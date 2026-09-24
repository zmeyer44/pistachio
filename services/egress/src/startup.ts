/**
 * Turning the environment into a serve-able configuration — or refusing to
 * run (docs/cloud-sync-design.md §9).
 *
 * The gateway holds the user's static browsing identity, so the startup
 * contract is: the process must never serve traffic on a routable address
 * with a verifier that does not verify. Two ways in, and no third:
 *
 * * `EGRESS_TOKEN_SECRET` (64 lowercase hex) — a real MAC-checking verifier,
 *   bound to `EGRESS_LISTEN` (`0.0.0.0:8443` by default).
 * * `EGRESS_DEV_INSECURE=1` — the shape-check-only {@link DevVerifier}, and
 *   *only* on a loopback address. Anything else is a startup error.
 *
 * Both configured, or neither, is also a startup error: the caller exits 1.
 */

import fs from "node:fs";
import net from "node:net";

import { DevVerifier, SharedSecretVerifier, type TokenVerifier } from "./auth.js";
import { DEFAULT_DEV_LISTEN, DEFAULT_LISTEN, ENV, SECRET_BYTES } from "./config.js";

export type StartupEnv = Readonly<Record<string, string | undefined>>;

export interface ListenAddress {
  readonly host: string;
  readonly port: number;
}

export interface StartupConfig {
  readonly listen: ListenAddress;
  readonly verifier: TokenVerifier;
  /** True only on the explicit opt-in path; the caller logs it loudly. */
  readonly devInsecure: boolean;
  readonly extraPorts: ReadonlyArray<number>;
  readonly ownerUserId: string | null;
  readonly control: { readonly baseUrl: string; readonly token: string } | null;
  readonly tls: { readonly cert: string; readonly key: string } | null;
  /** Non-fatal observations for the caller to log. */
  readonly warnings: ReadonlyArray<string>;
}

export class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartupError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function variable(env: StartupEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** `host:port` or `[v6]:port`; the port may be 0 (ephemeral). */
export function parseListen(text: string): ListenAddress | null {
  let host: string;
  let portText: string;
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    if (end < 0 || text[end + 1] !== ":") return null;
    host = text.slice(1, end);
    portText = text.slice(end + 2);
  } else {
    const colon = text.lastIndexOf(":");
    if (colon <= 0) return null;
    host = text.slice(0, colon);
    portText = text.slice(colon + 1);
  }
  if (host === "" || !/^[0-9]{1,5}$/.test(portText)) return null;
  const port = Number(portText);
  if (port > 65535) return null;
  return { host, port };
}

/** A literal loopback address: `127/8`, `::1`, or `::ffff:127.x.x.x`. */
export function isLoopbackLiteral(host: string): boolean {
  if (net.isIPv4(host)) return host.split(".")[0] === "127";
  if (!net.isIPv6(host)) return false;
  const lower = host.toLowerCase();
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  return mapped !== null && mapped[1] !== undefined && isLoopbackLiteral(mapped[1]);
}

/** Extra tunnel ports beyond 443/80, comma-separated; port 25 stays refused regardless. */
export function parseExtraPorts(raw: string | undefined): number[] {
  if (raw === undefined) return [];
  const ports: number[] = [];
  for (const piece of raw.split(",")) {
    const text = piece.trim();
    if (!/^[0-9]{1,5}$/.test(text)) continue;
    const port = Number(text);
    if (port >= 1 && port <= 65535 && !ports.includes(port)) ports.push(port);
  }
  return ports;
}

export interface StartupIo {
  readonly readFile?: (path: string) => string;
}

export function resolveStartup(env: StartupEnv, io: StartupIo = {}): StartupConfig {
  const warnings: string[] = [];
  const readFile = io.readFile ?? ((p: string) => fs.readFileSync(p, "utf8"));

  const devRaw = variable(env, ENV.devInsecure);
  const secretHex = variable(env, ENV.tokenSecret);
  if (devRaw !== undefined && devRaw !== "1") {
    throw new StartupError(
      `${ENV.devInsecure} is set to something other than "1"; unset it or set it to 1`,
    );
  }
  const devInsecure = devRaw === "1";
  if (devInsecure && secretHex !== undefined) {
    throw new StartupError(
      `${ENV.devInsecure}=1 and ${ENV.tokenSecret} are both set; refusing to guess which verifier you meant — unset one`,
    );
  }
  if (!devInsecure && secretHex === undefined) {
    throw new StartupError(
      `no credential verifier configured: set ${ENV.tokenSecret} to ${SECRET_BYTES * 2} lowercase hex characters (the shared secret control mints egress credentials with), or ${ENV.devInsecure}=1 to run the unauthenticated dev verifier on loopback`,
    );
  }

  const listenText = variable(env, ENV.listen) ?? (devInsecure ? DEFAULT_DEV_LISTEN : DEFAULT_LISTEN);
  const listen = parseListen(listenText);
  if (listen === null) {
    throw new StartupError(`${ENV.listen} must be host:port or [v6]:port (got ${JSON.stringify(listenText)})`);
  }

  let verifier: TokenVerifier;
  if (devInsecure) {
    if (!isLoopbackLiteral(listen.host)) {
      throw new StartupError(
        `${ENV.devInsecure}=1 binds loopback only (got ${listenText}); the dev verifier accepts any credential, so exposing it publishes an open proxy on the user's identity IP`,
      );
    }
    verifier = new DevVerifier();
  } else {
    try {
      verifier = SharedSecretVerifier.fromHex(secretHex ?? "");
    } catch (error) {
      throw new StartupError(
        `reading ${ENV.tokenSecret}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const ownerUserId = variable(env, ENV.ownerUserId) ?? null;
  if (ownerUserId !== null && !UUID_RE.test(ownerUserId)) {
    throw new StartupError(`${ENV.ownerUserId} must be a lowercase uuid`);
  }

  const controlUrl = variable(env, ENV.controlUrl);
  const gatewayToken = variable(env, ENV.gatewayToken);
  let control: StartupConfig["control"] = null;
  if (controlUrl !== undefined) {
    if (gatewayToken === undefined) {
      throw new StartupError(`${ENV.controlUrl} is set but ${ENV.gatewayToken} is not; the control plane refuses unauthenticated gateways`);
    }
    let parsed: URL;
    try {
      parsed = new URL(controlUrl);
    } catch {
      throw new StartupError(`${ENV.controlUrl} is not a valid URL`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new StartupError(`${ENV.controlUrl} must be an http(s) URL`);
    }
    control = { baseUrl: controlUrl.replace(/\/+$/, ""), token: gatewayToken };
  } else {
    if (gatewayToken !== undefined) {
      warnings.push(`${ENV.gatewayToken} is set but ${ENV.controlUrl} is not; ignoring it`);
    }
    warnings.push(
      `${ENV.controlUrl} unset: revocation feed, throttle limits, and usage metering are disabled`,
    );
  }

  const certPath = variable(env, ENV.tlsCert);
  const keyPath = variable(env, ENV.tlsKey);
  let tls: StartupConfig["tls"] = null;
  if ((certPath === undefined) !== (keyPath === undefined)) {
    throw new StartupError(`${ENV.tlsCert} and ${ENV.tlsKey} must be set together`);
  }
  if (certPath !== undefined && keyPath !== undefined) {
    try {
      tls = { cert: readFile(certPath), key: readFile(keyPath) };
    } catch (error) {
      throw new StartupError(
        `reading TLS material: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    listen,
    verifier,
    devInsecure,
    extraPorts: parseExtraPorts(variable(env, ENV.extraPorts)),
    ownerUserId,
    control,
    tls,
    warnings,
  };
}
