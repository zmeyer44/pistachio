import { describe, expect, it } from "vitest";
import { exportPublicKeyRaw, generateAgreementKeypair, importAgreementPublicKeyRaw } from "../src/index.js";
import { agreeWithPrivateKey, ephemeralAgreement, webCryptoX25519Available } from "../src/x25519.js";

describe("X25519 agreement backends", () => {
  it("agree on the same secret whichever side used pure JS", async () => {
    const recipient = await generateAgreementKeypair();
    const recipientPublic = await exportPublicKeyRaw(recipient.publicKey);
    for (const backend of ["portable", "webcrypto"] as const) {
      const ephemeral = await ephemeralAgreement(recipientPublic, backend);
      expect(ephemeral.publicKeyRaw.length).toBe(32);
      expect(ephemeral.sharedSecret.length).toBe(32);
      const fromRecipient = await agreeWithPrivateKey(
        recipient.privateKey,
        await importAgreementPublicKeyRaw(ephemeral.publicKeyRaw),
      );
      expect(fromRecipient).toEqual(ephemeral.sharedSecret);
    }
  });

  it("probes Web Crypto once and reports this runtime's support", async () => {
    await expect(webCryptoX25519Available()).resolves.toBe(true);
    const ephemeral = await ephemeralAgreement((await exportPublicKeyRaw((await generateAgreementKeypair()).publicKey)));
    expect(ephemeral.sharedSecret.some((byte) => byte !== 0)).toBe(true);
  });
});
