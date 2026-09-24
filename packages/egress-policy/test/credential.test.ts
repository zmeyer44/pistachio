/**
 * The credential username format both control (which mints) and the gateway
 * (which parses) now share — the one place the five authenticated fields are
 * defined.
 */

import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_PREFIX,
  CREDENTIAL_SECRET_BYTES,
  credentialUsername,
  isCredentialSecretHex,
  parseCredentialUsername,
} from "../src/index.js";

const USER = "11111111-1111-4111-8111-111111111111";
const DEVICE = "22222222-2222-4222-8222-222222222222";
const CREDENTIAL = "33333333-3333-4333-8333-333333333333";

describe("credential username", () => {
  it("builds the five dot-separated fields and parses them back", () => {
    const username = credentialUsername(USER, DEVICE, CREDENTIAL, 1_800_000_000);
    expect(username).toBe(`${CREDENTIAL_PREFIX}.${USER}.${DEVICE}.${CREDENTIAL}.1800000000`);
    expect(parseCredentialUsername(username)).toEqual({
      username,
      userId: USER,
      deviceId: DEVICE,
      credentialId: CREDENTIAL,
      exp: 1_800_000_000,
    });
  });

  it("refuses anything that is not exactly the v1 shape", () => {
    const good = credentialUsername(USER, DEVICE, CREDENTIAL, 1_800_000_000);
    for (const bad of [
      "",
      good.replace("pe1", "pe2"),
      good.replace("pe1", "PE1"),
      `${good}.extra`,
      good.split(".").slice(0, 4).join("."),
      // Uppercase hex is a different uuid spelling and the MAC covers bytes.
      good.replace(USER, "11111111-1111-4111-8111-11111111111A"),
      good.replace(USER, "not-a-uuid"),
      good.replace(".1800000000", ".-1"),
      good.replace(".1800000000", ".18e8"),
      // 16 digits: past the decimal cap, and past a safe integer.
      good.replace(".1800000000", `.${"9".repeat(16)}`),
    ]) {
      expect(parseCredentialUsername(bad), bad).toBeNull();
    }
  });

  it("accepts only the 64-lowercase-hex spelling of a gateway secret", () => {
    expect(CREDENTIAL_SECRET_BYTES).toBe(32);
    expect(isCredentialSecretHex("ab".repeat(CREDENTIAL_SECRET_BYTES))).toBe(true);
    expect(isCredentialSecretHex("AB".repeat(CREDENTIAL_SECRET_BYTES))).toBe(false);
    expect(isCredentialSecretHex("ab".repeat(CREDENTIAL_SECRET_BYTES - 1))).toBe(false);
    expect(isCredentialSecretHex(`${"ab".repeat(CREDENTIAL_SECRET_BYTES)}0`)).toBe(false);
    expect(isCredentialSecretHex("")).toBe(false);
  });
});
