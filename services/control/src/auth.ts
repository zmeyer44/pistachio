/**
 * Bearer auth (docs/cloud-sync-design.md §7.2).
 *
 * Every user-facing bearer is a device JWT from `@pistachio/sync-protocol`
 * `signDeviceToken` with claims `{sub: userId, did: deviceId, iat, exp, jti}`.
 * A bootstrap token has `did === sub`: issued by signup and password login,
 * it lets the first device enroll and a second device read wrappers before
 * enrolling. Nothing else is accepted — no stubs.
 *
 * `authenticateToken` is the WHOLE of bearer verification: `bearerAuth`
 * wraps it for HTTP routes, and the hub's upgrade handler calls it directly.
 * It re-reads `users` and `devices` on every request; `platform` comes from
 * `devices.platform`, never the token. HTTP routes map `revoked` to 401; the
 * hub host maps it to close code 4003.
 */

import type { MiddlewareHandler } from "hono";
import { timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { verifyDeviceToken } from "@pistachio/sync-protocol";
import type { Db } from "./db/client.js";
import type { AppEnv } from "./env.js";
import type { SigningKeys } from "./keys-provider.js";
import { devices, users, type DevicePlatform } from "./db/schema.js";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The identity a verified bearer token establishes. */
export interface AuthenticatedToken {
  userId: string;
  /** Null for a bootstrap token (no device bound yet). */
  deviceId: string | null;
  /** From `devices.platform`; null for a bootstrap token. */
  platform: DevicePlatform | null;
  revoked: boolean;
  /**
   * From `users.is_anonymous`, never the token: an account nobody signed in
   * to (docs/anonymous-accounts.md). Its device reaches the models and
   * little else — see `anonymousAllowed` in app.ts.
   */
  anonymous: boolean;
}

export interface AuthVariables {
  userId: string;
  deviceId: string | null;
  platform: DevicePlatform | null;
  anonymous: boolean;
}


export async function authenticateToken(
  db: Db,
  signing: SigningKeys,
  token: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<AuthenticatedToken | null> {
  if (token.split(".").length !== 3) return null;
  const result = await verifyDeviceToken(signing.verifyKey, token, nowSeconds);
  if (!result.ok) return null;
  const { sub, did } = result.claims;
  if (!UUID_RE.test(sub) || !UUID_RE.test(did)) return null;
  const [user] = await db.select({ id: users.id, anonymous: users.isAnonymous }).from(users).where(eq(users.id, sub));
  if (!user) return null;
  if (did === sub) return { userId: user.id, deviceId: null, platform: null, revoked: false, anonymous: user.anonymous };
  const [device] = await db
    .select({ userId: devices.userId, platform: devices.platform, revokedAt: devices.revokedAt })
    .from(devices)
    .where(eq(devices.id, did));
  if (!device || device.userId !== user.id) return null;
  return {
    userId: user.id,
    deviceId: did,
    platform: device.platform,
    revoked: device.revokedAt !== null,
    anonymous: user.anonymous,
  };
}

export function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length === 0 ? null : token;
}

/** Device/bootstrap JWT middleware: sets userId, deviceId, platform. */
export function bearerAuth(
  db: Db,
  signing: SigningKeys,
  nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = bearerToken(c.req.header("Authorization"));
    if (token === null) return c.json({ error: "unauthorized" }, 401);
    const identity = await authenticateToken(db, signing, token, nowSeconds());
    if (identity === null) return c.json({ error: "unauthorized" }, 401);
    if (identity.revoked) return c.json({ error: "unauthorized", reason: "device_revoked" }, 401);
    c.set("userId", identity.userId);
    c.set("deviceId", identity.deviceId);
    c.set("platform", identity.platform);
    c.set("anonymous", identity.anonymous);
    await next();
  };
}

/** 403 `device_required` for a bootstrap token on a device-only route. */
export const requireDevice: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("deviceId") === null) return c.json({ error: "device_required" }, 403);
  await next();
};

/** Constant-time compare; length is allowed to leak, the bytes are not. */
export function secretEquals(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/**
 * Bearer auth for a plane-to-plane shared secret (the cloud-browser runner
 * or the egress gateway). Read per request so rotation needs no restart;
 * with no secret configured the route family is CLOSED (503), never open.
 */
export function bearerService(
  secret: () => string | undefined,
  unconfiguredReason: string,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const expected = secret();
    if (!expected) return c.json({ error: "unavailable", reason: unconfiguredReason }, 503);
    const token = bearerToken(c.req.header("Authorization"));
    if (token === null || !secretEquals(token, expected)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}
