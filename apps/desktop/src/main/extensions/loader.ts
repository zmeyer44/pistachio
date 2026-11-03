/**
 * Reading a Pistachio extension's folder (docs/extensions.md §3, §7): its
 * `pistachio.json` through the manifest's schema, every file it names checked
 * to be there (inside the folder, by real path), its icon's address, and its
 * approval sheet — or, when any of that fails, what failed in words that say
 * how to fix it. Nothing here runs the extension's code.
 *
 * The bundled set lives in `apps/desktop/extensions/<id>/` in development and
 * `Resources/extensions/<id>/` in the app (electron-builder's extraResources).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { EXTENSION_SCHEME } from "@pistachio/shell-contracts/extensions";
import { EXTENSION_ID_PATTERN, manifestFiles, parseManifest, type ManifestIssue, type PistachioManifest } from "@pistachio/extension-api/manifest";
import { sheetFor, type Sheet } from "@pistachio/extension-api/sheet";
import { realInside, resolveInside } from "./paths";

export const MANIFEST_FILE = "pistachio.json";
/** The API majors this build loads (N and N−1, §7). */
export const SUPPORTED_API = [1] as const;

export interface LoadedExtension {
  ok: true;
  /** The folder, as given. */
  root: string;
  manifest: PistachioManifest;
  sheet: Sheet;
  iconUrl: string | null;
}

export interface LoadFailure {
  ok: false;
  root: string;
  /** The id the manifest declares, when it could be read that far. */
  id: string | null;
  /** One sentence for the Ledge's red dot and the status file. */
  error: string;
  issues: ManifestIssue[];
}

export type LoadResult = LoadedExtension | LoadFailure;

/** `pistachio-ext://<id>/<icon>`, or null for a monogram. */
export function extensionIconUrl(manifest: Pick<PistachioManifest, "id" | "icon">): string | null {
  if (manifest.icon === undefined) return null;
  return `${EXTENSION_SCHEME}://${manifest.id}/${manifest.icon.split("/").map(encodeURIComponent).join("/")}`;
}

/** The id a manifest declares, when it is one (a failed load is kept under it): anything else — ".." among them — is no id at all. */
function declaredId(text: string): string | null {
  try {
    const value: unknown = JSON.parse(text);
    const id = typeof value === "object" && value !== null ? (value as Record<string, unknown>)["id"] : undefined;
    return typeof id === "string" && id.length <= 80 && EXTENSION_ID_PATTERN.test(id) ? id : null;
  } catch {
    return null;
  }
}

function failure(root: string, id: string | null, issues: ManifestIssue[]): LoadFailure {
  const first = issues[0];
  const where = first === undefined || first.path === "" ? "" : ` (at ${first.path})`;
  const more = issues.length > 1 ? `, and ${String(issues.length - 1)} more` : "";
  return { ok: false, root, id, issues, error: first === undefined ? "pistachio.json could not be loaded." : `pistachio.json: ${first.message}${where}${more}.` };
}

/** Load the extension in `root`. */
export function loadExtensionFolder(root: string): LoadResult {
  const manifestPath = join(root, MANIFEST_FILE);
  let text: string;
  try {
    if (!statSync(manifestPath).isFile()) throw new Error("not a file");
    text = readFileSync(manifestPath, "utf8");
  } catch {
    return failure(root, null, [{ path: "", message: `there is no ${MANIFEST_FILE} in this folder` }]);
  }
  const id = declaredId(text);
  // (The schema refuses another api outright; said plainly, since it is what an old or new extension meets first.)
  if (text.length > 256 * 1024) return failure(root, id, [{ path: "", message: "pistachio.json is larger than 256 KB" }]);
  const parsed = parseManifest(text);
  if (!parsed.ok) {
    const api = (() => {
      try {
        return (JSON.parse(text) as Record<string, unknown>)["api"];
      } catch {
        return undefined;
      }
    })();
    if (typeof api === "number" && !(SUPPORTED_API as readonly number[]).includes(api)) {
      return failure(root, id, [{ path: "api", message: `this Pistachio loads extensions written for api ${SUPPORTED_API.join(" or ")}, and this one says api ${String(api)}` }]);
    }
    return failure(root, id, parsed.issues);
  }
  const manifest = parsed.manifest;
  const missing: ManifestIssue[] = [];
  for (const file of manifestFiles(manifest)) {
    const spelled = resolveInside(root, file);
    const real = spelled === null ? null : realInside(root, spelled);
    let isFile = false;
    try {
      isFile = real !== null && statSync(real).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) missing.push({ path: file, message: `"${file}" is named in pistachio.json but is not a file in this folder` });
  }
  if (missing.length > 0) return failure(root, manifest.id, missing);
  return { ok: true, root, manifest, sheet: sheetFor(manifest), iconUrl: extensionIconUrl(manifest) };
}

/** Where the app's own extensions are: the repo's folder in development, Resources/extensions in the app. */
export function bundledExtensionsDir(options: { isPackaged: boolean; appPath: string; resourcesPath: string }): string {
  // In dev the build step (scripts/build-extensions.mjs) writes out/extensions/<id>/ from apps/desktop/extensions/<id>/.
  return options.isPackaged ? join(options.resourcesPath, "extensions") : join(options.appPath, "out", "extensions");
}

/** Each bundled extension's folder (a folder holding a pistachio.json). An absent root is an empty set. */
export function listExtensionFolders(root: string): string[] {
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && existsSync(join(root, entry.name, MANIFEST_FILE)))
      .map((entry) => join(root, entry.name))
      .sort();
  } catch {
    return [];
  }
}
