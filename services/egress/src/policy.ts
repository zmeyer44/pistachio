/**
 * Target policy for one CONNECT (docs/cloud-sync-design.md §9): vet the
 * literal `host:port`, resolve, re-check every produced address, and dial
 * only the vetted literals — sequentially, first success wins.
 *
 * The rules themselves live in `@pistachio/egress-policy` (shared with
 * control's outbound-URL vetting); this module owns DNS and the dial. Splitting
 * resolve from dial is the anti-rebinding measure: the gateway never connects
 * to whatever a name resolves to at connect time, only to addresses that
 * passed {@link checkResolvedAddress}.
 */

import dns from "node:dns";
import net from "node:net";

import {
  NO_PERMITTED_ADDRESS_MESSAGE,
  checkResolvedAddress,
  refusalMessage,
  vetTarget,
  type TargetPolicyOptions,
} from "@pistachio/egress-policy";

import { DIAL_TIMEOUT_MS } from "./config.js";

export type { TargetPolicyOptions } from "@pistachio/egress-policy";

export interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

/** `dns.lookup(host, { all: true, verbatim: true })`, injectable for tests. */
export type LookupFn = (host: string) => Promise<ReadonlyArray<ResolvedAddress>>;

export const systemLookup: LookupFn = (host) =>
  dns.promises.lookup(host, { all: true, verbatim: true });

export type TargetResolution =
  | { readonly ok: true; readonly addresses: ReadonlyArray<string> }
  /** A 403 with this body. */
  | { readonly ok: false; readonly body: string };

/** Strip the `[...]` of an IPv6 literal from the CONNECT authority. */
export function unbracket(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * Vet the literal target, resolve it, and keep only addresses that pass the
 * post-DNS check. A resolver failure is a refusal, not a 502: a name the
 * gateway cannot vet is a name it must not dial.
 */
export async function resolveTarget(
  host: string,
  port: number,
  policy: TargetPolicyOptions,
  lookup: LookupFn = systemLookup,
): Promise<TargetResolution> {
  const refusal = vetTarget(host, port, policy);
  if (refusal !== null) return { ok: false, body: refusalMessage(refusal) };
  let resolved: ReadonlyArray<ResolvedAddress>;
  try {
    resolved = await lookup(unbracket(host));
  } catch {
    resolved = [];
  }
  const addresses: string[] = [];
  for (const entry of resolved) {
    if (checkResolvedAddress(entry.address, policy) === null) addresses.push(entry.address);
  }
  if (addresses.length === 0) return { ok: false, body: NO_PERMITTED_ADDRESS_MESSAGE };
  return { ok: true, addresses };
}

/** Open one TCP connection to a vetted literal, or null on failure/timeout. */
export type DialFn = (address: string, port: number, timeoutMs: number) => Promise<net.Socket | null>;

export const tcpDial: DialFn = (address, port, timeoutMs) =>
  new Promise((resolve) => {
    const socket = net.connect({ host: address, port, allowHalfOpen: true });
    let settled = false;
    const settle = (result: net.Socket | null): void => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      socket.removeListener("error", onError);
      socket.removeListener("timeout", onTimeout);
      socket.removeListener("connect", onConnect);
      resolve(result);
    };
    const onError = (): void => {
      socket.destroy();
      settle(null);
    };
    const onTimeout = (): void => {
      socket.destroy();
      settle(null);
    };
    const onConnect = (): void => {
      socket.setNoDelay(true);
      settle(socket);
    };
    socket.setTimeout(timeoutMs);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
    socket.once("connect", onConnect);
  });

/**
 * Dial the vetted addresses in order; the first that connects wins. Each
 * attempt gets its own `timeoutMs`, and `onAttempt` fires just before it — the
 * caller uses that to re-arm the client-side deadline per attempt, so a
 * blackholed address costs one dial timeout instead of the whole budget.
 */
export async function dialAny(
  addresses: ReadonlyArray<string>,
  port: number,
  options: {
    readonly dial?: DialFn;
    readonly timeoutMs?: number;
    readonly onAttempt?: (address: string, timeoutMs: number) => void;
  } = {},
): Promise<net.Socket | null> {
  const dial = options.dial ?? tcpDial;
  const timeoutMs = options.timeoutMs ?? DIAL_TIMEOUT_MS;
  for (const address of addresses) {
    options.onAttempt?.(address, timeoutMs);
    const socket = await dial(address, port, timeoutMs);
    if (socket !== null) return socket;
  }
  return null;
}
