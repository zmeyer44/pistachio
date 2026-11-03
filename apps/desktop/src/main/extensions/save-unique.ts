/**
 * A file saved into a folder under a name of the extension's choosing, never over another: the name, then
 * "name 2", "name 3"… — each tried by creating it exclusively, so two saves of one name at once (two exports
 * finishing together) take two files, and nothing a check found free is taken meanwhile.
 */

import { constants } from "node:fs";
import { copyFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

/** How many names are tried before giving up (a folder with that many of one name is not a folder to save into). */
const NAME_TRIES = 10_000;

function isExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EEXIST";
}

/** The candidates for `name` in `dir`: itself, then numbered before its extension. */
function* candidates(dir: string, name: string): Generator<string> {
  const extension = extname(name);
  const stem = name.slice(0, name.length - extension.length) || "file";
  yield join(dir, name);
  for (let n = 2; n <= NAME_TRIES; n += 1) yield join(dir, `${stem} ${String(n)}${extension}`);
}

/**
 * `write(target)` creates `target` exclusively (it must fail with EEXIST on a file that exists); the first name it
 * takes is answered. Anything but EEXIST is the save's failure.
 */
export async function saveUnique(dir: string, name: string, write: (target: string) => Promise<void>): Promise<string> {
  for (const target of candidates(dir, name)) {
    try {
      await write(target);
      return target;
    } catch (error) {
      if (!isExists(error)) throw error;
    }
  }
  throw new Error(`no free name for "${name}" in ${dir}`);
}

/** `bytes` saved as a new file. */
export function saveBytesUnique(dir: string, name: string, bytes: Uint8Array): Promise<string> {
  return saveUnique(dir, name, (target) => writeFile(target, bytes, { flag: "wx" }));
}

/** The file at `source` copied to a new file (the copy itself exclusive: COPYFILE_EXCL). */
export function copyUnique(dir: string, name: string, source: string): Promise<string> {
  return saveUnique(dir, name, (target) => copyFile(source, target, constants.COPYFILE_EXCL));
}
