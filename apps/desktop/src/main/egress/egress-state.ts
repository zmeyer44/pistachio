/**
 * Pure egress-plane plumbing (docs/cloud-sync-design.md §10.3): a Space's
 * policy → the SpaceEgressConfig the shared policy module consumes, config +
 * gateway health → the status the renderer shows, the reset-on-reconnect rule
 * for "browse direct for now", the startup QUIC decision, the proxy-challenge
 * predicate the `login` handlers apply, and the credential refresh schedule.
 * Electron-free so vitest covers every rule.
 */

import { readFileSync } from "node:fs";
import {
  defaultSpaceEgress,
  type EgressGateway,
  type GatewayState,
  type SpaceEgressConfig,
} from "@pistachio/egress-policy";
import type { SpaceEgressStatus } from "@pistachio/shell-contracts/ipc";
import type { SpaceEgressPolicy } from "@pistachio/shell-contracts/spaces";

export function buildSpaceEgressConfig(
  spaceId: string,
  policy: SpaceEgressPolicy,
  temporaryDirectOverride: boolean,
  /** Merchant-branded checkout hosts detected this session (in-memory). */
  detectedCheckoutHosts: ReadonlyArray<string> = [],
): SpaceEgressConfig {
  const base = defaultSpaceEgress(spaceId);
  return {
    ...base,
    policy,
    siteBypass: [...base.siteBypass],
    detectedCheckoutHosts: [...detectedCheckoutHosts],
    temporaryDirectOverride,
  };
}

/**
 * May this Space be proxied during THIS run? `--disable-quic` can only be
 * appended before app ready, so a Space switched to identity mid-session
 * would otherwise be proxied while QUIC is live — and Chromium races HTTP/3
 * over UDP straight past a CONNECT proxy, exposing the real IP for exactly
 * the Space the person just asked to protect. The switch is persisted and
 * takes effect at the next launch (D13).
 */
export function mayProxyThisRun(quicDisabledAtStartup: boolean): boolean {
  return quicDisabledAtStartup;
}

/** Config + gateway health → the per-Space state the controls render. */
export function spaceEgressStatusFor(
  config: SpaceEgressConfig,
  gateway: GatewayState,
  quicDisabledAtStartup: boolean,
): SpaceEgressStatus {
  const identity = config.policy === "identity";
  const restartRequired = identity && !mayProxyThisRun(quicDisabledAtStartup);
  return {
    spaceId: config.spaceId,
    policy: config.policy,
    // Not "failing closed" when the reason is a pending restart: the Space is
    // simply not proxied yet, and restartRequired says so explicitly.
    failClosed: identity && !restartRequired && gateway === "down" && !config.temporaryDirectOverride,
    temporaryDirectOverride: identity && config.temporaryDirectOverride,
    restartRequired,
  };
}

/**
 * "Browse direct for now" resets when the gateway comes back — deliberately
 * not sticky, so a temporary outage can never silently turn into a permanent
 * direct-browsing downgrade.
 */
export function shouldResetOverrides(previous: GatewayState, next: GatewayState): boolean {
  return previous === "down" && next === "up";
}

/** Pure core of the startup QUIC decision, split out for tests. */
export function parsedSpacesHaveIdentitySpace(parsed: unknown): boolean {
  if (typeof parsed !== "object" || parsed === null) return false;
  const spaces = (parsed as { spaces?: unknown }).spaces;
  if (!Array.isArray(spaces)) return false;
  return spaces.some(
    (space: unknown) =>
      typeof space === "object" &&
      space !== null &&
      (space as { egressPolicy?: unknown }).egressPolicy === "identity",
  );
}

/**
 * Does any persisted Space browse via the identity IP? Decides the startup
 * `--disable-quic` switch, which must be appended before app ready — before
 * any store exists — so this reads the raw spaces.json synchronously.
 */
export function spacesFileHasIdentitySpace(spacesPath: string): boolean {
  try {
    return parsedSpacesHaveIdentitySpace(JSON.parse(readFileSync(spacesPath, "utf8")));
  } catch {
    return false;
  }
}

/** The subset of Electron's AuthInfo the proxy predicate reads. */
export interface ProxyChallengeInfo {
  isProxy: boolean;
  host: string;
  port: number;
}

/**
 * The one predicate every `login` listener applies (§10.3): only a PROXY
 * challenge from the gateway itself is answered with the egress credential.
 * An origin's own 401, and a challenge from any other proxy, are left alone —
 * the credential must never be presented to a site.
 */
export function matchesProxyChallenge(
  authInfo: ProxyChallengeInfo,
  gateway: EgressGateway | null,
): boolean {
  if (gateway === null) return false;
  if (!authInfo.isProxy) return false;
  return authInfo.host === gateway.host && authInfo.port === gateway.port;
}

/**
 * Where the gateway is reached. Production gateways are `https://` proxies
 * (D13); `PISTACHIO_EGRESS_URL` may pin a dev gateway, which the egress
 * service runs as plain HTTP (§14), in which case its scheme and address win
 * for both the health probe and the proxy rule.
 */
export interface GatewayEndpoint {
  scheme: "https" | "http";
  host: string;
  port: number;
}

export function parseEgressUrlPin(value: string | undefined): GatewayEndpoint | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
    if (!Number.isInteger(port) || port <= 0) return null;
    return { scheme: url.protocol === "https:" ? "https" : "http", host: url.hostname, port };
  } catch {
    return null;
  }
}

export function gatewayEndpoint(
  gateway: EgressGateway | null,
  pin: GatewayEndpoint | null,
): GatewayEndpoint | null {
  if (pin !== null) return pin;
  if (gateway === null) return null;
  return { scheme: "https", host: gateway.host, port: gateway.port };
}

function endpointHost(endpoint: GatewayEndpoint): string {
  return endpoint.host.includes(":") && !endpoint.host.startsWith("[")
    ? `[${endpoint.host}]`
    : endpoint.host;
}

/** `GET <scheme>://<host>:<port>/healthz`, probed every 10 s. */
export function healthProbeUrl(endpoint: GatewayEndpoint): string {
  return `${endpoint.scheme}://${endpointHost(endpoint)}:${String(endpoint.port)}/healthz`;
}

/** The one proxy server a Chromium proxy rule names; no fallback after it. */
export function proxyServerFor(endpoint: GatewayEndpoint): string {
  return `${endpoint.scheme}://${endpointHost(endpoint)}:${String(endpoint.port)}`;
}

/** Refresh an hour before the credential's expiry; 0 when already due. */
export const CREDENTIAL_REFRESH_LEEWAY_MS = 60 * 60 * 1000;

export function credentialRefreshDelayMs(expiresAt: string, nowMs: number): number {
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs)) return 0;
  return Math.max(0, expiresMs - CREDENTIAL_REFRESH_LEEWAY_MS - nowMs);
}

/** A credential past its expiry is no credential. */
export function credentialIsLive(expiresAt: string, nowMs: number): boolean {
  const expiresMs = Date.parse(expiresAt);
  return Number.isFinite(expiresMs) && expiresMs > nowMs;
}

export const RESTART_REQUIRED_EXPLANATION =
  "Saved. This Space starts using your identity IP the next time you open Pistachio — " +
  "it is not routed now because QUIC cannot be disabled mid-session, and proxying with it on " +
  "would leak your real IP over UDP.";
