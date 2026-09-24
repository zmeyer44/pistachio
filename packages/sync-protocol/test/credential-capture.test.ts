import { describe, expect, it } from "vitest";
import {
  credentialCaptureSealAad,
  exportPublicKeyRaw,
  generateAgreementKeypair,
  openCredentialCapturePayload,
  sealCredentialCapturePayload,
  utf8,
} from "../src/index.js";

describe("credential capture sealed box", () => {
  it("lets only the intended cloud device open the run- and capture-bound payload", async () => {
    const recipient = await generateAgreementKeypair();
    const other = await generateAgreementKeypair();
    const recipientPublic = await exportPublicKeyRaw(recipient.publicKey);
    const aad = credentialCaptureSealAad("run-1", "capture-1");
    const boxed = await sealCredentialCapturePayload(recipientPublic, utf8("secret fields"), aad);

    expect(boxed).not.toEqual(utf8("secret fields"));
    await expect(openCredentialCapturePayload(
      recipient.privateKey,
      recipientPublic,
      boxed,
      aad,
    )).resolves.toEqual(utf8("secret fields"));
    await expect(openCredentialCapturePayload(
      other.privateKey,
      await exportPublicKeyRaw(other.publicKey),
      boxed,
      aad,
    )).rejects.toThrow();
    await expect(openCredentialCapturePayload(
      recipient.privateKey,
      recipientPublic,
      boxed,
      credentialCaptureSealAad("run-1", "capture-2"),
    )).rejects.toThrow();
  });

  it("seals interoperably from a browser without Web Crypto X25519", async () => {
    const recipient = await generateAgreementKeypair();
    const recipientPublic = await exportPublicKeyRaw(recipient.publicKey);
    const aad = credentialCaptureSealAad("run-1", "capture-1");
    const boxed = await sealCredentialCapturePayload(recipientPublic, utf8("secret fields"), aad, "portable");

    // Sealed with pure-JS X25519, opened by the cloud device's Web Crypto key.
    await expect(openCredentialCapturePayload(
      recipient.privateKey,
      recipientPublic,
      boxed,
      aad,
    )).resolves.toEqual(utf8("secret fields"));
    // A low-order recipient key yields an all-zero secret and must be refused.
    await expect(sealCredentialCapturePayload(new Uint8Array(32), utf8("x"), aad, "portable")).rejects.toThrow();
  });

  it("rejects malformed keys and envelopes before decryption", async () => {
    const recipient = await generateAgreementKeypair();
    const publicKey = await exportPublicKeyRaw(recipient.publicKey);
    const aad = credentialCaptureSealAad("run-1", "capture-1");

    await expect(sealCredentialCapturePayload(new Uint8Array(31), utf8("x"), aad)).rejects.toThrow("32 bytes");
    await expect(openCredentialCapturePayload(
      recipient.privateKey,
      publicKey,
      new Uint8Array([1, 2, 3]),
      aad,
    )).rejects.toThrow("malformed");
  });
});
