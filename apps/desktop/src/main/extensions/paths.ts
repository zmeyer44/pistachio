/**
 * Paths inside an extension's folder or its data folder (docs/extensions.md
 * §6.2): every file served, read or written is resolved twice — by its
 * spelling (no `..`, nothing absolute, no NUL) and by `realpath` — and refused
 * when either lands outside the root, so a symlink in a folder can never
 * reach a file beside it.
 */

import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { EXTENSION_ID_PATTERN } from "@pistachio/extension-api/manifest";

/** The extension's own userData folder: `storage.json`, `data/`, `ledger.ndjson`. */
/** `<userData>/ExtensionData/<id>` — for an id that is one: ".." or a path would name a folder that is not the extension's (and an uninstall removes it whole). */
export function extensionDataDir(userDataDir: string, id: string): string {
  if (!EXTENSION_ID_PATTERN.test(id)) throw new Error(`not an extension's id: ${id.slice(0, 40)}`);
  return join(userDataDir, "ExtensionData", id);
}

function within(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

/**
 * `relativePath` resolved under `root` by its spelling alone, or null when
 * it climbs out, is absolute, or holds a NUL. `""` is the root itself.
 */
export function resolveInside(root: string, relativePath: string): string | null {
  if (relativePath.includes("\0")) return null;
  const cleaned = relativePath.replace(/\\/g, "/");
  if (cleaned.startsWith("/") && cleaned !== "/") {
    // A URL's path: its leading slash is the root's.
    return resolveInside(root, cleaned.replace(/^\/+/, ""));
  }
  if (isAbsolute(cleaned)) return null;
  if (cleaned.split("/").some((part) => part === "..")) return null;
  const target = resolve(root, cleaned);
  return within(resolve(root), target) ? target : null;
}

/** The real path of `path` when it exists and really lies under `root`'s real path; null otherwise. */
export function realInside(root: string, path: string): string | null {
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(path);
    return within(realRoot, real) ? real : null;
  } catch {
    return null;
  }
}

/**
 * A path to write: its spelling under `root`, and its nearest existing
 * ancestor's real path under `root`'s too (the file itself may not exist
 * yet). Null when either check fails.
 */
export function writableInside(root: string, relativePath: string): string | null {
  const target = resolveInside(root, relativePath);
  if (target === null || target === resolve(root)) return null;
  let probe = target;
  for (;;) {
    const real = realInside(root, probe);
    if (real !== null) {
      // The target itself exists: it must be a file of the root's, which realInside said.
      return probe === target ? real : target;
    }
    const parent = resolve(probe, "..");
    if (parent === probe || !within(resolve(root), parent)) return null;
    try {
      // It exists after all — made meanwhile, another open's folder (realInside saw nothing a moment ago) — or it is a
      // link out: the real path says which.
      const real = realpathSync(probe);
      if (!within(realpathSync(root), real)) return null;
      return probe === target ? real : target;
    } catch {
      // Absent — unless it is a link to nowhere, which a write would follow and make its target: refused as a link out.
      try {
        if (lstatSync(probe).isSymbolicLink()) return null;
      } catch {
        // (Nothing there at all.)
      }
      probe = parent;
    }
  }
}
