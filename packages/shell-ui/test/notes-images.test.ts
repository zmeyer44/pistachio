/**
 * What a picture has to be before a note keeps it (docs/notes.md §5, N4):
 * the gate, the box it is drawn into, what it is re-encoded as, and the id
 * its bytes earn.
 */

import { describe, expect, it } from "vitest";
import { MAX_NOTE_BLOB_BYTES } from "@pistachio/shell-contracts/notes";
import {
  acceptNoteImage,
  bytesToBase64,
  encodeTarget,
  imageBlobId,
  mayHaveAlpha,
  MAX_NOTE_IMAGE_BYTES,
  NOTE_IMAGE_MAX_EDGE,
  planDownscale,
  withinBlobCap,
} from "../src/lib/notes-images";

function file(overrides: Partial<{ name: string; type: string; size: number }> = {}) {
  return { name: "shot.png", type: "image/png", size: 1_024, ...overrides };
}

describe("acceptNoteImage", () => {
  it("takes the four kinds a note can hold", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
      expect(acceptNoteImage(file({ type }))).toEqual({ ok: true, mediaType: type });
    }
  });

  it("refuses what is not an image, by name", () => {
    expect(acceptNoteImage(file({ name: "notes.pdf", type: "application/pdf" }))).toEqual({
      ok: false,
      reason: "notes.pdf is not an image",
    });
  });

  it("refuses an image kind a note cannot keep", () => {
    expect(acceptNoteImage(file({ name: "art.svg", type: "image/svg+xml" }))).toMatchObject({ ok: false });
  });

  it("refuses before decoding anything over 20 MB", () => {
    expect(acceptNoteImage(file({ size: MAX_NOTE_IMAGE_BYTES + 1 }))).toEqual({ ok: false, reason: "shot.png is over 20 MB" });
    expect(acceptNoteImage(file({ size: MAX_NOTE_IMAGE_BYTES }))).toMatchObject({ ok: true });
  });

  it("refuses an empty file", () => {
    expect(acceptNoteImage(file({ size: 0 }))).toMatchObject({ ok: false });
  });
});

describe("planDownscale", () => {
  it("leaves a picture that already fits alone", () => {
    expect(planDownscale(800, 600)).toEqual({ width: 800, height: 600, scaled: false });
    expect(planDownscale(NOTE_IMAGE_MAX_EDGE, 100)).toMatchObject({ scaled: false });
  });

  it("puts the long side on the cap and keeps the proportions", () => {
    expect(planDownscale(4096, 2048)).toEqual({ width: 2048, height: 1024, scaled: true });
    expect(planDownscale(2048, 4096)).toEqual({ width: 1024, height: 2048, scaled: true });
  });

  it("never rounds a side away", () => {
    expect(planDownscale(10_000, 3)).toEqual({ width: 2048, height: 1, scaled: true });
  });

  it("takes the cap as an argument, for a smaller box", () => {
    expect(planDownscale(1_000, 500, 100)).toEqual({ width: 100, height: 50, scaled: true });
  });
});

describe("encodeTarget", () => {
  it("re-encodes a photograph as JPEG", () => {
    expect(encodeTarget("image/jpeg", false)).toEqual({ mediaType: "image/jpeg", quality: 0.85 });
    expect(encodeTarget("image/png", false)).toEqual({ mediaType: "image/jpeg", quality: 0.85 });
  });

  it("keeps PNG where there is transparency to lose", () => {
    expect(encodeTarget("image/png", true)).toEqual({ mediaType: "image/png", quality: 1 });
    expect(encodeTarget("image/webp", true)).toEqual({ mediaType: "image/png", quality: 1 });
  });

  it("knows which sources could carry alpha at all", () => {
    expect(mayHaveAlpha("image/jpeg")).toBe(false);
    expect(mayHaveAlpha("image/png")).toBe(true);
    expect(mayHaveAlpha("image/gif")).toBe(true);
  });
});

describe("imageBlobId", () => {
  it("is the first 24 hex of the SHA-256 of the bytes", async () => {
    // SHA-256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    const id = await imageBlobId(new TextEncoder().encode("abc"));
    expect(id).toBe("ba7816bf8f01cfea414140de");
    expect(id).toMatch(/^[a-f0-9]{24}$/);
  });

  it("is the same id for the same bytes, and a different one for different bytes", async () => {
    const one = await imageBlobId(new Uint8Array([1, 2, 3]));
    expect(await imageBlobId(new Uint8Array([1, 2, 3]))).toBe(one);
    expect(await imageBlobId(new Uint8Array([1, 2, 4]))).not.toBe(one);
  });
});

describe("the register's cap", () => {
  it("holds at the documented ceiling", () => {
    expect(withinBlobCap(MAX_NOTE_BLOB_BYTES)).toBe(true);
    expect(withinBlobCap(MAX_NOTE_BLOB_BYTES + 1)).toBe(false);
    expect(withinBlobCap(0)).toBe(false);
  });
});

describe("bytesToBase64", () => {
  it("matches the one-shot encoding, past the argument-list limit", () => {
    const bytes = new Uint8Array(100_000);
    for (let at = 0; at < bytes.length; at += 1) bytes[at] = at % 256;
    const expected = Buffer.from(bytes).toString("base64");
    expect(bytesToBase64(bytes)).toBe(expected);
  });
});
