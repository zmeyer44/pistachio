import { describe, expect, it } from "vitest";
import {
  decodeCookiePlain,
  deriveKekFromPassphrase,
  deriveKekFromPrf,
  deriveKekFromRecoveryCode,
  deriveSpaceKeys,
  deviceWrapperSigningBytes,
  encodeCookiePlain,
  exportPublicKeyRaw,
  fromBase64,
  generateAgreementKeypair,
  generateDeviceKeypair,
  generateEnrollmentCode,
  generateRecoveryCode,
  generateSpaceRootSecret,
  lengthPrefixed,
  normalizeRecoveryCode,
  open,
  seal,
  serializeWrapper,
  toBase64,
  unwrapRootSecret,
  unwrapRootSecretFromDevice,
  utf8,
  wrapRootSecret,
  wrapRootSecretToDevice,
  type CookiePlain,
  type KeyWrapper,
} from "../src/index.js";

const plain: CookiePlain = {
  identity: {
    spaceId: "space-1",
    hostKey: ".github.com",
    name: "user_session",
    path: "/",
    partitionKey: "",
    sourceScheme: "secure",
  },
  attributes: {
    value: "secret-session-token",
    expiresMs: 1_800_000_000_000,
    persistent: true,
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    priority: "high",
  },
  deleted: false,
};

describe("sealed records", () => {
  it("seals and opens a cookie record, hiding plaintext", async () => {
    const keys = await deriveSpaceKeys("space-1", generateSpaceRootSecret());
    const aad = lengthPrefixed(["aad", "record-id"]);
    const sealed = await seal(keys.sealKey, encodeCookiePlain(plain), aad);
    const sealedStr = String.fromCharCode(...sealed);
    expect(sealedStr).not.toContain("github");
    expect(sealedStr).not.toContain("secret-session-token");
    const opened = decodeCookiePlain(await open(keys.sealKey, sealed, aad));
    expect(opened).toEqual(plain);
  });

  it("rejects tampered AAD (record id swap)", async () => {
    const keys = await deriveSpaceKeys("space-1", generateSpaceRootSecret());
    const sealed = await seal(keys.sealKey, encodeCookiePlain(plain), utf8("record-a"));
    await expect(open(keys.sealKey, sealed, utf8("record-b"))).rejects.toThrow();
  });

  it("cannot open with another space's keys", async () => {
    const keysA = await deriveSpaceKeys("space-1", generateSpaceRootSecret());
    const keysB = await deriveSpaceKeys("space-1", generateSpaceRootSecret());
    const sealed = await seal(keysA.sealKey, encodeCookiePlain(plain), utf8("aad"));
    await expect(open(keysB.sealKey, sealed, utf8("aad"))).rejects.toThrow();
  });
});

describe("key hierarchy (PRD §8.2)", () => {
  it("wraps the root secret under a PRF-derived KEK and recovers it", async () => {
    const root = generateSpaceRootSecret();
    const prfOutput = crypto.getRandomValues(new Uint8Array(32));
    const kek = await deriveKekFromPrf(prfOutput, "credential-1");
    const wrapped = await wrapRootSecret(kek, root, "space-1");
    const kekAgain = await deriveKekFromPrf(prfOutput, "credential-1");
    expect(await unwrapRootSecret(kekAgain, wrapped, "space-1")).toEqual(root);
  });

  it("a wrapper for one credential cannot unwrap another credential's wrap", async () => {
    const root = generateSpaceRootSecret();
    const prfOutput = crypto.getRandomValues(new Uint8Array(32));
    const kek1 = await deriveKekFromPrf(prfOutput, "credential-1");
    const kek2 = await deriveKekFromPrf(prfOutput, "credential-2");
    const wrapped = await wrapRootSecret(kek1, root, "space-1");
    await expect(unwrapRootSecret(kek2, wrapped, "space-1")).rejects.toThrow();
  });

  it("recovery code round-trips through normalization and recovers the secret", async () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iterations = 1_000; // fast test path; production uses 600k
    const root = generateSpaceRootSecret();
    const kek = await deriveKekFromRecoveryCode(code, salt, iterations);
    const wrapped = await wrapRootSecret(kek, root, "space-1");
    const sloppy = code.toLowerCase().replace(/-/g, " ");
    const kekAgain = await deriveKekFromRecoveryCode(sloppy, salt, iterations);
    expect(await unwrapRootSecret(kekAgain, wrapped, "space-1")).toEqual(root);
  });

  it("normalization maps ambiguous characters", () => {
    expect(normalizeRecoveryCode("oOoO-Il1i-".repeat(4).slice(0, 39))).toHaveLength(32);
  });

  it("enrollment code carries a secret to another device and a wrong code cannot open it", async () => {
    // Exactly what AuthService.mintEnrollmentCode / signinWithCode do: seal the
    // account's space secret under a KEK derived from the enrollment code, then
    // recover it on the linked device from the same code (§8.2 key transfer).
    const code = generateEnrollmentCode();
    expect(code).toMatch(/^[0-9A-HJ-NP-TV-Z]{4}-[0-9A-HJ-NP-TV-Z]{4}-[0-9A-HJ-NP-TV-Z]{4}$/);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const secret = generateSpaceRootSecret();

    const mintKek = await deriveKekFromPassphrase(code, salt);
    const wrapped = await wrapRootSecret(mintKek, secret, "enroll:space-1");

    // Linked device, same code → same secret.
    const redeemKek = await deriveKekFromPassphrase(code, salt);
    expect(await unwrapRootSecret(redeemKek, wrapped, "enroll:space-1")).toEqual(secret);

    // Any other code cannot open it.
    const wrongKek = await deriveKekFromPassphrase(generateEnrollmentCode(), salt);
    await expect(unwrapRootSecret(wrongKek, wrapped, "enroll:space-1")).rejects.toThrow();
  });

  it("derived space keys are deterministic from the root secret", async () => {
    const root = generateSpaceRootSecret();
    const k1 = await deriveSpaceKeys("space-1", root);
    const k2 = await deriveSpaceKeys("space-1", root);
    const sealed = await seal(k1.sealKey, utf8("hello"), utf8("aad"));
    expect(await open(k2.sealKey, sealed, utf8("aad"))).toEqual(utf8("hello"));
  });
});

describe("device-x25519 wrappers (D6)", () => {
  const SPACE = "work";

  async function party(deviceId: string) {
    const signing = await generateDeviceKeypair();
    const agreement = await generateAgreementKeypair();
    return {
      deviceId,
      signing,
      agreement,
      agreementPublicKeyRaw: await exportPublicKeyRaw(agreement.publicKey),
    };
  }

  it("agreement keys are X25519, extractable, and JWK-exportable", async () => {
    const pair = await generateAgreementKeypair();
    expect(pair.privateKey.algorithm.name).toBe("X25519");
    expect(pair.privateKey.extractable).toBe(true);
    const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    expect(jwk.kty).toBe("OKP");
    expect(jwk.crv).toBe("X25519");
    expect(typeof jwk.d).toBe("string");
    expect(typeof jwk.x).toBe("string");
    expect((await exportPublicKeyRaw(pair.publicKey)).length).toBe(32);
  });

  it("wraps from a browser without Web Crypto X25519 and the recipient still recovers it", async () => {
    const browser = await party("browser-1");
    const cloud = await party("cloud-1");
    const root = generateSpaceRootSecret();
    const wrapper = await wrapRootSecretToDevice(
      root,
      SPACE,
      { deviceId: cloud.deviceId, agreementPublicKeyRaw: cloud.agreementPublicKeyRaw },
      { deviceId: browser.deviceId, signingKey: browser.signing.privateKey },
      "portable",
    );
    expect(fromBase64(wrapper.salt).length).toBe(32);
    const recovered = await unwrapRootSecretFromDevice(
      wrapper,
      SPACE,
      { deviceId: cloud.deviceId, agreementPrivateKey: cloud.agreement.privateKey },
      browser.signing.publicKey,
    );
    expect(recovered).toEqual(root);
  });

  it("wraps a root secret to the cloud device and the recipient recovers it", async () => {
    const desktop = await party("desktop-1");
    const cloud = await party("cloud-1");
    const root = generateSpaceRootSecret();
    const wrapper = await wrapRootSecretToDevice(
      root,
      SPACE,
      { deviceId: cloud.deviceId, agreementPublicKeyRaw: cloud.agreementPublicKeyRaw },
      { deviceId: desktop.deviceId, signingKey: desktop.signing.privateKey },
    );
    expect(wrapper.kind).toBe("device-x25519");
    expect(wrapper.spaceId).toBe(SPACE);
    expect(wrapper.credentialId).toBe(cloud.deviceId);
    expect(wrapper.senderDeviceId).toBe(desktop.deviceId);
    expect(fromBase64(wrapper.salt).length).toBe(32);
    expect(typeof wrapper.signature).toBe("string");
    // The wrapper hides the secret.
    expect(wrapper.wrapped).not.toBe(toBase64(root));

    const recovered = await unwrapRootSecretFromDevice(
      wrapper,
      SPACE,
      { deviceId: cloud.deviceId, agreementPrivateKey: cloud.agreement.privateKey },
      desktop.signing.publicKey,
    );
    expect(recovered).toEqual(root);

    // Supplying the public key explicitly (non-extractable private key path) agrees.
    const again = await unwrapRootSecretFromDevice(
      wrapper,
      SPACE,
      {
        deviceId: cloud.deviceId,
        agreementPrivateKey: cloud.agreement.privateKey,
        agreementPublicKeyRaw: cloud.agreementPublicKeyRaw,
      },
      desktop.signing.publicKey,
    );
    expect(again).toEqual(root);

    // Survives the wrapper JSON round trip control performs.
    const stored = JSON.parse(JSON.stringify(wrapper)) as KeyWrapper;
    expect(
      await unwrapRootSecretFromDevice(
        stored,
        SPACE,
        { deviceId: cloud.deviceId, agreementPrivateKey: cloud.agreement.privateKey },
        desktop.signing.publicKey,
      ),
    ).toEqual(root);
  });

  it("rejects a tampered salt (ephemeral public key)", async () => {
    const desktop = await party("desktop-1");
    const cloud = await party("cloud-1");
    const wrapper = await wrapRootSecretToDevice(
      generateSpaceRootSecret(),
      SPACE,
      { deviceId: cloud.deviceId, agreementPublicKeyRaw: cloud.agreementPublicKeyRaw },
      { deviceId: desktop.deviceId, signingKey: desktop.signing.privateKey },
    );
    const forgedSalt = toBase64(await exportPublicKeyRaw((await generateAgreementKeypair()).publicKey));
    await expect(
      unwrapRootSecretFromDevice(
        { ...wrapper, salt: forgedSalt },
        SPACE,
        { deviceId: cloud.deviceId, agreementPrivateKey: cloud.agreement.privateKey },
        desktop.signing.publicKey,
      ),
    ).rejects.toThrow(/signature/);
  });

  it("rejects a wrapper for space A when unwrapping for space B", async () => {
    const desktop = await party("desktop-1");
    const cloud = await party("cloud-1");
    const wrapper = await wrapRootSecretToDevice(
      generateSpaceRootSecret(),
      "space-a",
      { deviceId: cloud.deviceId, agreementPublicKeyRaw: cloud.agreementPublicKeyRaw },
      { deviceId: desktop.deviceId, signingKey: desktop.signing.privateKey },
    );
    await expect(
      unwrapRootSecretFromDevice(
        wrapper,
        "space-b",
        { deviceId: cloud.deviceId, agreementPrivateKey: cloud.agreement.privateKey },
        desktop.signing.publicKey,
      ),
    ).rejects.toThrow(/space/);
    // Relabeling the wrapper does not help: the signature and AAD bind the space.
    await expect(
      unwrapRootSecretFromDevice(
        { ...wrapper, spaceId: "space-b" },
        "space-b",
        { deviceId: cloud.deviceId, agreementPrivateKey: cloud.agreement.privateKey },
        desktop.signing.publicKey,
      ),
    ).rejects.toThrow();
  });

  it("rejects a wrapper addressed to device A when device B tries to unwrap it", async () => {
    const desktop = await party("desktop-1");
    const cloudA = await party("cloud-a");
    const cloudB = await party("cloud-b");
    const wrapper = await wrapRootSecretToDevice(
      generateSpaceRootSecret(),
      SPACE,
      { deviceId: cloudA.deviceId, agreementPublicKeyRaw: cloudA.agreementPublicKeyRaw },
      { deviceId: desktop.deviceId, signingKey: desktop.signing.privateKey },
    );
    await expect(
      unwrapRootSecretFromDevice(
        wrapper,
        SPACE,
        { deviceId: cloudB.deviceId, agreementPrivateKey: cloudB.agreement.privateKey },
        desktop.signing.publicKey,
      ),
    ).rejects.toThrow(/device/);
    // Even claiming A's id, B's key cannot derive the wrapping key.
    await expect(
      unwrapRootSecretFromDevice(
        wrapper,
        SPACE,
        { deviceId: cloudA.deviceId, agreementPrivateKey: cloudB.agreement.privateKey },
        desktop.signing.publicKey,
      ),
    ).rejects.toThrow();
  });

  it("rejects a missing signature and a wrong-signer signature", async () => {
    const desktop = await party("desktop-1");
    const impostor = await party("desktop-2");
    const cloud = await party("cloud-1");
    const wrapper = await wrapRootSecretToDevice(
      generateSpaceRootSecret(),
      SPACE,
      { deviceId: cloud.deviceId, agreementPublicKeyRaw: cloud.agreementPublicKeyRaw },
      { deviceId: desktop.deviceId, signingKey: desktop.signing.privateKey },
    );
    const self = { deviceId: cloud.deviceId, agreementPrivateKey: cloud.agreement.privateKey };
    const { signature: _sig, ...unsigned } = wrapper;
    await expect(unwrapRootSecretFromDevice(unsigned, SPACE, self, desktop.signing.publicKey)).rejects.toThrow(
      /unsigned/,
    );
    await expect(
      unwrapRootSecretFromDevice({ ...wrapper, signature: "" }, SPACE, self, desktop.signing.publicKey),
    ).rejects.toThrow(/unsigned/);
    // Verified against a key that is not the sender's → rejected.
    await expect(unwrapRootSecretFromDevice(wrapper, SPACE, self, impostor.signing.publicKey)).rejects.toThrow(
      /signature/,
    );
    // A wrapper the impostor re-signed with their own key is rejected against the claimed sender's key.
    const resigned = {
      ...wrapper,
      senderDeviceId: impostor.deviceId,
      signature: toBase64(
        new Uint8Array(
          await crypto.subtle.sign(
            "Ed25519",
            impostor.signing.privateKey,
            deviceWrapperSigningBytes(SPACE, cloud.deviceId, wrapper.salt, wrapper.wrapped) as BufferSource,
          ),
        ),
      ),
    };
    await expect(unwrapRootSecretFromDevice(resigned, SPACE, self, desktop.signing.publicKey)).rejects.toThrow(
      /signature/,
    );
    // Other wrapper kinds are refused outright.
    await expect(
      unwrapRootSecretFromDevice({ ...wrapper, kind: "password" }, SPACE, self, desktop.signing.publicKey),
    ).rejects.toThrow(/device-x25519/);
  });

  it("serializeWrapper carries the sender fields only when present", () => {
    const base = { spaceId: SPACE, credentialId: "password", createdAtMs: 1, wrapped: new Uint8Array([1, 2, 3]) };
    const password = serializeWrapper({ ...base, kind: "password", salt: new Uint8Array([9]) });
    expect(password).toEqual({ kind: "password", spaceId: SPACE, credentialId: "password", salt: "CQ==", wrapped: "AQID", createdAtMs: 1 });
    expect("senderDeviceId" in password).toBe(false);
    const device = serializeWrapper({ ...base, kind: "device-x25519", credentialId: "cloud-1", senderDeviceId: "desktop-1", signature: "c2ln" });
    expect(device.senderDeviceId).toBe("desktop-1");
    expect(device.signature).toBe("c2ln");
  });
});
