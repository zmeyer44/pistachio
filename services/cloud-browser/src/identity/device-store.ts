/**
 * The cloud device's identity at rest (docs/cloud-sync-design.md §8.2):
 * `CLOUD_BROWSER_STATE_DIR/<userId>/device.json`, AES-256-GCM under
 * `CLOUD_BROWSER_STATE_KEY`, written atomically. The device id and both
 * keypairs are minted together and never change (D24); a revoked identity
 * is deleted and never reused.
 */

import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  exportPublicKeyRaw,
  generateAgreementKeypair,
  generateDeviceKeypair,
  toBase64,
} from "@pistachio/sync-protocol";

export interface StoredDevice {
  version: 1;
  userId: string;
  deviceId: string;
  /** Ed25519 private key as JWK. */
  signingKey: JsonWebKey;
  /** X25519 private key as JWK. */
  agreementKey: JsonWebKey;
  /** base64 raw 32 B. */
  devicePublicKey: string;
  /** base64 raw 32 B. */
  agreementPublicKey: string;
}

/** The identity as the runner uses it: keys imported, public raw bytes at hand. */
export interface DeviceIdentity {
  userId: string;
  deviceId: string;
  devicePublicKey: string;
  agreementPublicKey: string;
  signingPrivateKey: CryptoKey;
  signingPublicKey: CryptoKey;
  agreementPrivateKey: CryptoKey;
  agreementPublicKeyRaw: Uint8Array;
}

interface EncryptedEnvelope {
  version: 1;
  nonce: string;
  ciphertext: string;
  tag: string;
}

const AAD_PREFIX = "pistachio.cloud-browser.device.v1\0";
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function assertUserId(userId: string): void {
  if (!USER_ID_PATTERN.test(userId)) throw new Error("userId must be a lowercase uuid");
}

export class DeviceStore {
  readonly #directory: string;
  readonly #key: Buffer;

  constructor(directory: string, masterKey: Uint8Array) {
    if (masterKey.byteLength !== 32) {
      throw new Error("device store key must be exactly 32 bytes");
    }
    this.#directory = directory;
    this.#key = Buffer.from(masterKey);
  }

  pathFor(userId: string): string {
    assertUserId(userId);
    return join(this.#directory, userId, "device.json");
  }

  async load(userId: string): Promise<StoredDevice | null> {
    let encoded: string;
    try {
      encoded = await readFile(this.pathFor(userId), "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
    const envelope = JSON.parse(encoded) as EncryptedEnvelope;
    if (envelope.version !== 1) throw new Error("unsupported device envelope version");
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(envelope.nonce, "base64"));
    decipher.setAAD(Buffer.from(`${AAD_PREFIX}${userId}`, "utf8"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]);
    const stored = JSON.parse(plaintext.toString("utf8")) as StoredDevice;
    if (stored.version !== 1 || stored.userId !== userId || typeof stored.deviceId !== "string") {
      throw new Error("malformed device record");
    }
    return stored;
  }

  async save(userId: string, device: StoredDevice): Promise<void> {
    if (device.userId !== userId) throw new Error("device record belongs to another user");
    const path = this.pathFor(userId);
    await mkdir(join(this.#directory, userId), { recursive: true, mode: 0o700 });
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(Buffer.from(`${AAD_PREFIX}${userId}`, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(device), "utf8"), cipher.final()]);
    const envelope: EncryptedEnvelope = {
      version: 1,
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
    const temporary = `${path}.${String(process.pid)}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, JSON.stringify(envelope), { mode: 0o600 });
    await rename(temporary, path);
  }

  async delete(userId: string): Promise<void> {
    await rm(this.pathFor(userId), { force: true });
  }
}

/** Mint a brand-new identity: one uuid, an Ed25519 pair, an X25519 pair. */
export async function generateStoredDevice(userId: string): Promise<StoredDevice> {
  assertUserId(userId);
  const signing = await generateDeviceKeypair();
  const agreement = await generateAgreementKeypair();
  return {
    version: 1,
    userId,
    deviceId: randomUUID(),
    signingKey: await crypto.subtle.exportKey("jwk", signing.privateKey),
    agreementKey: await crypto.subtle.exportKey("jwk", agreement.privateKey),
    devicePublicKey: toBase64(await exportPublicKeyRaw(signing.publicKey)),
    agreementPublicKey: toBase64(await exportPublicKeyRaw(agreement.publicKey)),
  };
}

/** Import a stored record's keys. The agreement key stays extractable (§14). */
export async function importDeviceIdentity(stored: StoredDevice): Promise<DeviceIdentity> {
  const signingPrivateKey = await crypto.subtle.importKey("jwk", stored.signingKey, "Ed25519", true, ["sign"]);
  const signingPublicJwk: JsonWebKey = { kty: stored.signingKey.kty, crv: stored.signingKey.crv, x: stored.signingKey.x };
  const signingPublicKey = await crypto.subtle.importKey("jwk", signingPublicJwk, "Ed25519", true, ["verify"]);
  const agreementPrivateKey = await crypto.subtle.importKey("jwk", stored.agreementKey, "X25519", true, ["deriveBits"]);
  const agreementPublicKeyRaw = new Uint8Array(Buffer.from(stored.agreementPublicKey, "base64"));
  if (agreementPublicKeyRaw.byteLength !== 32) throw new Error("malformed agreement public key");
  return {
    userId: stored.userId,
    deviceId: stored.deviceId,
    devicePublicKey: stored.devicePublicKey,
    agreementPublicKey: stored.agreementPublicKey,
    signingPrivateKey,
    signingPublicKey,
    agreementPrivateKey,
    agreementPublicKeyRaw,
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
