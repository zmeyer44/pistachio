/**
 * A picture on its way into a note (docs/notes.md §5, N3/N4).
 *
 * Everything here is arithmetic and refusals — what a file is allowed to be,
 * how big it may end up, what it should be re-encoded as, and the id its
 * bytes earn. The canvas work that connects them (decode, draw, encode) needs
 * a document, so it stays in the editor; this is the half a test can hold.
 */

import { MAX_NOTE_BLOB_BYTES, NOTE_BLOB_MEDIA_TYPES, type NoteBlobMediaType } from "@pistachio/shell-contracts/notes";

/** Refused before a single pixel is decoded: a 40 MB RAW is not a note's picture. */
export const MAX_NOTE_IMAGE_BYTES = 20 * 1024 * 1024;
/** The long side a stored picture is downscaled to (N4). */
export const NOTE_IMAGE_MAX_EDGE = 2048;
/** What a photograph is re-encoded at; PNG keeps its alpha instead. */
export const NOTE_JPEG_QUALITY = 0.85;

export type ImageAccept =
  | { ok: true; mediaType: NoteBlobMediaType }
  | { ok: false; reason: string };

function isBlobMediaType(value: string): value is NoteBlobMediaType {
  return (NOTE_BLOB_MEDIA_TYPES as readonly string[]).includes(value);
}

/**
 * Whether a dropped or pasted file may become a note's picture. The name is
 * in the refusal because several files arrive at once and only one is wrong.
 */
export function acceptNoteImage(file: Pick<File, "name" | "type" | "size">): ImageAccept {
  const name = file.name === "" ? "That file" : file.name;
  if (!file.type.startsWith("image/")) return { ok: false, reason: `${name} is not an image` };
  if (!isBlobMediaType(file.type)) return { ok: false, reason: `${name} is not a kind of image a note can keep` };
  if (file.size === 0) return { ok: false, reason: `${name} is empty` };
  if (file.size > MAX_NOTE_IMAGE_BYTES) return { ok: false, reason: `${name} is over 20 MB` };
  return { ok: true, mediaType: file.type };
}

export interface Downscale {
  width: number;
  height: number;
  /** False when the picture is already small enough to keep as it is. */
  scaled: boolean;
}

/**
 * The box a picture is drawn into: its long side at `max`, its proportions
 * kept, never smaller than a pixel. A picture already inside the box is left
 * alone — re-encoding a screenshot for nothing only loses it sharpness.
 */
export function planDownscale(width: number, height: number, max = NOTE_IMAGE_MAX_EDGE): Downscale {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const longest = Math.max(w, h);
  if (longest <= max) return { width: w, height: h, scaled: false };
  const ratio = max / longest;
  return { width: Math.max(1, Math.round(w * ratio)), height: Math.max(1, Math.round(h * ratio)), scaled: true };
}

/**
 * What the re-encoded picture should be. A photograph becomes a JPEG, which
 * is most of what is dropped; anything carrying transparency stays a PNG,
 * because a JPEG would fill it with black.
 */
export function encodeTarget(mediaType: NoteBlobMediaType, hasAlpha: boolean): { mediaType: NoteBlobMediaType; quality: number } {
  if (hasAlpha) return { mediaType: "image/png", quality: 1 };
  return { mediaType: "image/jpeg", quality: NOTE_JPEG_QUALITY };
}

/** Whether a source of this type could be carrying transparency at all. */
export function mayHaveAlpha(mediaType: NoteBlobMediaType): boolean {
  return mediaType !== "image/jpeg";
}

/**
 * A picture's id: the first 24 hex characters of the SHA-256 of its bytes
 * (N3). Content-addressed, so the same screenshot dropped into two notes is
 * one record, and a note that is edited never rewrites its pictures.
 */
export async function imageBlobId(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // `crypto.subtle` is the same call in a renderer and in Node ≥ 20.
  const digest = await crypto.subtle.digest("SHA-256", view.slice().buffer as ArrayBuffer);
  let hex = "";
  for (const byte of new Uint8Array(digest).subarray(0, 12)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Whether the re-encoded bytes are small enough for one register (N4). */
export function withinBlobCap(byteLength: number): boolean {
  return byteLength > 0 && byteLength <= MAX_NOTE_BLOB_BYTES;
}

/**
 * Bytes as base64, a chunk at a time. `btoa(String.fromCharCode(...bytes))`
 * on a megabyte overflows the argument list; this is the same conversion
 * without the spread.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let at = 0; at < bytes.length; at += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
  }
  return btoa(binary);
}
