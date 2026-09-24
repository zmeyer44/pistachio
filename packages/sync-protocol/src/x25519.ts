/**
 * X25519 key agreement with a portable fallback.
 *
 * Web Crypto only gained X25519 in Safari 18.4, Chrome 133 and Firefox 130.
 * The credential-capture page and device wrappers run in whatever browser
 * opened a link, so the ephemeral (sender) side of an agreement falls back
 * to a constant-time pure-JS implementation when `crypto.subtle` cannot do
 * it. The recipient side always holds a non-exportable Web Crypto private
 * key and stays on Web Crypto: enrolled devices are desktops and cloud
 * runners, never the browsers this fallback exists for.
 */

import { x25519 } from "@noble/curves/ed25519.js";

export type X25519Backend = "webcrypto" | "portable";

let webCryptoProbe: Promise<boolean> | null = null;

/** Whether this runtime's Web Crypto implements X25519 end to end. Probed once. */
export function webCryptoX25519Available(): Promise<boolean> {
  webCryptoProbe ??= (async (): Promise<boolean> => {
    try {
      const pair = (await crypto.subtle.generateKey("X25519", false, ["deriveBits"])) as CryptoKeyPair;
      await crypto.subtle.deriveBits({ name: "X25519", public: pair.publicKey }, pair.privateKey, 256);
      return true;
    } catch {
      return false;
    }
  })();
  return webCryptoProbe;
}

export interface EphemeralAgreement {
  /** Raw 32-byte public key to ship alongside the ciphertext. */
  publicKeyRaw: Uint8Array;
  /** Raw 32-byte shared secret; callers zero it once a key is derived. */
  sharedSecret: Uint8Array;
}

/**
 * Generate a one-use keypair and agree with `peerPublicKeyRaw`. The private
 * scalar is discarded (Web Crypto) or zeroed (portable) before returning.
 */
export async function ephemeralAgreement(
  peerPublicKeyRaw: Uint8Array,
  backend?: X25519Backend,
): Promise<EphemeralAgreement> {
  const chosen = backend ?? ((await webCryptoX25519Available()) ? "webcrypto" : "portable");
  if (chosen === "portable") {
    const secretKey = x25519.utils.randomSecretKey();
    try {
      return {
        publicKeyRaw: x25519.getPublicKey(secretKey),
        sharedSecret: x25519.getSharedSecret(secretKey, peerPublicKeyRaw),
      };
    } finally {
      secretKey.fill(0);
    }
  }
  const peer = await crypto.subtle.importKey("raw", peerPublicKeyRaw as BufferSource, "X25519", true, []);
  const pair = (await crypto.subtle.generateKey("X25519", true, ["deriveBits"])) as CryptoKeyPair;
  return {
    publicKeyRaw: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
    sharedSecret: new Uint8Array(
      await crypto.subtle.deriveBits({ name: "X25519", public: peer }, pair.privateKey, 256),
    ),
  };
}

/** Agreement from a held Web Crypto private key (the recipient side). */
export async function agreeWithPrivateKey(privateKey: CryptoKey, peerPublicKey: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "X25519", public: peerPublicKey }, privateKey, 256),
  );
}
