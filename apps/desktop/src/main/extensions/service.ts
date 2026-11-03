/**
 * ExtensionService (docs/extensions.md §4, §7): the façade main constructs.
 * It holds the registry, each extension's loaded manifest and runtime state,
 * its views (pages, the panel, the worker), the dev folder's watcher and
 * status files, and it is the only thing that answers:
 *
 * - `pistachio-ext:call` from an extension context (`call`): the caller is
 *   the view main made, at its own origin (./views.ts), and the call runs
 *   through EXT_METHODS against the extension's scope (./methods.ts);
 * - the shell's `extensions(request)` (`request`) and the snapshot it draws
 *   the Ledge, the extensions page, the sheet and Settings from (`snapshot`,
 *   published coalesced per tick on IPC.extensionsChanged);
 * - the shell's panel slot (`setPanelBounds`);
 * - capture, input and keys (S3): the worker session's display-media and
 *   permission handlers (./capture.ts), the input taps on a tab's page and
 *   the tab preload's reports (./input.ts), the declared key commands
 *   (./keys.ts, `takeKey` from main's key relay), and the status pill main
 *   draws while an extension records.
 *
 * Chrome extensions (`kind: "chrome"` rows) are run by ./chrome/host.ts —
 * their Profile sessions, tabs, installs, popups and Ledge state; the
 * libraries are imported only once one is needed.
 */

import { EXT_GUARD_KEY, EXT_ISOLATED_WORLD } from "@pistachio/extension-api/wire";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { copyUnique, saveBytesUnique } from "./save-unique";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  clipboard,
  dialog,
  MessageChannelMain,
  nativeImage,
  Notification,
  powerSaveBlocker,
  safeStorage,
  session,
  shell,
  type BrowserWindow,
  type ContextMenuParams,
  type MenuItem,
  type Session,
  type WebContents,
  type WebContentsView, type WebFrameMain } from "electron";
import { z } from "zod";
import {
  EXT_EVENT_CHANNEL,
  EXT_HANDLER_TIMEOUTS,
  ExtError,
  type ExtCaptureSource,
  type ExtContext,
  type ExtEvent,
  type ExtEventMessage,
  type ExtInvokeKind,
  type ExtReply,
  type ExtStatus,
  type Json,
} from "@pistachio/extension-api";
import { manifestAsks, widenedAsks, type PistachioManifest } from "@pistachio/extension-api/manifest";
import { sheetFor } from "@pistachio/extension-api/sheet";
import {
  EMPTY_EXTENSIONS_SNAPSHOT,
  EXTENSION_SCHEME,
  type ExtensionError,
  type ExtensionInfo,
  type ExtensionLibraryEntry,
  type ExtensionRequest,
  type ExtensionResponse,
  type ExtensionSettingInfo,
  type ExtensionSource,
  type ExtensionStatus,
  type ExtensionsSnapshot,
} from "@pistachio/shell-contracts/extensions";
import type { ShellCommand } from "@pistachio/shell-contracts/chrome";
import { IPC, type BrowserTabInfo, type ContentBounds } from "@pistachio/shell-contracts/ipc";
import { DEFAULT_SHORTCUTS, shortcutActionForEvent, shortcutFromEvent, type ShortcutSettings } from "@pistachio/shell-contracts/shortcuts";
import { NOTICE_MESSAGE_MAX } from "@pistachio/shell-contracts/notice";
import type { PageContextMenuExtensionItem } from "@pistachio/shell-contracts/page-context-menu";
import type { ExtensionAuthorHost, ExtensionToolCallContext, ExtensionToolSpec } from "@pistachio/agent-runtime";
import type { NoteStore } from "../note-store";
import { agentToolSpecs, callAgentTool, DraftFolders, type AgentExtensionView, type DraftClaim } from "./agent";
import type { ServiceBrowser } from "./browser-host";
import { CAPTURE_END_GRACE_MS, CAPTURE_KILL_GRACE_MS, CaptureBook, picturedSources, STOP_ACTION, statusPillFor, type CaptureEndReason, panelIsChooser, keepStills } from "./capture";
import { readBodyAtMost } from "./net";
import { InputTaps, type InputSubscriber } from "./input";
import { keyBindings, type KeyBinding } from "./keys";
import { loadChromeCompat } from "./chrome/compat";
import { CURATED_CHROME } from "./chrome/curated";
import { ChromeHost } from "./chrome/host";
import { checkUpdates, installById, readInstalledManifest, uninstallById } from "./chrome/store";
import { DataFiles } from "./data-files";
import { Ledger } from "./ledger";
import { bundledExtensionsDir, listExtensionFolders, loadExtensionFolder, type LoadFailure, type LoadedExtension } from "./loader";
import { dispatch, settingValues, type CallContext, type ExtensionNotesHost, type ExtensionRuntime } from "./methods";
import { extensionDataDir } from "./paths";
import { serveExtensionRequest, serveIconRequest, type ExtensionFolders } from "./protocol";
import { ExtensionRegistry, RESERVED_ID_PREFIX, type ExtensionPending, type ExtensionRecord, onInAnyProfile } from "./registry";
import { ExtensionScope, isPrivateAddress } from "./scope";
import { StatusWriter, type LogLine } from "./status";
import { ExtensionStorage } from "./storage";
import { pageNameOf, PanelHost, ViewRegistry, extensionOrigin, type ViewIdentity } from "./views";
import { WorkerHost } from "./web-worker";
import { DevWatcher, isWithin, writeGeneratedFiles } from "./watch";

export const extensionPartition = (id: string): string => `persist:pistachio-ext-${id}`;
/** `net.fetch`'s own partition: no page ever loads in it, and its one filter is the extension's hosts. */
export const extensionNetPartition = (id: string): string => `persist:pistachio-ext-net-${id}`;

/** At most this much of a `net.fetch` response comes back. */
const MAX_FETCH_BYTES = 50 * 1024 * 1024;
/** How many saved or picked files an extension is remembered to own (the newest kept). */
const OWNED_MAX = 200;

/** The files an extension owns, as its `owned.json` keeps them; none when it cannot be read. */
function loadOwned(file: string): Set<string> {
  try {
    const list: unknown = JSON.parse(readFileSync(file, "utf8"));
    return new Set(Array.isArray(list) ? list.filter((path): path is string => typeof path === "string").slice(-OWNED_MAX) : []);
  } catch {
    return new Set();
  }
}

function saveOwned(file: string, owned: Set<string>): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify([...owned].slice(-OWNED_MAX)));
  } catch {
    // (Kept in memory alone for this launch.)
  }
}
const FETCH_TIMEOUT_MS = 60_000;
/** Why a secret is refused on a Mac whose keychain Pistachio cannot use (safeStorage): it would be written in the clear. */
const SECRETS_UNKEPT = "this Mac's keychain is not available to Pistachio, and a secret would otherwise be written to disk in the clear";
/** An extension partition's proxy: nothing answers at port 1, and loopback goes through it too (Chromium would bypass it). */
export const SEALED_PROXY: Electron.ProxyConfig = { mode: "fixed_servers", proxyRules: "socks5://127.0.0.1:1", proxyBypassRules: "<-loopback>" };
const DESK_EVENT_MS = 250;
/** The stills capture.sources lists, at most this many device px wide. */
const SOURCE_STILL_WIDTH = 480;
/** How long capture.sources waits on the stills before answering without them. */
/** How long the worker's page has to say how many tracks it holds (CaptureHost.liveTracks) before it is taken as holding. */
const LIVE_TRACKS_WAIT_MS = 1_000;
const SOURCE_STILL_WAIT_MS = 2_000;
/** The longest side a capture is asked at (docs/recorder.md R1: twice the view, within what the encoders take). */
const MAX_CAPTURE_SIDE = 3840;
/** How long the person's Stop waits on the extension's own handler before main ends its captures itself. */
const STOP_WAIT_MS = 3_000;
/** A toast's actions remembered for its button (the newest; a stale button does nothing). */
const TOAST_ACTIONS_KEPT = 8;
/** A 1×1 picture for a drag out of a page (macOS wants one; the Finder shows the file's own). */
const DRAG_ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export interface ExtensionServiceOptions {
  userDataDir: string;
  homeDir: string;
  isPackaged: boolean;
  appPath: string;
  resourcesPath: string;
  /** `out/preload/extension.cjs`. */
  preload: string;
  /** Developer mode and the dev folder (settings.extensions). */
  settings(): { developerMode: boolean; devFolder: string | null };
  setSettings(patch: { developerMode: boolean; devFolder: string | null }): void;
  onSettingsChange(listener: () => void): () => void;
  notes(): NoteStore | null;
  screenshotFolder(): Promise<string>;
  /** The person's shortcuts (settings.shortcuts): an extension's key never takes one of theirs (./keys.ts). */
  shortcuts?(): ShortcutSettings;
}

interface Subscription {
  id: number;
  senderId: number;
  event: ExtEvent;
  filter: Json | undefined;
}

interface Entry {
  id: string;
  root: string | null;
  loaded: LoadedExtension | null;
  failure: LoadFailure | null;
  /** What broke at run time (a crash loop, a missing folder), for the red dot. */
  error: ExtensionError | null;
  scope: ExtensionScope;
  storage: ExtensionStorage;
  data: DataFiles;
  ledger: Ledger;
  status: StatusWriter;
  runtime: ExtensionRuntime;
  worker: WorkerHost | null;
  /** The worker view's contents id while one runs: what it opened and held is closed with it (`stopped`). */
  workerId: number | null;
  badge: string | null;
  statusPill: ExtStatus | null;
  /** `runtime.keepAlive` holds by id: the reason, and the view that took it (released with the view). */
  holds: Map<number, { reason: string; owner: number }>;
  /** Power-save blockers by hold id, each with the view that took it (a worker's go with it). */
  sleep: Map<number, { blocker: number; owner: number }>;
  /** The files it saved or picked (`runtime.owned`), kept across launches in `ownedFile` (the last OWNED_MAX). */
  owned: Set<string>;
  ownedFile: string;
  subscriptions: Map<number, Subscription>;
  /** Its input subscriptions, by id, with the context that made each (its events go there). */
  inputs: Map<number, number>;
  /** The actions its latest toasts offered (a toast's button answers only those). */
  toastActions: string[];
}

interface Pending {
  extensionId: string;
  resolve(value: Json | undefined): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  /** How many answers are expected (a message to several pages); the first with a value wins. */
  expect: number;
  answered: number;
}

interface WindowParts {
  window: BrowserWindow;
  browser: ServiceBrowser;
  panel: PanelHost;
  notice(message: string): void;
  /** A command to the shell (an extension's toast with its action, agent.ask's Bar). */
  shell(command: ShellCommand): void;
  relayKeys(event: Electron.Event, input: Electron.Input, contents: WebContents): void;
}

type TabFacts = { title: string; url: string; loading: boolean; favIconUrl: string | null; profileId: string };

const requestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("approve"), id: z.string(), manifestHash: z.string(), agentAllowed: z.boolean().optional() }),
  z.object({ type: z.literal("deny"), id: z.string() }),
  z.object({ type: z.literal("setEnabled"), id: z.string(), enabled: z.boolean(), scope: z.enum(["all", "here"]).optional() }),
  z.object({ type: z.literal("pin"), id: z.string(), pinned: z.boolean() }),
  z.object({ type: z.literal("reorder"), id: z.string(), index: z.number().int().min(0) }),
  z.object({ type: z.literal("uninstall"), id: z.string() }),
  z.object({ type: z.literal("reload"), id: z.string() }),
  z.object({ type: z.literal("setAgentAllowed"), id: z.string(), allowed: z.boolean() }),
  z.object({ type: z.literal("setSetting"), id: z.string(), key: z.string(), value: z.unknown() }),
  z.object({ type: z.literal("setDeveloperMode"), on: z.boolean() }),
  z.object({ type: z.literal("loadFolder"), path: z.string().optional() }),
  z.object({ type: z.literal("revealFolder"), id: z.string() }),
  z.object({ type: z.literal("newFolder"), name: z.string().min(1).max(80), template: z.enum(["panel", "bar-command", "agent-tool"]) }),
  z.object({ type: z.literal("installChrome"), cwsId: z.string() }),
  z.object({ type: z.literal("approveInstall"), cwsId: z.string(), manifestHash: z.string() }),
  z.object({ type: z.literal("denyInstall"), cwsId: z.string() }),
  z.object({
    type: z.literal("activate"),
    id: z.string(),
    tabId: z.string().nullable(),
    anchor: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).nullable(),
  }),
  z.object({ type: z.literal("closePanel") }),
  z.object({
    type: z.literal("barCommand"),
    id: z.string(),
    command: z.string(),
    arg: z.string().max(4000),
    spaceId: z.string().nullable(),
    tabId: z.string().nullable(),
    selection: z.string().max(20_000).optional(),
  }),
  z.object({
    type: z.literal("menu"),
    id: z.string(),
    item: z.string(),
    click: z.object({
      tabId: z.string().nullable(),
      pageUrl: z.string().nullable(),
      linkUrl: z.string().optional(),
      selectionText: z.string().optional(),
      srcUrl: z.string().optional(),
      windowTabId: z.string().optional(),
    }),
  }),
  z.object({ type: z.literal("statusAction"), id: z.string(), action: z.string(), source: z.enum(["status", "toast"]).optional() }),
  z.object({ type: z.literal("openPage"), id: z.string(), page: z.string(), query: z.string().optional() }),
  z.object({ type: z.literal("logs"), id: z.string() }),
  z.object({ type: z.literal("draftFolder"), name: z.string().min(1).max(80) }),
]);

/** A folder name from what a person called it: lowercase, dashes. */
export function folderSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug === "" ? "extension" : slug;
}

/** Whether an event value passes a subscription's filter: every key of the filter equal in the value (or its `tab`). */
function passesFilter(filter: Json | undefined, value: unknown): boolean {
  if (filter === undefined || filter === null || typeof filter !== "object" || Array.isArray(filter)) return true;
  const record = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const tab = (typeof record["tab"] === "object" && record["tab"] !== null ? record["tab"] : {}) as Record<string, unknown>;
  return Object.entries(filter).every(([key, expected]) => {
    const actual = key in record ? record[key] : key === "tabId" ? (tab["id"] ?? record["tabId"]) : tab[key];
    return actual === expected;
  });
}

export class ExtensionService {
  readonly #options: ExtensionServiceOptions;
  readonly #registry: ExtensionRegistry;
  readonly #entries = new Map<string, Entry>();
  readonly #bundled = new Map<string, { root: string; result: LoadedExtension | LoadFailure }>();
  readonly #views: ViewRegistry;
  readonly #watcher: DevWatcher;
  /** Folders a dev folder held that could not be registered (no id, an id another holds): their status file alone. */
  readonly #orphans = new Map<string, StatusWriter>();
  /** Folders removed in this session, not taken up again until they change. */
  readonly #removed = new Set<string>();
  readonly #pending = new Map<number, Pending>();
  readonly #configured = new Set<Session>();
  readonly #notifications = new Set<Notification>();
  /** Chrome extensions: the `kind: "chrome"` records, run (./chrome/host.ts). */
  readonly #chrome: ChromeHost;
  #window: WindowParts | null = null;
  #openPanel: string | null = null;
  /** Whether the open panel was the person's doing (its icon, a key, the Bar — or the worker within a gesture): only then is it a chooser. */
  #panelByPerson = false;
  #nextId = 1;
  #publishQueued = false;
  #watchingParent: string | null = null;
  #lastTabs = new Map<string, TabFacts>();
  #tabsPrimed = false;
  #lastActiveTab: string | null = null;
  #lastCurrentSpace: string | null = null;
  /** The Profile in front at the last tick: a switch changes what the snapshot says of each extension (on here, its status). */
  #lastProfile: string | null = null;
  #deskTimer: NodeJS.Timeout | null = null;
  #offSettings: (() => void) | null = null;
  #disposed = false;
  /** Every extension's arm, live captures and holds (./capture.ts). */
  readonly #captures: CaptureBook;
  /** Every input subscription's taps (./input.ts). */
  readonly #taps: InputTaps;
  /** The declared key commands as bound now (./keys.ts); null until asked for again after a change. */
  #keys: KeyBinding[] | null = null;
  /** What each extension recorded last time it was looked at (the pill, `captures`), so a change publishes. */
  #liveKey = "";
  /** The draft folders the Bar made for the agent (docs/extensions.md §8), and what an author turn may do in them. */
  readonly #drafts = new DraftFolders({ beforeWrite: (folder) => this.#agentWrites(folder) });
  /** Draft folders an author turn is writing right now: their Ledge icon shimmers. */
  readonly #drafting = new Set<string>();
  /** A tool call in flight's progress line, by `<extension id>\n<run id>` (`ctx.progress` arrives as `runtime.log`). */
  readonly #toolProgress = new Map<string, (text: string) => void>();
  /** When an author turn last wrote into a folder, and when each extension was last read from its folder (by id). */
  readonly #agentWrittenAt = new Map<string, number>();
  readonly #loadedAt = new Map<string, number>();
  /** Whether the Mac's keychain seals secrets here (safeStorage): without it a secret setting is refused, never written in the clear. */
  #secretsKept = false;

  constructor(options: ExtensionServiceOptions) {
    this.#options = options;
    app.on("web-contents-created", (_event, contents) => this.#sealContents(contents));
    // Secrets are sealed with the Mac's keychain (safeStorage); without it nothing is written in the clear instead —
    // a secret setting is refused (#setSetting), and one sealed on another day reads as unset (registry settingsOf).
    this.#secretsKept = safeStorage.isEncryptionAvailable();
    const codec = this.#secretsKept
      ? { seal: (value: string) => safeStorage.encryptString(value).toString("base64"), open: (sealed: string) => safeStorage.decryptString(Buffer.from(sealed, "base64")) }
      : {
          seal: (): string => {
            throw new Error(SECRETS_UNKEPT);
          },
          open: (): string => {
            throw new Error(SECRETS_UNKEPT);
          },
        };
    this.#registry = new ExtensionRegistry(options.userDataDir, { codec });
    this.#views = new ViewRegistry({
      console: (identity, level, message, file, line) => this.#consoleLine(identity, level, message, file, line),
      gesture: (identity) => this.#entries.get(identity.extensionId)?.scope.noteGesture(),
      dropped: (contentsId, identity) => this.#viewDropped(contentsId, identity),
      renewed: (contentsId, identity) => this.#viewDropped(contentsId, identity),
      framed: (identity) => {
        const entry = this.#entries.get(identity.extensionId);
        if (entry === undefined) return;
        this.#log(entry, {
          at: Date.now(),
          context: identity.context,
          level: "error",
          message: "the page made a frame: what it captures can no longer be watched there, so a capture told to end will stop the page instead (make no frames in the worker)",
        });
      },
    });
    this.#watcher = new DevWatcher({
      found: (folder) => this.#found(folder),
      changed: (folder) => this.#changed(folder),
      gone: (folder) => this.#gone(folder),
    });
    this.#captures = new CaptureBook(
      {
        page: (tabId) => this.#window?.browser.tabContents(tabId) ?? null,
        exists: (tabId) => (this.#window?.browser.tab(tabId) ?? null) !== null,
        capturable: (extensionId, tabId) => this.#capturable(extensionId, tabId),
        hold: (tabIds) => this.#window?.browser.holdTabs(tabIds),
        liveTracks: (extensionId) => this.#liveTracks(extensionId),
        sourceKey: (page) => {
          const frame = (page as WebContents).mainFrame as WebFrameMain | null | undefined;
          return frame === null || frame === undefined ? null : `web-contents-media-stream://${String(frame.processId)}:${String(frame.routingId)}`;
        },
      },
      {
        ended: (extensionId, tabId, reason) => this.#captureEnded(extensionId, tabId, reason),
        changed: () => this.#liveChanged(),
        enforce: (extensionId, tabId, how, key) => this.#captureEnforced(extensionId, tabId, how, key),
      },
    );
    this.#taps = new InputTaps(
      {
        contents: (tabId) => this.#window?.browser.tabContents(tabId) ?? null,
        exists: (tabId) => (this.#window?.browser.tab(tabId) ?? null) !== null,
        view: (tabId) => this.#window?.browser.tabView(tabId) ?? null,
        pointer: () => this.#window?.browser.pointer() ?? null,
        focused: () => {
          const window = this.#window?.window ?? null;
          return window !== null && !window.isDestroyed() && window.isFocused();
        },
        now: () => performance.timeOrigin + performance.now(),
        platform: process.platform === "darwin" ? "darwin" : "other",
      },
      (subscriber) => this.#inputEnded(subscriber),
    );
    const chromePath = join(options.userDataDir, "Extensions", "chrome");
    this.#chrome = new ChromeHost({
      registry: this.#registry,
      extensionsPath: chromePath,
      chromeVersion: process.versions.chrome ?? "",
      browser: () => this.#window?.browser ?? null,
      window: () => this.#window?.window ?? null,
      sessionOf: (partition) => session.fromPartition(partition),
      notice: (message) => this.#window?.notice(message),
      publish: () => this.#publish(),
      log: (message) => console.warn(`[extensions] ${message}`),
      // The libraries are imported here, after ready, and only once a Chrome extension is wanted (compat.ts).
      loadCompat: (hooks) => loadChromeCompat(hooks, { extensionsPath: chromePath }),
      store: { installById, uninstallById, readInstalledManifest, checkUpdates: (check) => checkUpdates(check) },
    });
  }

  /* ------------------------------- startup ------------------------------- */

  /** Read the registry and the bundled set, take up the dev folder, answer icons for the shell. Call after app ready. */
  start(): void {
    const bundledDir = bundledExtensionsDir({ isPackaged: this.#options.isPackaged, appPath: this.#options.appPath, resourcesPath: this.#options.resourcesPath });
    for (const root of listExtensionFolders(bundledDir)) {
      const result = loadExtensionFolder(root);
      const id = result.ok ? result.manifest.id : result.id;
      if (id !== null) this.#bundled.set(id, { root, result });
    }
    for (const record of this.#registry.list()) {
      if (record.kind !== "pistachio") continue;
      const root = this.#rootOf(record);
      this.#mount(record.id, root, root === null ? null : this.#loadFor(record, root));
      // A bundled extension's manifest comes with the app: an update that asks for more waits on the sheet, one that
      // narrowed applies, as a dev folder seen again does (the watcher brings those through #reload itself).
      if (record.source.type === "bundled") this.#reload(record.id, "seen");
    }
    // The Ledge's icons: the shell draws from the default session, which serves icons and nothing else.
    const defaultSession = session.defaultSession;
    if (defaultSession.protocol.isProtocolHandled(EXTENSION_SCHEME)) defaultSession.protocol.unhandle(EXTENSION_SCHEME);
    defaultSession.protocol.handle(EXTENSION_SCHEME, (request) => serveIconRequest(request, (id) => this.#iconFor(id)));
    // And Chrome's action icons (`crx://`), here and now although the libraries come later: the shell's page keeps the
    // handlers it committed with (./chrome/host.ts crxResponse).
    if (defaultSession.protocol.isProtocolHandled("crx")) defaultSession.protocol.unhandle("crx");
    defaultSession.protocol.handle("crx", (request) => this.#chrome.crxResponse(request));
    this.#applyDeveloperMode();
    this.#offSettings = this.#options.onSettingsChange(() => {
      // (The person's shortcuts may have changed: the extensions' keys are bound again.)
      this.#keys = null;
      this.#applyDeveloperMode();
      this.#publish();
    });
    for (const record of this.#registry.list()) {
      if (record.kind !== "pistachio") continue;
      if ((record.source.type === "dev" || record.source.type === "unpacked") && !this.#inDevFolder(record.source.path)) this.#watcher.watchFolder(record.source.path);
    }
    // Chrome's: their folders read and the store's updates checked, before any Profile session loads one.
    this.#chrome.start();
    this.#publish();
  }

  /** The window came up: its browser, its panel, its notices. */
  attachWindow(parts: {
    window: BrowserWindow;
    browser: ServiceBrowser;
    notice(message: string): void;
    shell(command: ShellCommand): void;
    relayKeys(event: Electron.Event, input: Electron.Input, contents: WebContents): void;
    veiled(): boolean;
    placed?: () => void;
  }): void {
    const panel = new PanelHost({
      window: parts.window,
      veiled: parts.veiled,
      ...(parts.placed === undefined ? {} : { placed: parts.placed }),
      made: (view, extensionId) => this.#panelMade(view, extensionId),
    });
    this.#window = { window: parts.window, browser: parts.browser, panel, notice: parts.notice, shell: parts.shell, relayKeys: parts.relayKeys };
    this.#lastTabs = new Map();
    this.#tabsPrimed = false;
    this.#publish();
  }

  detachWindow(): void {
    // What was recorded in the window ends with it.
    for (const entry of this.#entries.values()) this.#stopRecording(entry, "closed");
    this.#window?.panel.destroy();
    this.#window = null;
    this.#openPanel = null;
    if (this.#deskTimer !== null) clearTimeout(this.#deskTimer);
    this.#deskTimer = null;
  }

  dispose(): void {
    this.#disposed = true;
    this.#offSettings?.();
    this.#watcher.dispose();
    this.detachWindow();
    this.#captures.dispose();
    this.#taps.dispose();
    for (const entry of this.#entries.values()) {
      entry.worker?.dispose();
      entry.storage.flush();
      void entry.data.closeAll();
      for (const hold of entry.sleep.values()) powerSaveBlocker.stop(hold.blocker);
      entry.sleep.clear();
    }
    for (const pending of this.#pending.values()) clearTimeout(pending.timer);
    this.#pending.clear();
  }

  /* ----------------------------- hooks for main ----------------------------- */

  /** BrowserController's `extensionPages` hook: an extension page's partition and preload, and its view once made. */
  readonly pageHooks = {
    view: (extensionId: string): { partition: string; preload: string } => {
      this.#prepareSession(extensionId);
      return { partition: extensionPartition(extensionId), preload: this.#options.preload };
    },
    attach: (_tabId: string, contents: WebContents, extensionId: string): void => {
      this.#views.register(contents, extensionId, "page");
    },
  };

  /** BrowserController's `extensionMenu` hook: declared items for a page, and a click. */
  readonly menuHooks = {
    items: (tab: BrowserTabInfo): PageContextMenuExtensionItem[] => {
      if (tab.extensionId !== undefined) return [];
      const items: PageContextMenuExtensionItem[] = [];
      for (const entry of this.#ordered()) {
        if (!this.#runnable(entry) || !entry.scope.onIn(tab.spaceId)) continue;
        const manifest = entry.loaded!.manifest;
        for (const item of manifest.contextMenus ?? []) {
          if (!item.contexts.some((context) => context !== "window")) continue;
          if (!ExtensionScope.menuHostAllowed(item.hosts, tab.url)) continue;
          items.push({ extensionId: entry.id, extensionName: manifest.name, itemId: item.id, title: item.title, contexts: item.contexts });
        }
      }
      return items;
    },
    clicked: (item: PageContextMenuExtensionItem, click: { tabId: string; pageUrl: string; linkUrl?: string; selectionText?: string; srcUrl?: string }): void => {
      void this.#menu(item.extensionId, item.itemId, { ...click, tabId: click.tabId, pageUrl: click.pageUrl }).catch((error: unknown) => this.#window?.notice(error instanceof Error ? error.message : String(error)));
    },
  };

  /**
   * BrowserController's `chromeTabs` hook (docs/extensions.md §4 "Chrome extensions"): the person's tabs as Chrome
   * extensions see them — made, put in use — and their `contextMenus` items for a page.
   */
  readonly chromeTabs = {
    added: (tabId: string, contents: WebContents, url: string): void => this.#chrome.tabAdded(tabId, contents, url),
    selected: (tabId: string, contents: WebContents): void => this.#chrome.tabSelected(tabId, contents),
    menuItems: (contents: WebContents, params: ContextMenuParams): MenuItem[] => this.#chrome.menuItems(contents, params),
  };

  /**
   * A Profile's session is about to show a page (main's `prepareSpaceSession`): with a Chrome extension on there, the
   * libraries attach and its extensions load first, waited for briefly; with none, nothing is imported or touched.
   */
  profileSession(ses: Session, profileId: string, partition: string): Promise<void> {
    return this.#chrome.profileSession(ses, profileId, partition);
  }

  /** Whether a webContents is one of an extension's contexts (the IPC gate refuses those on `pistachio:*`). */
  isExtensionSender(contentsId: number): boolean {
    return this.#views.isExtension(contentsId) || [...this.#entries.values()].some((entry) => entry.worker?.contents?.id === contentsId);
  }

  /** The tab side changed (main's publish tick): tab events, gesture grants, the current space. */
  tabsChanged(): void {
    const browser = this.#window?.browser;
    if (browser === undefined) return;
    const tabs = browser.tabs();
    const next = new Map<string, TabFacts>(tabs.map((tab) => [tab.id, { title: tab.title, url: tab.url, loading: tab.loading, favIconUrl: tab.faviconUrl, profileId: tab.spaceId }]));
    const previous = this.#lastTabs;
    this.#lastTabs = next;
    // (The window's first tick is the tabs as they are: no event says they were all just made.)
    const primed = this.#tabsPrimed;
    this.#tabsPrimed = true;
    for (const entry of this.#entries.values()) for (const tabId of previous.keys()) entry.scope.tabNavigated(tabId, next.get(tabId)?.url ?? null);
    const listening = [...this.#entries.values()].filter((entry) => [...entry.subscriptions.values()].some((sub) => sub.event.startsWith("tabs.") || sub.event === "spaces.currentChanged"));
    const active = browser.activeTabId();
    const profile = browser.activeProfileId();
    const current = browser.currentSpaceId(profile);
    if (listening.length > 0) {
      for (const tab of tabs) {
        const before = previous.get(tab.id);
        if (before === undefined) {
          if (primed) for (const entry of listening) this.#tabEvent(entry, "tabs.created", tab, (described) => ({ tab: described }));
          continue;
        }
        const changed: ("title" | "url" | "loading" | "favIconUrl")[] = [];
        if (before.title !== tab.title) changed.push("title");
        if (before.url !== tab.url) changed.push("url");
        if (before.loading !== tab.loading) changed.push("loading");
        if (before.favIconUrl !== tab.faviconUrl) changed.push("favIconUrl");
        if (changed.length > 0) for (const entry of listening) this.#tabEvent(entry, "tabs.updated", tab, (described) => ({ tab: described, changed }));
      }
      for (const [tabId, facts] of previous) {
        if (next.has(tabId)) continue;
        for (const entry of listening) if (entry.scope.onIn(facts.profileId)) this.#deliver(entry, "tabs.removed", { tabId });
      }
      if (active !== this.#lastActiveTab) {
        const tab = active === null ? null : browser.tab(active);
        for (const entry of listening) {
          const visible = tab === null ? null : entry.scope.describeTab(tab);
          if (tab !== null && visible === null) continue;
          this.#deliver(entry, "tabs.activated", { tabId: visible?.id ?? null });
        }
      }
      if (current !== this.#lastCurrentSpace) {
        for (const entry of listening) {
          if (!entry.scope.onIn(profile)) continue;
          let space: Json = null;
          try {
            space = entry.scope.spaces.current() as unknown as Json;
          } catch {
            space = null;
          }
          this.#deliver(entry, "spaces.currentChanged", { space });
        }
      }
    }
    this.#lastActiveTab = active;
    this.#lastCurrentSpace = current;
    this.#endForbidden();
    if (profile !== this.#lastProfile) {
      this.#lastProfile = profile;
      this.#publish();
    }
  }

  /**
   * A tab closed, woke as another page, went to an address no extension may record, left a Profile — or an extension
   * left the Profile (off here): its captures and subscriptions there end now.
   */
  #endForbidden(): void {
    void this.#captures.check();
    this.#taps.refresh();
    for (const subscriber of this.#taps.subscribers()) {
      if (!this.#capturable(subscriber.extensionId, subscriber.tabId)) this.#stopInput(subscriber.id);
    }
  }

  /** The shell reported its desk: `desk.changed`, at most four times a second. */
  deskChanged(): void {
    if (this.#deskTimer !== null) return;
    this.#deskTimer = setTimeout(() => {
      this.#deskTimer = null;
      for (const entry of this.#entries.values()) {
        if (![...entry.subscriptions.values()].some((sub) => sub.event === "desk.changed")) continue;
        try {
          this.#deliver(entry, "desk.changed", { state: entry.scope.desk.state() as unknown as Json });
        } catch {
          // Off in the Profile in front, or no window: nothing to say.
        }
      }
    }, DESK_EVENT_MS);
    this.#deskTimer.unref();
  }

  /**
   * A key from any view main relays (a tab's page, an extension's page or panel, the shell's own document): an
   * extension's declared key command, when the key is bound to one (./keys.ts) and the app holds it for nothing of
   * its own now. Runs it on the window in use (granting the extension that tab) and keeps the key from the view.
   */
  takeKey(event: Electron.Event, input: Electron.Input): boolean {
    if (input.type !== "keyDown" || input.isAutoRepeat === true) return false;
    if (!input.meta && !input.control && !input.alt && !/^F\d{1,2}$/.test(input.key)) return false;
    const platform = process.platform === "darwin" ? "darwin" : "other";
    const binding = shortcutFromEvent(input, platform);
    if (binding === null) return false;
    // (The person's own binding wins at the moment of the key, whatever was bound before.)
    if (shortcutActionForEvent(this.#options.shortcuts?.() ?? DEFAULT_SHORTCUTS, input, platform, "native") !== null) return false;
    const bound = this.#keyBindings().find((candidate) => candidate.binding === binding);
    const entry = bound === undefined ? undefined : this.#entries.get(bound.extensionId);
    const browser = this.#window?.browser;
    if (bound === undefined || entry === undefined || browser === undefined || !this.#runnable(entry) || !entry.scope.onIn(browser.activeProfileId())) return false;
    event.preventDefault();
    const tabId = browser.activeTabId();
    entry.scope.grantTab(tabId);
    void this.#invokeForShell(entry, "key", bound.commandId, { tabId, spaceId: this.#spaceOf(tabId) }, this.#profileOf(tabId)).catch((error: unknown) =>
      this.#window?.notice(error instanceof Error ? error.message : String(error)),
    );
    return true;
  }

  /** A tab preload's report (`pistachio:extension-input`, apps/desktop/src/preload/tab.ts): to the input tap on its page. */
  preloadInput(event: { sender: WebContents; senderFrame: Electron.WebFrameMain | null }, message: unknown): void {
    const frame = event.senderFrame;
    if (frame === null) return;
    let isMain: boolean;
    let at: { processId: number; routingId: number };
    try {
      isMain = frame === event.sender.mainFrame;
      at = { processId: frame.processId, routingId: frame.routingId };
    } catch {
      return;
    }
    this.#taps.fromPreload(event.sender.id, at, isMain, message);
  }

  /** The shell's veil came or went: the panel steps out from over its sheets. */
  reveil(): void {
    this.#window?.panel.reveil();
  }

  /** Raise the panel over the tab views (main's raise order, before the notices). */
  raisePanel(): void {
    this.#window?.panel.raise();
  }

  /* ------------------------------- the agent ------------------------------- */

  /**
   * The tools a turn in `profileId` may have (docs/extensions.md §6.2, "Agent tools"): each declared tool of an
   * extension on in that Profile, holding `agent:tools`, *Agent can use it* left on.
   */
  agentTools(profileId: string): ExtensionToolSpec[] {
    return agentToolSpecs(this.#ordered().map((entry) => this.#agentView(entry)), profileId);
  }

  /** One call of an extension's tool for the agent: the worker's handler, 30 s, its input on the ledger. Rejects with a sentence. */
  async callTool(extensionId: string, tool: string, input: unknown, ctx: ExtensionToolCallContext & { profileId: string }): Promise<unknown> {
    const key = `${extensionId}\n${ctx.runId}`;
    if (ctx.progress !== undefined) this.#toolProgress.set(key, ctx.progress);
    try {
      return await callAgentTool(
        {
          find: (id) => {
            const entry = this.#entries.get(id);
            return entry === undefined ? null : this.#agentView(entry);
          },
          invoke: (id, name, value, profileId) => this.#invoke(this.#requireRunnable(id), "tool", name, value, profileId),
          ledger: (id, line) => this.#entries.get(id)?.ledger.record(line),
        },
        extensionId,
        tool,
        input,
        { runId: ctx.runId, spaceId: ctx.spaceId, profileId: ctx.profileId, signal: ctx.signal },
      );
    } catch (error) {
      const entry = this.#entries.get(extensionId);
      if (entry !== undefined) this.#log(entry, { at: Date.now(), context: "main", level: "warn", message: `tool ${tool}: ${error instanceof Error ? error.message : String(error)}` });
      throw error;
    } finally {
      if (this.#toolProgress.get(key) === ctx.progress) this.#toolProgress.delete(key);
    }
  }

  /** The author turn takes the draft folder the Bar made, with the token `draftFolder` handed the shell (once). */
  claimDraft(slug: string, token: string): DraftClaim | null {
    return this.#drafts.claim(slug, token);
  }

  /** What the author tools reach: the claimed draft folders, and nothing beside. */
  get authorHost(): ExtensionAuthorHost {
    return this.#drafts;
  }

  /** The API's guide for an author turn's prompt (`packages/extension-api/AGENTS.md`, as the dev folder gets it). */
  authorGuide(): string {
    try {
      return readFileSync(join(this.#apiDir(), "AGENTS.md"), "utf8");
    } catch {
      return "";
    }
  }

  /** An author turn started or stopped writing into `folder`: its Ledge icon shimmers meanwhile. */
  setDrafting(folder: string, on: boolean): void {
    if (on ? this.#drafting.has(folder) : !this.#drafting.has(folder)) return;
    if (on) this.#drafting.add(folder);
    else this.#drafting.delete(folder);
    this.#publish();
  }

  /**
   * The agent wrote to an approved extension's folder (docs/extensions.md §6.2, "Approving"): it waits paused on the
   * sheet — "Pistachio changed it" — whatever it asks, until the person approves again. A person's own edits
   * hot-reload; an agent's never run unseen.
   */
  markAgentChanged(id: string): void {
    const record = this.#registry.get(id);
    if (record === null || record.grants === null) return;
    const entry = this.#entries.get(id);
    const manifest = entry?.loaded?.manifest;
    const widened = manifest === undefined ? { capabilities: [], hosts: [] } : widenedAsks(record.grants, manifest);
    this.#registry.update(id, {
      pending: { manifestHash: manifest === undefined ? record.grants.manifestHash : sheetFor(manifest).manifestHash, widened: widened.capabilities, hosts: widened.hosts, changedBy: "agent" },
    });
    if (entry !== undefined) {
      this.#stop(entry);
      this.#log(entry, { at: Date.now(), context: "main", level: "warn", message: "paused: Pistachio's agent changed it; it runs again once the person approves" });
    }
    this.#publish();
  }

  /** Before an author turn writes into `folder`: an approved extension there is paused first, so the reload keeps it so. */
  #agentWrites(folder: string): void {
    this.#agentWrittenAt.set(folder, Date.now());
    const record = this.#registry.findByPath(folder);
    if (record !== null && record.grants !== null) this.markAgentChanged(record.id);
  }

  #agentView(entry: Entry): AgentExtensionView {
    const record = this.#registry.get(entry.id);
    return {
      id: entry.id,
      manifest: entry.loaded?.manifest ?? null,
      runnable: this.#runnable(entry),
      agentAllowed: record?.agentAllowed === true,
      can: (capability) => entry.scope.can(capability),
      onIn: (profileId) => entry.scope.onIn(profileId),
    };
  }

  /* ------------------------------- the wire ------------------------------- */

  /** `pistachio-ext:call`: never throws across IPC. */
  async call(event: { sender: WebContents; senderFrame: Electron.WebFrameMain | null }, method: unknown, args: unknown): Promise<ExtReply> {
    const identity = this.#views.caller({ sender: event.sender, senderFrame: event.senderFrame });
    if (identity === null) return { ok: false, code: "PERMISSION_DENIED", message: "not a Pistachio extension's page, panel or worker" };
    const entry = this.#entries.get(identity.extensionId);
    if (entry === undefined || !this.#runnable(entry)) return { ok: false, code: "UNAVAILABLE", message: "this extension is off" };
    let url = "";
    try {
      url = event.senderFrame?.url ?? "";
    } catch {
      url = "";
    }
    const ctx: CallContext = {
      extensionId: entry.id,
      context: identity.context,
      page: identity.context === "page" ? pageNameOf(entry.loaded?.manifest.pages, entry.id, url) : null,
      senderId: event.sender.id,
    };
    if (identity.context === "worker") entry.worker?.touch();
    return dispatch(method, args, entry.scope, ctx, entry.runtime);
  }

  /* ----------------------------- the shell's word ----------------------------- */

  /**
   * The shell's `extensions(request)`. Throws (to the shell) with a sentence when it cannot be done. The snapshot is
   * published after every request, answered or refused: the shell has no "get", and its first request (a
   * `closePanel`, its hello) is what brings it the snapshot.
   */
  async request(value: unknown): Promise<ExtensionResponse> {
    try {
      return await this.#answer(value);
    } finally {
      this.#publish();
    }
  }

  async #answer(value: unknown): Promise<ExtensionResponse> {
    const parsed = requestSchema.safeParse(value);
    if (!parsed.success) throw new Error("That is not an extensions request.");
    const request = parsed.data as ExtensionRequest;
    switch (request.type) {
      case "approve":
        if (this.#registry.get(request.id)?.kind === "chrome") await this.#chrome.approve(request.id, request.manifestHash);
        else this.#approve(request.id, request.manifestHash, request.agentAllowed);
        return { type: "ok" };
      case "deny":
        this.#deny(request.id);
        return { type: "ok" };
      case "setEnabled":
        this.#setEnabled(request.id, request.enabled, request.scope ?? "all");
        return { type: "ok" };
      case "pin":
        this.#requireRecord(request.id);
        this.#registry.update(request.id, { pinned: request.pinned });
        this.#publish();
        return { type: "ok" };
      case "reorder":
        this.#requireRecord(request.id);
        // (The index is the Ledge's: among the pinned extensions, in their order.)
        this.#registry.reorder(request.id, request.index, (record) => record.pinned);
        this.#publish();
        return { type: "ok" };
      case "uninstall":
        await this.#uninstall(request.id);
        return { type: "ok" };
      case "reload":
        this.#requireRecord(request.id);
        this.#reload(request.id, "reload");
        return { type: "ok" };
      case "setAgentAllowed": {
        const entry = this.#requireEntry(request.id);
        if (request.allowed && ((entry.loaded?.manifest.tools?.length ?? 0) === 0 || !entry.scope.can("agent:tools"))) throw new Error("This extension has no tools the agent could call.");
        this.#registry.update(request.id, { agentAllowed: request.allowed });
        this.#publish();
        return { type: "ok" };
      }
      case "setSetting":
        this.#setSetting(request.id, request.key, request.value);
        return { type: "ok" };
      case "setDeveloperMode": {
        const current = this.#options.settings();
        this.#options.setSettings({ developerMode: request.on, devFolder: current.devFolder });
        return { type: "ok" };
      }
      case "loadFolder":
        return this.#loadFolder(request.path);
      case "revealFolder": {
        const record = this.#requireRecord(request.id);
        const root = this.#rootOf(record);
        if (root === null) throw new Error("This extension has no folder on this Mac.");
        shell.showItemInFolder(join(root, record.kind === "chrome" ? "manifest.json" : "pistachio.json"));
        return { type: "ok" };
      }
      case "newFolder":
        return this.#newFolder(request.name, request.template);
      case "installChrome":
        return this.#chrome.install(request.cwsId, this.#window?.browser.activeProfileId() ?? null);
      case "approveInstall":
        await this.#chrome.approveInstall(request.cwsId, request.manifestHash);
        return { type: "ok" };
      case "denyInstall":
        await this.#chrome.denyInstall(request.cwsId);
        return { type: "ok" };
      case "activate":
        await this.#activate(request.id, request.tabId, request.anchor);
        return { type: "ok" };
      case "closePanel":
        this.#closePanel();
        return { type: "ok" };
      case "barCommand":
        await this.#barCommand(request.id, request.command, request.arg, request.spaceId, request.tabId, request.selection ?? null);
        return { type: "ok" };
      case "menu":
        await this.#menu(request.id, request.item, request.click);
        return { type: "ok" };
      case "statusAction": {
        const entry = this.#requireRunnable(request.id);
        const source = request.source ?? "status";
        // A toast's button answers only what one of its toasts offered.
        if (source === "toast" && !entry.toastActions.includes(request.action)) return { type: "ok" };
        // Main's own Stop on the pill (drawn because the extension records with no pill of its own, or one with no
        // Stop) is the person's stop: the extension hears it, and its captures end whatever it does (after its
        // handler answers, or STOP_WAIT_MS). An extension's own Stop is its to honour: its pill says it records.
        const stopping = source === "status" && request.action === STOP_ACTION && this.#recording(entry) && !(entry.statusPill?.actions ?? []).some((action) => action.id === STOP_ACTION);
        const invoked = this.#invoke(entry, "statusAction", request.action, { action: request.action, source }, null);
        if (!stopping) {
          await invoked;
          return { type: "ok" };
        }
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([invoked.catch(() => undefined), new Promise((resolve) => (timer = setTimeout(resolve, STOP_WAIT_MS)))]).finally(() => clearTimeout(timer));
        this.#stopRecording(entry, "stop");
        await invoked.catch(() => undefined);
        return { type: "ok" };
      }
      case "openPage": {
        const entry = this.#requireRunnable(request.id);
        if (entry.loaded!.manifest.pages?.[request.page] === undefined) throw new Error(`${entry.loaded!.manifest.name} has no page "${request.page}".`);
        const place = entry.scope.pagePlace(undefined);
        await this.#openPage(entry, request.page, request.query, place);
        return { type: "ok" };
      }
      case "logs": {
        const entry = this.#entries.get(request.id);
        return { type: "logs", lines: entry?.status.lines() ?? [] };
      }
      case "draftFolder":
        return this.#draftFolder(request.name);
    }
  }

  /** The shell's slot for the open panel (IPC.extensionPanelBounds); null when its card closed. */
  setPanelBounds(bounds: ContentBounds | null): void {
    const parts = this.#window;
    if (parts === null) return;
    if (bounds === null || this.#openPanel === null) {
      parts.panel.setSlot(null);
      return;
    }
    parts.panel.setSlot(bounds);
  }

  /* ------------------------------- snapshot ------------------------------- */

  snapshot(): ExtensionsSnapshot {
    const settings = this.#options.settings();
    const recorded = new Set(this.#registry.list().map((record) => record.id));
    const library: ExtensionLibraryEntry[] = [];
    for (const [id, bundled] of this.#bundled) {
      if (recorded.has(id) || !bundled.result.ok) continue;
      const manifest = bundled.result.manifest;
      library.push({ id, name: manifest.name, description: manifest.description ?? "", iconUrl: bundled.result.iconUrl });
    }
    return {
      ...EMPTY_EXTENSIONS_SNAPSHOT,
      extensions: this.#registry.list().map((record) => this.#info(record)),
      developerMode: settings.developerMode,
      devFolder: settings.developerMode ? this.#devFolder() : null,
      library,
      curated: CURATED_CHROME,
      pendingInstall: this.#chrome.pendingInstall(),
      openPanel: this.#openPanel,
    };
  }

  #info(record: ExtensionRecord): ExtensionInfo {
    if (record.kind === "chrome") return this.#chrome.info(record, this.#window?.browser.activeProfileId() ?? null);
    const entry = this.#entries.get(record.id);
    const manifest = entry?.loaded?.manifest ?? null;
    const activeProfile = this.#window?.browser.activeProfileId() ?? null;
    const enabledHere = record.profiles === "all" || (activeProfile !== null && record.profiles.includes(activeProfile));
    const stored = manifest === null ? {} : this.#registry.settingsOf(record.id);
    const settings: ExtensionSettingInfo[] = (manifest?.settings ?? []).map((setting) => {
      const values = manifest === null ? {} : settingValues(manifest, stored, false);
      return {
        key: setting.key,
        title: setting.title,
        description: setting.description ?? null,
        type: setting.type,
        options: setting.type === "enum" ? setting.options : null,
        value: setting.type === "secret" ? (stored[setting.key] === undefined ? "" : "••••••") : (values[setting.key] ?? null),
        ...(setting.type === "number" && setting.min !== undefined ? { min: setting.min } : {}),
        ...(setting.type === "number" && setting.max !== undefined ? { max: setting.max } : {}),
      };
    });
    const needsSheet = manifest !== null && (record.grants === null || record.pending !== null);
    return {
      id: record.id,
      kind: record.kind,
      name: manifest?.name ?? record.id,
      version: manifest?.version ?? "",
      description: manifest?.description ?? "",
      // (Only an icon the default session will serve: an extension on, or waiting on approval.)
      iconUrl: manifest === null || this.#iconFor(record.id) === null ? null : (entry?.loaded?.iconUrl ?? null),
      source: record.source,
      enabled: record.enabled,
      enabledHere,
      pinned: record.pinned,
      order: record.order,
      agentAllowed: record.agentAllowed && entry !== undefined && entry.scope.can("agent:tools"),
      status: entry === undefined ? "error" : this.#statusOf(entry, record, enabledHere),
      error: entry?.failure !== null && entry?.failure !== undefined ? { message: entry.failure.error, at: Date.now() } : (entry?.error ?? null),
      badge: entry?.badge ?? null,
      statusPill: entry === undefined ? null : statusPillFor(entry.statusPill, manifest?.name ?? record.id, this.#liveOf(entry)),
      hasPanel: manifest?.panel !== undefined && manifest !== null,
      panelWidth: manifest?.panel?.width ?? null,
      hasAction: manifest !== null && (manifest.panel !== undefined || manifest.action === true),
      pages: Object.entries(manifest?.pages ?? {}).map(([name, page]) => ({ name, title: page.title })),
      barCommands: (manifest?.bar?.commands ?? []).map((command) => ({ name: command.name, description: command.description, arg: command.arg === undefined ? null : { hint: command.arg.hint, required: command.arg.required === true } })),
      menuItems: (manifest?.contextMenus ?? []).map((item) => ({ id: item.id, title: item.title, contexts: [...item.contexts], hosts: item.hosts ?? [] })),
      settings,
      tools: (manifest?.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description, effect: tool.effect })),
      grants: record.grants === null ? null : { capabilities: [...record.grants.capabilities], hosts: [...record.grants.hosts] },
      pending: needsSheet ? { ...sheetFor(manifest!), ...(record.pending?.changedBy === "agent" ? { changedByAgent: true } : {}) } : null,
      verdict: null,
      devPath: record.source.type === "dev" || record.source.type === "unpacked" ? record.source.path : null,
      captures: entry === undefined ? [] : this.#liveTabs(entry),
      ...(entry?.root !== null && entry?.root !== undefined && this.#drafting.has(entry.root) ? { drafting: true } : {}),
    };
  }

  #statusOf(entry: Entry, record: ExtensionRecord, enabledHere: boolean): ExtensionStatus {
    if (entry.failure !== null || entry.loaded === null || entry.worker?.looping === true) return "error";
    if (record.grants === null) return "needs-approval";
    if (record.pending !== null) return "paused";
    if (!record.enabled || !enabledHere) return "off";
    return entry.worker?.running === true ? "running" : "idle";
  }

  #publish(): void {
    if (this.#publishQueued || this.#disposed) return;
    this.#publishQueued = true;
    queueMicrotask(() => {
      this.#publishQueued = false;
      // (An extension turned on or off, approved, reloaded: its keys are bound again.)
      this.#keys = null;
      // (The status files are the folders', window or not: an agent writing a draft reads them.)
      for (const entry of this.#entries.values()) this.#writeStatus(entry);
      const window = this.#window?.window;
      if (window === undefined || window.isDestroyed()) return;
      window.webContents.send(IPC.extensionsChanged, this.snapshot());
    });
  }

  /* ------------------------------- entries ------------------------------- */

  #ordered(): Entry[] {
    return this.#registry.list().flatMap((record) => this.#entries.get(record.id) ?? []);
  }

  #requireRecord(id: string): ExtensionRecord {
    const record = this.#registry.get(id);
    if (record === null) throw new Error("There is no such extension.");
    return record;
  }

  #requireEntry(id: string): Entry {
    this.#requireRecord(id);
    const entry = this.#entries.get(id);
    if (entry === undefined) throw new Error("That extension could not be loaded.");
    return entry;
  }

  #requireRunnable(id: string): Entry {
    const entry = this.#requireEntry(id);
    if (!this.#runnable(entry)) {
      const record = this.#registry.get(id)!;
      if (entry.loaded === null) throw new Error(entry.failure?.error ?? "That extension could not be loaded.");
      if (record.grants === null || record.pending !== null) throw new Error(`${entry.loaded.manifest.name} is waiting on your approval.`);
      throw new Error(`${entry.loaded.manifest.name} is off.`);
    }
    return entry;
  }

  /** Approved, on, loaded, not paused: its code may run and its calls are answered. */
  #runnable(entry: Entry): boolean {
    const record = this.#registry.get(entry.id);
    return record !== null && record.kind === "pistachio" && record.enabled && onInAnyProfile(record) && record.grants !== null && record.pending === null && entry.loaded !== null && entry.worker?.looping !== true;
  }

  #rootOf(record: ExtensionRecord): string | null {
    switch (record.source.type) {
      case "bundled":
        return this.#bundled.get(record.id)?.root ?? null;
      case "dev":
      case "unpacked":
        return record.source.path;
      case "webstore":
        return null;
    }
  }

  #loadFor(record: ExtensionRecord, root: string): LoadedExtension | LoadFailure {
    if (record.source.type === "bundled") {
      const bundled = this.#bundled.get(record.id);
      if (bundled !== undefined) return bundled.result;
    }
    const result = loadExtensionFolder(root);
    if (result.ok && result.manifest.id !== record.id) {
      return { ok: false, root, id: result.manifest.id, error: `pistachio.json now says "${result.manifest.id}" where this extension was "${record.id}": change "id" back, or remove the extension and add the folder again.`, issues: [{ path: "id", message: "the id changed" }] };
    }
    return result;
  }

  /** Make or refresh the entry for `id` from a load. */
  #mount(id: string, root: string | null, result: LoadedExtension | LoadFailure | null): Entry {
    let entry = this.#entries.get(id);
    if (entry === undefined) {
      const dataDir = extensionDataDir(this.#options.userDataDir, id);
      const record = this.#registry.get(id);
      const devFolder = record !== null && (record.source.type === "dev" || record.source.type === "unpacked") ? record.source.path : null;
      const ledger = new Ledger(join(dataDir, "ledger.ndjson"));
      const created: Entry = {
        id,
        root,
        loaded: null,
        failure: null,
        error: null,
        scope: undefined as unknown as ExtensionScope,
        storage: new ExtensionStorage(join(dataDir, "storage.json")),
        data: new DataFiles(join(dataDir, "data")),
        ledger,
        status: new StatusWriter(devFolder, id),
        runtime: undefined as unknown as ExtensionRuntime,
        worker: null,
        badge: null,
        statusPill: null,
        holds: new Map(),
        sleep: new Map(),
        workerId: null,
        owned: loadOwned(join(dataDir, "owned.json")),
        ownedFile: join(dataDir, "owned.json"),
        subscriptions: new Map(),
        inputs: new Map(),
        toastActions: [],
      };
      created.scope = new ExtensionScope(id, {
        record: () => this.#registry.get(id),
        manifest: () => this.#entries.get(id)?.loaded?.manifest ?? null,
        browser: () => this.#window?.browser ?? null,
        ledger,
      });
      created.runtime = this.#runtimeFor(created);
      this.#entries.set(id, created);
      entry = created;
    }
    entry.root = root;
    if (result === null) {
      entry.loaded = null;
      entry.failure = { ok: false, root: root ?? "", id, error: "Its folder is not on this Mac any more.", issues: [] };
    } else if (result.ok) {
      entry.loaded = result;
      entry.failure = null;
    } else {
      entry.loaded = null;
      entry.failure = result;
    }
    if (result !== null) this.#loadedAt.set(id, Date.now());
    return entry;
  }

  #writeStatus(entry: Entry): void {
    const record = this.#registry.get(entry.id);
    if (record === null) return;
    const manifest = entry.loaded?.manifest;
    const enabledHere = record.profiles === "all" || (this.#window !== null && record.profiles.includes(this.#window.browser.activeProfileId()));
    const pendingAsks = record.pending === null ? null : { capabilities: record.pending.widened, hosts: record.pending.hosts };
    entry.status.update({
      id: entry.id,
      state: this.#statusOf(entry, record, enabledHere),
      api: manifest?.api ?? null,
      manifestErrors: entry.failure?.issues.length ? entry.failure.issues : entry.failure !== null ? [{ path: "", message: entry.failure.error }] : [],
      pendingGrants: pendingAsks,
      surfaces: {
        bar: (manifest?.bar?.commands ?? []).map((command) => `/${command.name}`),
        tools: (manifest?.tools ?? []).map((tool) => tool.name),
        pages: Object.keys(manifest?.pages ?? {}),
      },
      keys: (manifest?.commands ?? []).map((command) => {
        const bound = this.#runnable(entry) ? this.#keyBindings().find((binding) => binding.extensionId === entry.id && binding.commandId === command.id) : undefined;
        return {
          id: command.id,
          key: command.key ?? null,
          binding: bound?.binding ?? null,
          unbound: bound?.unbound ?? (command.key === undefined || bound !== undefined ? null : "bound once the extension is on and approved"),
        };
      }),
    });
  }

  /* ------------------------------- sessions ------------------------------- */

  /**
   * A view made on an extension's partition runs WebRTC with proxied UDP only — which the black-hole proxy has
   * none of — whoever made it (a page's tab is BrowserController's, the panel's and the worker's the registry's).
   */
  #sealContents(contents: WebContents): void {
    if (contents.isDestroyed() || !this.#configured.has(contents.session)) return;
    contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  }

  /** The extension's partition, set up once: the folder served, nothing else reached, nothing downloaded or asked. */
  #prepareSession(id: string): Session {
    const ses = session.fromPartition(extensionPartition(id));
    if (this.#configured.has(ses)) return ses;
    this.#configured.add(ses);
    if (ses.protocol.isProtocolHandled(EXTENSION_SCHEME)) ses.protocol.unhandle(EXTENSION_SCHEME);
    ses.protocol.handle(EXTENSION_SCHEME, (request) => serveExtensionRequest(request, id, this.#folders));
    // `connect-src 'self'` enforced twice: nothing leaves the partition but its own origin (net.fetch has its own).
    ses.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !/^(pistachio-ext|data|blob|devtools):/i.test(details.url) });
    });
    // And a third time, under both: the partition's proxy is a black hole, loopback included, so what neither the
    // CSP nor webRequest sees — WebRTC's STUN and TURN, which would carry anything out as a username — reaches
    // nothing either (its views also run with only proxied UDP: #sealContents). MEASURED (Electron 43.4.1): a page
    // whose requests are all cancelled still opened a TURN/TCP connection to a server; with this proxy it opened
    // none, and none when loaded without waiting for the proxy to apply (~100 ms).
    void ses.setProxy(SEALED_PROXY).catch((error: unknown) => {
      const entry = this.#entries.get(id);
      if (entry !== undefined) this.#log(entry, { at: Date.now(), context: "main", level: "error", message: `the partition's proxy could not be set: ${error instanceof Error ? error.message : String(error)}` });
    });
    // The microphone and the camera from the grants (media:microphone, media:camera), to the extension's own
    // contexts; the screen only through capture.arm — one request, from the worker's frame (./capture.ts).
    // MEASURED (Electron 43.4.1): a getDisplayMedia asks for "media" with no media types first, and a refusal here
    // is the page's NotAllowedError; the tab's own session is never asked.
    ses.setPermissionRequestHandler((contents, permission, callback, details) => {
      if (permission === "fullscreen") return callback(true);
      const mediaTypes = "mediaTypes" in details ? (details.mediaTypes ?? []) : [];
      if (permission === "display-capture" || (permission === "media" && mediaTypes.length === 0)) return callback(this.#captures.mayCapture(id, contents.id));
      if (permission === "media") return callback(this.#mediaAllowed(id, contents.id, mediaTypes));
      callback(false);
    });
    ses.setPermissionCheckHandler((contents, permission, _origin, details) => {
      if (permission === "fullscreen") return true;
      if (permission !== "media" || contents === null) return false;
      return details.mediaType === "audio" || details.mediaType === "video" ? this.#mediaAllowed(id, contents.id, [details.mediaType]) : false;
    });
    ses.setDisplayMediaRequestHandler((request, callback) => {
      const answer = this.#captures.answer(id, { frame: request.frame, audioRequested: request.audioRequested });
      try {
        callback(answer === null ? {} : (answer as unknown as Electron.Streams));
      } catch {
        // Electron throws at an empty answer to a request for video: the page hears it refused (an AbortError).
      }
    });
    ses.on("will-download", (event) => event.preventDefault());
    return ses;
  }

  /** The microphone or the camera for one of the extension's own contexts, as its grants say. */
  #mediaAllowed(id: string, contentsId: number, mediaTypes: readonly string[]): boolean {
    const entry = this.#entries.get(id);
    if (entry === undefined || !this.#runnable(entry) || mediaTypes.length === 0) return false;
    const own = this.#views.get(contentsId)?.extensionId === id || entry.worker?.contents?.id === contentsId;
    return own && mediaTypes.every((type) => (type === "audio" ? entry.scope.can("media:microphone") : type === "video" ? entry.scope.can("media:camera") : false));
  }

  /** `net.fetch`'s partition: its one filter holds every hop — redirects too — to the hosts granted. */
  #netSession(entry: Entry): Session {
    const ses = session.fromPartition(extensionNetPartition(entry.id));
    if (this.#configured.has(ses)) return ses;
    this.#configured.add(ses);
    ses.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !entry.scope.hostAllowed(details.url) });
    });
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ses.on("will-download", (event) => event.preventDefault());
    return ses;
  }

  readonly #folders: ExtensionFolders = {
    folder: (id) => {
      const entry = this.#entries.get(id);
      // (A page restored for an extension since removed shows it is off, at its own address.)
      if (entry === undefined) return { off: id };
      const name = entry.loaded?.manifest.name ?? id;
      if (!this.#runnable(entry) || entry.root === null) return { off: name };
      return { root: entry.root, manifest: entry.loaded!.manifest, name };
    },
    dataFolder: (id) => {
      const entry = this.#entries.get(id);
      return entry !== undefined && this.#runnable(entry) && entry.scope.can("files:data") ? entry.data.root : null;
    },
  };

  #iconFor(id: string): { root: string; icon: string } | null {
    const record = this.#registry.get(id);
    const entry = this.#entries.get(id);
    const manifest = entry?.loaded?.manifest;
    if (record !== null && entry !== undefined && manifest?.icon !== undefined && entry.root !== null && (record.enabled || record.grants === null || record.pending !== null)) {
      return { root: entry.root, icon: manifest.icon };
    }
    const bundled = this.#bundled.get(id);
    if (bundled !== undefined && bundled.result.ok && bundled.result.manifest.icon !== undefined) return { root: bundled.root, icon: bundled.result.manifest.icon };
    return null;
  }

  /* ------------------------------- the views ------------------------------- */

  #panelMade(view: WebContentsView, extensionId: string): void {
    const contents = view.webContents;
    this.#views.register(contents, extensionId, "panel");
    contents.on("before-input-event", (event, input) => {
      const parts = this.#window;
      if (parts === null) return;
      // ⎋ closes the card, as a press elsewhere does; ⌘ keys go on to the shell, as a tab's do.
      if (input.type === "keyDown" && input.key === "Escape" && !input.meta && !input.control && !input.alt) {
        event.preventDefault();
        this.#closePanel();
        if (!parts.window.isDestroyed()) parts.window.webContents.focus();
        return;
      }
      parts.relayKeys(event, input, contents);
    });
  }

  /** A view's document is gone — the view closed or crashed, left its origin, or loads another page of its own: what it held goes. */
  #viewDropped(contentsId: number, identity: ViewIdentity): void {
    const entry = this.#entries.get(identity.extensionId);
    if (entry === undefined) return;
    for (const [id, sub] of entry.subscriptions) if (sub.senderId === contentsId) entry.subscriptions.delete(id);
    for (const [id, senderId] of entry.inputs) if (senderId === contentsId) this.#stopInput(id);
    // Its keep-alive and capture holds go with it: their release went with the document.
    for (const [id, hold] of [...entry.holds]) if (hold.owner === contentsId) entry.holds.delete(id);
    this.#captures.releaseOwned(entry.id, contentsId);
    this.#releaseOwned(entry, contentsId);
  }

  /** A file the extension saved or picked is its to show, copy and drag from now on — after a relaunch too (`ownedFile`). */
  #remember(entry: Entry, path: string): void {
    entry.owned.delete(path);
    entry.owned.add(path);
    while (entry.owned.size > OWNED_MAX) entry.owned.delete(entry.owned.values().next().value as string);
    saveOwned(entry.ownedFile, entry.owned);
  }

  /** What one view held — its power-save blockers, its open data writes — let go: it closed or crashed, or it was the worker and stopped. */
  #releaseOwned(entry: Entry, contentsId: number): void {
    for (const [id, hold] of [...entry.sleep]) {
      if (hold.owner !== contentsId) continue;
      powerSaveBlocker.stop(hold.blocker);
      entry.sleep.delete(id);
    }
    void entry.data.closeOwned(contentsId);
  }

  #consoleLine(identity: ViewIdentity, level: "debug" | "info" | "warn" | "error", message: string, file: string, line: number): void {
    const entry = this.#entries.get(identity.extensionId);
    if (entry === undefined) return;
    this.#log(entry, { at: Date.now(), context: identity.context, level, message, file, line });
    if (level === "error") entry.status.runtimeError({ context: identity.context, message, file, line, at: Date.now() });
  }

  #log(entry: Entry, line: LogLine): void {
    entry.status.log(line);
  }

  #worker(entry: Entry): WorkerHost {
    if (entry.worker !== null) return entry.worker;
    const worker = new WorkerHost({
      extensionId: entry.id,
      partition: extensionPartition(entry.id),
      preload: this.#options.preload,
      made: (contents) => {
        this.#prepareSession(entry.id);
        this.#views.register(contents, entry.id, "worker");
        entry.workerId = contents.id;
        this.#publish();
      },
      keptUp: () => entry.holds.size > 0 || this.#views.of(entry.id, "page").length > 0 || this.#views.of(entry.id, "panel").length > 0,
      stopped: (reason) => {
        for (const [id, pending] of this.#pending) {
          if (pending.extensionId !== entry.id) continue;
          clearTimeout(pending.timer);
          this.#pending.delete(id);
          pending.reject(new ExtError("CANCELLED", "the worker stopped"));
        }
        entry.holds.clear();
        // What it held goes with it: its streams, its power-save blockers, its open data files (a page's stay).
        this.#stopRecording(entry, "worker", true);
        const workerId = entry.workerId;
        entry.workerId = null;
        if (workerId !== null) this.#releaseOwned(entry, workerId);
        if (reason === "loop") {
          entry.error = { message: "Its worker crashed three times in a minute. It starts again once its files change.", at: Date.now() };
          this.#log(entry, { at: Date.now(), context: "main", level: "error", message: entry.error.message });
        }
        this.#publish();
      },
      log: (level, message) => this.#log(entry, { at: Date.now(), context: "main", level, message }),
    });
    entry.worker = worker;
    return worker;
  }

  async #ensureWorker(entry: Entry): Promise<WebContents> {
    if (entry.loaded?.manifest.worker === undefined) throw new ExtError("UNAVAILABLE", 'this extension has no worker: add "worker": { "type": "web", "main": "worker.js" } to pistachio.json');
    this.#prepareSession(entry.id);
    const contents = await this.#worker(entry).start();
    this.#publish();
    return contents;
  }

  /* ----------------------------- invocations ----------------------------- */

  /**
   * A declared handler in the worker (`invoke` on the event channel), awaited
   * through `runtime.done` with the kind's timeout. While it runs, the
   * worker's calls with no tab act in `profileId` (the Profile it was invoked
   * in; the Profile in front when null).
   */
  async #invoke(entry: Entry, kind: ExtInvokeKind, name: string, value: unknown, profileId: string | null): Promise<Json | undefined> {
    const contents = await this.#ensureWorker(entry);
    const id = this.#nextId++;
    const profile = profileId ?? this.#window?.browser.activeProfileId() ?? null;
    if (profile !== null) entry.scope.beginInvocation(id, profile);
    try {
      return await new Promise<Json | undefined>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.#pending.delete(id);
          const message = `the ${kind} handler "${name}" did not answer within ${String(EXT_HANDLER_TIMEOUTS[kind] / 1000)} s`;
          entry.status.runtimeError({ context: "worker", message: `TIMEOUT: ${message}`, at: Date.now() });
          this.#log(entry, { at: Date.now(), context: "main", level: "warn", message: `TIMEOUT: ${message}` });
          reject(new ExtError("TIMEOUT", message));
        }, EXT_HANDLER_TIMEOUTS[kind]);
        timer.unref();
        this.#pending.set(id, { extensionId: entry.id, resolve, reject, timer, expect: 1, answered: 0 });
        const message: ExtEventMessage = { kind: "invoke", id, invoke: kind, name, v: value };
        contents.send(EXT_EVENT_CHANNEL, message);
      });
    } finally {
      entry.scope.endInvocation(id);
    }
  }

  #done(ctx: CallContext, id: number, value: Json | undefined, error: string | undefined): void {
    const pending = this.#pending.get(id);
    if (pending === undefined || pending.extensionId !== ctx.extensionId) return;
    pending.answered += 1;
    if (error !== undefined) {
      const entry = this.#entries.get(ctx.extensionId);
      if (entry !== undefined) entry.status.runtimeError({ context: ctx.context, message: error, at: Date.now() });
      if (pending.expect === 1) {
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        pending.reject(new Error(error));
        return;
      }
    }
    if (value !== undefined || pending.answered >= pending.expect) {
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.resolve(value);
    }
  }

  /** Profile of a tab, else the Profile in front. */
  #profileOf(tabId: string | null): string | null {
    const browser = this.#window?.browser;
    if (browser === undefined) return null;
    const tab = tabId === null ? null : browser.tab(tabId);
    return tab?.spaceId ?? browser.activeProfileId();
  }

  /** The space (tab group) a tab is in, or the current space. */
  #spaceOf(tabId: string | null): string | null {
    const browser = this.#window?.browser;
    if (browser === undefined) return null;
    const profile = this.#profileOf(tabId);
    if (profile === null) return null;
    if (tabId !== null) {
      const group = browser.spaces(profile).find((candidate) => candidate.tabIds.includes(tabId));
      if (group !== undefined) return group.id;
    }
    return browser.currentSpaceId(profile);
  }

  /* ------------------------------ the runtime ------------------------------ */

  #runtimeFor(entry: Entry): ExtensionRuntime {
    const manifest = (): PistachioManifest => {
      const loaded = entry.loaded;
      if (loaded === null) throw new ExtError("UNAVAILABLE", "this extension is not loaded");
      return loaded.manifest;
    };
    return {
      manifest,
      info: (ctx) => ({ id: entry.id, manifest: manifest() as unknown as Json, context: ctx.context, page: ctx.page, timeOrigin: performance.timeOrigin }),
      storage: entry.storage,
      data: entry.data,
      storageChanged: (changes) => this.#deliverAll(entry, "storage.changed", { changes: changes as unknown as Json }),
      storedSettings: () => {
        const secrets = new Set((manifest().settings ?? []).filter((setting) => setting.type === "secret").map((setting) => setting.key));
        return this.#registry.settingsOf(entry.id, secrets);
      },
      sendMessage: (ctx, message) => this.#sendMessage(entry, ctx, message),
      connect: (ctx, name, target) => this.#connect(entry, ctx, name, target),
      keepAlive: (ctx, reason) => {
        const id = this.#nextId++;
        entry.holds.set(id, { reason, owner: ctx.senderId });
        entry.worker?.touch();
        return id;
      },
      release: (holdId) => {
        entry.holds.delete(holdId);
        entry.worker?.touch();
      },
      done: (ctx, id, value, error) => this.#done(ctx, id, value, error),
      log: (ctx, level, message, data) => {
        this.#log(entry, { at: Date.now(), context: ctx.context, level, message, ...(data === undefined ? {} : { data }) });
        // A tool's `ctx.progress(text)` (the runtime sends it as a log line marked with its run): the step's detail line.
        const marked = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, Json>) : null;
        if (ctx.context === "worker" && marked?.["progress"] === true && typeof marked["runId"] === "string") this.#toolProgress.get(`${entry.id}\n${marked["runId"]}`)?.(message);
      },
      openPanel: (ctx) => this.#openPanelFor(entry, null, ctx),
      closePanel: () => {
        if (this.#openPanel === entry.id) this.#closePanel();
      },
      openPage: (_ctx, name, query, place) => this.#openPage(entry, name, query, place),
      toast: (toast) => {
        // The notice stack's one line, its action the card's button (an `extensions` statusAction, source "toast").
        const text = `${manifest().name}: ${toast.title}${toast.body === undefined ? "" : ` — ${toast.body}`}`;
        const message = text.length > NOTICE_MESSAGE_MAX ? `${text.slice(0, NOTICE_MESSAGE_MAX - 1)}…` : text;
        if (toast.action !== undefined) entry.toastActions = [...entry.toastActions.filter((id) => id !== toast.action!.id), toast.action.id].slice(-TOAST_ACTIONS_KEPT);
        if (this.#window === null) return;
        this.#window.shell({ type: "extensionToast", id: entry.id, message, action: toast.action ?? null });
      },
      setBadge: (text) => {
        entry.badge = text;
        this.#publish();
      },
      setStatus: (status) => {
        entry.statusPill = status;
        this.#publish();
      },
      preferredSize: (ctx, _width, height) => {
        if (ctx.context !== "panel" || this.#openPanel !== entry.id) return;
        this.#window?.panel.setPreferredHeight(height);
      },
      pick: async (options) => {
        const parts = this.#window;
        const extensions = (options.accept ?? []).flatMap((accept) => {
          if (accept.startsWith(".")) return [accept.slice(1)];
          if (accept === "image/*") return ["png", "jpg", "jpeg", "gif", "webp", "svg", "heic"];
          if (accept === "video/*") return ["mp4", "mov", "webm", "m4v"];
          if (accept === "audio/*") return ["mp3", "m4a", "wav", "aac", "ogg"];
          return [];
        });
        const dialogOptions: Electron.OpenDialogOptions = {
          properties: ["openFile", ...(options.multiple === true ? (["multiSelections"] as const) : [])],
          ...(extensions.length > 0 ? { filters: [{ name: "Files", extensions }] } : {}),
        };
        const result = parts === null || parts.window.isDestroyed() ? await dialog.showOpenDialog(dialogOptions) : await dialog.showOpenDialog(parts.window, dialogOptions);
        if (result.canceled) return [];
        for (const path of result.filePaths) this.#remember(entry, path);
        return result.filePaths;
      },
      save: async (bytes, dataPath, suggestedName, folder) => {
        const name = basename(suggestedName).replace(/[/\\:\0]/g, "-").trim() || "file";
        let target: string;
        if (folder === "ask") {
          const parts = this.#window;
          const options: Electron.SaveDialogOptions = { defaultPath: join(app.getPath("downloads"), name) };
          const result = parts === null || parts.window.isDestroyed() ? await dialog.showSaveDialog(options) : await dialog.showSaveDialog(parts.window, options);
          if (result.canceled || result.filePath === undefined || result.filePath === "") return null;
          target = result.filePath;
        } else {
          // (A new file under the next free name, taken exclusively: two exports finishing at once take two files.
          // Off the main thread either way: a recording's export is gigabytes, and a slow disk would hold the window.)
          const dir = folder === "downloads" ? app.getPath("downloads") : await this.#options.screenshotFolder();
          await mkdir(dir, { recursive: true });
          target = bytes !== null ? await saveBytesUnique(dir, name, bytes) : dataPath !== null ? await copyUnique(dir, name, dataPath) : await saveBytesUnique(dir, name, new Uint8Array());
          this.#remember(entry, target);
          return target;
        }
        // (The person named the file in the dialog, and so the file it replaces.)
        if (bytes !== null) await writeFile(target, bytes);
        else if (dataPath !== null) await copyFile(dataPath, target);
        this.#remember(entry, target);
        return target;
      },
      owned: (path) => {
        if (entry.owned.has(path)) return path;
        try {
          return entry.data.existing(path.startsWith(entry.data.root) ? path.slice(entry.data.root.length).replace(/^\/+/, "") : path);
        } catch {
          return null;
        }
      },
      reveal: (path) => shell.showItemInFolder(path),
      startDrag: (ctx, path) => {
        const contents = this.#views.get(ctx.senderId)?.contents;
        if (contents === undefined || contents.isDestroyed()) return;
        contents.startDrag({ file: path, icon: nativeImage.createFromDataURL(DRAG_ICON) });
      },
      clipboardWrite: (content) => {
        if (content.filePath !== undefined) {
          if (process.platform === "darwin") clipboard.writeBuffer("public.file-url", Buffer.from(pathToFileURL(content.filePath).href));
          else clipboard.writeText(content.filePath);
          return;
        }
        clipboard.write({
          ...(content.text === undefined ? {} : { text: content.text }),
          ...(content.html === undefined ? {} : { html: content.html }),
          ...(content.imagePng === undefined ? {} : { image: nativeImage.createFromBuffer(Buffer.from(content.imagePng)) }),
        });
      },
      clipboardReadText: () => clipboard.readText(),
      notify: (notification) => this.#notify(entry, notification),
      fetch: (url, init) => this.#fetch(entry, url, init),
      notes: () => this.#notesFor(entry),
      preventSleep: (ctx) => {
        const id = this.#nextId++;
        entry.sleep.set(id, { blocker: powerSaveBlocker.start("prevent-display-sleep"), owner: ctx.senderId });
        return id;
      },
      releaseSleep: (holdId) => {
        const hold = entry.sleep.get(holdId);
        if (hold === undefined) return;
        powerSaveBlocker.stop(hold.blocker);
        entry.sleep.delete(holdId);
      },
      subscribe: (ctx, event, filter) => {
        const id = this.#nextId++;
        entry.subscriptions.set(id, { id, senderId: ctx.senderId, event, filter });
        return id;
      },
      unsubscribe: (ctx, subscriptionId) => {
        const sub = entry.subscriptions.get(subscriptionId);
        if (sub !== undefined && sub.senderId === ctx.senderId) entry.subscriptions.delete(subscriptionId);
      },
      captureSources: (ctx, sources) => this.#captureSources(entry, ctx, sources),
      captureArm: (ctx, tabId, options) => this.#captureArm(entry, ctx, tabId, options),
      captureHold: (ctx, tabId) => this.#captures.hold(entry.id, tabId, ctx.senderId),
      captureRelease: (holdId) => this.#captures.release(entry.id, holdId),
      inputSubscribe: (ctx, tabId, kinds) => {
        const id = this.#nextId++;
        entry.inputs.set(id, ctx.senderId);
        this.#taps.subscribe({
          id,
          extensionId: entry.id,
          tabId,
          kinds: kinds === null ? null : new Set(kinds),
          deliver: (events) => {
            this.#send(ctx.senderId, { kind: "event", subscription: 0, e: "input.event", v: { subscriptionId: id, events } });
          },
        });
        this.#liveChanged();
        return id;
      },
      inputStop: (ctx, subscriptionId) => {
        if (entry.inputs.get(subscriptionId) === ctx.senderId) this.#stopInput(subscriptionId);
      },
      agentAsk: (prompt, place) => this.#agentAsk(entry, prompt, place),
    };
  }

  /* ------------------------- capture, input (S3) ------------------------- */

  /** Whether an extension may record a tab now: on, the tab one it may see, a web page. */
  #capturable(extensionId: string, tabId: string): boolean {
    const entry = this.#entries.get(extensionId);
    if (entry === undefined || !this.#runnable(entry)) return false;
    try {
      const tab = entry.scope.visibleTab(tabId);
      return tab.extensionId === undefined && !isPrivateAddress(tab.url);
    } catch {
      return false;
    }
  }

  /**
   * The desk's capturable windows; from the open panel — the person's chooser — each with its still and each the
   * person's pick to make. From anywhere else (the worker, a page, the panel closed) a still only of a window the
   * person already granted or the extension records: a list of pictures of every window is a screenshot of the desk,
   * which `pages.screenshot` asks a grant for, and a chooser no one sees asks nothing.
   */
  async #captureSources(entry: Entry, ctx: { context: ExtContext }, sources: ExtCaptureSource[]): Promise<ExtCaptureSource[]> {
    const browser = this.#window?.browser;
    if (browser === undefined) return [];
    const chooser = panelIsChooser({ context: ctx.context, extensionId: entry.id, openPanel: this.#openPanel, byPerson: this.#panelByPerson, shown: this.#window?.panel.shown() ?? false });
    if (chooser) entry.scope.grantListed(sources.map((source) => source.tabId));
    const recorded = this.#captures.capturing(entry.id);
    const pictured = picturedSources(sources, chooser, (tabId) => entry.scope.hasGesture(tabId) || recorded.includes(tabId));
    let timer: NodeJS.Timeout | undefined;
    const stills =
      pictured.length === 0
        ? []
        : await Promise.race([
            browser.stills(
              pictured.map((source) => source.tabId),
              SOURCE_STILL_WIDTH,
            ),
            new Promise<[]>((resolve) => (timer = setTimeout(() => resolve([]), SOURCE_STILL_WAIT_MS))),
          ])
            .catch(() => [])
            .finally(() => clearTimeout(timer));
    // (Once the pictures came: still the caller's to see — the chooser still open, the grant still on the tab or it
    // still recorded — and the tab still on the site that was listed; a tab that went elsewhere meanwhile shows nothing.)
    const stillChooser = panelIsChooser({ context: ctx.context, extensionId: entry.id, openPanel: this.#openPanel, byPerson: this.#panelByPerson, shown: this.#window?.panel.shown() ?? false });
    const byTab = keepStills(
      pictured,
      new Map(stills.map((still) => [still.tabId, still.dataUrl])),
      (source) => stillChooser || entry.scope.hasGesture(source.tabId) || this.#captures.capturing(entry.id).includes(source.tabId),
      (tabId) => browser.tab(tabId)?.url ?? null,
    );
    return sources.map((source) => ({ ...source, still: byTab.get(source.tabId) ?? null }));
  }

  /**
   * capture.tab's first half: the worker's session armed for one getDisplayMedia of the tab (from the worker's own
   * frame, within ARM_MS), the tab woken and laid out, and the size to ask for — the view's size × `scale`, the
   * longest side at most MAX_CAPTURE_SIDE, even numbers (what the encoders take).
   */
  async #captureArm(entry: Entry, ctx: { senderId: number }, tabId: string, options: { audio: boolean; scale: 1 | 2 }): Promise<{ width: number; height: number }> {
    const worker = entry.worker?.contents ?? null;
    const browser = this.#window?.browser;
    if (worker === null || worker.id !== ctx.senderId) throw new ExtError("INVALID_ARGUMENT", "capture.tab works in the worker");
    if (browser === undefined) throw new ExtError("UNAVAILABLE", "the browser window is not open");
    // (One capture starting at a time: a second arm would take the first's getDisplayMedia, and hand A's call B's stream.)
    if (this.#captures.ending(entry.id, tabId)) {
      // A capture of the tab is ending: over already if the worker holds no track of it (a stop and a fresh start, the
      // Recorder's way) — looked at now, not at the next tick — and still ending, its deadline kept, if it does.
      await this.#captures.check();
      if (this.#captures.ending(entry.id, tabId)) throw new ExtError("UNAVAILABLE", "capture.tab: the capture of this tab was stopped and is ending; it can be captured again once its tracks have ended");
    }
    if (!this.#captures.arm({ extensionId: entry.id, tabId, audio: options.audio, contentsId: worker.id, frame: worker.mainFrame })) {
      throw new ExtError("RATE_LIMITED", "capture.tab: a capture is already starting; wait for it before starting another");
    }
    let awake = false;
    try {
      awake = await browser.wakeTab(tabId);
    } catch {
      awake = false;
    }
    if (!awake) {
      this.#captures.disarm(entry.id);
      throw new ExtError("UNAVAILABLE", "capture.tab: that window's page could not be woken");
    }
    return captureSize(browser.captureSize(tabId) ?? { width: 1280, height: 800 }, options.scale);
  }

  /** The sources of the display tracks the extension's worker holds live, by the guard in its page (CaptureHost.liveTracks). */
  async #liveTracks(extensionId: string): Promise<string[] | null> {
    const contents = this.#entries.get(extensionId)?.worker?.contents ?? null;
    if (contents === null || contents.isDestroyed()) return [];
    // A worker that made a frame has another realm's clone within reach, past the guard: its answer is no answer (taken
    // as holding), and the person's Stop ends in the kill that no realm survives.
    if (this.#views.get(contents.id)?.framed === true) return null;
    let timer: NodeJS.Timeout | undefined;
    try {
      const answer: unknown = await Promise.race([
        // (The preload's world, not the page's: a script there may rebind `globalThis` or shadow the guard's name.)
        contents.executeJavaScriptInIsolatedWorld(EXT_ISOLATED_WORLD, [{ code: `globalThis[${JSON.stringify(EXT_GUARD_KEY)}].live()` }]),
        new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), LIVE_TRACKS_WAIT_MS))),
      ]);
      return Array.isArray(answer) && answer.every((source) => typeof source === "string") ? (answer as string[]) : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** A capture ended: the worker's runtime ends its tracks (`capture.ended`), and anyone subscribed hears it. */
  #captureEnded(extensionId: string, tabId: string, reason: CaptureEndReason): void {
    const entry = this.#entries.get(extensionId);
    if (entry === undefined) return;
    const value = { tabId, reason };
    const worker = entry.worker?.contents ?? null;
    if (worker !== null && ![...entry.subscriptions.values()].some((sub) => sub.event === "capture.ended" && sub.senderId === worker.id)) {
      this.#send(worker.id, { kind: "event", subscription: 0, e: "capture.ended", v: value });
    }
    this.#deliver(entry, "capture.ended", value);
    this.#log(entry, { at: Date.now(), context: "main", level: "info", message: `capture of ${tabId} ended (${reason})` });
  }

  /**
   * A capture still running CAPTURE_END_GRACE_MS after `capture.ended` was sent (the person's Stop, an address it may
   * not see): the extension's own runtime was to stop the tracks and did not — or a stream taken with the raw wire was
   * in no map of its. "end": main stops the worker's tracks itself, through the guard the preload set in its world
   * (`__pistachioEndCaptures`, which no script of the page can replace); "kill", CAPTURE_KILL_GRACE_MS later with the
   * page still captured: its renderer is killed (web-worker.ts `kill`) — the extension's pages share the process and
   * die with it; reloaded, they come back. Each said in its log; the kill as an error.
   */
  #captureEnforced(extensionId: string, tabId: string, how: "end" | "kill", key: string | null): void {
    const entry = this.#entries.get(extensionId);
    if (entry === undefined) return;
    if (how === "end") {
      this.#log(entry, { at: Date.now(), context: "main", level: "warn", message: `the capture of ${tabId} went on ${String(CAPTURE_END_GRACE_MS / 1000)} s after it was told to end: its streams were ended from main` });
      const contents = entry.worker?.contents ?? null;
      // (That source's tracks alone: another capture of the worker's goes on.)
      if (contents !== null && !contents.isDestroyed())
        void contents.executeJavaScriptInIsolatedWorld(EXT_ISOLATED_WORLD, [{ code: `globalThis[${JSON.stringify(EXT_GUARD_KEY)}].end(${JSON.stringify(key)})` }]).catch(() => undefined);
      return;
    }
    const message = `the capture of ${tabId} went on ${String(CAPTURE_KILL_GRACE_MS / 1000)} s after main ended its streams, or its worker gave no answer: its worker was killed`;
    this.#log(entry, { at: Date.now(), context: "main", level: "error", message });
    entry.status.runtimeError({ context: "worker", message, at: Date.now() });
    entry.worker?.kill();
    this.#reloadViews(entry);
  }

  #stopInput(subscriptionId: number): void {
    const subscriber = this.#taps.stop(subscriptionId);
    if (subscriber !== null) this.#inputEnded(subscriber);
  }

  #inputEnded(subscriber: InputSubscriber): void {
    this.#entries.get(subscriber.extensionId)?.inputs.delete(subscriber.id);
    this.#liveChanged();
  }

  /** Whether an extension captures a window or watches input now (its pill says so). */
  #recording(entry: Entry): boolean {
    return this.#liveTabs(entry).length > 0;
  }

  #liveOf(entry: Entry): { capturing: boolean; watching: boolean } {
    return { capturing: this.#captures.capturing(entry.id).length > 0, watching: entry.inputs.size > 0 };
  }

  /** The tabs an extension captures or watches now (`captures` in the snapshot: the shell marks them). */
  #liveTabs(entry: Entry): string[] {
    const watched = this.#taps.subscribers().filter((subscriber) => subscriber.extensionId === entry.id).map((subscriber) => subscriber.tabId);
    return [...new Set([...this.#captures.capturing(entry.id), ...watched])];
  }

  /** Every capture and input subscription of an extension ended (the person's Stop, the window closing, its worker gone); `forget` its holds too. */
  #stopRecording(entry: Entry, reason: CaptureEndReason, forget = false): void {
    if (forget) this.#captures.forget(entry.id, reason);
    else this.#captures.end(entry.id, reason);
    for (const id of [...entry.inputs.keys()]) this.#stopInput(id);
  }

  /** What is recorded changed: each scope hears what it records, and the snapshot (pill, `captures`) goes out. */
  #liveChanged(): void {
    const parts: string[] = [];
    for (const entry of this.#entries.values()) {
      const live = this.#liveTabs(entry);
      entry.scope.noteLive(live);
      parts.push(`${entry.id}:${live.join(",")}:${String(this.#liveOf(entry).capturing)}`);
    }
    const key = parts.join("|");
    if (key === this.#liveKey) return;
    this.#liveKey = key;
    this.#publish();
  }

  /** agent.ask: the space's Bar holds the prompt for the person to send (the space made current first). */
  async #agentAsk(entry: Entry, prompt: string, place: { profileId: string; space: string }): Promise<void> {
    const parts = this.#window;
    if (parts === null) throw new ExtError("UNAVAILABLE", "the browser window is not open");
    if (place.profileId !== parts.browser.activeProfileId()) throw new ExtError("UNAVAILABLE", "agent.ask fills the Bar of the Profile in front");
    if (place.space !== "current" && place.space !== "new" && place.space !== parts.browser.currentSpaceId(place.profileId)) await parts.browser.selectSpace(place.space);
    parts.shell({ type: "askDesk", text: prompt, via: entry.loaded?.manifest.name ?? entry.id });
  }

  /** Every runnable extension's declared keys, bound in the person's order (./keys.ts), kept until something changes. */
  #keyBindings(): KeyBinding[] {
    if (this.#keys !== null) return this.#keys;
    const extensions = this.#ordered()
      .filter((entry) => this.#runnable(entry))
      .map((entry) => ({ id: entry.id, name: entry.loaded!.manifest.name, commands: entry.loaded!.manifest.commands ?? [] }));
    this.#keys = keyBindings(extensions, this.#options.shortcuts?.() ?? DEFAULT_SHORTCUTS);
    return this.#keys;
  }

  #notesFor(entry: Entry): ExtensionNotesHost | null {
    const store = this.#options.notes();
    if (store === null) return null;
    // An extension's writes are no keystroke of the person's: credited to it, as a run's are to the run.
    const source = { kind: "agent" as const, runId: `extension:${entry.id}` };
    return {
      list: () => store.list(),
      search: (query, limit) => store.search(query, limit),
      get: (id) => {
        const note = store.get(id);
        return note === null ? null : { id: note.id, title: note.title, markdown: note.markdown };
      },
      create: (input) => ({ id: store.create({ title: input.title, markdown: input.markdown }, source).id }),
      edit: (id, edit) => {
        store.edit(id, edit, null, source);
      },
    };
  }

  #notify(entry: Entry, notification: { title: string; body?: string; action?: { id: string; title: string } }): void {
    if (!Notification.isSupported()) return;
    const shown = new Notification({
      title: notification.title,
      subtitle: entry.loaded?.manifest.name ?? entry.id,
      ...(notification.body === undefined ? {} : { body: notification.body }),
      ...(notification.action === undefined ? {} : { actions: [{ type: "button" as const, text: notification.action.title }] }),
    });
    this.#notifications.add(shown);
    const forget = (): void => void this.#notifications.delete(shown);
    shown.on("close", forget);
    shown.on("action", () => {
      forget();
      if (notification.action === undefined || !this.#runnable(entry)) return;
      void this.#invoke(entry, "statusAction", notification.action.id, { action: notification.action.id, source: "notification" }, null).catch(() => undefined);
    });
    shown.show();
  }

  async #fetch(entry: Entry, url: string, init: { method: string; headers: Record<string, string>; body: Uint8Array | string | null }): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }> {
    const ses = this.#netSession(entry);
    let response: Response;
    try {
      response = await ses.fetch(url, {
        method: init.method,
        headers: init.headers,
        ...(init.body === null || init.method === "GET" || init.method === "HEAD" ? {} : { body: typeof init.body === "string" ? init.body : Buffer.from(init.body) }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof Error && /ERR_BLOCKED_BY_CLIENT/.test(error.message)) throw new ExtError("PERMISSION_DENIED", "net.fetch went (or was redirected) to a host pistachio.json → hosts does not name");
      throw error;
    }
    const length = Number(response.headers.get("content-length") ?? "0");
    if (length > MAX_FETCH_BYTES) throw new ExtError("UNAVAILABLE", "net.fetch answers at most 50 MB");
    // (Read as it comes: a Content-Length is a claim, and a body read whole would sit in memory before it was measured.)
    const body = await readBodyAtMost(response.body, MAX_FETCH_BYTES);
    if (body === null) throw new ExtError("UNAVAILABLE", "net.fetch answers at most 50 MB");
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return { status: response.status, headers, body };
  }

  /* ------------------------------ events ------------------------------ */

  #send(contentsId: number, message: ExtEventMessage, ports?: Electron.MessagePortMain[]): boolean {
    const identity = this.#views.get(contentsId);
    const contents = identity?.contents;
    if (contents === undefined || contents.isDestroyed()) return false;
    if (ports === undefined) contents.send(EXT_EVENT_CHANNEL, message);
    else contents.postMessage(EXT_EVENT_CHANNEL, message, ports);
    return true;
  }

  #deliver(entry: Entry, event: ExtEvent, value: Json | Record<string, unknown>, only?: (sub: Subscription) => boolean): void {
    for (const sub of entry.subscriptions.values()) {
      if (sub.event !== event || (only !== undefined && !only(sub)) || !passesFilter(sub.filter, value)) continue;
      this.#send(sub.senderId, { kind: "event", subscription: sub.id, e: event, v: value });
    }
  }

  #deliverAll(entry: Entry, event: ExtEvent, value: Json): void {
    this.#deliver(entry, event, value);
  }

  #tabEvent(entry: Entry, event: ExtEvent, tab: BrowserTabInfo, value: (described: Json) => Record<string, unknown>): void {
    let described: Json | null = null;
    try {
      described = entry.scope.describeTab(tab) as unknown as Json | null;
    } catch {
      described = null;
    }
    if (described === null) return;
    this.#deliver(entry, event, value(described));
  }

  /* --------------------------- messages, ports --------------------------- */

  async #sendMessage(entry: Entry, ctx: CallContext, message: Json): Promise<Json | undefined> {
    if (ctx.context !== "worker") return this.#invoke(entry, "message", "message", { message, from: ctx.context }, null);
    // From the worker: every page and the panel listening, one copy each (its runtime runs every listener on one), the
    // first answer with a value.
    const targets = [...this.#views.of(entry.id, "page"), ...this.#views.of(entry.id, "panel")].flatMap((view) => {
      const sub = [...entry.subscriptions.values()].find((candidate) => candidate.event === "runtime.message" && candidate.senderId === view.contents.id);
      return sub === undefined ? [] : [sub];
    });
    if (targets.length === 0) return undefined;
    const id = this.#nextId++;
    return new Promise<Json | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        resolve(undefined);
      }, EXT_HANDLER_TIMEOUTS.message);
      timer.unref();
      // (A page's handler that failed is no answer: the next one may have one.)
      this.#pending.set(id, { extensionId: entry.id, resolve, reject: () => resolve(undefined), timer, expect: targets.length, answered: 0 });
      for (const sub of targets) this.#send(sub.senderId, { kind: "event", subscription: sub.id, e: "runtime.message", v: { message, from: "worker", replyId: id } });
    });
  }

  async #connect(entry: Entry, ctx: CallContext, name: string, target: "worker" | { page: string }): Promise<{ portId: number }> {
    let targetContents: WebContents;
    let targetContext: ExtContext;
    if (target === "worker") {
      if (ctx.context === "worker") throw new ExtError("INVALID_ARGUMENT", "the worker connects to a page by its name");
      targetContents = await this.#ensureWorker(entry);
      targetContext = "worker";
    } else {
      const view = this.#views.of(entry.id).find((candidate) => {
        if (candidate.context === "panel") return target.page === "panel";
        if (candidate.context !== "page") return false;
        let url = "";
        try {
          url = candidate.contents.getURL();
        } catch {
          url = "";
        }
        return pageNameOf(entry.loaded?.manifest.pages, entry.id, url) === target.page;
      });
      if (view === undefined) throw new ExtError("NOT_FOUND", `no page "${target.page}" of this extension is open`);
      targetContents = view.contents;
      targetContext = view.context;
    }
    const portId = this.#nextId++;
    const { port1, port2 } = new MessageChannelMain();
    const subOf = (contentsId: number): number => [...entry.subscriptions.values()].find((sub) => sub.event === "runtime.connect" && sub.senderId === contentsId)?.id ?? 0;
    // The caller's end first (it matches it to the portId the call answers), then the target's.
    this.#send(ctx.senderId, { kind: "event", subscription: subOf(ctx.senderId), e: "runtime.connect", v: { portId, name, from: targetContext } }, [port1]);
    if (!targetContents.isDestroyed()) {
      targetContents.postMessage(EXT_EVENT_CHANNEL, { kind: "event", subscription: subOf(targetContents.id), e: "runtime.connect", v: { portId, name, from: ctx.context } } satisfies ExtEventMessage, [port2]);
    }
    return { portId };
  }

  /* ------------------------------ ui ------------------------------ */

  /** `ctx` null: the person opened it (the shell's activate — the icon, a key, the Bar); else the extension's own `ui.openPanel`. */
  #openPanelFor(entry: Entry, tabId: string | null, ctx: CallContext | null): void {
    const parts = this.#window;
    const panel = entry.loaded?.manifest.panel;
    if (parts === null || panel === undefined) throw new ExtError("UNAVAILABLE", "the window is not open");
    this.#prepareSession(entry.id);
    if (tabId !== null) entry.scope.grantTab(tabId);
    // Another extension's panel gives way: what its source list granted goes with it, as a close takes it.
    if (this.#openPanel !== null && this.#openPanel !== entry.id) this.#entries.get(this.#openPanel)?.scope.panelClosed();
    this.#openPanel = entry.id;
    // Opened by the worker on its own — no press, no key, no invocation of the extension's within the gesture window — the
    // panel is no chooser: its capture.sources lists the windows but grants none (what no one asked to see picks nothing).
    this.#panelByPerson = ctx === null || entry.scope.recentGesture();
    parts.panel.open(entry.id, `${extensionOrigin(entry.id)}${panel.file.split("/").map(encodeURIComponent).join("/")}`, extensionPartition(entry.id), this.#options.preload);
    this.#publish();
  }

  #closePanel(): void {
    if (this.#openPanel === null) return;
    // What its source list granted goes with it (a capture it started goes on).
    this.#entries.get(this.#openPanel)?.scope.panelClosed();
    this.#openPanel = null;
    this.#panelByPerson = false;
    this.#window?.panel.close();
    this.#publish();
  }

  async #openPage(entry: Entry, name: string, query: string | undefined, place: { profileId: string; space: string }): Promise<string> {
    const browser = this.#window?.browser;
    const page = entry.loaded?.manifest.pages?.[name];
    if (browser === undefined) throw new ExtError("UNAVAILABLE", "the window is not open");
    if (page === undefined) throw new ExtError("NOT_FOUND", `no page "${name}"`);
    this.#prepareSession(entry.id);
    const base = `${extensionOrigin(entry.id)}${page.file.split("/").map(encodeURIComponent).join("/")}`;
    if (page.singleton === true) {
      const open = browser.tabs().find((tab) => tab.extensionId === entry.id && (tab.url === base || tab.url.startsWith(`${base}?`) || tab.url.startsWith(`${base}#`)));
      if (open !== undefined) {
        await browser.showTab(open.id);
        return open.id;
      }
    }
    const url = query === undefined || query === "" ? base : `${base}?${query.replace(/^\?/, "")}`;
    return browser.createTab(url, { profileId: place.profileId, space: place.space, activate: true });
  }

  async #activate(id: string, tabId: string | null, anchor: ContentBounds | null): Promise<void> {
    const record = this.#registry.get(id);
    if (record === null) {
      // The library: turning one on starts with its sheet.
      if (this.#bundled.has(id)) {
        this.#setEnabled(id, true, "all");
        return;
      }
      throw new Error("There is no such extension.");
    }
    // A Chrome action: its popup at the icon (the shell's rect, window coordinates), or `action.onClicked`.
    if (record.kind === "chrome") {
      await this.#chrome.activate(id, tabId, anchor);
      return;
    }
    const entry = this.#requireRunnable(id);
    const manifest = entry.loaded!.manifest;
    // Off in the Profile in front: its icon is dim there, and a click on it runs nothing (the keys refuse the same).
    const profileId = this.#window?.browser.activeProfileId() ?? null;
    if (profileId !== null && !entry.scope.onIn(profileId)) throw new Error(`${manifest.name} is off in this Profile.`);
    if (manifest.panel !== undefined) {
      if (this.#openPanel === id) this.#closePanel();
      else this.#openPanelFor(entry, tabId, null);
      return;
    }
    if (manifest.action === true) {
      entry.scope.grantTab(tabId);
      await this.#invokeForShell(entry, "action", "action", { tabId, spaceId: this.#spaceOf(tabId) }, this.#profileOf(tabId));
    }
  }

  async #barCommand(id: string, command: string, arg: string, spaceId: string | null, tabId: string | null, selection: string | null): Promise<void> {
    const entry = this.#requireRunnable(id);
    const manifest = entry.loaded!.manifest;
    const declared = manifest.bar?.commands.find((candidate) => candidate.name === command);
    if (declared === undefined) throw new Error(`${manifest.name} has no /${command}.`);
    if (declared.arg?.required === true && arg.trim() === "") throw new Error(`/${command} needs ${declared.arg.hint}.`);
    entry.scope.grantTab(tabId);
    if ("prompt" in declared.run) {
      // A prompt command is a request to the agent (docs/extensions.md §2): that wiring is a later stage.
      this.#log(entry, { at: Date.now(), context: "main", level: "info", message: `/${command} is a prompt for the agent, which extensions reach in a later stage` });
      this.#window?.notice(`/${command} asks the agent, which extensions reach in a later stage.`);
      return;
    }
    const result = await this.#invokeForShell(entry, "bar", command, { arg, spaceId: spaceId ?? this.#spaceOf(tabId), tabId, selection }, this.#profileOf(tabId));
    if (typeof result === "object" && result !== null && !Array.isArray(result)) {
      const answer = result as Record<string, Json>;
      if (typeof answer["openPage"] === "string") {
        await this.#openPage(entry, answer["openPage"], typeof answer["query"] === "string" ? answer["query"] : undefined, entry.scope.pagePlace(undefined));
      } else if (typeof answer["prompt"] === "string") {
        this.#window?.notice(`/${command} asks the agent, which extensions reach in a later stage.`);
      }
    }
  }

  async #menu(id: string, item: string, click: { tabId: string | null; pageUrl: string | null; linkUrl?: string; selectionText?: string; srcUrl?: string; windowTabId?: string }): Promise<void> {
    const entry = this.#requireRunnable(id);
    const manifest = entry.loaded!.manifest;
    if (!(manifest.contextMenus ?? []).some((candidate) => candidate.id === item)) throw new Error(`${manifest.name} has no menu item "${item}".`);
    const tabId = click.windowTabId ?? click.tabId;
    entry.scope.grantTab(tabId);
    await this.#invokeForShell(entry, "menu", item, { ...click }, this.#profileOf(tabId));
  }

  /** An invocation the shell asked for: its failure is a sentence the shell can show. */
  async #invokeForShell(entry: Entry, kind: ExtInvokeKind, name: string, value: unknown, profileId: string | null): Promise<Json | undefined> {
    try {
      return await this.#invoke(entry, kind, name, value, profileId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#log(entry, { at: Date.now(), context: "main", level: "error", message: `${kind} ${name}: ${message}` });
      throw new Error(`${entry.loaded?.manifest.name ?? entry.id}: ${message}`);
    }
  }

  /* ---------------------------- approval, life ---------------------------- */

  #approve(id: string, manifestHash: string, agentAllowed: boolean | undefined): void {
    const record = this.#requireRecord(id);
    const entry = this.#requireEntry(id);
    const manifest = entry.loaded?.manifest;
    if (manifest === undefined) throw new Error(entry.failure?.error ?? "That extension could not be loaded.");
    const sheet = sheetFor(manifest);
    if (sheet.manifestHash !== manifestHash) throw new Error("The extension changed since this sheet was shown. Look it over again.");
    // The agent's draft (docs/extensions.md §8): not while it is still being written, nor before what it last wrote
    // was read — the sheet names the manifest, and the code beside it must be the code that loaded.
    if (entry.root !== null && this.#drafting.has(entry.root)) throw new Error("Pistachio is still writing it. Look it over once it's done.");
    if (entry.root !== null && (this.#agentWrittenAt.get(entry.root) ?? 0) >= (this.#loadedAt.get(id) ?? 0)) {
      throw new Error("The extension changed since this sheet was shown. Look it over again.");
    }
    const asks = manifestAsks(manifest);
    const first = record.grants === null;
    const hasTools = (manifest.tools?.length ?? 0) > 0;
    this.#registry.update(id, {
      grants: { capabilities: asks.capabilities, hosts: asks.hosts, manifestHash, at: Date.now() },
      pending: null,
      enabled: true,
      pinned: true,
      agentAllowed: hasTools && (agentAllowed ?? (first ? true : record.agentAllowed)),
    });
    entry.error = null;
    entry.status.clearRuntimeErrors();
    this.#publish();
    if (manifest.worker !== undefined) {
      void this.#invoke(entry, "installed", "installed", { reason: first ? "install" : "update" }, null).catch((error: unknown) =>
        this.#log(entry, { at: Date.now(), context: "main", level: "warn", message: `onInstalled: ${error instanceof Error ? error.message : String(error)}` }),
      );
    }
    this.#reloadViews(entry);
  }

  /** The sheet's *Not now*: nothing changes — a never-approved extension stays waiting on approval, a paused one stays paused. */
  #deny(id: string): void {
    this.#requireRecord(id);
    this.#publish();
  }

  #setEnabled(id: string, enabled: boolean, scope: "all" | "here"): void {
    let record = this.#registry.get(id);
    if (record === null) {
      const bundled = this.#bundled.get(id);
      if (bundled === undefined || !enabled) throw new Error("There is no such extension.");
      if (!bundled.result.ok) throw new Error(bundled.result.error);
      // Nothing enables itself: the library's extension comes in waiting on its sheet.
      const fresh = this.#registry.fresh(id, "pistachio", { type: "bundled" });
      fresh.pending = this.#pendingOf(bundled.result.manifest, null);
      this.#registry.upsert(fresh);
      this.#mount(id, bundled.root, bundled.result);
      this.#publish();
      return;
    }
    const active = this.#window?.browser.activeProfileId() ?? null;
    if (scope === "here" && active !== null) {
      const all = this.#window?.browser.profileIds() ?? [];
      const current = record.profiles === "all" ? all : record.profiles;
      const profiles = enabled ? [...new Set([...current, active])] : current.filter((profile) => profile !== active);
      record = this.#registry.update(id, { profiles: all.every((profile) => profiles.includes(profile)) ? "all" : profiles, ...(enabled ? { enabled: true } : {}) })!;
    } else {
      record = this.#registry.update(id, { enabled, ...(enabled ? { profiles: "all" as const } : {}) })!;
    }
    if (record.kind === "chrome") {
      // Loaded or unloaded in each Profile session as it now says.
      void this.#chrome.sync().catch((error: unknown) => console.warn("[extensions] Chrome extensions could not follow a switch", error));
      this.#publish();
      return;
    }
    const entry = this.#entries.get(id);
    if (entry !== undefined && (!record.enabled || !this.#runnable(entry))) this.#stop(entry);
    if (entry !== undefined && this.#runnable(entry)) this.#reloadViews(entry);
    // Off in a Profile: what it watches or captures there ends now, not at the next tab change.
    this.#endForbidden();
    this.#publish();
  }

  /** Everything of an extension that runs, stopped (it was turned off, paused, removed). */
  #stop(entry: Entry): void {
    this.#stopRecording(entry, "off", true);
    entry.worker?.stop();
    // Its passing state goes with it: a pill, a badge or a toast's buttons of an extension that is off would say what is not so.
    entry.statusPill = null;
    entry.badge = null;
    entry.toastActions = [];
    if (this.#openPanel === entry.id) this.#closePanel();
    for (const hold of entry.sleep.values()) powerSaveBlocker.stop(hold.blocker);
    entry.sleep.clear();
    entry.holds.clear();
    void entry.data.closeAll();
    this.#reloadViews(entry);
  }

  /**
   * Every page and the panel reloaded, their query intact (§4 "Hot reload"): from main, so a page showing "This
   * extension is off" — no API, nothing listening — comes back too.
   */
  #reloadViews(entry: Entry): void {
    for (const view of [...this.#views.of(entry.id, "page"), ...this.#views.of(entry.id, "panel")]) {
      if (!view.contents.isDestroyed()) view.contents.reload();
    }
  }

  async #uninstall(id: string): Promise<void> {
    const record = this.#requireRecord(id);
    if (record.source.type === "bundled") throw new Error("Pistachio's own extensions can be turned off, not removed.");
    // Out of every Profile session, its download and its storage gone (an unpacked folder is the person's own).
    if (record.kind === "chrome") {
      await this.#chrome.uninstall(id);
      return;
    }
    if (record.source.type === "dev" || record.source.type === "unpacked") {
      this.#removed.add(record.source.path);
      if (!this.#inDevFolder(record.source.path)) this.#watcher.unwatch(record.source.path);
    }
    // Its pages close with it.
    const browser = this.#window?.browser;
    if (browser !== undefined) for (const tab of browser.tabs()) if (tab.extensionId === id) void browser.closeTab(tab.id).catch(() => undefined);
    this.#forget(id, { data: true });
  }

  #forget(id: string, options: { data: boolean }): void {
    const entry = this.#entries.get(id);
    if (entry !== undefined) {
      this.#stop(entry);
      entry.worker?.dispose();
      entry.storage.flush();
      this.#entries.delete(id);
    }
    this.#registry.remove(id);
    if (options.data) {
      // Its data, its partitions' storage, its ledger: gone with it (the person confirmed in the shell).
      try {
        rmSync(extensionDataDir(this.#options.userDataDir, id), { recursive: true, force: true });
      } catch (error) {
        console.error("[extensions] could not remove the data of", id, error);
      }
      for (const partition of [extensionPartition(id), extensionNetPartition(id)]) {
        const ses = session.fromPartition(partition);
        void ses.clearStorageData().catch(() => undefined);
        void ses.clearCache().catch(() => undefined);
      }
    }
    this.#publish();
  }

  #setSetting(id: string, key: string, value: unknown): void {
    const entry = this.#requireEntry(id);
    const manifest = entry.loaded?.manifest;
    const setting = manifest?.settings?.find((candidate) => candidate.key === key);
    if (manifest === undefined || setting === undefined) throw new Error("That extension declares no such setting.");
    let clean: Json | undefined;
    switch (setting.type) {
      case "boolean":
        if (typeof value !== "boolean") throw new Error(`${setting.title} is on or off.`);
        clean = value;
        break;
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${setting.title} is a number.`);
        clean = Math.min(setting.max ?? Number.POSITIVE_INFINITY, Math.max(setting.min ?? Number.NEGATIVE_INFINITY, value));
        break;
      case "string":
        if (typeof value !== "string" || value.length > 2000) throw new Error(`${setting.title} is a line of text.`);
        clean = value;
        break;
      case "enum":
        if (typeof value !== "string" || !setting.options.includes(value)) throw new Error(`${setting.title} is one of ${setting.options.join(", ")}.`);
        clean = value;
        break;
      case "secret":
        if (value !== null && (typeof value !== "string" || value.length > 4000)) throw new Error(`${setting.title} is a line of text.`);
        clean = value === "" || value === null ? undefined : (value as string);
        if (clean !== undefined && !this.#secretsKept) throw new Error(`${setting.title} can't be kept: ${SECRETS_UNKEPT}`);
        break;
    }
    this.#registry.setSetting(id, key, clean, setting.type === "secret");
    // The worker hears every value; a page or the panel never hears a secret.
    const workerIds = new Set(this.#views.of(id, "worker").map((view) => view.contents.id));
    this.#deliver(entry, "settings.changed", { key, value: clean ?? null }, (sub) => setting.type !== "secret" || workerIds.has(sub.senderId));
    this.#publish();
  }

  #pendingOf(manifest: PistachioManifest, grants: ExtensionRecord["grants"]): ExtensionPending | null {
    const hash = sheetFor(manifest).manifestHash;
    if (grants === null) {
      const asks = manifestAsks(manifest);
      return { manifestHash: hash, widened: asks.capabilities, hosts: asks.hosts };
    }
    const widened = widenedAsks(grants, manifest);
    return widened.capabilities.length === 0 && widened.hosts.length === 0 ? null : { manifestHash: hash, widened: widened.capabilities, hosts: widened.hosts };
  }

  /**
   * Read the folder again (a file changed, *Reload*): re-validate; a manifest
   * that widened its asks pauses the extension until approved; otherwise the
   * worker restarts, every page and the panel reload, and `onInstalled`
   * hears `dev-reload` (or `update`). `seen` is a known folder seen again at
   * launch: refreshed quietly, nothing started.
   */
  #reload(id: string, why: "seen" | "reload" | "dev-reload"): void {
    const record = this.#registry.get(id);
    if (record === null) return;
    if (record.kind === "chrome") {
      void this.#chrome.reload(id).catch((error: unknown) => this.#window?.notice(error instanceof Error ? error.message : String(error)));
      return;
    }
    const root = this.#rootOf(record);
    if (record.source.type === "bundled" && root !== null) {
      const fresh = loadExtensionFolder(root);
      this.#bundled.set(id, { root, result: fresh });
    }
    const result = root === null ? null : this.#loadFor(record, root);
    const entry = this.#mount(id, root, result);
    entry.worker?.clearLoop();
    entry.error = null;
    if (result === null || !result.ok) {
      this.#stop(entry);
      this.#log(entry, { at: Date.now(), context: "main", level: "error", message: entry.failure?.error ?? "could not load" });
      this.#publish();
      return;
    }
    const manifest = result.manifest;
    const hash = sheetFor(manifest).manifestHash;
    if (record.grants === null) {
      this.#registry.update(id, { pending: this.#pendingOf(manifest, null) });
      this.#publish();
      return;
    }
    if (record.pending?.changedBy === "agent") {
      // The agent's writes wait for the person whatever they ask (markAgentChanged): the sheet names what loaded now.
      const widened = widenedAsks(record.grants, manifest);
      this.#registry.update(id, { pending: { manifestHash: hash, widened: widened.capabilities, hosts: widened.hosts, changedBy: "agent" } });
      this.#stop(entry);
      this.#publish();
      return;
    }
    const pending = this.#pendingOf(manifest, record.grants);
    if (pending !== null) {
      this.#registry.update(id, { pending });
      this.#stop(entry);
      // (The Ledge's amber dot says it; the shell offers the sheet.)
      this.#log(entry, { at: Date.now(), context: "main", level: "warn", message: `paused: it now asks for ${[...pending.widened, ...pending.hosts].join(", ")}` });
      this.#publish();
      return;
    }
    // Narrowed or the same: applied at once (the grant now names this manifest).
    this.#registry.update(id, { pending: null, grants: { ...record.grants, manifestHash: hash } });
    entry.status.clearRuntimeErrors();
    this.#publish();
    if (why === "seen" && record.grants.manifestHash === hash) return;
    const wasRunning = entry.worker?.running === true;
    entry.worker?.stop();
    if (!this.#runnable(entry)) return;
    this.#reloadViews(entry);
    const dev = record.source.type === "dev" || record.source.type === "unpacked";
    if (manifest.worker !== undefined && (wasRunning || why === "dev-reload")) {
      void this.#invoke(entry, "installed", "installed", { reason: dev ? "dev-reload" : "update" }, null).catch((error: unknown) =>
        this.#log(entry, { at: Date.now(), context: "main", level: "warn", message: `onInstalled: ${error instanceof Error ? error.message : String(error)}` }),
      );
    }
  }

  /* ------------------------------ the dev folder ------------------------------ */

  #devFolder(): string {
    return this.#options.settings().devFolder ?? join(this.#options.homeDir, "Pistachio", "Extensions");
  }

  #inDevFolder(path: string): boolean {
    return this.#watchingParent !== null && isWithin(this.#watchingParent, path) && path !== this.#watchingParent;
  }

  #apiDir(): string {
    return this.#options.isPackaged ? join(this.#options.resourcesPath, "extension-api") : join(this.#options.appPath, "..", "..", "packages", "extension-api");
  }

  #applyDeveloperMode(): void {
    const settings = this.#options.settings();
    const folder = this.#devFolder();
    if (!settings.developerMode) {
      if (this.#watchingParent !== null) this.#watcher.unwatch(this.#watchingParent);
      this.#watchingParent = null;
      this.#publish();
      return;
    }
    if (this.#watchingParent === folder) return;
    if (this.#watchingParent !== null) this.#watcher.unwatch(this.#watchingParent);
    try {
      const missing = writeGeneratedFiles(folder, this.#apiDir());
      if (missing.length > 0) console.warn(`[extensions] the dev folder's ${missing.join(", ")} are placeholders: not in packages/extension-api yet`);
    } catch (error) {
      console.error("[extensions] could not make the dev folder", folder, error);
      return;
    }
    this.#watchingParent = folder;
    this.#watcher.watchParent(folder);
    this.#publish();
  }

  #found(folder: string): void {
    if (this.#removed.has(folder)) return;
    const known = this.#registry.findByPath(folder);
    if (known !== null) {
      // A folder already registered, seen again (the watch starting): read again quietly.
      this.#reload(known.id, "seen");
      return;
    }
    this.#adopt(folder, { type: "dev", path: folder });
  }

  #changed(folder: string): void {
    if (this.#removed.delete(folder)) {
      this.#adopt(folder, { type: "dev", path: folder });
      return;
    }
    const known = this.#registry.findByPath(folder);
    if (known === null) {
      this.#adopt(folder, { type: "dev", path: folder });
      return;
    }
    this.#reload(known.id, "dev-reload");
  }

  #gone(folder: string): void {
    this.#orphans.delete(folder);
    const known = this.#registry.findByPath(folder);
    if (known === null || known.kind === "chrome") return;
    const entry = this.#mount(known.id, folder, null);
    this.#stop(entry);
    this.#publish();
  }

  /** A folder seen for the first time: registered, waiting on the person's approval. */
  #adopt(folder: string, source: ExtensionSource): string | null {
    const result = loadExtensionFolder(folder);
    const id = result.ok ? result.manifest.id : result.id;
    const orphan = (message: string, issues = result.ok ? [] : result.issues): null => {
      const status = this.#orphans.get(folder) ?? new StatusWriter(folder, id);
      this.#orphans.set(folder, status);
      status.update({ id, state: "error", manifestErrors: issues.length > 0 ? issues : [{ path: "", message }] });
      status.log({ at: Date.now(), context: "main", level: "error", message });
      return null;
    };
    if (id === null) return orphan(result.ok ? "pistachio.json has no id" : result.error);
    // A draft the agent is still writing (docs/extensions.md §8) is no extension until it loads: its status file says
    // what is missing, and the Ledge and the "New extension" notice wait for a folder that loads.
    if (!result.ok && this.#drafts.has(folder) && this.#registry.findByPath(folder) === null) return orphan(result.error);
    let claim = this.#registry.claim(id, source);
    if (!claim.ok) {
      // A dev folder that moved (renamed, its old place gone) is the same extension: its record follows it.
      const held = this.#registry.get(id);
      const moved = held !== null && (held.source.type === "dev" || held.source.type === "unpacked") && !existsSync(held.source.path) && !id.startsWith(RESERVED_ID_PREFIX);
      if (!moved) {
        this.#window?.notice(`An extension in ${basename(folder)} could not be added: its id is already taken.`);
        return orphan(claim.reason, [{ path: "id", message: claim.reason }]);
      }
      this.#registry.update(id, { source });
      claim = { ok: true, record: this.#registry.get(id) };
    }
    this.#orphans.delete(folder);
    // (The entry is made afresh: its status writer is the record's folder's.)
    this.#entries.get(id)?.worker?.dispose();
    this.#entries.delete(id);
    if (claim.record === null) {
      const record = this.#registry.fresh(id, "pistachio", source);
      record.pending = result.ok ? this.#pendingOf(result.manifest, null) : null;
      this.#registry.upsert(record);
      this.#mount(id, folder, result);
      // (The shell raises "New extension · Review" itself, from the snapshot.)
    } else {
      this.#reload(id, "dev-reload");
    }
    this.#publish();
    return id;
  }

  async #loadFolder(path: string | undefined): Promise<ExtensionResponse> {
    let folder = path;
    if (folder === undefined) {
      const parts = this.#window;
      const options: Electron.OpenDialogOptions = { title: "Load an extension's folder", properties: ["openDirectory"] };
      const result = parts === null || parts.window.isDestroyed() ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(parts.window, options);
      if (result.canceled || result.filePaths[0] === undefined) return { type: "ok" };
      folder = result.filePaths[0];
    }
    if (!existsSync(join(folder, "pistachio.json"))) {
      // A Chrome extension's folder: an unpacked Chrome extension, waiting on its sheet (docs/extensions.md §2).
      if (existsSync(join(folder, "manifest.json"))) return this.#chrome.loadUnpacked(folder);
      throw new Error("That folder has no pistachio.json (a Pistachio extension) or manifest.json (a Chrome extension).");
    }
    this.#removed.delete(folder);
    const known = this.#registry.findByPath(folder);
    if (known === null) {
      const id = this.#adopt(folder, { type: "dev", path: folder });
      if (id === null) throw new Error(this.#orphans.get(folder)?.status.manifestErrors[0]?.message ?? "That folder could not be loaded.");
    } else this.#reload(known.id, "reload");
    if (!this.#inDevFolder(folder)) this.#watcher.watchFolder(folder);
    return { type: "folder", path: folder };
  }

  #requireDevFolder(): string {
    const settings = this.#options.settings();
    if (!settings.developerMode) this.#options.setSettings({ developerMode: true, devFolder: settings.devFolder });
    this.#applyDeveloperMode();
    return this.#devFolder();
  }

  #newFolder(name: string, template: "panel" | "bar-command" | "agent-tool"): ExtensionResponse {
    const parent = this.#requireDevFolder();
    const slug = folderSlug(name);
    let folder = join(parent, slug);
    for (let n = 2; existsSync(folder); n += 1) folder = join(parent, `${slug}-${String(n)}`);
    const source = join(this.#apiDir(), "templates", template);
    if (existsSync(source) && statSync(source).isDirectory()) {
      cpSync(source, folder, { recursive: true });
      const manifestPath = join(folder, "pistachio.json");
      if (existsSync(manifestPath)) {
        // The template's manifest, named for this one.
        try {
          const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
          manifest["id"] = `dev.local.${basename(folder)}`;
          manifest["name"] = name.slice(0, 40);
          writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        } catch {
          // A template that is not JSON is left as it is: the status file says what is wrong with it.
        }
      }
    } else {
      mkdirSync(folder, { recursive: true });
      writeMinimalExtension(folder, name, template);
    }
    return { type: "folder", path: folder };
  }

  /** The agent's draft (docs/extensions.md §8): an empty folder in the dev folder; what lands there waits on approval. */
  #draftFolder(name: string): ExtensionResponse {
    const parent = this.#requireDevFolder();
    const slug = folderSlug(name);
    let folder = join(parent, slug);
    for (let n = 2; existsSync(folder) && readdirSync(folder).length > 0; n += 1) folder = join(parent, `${slug}-${String(n)}`);
    mkdirSync(folder, { recursive: true });
    // The author turn that writes it carries this token (the Bar's prompt says it), and no other turn can.
    return { type: "folder", path: folder, author: this.#drafts.add(folder) };
  }
}

/** The size a capture is asked at: the page's size × `scale`, its longest side at most MAX_CAPTURE_SIDE, in even px. */
export function captureSize(size: { width: number; height: number }, scale: 1 | 2): { width: number; height: number } {
  const width = Math.max(2, size.width * scale);
  const height = Math.max(2, size.height * scale);
  const fit = Math.min(1, MAX_CAPTURE_SIDE / Math.max(width, height));
  const even = (value: number): number => Math.max(2, Math.round((value * fit) / 2) * 2);
  return { width: even(width), height: even(height) };
}

/** A folder that loads as it is: a manifest, a worker, and a panel (or a Bar command, or a tool). */
export function writeMinimalExtension(folder: string, name: string, template: "panel" | "bar-command" | "agent-tool"): void {
  const slug = basename(folder);
  const manifest: Record<string, unknown> = {
    $schema: "../.pistachio/pistachio-extension.schema.json",
    api: 1,
    id: `dev.local.${slug.replace(/[^a-z0-9-]/g, "-")}`,
    name: name.slice(0, 40),
    version: "0.1.0",
    description: "",
    worker: { type: "web", main: "worker.js" },
  };
  if (template === "panel") manifest["panel"] = { file: "panel.html" };
  if (template === "bar-command") manifest["bar"] = { commands: [{ name: "hello", description: "Say hello", run: { event: true } }] };
  if (template === "agent-tool") {
    manifest["permissions"] = ["agent:tools"];
    manifest["tools"] = [{ name: "hello", description: "Say hello to someone", input: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }, effect: "read" }];
  }
  writeFileSync(join(folder, "pistachio.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const worker =
    template === "bar-command"
      ? `pistachio.bar.onCommand("hello", () => {\n  pistachio.ui.toast({ title: "Hello from ${name.replace(/"/g, "")}" });\n});\n`
      : template === "agent-tool"
        ? `pistachio.agent.onToolCall("hello", async (input) => ({ greeting: \`Hello, \${input.name}!\` }));\n`
        : `pistachio.runtime.onInstalled(({ reason }) => pistachio.runtime.log("info", \`installed: \${reason}\`));\n`;
  writeFileSync(join(folder, "worker.js"), worker);
  if (template === "panel") {
    writeFileSync(
      join(folder, "panel.html"),
      `<!doctype html>\n<html>\n  <head><meta charset="utf-8"><title>${name.replace(/[<>&]/g, "")}</title></head>\n  <body>\n    <p>Hello from ${name.replace(/[<>&]/g, "")}.</p>\n  </body>\n</html>\n`,
    );
  }
}
