/**
 * Key hierarchy (PRD §8.2, redesigned):
 *
 *   1. Per-space random ROOT SECRET (the "DEK" in PRD terms). From it we
 *      derive subkeys via HKDF: a sealing key (AES-256-GCM) for session
 *      envelopes and an id key (HMAC-SHA-256) for pseudonymous record/origin
 *      ids. Deriving both from one wrapped secret keeps exactly one thing to
 *      wrap, rotate, and recover per space.
 *   2. The root secret is WRAPPED independently for each enrolled credential:
 *      a password-derived KEK, an offline recovery code, and — for the cloud
 *      browser (D5/D6) — the recipient device's X25519 agreement key with a
 *      sender-signed `device-x25519` wrapper. Passkey PRF, hardware keys, and
 *      KMS wrappers keep their kinds for later.
 *   3. Wrappers rotate on device add/revoke; the root secret itself rotates
 *      after a security event.
 *
 * PRF output is credential-associated and must never be used directly as the
 * permanent data key — it only ever derives a wrapping KEK.
 */

import { base64urlDecode, concatBytes, fromBase64, lengthPrefixed, toBase64, utf8 } from "./encoding.js";
import { agreeWithPrivateKey, ephemeralAgreement, type X25519Backend } from "./x25519.js";
import { importAgreementPublicKeyRaw, type AgreementKeypair } from "./device.js";

export interface SpaceKeys {
  spaceId: string;
  /** AES-256-GCM key sealing/opening session record envelopes. */
  sealKey: CryptoKey;
  /** HMAC-SHA-256 key producing pseudonymous record and origin ids. */
  idKey: CryptoKey;
}

export const SPACE_ROOT_SECRET_BYTES = 32;

export function generateSpaceRootSecret(): Uint8Array {
  const secret = new Uint8Array(SPACE_ROOT_SECRET_BYTES);
  crypto.getRandomValues(secret);
  return secret;
}

async function hkdfDerive(
  rootSecret: Uint8Array,
  info: string,
  algorithm: AesKeyGenParams | HmacKeyGenParams,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", rootSecret as BufferSource, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: utf8("pistachio.space.v1") as BufferSource,
      info: utf8(info) as BufferSource,
    },
    ikm,
    algorithm,
    false,
    usages,
  );
}

export async function deriveSpaceKeys(spaceId: string, rootSecret: Uint8Array): Promise<SpaceKeys> {
  if (rootSecret.length !== SPACE_ROOT_SECRET_BYTES) throw new Error("bad root secret length");
  const sealKey = await hkdfDerive(rootSecret, `seal:${spaceId}`, { name: "AES-GCM", length: 256 }, [
    "encrypt",
    "decrypt",
  ]);
  const idKey = await hkdfDerive(
    rootSecret,
    `id:${spaceId}`,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    ["sign"],
  );
  return { spaceId, sealKey, idKey };
}

/* ------------------------------------------------------------------ *
 * Sealing (AES-256-GCM envelopes)
 * ------------------------------------------------------------------ */

const SEALED_VERSION = 0x01;
const GCM_IV_BYTES = 12;

/** Seal plaintext under the space seal key. Output: version || iv || ciphertext+tag. */
export async function seal(
  sealKey: CryptoKey,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const iv = new Uint8Array(GCM_IV_BYTES);
  crypto.getRandomValues(iv);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource, additionalData: aad as BufferSource },
      sealKey,
      plaintext as BufferSource,
    ),
  );
  return concatBytes(new Uint8Array([SEALED_VERSION]), iv, ct);
}

export async function open(
  sealKey: CryptoKey,
  sealed: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  if (sealed[0] !== SEALED_VERSION) throw new Error(`unknown sealed version ${sealed[0]}`);
  const iv = sealed.subarray(1, 1 + GCM_IV_BYTES);
  const ct = sealed.subarray(1 + GCM_IV_BYTES);
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource, additionalData: aad as BufferSource },
      sealKey,
      ct as BufferSource,
    ),
  );
}

/* ------------------------------------------------------------------ *
 * KEK wrappers
 * ------------------------------------------------------------------ */

export type KeyWrapperKind =
  | "password"
  | "recovery-code"
  | "device-x25519"
  | "passkey-prf"
  | "hardware-key"
  | "kms"
  | "enrollment-code";

/**
 * Serialized wrapper stored by the control plane (opaque to the server).
 *
 * `credentialId` conventions: `password` → `"password"`, `recovery-code` →
 * `"recovery"`, `device-x25519` → the recipient device id, `passkey-prf` →
 * the WebAuthn credential id. `senderDeviceId` and `signature` are required
 * when `kind === "device-x25519"` and absent otherwise.
 */
export interface KeyWrapper {
  kind: KeyWrapperKind;
  spaceId: string;
  credentialId: string;
  /**
   * base64: PBKDF2 salt for password / recovery-code / enrollment-code
   * wrappers, the ephemeral X25519 public key for `device-x25519` wrappers,
   * "" otherwise.
   */
  salt: string;
  /** base64: version || iv || ciphertext+tag over the space root secret. */
  wrapped: string;
  createdAtMs: number;
  /** `device-x25519` only: the enrolled user device that produced the wrapper. */
  senderDeviceId?: string;
  /** `device-x25519` only: base64 Ed25519 signature by `senderDeviceId`. */
  signature?: string;
}

/** Derive a wrapping KEK from WebAuthn PRF output (never used as a data key). */
export async function deriveKekFromPrf(
  prfOutput: Uint8Array,
  credentialId: string,
): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", prfOutput as BufferSource, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: utf8("pistachio.kek.v1") as BufferSource,
      info: lengthPrefixed(["passkey-prf", credentialId]) as BufferSource,
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export const RECOVERY_CODE_PBKDF2_ITERATIONS = 600_000;

/** Crockford base32, no ambiguous characters. */
const RECOVERY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RECOVERY_GROUPS = 8;
const RECOVERY_GROUP_LEN = 4;

/** High-entropy offline recovery code (160 bits), shown once, user-stored. */
export function generateRecoveryCode(): string {
  const chars = RECOVERY_GROUPS * RECOVERY_GROUP_LEN;
  const random = new Uint8Array(chars);
  crypto.getRandomValues(random);
  const groups: string[] = [];
  for (let g = 0; g < RECOVERY_GROUPS; g++) {
    let group = "";
    for (let i = 0; i < RECOVERY_GROUP_LEN; i++) {
      group += RECOVERY_ALPHABET[(random[g * RECOVERY_GROUP_LEN + i] as number) % 32];
    }
    groups.push(group);
  }
  return groups.join("-");
}

/**
 * Second-device enrollment code (§8.2): shorter than a recovery code because a
 * human types it across the room in a 10-minute window, and single-use. Same
 * unambiguous alphabet, three groups of four (~60 bits) — enough for a
 * short-lived single-use secret, stretched by PBKDF2 before it guards keys.
 */
export function generateEnrollmentCode(): string {
  const groups = 3;
  const random = new Uint8Array(groups * RECOVERY_GROUP_LEN);
  crypto.getRandomValues(random);
  const out: string[] = [];
  for (let g = 0; g < groups; g++) {
    let group = "";
    for (let i = 0; i < RECOVERY_GROUP_LEN; i++) {
      group += RECOVERY_ALPHABET[(random[g * RECOVERY_GROUP_LEN + i] as number) % 32];
    }
    out.push(group);
  }
  return out.join("-");
}

export function normalizeRecoveryCode(code: string): string {
  const cleaned = code.toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (cleaned.length !== RECOVERY_GROUPS * RECOVERY_GROUP_LEN) {
    throw new Error("recovery code must contain 32 characters");
  }
  return cleaned;
}

export async function deriveKekFromRecoveryCode(
  code: string,
  salt: Uint8Array,
  iterations: number = RECOVERY_CODE_PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  return deriveKekFromPassphrase(normalizeRecoveryCode(code), salt, iterations);
}

/**
 * KEK from an arbitrary secret string (no recovery-code normalization). Used
 * for the account password (`password` wrappers) and the second-device
 * enrollment code (§8.2): the control plane never sees plaintext key
 * material. PBKDF2 stretching is the point for the lower-entropy inputs.
 */
export async function deriveKekFromPassphrase(
  passphrase: string,
  salt: Uint8Array,
  iterations: number = RECOVERY_CODE_PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    utf8(passphrase) as BufferSource,
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const WRAP_DOMAIN = "pistachio.wrap.v1";

export async function wrapRootSecret(
  kek: CryptoKey,
  rootSecret: Uint8Array,
  spaceId: string,
): Promise<Uint8Array> {
  return seal(kek, rootSecret, lengthPrefixed([WRAP_DOMAIN, spaceId]));
}

export async function unwrapRootSecret(
  kek: CryptoKey,
  wrapped: Uint8Array,
  spaceId: string,
): Promise<Uint8Array> {
  const secret = await open(kek, wrapped, lengthPrefixed([WRAP_DOMAIN, spaceId]));
  if (secret.length !== SPACE_ROOT_SECRET_BYTES) throw new Error("unwrapped secret has bad length");
  return secret;
}

export function serializeWrapper(w: Omit<KeyWrapper, "wrapped" | "salt"> & {
  wrapped: Uint8Array;
  salt?: Uint8Array;
}): KeyWrapper {
  const out: KeyWrapper = {
    kind: w.kind,
    spaceId: w.spaceId,
    credentialId: w.credentialId,
    salt: w.salt ? toBase64(w.salt) : "",
    wrapped: toBase64(w.wrapped),
    createdAtMs: w.createdAtMs,
  };
  if (w.senderDeviceId !== undefined) out.senderDeviceId = w.senderDeviceId;
  if (w.signature !== undefined) out.signature = w.signature;
  return out;
}

export function wrapperBytes(w: KeyWrapper): { wrapped: Uint8Array; salt: Uint8Array | null } {
  return { wrapped: fromBase64(w.wrapped), salt: w.salt ? fromBase64(w.salt) : null };
}

/* ------------------------------------------------------------------ *
 * Device-to-device wrappers (D6): X25519 + HKDF + AES-GCM, sender-signed
 * ------------------------------------------------------------------ */

const X25519_WRAP_DOMAIN = "pistachio.x25519.wrap.v1";
const WRAP_SIG_DOMAIN = "pistachio.wrapsig.v1";
const DEVICE_WRAPPER_KIND: KeyWrapperKind = "device-x25519";

/** X25519 agreement keypair: extractable so the desktop can persist it as JWK. */
export async function generateAgreementKeypair(): Promise<AgreementKeypair> {
  const pair = (await crypto.subtle.generateKey("X25519", true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  return { publicKey: pair.publicKey, privateKey: pair.privateKey };
}

/** Canonical bytes covered by a `device-x25519` wrapper's sender signature. */
export function deviceWrapperSigningBytes(
  spaceId: string,
  recipientDeviceId: string,
  salt: string,
  wrapped: string,
): Uint8Array {
  return lengthPrefixed([WRAP_SIG_DOMAIN, spaceId, recipientDeviceId, salt, wrapped]);
}

function deviceWrapAad(spaceId: string, recipientDeviceId: string): Uint8Array {
  return lengthPrefixed([WRAP_DOMAIN, spaceId, recipientDeviceId]);
}

async function deriveDeviceWrapKey(
  shared: Uint8Array,
  spaceId: string,
  recipientDeviceId: string,
  ephemeralPublicKeyB64: string,
  recipientPublicKeyB64: string,
): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", shared as BufferSource, "HKDF", false, [
    "deriveKey",
  ]);
  shared.fill(0);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: utf8(X25519_WRAP_DOMAIN) as BufferSource,
      info: lengthPrefixed([
        spaceId,
        recipientDeviceId,
        ephemeralPublicKeyB64,
        recipientPublicKeyB64,
      ]) as BufferSource,
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Raw public key of an extractable X25519 private key (JWK `x` component). */
async function agreementPublicKeyFromPrivate(privateKey: CryptoKey): Promise<Uint8Array> {
  let jwk: JsonWebKey;
  try {
    jwk = await crypto.subtle.exportKey("jwk", privateKey);
  } catch {
    throw new Error("agreement private key must be extractable (or pass agreementPublicKeyRaw)");
  }
  if (typeof jwk.x !== "string" || jwk.x.length === 0) throw new Error("agreement key has no public component");
  return base64urlDecode(jwk.x);
}

/**
 * Wrap a space root secret to another device's X25519 agreement key (D6).
 * The wrapper is authenticated by the sender's Ed25519 signing key so the
 * recipient can refuse a wrapper the control plane (or anyone else) minted.
 * The sender may be a browser without Web Crypto X25519; the ephemeral
 * agreement then runs in pure JS (`backend` pins one for tests).
 */
export async function wrapRootSecretToDevice(
  rootSecret: Uint8Array,
  spaceId: string,
  recipient: { deviceId: string; agreementPublicKeyRaw: Uint8Array },
  sender: { deviceId: string; signingKey: CryptoKey },
  backend?: X25519Backend,
): Promise<KeyWrapper> {
  if (rootSecret.length !== SPACE_ROOT_SECRET_BYTES) throw new Error("bad root secret length");
  const ephemeral = await ephemeralAgreement(recipient.agreementPublicKeyRaw, backend);
  const salt = toBase64(ephemeral.publicKeyRaw);
  const key = await deriveDeviceWrapKey(
    ephemeral.sharedSecret,
    spaceId,
    recipient.deviceId,
    salt,
    toBase64(recipient.agreementPublicKeyRaw),
  );
  const wrapped = toBase64(await seal(key, rootSecret, deviceWrapAad(spaceId, recipient.deviceId)));
  const signature = toBase64(
    new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        sender.signingKey,
        deviceWrapperSigningBytes(spaceId, recipient.deviceId, salt, wrapped) as BufferSource,
      ),
    ),
  );
  return {
    kind: DEVICE_WRAPPER_KIND,
    spaceId,
    credentialId: recipient.deviceId,
    salt,
    wrapped,
    createdAtMs: Date.now(),
    senderDeviceId: sender.deviceId,
    signature,
  };
}

/**
 * Recover a root secret from a `device-x25519` wrapper addressed to this
 * device. `senderPublicKey` is the Ed25519 key registered for
 * `wrapper.senderDeviceId` — the caller looks it up in the device registry.
 * Throws on any mismatch (kind, space, recipient, signature) before touching
 * the ciphertext.
 */
export async function unwrapRootSecretFromDevice(
  wrapper: KeyWrapper,
  spaceId: string,
  self: { deviceId: string; agreementPrivateKey: CryptoKey; agreementPublicKeyRaw?: Uint8Array },
  senderPublicKey: CryptoKey,
): Promise<Uint8Array> {
  if (wrapper.kind !== DEVICE_WRAPPER_KIND) throw new Error("wrapper is not a device-x25519 wrapper");
  if (wrapper.spaceId !== spaceId) throw new Error("wrapper is for another space");
  if (wrapper.credentialId !== self.deviceId) throw new Error("wrapper is for another device");
  if (typeof wrapper.senderDeviceId !== "string" || wrapper.senderDeviceId.length === 0) {
    throw new Error("wrapper has no sender");
  }
  if (typeof wrapper.signature !== "string" || wrapper.signature.length === 0) {
    throw new Error("wrapper is unsigned");
  }
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      "Ed25519",
      senderPublicKey,
      fromBase64(wrapper.signature) as BufferSource,
      deviceWrapperSigningBytes(spaceId, self.deviceId, wrapper.salt, wrapper.wrapped) as BufferSource,
    );
  } catch {
    valid = false;
  }
  if (!valid) throw new Error("wrapper signature does not verify");
  const ephemeralPublicKey = await importAgreementPublicKeyRaw(fromBase64(wrapper.salt));
  const ownPublicKeyRaw =
    self.agreementPublicKeyRaw ?? (await agreementPublicKeyFromPrivate(self.agreementPrivateKey));
  const key = await deriveDeviceWrapKey(
    await agreeWithPrivateKey(self.agreementPrivateKey, ephemeralPublicKey),
    spaceId,
    self.deviceId,
    wrapper.salt,
    toBase64(ownPublicKeyRaw),
  );
  const secret = await open(key, fromBase64(wrapper.wrapped), deviceWrapAad(spaceId, self.deviceId));
  if (secret.length !== SPACE_ROOT_SECRET_BYTES) throw new Error("unwrapped secret has bad length");
  return secret;
}
