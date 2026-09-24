/**
 * The control plane owns the Ed25519 device-token signing key (D7).
 * `server.ts` requires `CONTROL_TOKEN_SK`/`CONTROL_TOKEN_PK`; `dev-server.ts`
 * generates an ephemeral pair with a loud warning; tests generate a pair.
 * There is no generated fallback here.
 */

import {
  fromBase64,
  generateTokenKeypair,
  importTokenSigningKey,
  importTokenVerifyKey,
  toBase64,
} from "@pistachio/sync-protocol";

/** Reads CONTROL_TOKEN_SK (base64 pkcs8) and CONTROL_TOKEN_PK (base64 raw). */
export type SigningKeyEnv = Record<string, string | undefined>;

export interface SigningKeys {
  signingKey: CryptoKey;
  verifyKey: CryptoKey;
  publicKeyBase64(): string;
}

export async function createSigningKeys(
  privateKeyPkcs8: Uint8Array,
  publicKeyRaw: Uint8Array,
): Promise<SigningKeys> {
  const signingKey = await importTokenSigningKey(privateKeyPkcs8);
  const verifyKey = await importTokenVerifyKey(publicKeyRaw);
  const publicKeyBase64 = toBase64(publicKeyRaw);
  return { signingKey, verifyKey, publicKeyBase64: () => publicKeyBase64 };
}

/** A fresh keypair (tests, dev-server). */
export async function generateSigningKeys(): Promise<SigningKeys> {
  const pair = await generateTokenKeypair();
  return createSigningKeys(pair.privateKeyPkcs8, pair.publicKeyRaw);
}

/** Base64 pair suitable for CONTROL_TOKEN_SK / CONTROL_TOKEN_PK. */
export async function generateSigningKeyEnv(): Promise<{ sk: string; pk: string }> {
  const pair = await generateTokenKeypair();
  return { sk: toBase64(pair.privateKeyPkcs8), pk: toBase64(pair.publicKeyRaw) };
}

/** Null when either variable is missing; throws when they do not decode. */
export async function signingKeysFromEnv(env: SigningKeyEnv): Promise<SigningKeys | null> {
  const sk = env["CONTROL_TOKEN_SK"];
  const pk = env["CONTROL_TOKEN_PK"];
  if (!sk || !pk) return null;
  return createSigningKeys(fromBase64(sk), fromBase64(pk));
}
