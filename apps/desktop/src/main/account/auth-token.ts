/**
 * Pure device-token helpers (docs/cloud-sync-design.md §7.2, §10.1): read the
 * claims of a compact JWT without verifying it (control signed it; the desktop
 * only needs to know WHEN to refresh and WHOSE token it holds), and the
 * refresh schedule at `exp − 60 s`. No I/O — the tests exercise this directly
 * and ControlClient owns the timers.
 */

import { base64urlDecode, fromUtf8 } from "@pistachio/sync-protocol";

/** Re-mint this long before exp. */
export const TOKEN_REFRESH_LEEWAY_SECONDS = 60;

export interface DeviceTokenClaimsLike {
  sub?: unknown;
  did?: unknown;
  exp?: unknown;
  iat?: unknown;
  jti?: unknown;
}

/** The payload of a compact JWT, or null for anything that is not one. */
export function tokenClaims(token: string): DeviceTokenClaimsLike | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const parsed: unknown = JSON.parse(fromUtf8(base64urlDecode(parts[1] as string)));
    return typeof parsed === "object" && parsed !== null ? (parsed as DeviceTokenClaimsLike) : null;
  } catch {
    return null;
  }
}

/** `exp` (epoch seconds) from a compact JWT; null when absent or not a JWT. */
export function tokenExpSeconds(token: string): number | null {
  const exp = tokenClaims(token)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp : null;
}

/**
 * A bootstrap token names the user as its own device (`did === sub`, §7.2):
 * it may list Spaces and wrappers and enroll, and nothing else.
 */
export function isBootstrapToken(token: string): boolean {
  const claims = tokenClaims(token);
  return (
    claims !== null &&
    typeof claims.sub === "string" &&
    typeof claims.did === "string" &&
    claims.sub === claims.did
  );
}

/** Should the client refresh now? True once inside the leeway window. */
export function shouldRefreshToken(
  expSeconds: number,
  nowSeconds: number,
  leewaySeconds: number = TOKEN_REFRESH_LEEWAY_SECONDS,
): boolean {
  return nowSeconds >= expSeconds - leewaySeconds;
}

/** Delay until the proactive refresh should fire; 0 when already due. */
export function refreshDelayMs(
  expSeconds: number,
  nowMs: number,
  leewaySeconds: number = TOKEN_REFRESH_LEEWAY_SECONDS,
): number {
  return Math.max(0, (expSeconds - leewaySeconds) * 1000 - nowMs);
}
