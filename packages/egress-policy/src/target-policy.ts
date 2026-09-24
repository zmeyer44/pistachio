/**
 * Target policy: which `host:port` pairs the identity gateway will tunnel to,
 * and which resolved addresses it may dial. A port of harbor's
 * `services/egressgw/src/policy.rs`, shared by `services/egress` and by
 * control's outbound-URL vetting (docs/cloud-sync-design.md §5, §7.3, §9).
 *
 * Two refusal families, both fail-closed:
 *
 * * **Private/loopback targets.** The gateway sits inside Pistachio's own
 *   network; letting a tunnel reach loopback or RFC1918 space would turn the
 *   product into an SSRF pivot against the control plane and every
 *   neighbouring service. Literal IPs are refused here, and resolved
 *   addresses are re-checked after DNS ({@link checkResolvedAddress}) so a
 *   public-looking hostname cannot rebind into private space.
 * * **Ports.** 443 and 80 plus an operator-configured allowlist. Port 25 is
 *   refused unconditionally — spam egress is an abuse channel, and
 *   "unconditionally" means even a misconfigured extra-ports list cannot
 *   reopen it.
 */

import { ipIsPrivate, parseIpAddress, unbracketHost, type IpAddress } from "./ip.js";

/**
 * Why a target was refused. Rendered to the client as a terse 403 body by
 * {@link refusalMessage}; never logged with more detail than this.
 */
export type Refusal =
  /** Port 25: spam-egress abuse control. Never allowed. */
  | { readonly kind: "smtp" }
  /** Port outside 443/80/extra allowlist. */
  | { readonly kind: "port_not_allowed"; readonly port: number }
  /**
   * Loopback, RFC1918, link-local, CGNAT, ULA, or a bare LAN name — the
   * gateway must never reach into private address space.
   */
  | { readonly kind: "private_target" };

/** The 403 body for a refusal — byte-identical to harbor's gateway. */
export function refusalMessage(refusal: Refusal): string {
  switch (refusal.kind) {
    case "smtp":
      return "port 25 is never tunnelled";
    case "port_not_allowed":
      return `port ${refusal.port} is not allowed`;
    case "private_target":
      return "private or local targets are never tunnelled";
  }
}

/**
 * The 403 body harbor's gateway sends when a name passed {@link vetTarget}
 * but none of its resolved addresses passed {@link checkResolvedAddress}.
 */
export const NO_PERMITTED_ADDRESS_MESSAGE = "target did not resolve to a permitted address";

/**
 * Per-deployment tunnel policy, built once at startup from configuration
 * (`EGRESS_EXTRA_PORTS`). There is intentionally no runtime mutation surface.
 */
export interface TargetPolicyOptions {
  /** Ports allowed beyond 443 and 80. Listing 25 here does not reopen it. */
  readonly extraPorts?: Iterable<number>;
  /**
   * Lifts the private-target refusal ONLY. Exists for tests and local
   * development (loopback echo servers); production callers never set it.
   * Port rules — including the port-25 refusal — still apply.
   */
  readonly allowPrivateTargets?: boolean;
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 0 && port <= 65535;
}

function checkPort(port: number, extraPorts: Iterable<number> | undefined): Refusal | null {
  if (port === 25) return { kind: "smtp" };
  if (port === 443 || port === 80) return null;
  if (isValidPort(port) && extraPorts !== undefined) {
    for (const extra of extraPorts) if (extra === port) return null;
  }
  return { kind: "port_not_allowed", port };
}

function checkAddress(ip: IpAddress | null, options: TargetPolicyOptions): Refusal | null {
  if (options.allowPrivateTargets === true) return null;
  // An address that cannot be parsed cannot be vetted: refuse it.
  if (ip === null || ipIsPrivate(ip)) return { kind: "private_target" };
  return null;
}

/**
 * Check the literal target from the CONNECT line (or a URL's host and port),
 * before DNS. Bracketed IPv6 literals are accepted.
 */
export function vetTarget(
  host: string,
  port: number,
  options: TargetPolicyOptions = {},
): Refusal | null {
  const portRefusal = checkPort(port, options.extraPorts);
  if (portRefusal !== null) return portRefusal;
  const bare = unbracketHost(host);
  const ip = parseIpAddress(bare);
  if (ip !== null) return checkAddress(ip, options);
  if (options.allowPrivateTargets === true) return null;
  const h = bare.toLowerCase();
  // `localhost` names and bare no-dot hostnames are LAN/mDNS names — they
  // can only resolve somewhere the gateway must not go.
  if (h === "localhost" || h.endsWith(".localhost") || !h.includes(".")) {
    return { kind: "private_target" };
  }
  return null;
}

/**
 * Re-check an address DNS actually produced. Splitting this from
 * {@link vetTarget} is the anti-rebinding measure: only addresses that passed
 * this check are ever dialled, not whatever the name resolves to at connect
 * time. Anything that is not a parseable IPv4/IPv6 literal is refused.
 */
export function checkResolvedAddress(
  address: string,
  options: TargetPolicyOptions = {},
): Refusal | null {
  return checkAddress(parseIpAddress(unbracketHost(address)), options);
}
