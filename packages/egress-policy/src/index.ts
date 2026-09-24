/**
 * Identity egress routing (docs/cloud-sync-design.md §5).
 *
 * Every request a proxied space makes gets one of three answers:
 *
 *   - **gateway** — tunnel to the identity egress gateway, exiting from the
 *     user's static IP. This is the thing the product sells.
 *   - **direct** — bypass the gateway. Local/private traffic, high-bandwidth
 *     media, and per-site bypasses go direct: routing them through the
 *     gateway burns money and adds nothing to identity stability.
 *   - **blocked** — the gateway is down and the user has not accepted
 *     browsing direct. Pistachio FAILS CLOSED; "zero silent fallback to
 *     direct" is a release gate, so a degraded gateway must never quietly
 *     leak the real IP to a site the user believes is proxied.
 *
 * Pure and dependency-free so the desktop, the cloud browser, the gateway,
 * and the tests share one implementation of the rules.
 */

import {
  HOSTED_CHECKOUT_RULES,
  MEDIA_BYPASS_DOMAINS,
  SEEDED_HOSTILE_DOMAINS,
  normalizedHost,
} from "@pistachio/sync-protocol";
import { ipIsPrivate, isIpLiteral, parseIpAddress, unbracketHost } from "./ip.js";

export {
  ipIsPrivate,
  ipv4IsPrivate,
  ipv4MappedAddress,
  ipv6IsPrivate,
  isIpLiteral,
  parseIpAddress,
  unbracketHost,
  type IpAddress,
  type Ipv4Octets,
  type Ipv6Segments,
} from "./ip.js";
export * from "./target-policy.js";
export * from "./credential.js";

export type EgressRoute = "gateway" | "direct" | "blocked";

export type EgressReason =
  | "space_direct"
  | "loopback"
  | "private_range"
  | "vpn_route"
  | "media_bypass"
  | "hosted_checkout"
  | "site_bypass"
  | "gateway_down_override"
  | "gateway_down_failclosed"
  | "identity";

export interface EgressDecision {
  route: EgressRoute;
  reason: EgressReason;
  /** Shown in the site controls / banner so the routing is never a mystery. */
  explanation: string;
}

export type GatewayState = "up" | "down";

/** Work → identity IP; Personal → direct. */
export type EgressPolicy = "identity" | "direct";

export interface SpaceEgressConfig {
  spaceId: string;
  policy: EgressPolicy;
  /** Hosts the user (or challenge auto-suggest) pinned to direct. */
  siteBypass: ReadonlyArray<string>;
  /** High-bandwidth media bypass — on by default, configurable. */
  mediaBypass: boolean;
  /**
   * Hosted checkout bypass — on by default. Payment processors refuse proxied
   * requests outright rather than challenge them, so these pages are routed
   * direct automatically (see HOSTED_CHECKOUT_RULES).
   */
  checkoutBypass: boolean;
  /**
   * Merchant-branded checkout hosts recognised at runtime by their path shape
   * (`buy.example.com/checkouts/cn/…`). A host list cannot know these ahead of
   * time, so the client discovers them per navigation and holds them for the
   * session only — a checkout host is never permanently pinned to direct.
   */
  detectedCheckoutHosts: ReadonlyArray<string>;
  /**
   * One-click "browse direct for now" after a fail-closed banner. Resets on
   * reconnect — it is deliberately not sticky.
   */
  temporaryDirectOverride: boolean;
}

export interface NetworkContext {
  gateway: GatewayState;
  /** Routes claimed by an active corporate VPN — never proxied. */
  vpnRoutes: ReadonlyArray<string>;
  vpnActive: boolean;
}

export function defaultSpaceEgress(spaceId: string): SpaceEgressConfig {
  return {
    spaceId,
    policy: "direct",
    siteBypass: [],
    mediaBypass: true,
    checkoutBypass: true,
    detectedCheckoutHosts: [],
    temporaryDirectOverride: false,
  };
}

/* ------------------------------------------------------------------ *
 * Host classification
 * ------------------------------------------------------------------ */

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * Private, local, or otherwise unroutable — traffic that never leaves the
 * machine. An IP literal is judged by the shared range list, so a mapped
 * (`::ffff:10.0.0.1`), compatible, NAT64 or 6to4 form of a refused IPv4
 * address is refused too, and `0.0.0.0` is not mistaken for public.
 */
export function isPrivateHost(host: string): boolean {
  const h = unbracketHost(host.toLowerCase());
  const ip = parseIpAddress(h);
  if (ip !== null) return ipIsPrivate(ip);
  // A malformed literal (leading-zero octet, zone id) is not a hostname
  // that resolves publicly; refuse rather than route it direct.
  if (/^[\d.]+$/.test(h) || h.includes(":")) return true;
  // Bare hostnames with no dot are LAN names (mDNS, corporate short names).
  if (!h.includes(".") && !isLoopbackHost(h)) return true;
  return false;
}

function hostMatches(host: string, suffix: string): boolean {
  const h = normalizedHost(host);
  const s = normalizedHost(suffix);
  return h === s || h.endsWith(`.${s}`);
}

export function isMediaHost(host: string): boolean {
  return MEDIA_BYPASS_DOMAINS.some((d) => hostMatches(host, d));
}

/** Origins known to challenge datacenter IPs — bypass is auto-suggested. */
export function isKnownHostileToDatacenterIps(host: string): boolean {
  return SEEDED_HOSTILE_DOMAINS.some((d) => hostMatches(host, d));
}

/* ------------------------------------------------------------------ *
 * Hosted checkout detection
 * ------------------------------------------------------------------ */

/** Checkout hosts known by name — these can be bypassed before any request. */
export const HOSTED_CHECKOUT_DOMAINS: ReadonlyArray<string> = HOSTED_CHECKOUT_RULES.filter(
  (rule) => rule.host !== undefined && rule.path === undefined,
).map((rule) => rule.host as string);

export interface HostedCheckoutMatch {
  /** The host to route direct, normalized. */
  host: string;
  /** Which processor was recognised, for the notice shown to the user. */
  label: string;
}

/**
 * Does this URL look like a hosted checkout page? Matches the processors' own
 * domains and — the case a host list cannot cover — merchant-branded checkout
 * domains identified by their path shape.
 *
 * Returns the match rather than a boolean so the caller can name the processor
 * when it tells the user the page is browsing direct.
 */
export function matchHostedCheckout(url: string): HostedCheckoutMatch | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  for (const rule of HOSTED_CHECKOUT_RULES) {
    if (rule.host !== undefined && !hostMatches(parsed.hostname, rule.host)) continue;
    if (rule.path !== undefined && !rule.path.test(parsed.pathname)) continue;
    if (rule.host === undefined && rule.path === undefined) continue;
    return { host: normalizedHost(parsed.hostname), label: rule.label };
  }
  return null;
}

export function isHostedCheckoutHost(host: string): boolean {
  return HOSTED_CHECKOUT_DOMAINS.some((d) => hostMatches(host, d));
}

function matchesVpnRoute(host: string, routes: ReadonlyArray<string>): boolean {
  return routes.some((r) => hostMatches(host, r));
}

/** A known checkout domain, or one recognised by path earlier this session. */
function isCheckoutBypassHost(host: string, space: SpaceEgressConfig): boolean {
  if (isHostedCheckoutHost(host)) return true;
  return space.detectedCheckoutHosts.some((h) => hostMatches(host, h));
}

/* ------------------------------------------------------------------ *
 * The decision
 * ------------------------------------------------------------------ */

/**
 * Route one request. Order matters: local/private and VPN rules win over
 * everything (they must never be tunnelled), then explicit bypasses, and only
 * then the gateway — whose availability decides between proxying and failing
 * closed.
 */
export function decideEgress(
  host: string,
  space: SpaceEgressConfig,
  net: NetworkContext,
): EgressDecision {
  if (isLoopbackHost(host)) {
    return { route: "direct", reason: "loopback", explanation: "Local address — never proxied." };
  }
  if (isPrivateHost(host)) {
    return {
      route: "direct",
      reason: "private_range",
      explanation: "Private network address — never proxied.",
    };
  }
  if (net.vpnActive && matchesVpnRoute(host, net.vpnRoutes)) {
    return {
      route: "direct",
      reason: "vpn_route",
      explanation: "Routed by your active VPN — browsing direct on this network.",
    };
  }
  if (space.policy === "direct") {
    return {
      route: "direct",
      reason: "space_direct",
      explanation: "This space browses direct.",
    };
  }
  if (space.siteBypass.some((s) => hostMatches(host, s))) {
    return {
      route: "direct",
      reason: "site_bypass",
      explanation: "You chose to browse this site direct.",
    };
  }
  // Not a silent fallback: this is a policy rule with the same standing as
  // the media bypass, it is reported by explain(), and the user is told the
  // first time a checkout host is routed direct.
  if (space.checkoutBypass && isCheckoutBypassHost(host, space)) {
    return {
      route: "direct",
      reason: "hosted_checkout",
      explanation:
        "Hosted checkout pages refuse proxied requests, so this payment page browses direct.",
    };
  }
  if (space.mediaBypass && isMediaHost(host)) {
    return {
      route: "direct",
      reason: "media_bypass",
      explanation: "High-bandwidth media bypasses the identity gateway by default.",
    };
  }
  if (net.gateway === "down") {
    if (space.temporaryDirectOverride) {
      return {
        route: "direct",
        reason: "gateway_down_override",
        explanation: "Identity gateway unreachable — browsing direct for now, at your request.",
      };
    }
    // Fail closed. Never silently fall back to direct (release gate).
    return {
      route: "blocked",
      reason: "gateway_down_failclosed",
      explanation:
        "Identity gateway unreachable. Pistachio blocked this request rather than reveal your real IP.",
    };
  }
  return {
    route: "gateway",
    reason: "identity",
    explanation: "Browsing through your Pistachio identity IP.",
  };
}

/** {@link decideEgress} keyed by the normalized host, for the site controls / IPC surface. */
export interface EgressExplanation extends EgressDecision {
  host: string;
}

/** The routing decision for a host, explained — never a mystery to the user. */
export function explain(
  host: string,
  space: SpaceEgressConfig,
  net: NetworkContext,
): EgressExplanation {
  return { host: normalizedHost(host), ...decideEgress(host, space, net) };
}

/* ------------------------------------------------------------------ *
 * Client wiring helpers
 * ------------------------------------------------------------------ */

/** The identity gateway a session tunnels through (`GET /egress`). */
export interface EgressGateway {
  host: string;
  port: number;
}

/**
 * Chromium proxy config for a space, in the shape `session.setProxy` takes.
 * A CONNECT proxy tunnels TCP only, so QUIC must be disabled process-wide
 * whenever any space is proxied (`--disable-quic`, D13) or Chromium races
 * UDP straight past the proxy and leaks the real IP. Bypass entries keep local
 * traffic off the proxy at the network stack, not just in our policy.
 */
export interface ChromiumProxyConfig {
  mode: "fixed_servers";
  /** `https://<host>:<port>` — one proxy, never a `direct://` fallback. */
  proxyRules: string;
  proxyBypassRules: string;
}

/**
 * Chromium matches a bare hostname in proxyBypassRules EXACTLY — `stripe.com`
 * does not cover `checkout.stripe.com`. `hostMatches` above is a suffix match,
 * so emit both forms or the network stack and the policy module disagree about
 * which hosts are bypassed. IP literals and CIDR ranges are emitted as-is.
 */
export function bypassPatternsFor(hosts: ReadonlyArray<string>): string[] {
  const patterns: string[] = [];
  for (const raw of hosts) {
    const h = normalizedHost(raw.trim());
    if (h === "") continue;
    if (h.includes("/") || isIpLiteral(h)) {
      patterns.push(h);
      continue;
    }
    patterns.push(h, `*.${h}`);
  }
  return patterns;
}

export const LOCAL_BYPASS_RULES =
  "<local>;localhost;127.0.0.1/8;::1;10.0.0.0/8;172.16.0.0/12;192.168.0.0/16;169.254.0.0/16;fc00::/7;fe80::/10";

function proxyServerFor(gateway: EgressGateway): string {
  const host =
    gateway.host.includes(":") && !gateway.host.startsWith("[")
      ? `[${gateway.host}]`
      : gateway.host;
  return `https://${host}:${gateway.port}`;
}

export function proxyConfigFor(
  space: SpaceEgressConfig,
  gateway: EgressGateway,
  net: NetworkContext,
): ChromiumProxyConfig {
  if (space.policy === "direct") {
    return { mode: "fixed_servers", proxyRules: "direct://", proxyBypassRules: "" };
  }
  const hosts = new Set<string>(space.siteBypass);
  if (space.mediaBypass) for (const h of MEDIA_BYPASS_DOMAINS) hosts.add(h);
  if (space.checkoutBypass) {
    // Known processor domains need no detection; the detected list carries the
    // merchant-branded ones found by path this session.
    for (const h of HOSTED_CHECKOUT_DOMAINS) hosts.add(h);
    for (const h of space.detectedCheckoutHosts) hosts.add(h);
  }
  if (net.vpnActive) for (const h of net.vpnRoutes) hosts.add(h);
  const bypass = [LOCAL_BYPASS_RULES, ...new Set(bypassPatternsFor([...hosts]))];
  return {
    mode: "fixed_servers",
    // One proxy and nothing after it: a `,direct://` fallback would let a
    // gateway outage silently reveal the real IP.
    proxyRules: proxyServerFor(gateway),
    proxyBypassRules: bypass.join(";"),
  };
}

/**
 * A site challenged us in a way that suggests datacenter-IP hostility.
 * Returns a suggestion the UI can offer — never an automatic change, since
 * silently moving a site off the identity IP would undermine the promise.
 */
export interface BypassSuggestion {
  host: string;
  reason: string;
}

export function suggestBypassOnChallenge(
  host: string,
  httpStatus: number,
  space: SpaceEgressConfig,
): BypassSuggestion | null {
  if (space.policy !== "identity") return null;
  if (space.siteBypass.some((s) => hostMatches(host, s))) return null;
  const challenged = httpStatus === 403 || httpStatus === 429 || httpStatus === 503;
  if (!challenged && !isKnownHostileToDatacenterIps(host)) return null;
  return {
    host: normalizedHost(host),
    reason: isKnownHostileToDatacenterIps(host)
      ? "This site is known to challenge datacenter IP addresses."
      : `This site returned ${httpStatus}, which often means it is challenging the IP address.`,
  };
}
