import { randomUUID } from "node:crypto";
import {
  deriveSpaceKeys,
  fromBase64,
  fromUtf8,
  open,
  generateDeviceKeypair,
  liveProofSealAad,
  seal,
  shellProofSealAad,
  SPACE_ROOT_SECRET_BYTES,
  toBase64,
  utf8,
  type CookieAttributes,
  type CookieIdentity,
  type DeviceKeypair,
  type SpaceKeys,
} from "@pistachio/sync-protocol";

export const USER_A = "11111111-1111-4111-8111-111111111111";
export const USER_B = "22222222-2222-4222-8222-222222222222";

export function testRootSecret(fill = 0x42): Uint8Array {
  return new Uint8Array(SPACE_ROOT_SECRET_BYTES).fill(fill);
}

export function testSpaceKeys(spaceId: string, fill = 0x42): Promise<SpaceKeys> {
  return deriveSpaceKeys(spaceId, testRootSecret(fill));
}

export async function testSigner(): Promise<{ deviceId: string; privateKey: CryptoKey; keypair: DeviceKeypair }> {
  const keypair = await generateDeviceKeypair();
  return { deviceId: randomUUID(), privateKey: keypair.privateKey, keypair };
}

export function identity(spaceId: string, hostKey: string, name: string, path = "/", secure = true): CookieIdentity {
  return { spaceId, hostKey, name, path, partitionKey: "", sourceScheme: secure ? "secure" : "nonsecure" };
}

export function attrs(value: string, overrides: Partial<CookieAttributes> = {}): CookieAttributes {
  return {
    value,
    expiresMs: null,
    persistent: false,
    secure: true,
    httpOnly: false,
    sameSite: "lax",
    priority: "medium",
    ...overrides,
  };
}

/**
 * Answer a live view's challenge the way a real client does (§8.5): the
 * nonce sealed under the Space key, base64.
 */
export async function liveProof(
  spaceId: string,
  runId: string,
  nonce: string,
  fill = 0x42,
): Promise<string> {
  const keys = await testSpaceKeys(spaceId, fill);
  return toBase64(await seal(keys.sealKey, utf8(nonce), liveProofSealAad(runId, nonce)));
}

/**
 * Answer a shell socket's challenge the way the web app does (§5): the nonce
 * sealed under the Space key, under the shell domain so it can never stand in
 * for a live-view proof.
 */
export async function shellProof(
  spaceId: string,
  sessionId: string,
  nonce: string,
  fill = 0x42,
): Promise<string> {
  const keys = await testSpaceKeys(spaceId, fill);
  return toBase64(await seal(keys.sealKey, utf8(nonce), shellProofSealAad(sessionId, nonce)));
}

/**
 * Open a shell proof the way the host does. Sealing is randomized, so a proof
 * can only ever be checked by opening it — comparing two seals of the same
 * nonce would compare two different ciphertexts.
 */
export async function verifyShellProof(
  spaceId: string,
  sessionId: string,
  nonce: string,
  proof: string,
  fill = 0x42,
): Promise<boolean> {
  const keys = await testSpaceKeys(spaceId, fill);
  try {
    return fromUtf8(await open(keys.sealKey, fromBase64(proof), shellProofSealAad(sessionId, nonce))) === nonce;
  } catch {
    return false;
  }
}
