/**
 * A text file's words, and the way it was written: read as UTF-8 (a file
 * that is not is shown, and not edited — writing it back as UTF-8 would
 * change what every other byte means), and written back with the same
 * byte-order mark and the same line endings it came with.
 */

export interface TextFile {
  text: string;
  /** Written with a byte-order mark. */
  bom: boolean;
  /** Its lines ended \r\n. */
  crlf: boolean;
  /** Not UTF-8: shown as Windows Latin-1, not editable. */
  foreign: boolean;
}

export function readTextFile(bytes: Uint8Array): TextFile {
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const body = bom ? bytes.subarray(3) : bytes;
  let text: string;
  let foreign = false;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    text = new TextDecoder("windows-1252").decode(body);
    foreign = true;
  }
  const crlf = /\r\n/.test(text.slice(0, 65_536));
  return { text: text.replace(/\r\n/g, "\n"), bom, crlf, foreign };
}

export function writeTextFile(file: Pick<TextFile, "bom" | "crlf">, text: string): Uint8Array {
  const body = new TextEncoder().encode(file.crlf ? text.replace(/\r?\n/g, "\r\n") : text);
  if (!file.bom) return body;
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf], 0);
  out.set(body, 3);
  return out;
}
