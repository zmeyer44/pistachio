/**
 * What macOS converts for the desk's documents (docs/desk-documents.md §3):
 * a Word 97–2004 document (.doc) is shown and edited as a .docx and written
 * back as a .doc, and read as text for the agent (textutil); a picture that
 * neither the shell nor the model can draw (HEIC, TIFF, BMP, AVIF) is shown
 * and read as a PNG (sips).
 *
 * Each conversion works on copies in a private temporary folder, owner
 * only, taken away as soon as it is done, and is given 30 seconds.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const TIMEOUT_MS = 30_000;

export interface DocumentConverter {
  /** A Word 97–2004 document as a .docx. */
  docToDocx(bytes: Buffer): Promise<Buffer>;
  /** A .docx as a Word 97–2004 document. */
  docxToDoc(bytes: Buffer): Promise<Buffer>;
  /** A Word 97–2004 document's text. */
  docText(bytes: Buffer): Promise<string>;
  /** A picture as a PNG. */
  imageToPng(bytes: Buffer, extension: string): Promise<Buffer>;
}

async function inScratch<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pistachio-convert-"));
  try {
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function textutil(bytes: Buffer, from: string, to: "docx" | "doc" | "txt"): Promise<Buffer> {
  return inScratch(async (dir) => {
    const input = join(dir, `in.${from}`);
    const output = join(dir, `out.${to}`);
    await writeFile(input, bytes, { mode: 0o600 });
    await run("/usr/bin/textutil", ["-convert", to, "-output", output, input], { timeout: TIMEOUT_MS });
    return readFile(output);
  });
}

/** macOS's own converters: textutil for Word, sips for pictures. */
export function macDocumentConverter(): DocumentConverter {
  return {
    docToDocx: (bytes) => textutil(bytes, "doc", "docx"),
    docxToDoc: (bytes) => textutil(bytes, "docx", "doc"),
    docText: async (bytes) => (await textutil(bytes, "doc", "txt")).toString("utf8"),
    imageToPng: (bytes, extension) =>
      inScratch(async (dir) => {
        const input = join(dir, `in.${extension.replace(/[^a-z0-9]/gi, "") || "img"}`);
        const output = join(dir, "out.png");
        await writeFile(input, bytes, { mode: 0o600 });
        await run("/usr/bin/sips", ["-s", "format", "png", input, "--out", output], { timeout: TIMEOUT_MS });
        return readFile(output);
      }),
  };
}

/** Where there is nothing to convert with (tests; another platform): each conversion says so. */
export function noDocumentConverter(): DocumentConverter {
  const refuse = (): Promise<never> => Promise.reject(new Error("this Mac cannot convert that file"));
  return { docToDocx: refuse, docxToDoc: refuse, docText: refuse, imageToPng: refuse };
}
