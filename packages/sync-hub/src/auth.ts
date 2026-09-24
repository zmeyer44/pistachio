/**
 * Device-token verification helpers for a hub host.
 *
 * A bearer is a compact EdDSA JWS minted by the control plane
 * (`signDeviceToken`) with claims `{sub: userId, did: deviceId, iat, exp,
 * jti}`. Verified against the control plane's base64 raw Ed25519 public key.
 * A bootstrap token (`did === sub`, §7.2) carries no device: it yields
 * `deviceId: null`, which the WebSocket upgrade refuses with 403.
 *
 * The control plane's own `authenticateToken` additionally re-reads the
 * device row (platform, revocation) on every request; this module is the
 * signature/expiry half only and never consults a database.
 */

import {
  base64urlDecode,
  fromBase64,
  fromUtf8,
  importTokenVerifyKey,
  verifyDeviceToken,
} from "@pistachio/sync-protocol";

const JWS_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export interface AuthEnv {
  /** base64 raw Ed25519 verify key for control-plane device tokens. */
  CONTROL_PUBLIC_KEY?: string;
}

export type AuthResult =
  | { userId: string; deviceId: string | null }
  | { error: string };

/** Extract the token from an `Authorization: Bearer <token>` header. */
export function bearerToken(authorization: string | null): string | null {
  if (authorization === null) return null;
  const parts = authorization.split(" ");
  if (parts.length !== 2) return null;
  const [scheme, token] = parts;
  if (scheme === undefined || token === undefined) return null;
  if (scheme.toLowerCase() !== "bearer") return null;
  return token;
}

/** Three base64url parts whose header decodes to `{alg:"EdDSA",typ:"JWT"}`. */
export function isDeviceJws(token: string): boolean {
  if (!JWS_PATTERN.test(token)) return false;
  const header = token.split(".")[0];
  if (header === undefined) return false;
  try {
    const decoded = JSON.parse(fromUtf8(base64urlDecode(header))) as {
      alg?: unknown;
      typ?: unknown;
    };
    return decoded.alg === "EdDSA" && decoded.typ === "JWT";
  } catch {
    return false;
  }
}

/** Imported verify key, cached per process and keyed by the env string so a
 * rotated key refreshes the cache. */
let cachedVerifyKey: { publicKey: string; key: Promise<CryptoKey> } | null =
  null;

function controlVerifyKey(publicKey: string): Promise<CryptoKey> {
  if (cachedVerifyKey === null || cachedVerifyKey.publicKey !== publicKey) {
    cachedVerifyKey = {
      publicKey,
      key: importTokenVerifyKey(fromBase64(publicKey)),
    };
  }
  return cachedVerifyKey.key;
}

/**
 * Authenticate a hub request from its `Authorization` header value. Only
 * signed device JWTs are accepted, and only while `CONTROL_PUBLIC_KEY` is
 * configured — there is no unauthenticated development fallback.
 */
export async function authenticate(
  authorization: string | null,
  env: AuthEnv,
  nowSeconds: number,
): Promise<AuthResult> {
  const token = bearerToken(authorization);
  if (token === null) return { error: "unauthorized" };
  return verifyBearer(token, env, nowSeconds);
}

/** `authenticate` for a token already extracted from a header or query. */
export async function verifyBearer(
  token: string,
  env: AuthEnv,
  nowSeconds: number,
): Promise<AuthResult> {
  const publicKey =
    env.CONTROL_PUBLIC_KEY === "" ? undefined : env.CONTROL_PUBLIC_KEY;
  if (publicKey === undefined) return { error: "unauthorized" };
  if (!isDeviceJws(token)) return { error: "unauthorized" };
  try {
    const key = await controlVerifyKey(publicKey);
    const result = await verifyDeviceToken(key, token, nowSeconds);
    if (!result.ok) return { error: result.reason };
    const { sub, did } = result.claims;
    return { userId: sub, deviceId: did === sub ? null : did };
  } catch {
    // Undecodable/unimportable key material: treat as unauthenticated
    // rather than throwing 500s at every device.
    return { error: "unauthorized" };
  }
}
