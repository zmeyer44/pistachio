/**
 * Extensions (docs/extensions.md): what the shell knows about every
 * extension — Chrome's and Pistachio's — and what it asks main to do with
 * them. One request union and one snapshot, the notes recipe (./notes.ts),
 * so a host that has no extensions (the cloud browser) refuses one member
 * with one reason.
 *
 * Main owns the registry (`<userData>/extensions.json`) and is the only
 * writer; the shell draws the Ledge, the extensions page, the approval
 * sheet and Settings → Extensions from the snapshot alone, never from an
 * extension's own code.
 */

import type { ContentBounds } from "./ipc.js";

export type ExtensionKind = "pistachio" | "chrome";

/** Where an extension came from; `dev` folders are watched and hot-reloaded. */
export type ExtensionSource =
  | { type: "bundled" }
  | { type: "dev"; path: string }
  | { type: "webstore"; cwsId: string; version: string }
  | { type: "unpacked"; path: string };

export type ExtensionSourceType = ExtensionSource["type"];

/**
 * - `off`: the person turned it off (the master switch, or off in this Profile).
 * - `needs-approval`: never approved, or its manifest widened; nothing of it runs.
 * - `paused`: approved once, now waiting on a widened manifest's approval.
 * - `error`: its manifest or its code failed; `error` says what, in words that say how to fix it.
 * - `incompatible`: a Chrome extension whose core Pistachio lacks (the verdict says why).
 * - `idle` / `running`: on, and whether its worker (or service worker) is up.
 */
export type ExtensionStatus = "off" | "needs-approval" | "paused" | "error" | "incompatible" | "idle" | "running";

export type ExtensionTier = "low" | "medium" | "high" | "critical";

/** One line of the approval sheet: a fixed sentence per capability, never the extension's own words. */
export interface ExtensionSheetLine {
  tier: ExtensionTier;
  text: string;
}

/** The approval sheet's contents, computed by main from the manifest that will load. */
export interface ExtensionSheet {
  /** What it adds to the window, in words: "/prs in the Bar", "a tool the agent can call". */
  adds: string[];
  /** What it can do, broadest first; the sheet shows at most four and discloses the rest. */
  can: ExtensionSheetLine[];
  /** Everything it declares, for "See everything it declares ›". */
  declares: string[];
  /** The hash of the manifest these lines describe; an approval names it. */
  manifestHash: string;
  /** Pistachio's agent changed the folder after the person approved it: it waits, paused, for them to look again (§6.2). */
  changedByAgent?: boolean;
}

/** A Chrome extension's verdict, read from the downloaded manifest (docs/extensions.md §6.4). */
export type ChromeVerdict =
  | { kind: "works" }
  | { kind: "partly"; notes: string[] }
  | { kind: "wont"; reason: string; alternative?: string };

export interface ExtensionGrantSummary {
  capabilities: string[];
  hosts: string[];
}

export interface ExtensionBarCommandInfo {
  name: string;
  description: string;
  arg: { hint: string; required: boolean } | null;
}

export interface ExtensionMenuItemInfo {
  id: string;
  title: string;
  contexts: string[];
  hosts: string[];
}

export interface ExtensionSettingInfo {
  key: string;
  title: string;
  description: string | null;
  type: "boolean" | "string" | "number" | "enum" | "secret";
  options: string[] | null;
  /** The value in force (a secret reads as "" or "••••••"). */
  value: unknown;
  min?: number;
  max?: number;
}

/** A live pill an extension asked the shell to draw beside the Bar's nub (`pistachio.ui.setStatus`). */
export interface ExtensionStatusPill {
  text: string;
  actions: { id: string; title: string }[];
}

export interface ExtensionError {
  message: string;
  file?: string;
  line?: number;
  at: number;
}

/** Everything the shell draws about one extension. */
export interface ExtensionInfo {
  id: string;
  kind: ExtensionKind;
  name: string;
  version: string;
  description: string;
  /**
   * The mark the shell draws: `crx://extension-logo/<id>/64?t=…` for a Chrome extension (its manifest's own logo,
   * served by main from its folder, loaded or not — or its action's `crx://extension-icon/…` while `setIcon` changed
   * it), `pistachio-ext://<id>/<icon>` for ours, or null (a monogram).
   */
  iconUrl: string | null;
  source: ExtensionSource;
  /** The master switch. */
  enabled: boolean;
  /** On in the Profile in front. */
  enabledHere: boolean;
  pinned: boolean;
  order: number;
  /** The person let the agent call its tools (`agent:tools` granted and the switch on). */
  agentAllowed: boolean;
  status: ExtensionStatus;
  error: ExtensionError | null;
  /** The action's badge (Chrome's `setBadgeText`, or `pistachio.ui.setBadge`). */
  badge: string | null;
  statusPill: ExtensionStatusPill | null;
  /** A Pistachio extension with a `panel`; a Chrome extension with a popup. */
  hasPanel: boolean;
  /** The panel's declared width (pistachio.json `panel.width`, 240–480), or null for the default. */
  panelWidth: number | null;
  /** Something happens on a click: a popup, a panel, or an `action`. */
  hasAction: boolean;
  pages: { name: string; title: string }[];
  barCommands: ExtensionBarCommandInfo[];
  /** Declared context-menu items for a desk window's ⋯ (`window`) and the page's menu. */
  menuItems: ExtensionMenuItemInfo[];
  settings: ExtensionSettingInfo[];
  tools: { name: string; description: string; effect: "read" | "write" }[];
  grants: ExtensionGrantSummary | null;
  /** Waiting on the person: the sheet to approve (a first load, or a widened manifest). */
  pending: ExtensionSheet | null;
  verdict: ChromeVerdict | null;
  /** The dev folder, when it is one, for *Show folder*. */
  devPath: string | null;
  /** Tabs this extension is capturing or watching right now (docs/extensions.md §5 `capture`): the shell marks them. */
  captures?: string[];
  /** The agent's author turn is writing its folder right now (docs/extensions.md §8): its Ledge icon shimmers. */
  drafting?: boolean;
}

/** A library (bundled) extension not yet turned on, offered on the extensions page. */
export interface ExtensionLibraryEntry {
  id: string;
  name: string;
  description: string;
  iconUrl: string | null;
}

/** A curated Chrome Web Store extension with its measured verdict. */
export interface ExtensionCuratedEntry {
  cwsId: string;
  name: string;
  description: string;
  /** Its logo, a file of the shell's own (`/extension-icons/<id>.png`, taken from its package), or null (a monogram). */
  iconUrl: string | null;
  verdict: ChromeVerdict;
}

/** A Chrome Web Store install waiting on the sheet: main downloaded it and read the real manifest. */
export interface ExtensionPendingInstall {
  cwsId: string;
  name: string;
  description: string;
  iconUrl: string | null;
  verdict: ChromeVerdict;
  sheet: ExtensionSheet;
}

export interface ExtensionsSnapshot {
  extensions: ExtensionInfo[];
  developerMode: boolean;
  /** `~/Pistachio/Extensions`, once Developer mode made it. */
  devFolder: string | null;
  library: ExtensionLibraryEntry[];
  curated: ExtensionCuratedEntry[];
  pendingInstall: ExtensionPendingInstall | null;
  /** The extension whose panel is open beside the sidebar, if any. */
  openPanel: string | null;
}

export const EMPTY_EXTENSIONS_SNAPSHOT: ExtensionsSnapshot = {
  extensions: [],
  developerMode: false,
  devFolder: null,
  library: [],
  curated: [],
  pendingInstall: null,
  openPanel: null,
};

/** What a context-menu or window-menu click carries to the extension. */
export interface ExtensionMenuClick {
  tabId: string | null;
  pageUrl: string | null;
  linkUrl?: string;
  selectionText?: string;
  srcUrl?: string;
  /** The desk window's tab, for `window` items. */
  windowTabId?: string;
}

export type ExtensionRequest =
  /** The sheet's *Turn it on*; `manifestHash` is the one the sheet showed. */
  | { type: "approve"; id: string; manifestHash: string; agentAllowed?: boolean }
  | { type: "deny"; id: string }
  | { type: "setEnabled"; id: string; enabled: boolean; scope?: "all" | "here" }
  | { type: "pin"; id: string; pinned: boolean }
  | { type: "reorder"; id: string; index: number }
  | { type: "uninstall"; id: string }
  | { type: "reload"; id: string }
  | { type: "setAgentAllowed"; id: string; allowed: boolean }
  | { type: "setSetting"; id: string; key: string; value: unknown }
  | { type: "setDeveloperMode"; on: boolean }
  /** A folder picked by the person (no `path`: a native dialog), linked into the registry as a dev folder. */
  | { type: "loadFolder"; path?: string }
  | { type: "revealFolder"; id: string }
  /** Scaffold a template into the dev folder; answers `{ type: "folder" }`. */
  | { type: "newFolder"; name: string; template: "panel" | "bar-command" | "agent-tool" }
  /** Download by store id, read the real manifest, and offer the sheet (`pendingInstall`). */
  | { type: "installChrome"; cwsId: string }
  | { type: "approveInstall"; cwsId: string; manifestHash: string }
  | { type: "denyInstall"; cwsId: string }
  /** The Ledge icon: a Chrome action's popup at `anchor` (window coordinates), or a Pistachio panel/action. */
  | { type: "activate"; id: string; tabId: string | null; anchor: ContentBounds | null }
  | { type: "closePanel" }
  | { type: "barCommand"; id: string; command: string; arg: string; spaceId: string | null; tabId: string | null; selection?: string }
  | { type: "menu"; id: string; item: string; click: ExtensionMenuClick }
  /** A status pill's action (`source` "status", the default) or a toast's ("toast") was chosen. */
  | { type: "statusAction"; id: string; action: string; source?: "status" | "toast" }
  | { type: "openPage"; id: string; page: string; query?: string }
  | { type: "logs"; id: string }
  /** The agent's drafting (docs/extensions.md §8) and the Bar's `/extension`: answers once the draft folder exists. */
  | { type: "draftFolder"; name: string };

export type ExtensionResponse =
  | { type: "ok" }
  /**
   * A folder made. A `draftFolder`'s carries `author`: its slug and the one-time token the Bar's prompt names, so
   * the turn that writes it is the author turn (docs/extensions.md §8) and no other prompt can be.
   */
  | { type: "folder"; path: string; author?: { slug: string; token: string } }
  | { type: "logs"; lines: string[] }
  /** `installChrome` once the sheet is up, or at once with the verdict when it won't work. */
  | { type: "verdict"; verdict: ChromeVerdict };

/** A Bar command id for an extension's declared command: `ext:<extension id>:<command>`. */
export function extensionBarCommandId(extensionId: string, command: string): `ext:${string}` {
  return `ext:${extensionId}:${command}`;
}

export function parseExtensionBarCommandId(id: string): { extensionId: string; command: string } | null {
  if (!id.startsWith("ext:")) return null;
  const rest = id.slice(4);
  const at = rest.lastIndexOf(":");
  if (at <= 0 || at === rest.length - 1) return null;
  return { extensionId: rest.slice(0, at), command: rest.slice(at + 1) };
}

/** The page an extension's desk window is: `pistachio-ext://<id>/<file>?<query>`. */
export const EXTENSION_SCHEME = "pistachio-ext";

export function isExtensionPageUrl(url: string): boolean {
  return url.startsWith(`${EXTENSION_SCHEME}://`);
}

/** The extension an address belongs to, or null. */
export function extensionIdOfUrl(url: string): string | null {
  if (!isExtensionPageUrl(url)) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/** The extensions page, a shell-drawn page (./shell-pages.ts). */
export const EXTENSIONS_PAGE_URL = "pistachio://extensions/";
export const EXTENSIONS_PAGE_TITLE = "Extensions";
export const EXTENSIONS_PAGE_FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='18' fill='%2352a862'/%3E%3Cpath d='M22 20h8v-4a4 4 0 0 1 8 0v4h8v8h4a4 4 0 0 1 0 8h-4v8H22v-8h-4a4 4 0 0 1 0-8h4z' fill='white'/%3E%3C/svg%3E";

export function isExtensionsPageUrl(url: string): boolean {
  const trimmed = url.trim();
  return trimmed === EXTENSIONS_PAGE_URL || trimmed === "pistachio://extensions" || trimmed.startsWith("pistachio://extensions/?") || trimmed.startsWith("pistachio://extensions?");
}

/** The Ledge's size (docs/extensions.md X9). */
export const LEDGE_HEIGHT = 36;
export const LEDGE_SLOT = 28;
export const LEDGE_GAP = 4;
/** In rail mode, how many pinned icons the rail's foot shows before ⋯. */
export const LEDGE_RAIL_MAX = 3;
