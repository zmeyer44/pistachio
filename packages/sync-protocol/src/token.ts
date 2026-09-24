/**
 * Short-lived device tokens (PRD §8.2 "short-lived mTLS certs" — the V1
 * software analogue: EdDSA-signed device JWTs minted by the control plane and
 * verified by the session plane). Compact JWS, Ed25519 ("EdDSA"), no external
 * dependency — runs in Node, Cloudflare Workers, and Electron.
 *
 * The control plane holds the signing key; the session plane holds only the
 * public key (env-provided). Revocation is enforced separately (a revoked
 * device id list at the hub) because a valid unexpired token cannot be
 * un-signed — short TTL bounds the window, the revocation list closes it.
 */

import { base64urlDecode, base64urlEncode, lengthPrefixed, utf8, fromUtf8 } from "./encoding.js";

/**
 * Bytes a device signs to prove possession of its enrolled Ed25519 identity
 * key during device-credential registration and device-login (PRD §8.2). The
 * control plane mints a one-time `challenge`; the device signs over this
 * domain-separated tuple with its identity key. Domain separation keeps these
 * proofs disjoint from sync-record signatures (`pistachio.recordsig.v1`), so a
 * signature captured in one protocol can never be replayed in the other.
 *
 * Shared here so the control plane (verifier) and the desktop client (signer)
 * cannot drift.
 */
export function deviceLoginSigningBytes(deviceId: string, challenge: string): Uint8Array {
  return lengthPrefixed(["pistachio.devicelogin.v1", deviceId, challenge]);
}

export interface DeviceTokenClaims {
  /** Subject: userId (uuid). */
  sub: string;
  /** Device id (uuid). */
  did: string;
  /** Issued-at (epoch seconds). */
  iat: number;
  /** Expiry (epoch seconds). */
  exp: number;
  /** Token id (uuid) — lets a specific token be denylisted if ever needed. */
  jti: string;
}

const HEADER = base64urlEncode(utf8(JSON.stringify({ alg: "EdDSA", typ: "JWT" })));

export async function importTokenSigningKey(pkcs8: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", pkcs8 as BufferSource, "Ed25519", false, ["sign"]);
}

export async function importTokenVerifyKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw as BufferSource, "Ed25519", true, ["verify"]);
}

/** Generate a fresh control-plane signing keypair (setup/rotation). */
export async function generateTokenKeypair(): Promise<{
  privateKeyPkcs8: Uint8Array;
  publicKeyRaw: Uint8Array;
}> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  return {
    privateKeyPkcs8: new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    publicKeyRaw: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
  };
}

export async function signDeviceToken(
  signingKey: CryptoKey,
  claims: DeviceTokenClaims,
): Promise<string> {
  const payload = base64urlEncode(utf8(JSON.stringify(claims)));
  const signingInput = `${HEADER}.${payload}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign("Ed25519", signingKey, utf8(signingInput) as BufferSource),
  );
  return `${signingInput}.${base64urlEncode(sig)}`;
}

export type TokenVerifyResult =
  | { ok: true; claims: DeviceTokenClaims }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

/**
 * Verify signature and expiry. `nowSeconds` is injected so callers control the
 * clock (tests, and the Workers runtime where Date is fine but determinism
 * helps). A small negative skew is tolerated on exp.
 */
export async function verifyDeviceToken(
  verifyKey: CryptoKey,
  token: string,
  nowSeconds: number,
  clockSkewSeconds = 30,
): Promise<TokenVerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [header, payload, sig] = parts as [string, string, string];
  if (header !== HEADER) return { ok: false, reason: "malformed" };
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      "Ed25519",
      verifyKey,
      base64urlDecode(sig) as BufferSource,
      utf8(`${header}.${payload}`) as BufferSource,
    );
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
  if (!valid) return { ok: false, reason: "bad_signature" };
  let claims: DeviceTokenClaims;
  try {
    claims = JSON.parse(fromUtf8(base64urlDecode(payload))) as DeviceTokenClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof claims.sub !== "string" ||
    typeof claims.did !== "string" ||
    typeof claims.exp !== "number" ||
    typeof claims.iat !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (claims.exp + clockSkewSeconds < nowSeconds) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}
