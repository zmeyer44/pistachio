/**
 * Chrome extensions in Pistachio (docs/extensions.md X1, X10, X11, §2 "Click one" / "Find and add them" / "Approve one",
 * §4 "Chrome extensions", §6.4, §7): the registry's `kind: "chrome"` rows, run. ExtensionService owns the registry
 * and the snapshot; this owns everything Chrome about them —
 *
 * - **the libraries, lazily**: nothing is imported, no session is touched, until a Chrome extension is on in a
 *   Profile whose session is in use, an install starts, or a tab reaches the Chrome Web Store (`loadCompat`);
 * - **each Profile session**: `attachSession`, then `loadExtension` for each record on there (approved, not paused,
 *   not `incompatible`) — before that Profile's first page loads where it can (main's `prepareSpaceSession` waits
 *   here, briefly), so a content script runs on the first page too; and load/unload as records change;
 * - **the person's tabs**: every one BrowserController reports (`chromeTabs`: never a hidden agent tab, an unlisted
 *   one, Glance, a sign-in pop-up, an extension page of Pistachio's or a tab of files) is `addTab`'d, its activation
 *   `selectTab`'d; a closed tab leaves through the library's own `destroyed` listener;
 * - **installs**: by store id (the extensions page, the store page's *Add to Chrome*) — downloaded, the verdict and the
 *   sheet read from the downloaded manifest, `pendingInstall` until the person approves (or the download removed);
 *   an unpacked folder (*Load a folder…*) waits on the same sheet as a record; updates at launch, before any Profile
 *   loads, pause one that widened;
 * - **the Ledge**: each action's icon, badge and popup from the Profile in front's session; a click opens the popup at
 *   the icon (or fires `action.onClicked`).
 *
 * Electron itself is reached only through the deps and the compat (main/extensions/chrome/compat.ts), so the tests
 * drive this with stand-ins. Content scripts run in the agent's hidden tabs too (the Profile's own session; §12).
 */

import { existsSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { extname, join, resolve, sep } from "node:path";
import type { BaseWindow, ContextMenuParams, MenuItem, Session, WebContents } from "electron";
import type { ExtensionInfo, ExtensionPendingInstall, ExtensionResponse, ExtensionStatus } from "@pistachio/shell-contracts/extensions";
import type { ContentBounds } from "@pistachio/shell-contracts/ipc";
import { NOTICE_MESSAGE_MAX } from "@pistachio/shell-contracts/notice";
import { spacePartition } from "@pistachio/shell-contracts/spaces";
import type { ServiceBrowser } from "../browser-host";
import type { ExtensionGrant, ExtensionPending, ExtensionRecord, ExtensionRegistry } from "../registry";
import { isChromeExtensionId, pickManifestIcon, type ChromeActionState } from "./actions";
import { folderLinksOut } from "./folder";
import type { ChromeCompat, ChromeCompatHooks, ChromeNotice } from "./compat";
import { verdictFor } from "./curated";
import type { ChromeUpdate, InstalledChrome } from "./store";
import { chromeApiPermissions, chromeHostPatterns, chromePatternCovers, chromeSheet, chromeVerdict, type ChromeManifest, type ChromeVerdictOptions } from "./verdict";

/** How long a Profile's page waits for its Chrome extensions to load before it goes ahead without them. */
export const PROFILE_WAIT_MS = 4_000;
/**
 * Where a popup opens against its icon: the Ledge is at the window's foot on the leading side, so above the icon
 * ("top") and from its leading edge, into the window ("right" in electron-chrome-extensions' PopupView terms).
 */
export const POPUP_ALIGNMENT = "top right";
const STORE_ORIGIN = "https://chromewebstore.google.com";
const MAX_ICON_BYTES = 256 * 1024;
const ICON_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
};

/* ------------------------------- pure rules ------------------------------- */

/**
 * The id Chromium gives a folder it loads (crx_file::id_util): the SHA-256 of the manifest's `key` (its DER public
 * key), else of the folder's path as given to `loadExtension`, its first 16 bytes in hex spelled a–p.
 */
export function chromeIdFor(path: string, manifest: Pick<ChromeManifest, "key">): string {
  const key = typeof manifest.key === "string" ? manifest.key.replace(/\s+/g, "") : "";
  const input = key !== "" ? Buffer.from(key, "base64") : Buffer.from(path, "utf8");
  const hex = createHash("sha256").update(input).digest("hex").slice(0, 32);
  return [...hex].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join("");
}

/** A tab Chrome extensions are told of: a web page (or one about to load), never one of Pistachio's own surfaces, an extension's page or a file. */
export function chromeTabUrl(url: string): boolean {
  return /^(?:https?|about):/iu.test(url);
}

/** What the person grants by approving a Chrome extension's sheet: its API permissions and the sites it reaches. */
export function chromeGrantsOf(manifest: ChromeManifest, manifestHash: string, at: number): ExtensionGrant {
  return { capabilities: chromeApiPermissions(manifest), hosts: chromeHostPatterns(manifest), manifestHash, at };
}

/**
 * What `manifest` asks beyond `grants` — API permissions by name, sites by coverage — as the record's `pending`; all
 * of it with no grants (a first approval); null when it asks nothing new (narrowing applies at once, X6).
 */
export function chromeWidened(grants: ExtensionGrant | null, manifest: ChromeManifest): ExtensionPending | null {
  const manifestHash = chromeSheet(manifest).manifestHash;
  const capabilities = chromeApiPermissions(manifest);
  const hosts = chromeHostPatterns(manifest);
  if (grants === null) return { manifestHash, widened: capabilities, hosts };
  const widened = capabilities.filter((permission) => !grants.capabilities.includes(permission));
  const wider = hosts.filter((host) => !grants.hosts.some((granted) => chromePatternCovers(granted, host)));
  return widened.length === 0 && wider.length === 0 ? null : { manifestHash, widened, hosts: wider };
}

/** Whether a Chrome record may run in a Profile: approved, on there, not paused, not `incompatible`. */
export function chromeRunsIn(record: ExtensionRecord, profileId: string): boolean {
  return (
    record.kind === "chrome" &&
    record.enabled &&
    record.grants !== null &&
    record.pending === null &&
    record.verdict?.kind !== "wont" &&
    (record.profiles === "all" || record.profiles.includes(profileId))
  );
}

/** A Chrome record's status on the extensions page and the Ledge (the contract's `ExtensionStatus`). */
export function chromeStatus(record: ExtensionRecord, facts: { failed: boolean; enabledHere: boolean; loadedHere: boolean }): ExtensionStatus {
  if (record.verdict?.kind === "wont") return "incompatible";
  if (facts.failed) return "error";
  if (record.grants === null) return "needs-approval";
  if (record.pending !== null) return "paused";
  if (!record.enabled || !facts.enabledHere) return "off";
  return facts.loadedHere ? "running" : "idle";
}

function parseJson(text: string): unknown {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

/** A folder's `manifest.json`, or a throw that says what is wrong with it. */
export function readChromeManifest(dir: string): ChromeManifest {
  const value = parseJson(readFileSync(join(dir, "manifest.json"), "utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("manifest.json is not an object");
  return value as ChromeManifest;
}

/** Text a manifest gives (`name`, `description`), `__MSG_key__` resolved from its `_locales` (its default, then English). */
export function chromeMessage(dir: string, manifest: ChromeManifest, raw: unknown): string {
  if (typeof raw !== "string") return "";
  const match = /^__MSG_(\w+)__$/.exec(raw.trim());
  if (match === null) return raw.trim();
  const key = match[1]!.toLowerCase();
  const locales = [...new Set([manifest.default_locale, "en", "en_US"].filter((locale): locale is string => typeof locale === "string" && /^[\w-]+$/.test(locale)))];
  for (const locale of locales) {
    try {
      const messages = parseJson(readFileSync(join(dir, "_locales", locale, "messages.json"), "utf8"));
      if (messages === null || typeof messages !== "object") continue;
      for (const [name, value] of Object.entries(messages as Record<string, unknown>)) {
        const message = (value as { message?: unknown } | null)?.message;
        if (name.toLowerCase() === key && typeof message === "string" && message.trim() !== "") return message.trim();
      }
    } catch {
      // the next locale
    }
  }
  return "";
}

/** The manifest's icon as a `data:` address (the shell may show one; `crx://` needs the extension loaded). */
export function chromeIconData(dir: string, manifest: ChromeManifest): string | null {
  const action = manifest.action ?? manifest.browser_action ?? manifest.page_action;
  const relative = pickManifestIcon(manifest.icons, 32) ?? pickManifestIcon(action?.default_icon, 32);
  if (relative === null) return null;
  const type = ICON_TYPES[extname(relative).toLowerCase()];
  if (type === undefined) return null;
  try {
    const root = realpathSync(dir);
    const file = realpathSync(resolve(root, relative.replace(/^\/+/, "")));
    if (!file.startsWith(`${root}${sep}`) || statSync(file).size > MAX_ICON_BYTES) return null;
    return `data:${type};base64,${readFileSync(file).toString("base64")}`;
  } catch {
    return null;
  }
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Resolves once `promise` settles or `ms` pass, whichever is first; never rejects. */
async function waitAtMost(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    promise.catch(() => undefined),
    new Promise<void>((done) => {
      timer = setTimeout(done, ms);
      timer.unref?.();
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}

/* ------------------------------- the host ------------------------------- */

/** The parts of electron-chrome-web-store's glue (./store.ts) the host uses; stand-ins in the tests. */
export interface ChromeStorePort {
  installById(cwsId: string, extensionsPath: string): Promise<InstalledChrome>;
  uninstallById(cwsId: string, extensionsPath: string): Promise<void>;
  readInstalledManifest(cwsId: string, extensionsPath: string): Promise<InstalledChrome | null>;
  checkUpdates(options: { extensionsPath: string; cwsIds: readonly string[] }): Promise<ChromeUpdate[]>;
}

/** The parts of ChromeCompat the host uses; a stand-in in the tests. */
export type ChromeCompatPort = Pick<
  ChromeCompat,
  | "attachSession"
  | "isAttached"
  | "loadExtension"
  | "unload"
  | "addTab"
  | "removeTab"
  | "selectTab"
  | "contextMenuItems"
  | "actions"
  | "activate"
  | "crxResponse"
  | "iconUrl"
  | "notificationsToNotices"
  | "on"
>;

export interface ChromeHostDeps {
  registry: ExtensionRegistry;
  /** `<userData>/Extensions/chrome` (§7). */
  extensionsPath: string;
  /** `process.versions.chrome`, for `minimum_chrome_version`. */
  chromeVersion: string;
  browser(): ServiceBrowser | null;
  /** The window tabs live in (the popup's parent), or null while there is none. */
  window(): BaseWindow | null;
  /** A Profile's session by its partition (main's `session.fromPartition`). */
  sessionOf(partition: string): Session;
  notice(message: string): void;
  /** The snapshot changed (main coalesces it). */
  publish(): void;
  log(message: string): void;
  /** `loadChromeCompat` (the libraries imported after ready). */
  loadCompat(hooks: ChromeCompatHooks): Promise<ChromeCompatPort>;
  store: ChromeStorePort;
  now?: () => number;
}

interface ChromeFolder {
  /** The folder that loads; null when it is not on this Mac. */
  path: string | null;
  manifest: ChromeManifest | null;
  name: string;
  description: string;
  /** The manifest's icon as `data:`, for when the extension is not loaded in the Profile in front. */
  icon: string | null;
  /** What failed, in words: the folder gone, its manifest, a load. */
  error: string | null;
  errorAt: number;
}

interface ProfileSession {
  ses: Session;
  partition: string;
  /** Attached (and its extensions loaded) once this settles true; null until something asks. */
  ready: Promise<boolean> | null;
}

interface TrackedTab {
  tabId: string;
  contents: WebContents;
  /** The address it shows or is about to load ("" until known): what decides whether it is a tab to the library. */
  url: string;
}

interface PendingInstall extends ExtensionPendingInstall {
  path: string;
  version: string;
  manifest: ChromeManifest;
}

export class ChromeHost {
  readonly #deps: ChromeHostDeps;
  readonly #now: () => number;
  #compat: ChromeCompatPort | null = null;
  #compatLoading: Promise<ChromeCompatPort> | null = null;
  /** The records' folders read and the launch's updates applied: nothing loads before. */
  #ready: Promise<void> = Promise.resolve();
  readonly #folders = new Map<string, ChromeFolder>();
  readonly #profiles = new Map<string, ProfileSession>();
  /** Per Profile, the extensions loaded in its session. */
  readonly #loaded = new Map<string, Set<string>>();
  /** Per Profile, each action as the Ledge draws it (on the session's active tab). */
  readonly #actions = new Map<string, Map<string, ChromeActionState>>();
  readonly #actionsQueued = new Set<string>();
  /** The person's tabs, by their contents' id, and by tab id. */
  readonly #tabs = new Map<number, TrackedTab>();
  readonly #tabIds = new Map<string, WebContents>();
  /** The last Ledge icon each action was clicked from (window coordinates), for a `/` command with no icon. */
  readonly #anchors = new Map<string, ContentBounds>();
  #pendingInstall: PendingInstall | null = null;
  /** Loads, unloads and attaches, one at a time. */
  #queue: Promise<unknown> = Promise.resolve();
  /** Installs (the store's, a folder's) one at a time: the newer displaces the older's sheet and download, never the other way. */
  #installs: Promise<unknown> = Promise.resolve();

  constructor(deps: ChromeHostDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  /** Read the Chrome records' folders and run the launch's update check. Imports nothing with no Chrome record. */
  start(): void {
    const records = this.#records();
    if (records.length === 0) return;
    this.#ready = this.#startup(records).catch((error: unknown) => this.#deps.log(`Chrome extensions at launch: ${messageOf(error)}`));
  }

  async #startup(records: ExtensionRecord[]): Promise<void> {
    for (const record of records) {
      const folder = await this.#readFolder(record);
      // The folder as it is now against what was approved: a manifest edited while Pistachio was closed (an unpacked
      // folder's; a download's, replaced by hand) never loads on the old approval — widened, it waits on its sheet.
      if (record.grants !== null && folder.manifest !== null && chromeSheet(folder.manifest).manifestHash !== record.grants.manifestHash) {
        this.#regrant(record, folder, "changed while Pistachio was closed");
      }
    }
    // Updates before any Profile loads (./store.ts checkUpdates: the library deletes an old version's folder).
    const stored = records.filter((record) => record.source.type === "webstore" && record.grants !== null && record.verdict?.kind !== "wont");
    if (stored.length > 0) await this.#applyUpdates(stored);
    this.#deps.publish();
  }

  async #applyUpdates(records: ExtensionRecord[]): Promise<void> {
    let updates: ChromeUpdate[];
    try {
      updates = await this.#deps.store.checkUpdates({ extensionsPath: this.#deps.extensionsPath, cwsIds: records.map((record) => record.id) });
    } catch (error) {
      this.#deps.log(`the Chrome Web Store's update check failed: ${messageOf(error)}`);
      return;
    }
    for (const update of updates) {
      const record = this.#deps.registry.get(update.cwsId);
      if (record === null || record.kind !== "chrome") continue;
      const folder = this.#folderOf(record.id, update.path, update.manifest, null);
      const verdict = verdictFor(update.cwsId, update.manifest, this.#verdictOptions(folder));
      const pending = chromeWidened(record.grants, update.manifest);
      const source = { type: "webstore" as const, cwsId: update.cwsId, version: update.to };
      // Widened: paused (not loaded) until the person approves the new sheet; else the grant names the new manifest.
      this.#deps.registry.update(
        record.id,
        pending === null && record.grants !== null
          ? { source, verdict, pending: null, grants: chromeGrantsOf(update.manifest, chromeSheet(update.manifest).manifestHash, record.grants.at) }
          : { source, verdict, pending },
      );
      this.#folders.set(record.id, folder);
      if (pending !== null) this.#deps.log(`${folder.name} ${update.to} asks for more (${[...pending.widened, ...pending.hosts].join(", ")}): paused until approved`);
    }
  }

  /* ---------------------------- Profile sessions ---------------------------- */

  /**
   * A Profile's session is about to show a page (main's `prepareSpaceSession`): with a Chrome extension on there, the
   * libraries attach and its extensions load first — waited for at most PROFILE_WAIT_MS. With none, nothing.
   */
  async profileSession(ses: Session, profileId: string, partition: string): Promise<void> {
    const known = this.#profiles.get(profileId);
    if (known === undefined || known.ses !== ses) this.#profiles.set(profileId, { ses, partition, ready: null });
    if (!this.#wanted(profileId)) return;
    await waitAtMost(this.#attach(profileId), PROFILE_WAIT_MS);
  }

  /** Load and unload in every live Profile session as the records say now (approve, a switch, a reload, removal). */
  async sync(): Promise<void> {
    const front = this.#deps.browser()?.activeProfileId() ?? null;
    if (front !== null) this.#profile(front);
    const attaching: Promise<boolean>[] = [];
    for (const [profileId, profile] of this.#profiles) if (profile.ready === null && this.#wanted(profileId)) attaching.push(this.#attach(profileId));
    await this.#serial(async () => {
      const compat = this.#compat;
      if (compat === null) return;
      for (const [profileId, profile] of this.#profiles) if (profile.ready !== null && compat.isAttached(profile.ses)) await this.#syncProfile(profileId, compat);
    });
    await Promise.all(attaching);
    this.#deps.publish();
  }

  #profile(profileId: string): ProfileSession {
    let profile = this.#profiles.get(profileId);
    if (profile === undefined) {
      const partition = spacePartition(profileId);
      profile = { ses: this.#deps.sessionOf(partition), partition, ready: null };
      this.#profiles.set(profileId, profile);
    }
    return profile;
  }

  #profileOf(ses: Session): string | null {
    for (const [profileId, profile] of this.#profiles) if (profile.ses === ses) return profileId;
    return null;
  }

  #records(): ExtensionRecord[] {
    return this.#deps.registry.list().filter((record) => record.kind === "chrome");
  }

  #wanted(profileId: string): boolean {
    return this.#records().some((record) => chromeRunsIn(record, profileId));
  }

  #loadedIn(profileId: string): Set<string> {
    let loaded = this.#loaded.get(profileId);
    if (loaded === undefined) {
      loaded = new Set();
      this.#loaded.set(profileId, loaded);
    }
    return loaded;
  }

  #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** The libraries in the Profile's session, its open tabs told, its extensions loaded. Once per session; true when done. */
  #attach(profileId: string): Promise<boolean> {
    const profile = this.#profile(profileId);
    if (profile.ready !== null) return profile.ready;
    const ready = this.#serial(async () => {
      await this.#ready;
      const compat = await this.#compatLoaded();
      await compat.attachSession(profile.ses, profileId, profile.partition);
      const window = this.#deps.window();
      // (The web pages alone, as for a tab told of while attached: #followed.)
      for (const tab of this.#tabs.values()) {
        if (!tab.contents.isDestroyed() && tab.contents.session === profile.ses && chromeTabUrl(tab.url)) compat.addTab(profile.ses, tab.contents, window);
      }
      const browser = this.#deps.browser();
      const activeId = browser?.activeTabId() ?? null;
      const active = activeId === null ? undefined : this.#tabIds.get(activeId);
      if (active !== undefined && !active.isDestroyed() && active.session === profile.ses) compat.selectTab(profile.ses, active);
      await this.#syncProfile(profileId, compat);
      return true;
    });
    profile.ready = ready.catch((error: unknown) => {
      this.#deps.log(`Chrome extensions could not start in a Profile: ${messageOf(error)}`);
      if (this.#profiles.get(profileId) === profile) profile.ready = null;
      return false;
    });
    return profile.ready;
  }

  async #syncProfile(profileId: string, compat: ChromeCompatPort): Promise<void> {
    const profile = this.#profiles.get(profileId);
    if (profile === undefined) return;
    const loaded = this.#loadedIn(profileId);
    const records = this.#records();
    const known = new Set(records.map((record) => record.id));
    for (const id of [...loaded]) {
      if (known.has(id)) continue;
      compat.unload(profile.ses, id);
      loaded.delete(id);
    }
    for (const record of records) {
      const folder = this.#folders.get(record.id);
      const path = folder?.manifest === null ? null : (folder?.path ?? null);
      const should = chromeRunsIn(record, profileId) && path !== null;
      if (!should) {
        if (loaded.delete(record.id)) compat.unload(profile.ses, record.id);
        continue;
      }
      if (loaded.has(record.id)) continue;
      // The folder as it stands now, not as it was read — edited since its sheet opened, or while it was off — since the
      // library loads from disk: regranted as the launch's read does (widened, it waits on its sheet), and never loaded
      // on another manifest's approval: every path keeps the grant naming the manifest that loads; this is the floor.
      const fresh = await this.#readFolder(record);
      let current: ExtensionRecord = record;
      if (fresh.manifest !== null && current.grants !== null && chromeSheet(fresh.manifest).manifestHash !== current.grants.manifestHash) {
        this.#regrant(current, fresh, "changed since it was approved");
        current = this.#deps.registry.get(record.id) ?? current;
        if (!chromeRunsIn(current, profileId)) continue;
      }
      if (fresh.manifest === null || fresh.path === null || current.grants === null || chromeSheet(fresh.manifest).manifestHash !== current.grants.manifestHash) {
        this.#fail(record.id, "Its manifest.json is not the one approved: reload it, then look over its sheet.");
        continue;
      }
      try {
        // (Checked at every load, not only when the folder was added: a link can be put there any day.)
        const linked = folderLinksOut(fresh.path);
        if (linked !== null) throw new Error(`it links out of its folder (${linked}), and Pistachio serves a folder's own files only`);
        const extension = await compat.loadExtension(profile.ses, fresh.path);
        if (extension.id !== record.id) {
          compat.unload(profile.ses, extension.id);
          this.#fail(record.id, `Chrome loaded it as ${extension.id}, not ${record.id}: remove it and add it again.`);
          continue;
        }
        loaded.add(record.id);
        if (fresh.error !== null) this.#folders.set(record.id, { ...fresh, error: null, errorAt: 0 });
      } catch (error) {
        this.#fail(record.id, `It could not be loaded: ${messageOf(error)}`);
      }
    }
    this.#refreshActions(profileId);
  }

  #fail(id: string, message: string): void {
    const folder = this.#folders.get(id);
    this.#deps.log(`${folder?.name ?? id}: ${message}`);
    if (folder !== undefined) this.#folders.set(id, { ...folder, error: message, errorAt: this.#now() });
  }

  async #compatLoaded(): Promise<ChromeCompatPort> {
    if (this.#compat !== null) return this.#compat;
    this.#compatLoading ??= this.#deps
      .loadCompat(this.#hooks())
      .then((compat) => {
        compat.notificationsToNotices({ show: (notice) => this.#notice(notice) });
        compat.on("install-requested", ({ cwsId, profileId }) => {
          void this.install(cwsId, profileId)
            .then((answer) => {
              if (answer.type === "verdict" && answer.verdict.kind === "wont") this.#deps.notice(answer.verdict.reason);
            })
            .catch((error: unknown) => this.#deps.notice(messageOf(error)));
        });
        compat.on("actions-changed", (profileId) => this.#refreshActions(profileId));
        this.#compat = compat;
        return compat;
      })
      .catch((error: unknown) => {
        this.#compatLoading = null;
        throw error;
      });
    return this.#compatLoading;
  }

  /** The libraries' side of the host (compat.ts ChromeCompatHooks): BrowserController's tabs, guards and window. */
  #hooks(): ChromeCompatHooks {
    return {
      // `tabs.create`, `windows.create` (a `popup` window too: a tab, never an OS window), `runtime.openOptionsPage`.
      createTab: async (details, profileId) => {
        const browser = this.#deps.browser();
        const window = this.#deps.window();
        if (browser === null || window === null || window.isDestroyed()) throw new Error("The Pistachio window isn't open.");
        const url = details.url ?? "";
        // (The library refused Pistachio's own schemes, file: and data:; an extension's own pages in a tab are later.)
        if (url !== "" && !/^https?:\/\//i.test(url)) throw new Error("Pistachio opens only web addresses in tabs for extensions.");
        const tabId = await browser.createTab(url, { profileId, space: "current", activate: details.active !== false });
        const contents = this.#tabIds.get(tabId);
        if (contents === undefined || contents.isDestroyed()) throw new Error("The tab could not be opened.");
        return [contents, window];
      },
      // An extension never moves the person in v1 (docs/extensions.md §4): `tabs.update({ active })` and `tabs.remove`
      // are the library's bookkeeping alone. A tab it forgot is told again the next time it is shown.
      selectTab: () => undefined,
      removeTab: () => undefined,
      navigateTab: async (tab, url) => {
        const browser = this.#deps.browser();
        const tracked = this.#tabs.get(tab.id);
        if (browser === null || tracked === undefined || tracked.contents !== tab) throw new Error("No such tab.");
        // Only the web: never a terminal, a file, a page of Pistachio's (BrowserController.navigate's own guards follow).
        if (!/^https?:\/\//i.test(url)) throw new Error("An extension can send a tab only to a web address.");
        await browser.navigate(tracked.tabId, url);
      },
      // Already narrowed to what the manifest declared (compat.ts), required or optional; granted within what the
      // person approved alone — an optional permission is refused in v1 (no prompt: the extension hears false, as
      // it would from a person declining), so nothing an update declared optional widens what a sheet showed.
      requestPermissions: async (extension, request) => {
        const grants = this.#deps.registry.get(extension.id)?.grants ?? null;
        if (grants === null) return false;
        return (
          request.permissions.every((permission) => grants.capabilities.includes(permission)) &&
          request.origins.every((origin) => grants.hosts.some((granted) => chromePatternCovers(granted, origin)))
        );
      },
      window: () => this.#deps.window(),
    };
  }

  /* --------------------------------- tabs --------------------------------- */

  /** A person's page view was made (BrowserController's `chromeTabs.added`). */
  tabAdded(tabId: string, contents: WebContents, url: string): void {
    this.#track(tabId, contents, url);
  }

  /** A person's tab was put in use: extensions hear `tabs.onActivated`, the Ledge shows the actions on it. */
  tabSelected(tabId: string, contents: WebContents): void {
    this.#track(tabId, contents, contents.isDestroyed() ? "" : contents.getURL());
    const compat = this.#compat;
    if (compat !== null && !contents.isDestroyed() && compat.isAttached(contents.session)) compat.selectTab(contents.session, contents);
  }

  /** The `contextMenus` items for a page (appended to its menu by BrowserController). */
  menuItems(contents: WebContents, params: ContextMenuParams): MenuItem[] {
    const compat = this.#compat;
    if (compat === null || contents.isDestroyed() || !this.#tabs.has(contents.id) || !compat.isAttached(contents.session) || !chromeTabUrl(contents.getURL())) return [];
    try {
      return compat.contextMenuItems(contents.session, contents, params);
    } catch (error) {
      this.#deps.log(`context menu items: ${messageOf(error)}`);
      return [];
    }
  }

  /** `url`: the address the tab shows or is about to load ("" when nothing is known yet, which changes nothing). */
  #track(tabId: string, contents: WebContents, url: string): void {
    if (contents.isDestroyed()) return;
    const id = contents.id;
    const known = this.#tabs.get(id);
    if (known !== undefined && known.contents === contents) known.tabId = tabId;
    else {
      this.#tabs.set(id, { tabId, contents, url: "" });
      // (The library hears the close itself — its own `destroyed` listener removes the tab.)
      contents.once("destroyed", () => {
        if (this.#tabs.get(id)?.contents === contents) this.#tabs.delete(id);
        for (const [key, value] of this.#tabIds) if (value === contents) this.#tabIds.delete(key);
      });
      // Followed as it sets out (the library then sees the load from its start) and as it arrives.
      contents.on("did-start-navigation", (details) => {
        if (details.isMainFrame && !details.isSameDocument) this.#followed(contents, details.url);
      });
      contents.on("did-navigate", (_event, url) => {
        if (originOf(url) === STORE_ORIGIN) void this.#storeVisited(contents);
        this.#followed(contents, url);
      });
    }
    this.#tabIds.set(tabId, contents);
    if (url !== "") this.#followed(contents, url);
  }

  /**
   * The library told of a tab as it stands: on a web page it is a tab of the person's to it; on one of Pistachio's
   * own surfaces (notes, a terminal, home — `pistachio:`), an extension's page or a file it is no tab at all — and
   * a tab again as it comes back to the web. (`addTab` and `removeTab` are idempotent in the library.)
   */
  #followed(contents: WebContents, url: string): void {
    const tracked = this.#tabs.get(contents.id);
    if (tracked !== undefined && tracked.contents === contents) tracked.url = url;
    const compat = this.#compat;
    if (compat === null || contents.isDestroyed() || !compat.isAttached(contents.session)) return;
    if (chromeTabUrl(url)) compat.addTab(contents.session, contents, this.#deps.window());
    else compat.removeTab(contents.session, contents);
  }

  /**
   * A tab reached the Chrome Web Store in a Profile with no Chrome extension yet: its *Add to Chrome* needs the
   * store's preload, so the libraries attach there and the page loads once more with it.
   */
  async #storeVisited(contents: WebContents): Promise<void> {
    const profileId = this.#profileOf(contents.session);
    if (profileId === null || this.#profiles.get(profileId)?.ready !== null) return;
    if (!(await this.#attach(profileId))) return;
    if (!contents.isDestroyed() && originOf(contents.getURL()) === STORE_ORIGIN) contents.reload();
  }

  /* --------------------------------- the Ledge --------------------------------- */

  /**
   * The shell's `crx://extension-icon/…` (main's handler on the default session, registered at launch: a page keeps
   * the protocol handlers it committed with). Nothing to answer until the libraries are loaded.
   */
  crxResponse(request: Request): Response {
    return this.#compat === null ? new Response(null, { status: 404 }) : this.#compat.crxResponse(request);
  }

  #refreshActions(profileId: string): void {
    if (this.#actionsQueued.has(profileId)) return;
    this.#actionsQueued.add(profileId);
    queueMicrotask(() => {
      this.#actionsQueued.delete(profileId);
      void this.#readActions(profileId);
    });
  }

  async #readActions(profileId: string): Promise<void> {
    const compat = this.#compat;
    const profile = this.#profiles.get(profileId);
    if (compat === null || profile === undefined || !compat.isAttached(profile.ses)) return;
    try {
      const states = await compat.actions(profile.ses);
      this.#actions.set(profileId, new Map(states.map((state) => [state.extensionId, state])));
    } catch (error) {
      this.#deps.log(`reading the actions: ${messageOf(error)}`);
    }
    this.#deps.publish();
  }

  /** What the shell draws about a Chrome record, in the Profile in front. */
  info(record: ExtensionRecord, activeProfileId: string | null): ExtensionInfo {
    const folder = this.#folders.get(record.id);
    const manifest = folder?.manifest ?? null;
    const enabledHere = record.profiles === "all" || (activeProfileId !== null && record.profiles.includes(activeProfileId));
    const loadedHere = activeProfileId !== null && this.#loaded.get(activeProfileId)?.has(record.id) === true;
    const action = loadedHere && activeProfileId !== null ? (this.#actions.get(activeProfileId)?.get(record.id) ?? null) : null;
    const profile = activeProfileId === null ? undefined : this.#profiles.get(activeProfileId);
    const crx = loadedHere && profile !== undefined && this.#compat !== null ? (action?.iconUrl ?? this.#compat.iconUrl(profile.ses, record.id)) : null;
    const actionKey = manifest?.action ?? manifest?.browser_action ?? manifest?.page_action;
    const failed = folder !== undefined && (folder.error !== null || manifest === null);
    const sheet = manifest !== null && (record.grants === null || record.pending !== null) ? chromeSheet(manifest) : null;
    return {
      id: record.id,
      kind: "chrome",
      name: folder?.name ?? record.id,
      version: typeof manifest?.version === "string" ? manifest.version : record.source.type === "webstore" ? record.source.version : "",
      description: folder?.description ?? "",
      iconUrl: crx ?? folder?.icon ?? null,
      source: record.source,
      enabled: record.enabled,
      enabledHere,
      pinned: record.pinned,
      order: record.order,
      agentAllowed: false,
      status: chromeStatus(record, { failed, enabledHere, loadedHere }),
      error: folder?.error === null || folder?.error === undefined ? null : { message: folder.error, at: folder.errorAt },
      badge: action?.badge ?? null,
      statusPill: null,
      hasPanel: action?.hasPopup ?? (typeof actionKey?.default_popup === "string" && actionKey.default_popup !== ""),
      panelWidth: null,
      hasAction: actionKey !== undefined && actionKey !== null,
      pages: [],
      barCommands: [],
      menuItems: [],
      settings: [],
      tools: [],
      grants: record.grants === null ? null : { capabilities: [...record.grants.capabilities], hosts: [...record.grants.hosts] },
      pending: sheet,
      verdict: record.verdict ?? null,
      devPath: record.source.type === "unpacked" ? record.source.path : null,
    };
  }

  /**
   * The Ledge icon (or its `/` command): the action runs on the tab in use — its popup at `anchor` (window
   * coordinates; PopupView adds the window's position), else at the last place it was clicked from, else the
   * Ledge's corner — or `action.onClicked` with no popup.
   */
  async activate(id: string, tabId: string | null, anchor: ContentBounds | null): Promise<void> {
    const record = this.#deps.registry.get(id);
    const browser = this.#deps.browser();
    if (record === null || record.kind !== "chrome") throw new Error("There is no such extension.");
    if (browser === null) throw new Error("The Pistachio window isn't open.");
    const name = this.#folders.get(id)?.name ?? id;
    const profileId = browser.activeProfileId();
    if (record.verdict?.kind === "wont") throw new Error(`${name} won't work in Pistachio. ${record.verdict.reason}`);
    if (!chromeRunsIn(record, profileId)) throw new Error(record.grants === null || record.pending !== null ? `${name} is waiting on your approval.` : `${name} is off in this Profile.`);
    if (!(await this.#attach(profileId))) throw new Error(`${name} couldn't start.`);
    const profile = this.#profile(profileId);
    const compat = this.#compat;
    if (compat === null || this.#loaded.get(profileId)?.has(id) !== true) throw new Error(this.#folders.get(id)?.error ?? `${name} couldn't be loaded.`);
    const contents = tabId === null ? undefined : this.#tabIds.get(tabId);
    // The action runs on the web page in use, one the library has as a tab: with none — one of Pistachio's own pages
    // or an extension's in front, no page at all — it runs nowhere (the library, handed no tab, would fall back to the
    // last web tab it saw and grant that page by a click made on another).
    const tab = contents !== undefined && !contents.isDestroyed() && contents.session === profile.ses && chromeTabUrl(this.#tabs.get(contents.id)?.url ?? contents.getURL()) ? contents : null;
    if (tab === null) throw new Error(`${name} works on a web page: bring one in front and click again.`);
    if (anchor !== null) this.#anchors.set(id, anchor);
    const anchorRect = anchor ?? this.#anchors.get(id) ?? this.#ledgeCorner();
    try {
      compat.activate(profile.ses, { extensionId: id, tab, anchorRect, alignment: POPUP_ALIGNMENT });
    } catch (error) {
      throw new Error(tab === null ? `${name} acts on a page: open one first.` : `${name}: ${messageOf(error)}`);
    }
  }

  /** Where the Ledge is when no icon says (the sidebar hidden, a `/` command): the window's foot, on the leading side. */
  #ledgeCorner(): ContentBounds {
    const window = this.#deps.window();
    const height = window === null || window.isDestroyed() ? 600 : window.getContentBounds().height;
    return { x: 12, y: Math.max(0, height - 44), width: 28, height: 28 };
  }

  #notice(notice: ChromeNotice): void {
    const text = `${notice.extensionName}: ${notice.title}${notice.body === "" ? "" : ` — ${notice.body}`}`;
    this.#deps.notice(clip(text.replace(/\s+/g, " ").trim(), NOTICE_MESSAGE_MAX));
  }

  /* ---------------------------- installs and life ---------------------------- */

  /** The store install waiting on the sheet, as the snapshot carries it. */
  pendingInstall(): ExtensionPendingInstall | null {
    const pending = this.#pendingInstall;
    if (pending === null) return null;
    return { cwsId: pending.cwsId, name: pending.name, description: pending.description, iconUrl: pending.iconUrl, verdict: pending.verdict, sheet: pending.sheet };
  }

  /**
   * Add from the Chrome Web Store by id: download it, read the **downloaded** manifest, and put the sheet up
   * (`pendingInstall`) — or, when it won't work, say why and remove the download. Answers the verdict.
   */
  async install(cwsId: string, _profileId: string | null = null): Promise<ExtensionResponse> {
    if (!isChromeExtensionId(cwsId)) throw new Error("That isn't a Chrome Web Store extension's id.");
    // (One at a time: two overlapping, the older's download finishing last would put its sheet over the newer's and
    // leave the newer's download to no one.)
    return this.#oneInstall(() => this.#install(cwsId));
  }

  #oneInstall<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#installs.then(run, run);
    this.#installs = next.catch(() => undefined);
    return next;
  }

  async #install(cwsId: string): Promise<ExtensionResponse> {
    if (this.#deps.registry.get(cwsId) !== null) throw new Error(`${this.#folders.get(cwsId)?.name ?? "That extension"} is already in Pistachio.`);
    if (this.#pendingInstall?.cwsId === cwsId) return { type: "verdict", verdict: this.#pendingInstall.verdict };
    // One sheet at a time: another waiting is let go.
    await this.#dropPending();
    let installed: InstalledChrome;
    try {
      installed = await this.#deps.store.installById(cwsId, this.#deps.extensionsPath);
    } catch (error) {
      throw new Error(`It couldn't be downloaded from the Chrome Web Store: ${messageOf(error)}`);
    }
    const folder = this.#folderOf(cwsId, installed.path, installed.manifest, null);
    const verdict = verdictFor(cwsId, installed.manifest, this.#verdictOptions(folder));
    if (verdict.kind === "wont") {
      await this.#deps.store.uninstallById(cwsId, this.#deps.extensionsPath).catch(() => undefined);
      return { type: "verdict", verdict };
    }
    this.#pendingInstall = {
      cwsId,
      name: folder.name,
      description: folder.description,
      iconUrl: folder.icon,
      verdict,
      sheet: chromeSheet(installed.manifest),
      path: installed.path,
      version: installed.version,
      manifest: installed.manifest,
    };
    this.#deps.publish();
    return { type: "verdict", verdict };
  }

  /** The sheet's *Turn it on* for a store install: recorded, on in the Profile in front, loaded there. */
  async approveInstall(cwsId: string, manifestHash: string): Promise<void> {
    const pending = this.#pendingInstall;
    if (pending === null || pending.cwsId !== cwsId) throw new Error("That install isn't waiting any more.");
    if (pending.sheet.manifestHash !== manifestHash) throw new Error("The extension changed since this sheet was shown. Look it over again.");
    if (pending.verdict.kind === "wont") throw new Error(pending.verdict.reason);
    if (this.#deps.registry.get(cwsId) !== null) throw new Error(`${pending.name} is already in Pistachio.`);
    const profileId = this.#deps.browser()?.activeProfileId() ?? null;
    const record = this.#deps.registry.fresh(cwsId, "chrome", { type: "webstore", cwsId, version: pending.version }, this.#now());
    record.enabled = true;
    record.pinned = true;
    record.profiles = profileId === null ? "all" : [profileId];
    record.grants = chromeGrantsOf(pending.manifest, manifestHash, this.#now());
    record.verdict = pending.verdict;
    this.#deps.registry.upsert(record);
    this.#folders.set(cwsId, this.#folderOf(cwsId, pending.path, pending.manifest, null));
    this.#pendingInstall = null;
    await this.sync();
  }

  /** The sheet's *Not now* for a store install: the download goes. */
  async denyInstall(cwsId: string): Promise<void> {
    if (this.#pendingInstall?.cwsId !== cwsId) return;
    await this.#dropPending();
    this.#deps.publish();
  }

  async #dropPending(): Promise<void> {
    const pending = this.#pendingInstall;
    if (pending === null) return;
    this.#pendingInstall = null;
    if (this.#deps.registry.get(pending.cwsId) === null) await this.#deps.store.uninstallById(pending.cwsId, this.#deps.extensionsPath).catch(() => undefined);
  }

  /**
   * *Load a folder…* on a folder with a `manifest.json`: an `unpacked` record, waiting on the sheet (Chrome's own
   * warnings and the verdict); the same folder again is a reload.
   */
  async loadUnpacked(path: string): Promise<ExtensionResponse> {
    return this.#oneInstall(() => this.#loadUnpacked(path));
  }

  async #loadUnpacked(path: string): Promise<ExtensionResponse> {
    const folder = resolve(path).replace(/[\\/]+$/, "");
    let manifest: ChromeManifest;
    try {
      manifest = readChromeManifest(folder);
    } catch (error) {
      throw new Error(`That folder's manifest.json can't be read: ${messageOf(error)}`);
    }
    const linked = folderLinksOut(folder);
    if (linked !== null) throw new Error(`That folder links out of itself (${linked}): Pistachio serves a folder's own files only.`);
    const id = chromeIdFor(folder, manifest);
    const held = this.#deps.registry.get(id);
    if (held !== null && !(held.source.type === "unpacked" && held.source.path === folder)) {
      throw new Error(`${this.#folders.get(id)?.name ?? "Another extension"} already has this one's id (${id}): remove it first.`);
    }
    if (held !== null) {
      await this.reload(id);
      return { type: "folder", path: folder };
    }
    const read = this.#folderOf(id, folder, manifest, null);
    const record = this.#deps.registry.fresh(id, "chrome", { type: "unpacked", path: folder }, this.#now());
    record.pending = chromeWidened(null, manifest);
    record.verdict = chromeVerdict(manifest, this.#verdictOptions(read));
    this.#deps.registry.upsert(record);
    this.#folders.set(id, read);
    this.#deps.publish();
    return { type: "folder", path: folder };
  }

  /** The sheet's *Turn it on* for a Chrome record (an unpacked folder, a widened update): granted, on, loaded. */
  async approve(id: string, manifestHash: string): Promise<void> {
    const record = this.#deps.registry.get(id);
    if (record === null || record.kind !== "chrome") throw new Error("There is no such extension.");
    const folder = this.#folders.get(id) ?? (await this.#readFolder(record));
    const manifest = folder.manifest;
    if (manifest === null) throw new Error(folder.error ?? "Its manifest.json can't be read.");
    if (record.verdict?.kind === "wont") throw new Error(`${folder.name} won't work in Pistachio. ${record.verdict.reason}`);
    if (chromeSheet(manifest).manifestHash !== manifestHash) throw new Error("The extension changed since this sheet was shown. Look it over again.");
    const profileId = this.#deps.browser()?.activeProfileId() ?? null;
    const first = record.grants === null;
    this.#deps.registry.update(id, {
      grants: chromeGrantsOf(manifest, manifestHash, this.#now()),
      pending: null,
      enabled: true,
      pinned: true,
      // A Chrome extension reaches a Profile's cookie jar: on where the person approved it, nowhere else (§6.2).
      ...(first && profileId !== null ? { profiles: [profileId] } : {}),
    });
    await this.sync();
  }

  /** Read its folder again: a manifest that widened pauses it; else it loads afresh wherever it runs. */
  async reload(id: string): Promise<void> {
    const record = this.#deps.registry.get(id);
    if (record === null || record.kind !== "chrome") return;
    this.#regrant(record, await this.#readFolder(record), null);
    // Out of every session it is in; `sync` loads the new files back wherever it still runs.
    await this.#serial(async () => this.#unloadEverywhere(id));
    await this.sync();
  }

  /**
   * The folder's manifest against the record: its verdict afresh; with no grant yet, the whole sheet waits; widened
   * beyond the grant, it is paused on the sheet again (`pending`); else the grant names the manifest as it is now
   * (narrowing applies at once, X6). `why`, when given, is said in the log beside what more it asks.
   */
  #regrant(record: ExtensionRecord, folder: ChromeFolder, why: string | null): void {
    const manifest = folder.manifest;
    if (manifest === null) return;
    const verdict = record.source.type === "webstore" ? verdictFor(record.id, manifest, this.#verdictOptions(folder)) : chromeVerdict(manifest, this.#verdictOptions(folder));
    if (record.grants === null) {
      this.#deps.registry.update(record.id, { verdict, pending: chromeWidened(null, manifest) });
      return;
    }
    const pending = chromeWidened(record.grants, manifest);
    this.#deps.registry.update(
      record.id,
      pending === null ? { verdict, pending: null, grants: chromeGrantsOf(manifest, chromeSheet(manifest).manifestHash, record.grants.at) } : { verdict, pending },
    );
    if (pending !== null && why !== null) this.#deps.log(`${folder.name} ${why} and asks for more (${[...pending.widened, ...pending.hosts].join(", ")}): paused until approved`);
  }

  /**
   * Removed: out of every session, its download deleted (a store one; an unpacked folder is the person's), and its
   * own storage in every Profile cleared.
   */
  async uninstall(id: string): Promise<void> {
    const record = this.#deps.registry.get(id);
    if (record === null || record.kind !== "chrome") return;
    await this.#serial(async () => this.#unloadEverywhere(id));
    this.#deps.registry.remove(id);
    this.#folders.delete(id);
    this.#anchors.delete(id);
    for (const actions of this.#actions.values()) actions.delete(id);
    if (record.source.type === "webstore") {
      await this.#deps.store.uninstallById(record.source.cwsId, this.#deps.extensionsPath).catch((error: unknown) => this.#deps.log(`removing ${id}'s download: ${messageOf(error)}`));
    }
    const profileIds = new Set([...this.#profiles.keys(), ...(this.#deps.browser()?.profileIds() ?? [])]);
    for (const profileId of profileIds) {
      const ses = this.#profiles.get(profileId)?.ses ?? this.#deps.sessionOf(spacePartition(profileId));
      await ses.clearStorageData({ origin: `chrome-extension://${id}` }).catch(() => undefined);
      // chrome.storage is the extension system's own (not the origin's): its folders go too.
      for (const area of ["Local Extension Settings", "Sync Extension Settings", "Managed Extension Settings"]) {
        const storagePath = ses.getStoragePath();
        if (storagePath === null) continue;
        try {
          rmSync(join(storagePath, area, id), { recursive: true, force: true });
        } catch {
          // Best effort: Chromium may still hold it open.
        }
      }
    }
    this.#deps.publish();
  }

  #unloadEverywhere(id: string): void {
    for (const [profileId, loaded] of this.#loaded) {
      if (!loaded.delete(id)) continue;
      const profile = this.#profiles.get(profileId);
      if (profile !== undefined) this.#compat?.unload(profile.ses, id);
      this.#refreshActions(profileId);
    }
  }

  /* ------------------------------- folders ------------------------------- */

  async #readFolder(record: ExtensionRecord): Promise<ChromeFolder> {
    let path: string | null = null;
    let manifest: ChromeManifest | null = null;
    let error: string | null = null;
    try {
      if (record.source.type === "unpacked") {
        path = record.source.path;
        if (!existsSync(path)) error = "Its folder is not on this Mac any more.";
        else manifest = readChromeManifest(path);
      } else if (record.source.type === "webstore") {
        const installed = await this.#deps.store.readInstalledManifest(record.source.cwsId, this.#deps.extensionsPath);
        if (installed === null) error = "Its download is not on this Mac any more: remove it and add it again from the Chrome Web Store.";
        else {
          path = installed.path;
          manifest = installed.manifest;
        }
      } else error = "This is not a Chrome extension's folder.";
    } catch (cause) {
      error = `Its manifest.json can't be read: ${messageOf(cause)}`;
      manifest = null;
    }
    const folder = this.#folderOf(record.id, path, manifest, error);
    this.#folders.set(record.id, folder);
    return folder;
  }

  #folderOf(id: string, path: string | null, manifest: ChromeManifest | null, error: string | null): ChromeFolder {
    const readable = path !== null && manifest !== null;
    const name = readable ? chromeMessage(path, manifest, manifest.name) || chromeMessage(path, manifest, manifest.short_name) || id : id;
    return {
      path: readable ? path : null,
      manifest,
      name: name.slice(0, 80),
      description: readable ? chromeMessage(path, manifest, manifest.description).slice(0, 300) : "",
      icon: readable ? chromeIconData(path, manifest) : null,
      error,
      errorAt: error === null ? 0 : this.#now(),
    };
  }

  #verdictOptions(folder: ChromeFolder): ChromeVerdictOptions {
    return { displayName: folder.name, chromeVersion: this.#deps.chromeVersion };
  }
}
