import { sanitizePageResume, type PageResumeState } from "./page-resume.js";
/**
 * The durable, recoverable part of a human browsing session. Page processes,
 * agent tabs, Glance previews, permissions, downloads, and run authority are
 * intentionally absent: a restart rebuilds human tabs against each Space's
 * persistent partition without reviving ephemeral authority.
 */

import {
  isBrowserPermission,
  isPermissionDecision,
  type PermissionDecision,
} from "./browser-controls.js";
import type { SplitGridLayout, SplitGroupInfo } from "./ipc.js";
import { DEFAULT_SIDEBAR_STATE, sanitizeSidebarState, type SidebarState } from "./sidebar.js";
import { sanitizeTabGroups, type TabGroupInfo } from "./tab-groups.js";
import { isAllowedNavigation, normalizeNavigation } from "./url.js";

export const TAB_SESSION_VERSION = 1;
export const MAX_RESTORED_TABS_PER_SPACE = 200;
/** How much of a tab's back/forward stack survives a restart. */
export const MAX_RESTORED_HISTORY_ENTRIES = 50;

/** One back/forward entry: the address and its title, nothing of the page itself. */
export interface DurableHistoryEntry {
  url: string;
  title: string;
}

/**
 * A tab's back/forward stack. Only addresses and titles are durable: page
 * state is not encoded in history entries. The separate, bounded `resume`
 * checkpoint can carry document scroll and supported textarea drafts.
 */
export interface DurableTabHistory {
  entries: DurableHistoryEntry[];
  /** Index of the entry the tab was showing. */
  index: number;
}

export interface DurableTab {
  id: string;
  spaceId: string;
  title: string;
  url: string;
  faviconUrl: string | null;
  anchorId: string | null;
  lastActiveAt: number;
  /** Absent in files written before history was recorded. */
  history?: DurableTabHistory;
  resume?: PageResumeState;
}

export interface DurableSpaceSession {
  /** Last actual change; republishing an unchanged device must not win a handoff. */
  updatedAt?: number;
  tabs: DurableTab[];
  activeTabId: string | null;
  recentTabIds: string[];
  splitGroups: SplitGroupInfo[];
  /** Absent in files written before tab groups (@pistachio/shell-contracts/tab-groups). */
  tabGroups?: TabGroupInfo[];
}

export interface DurableTabSession {
  version: typeof TAB_SESSION_VERSION;
  spaces: Record<string, DurableSpaceSession>;
}

export const EMPTY_TAB_SESSION: DurableTabSession = {
  version: TAB_SESSION_VERSION,
  spaces: {},
};

const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,127}$/i;
/** A tab id, which a cloud host scopes with a prefix (`cloud:<uuid>`). */
const SAFE_TAB_ID = /^[a-z0-9][a-z0-9:_-]{0,191}$/i;
const SIGN_OUT_PATH = /(?:^|\/)(?:log[-_]?out|sign[-_]?out)(?:\/|$)/iu;
const TRANSIENT_SIGN_OUT_PARAMETERS = new Set([
  "logout",
  "logged_out",
  "loggedout",
  "sign_out",
  "signout",
]);

/** Do not make one-shot sign-out endpoints part of durable browser state. */
export function normalizeRestorableTabUrl(value: string): string {
  const normalized = normalizeNavigation(value);
  try {
    const url = new URL(normalized);
    if (SIGN_OUT_PATH.test(url.pathname)) {
      url.pathname = "/";
      url.search = "";
      url.hash = "";
      return url.href;
    }
    for (const key of [...url.searchParams.keys()]) {
      if (
        TRANSIENT_SIGN_OUT_PARAMETERS.has(
          key.toLowerCase().replaceAll("-", "_"),
        )
      )
        url.searchParams.delete(key);
    }
    return url.href;
  } catch {
    return normalized;
  }
}

export function sanitizeTabSession(value: unknown, validSpaceIds?: ReadonlySet<string>): DurableTabSession {
  if (typeof value !== "object" || value === null) return structuredClone(EMPTY_TAB_SESSION);
  const root = value as Record<string, unknown>;
  if (root["version"] !== TAB_SESSION_VERSION) return structuredClone(EMPTY_TAB_SESSION);
  const rawSpaces = root["spaces"];
  if (typeof rawSpaces !== "object" || rawSpaces === null) return structuredClone(EMPTY_TAB_SESSION);
  const spaces: Record<string, DurableSpaceSession> = {};
  for (const [spaceId, rawSpace] of Object.entries(rawSpaces as Record<string, unknown>)) {
    if (!SAFE_ID.test(spaceId) || (validSpaceIds !== undefined && !validSpaceIds.has(spaceId))) continue;
    const space = sanitizeSpaceSession(rawSpace, spaceId);
    if (space.tabs.length > 0) spaces[spaceId] = space;
  }
  return { version: TAB_SESSION_VERSION, spaces };
}

function sanitizeSpaceSession(value: unknown, spaceId: string): DurableSpaceSession {
  const raw = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const tabs: DurableTab[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw["tabs"])) {
    for (const candidate of raw["tabs"]) {
      const tab = sanitizeTab(candidate, spaceId);
      if (tab === null || seen.has(tab.id)) continue;
      seen.add(tab.id);
      tabs.push(tab);
      if (tabs.length === MAX_RESTORED_TABS_PER_SPACE) break;
    }
  }
  const ids = new Set(tabs.map((tab) => tab.id));
  const activeTabId = typeof raw["activeTabId"] === "string" && ids.has(raw["activeTabId"]) ? raw["activeTabId"] : (tabs[0]?.id ?? null);
  const recentTabIds = Array.isArray(raw["recentTabIds"])
    ? [...new Set(raw["recentTabIds"].filter((id): id is string => typeof id === "string" && ids.has(id)))].slice(0, tabs.length)
    : [];
  const splitGroups = sanitizeSplitGroups(raw["splitGroups"], ids);
  // Only a day tab can be grouped: a pinned or favorite tab belongs to its shelf entry.
  const tabGroups = sanitizeTabGroups(raw["tabGroups"], new Set(tabs.filter((tab) => tab.anchorId === null).map((tab) => tab.id)));
  const updatedAt = raw["updatedAt"];
  return { tabs, activeTabId, recentTabIds, splitGroups, ...(tabGroups.length > 0 ? { tabGroups } : {}), ...(typeof updatedAt === "number" && Number.isFinite(updatedAt) && updatedAt >= 0 ? { updatedAt } : {}) };
}

function sanitizeTab(value: unknown, spaceId: string): DurableTab | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw["id"] === "string" && SAFE_ID.test(raw["id"]) ? raw["id"] : "";
  const rawUrl = typeof raw["url"] === "string" && raw["url"].length <= 2_048 ? raw["url"] : "";
  if (id === "" || !isAllowedNavigation(rawUrl)) return null;
  const url = normalizeRestorableTabUrl(rawUrl);
  const history = sanitizeTabHistory(raw["history"]);
  return {
    id,
    spaceId,
    title: typeof raw["title"] === "string" ? raw["title"].trim().slice(0, 240) || "Restored tab" : "Restored tab",
    url,
    faviconUrl: sanitizeFavicon(raw["faviconUrl"]),
    anchorId: typeof raw["anchorId"] === "string" && raw["anchorId"].length <= 2_048 ? raw["anchorId"] : null,
    lastActiveAt: typeof raw["lastActiveAt"] === "number" && Number.isFinite(raw["lastActiveAt"]) && raw["lastActiveAt"] >= 0 ? raw["lastActiveAt"] : 0,
    ...(history === null ? {} : { history }),
    ...(sanitizePageResume(raw["resume"], url) ? { resume: sanitizePageResume(raw["resume"], url)! } : {}),
  };
}

/**
 * A restorable back/forward stack, or null when there is nothing worth
 * restoring beyond the tab's own address. Entries that could not be loaded
 * again (blob:, about:, data:, unsafe schemes) are dropped; the stack is
 * abandoned when the entry being shown is one of them, since restoring it
 * would land on a different page. Sign-out routes are neutralized the way
 * the tab's address is. Trimmed to the newest MAX_RESTORED_HISTORY_ENTRIES
 * without ever dropping the entry being shown.
 */
export function sanitizeTabHistory(value: unknown): DurableTabHistory | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw["entries"])) return null;
  const rawIndex = raw["index"];
  if (typeof rawIndex !== "number" || !Number.isInteger(rawIndex)) return null;
  const entries = raw["entries"].map((candidate: unknown): DurableHistoryEntry => {
    if (typeof candidate !== "object" || candidate === null) return { url: "", title: "" };
    const entry = candidate as Record<string, unknown>;
    return {
      url: typeof entry["url"] === "string" && entry["url"].length <= 2_048 ? entry["url"] : "",
      title: typeof entry["title"] === "string" ? entry["title"].trim().slice(0, 240) : "",
    };
  });
  const trimmed = trimTabHistory(entries, rawIndex, (entry) => isAllowedNavigation(entry.url));
  if (trimmed === null) return null;
  return {
    entries: trimmed.entries.map((entry) => ({ ...entry, url: normalizeRestorableTabUrl(entry.url) })),
    index: trimmed.index,
  };
}

/**
 * The part of a stack a fresh page can be given again: the entries
 * `restorable` accepts, trimmed to the newest MAX_RESTORED_HISTORY_ENTRIES
 * without ever dropping the entry being shown (`index`). Null when that
 * entry is itself unrestorable — the tab's own address is then the better
 * start — or when fewer than two entries remain, which a plain load of the
 * address gives anyway. Entries pass through untouched, so a caller's extra
 * fields (page state, kept in memory only) survive the trim.
 */
export function trimTabHistory<T extends { url: string }>(
  entries: readonly T[],
  index: number,
  restorable: (entry: T) => boolean,
): { entries: T[]; index: number } | null {
  if (index < 0 || index >= entries.length) return null;
  const kept: T[] = [];
  let shown = -1;
  for (const [position, entry] of entries.entries()) {
    if (!restorable(entry)) {
      if (position === index) return null;
      continue;
    }
    if (position === index) shown = kept.length;
    kept.push(entry);
  }
  if (shown < 0 || kept.length < 2) return null;
  if (kept.length <= MAX_RESTORED_HISTORY_ENTRIES) return { entries: kept, index: shown };
  const start = Math.min(kept.length - MAX_RESTORED_HISTORY_ENTRIES, shown);
  return { entries: kept.slice(start, start + MAX_RESTORED_HISTORY_ENTRIES), index: shown - start };
}

function sanitizeSplitGroups(value: unknown, tabIds: ReadonlySet<string>): SplitGroupInfo[] {
  if (!Array.isArray(value)) return [];
  const groups: SplitGroupInfo[] = [];
  const claimed = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const raw = candidate as Record<string, unknown>;
    const id = raw["id"];
    // Version 1 originally persisted only primary/secondary. Accept those
    // files and normalize them into the new ordered 2–4 pane representation.
    const legacyIds = [raw["primaryTabId"], raw["secondaryTabId"]];
    const ids = Array.isArray(raw["tabIds"]) ? raw["tabIds"] : legacyIds;
    const mode = raw["mode"];
    const gridLayout = sanitizeGridLayout(raw["gridLayout"]);
    if (
      typeof id !== "string" ||
      !SAFE_ID.test(id) ||
      ids.length < 2 ||
      ids.length > 4 ||
      ids.some((tabId) => typeof tabId !== "string" || !tabIds.has(tabId) || claimed.has(tabId)) ||
      new Set(ids).size !== ids.length ||
      (mode !== "vertical" && mode !== "horizontal" && mode !== "grid")
    )
      continue;
    const normalizedIds = ids as string[];
    for (const tabId of normalizedIds) claimed.add(tabId);
    groups.push({
      id,
      tabIds: [...normalizedIds],
      primaryTabId: normalizedIds[0]!,
      secondaryTabId: normalizedIds[1]!,
      mode,
      gridLayout,
    });
  }
  return groups;
}

function sanitizeGridLayout(value: unknown): SplitGridLayout {
  return value === "span-top" || value === "span-left" || value === "span-right" ? value : "span-bottom";
}

function sanitizeFavicon(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 16_384) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "data:" ? value : null;
  } catch {
    return null;
  }
}

/* ------------------------------ browser session ----------------------------- */

/**
 * The persistent cloud browser session's durable state
 * (docs/web-browser-design.md §9), the structural mirror of
 * `@pistachio/sync-protocol`'s `BrowserSessionRecord`. The record is the wire
 * shape sealed under the workspace key as `browser-session:<spaceId>`; this
 * is the same shape stated in the shell's own vocabulary (`SidebarState`,
 * `SplitGroupInfo`), so the host builds one from the state it already holds
 * and the parity test in `test/record-docs.test.ts` keeps the two from
 * drifting.
 */
/**
 * Bumped to 2 in S6, when the per-site permission decisions joined the
 * record. The bump is the whole mixed-fleet story: a worker that only knows
 * version 1 refuses a version-2 record rather than reading the half it
 * understands, and `readBrowserSessionState` tells its caller the difference
 * between "there is nothing stored" and "there is something stored that I
 * cannot read" — because only the first of those may be published over.
 */
export const BROWSER_SESSION_VERSION = 2;

/** How long a tab's address may be before the record refuses to carry it. */
export const MAX_RESTORABLE_URL_LENGTH = 2_048;

export interface BrowserSessionTab {
  id: string;
  url: string;
  title: string;
  favicon: string | null;
  kind: "human";
  /** The shelf entry this tab is the live page of (a pin, a favorite, `preset:<url>`). */
  pinnedAnchor?: string;
  /**
   * When the tab was last in front. Without it a rebuilt session's tab
   * switcher is insertion order rather than most-recent-first, which is not
   * the order the person left it in. Absent in version-1 records.
   */
  lastActiveAt?: number;
  resume?: PageResumeState;
}

export interface BrowserSessionState {
  version: typeof BROWSER_SESSION_VERSION;
  spaceId: string;
  tabs: BrowserSessionTab[];
  activeTabId: string | null;
  splitGroups: SplitGroupInfo[];
  shelf: SidebarState;
  /** Page zoom per origin host, so a zoomed site is still zoomed after a rebuild. */
  zoom: Record<string, number>;
  /**
   * What each site was allowed, per origin: the answer the person gave the
   * permission prompt, kept so the next visit does not ask again
   * (docs/web-browser-design.md §11, "Site permissions"). Keyed by the full
   * origin (scheme, host, port — so `http://` never inherits an `https://`
   * grant) and then by `BrowserPermission`; a permission with no entry is
   * "ask".
   */
  permissions: Record<string, Record<string, PermissionDecision>>;
  updatedAt: number;
}

export const EMPTY_BROWSER_SESSION_STATE: Omit<BrowserSessionState, "spaceId"> = {
  version: BROWSER_SESSION_VERSION,
  tabs: [],
  activeTabId: null,
  splitGroups: [],
  shelf: DEFAULT_SIDEBAR_STATE,
  zoom: {},
  permissions: {},
  updatedAt: 0,
};

/**
 * A session record read back from the hub. Anything unusable is dropped
 * rather than thrown: a record written by a newer build, or one a byte of
 * which did not survive, must leave a person with a session they can still
 * use — an empty one at worst — not a worker that refuses to claim.
 */
/**
 * Site permissions read back from a record. A host or a permission this
 * build does not know is dropped rather than kept: a decision nobody can
 * apply is worse than asking again.
 */
export function sanitizeSitePermissions(value: unknown): Record<string, Record<string, PermissionDecision>> {
  return readSitePermissions(value).decisions;
}

/**
 * The same read, plus whether anything was dropped. A permission name this
 * build does not know is a permission a NEWER build gave the person, and the
 * dropping is only safe as long as the pruned map is never written back.
 */
export function readSitePermissions(value: unknown): {
  decisions: Record<string, Record<string, PermissionDecision>>;
  pruned: boolean;
} {
  const decisions: Record<string, Record<string, PermissionDecision>> = {};
  let pruned = false;
  if (typeof value !== "object" || value === null) {
    return { decisions, pruned: value !== undefined && value !== null };
  }
  for (const [host, entries] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entries !== "object" || entries === null) {
      pruned = true;
      continue;
    }
    const kept: Record<string, PermissionDecision> = {};
    for (const [permission, decision] of Object.entries(entries as Record<string, unknown>)) {
      if (!isBrowserPermission(permission) || !isPermissionDecision(decision)) {
        pruned = true;
        continue;
      }
      kept[permission] = decision;
    }
    if (Object.keys(kept).length > 0) decisions[host.slice(0, 253)] = kept;
  }
  return { decisions, pruned };
}

/**
 * What a stored record turned out to be. The distinction matters because the
 * host PUBLISHES: a record it could not read is not an empty session, and
 * writing an empty session over it would lose every tab on every device
 * (docs/web-browser-design.md §9). `pruned` says the record was readable but
 * carried something this build dropped — a permission name it does not know,
 * a two-hundred-and-first tab — which is equally not a thing to write back.
 */
export type BrowserSessionRead =
  | { kind: "none" }
  | { kind: "unreadable"; reason: "version" | "shape" }
  | { kind: "state"; state: BrowserSessionState; pruned: boolean };

/**
 * Read a stored session record. Anything unusable is reported rather than
 * thrown: a record written by a newer build must leave a person with a
 * session they can still use — an empty one at worst — not a worker that
 * refuses to claim, and not a worker that overwrites what it could not read.
 */
export function readBrowserSessionState(value: unknown, spaceId: string): BrowserSessionRead {
  if (value === null || value === undefined) return { kind: "none" };
  if (typeof value !== "object") return { kind: "unreadable", reason: "shape" };
  const raw = value as Record<string, unknown>;
  if (raw["version"] !== BROWSER_SESSION_VERSION) return { kind: "unreadable", reason: "version" };
  if (typeof raw["spaceId"] !== "string" || raw["spaceId"] !== spaceId) {
    return { kind: "unreadable", reason: "shape" };
  }
  let pruned = false;
  const tabs: BrowserSessionTab[] = [];
  const seen = new Set<string>();
  const rawTabs = Array.isArray(raw["tabs"]) ? raw["tabs"] : [];
  for (const candidate of rawTabs) {
    if (typeof candidate !== "object" || candidate === null) {
      pruned = true;
      continue;
    }
    const tab = candidate as Record<string, unknown>;
    const id = tab["id"];
    const url = tab["url"];
    // The RAW address is what is checked, and it is checked before it is
    // normalized: `normalizeNavigation` never fails — anything unparseable
    // becomes a search — so a check after it can never reject anything.
    if (
      typeof id !== "string" ||
      !SAFE_TAB_ID.test(id) ||
      seen.has(id) ||
      typeof url !== "string" ||
      url.length > MAX_RESTORABLE_URL_LENGTH ||
      !isAllowedNavigation(url)
    ) {
      pruned = true;
      continue;
    }
    seen.add(id);
    const anchor = tab["pinnedAnchor"];
    const lastActiveAt = tab["lastActiveAt"];
    tabs.push({
      id,
      url: normalizeRestorableTabUrl(url),
      title: typeof tab["title"] === "string" ? tab["title"].slice(0, 512) : "",
      favicon: sanitizeFavicon(tab["favicon"]),
      kind: "human",
      ...(sanitizePageResume(tab["resume"], url) ? { resume: sanitizePageResume(tab["resume"], url)! } : {}),
      ...(typeof anchor === "string" && anchor !== "" ? { pinnedAnchor: anchor.slice(0, 512) } : {}),
      ...(typeof lastActiveAt === "number" && Number.isFinite(lastActiveAt) && lastActiveAt >= 0
        ? { lastActiveAt }
        : {}),
    });
    if (tabs.length >= MAX_RESTORED_TABS_PER_SPACE) {
      if (rawTabs.length > MAX_RESTORED_TABS_PER_SPACE) pruned = true;
      break;
    }
  }
  const ids = new Set(tabs.map((tab) => tab.id));
  const activeTabId = raw["activeTabId"];
  const zoom: Record<string, number> = {};
  const rawZoom = raw["zoom"];
  if (typeof rawZoom === "object" && rawZoom !== null) {
    for (const [host, factor] of Object.entries(rawZoom as Record<string, unknown>)) {
      if (typeof factor !== "number" || !Number.isFinite(factor) || factor < 0.25 || factor > 5) {
        pruned = true;
        continue;
      }
      zoom[host.slice(0, 253)] = factor;
    }
  }
  const permissions = readSitePermissions(raw["permissions"]);
  if (permissions.pruned) pruned = true;
  const splitGroups = sanitizeSplitGroups(raw["splitGroups"], ids);
  if (Array.isArray(raw["splitGroups"]) && splitGroups.length !== raw["splitGroups"].length) pruned = true;
  return {
    kind: "state",
    pruned,
    state: {
      version: BROWSER_SESSION_VERSION,
      spaceId,
      tabs,
      activeTabId: typeof activeTabId === "string" && ids.has(activeTabId) ? activeTabId : (tabs[0]?.id ?? null),
      splitGroups,
      shelf: sanitizeSidebarState(raw["shelf"]),
      zoom,
      permissions: permissions.decisions,
      updatedAt: typeof raw["updatedAt"] === "number" && Number.isFinite(raw["updatedAt"]) ? raw["updatedAt"] : 0,
    },
  };
}

/** The state alone, for callers that do not publish (a reader, a test). */
export function sanitizeBrowserSessionState(
  value: unknown,
  spaceId: string,
): BrowserSessionState | null {
  const read = readBrowserSessionState(value, spaceId);
  return read.kind === "state" ? read.state : null;
}
