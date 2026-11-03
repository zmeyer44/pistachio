/**
 * A Chrome extension's folder is served whole at `chrome-extension://<id>/` by Electron, symlinks followed
 * (`allowFileAccess: false` keeps `file:` out, not a link): one pointing out of the folder would hand any file on
 * the Mac to the extension and its pages. A folder with such a link — or one to nowhere, which could point anywhere
 * later — is refused before it is loaded, and again at every load.
 */

import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** The first link out of `dir` (its path inside the folder), or null when every link stays inside. */
export function folderLinksOut(dir: string): string | null {
  let root: string;
  try {
    root = realpathSync(dir);
  } catch {
    return ".";
  }
  const inside = (real: string): boolean => real === root || real.startsWith(root + sep);
  // (Each real directory walked once: links to `.` or to each other would otherwise be walked without end.)
  const walked = new Set<string>([root]);
  const pending = [dir];
  while (pending.length > 0) {
    const folder = pending.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(folder);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(folder, name);
      let kind: ReturnType<typeof lstatSync>;
      try {
        kind = lstatSync(full);
      } catch {
        continue;
      }
      if (kind.isSymbolicLink()) {
        let real: string;
        try {
          real = realpathSync(full);
        } catch {
          return relative(dir, full);
        }
        if (!inside(real)) return relative(dir, full);
        // (A link inside is followed into, as Electron would follow it — once per real directory.)
        try {
          if (lstatSync(real).isDirectory() && !walked.has(real)) {
            walked.add(real);
            pending.push(full);
          }
        } catch {
          // (Gone meanwhile.)
        }
      } else if (kind.isDirectory()) {
        let real: string;
        try {
          real = realpathSync(full);
        } catch {
          continue;
        }
        if (walked.has(real)) continue;
        walked.add(real);
        pending.push(full);
      }
    }
  }
  return null;
}
