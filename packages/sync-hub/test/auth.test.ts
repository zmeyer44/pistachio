import {
  generateTokenKeypair,
  importTokenSigningKey,
  signDeviceToken,
  toBase64,
  type DeviceTokenClaims,
} from "@pistachio/sync-protocol";
import { describe, expect, it } from "vitest";
import { authenticate, bearerToken, isDeviceJws, verifyBearer } from "../src/auth.js";

const NOW = 1_700_000_000;
const USER = "5f1a5f1a-0000-4000-8000-000000000001";
const DEVICE = "5f1a5f1a-0000-4000-8000-0000000000d1";

async function mintKit(): Promise<{ publicKey: string; signingKey: CryptoKey }> {
  const pair = await generateTokenKeypair();
  return {
    publicKey: toBase64(pair.publicKeyRaw),
    signingKey: await importTokenSigningKey(pair.privateKeyPkcs8),
  };
}

function claims(overrides: Partial<DeviceTokenClaims> = {}): DeviceTokenClaims {
  return {
    sub: USER,
    did: DEVICE,
    iat: NOW - 60,
    exp: NOW + 540,
    jti: "11111111-1111-4111-8111-111111111111",
    ...overrides,
  };
}

describe("bearerToken", () => {
  it("extracts the token from a Bearer header, case-insensitively", () => {
    expect(bearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(bearerToken("bearer abc")).toBe("abc");
  });

  it("rejects missing or malformed headers", () => {
    expect(bearerToken(null)).toBeNull();
    expect(bearerToken("abc")).toBeNull();
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken("Bearer")).toBeNull();
    expect(bearerToken("Bearer a b")).toBeNull();
  });
});

describe("isDeviceJws", () => {
  it("recognises only three-part EdDSA JWTs", async () => {
    const kit = await mintKit();
    expect(isDeviceJws(await signDeviceToken(kit.signingKey, claims()))).toBe(true);
    expect(isDeviceJws("hbr_dev_alice")).toBe(false);
    expect(isDeviceJws("a.b")).toBe(false);
    expect(isDeviceJws("not base64!.b.c")).toBe(false);
    // Three parts whose header is not the device-token header.
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    expect(isDeviceJws(`${header}.e30.c2ln`)).toBe(false);
  });
});

describe("authenticate", () => {
  it("verifies a control-plane-signed device token", async () => {
    const kit = await mintKit();
    const token = await signDeviceToken(kit.signingKey, claims());
    const result = await authenticate(
      `Bearer ${token}`,
      { CONTROL_PUBLIC_KEY: kit.publicKey },
      NOW,
    );
    expect(result).toEqual({ userId: USER, deviceId: DEVICE });
  });

  it("maps a bootstrap token (did === sub) to deviceId null", async () => {
    const kit = await mintKit();
    const token = await signDeviceToken(kit.signingKey, claims({ did: USER }));
    const result = await verifyBearer(token, { CONTROL_PUBLIC_KEY: kit.publicKey }, NOW);
    expect(result).toEqual({ userId: USER, deviceId: null });
  });

  it("rejects an expired token", async () => {
    const kit = await mintKit();
    const token = await signDeviceToken(kit.signingKey, claims({ exp: NOW - 120 }));
    const result = await authenticate(
      `Bearer ${token}`,
      { CONTROL_PUBLIC_KEY: kit.publicKey },
      NOW,
    );
    expect(result).toEqual({ error: "expired" });
  });

  it("rejects a token signed with the wrong key", async () => {
    const signer = await mintKit();
    const verifier = await mintKit();
    const token = await signDeviceToken(signer.signingKey, claims());
    const result = await authenticate(
      `Bearer ${token}`,
      { CONTROL_PUBLIC_KEY: verifier.publicKey },
      NOW,
    );
    expect(result).toEqual({ error: "bad_signature" });
  });

  it("has no development stub: non-JWT bearers are unauthorized", async () => {
    const kit = await mintKit();
    const env = { CONTROL_PUBLIC_KEY: kit.publicKey };
    expect(await authenticate("Bearer hbr_dev_alice", env, NOW)).toEqual({
      error: "unauthorized",
    });
    expect(await authenticate("Bearer hbr_dev_alice.device-1", env, NOW)).toEqual({
      error: "unauthorized",
    });
    expect(await authenticate("Bearer nope", env, NOW)).toEqual({ error: "unauthorized" });
    expect(await authenticate(null, env, NOW)).toEqual({ error: "unauthorized" });
    expect(await authenticate("Basic abc", env, NOW)).toEqual({ error: "unauthorized" });
  });

  it("rejects every token while no public key is configured", async () => {
    const kit = await mintKit();
    const token = await signDeviceToken(kit.signingKey, claims());
    expect(await authenticate(`Bearer ${token}`, {}, NOW)).toEqual({ error: "unauthorized" });
    expect(await authenticate(`Bearer ${token}`, { CONTROL_PUBLIC_KEY: "" }, NOW)).toEqual({
      error: "unauthorized",
    });
    expect(await authenticate("Bearer hbr_dev_alice", {}, NOW)).toEqual({
      error: "unauthorized",
    });
  });

  it("treats unimportable key material as unauthorized rather than throwing", async () => {
    const kit = await mintKit();
    const token = await signDeviceToken(kit.signingKey, claims());
    expect(
      await authenticate(`Bearer ${token}`, { CONTROL_PUBLIC_KEY: "AAAA" }, NOW),
    ).toEqual({ error: "unauthorized" });
  });
});
