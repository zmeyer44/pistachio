import {
  CHAT_IMAGE_TYPES,
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_SELECTION_CHARS,
  type ChatInsert,
} from "@pistachio/shell-contracts/chat-insert";

/**
 * Turning what a page's right-click menu points at into a ChatInsert the
 * composer can stage. The pure parts live here; the browser controller does
 * the fetching and the frame scripting around them.
 */

export type ChatInsertResult =
  | { ok: true; insert: ChatInsert }
  | { ok: false; reason: string };

export interface DecodedDataUrl {
  mediaType: string;
  bytes: Uint8Array;
}

/** The bytes inside a data: URL, or null for anything else. */
export function parseDataUrl(url: string): DecodedDataUrl | null {
  const match = /^data:([^,]*?)(;base64)?,([\s\S]*)$/u.exec(url);
  if (match === null) return null;
  const [, header = "", base64, payload = ""] = match;
  const mediaType = normalizeMediaType(header.split(";", 1)[0] ?? "");
  try {
    const bytes =
      base64 === undefined
        ? Buffer.from(decodeURIComponent(payload), "utf8")
        : Buffer.from(payload, "base64");
    return {
      mediaType: mediaType === "" ? "text/plain" : mediaType,
      bytes: new Uint8Array(bytes),
    };
  } catch {
    return null;
  }
}

/** `image/JPG; charset=…` → `image/jpeg`: the bare, canonical type. */
export function normalizeMediaType(value: string): string {
  const bare = (value.split(";", 1)[0] ?? "").trim().toLowerCase();
  return bare === "image/jpg" ? "image/jpeg" : bare;
}

const EXTENSION_FOR: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * The name the chip and the model see: the address's file name, given the
 * extension of the bytes actually attached (a re-rendered SVG is a PNG).
 */
export function imageFileName(srcURL: string, mediaType: string): string {
  const extension = EXTENSION_FOR[mediaType] ?? "png";
  let base = "";
  try {
    const url = new URL(srcURL);
    // A data: URL's "path" is its payload; there is no name to keep.
    if (url.protocol !== "data:")
      base = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  } catch {
    base = "";
  }
  base = base
    .replace(/[\\/:*?"<>|\p{Cc}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 100);
  const stem = base.replace(/\.[a-z0-9]{1,5}$/iu, "").trim();
  return `${stem === "" ? "image" : stem}.${extension}`;
}

/** Package fetched or decoded image bytes, or say plainly why they will not do. */
export function imageInsertFromBytes(
  bytes: Uint8Array,
  rawMediaType: string,
  srcURL: string,
): ChatInsertResult {
  const mediaType = normalizeMediaType(rawMediaType);
  if (!CHAT_IMAGE_TYPES.has(mediaType))
    return { ok: false, reason: "Only PNG, JPEG, GIF, and WebP images can be added" };
  if (bytes.byteLength === 0) return { ok: false, reason: "That image is empty" };
  if (bytes.byteLength > MAX_CHAT_ATTACHMENT_BYTES)
    return { ok: false, reason: "That image is over 4 MB" };
  return {
    ok: true,
    insert: {
      kind: "image",
      name: imageFileName(srcURL, mediaType),
      mediaType,
      url: `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`,
    },
  };
}

/** Selected words, trimmed to what the composer accepts. */
export function selectionInsert(
  text: string,
  page: { title: string; url: string },
): ChatInsert | null {
  const trimmed = text.replace(/\r\n?/gu, "\n").trim();
  if (trimmed === "") return null;
  const clamped =
    trimmed.length > MAX_CHAT_SELECTION_CHARS
      ? `${trimmed.slice(0, MAX_CHAT_SELECTION_CHARS - 1).trimEnd()}…`
      : trimmed;
  return {
    kind: "selection",
    text: clamped,
    title: page.title.slice(0, 256),
    url: page.url.slice(0, 4096),
  };
}

/** Longest side of a re-rendered image; keeps the PNG well under the byte cap. */
const MAX_RENDERED_EDGE = 2048;

/**
 * Page-world script that paints the `<img>` the menu was opened over onto a
 * canvas and returns it as a PNG data: URL — the fallback for formats the
 * model cannot take (SVG, AVIF, BMP…), for blob: sources, and for a fetch
 * the site refused. Returns null when the image is cross-origin without
 * CORS, since the canvas is then tainted and unreadable.
 */
export function canvasImageScript(srcURL: string): string {
  return `(() => {
  const src = ${JSON.stringify(srcURL)};
  const images = [...document.images];
  const image = images.find((candidate) => candidate.currentSrc === src || candidate.src === src);
  if (!image || image.naturalWidth === 0) return null;
  const scale = Math.min(1, ${String(MAX_RENDERED_EDGE)} / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) return null;
  try {
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
})()`;
}
