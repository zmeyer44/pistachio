/**
 * Device identity and mutation signing (PRD §8.3 "device-signed mutations",
 * §9 threat "rogue/stolen device injects or resurrects cookies").
 *
 * Every enrolled device holds an Ed25519 signing keypair and an X25519
 * agreement keypair (D6). Every published mutation is signed; peers verify
 * against the enrolled-device registry from the control plane. The agreement
 * key receives sender-signed `device-x25519` root-secret wrappers (keys.ts).
 */

import { encodeHlc, type Hlc } from "./hlc.js";
import { lengthPrefixed } from "./encoding.js";
import type { Cause } from "./cookie.js";

/** A device is either a desktop or the hosted cloud browser (D10). */
export const DEVICE_KINDS = ["desktop", "cloud"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

/** Ed25519 signing keypair. */
export interface DeviceKeypair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

/** X25519 key-agreement keypair (extractable, JWK-exportable). */
export interface AgreementKeypair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

export async function generateDeviceKeypair(): Promise<DeviceKeypair> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return { publicKey: pair.publicKey, privateKey: pair.privateKey };
}

/** Raw public key bytes — 32 bytes for both Ed25519 and X25519 keys. */
export async function exportPublicKeyRaw(publicKey: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
}

/** Import a raw Ed25519 public key (record / wrapper signature verification). */
export async function importPublicKeyRaw(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw as BufferSource, "Ed25519", true, ["verify"]);
}

/** Import a raw X25519 public key (wrapping a root secret to a device). */
export async function importAgreementPublicKeyRaw(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw as BufferSource, "X25519", true, []);
}

export interface SignableRecordFields {
  spaceId: string;
  recordId: string; // hex
  originId: string; // hex
  sealedRecord: string; // base64
  hlc: Hlc;
  causalParent: string | null;
  cause: Cause;
}

/** Canonical bytes covered by a record's device signature. */
export function recordSigningBytes(r: SignableRecordFields): Uint8Array {
  return lengthPrefixed([
    "pistachio.recordsig.v1",
    r.spaceId,
    r.recordId,
    r.originId,
    r.sealedRecord,
    encodeHlc(r.hlc),
    r.causalParent ?? "",
    r.cause,
  ]);
}

export async function signRecord(
  privateKey: CryptoKey,
  r: SignableRecordFields,
): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.sign("Ed25519", privateKey, recordSigningBytes(r) as BufferSource),
  );
}

export async function verifyRecord(
  publicKey: CryptoKey,
  signature: Uint8Array,
  r: SignableRecordFields,
): Promise<boolean> {
  return crypto.subtle.verify(
    "Ed25519",
    publicKey,
    signature as BufferSource,
    recordSigningBytes(r) as BufferSource,
  );
}
