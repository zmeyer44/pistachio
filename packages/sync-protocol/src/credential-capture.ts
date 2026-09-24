/**
 * One-use credential payloads sealed by an otherwise unauthenticated browser
 * directly to the cloud device. The control plane publishes only the
 * recipient's enrolled X25519 public key and relays the resulting ciphertext.
 */

import { importAgreementPublicKeyRaw } from "./device.js";
import { lengthPrefixed, utf8, concatBytes } from "./encoding.js";
import { open, seal } from "./keys.js";
import { agreeWithPrivateKey, ephemeralAgreement, type X25519Backend } from "./x25519.js";

const BOX_VERSION = 0x01;
const X25519_PUBLIC_KEY_BYTES = 32;
const BOX_DOMAIN = "pistachio.credentialcapture.box.v1";
const MIN_SEALED_BYTES = 1 + 12 + 16;

async function deriveBoxKey(
  shared: Uint8Array,
  ephemeralPublicKeyRaw: Uint8Array,
  recipientPublicKeyRaw: Uint8Array,
  aad: Uint8Array,
): Promise<CryptoKey> {
  try {
    const material = await crypto.subtle.importKey("raw", shared as BufferSource, "HKDF", false, ["deriveKey"]);
    return await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: utf8(BOX_DOMAIN) as BufferSource,
        info: lengthPrefixed([ephemeralPublicKeyRaw, recipientPublicKeyRaw, aad]) as BufferSource,
      },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  } finally {
    shared.fill(0);
  }
}

/**
 * Seal plaintext to a raw X25519 public key. Output is version || ephemeral
 * public key || AES-GCM envelope. Runs in the browser that opened the
 * capture link, so the agreement falls back to pure JS where Web Crypto has
 * no X25519 (`backend` pins one for tests).
 */
export async function sealCredentialCapturePayload(
  recipientPublicKeyRaw: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
  backend?: X25519Backend,
): Promise<Uint8Array> {
  if (recipientPublicKeyRaw.byteLength !== X25519_PUBLIC_KEY_BYTES) {
    throw new Error("credential capture recipient key must be 32 bytes");
  }
  const ephemeral = await ephemeralAgreement(recipientPublicKeyRaw, backend);
  const key = await deriveBoxKey(ephemeral.sharedSecret, ephemeral.publicKeyRaw, recipientPublicKeyRaw, aad);
  const encrypted = await seal(key, plaintext, aad);
  return concatBytes(new Uint8Array([BOX_VERSION]), ephemeral.publicKeyRaw, encrypted);
}

/** Open a credential payload with the cloud device's X25519 private key. */
export async function openCredentialCapturePayload(
  recipientPrivateKey: CryptoKey,
  recipientPublicKeyRaw: Uint8Array,
  boxed: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  if (recipientPublicKeyRaw.byteLength !== X25519_PUBLIC_KEY_BYTES) {
    throw new Error("credential capture recipient key must be 32 bytes");
  }
  if (
    boxed[0] !== BOX_VERSION ||
    boxed.byteLength < 1 + X25519_PUBLIC_KEY_BYTES + MIN_SEALED_BYTES
  ) {
    throw new Error("malformed credential capture payload");
  }
  const ephemeralPublicKeyRaw = boxed.subarray(1, 1 + X25519_PUBLIC_KEY_BYTES);
  const ephemeralPublicKey = await importAgreementPublicKeyRaw(ephemeralPublicKeyRaw);
  const key = await deriveBoxKey(
    await agreeWithPrivateKey(recipientPrivateKey, ephemeralPublicKey),
    ephemeralPublicKeyRaw,
    recipientPublicKeyRaw,
    aad,
  );
  return open(key, boxed.subarray(1 + X25519_PUBLIC_KEY_BYTES), aad);
}
