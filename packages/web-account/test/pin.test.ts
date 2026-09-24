import { describe, expect, it } from "vitest";
import { WORKSPACE_PSEUDO_SPACE_ID, generateSpaceRootSecret } from "@pistachio/sync-protocol";
import {
  MAX_PIN_ATTEMPTS,
  PIN_LENGTH,
  isCompletePin,
  openRootSecrets,
  sanitizePinInput,
  sealRootSecrets,
  spaceKeysFrom,
} from "../src/pin";

/**
 * The PIN is what stands between a closed tab and this account's keys, so the
 * things worth pinning are the ones a refactor could quietly weaken: that a
 * wrong PIN opens nothing, that a right one opens exactly what went in, and
 * that a blob cannot be moved between Spaces.
 *
 * Real PBKDF2 at `PIN_PBKDF2_ITERATIONS` is about a second per derivation, so
 * these are deliberately few.
 */

const PIN = "314159";
const secrets = (): Map<string, Uint8Array> =>
  new Map([
    [WORKSPACE_PSEUDO_SPACE_ID, generateSpaceRootSecret()],
    ["space_one", generateSpaceRootSecret()],
  ]);

describe("the keypad's own rules", () => {
  it("keeps digits and nothing else, never more than fit", () => {
    expect(sanitizePinInput("12ab34-56789")).toBe("123456");
    expect(sanitizePinInput("  9 8 ")).toBe("98");
    expect(sanitizePinInput("")).toBe("");
  });

  it("is complete only at exactly the right length", () => {
    expect(isCompletePin("123456")).toBe(true);
    expect(isCompletePin("12345")).toBe(false);
    expect(isCompletePin("1234567")).toBe(false);
    expect(isCompletePin("12345a")).toBe(false);
    expect(PIN_LENGTH).toBe(6);
  });

  it("gives a person more than one try, and not many", () => {
    expect(MAX_PIN_ATTEMPTS).toBeGreaterThan(1);
    expect(MAX_PIN_ATTEMPTS).toBeLessThanOrEqual(10);
  });
});

describe("sealing a session under a PIN", () => {
  it("gives back exactly the secrets that went in", async () => {
    const roots = secrets();
    const sealed = await sealRootSecrets(PIN, roots);
    const opened = await openRootSecrets(PIN, sealed);

    expect(opened.kind).toBe("secrets");
    if (opened.kind !== "secrets") return;
    expect([...opened.secrets.keys()].sort()).toEqual([...roots.keys()].sort());
    for (const [spaceId, secret] of roots) {
      expect(opened.secrets.get(spaceId)).toEqual(secret);
    }
  });

  it("writes down nothing a wrong PIN can read", async () => {
    const sealed = await sealRootSecrets(PIN, secrets());
    expect(await openRootSecrets("314158", sealed)).toEqual({ kind: "wrong" });
    // A near-miss is no nearer than any other miss: AES-GCM either
    // authenticates or it does not.
    expect(await openRootSecrets("000000", sealed)).toEqual({ kind: "wrong" });
  });

  it("refuses a PIN that is not six digits rather than sealing under a short one", async () => {
    await expect(sealRootSecrets("12345", secrets())).rejects.toThrow(/6 digits/u);
    await expect(sealRootSecrets("12345a", secrets())).rejects.toThrow(/6 digits/u);
  });

  it("has nothing to seal when the session holds no root secrets", async () => {
    await expect(sealRootSecrets(PIN, new Map())).rejects.toThrow(/password/u);
  });

  it("salts each record separately, so two browsers share no work", async () => {
    const roots = secrets();
    const a = await sealRootSecrets(PIN, roots);
    const b = await sealRootSecrets(PIN, roots);
    expect(a.salt).not.toEqual(b.salt);
    expect(a.wrapped.get("space_one")).not.toEqual(b.wrapped.get("space_one"));
  });

  it("binds every blob to its own Space, so one cannot be opened as another", async () => {
    const sealed = await sealRootSecrets(PIN, secrets());
    const swapped = {
      ...sealed,
      wrapped: new Map([
        [WORKSPACE_PSEUDO_SPACE_ID, sealed.wrapped.get("space_one")!],
        ["space_one", sealed.wrapped.get(WORKSPACE_PSEUDO_SPACE_ID)!],
      ]),
    };
    // Nothing opens, so this is indistinguishable from a wrong PIN — which is
    // the right answer: a record this scrambled is not this account's.
    expect(await openRootSecrets(PIN, swapped)).toEqual({ kind: "wrong" });
  });

  it("calls a half-readable record damaged rather than wrong, so no try is burnt for it", async () => {
    const sealed = await sealRootSecrets(PIN, secrets());
    const corrupt = new Uint8Array(sealed.wrapped.get("space_one")!);
    corrupt[corrupt.length - 1] = (corrupt.at(-1) ?? 0) ^ 0xff;
    const damaged = { ...sealed, wrapped: new Map([...sealed.wrapped, ["space_one", corrupt]]) };
    expect(await openRootSecrets(PIN, damaged)).toEqual({ kind: "damaged" });
  });

  it("turns the secrets back into the keys the app reads records with", async () => {
    const roots = secrets();
    const keys = await spaceKeysFrom(roots);
    expect([...keys.keys()].sort()).toEqual([...roots.keys()].sort());
    const one = keys.get("space_one");
    expect(one?.spaceId).toBe("space_one");
    // Non-extractable, exactly as a password unlock produces: a PIN buys
    // convenience, not a copy of the key material.
    expect(one?.sealKey.extractable).toBe(false);
    expect(one?.idKey.extractable).toBe(false);
  });
});
