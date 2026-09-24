import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deviceLoginSigningBytes, exportPublicKeyRaw, toBase64 } from "@pistachio/sync-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeviceStore, generateStoredDevice, importDeviceIdentity } from "../src/identity/device-store.js";
import { USER_A, USER_B } from "./helpers/keys.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cloud-browser-device-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("device store", () => {
  it("encrypts device.json at rest and round-trips both keypairs", async () => {
    const key = randomBytes(32);
    const store = new DeviceStore(dir, key);
    const stored = await generateStoredDevice(USER_A);
    await store.save(USER_A, stored);
    const raw = await readFile(store.pathFor(USER_A), "utf8");
    expect(raw).not.toContain(stored.deviceId);
    expect(raw).not.toContain("signingKey");
    expect(JSON.parse(raw)).toMatchObject({ version: 1 });
    const loaded = await store.load(USER_A);
    expect(loaded).toEqual(stored);
    const identity = await importDeviceIdentity(loaded as NonNullable<typeof loaded>);
    expect(identity.deviceId).toBe(stored.deviceId);
    expect(toBase64(await exportPublicKeyRaw(identity.signingPublicKey))).toBe(stored.devicePublicKey);
    expect(identity.agreementPublicKeyRaw.byteLength).toBe(32);
    // The imported signing key signs a challenge the public key verifies.
    const bytes = deviceLoginSigningBytes(identity.deviceId, "challenge");
    const signature = await crypto.subtle.sign("Ed25519", identity.signingPrivateKey, bytes as BufferSource);
    expect(await crypto.subtle.verify("Ed25519", identity.signingPublicKey, signature, bytes as BufferSource)).toBe(true);
    // The agreement private key stays extractable (needed by unwrapRootSecretFromDevice).
    expect(identity.agreementPrivateKey.extractable).toBe(true);
  });

  it("refuses the wrong key, a swapped user, and a tampered file", async () => {
    const store = new DeviceStore(dir, randomBytes(32));
    const stored = await generateStoredDevice(USER_A);
    await store.save(USER_A, stored);
    await expect(new DeviceStore(dir, randomBytes(32)).load(USER_A)).rejects.toThrow();
    await expect(store.save(USER_B, stored)).rejects.toThrow("another user");
    const path = store.pathFor(USER_A);
    const envelope = JSON.parse(await readFile(path, "utf8")) as { ciphertext: string };
    const bytes = Buffer.from(envelope.ciphertext, "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, JSON.stringify({ ...envelope, ciphertext: bytes.toString("base64") }));
    await expect(store.load(USER_A)).rejects.toThrow();
  });

  it("returns null when nothing is stored and deletes idempotently", async () => {
    const store = new DeviceStore(dir, randomBytes(32));
    expect(await store.load(USER_A)).toBeNull();
    await store.delete(USER_A);
    await store.save(USER_A, await generateStoredDevice(USER_A));
    await store.delete(USER_A);
    expect(await store.load(USER_A)).toBeNull();
    expect(() => store.pathFor("../etc")).toThrow("uuid");
  });
});
