/**
 * Chrome Web Store installs by id (docs/extensions.md §6.5, §7): Pistachio downloads the CRX itself, reads the
 * **downloaded** manifest for the verdict and the sheet, and loads nothing — the registry loads an extension once
 * the person approved it. The store's own install path (the page's *Add to Chrome*) only hands over the id
 * (compat.ts `beforeInstall`).
 *
 * Folders: `<extensionsPath>/<cwsId>/<version>_0/` — the library's layout (its `downloadExtension`), with
 * `manifest.key` added by the library so the id stays the store's.
 *
 * electron-chrome-web-store is imported lazily, after `app.whenReady()`, never at this module's top: the app
 * registers every privileged scheme in one call before ready (index.ts), and nothing imported later may try.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { session as electronSession, type Session } from "electron";
import { isChromeExtensionId } from "./actions";
import type { ChromeManifest } from "./verdict";

export interface InstalledChrome {
  cwsId: string;
  /** The version folder that loads. */
  path: string;
  manifest: ChromeManifest;
  version: string;
}

function assertId(cwsId: string): void {
  // The id becomes a folder name: never a path.
  if (!isChromeExtensionId(cwsId)) throw new Error(`Not a Chrome Web Store id: ${String(cwsId).slice(0, 64)}`);
}

/** Dotted numeric versions, as Chrome compares them (up to four parts; a missing part is 0). */
export function compareChromeVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 4); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Chrome reads JSON files that start with a byte-order mark; JSON.parse does not. */
function parseJson(text: string): unknown {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

async function readManifest(dir: string): Promise<ChromeManifest> {
  const manifest = parseJson(await fs.readFile(path.join(dir, "manifest.json"), "utf8"));
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error(`${dir}: manifest.json is not an object`);
  return manifest as ChromeManifest;
}

/** The newest installed version of a store extension, or null. Only the library's `<version>_<n>` folders count. */
export async function readInstalledManifest(cwsId: string, extensionsPath: string): Promise<InstalledChrome | null> {
  assertId(cwsId);
  const root = path.join(extensionsPath, cwsId);
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return null;
  }
  let best: InstalledChrome | null = null;
  for (const name of entries) {
    // (A half-done download is a uuid folder: never a version.)
    if (!/^\d+(\.\d+){0,3}_\d+$/.test(name)) continue;
    const dir = path.join(root, name);
    try {
      const manifest = await readManifest(dir);
      const version = typeof manifest.version === "string" ? manifest.version : name.split("_")[0]!;
      if (best === null || compareChromeVersions(version, best.version) > 0) best = { cwsId, path: dir, manifest, version };
    } catch {
      // An unreadable folder is skipped; the registry decides what an absent install means.
    }
  }
  return best;
}

/**
 * Download a store extension by id (unless a version is already on disk) and read its real manifest. Loads nothing.
 * The library checks the CRX's declared id against `cwsId` and its key proof; it does not verify the signature
 * (docs/extensions.md §6.5: integrity rests on TLS to Google).
 */
export async function installById(cwsId: string, extensionsPath: string): Promise<InstalledChrome> {
  assertId(cwsId);
  const existing = await readInstalledManifest(cwsId, extensionsPath);
  if (existing !== null) return existing;
  const { downloadExtension } = await import("electron-chrome-web-store");
  const dir = await downloadExtension(cwsId, extensionsPath);
  const manifest = await readManifest(dir);
  return { cwsId, path: dir, manifest, version: typeof manifest.version === "string" ? manifest.version : "" };
}

/** Remove every downloaded version. The caller unloads the extension from each Profile session first. */
export async function uninstallById(cwsId: string, extensionsPath: string): Promise<void> {
  assertId(cwsId);
  await fs.rm(path.join(extensionsPath, cwsId), { recursive: true, force: true });
}

/**
 * The extension's name in words: `__MSG_extName__` resolved from its `_locales` (the default locale, then English),
 * else the manifest's name as written.
 */
export async function chromeDisplayName(dir: string, manifest: ChromeManifest): Promise<string> {
  const raw = typeof manifest.name === "string" ? manifest.name : "";
  const match = /^__MSG_(\w+)__$/.exec(raw);
  if (match === null) return raw;
  const key = match[1]!.toLowerCase();
  const locales = [...new Set([manifest.default_locale, "en", "en_US"].filter((l): l is string => typeof l === "string" && /^[\w-]+$/.test(l)))];
  for (const locale of locales) {
    try {
      const messages = parseJson(await fs.readFile(path.join(dir, "_locales", locale, "messages.json"), "utf8"));
      if (messages === null || typeof messages !== "object") continue;
      for (const [name, value] of Object.entries(messages as Record<string, unknown>)) {
        const message = (value as { message?: unknown } | null)?.message;
        if (name.toLowerCase() === key && typeof message === "string" && message.trim() !== "") return message.trim();
      }
    } catch {
      // the next locale
    }
  }
  return typeof manifest.short_name === "string" && !manifest.short_name.startsWith("__MSG_") ? manifest.short_name : raw;
}

export interface ChromeUpdate {
  cwsId: string;
  from: string;
  to: string;
  /** The new version's folder. The old one is gone (the library deletes it). */
  path: string;
  previousManifest: ChromeManifest;
  manifest: ChromeManifest;
}

/**
 * The scratch session updates run in: a partition of its own — persistent in name, since Electron loads an extension
 * in no temporary session ("Extensions cannot be loaded in a temporary session", MEASURED on 43.4.1) — with no
 * Profile's cookies, no tabs, nothing shown.
 */
const UPDATE_PARTITION = "persist:pistachio-chrome-updates";

/**
 * Check the store for newer versions of the given installed extensions and download them, through the library's
 * `updateExtensions`. Run it **at launch, before any Profile session loads a Chrome extension** — and never while
 * one does:
 *
 * - The library's update path is silent: it downloads the new version, removes the old from the session it checks,
 *   loads the new one there, and **deletes the old version's folder** — under any other session that still has it
 *   loaded. So the check runs in a scratch, in-memory session of its own (where each extension's service worker may
 *   start briefly, with no Profile's cookies and no tabs), and every Profile session loads afterwards.
 * - It compares nothing. The caller must compare `previousManifest` with `manifest` (verdict.ts's host patterns and
 *   API permissions against the grants) and leave one that widened `pending` — paused, not loaded — until the
 *   person approves the new sheet. The old version can't be kept: its folder is gone.
 * - It tells Google which ids are installed (the store's update protocol); production must set `NODE_ENV`.
 */
export async function checkUpdates(options: { extensionsPath: string; cwsIds: readonly string[]; session?: Session }): Promise<ChromeUpdate[]> {
  const scratch = options.session ?? electronSession.fromPartition(UPDATE_PARTITION);
  const before = new Map<string, InstalledChrome>();
  let refused: unknown = null;
  for (const cwsId of options.cwsIds) {
    if (!isChromeExtensionId(cwsId)) continue;
    const installed = await readInstalledManifest(cwsId, options.extensionsPath);
    if (installed === null) continue;
    try {
      if (scratch.extensions.getExtension(cwsId) === null) await scratch.extensions.loadExtension(installed.path, { allowFileAccess: false });
      before.set(cwsId, installed);
    } catch (error) {
      // One that won't load can't be checked; the registry reports its error at load.
      refused = error;
    }
  }
  // (None could be loaded, though some are installed: the check never ran, and the caller logs why.)
  if (before.size === 0 && refused !== null) throw new Error(`no installed Chrome extension could be loaded for the update check: ${refused instanceof Error ? refused.message : String(refused)}`);
  if (before.size === 0) return [];
  try {
    const { updateExtensions } = await import("electron-chrome-web-store");
    await updateExtensions(scratch);
  } finally {
    for (const extension of scratch.extensions.getAllExtensions()) scratch.extensions.removeExtension(extension.id);
  }
  const updates: ChromeUpdate[] = [];
  for (const [cwsId, previous] of before) {
    const now = await readInstalledManifest(cwsId, options.extensionsPath);
    if (now === null || compareChromeVersions(now.version, previous.version) <= 0) continue;
    updates.push({ cwsId, from: previous.version, to: now.version, path: now.path, previousManifest: previous.manifest, manifest: now.manifest });
  }
  return updates;
}
