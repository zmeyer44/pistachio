import { describe, expect, it } from "vitest";

import {
  Authenticator,
  DevVerifier,
  RevocationSet,
  SharedSecretVerifier,
  authFailureStatus,
  credentialPassword,
  parseCredentialUsername,
  parseProxyAuthorization,
  parseSecretHex,
} from "../src/auth.js";
import { basicProxyAuthorization, bearerProxyAuthorization, mintCredential } from "../src/mint.js";
import { DEVICE_A, DEVICE_B, OTHER_SECRET_HEX, SECRET_HEX, USER_A, USER_B, credentialFor } from "./helpers.js";

describe("credential username", () => {
  it("parses exactly five dot-separated fields with the pe1 prefix", () => {
    const username = `pe1.${USER_A}.${DEVICE_A}.${DEVICE_B}.1700000000`;
    expect(parseCredentialUsername(username)).toEqual({
      username,
      userId: USER_A,
      deviceId: DEVICE_A,
      credentialId: DEVICE_B,
      exp: 1700000000,
    });
  });

  it("rejects the wrong prefix, wrong field counts, and non-canonical ids", () => {
    const good = `pe1.${USER_A}.${DEVICE_A}.${DEVICE_B}.1700000000`;
    for (const bad of [
      "",
      "garbage",
      good.replace("pe1", "pe2"),
      good.replace("pe1", "PE1"),
      `${good}.extra`,
      `pe1.${USER_A}.${DEVICE_A}.1700000000`,
      good.replace(USER_A, "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"),
      good.replace(DEVICE_A, "not-a-uuid"),
      good.replace(/1700000000$/, "17e8"),
      good.replace(/1700000000$/, "-1"),
      good.replace(/1700000000$/, ""),
      `.${good}`,
    ]) {
      expect(parseCredentialUsername(bad), bad).toBeNull();
    }
  });
});

describe("Proxy-Authorization parsing", () => {
  const credential = credentialFor();

  it("decodes Basic and splits at the first colon", () => {
    expect(parseProxyAuthorization(basicProxyAuthorization(credential))).toEqual({
      username: credential.username,
      password: credential.password,
    });
    expect(parseProxyAuthorization(`basic ${Buffer.from("u:p:q").toString("base64")}`)).toEqual({
      username: "u",
      password: "p:q",
    });
  });

  it("splits Bearer at the last dot because the username carries four", () => {
    const presented = parseProxyAuthorization(bearerProxyAuthorization(credential));
    expect(presented).toEqual({ username: credential.username, password: credential.password });
    expect(presented?.username.split(".")).toHaveLength(5);
  });

  it("rejects other schemes and empty halves", () => {
    for (const bad of [
      undefined,
      "",
      "Basic",
      "Basic ",
      "Digest abc",
      `Basic ${Buffer.from("nocolon").toString("base64")}`,
      `Basic ${Buffer.from(":pw").toString("base64")}`,
      "Bearer nodots",
      "Bearer trailing.",
      "Bearer .leading",
      "Bearer",
    ]) {
      expect(parseProxyAuthorization(bad), String(bad)).toBeNull();
    }
  });
});

describe("SharedSecretVerifier", () => {
  const verifier = SharedSecretVerifier.fromHex(SECRET_HEX);

  it("is base64url HMAC-SHA256 over utf8(username) without padding", () => {
    const credential = mintCredential({ secretHex: SECRET_HEX, userId: USER_A, deviceId: DEVICE_A });
    expect(credential.password).toHaveLength(43);
    expect(credential.password).not.toContain("=");
    expect(credential.password).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(credential.password).toBe(credentialPassword(Buffer.from(SECRET_HEX, "hex"), credential.username));
    expect(verifier.verify(credential.username, credential.password)).toBe(true);
  });

  it("rejects a tampered MAC, a foreign secret, and a swapped user id", () => {
    const credential = credentialFor();
    const last = credential.password.at(-1) === "A" ? "B" : "A";
    expect(verifier.verify(credential.username, credential.password.slice(0, -1) + last)).toBe(false);
    expect(verifier.verify(credential.username, "")).toBe(false);
    expect(verifier.verify(credential.username, `${credential.password}=`)).toBe(false);
    const foreign = credentialFor(USER_A, DEVICE_A, { secretHex: OTHER_SECRET_HEX });
    expect(verifier.verify(foreign.username, foreign.password)).toBe(false);
    const swapped = credential.username.replace(USER_A, USER_B);
    expect(verifier.verify(swapped, credential.password)).toBe(false);
    const laterExp = credential.username.replace(/\d+$/, String(credential.expiresAt + 3600));
    expect(verifier.verify(laterExp, credential.password)).toBe(false);
  });

  it("refuses anything but 64 lowercase hex characters as the secret", () => {
    expect(parseSecretHex(SECRET_HEX)).toHaveLength(32);
    for (const bad of ["", "abcd", "ab".repeat(33), "AB".repeat(32), "zz".repeat(32), `${SECRET_HEX}\n0`]) {
      expect(parseSecretHex(bad), bad).toBeNull();
      expect(() => SharedSecretVerifier.fromHex(bad)).toThrow(/hex/);
    }
    expect(parseSecretHex(` ${SECRET_HEX} `)).toHaveLength(32);
  });
});

describe("DevVerifier", () => {
  it("accepts any non-empty password (it authenticates nothing)", () => {
    const dev = new DevVerifier();
    expect(dev.verify("whatever", "x")).toBe(true);
    expect(dev.verify("whatever", "")).toBe(false);
  });
});

describe("Authenticator", () => {
  const nowMs = 1_800_000_000_000;
  const now = (): number => nowMs;
  const make = (options: { ownerUserId?: string; revocations?: RevocationSet } = {}): Authenticator =>
    new Authenticator({
      verifier: SharedSecretVerifier.fromHex(SECRET_HEX),
      now,
      ...options,
    });

  it("accepts a fresh credential in both header forms", () => {
    const credential = credentialFor(USER_A, DEVICE_A, { expiresAtSeconds: nowMs / 1000 + 60 });
    const auth = make();
    for (const header of [basicProxyAuthorization(credential), bearerProxyAuthorization(credential)]) {
      const result = auth.authenticate(header);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.credential.userId).toBe(USER_A);
        expect(result.credential.deviceId).toBe(DEVICE_A);
        expect(result.credential.credentialId).toBe(credential.credentialId);
      }
    }
  });

  it("fails closed in order: missing, malformed, MAC, expiry, revocation, owner", () => {
    const auth = make({ ownerUserId: USER_A, revocations: new RevocationSet() });
    expect(auth.authenticate(undefined)).toEqual({ ok: false, reason: "missing" });
    expect(auth.authenticate("Basic !!!")).toEqual({ ok: false, reason: "malformed" });
    const fresh = credentialFor(USER_A, DEVICE_A, { expiresAtSeconds: nowMs / 1000 + 60 });
    expect(auth.authenticate(`Bearer ${fresh.username}.wrong`)).toEqual({ ok: false, reason: "bad_signature" });
    const expired = credentialFor(USER_A, DEVICE_A, { expiresAtSeconds: nowMs / 1000 - 1 });
    expect(auth.authenticate(basicProxyAuthorization(expired))).toEqual({ ok: false, reason: "expired" });
    const boundary = credentialFor(USER_A, DEVICE_A, { expiresAtSeconds: nowMs / 1000 });
    expect(auth.authenticate(basicProxyAuthorization(boundary))).toEqual({ ok: false, reason: "expired" });

    auth.revocations.revokeCredential(fresh.credentialId);
    expect(auth.authenticate(basicProxyAuthorization(fresh))).toEqual({ ok: false, reason: "credential_revoked" });
    auth.revocations.revokeDevice(DEVICE_A);
    expect(auth.authenticate(basicProxyAuthorization(fresh))).toEqual({ ok: false, reason: "device_revoked" });

    const other = credentialFor(USER_B, DEVICE_B, { expiresAtSeconds: nowMs / 1000 + 60 });
    expect(auth.authenticate(basicProxyAuthorization(other))).toEqual({ ok: false, reason: "owner_mismatch" });
  });

  it("maps only the owner mismatch to 403; everything else challenges with 407", () => {
    expect(authFailureStatus("owner_mismatch")).toBe(403);
    for (const reason of ["missing", "malformed", "bad_signature", "expired", "device_revoked", "credential_revoked"] as const) {
      expect(authFailureStatus(reason)).toBe(407);
    }
  });
});
