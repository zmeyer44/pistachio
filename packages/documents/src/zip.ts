/**
 * The zip every Office file is (docs/desk-documents.md §3): read whole into
 * memory, entry by entry, and written back with the entries in the order
 * they came — only the parts that changed are new.
 *
 * A document is somebody's file, and a zip can claim to hold far more than
 * it weighs: an entry, or the whole, that would inflate past the limits
 * below is refused before anything is inflated.
 */

import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";

/** No single part of a document may inflate past this, nor all of them together past the next. */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 4_000;

/** A zip's entries by path, in the order they were stored. */
export type ZipEntries = Map<string, Uint8Array>;

export class DocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentError";
  }
}

export function readZip(bytes: Uint8Array): ZipEntries {
  let total = 0;
  let count = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (file) => {
        count += 1;
        total += file.originalSize;
        if (count > MAX_ENTRIES) throw new DocumentError("the file holds too many parts");
        if (file.originalSize > MAX_ENTRY_BYTES || total > MAX_TOTAL_BYTES) throw new DocumentError("the file is too large once unpacked");
        return true;
      },
    });
  } catch (error) {
    if (error instanceof DocumentError) throw error;
    throw new DocumentError("the file is not a readable Office document");
  }
  return new Map(Object.entries(files));
}

export function writeZip(entries: ZipEntries): Uint8Array {
  const zippable: Zippable = {};
  for (const [path, data] of entries) zippable[path] = [data, { level: path.endsWith(".png") || path.endsWith(".jpeg") || path.endsWith(".jpg") ? 0 : 6 }];
  return zipSync(zippable);
}

/** An entry's text (UTF-8, its byte-order mark dropped), or null when there is no such entry. */
export function zipText(entries: ZipEntries, path: string): string | null {
  const data = entries.get(path);
  if (data === undefined) return null;
  const text = strFromU8(data);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function textBytes(text: string): Uint8Array {
  return strToU8(text);
}

/** A part's path from another part's relationship target: `media/image1.png` beside `word/document.xml` is `word/media/image1.png`. */
export function resolvePartPath(fromPart: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const base = fromPart.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "..") base.pop();
    else if (segment !== "." && segment !== "") base.push(segment);
  }
  return base.join("/");
}
