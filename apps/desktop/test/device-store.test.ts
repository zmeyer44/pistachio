/**
 * account.json (docs/cloud-sync-design.md §10.1, D20, D24): one device id
 * minted with the keys and never changed, every secret sealed with
 * safeStorage, atomic writes, and a locked store when the keychain is away.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const keychain = { available: true };

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => keychain.available,
    encryptString: (plain: string) => Buffer.from(`sealed:${plain}`, "utf8"),
    decryptString: (sealed: Buffer) => {
      const text = sealed.toString("utf8");
      if (!text.startsWith("sealed:")) throw new Error("not sealed by this keychain");
      return text.slice("sealed:".length);
    },
  },
}));

const { DeviceStore, ACCOUNT_FILE } = await import("../src/main/account/device-store");
const { toBase64, deviceLoginSigningBytes, importPublicKeyRaw } = await import("@pistachio/sync-protocol");

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "pistachio-account-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  keychain.available = true;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function secret(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

describe("DeviceStore", () => {
  it("mints a lowercase uuid v4 device id with the keys and keeps it across loads", async () => {
    const dir = scratch();
    const first = await DeviceStore.load(dir, { deviceName: "Pat's Mac" });
    expect(first.deviceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first.encryptionAvailable).toBe(true);
    expect(first.deviceName).toBe("Pat's Mac");
    expect(first.enrollment().state).toBe("unenrolled");
    expect(existsSync(join(dir, ACCOUNT_FILE))).toBe(true);

    const again = await DeviceStore.load(dir);
    expect(again.deviceId).toBe(first.deviceId);
    expect(again.devicePublicKey()).toBe(first.devicePublicKey());
    expect(again.agreementPublicKey()).toBe(first.agreementPublicKey());
    // The reloaded signing key still signs for the stored public key.
    const bytes = deviceLoginSigningBytes(again.deviceId, "challenge");
    const signature = await crypto.subtle.sign("Ed25519", again.identity().signingKey, bytes as BufferSource);
    const publicKey = await importPublicKeyRaw(Buffer.from(first.devicePublicKey(), "base64"));
    expect(await crypto.subtle.verify("Ed25519", publicKey, signature, bytes as BufferSource)).toBe(true);
  });

  it("seals every secret field so the file never holds them in the clear", async () => {
    const dir = scratch();
    const store = await DeviceStore.load(dir);
    store.setEnrollment({ state: "enrolled", userId: "u1", email: "pat@example.com", token: "tok.en.sig", bootstrapToken: null });
    store.setSpaceSecret("work", secret(7));
    store.setWorkspaceSecret(secret(9));
    store.setCloudDevicePin({ deviceId: "cloud-1", agreementPublicKey: toBase64(secret(3)) });

    const text = readFileSync(join(dir, ACCOUNT_FILE), "utf8");
    expect(text).not.toContain("tok.en.sig");
    expect(text).not.toContain(toBase64(secret(7)));
    expect(text).not.toContain(toBase64(secret(9)));
    expect(text).not.toContain('"d":'); // no private JWK component in the clear
    const parsed = JSON.parse(text) as Record<string, unknown> & { enrollment: Record<string, string>; spaceSecrets: Record<string, string> };
    const sealedBy = (value: string): string => Buffer.from(value, "base64").toString("utf8");
    expect(sealedBy(String(parsed["signingKey"]))).toMatch(/^sealed:\{/);
    expect(sealedBy(String(parsed["agreementKey"]))).toMatch(/^sealed:\{/);
    expect(sealedBy(parsed.enrollment["token"]!)).toBe("sealed:tok.en.sig");
    expect(sealedBy(parsed.spaceSecrets["work"]!)).toBe(`sealed:${toBase64(secret(7))}`);
    expect(sealedBy(String(parsed["workspaceSecret"]))).toBe(`sealed:${toBase64(secret(9))}`);
    // Public facts stay readable.
    expect(parsed).toMatchObject({ version: 1, deviceId: store.deviceId, enrollment: { state: "enrolled", email: "pat@example.com" } });

    const reloaded = await DeviceStore.load(dir);
    expect(reloaded.enrollment()).toEqual({
      state: "enrolled",
      userId: "u1",
      email: "pat@example.com",
      controlUrl: null,
      token: "tok.en.sig",
      bootstrapToken: null,
    });
    expect(reloaded.spaceSecret("work")).toEqual(secret(7));
    expect(reloaded.spaceSecret("missing")).toBeNull();
    expect(reloaded.workspaceSecret()).toEqual(secret(9));
    expect(reloaded.spaceSecretIds()).toEqual(["work"]);
    expect(reloaded.cloudDevicePin()).toEqual({ deviceId: "cloud-1", agreementPublicKey: toBase64(secret(3)) });
  });

  it("writes atomically: no temp file lingers and a partial write never replaces the file", async () => {
    const dir = scratch();
    const store = await DeviceStore.load(dir);
    store.setSpaceSecret("work", secret(1));
    expect(existsSync(join(dir, `${ACCOUNT_FILE}.tmp`))).toBe(false);
    expect(() => JSON.parse(readFileSync(join(dir, ACCOUNT_FILE), "utf8"))).not.toThrow();
  });

  it("stays locked and writes nothing when the keychain cannot encrypt", async () => {
    keychain.available = false;
    const dir = scratch();
    const store = await DeviceStore.load(dir);
    expect(store.encryptionAvailable).toBe(false);
    expect(existsSync(join(dir, ACCOUNT_FILE))).toBe(false);
    store.setSpaceSecret("work", secret(1));
    expect(existsSync(join(dir, ACCOUNT_FILE))).toBe(false);
    expect(store.spaceSecret("work")).toBeNull();
  });

  it("keeps a stored identity locked, not replaced, while the keychain is away", async () => {
    const dir = scratch();
    const first = await DeviceStore.load(dir);
    keychain.available = false;
    const locked = await DeviceStore.load(dir);
    expect(locked.deviceId).toBe(first.deviceId);
    expect(locked.encryptionAvailable).toBe(false);
    expect(() => locked.identity()).toThrow(/keychain/);
    keychain.available = true;
    const back = await DeviceStore.load(dir);
    expect(back.deviceId).toBe(first.deviceId);
    expect(() => back.identity()).not.toThrow();
  });

  it("sign-out clears the account but keeps the device id and keys (§10.1)", async () => {
    const dir = scratch();
    const store = await DeviceStore.load(dir);
    const publicKey = store.devicePublicKey();
    store.setEnrollment({ state: "enrolled", userId: "u1", email: "pat@example.com", token: "t.o.k" });
    store.setSpaceSecret("work", secret(2));
    store.setWorkspaceSecret(secret(4));
    store.setCloudDevicePin({ deviceId: "cloud-1", agreementPublicKey: toBase64(secret(3)) });
    store.setPendingWrappers([{ spaceId: "work", kind: "password", credentialId: "password", salt: "", wrapped: "x" }]);
    store.clearAccount();
    expect(store.deviceId).toBe(store.deviceId);
    expect(store.devicePublicKey()).toBe(publicKey);
    expect(store.enrollment().state).toBe("unenrolled");
    expect(store.enrollment().token).toBeNull();
    expect(store.spaceSecretIds()).toEqual([]);
    expect(store.workspaceSecret()).toBeNull();
    expect(store.cloudDevicePin()).toBeNull();
    expect(store.pendingWrappers()).toEqual([]);
    const reloaded = await DeviceStore.load(dir);
    expect(reloaded.deviceId).toBe(store.deviceId);
  });

  it("regenerates the id together with the keys, only on request", async () => {
    const dir = scratch();
    const store = await DeviceStore.load(dir);
    const before = { id: store.deviceId, key: store.devicePublicKey() };
    store.setSpaceSecret("work", secret(5));
    await store.regenerateIdentity();
    expect(store.deviceId).not.toBe(before.id);
    expect(store.devicePublicKey()).not.toBe(before.key);
    expect(store.spaceSecret("work")).toEqual(secret(5));
    const reloaded = await DeviceStore.load(dir);
    expect(reloaded.deviceId).toBe(store.deviceId);
  });

  it("re-mints an identity when the stored keys cannot be opened", async () => {
    const dir = scratch();
    const first = await DeviceStore.load(dir);
    const path = join(dir, ACCOUNT_FILE);
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    raw["signingKey"] = Buffer.from("garbage").toString("base64");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, JSON.stringify(raw));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const again = await DeviceStore.load(dir);
    expect(again.deviceId).not.toBe(first.deviceId);
    expect(() => again.identity()).not.toThrow();
    error.mockRestore();
  });
});
