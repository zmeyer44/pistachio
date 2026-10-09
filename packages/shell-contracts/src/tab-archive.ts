/**
 * The tab archive: tabs Tidy closed because they went idle, and spaces (tab
 * groups) a person closed, kept so that neither is a loss (docs/tab-tidy.md §3.6).
 * Main owns the file (main/tab-archive-store.ts); the archive page reads it
 * through one request/response method, the way Watchtower's page does, so
 * the list never rides on the snapshot.
 *
 * An archived tab carries what a durable tab does — address, title, icon,
 * the back/forward stack, the scroll/draft checkpoint — so restoring one is
 * the same act as restoring a session tab. Only the VIEW (no history, no
 * checkpoint) crosses to a renderer.
 *
 * Pure on purpose — no Electron, no DOM — so vitest pins it under node.
 */

import { sanitizePageResume, type PageResumeState } from "./page-resume.js";
import { isTabGroupColor, isTabGroupId, storedTabGroupTitle, type TabGroupColor, type TabGroupOrigin } from "./tab-groups.js";
import { normalizeRestorableTabUrl, sanitizeTabHistory, type DurableTabHistory } from "./tab-session.js";
import { isAllowedNavigation } from "./url.js";

export const TAB_ARCHIVE_VERSION = 1;
export const MAX_ARCHIVE_ENTRIES = 500;
export const MAX_ARCHIVED_GROUP_TABS = 200;
export { ARCHIVE_RETENTION_DAYS, DEFAULT_ARCHIVE_RETENTION_DAYS, type ArchiveRetentionDays } from "./tidy.js";

/** Why an entry is here: the clock took it, or a person closed its space (tab group). */
export type ArchiveReason = "idle" | "closed";

export interface ArchivedTab {
  title: string;
  url: string;
  faviconUrl: string | null;
  lastActiveAt: number;
  history?: DurableTabHistory;
  resume?: PageResumeState;
}

interface ArchiveEntryBase {
  id: string;
  spaceId: string;
  archivedAt: number;
  reason: ArchiveReason;
  /** The Tidy run that filed it, which is what that run's Undo takes back; null for a closed group. */
  runId: string | null;
}

export interface ArchivedTabEntry extends ArchiveEntryBase {
  kind: "tab";
  tab: ArchivedTab;
}

export interface ArchivedGroupEntry extends ArchiveEntryBase {
  kind: "group";
  /**
   * The space's (tab group's) own id (since 2026-10-09; absent in entries
   * filed before): restoring makes the space with this id when it is free,
   * so its Stack and its conversation — kept by that id — come back with it.
   * With it the entry IS the space, and may hold no tabs: an empty space
   * with a Stack filed and restored whole.
   */
  groupId?: string;
  group: { title: string; color: TabGroupColor; origin: TabGroupOrigin };
  /** Its tabs; empty only with `groupId`. */
  tabs: ArchivedTab[];
}

export type ArchiveEntry = ArchivedTabEntry | ArchivedGroupEntry;

export interface TabArchiveFile {
  version: typeof TAB_ARCHIVE_VERSION;
  /** Newest first. */
  entries: ArchiveEntry[];
}

export const EMPTY_TAB_ARCHIVE: TabArchiveFile = { version: TAB_ARCHIVE_VERSION, entries: [] };

/* ------------------------------- the view ------------------------------- */

export interface ArchivedTabView {
  title: string;
  url: string;
  faviconUrl: string | null;
  lastActiveAt: number;
}

export type ArchiveEntryView =
  | (ArchiveEntryBase & { kind: "tab"; tab: ArchivedTabView })
  | (ArchiveEntryBase & { kind: "group"; group: ArchivedGroupEntry["group"]; tabs: ArchivedTabView[]; groupId?: string });

function tabView(tab: ArchivedTab): ArchivedTabView {
  return { title: tab.title, url: tab.url, faviconUrl: tab.faviconUrl, lastActiveAt: tab.lastActiveAt };
}

export function archiveEntryView(entry: ArchiveEntry): ArchiveEntryView {
  const base: ArchiveEntryBase = {
    id: entry.id,
    spaceId: entry.spaceId,
    archivedAt: entry.archivedAt,
    reason: entry.reason,
    runId: entry.runId,
  };
  return entry.kind === "tab"
    ? { ...base, kind: "tab", tab: tabView(entry.tab) }
    : { ...base, kind: "group", group: entry.group, tabs: entry.tabs.map(tabView), ...(entry.groupId === undefined ? {} : { groupId: entry.groupId }) };
}

/** How many tabs an entry holds. */
export function archiveEntryTabCount(entry: ArchiveEntry | ArchiveEntryView): number {
  return entry.kind === "tab" ? 1 : entry.tabs.length;
}

/* ------------------------------- requests ------------------------------- */

export type TabArchiveRequest =
  | { type: "list"; spaceId: string }
  /** Reopen an entry — or, with `tabIndex`, one tab out of a group entry — in its Space, and show it. */
  | { type: "restore"; entryId: string; tabIndex?: number }
  | { type: "remove"; entryId: string }
  | { type: "clear"; spaceId: string };

export type TabArchiveResponse =
  | { type: "list"; entries: ArchiveEntryView[]; retentionDays: number }
  /** `reason`: why it was not done, in the person's words (a filed space the Profile has no room for). */
  | { type: "done"; ok: boolean; reason?: string };

const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,127}$/i;

export function isTabArchiveRequest(value: unknown): value is TabArchiveRequest {
  if (typeof value !== "object" || value === null) return false;
  const raw = value as Record<string, unknown>;
  const id = (key: string): boolean => typeof raw[key] === "string" && SAFE_ID.test(raw[key]);
  switch (raw["type"]) {
    case "list":
    case "clear":
      return id("spaceId");
    case "remove":
      return id("entryId");
    case "restore": {
      const index = raw["tabIndex"];
      return id("entryId") && (index === undefined || (typeof index === "number" && Number.isInteger(index) && index >= 0));
    }
    default:
      return false;
  }
}

/* ------------------------------- sanitize ------------------------------- */

function sanitizeFavicon(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 16_384) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "data:" ? value : null;
  } catch {
    return null;
  }
}

function time(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function sanitizeArchivedTab(value: unknown): ArchivedTab | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const rawUrl = typeof raw["url"] === "string" && raw["url"].length <= 2_048 ? raw["url"] : "";
  if (!isAllowedNavigation(rawUrl)) return null;
  const url = normalizeRestorableTabUrl(rawUrl);
  const history = sanitizeTabHistory(raw["history"]);
  const resume = sanitizePageResume(raw["resume"], url);
  return {
    title: typeof raw["title"] === "string" ? raw["title"].trim().slice(0, 240) : "",
    url,
    faviconUrl: sanitizeFavicon(raw["faviconUrl"]),
    lastActiveAt: time(raw["lastActiveAt"]),
    ...(history === null ? {} : { history }),
    ...(resume ? { resume } : {}),
  };
}

function sanitizeEntry(value: unknown): ArchiveEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const id = raw["id"];
  const spaceId = raw["spaceId"];
  if (typeof id !== "string" || !SAFE_ID.test(id) || typeof spaceId !== "string" || !SAFE_ID.test(spaceId)) return null;
  const runId = raw["runId"];
  const base: ArchiveEntryBase = {
    id,
    spaceId,
    archivedAt: time(raw["archivedAt"]),
    reason: raw["reason"] === "closed" ? "closed" : "idle",
    runId: typeof runId === "string" && SAFE_ID.test(runId) ? runId : null,
  };
  if (raw["kind"] === "tab") {
    const tab = sanitizeArchivedTab(raw["tab"]);
    return tab === null ? null : { ...base, kind: "tab", tab };
  }
  if (raw["kind"] !== "group" || !Array.isArray(raw["tabs"])) return null;
  const tabs = raw["tabs"].flatMap((candidate: unknown) => {
    const tab = sanitizeArchivedTab(candidate);
    return tab === null ? [] : [tab];
  });
  // A space's entry may be the space alone — but only one that says which space it is.
  const groupId = isTabGroupId(raw["groupId"]) ? raw["groupId"] : undefined;
  if (tabs.length === 0 && groupId === undefined) return null;
  const group = typeof raw["group"] === "object" && raw["group"] !== null ? (raw["group"] as Record<string, unknown>) : {};
  return {
    ...base,
    kind: "group",
    ...(groupId === undefined ? {} : { groupId }),
    group: {
      title: storedTabGroupTitle(group["title"]),
      color: isTabGroupColor(group["color"]) ? group["color"] : "gray",
      origin: group["origin"] === "auto" ? "auto" : "manual",
    },
    tabs: tabs.slice(0, MAX_ARCHIVED_GROUP_TABS),
  };
}

export function sanitizeTabArchive(value: unknown): TabArchiveFile {
  if (typeof value !== "object" || value === null) return structuredClone(EMPTY_TAB_ARCHIVE);
  const raw = value as Record<string, unknown>;
  if (raw["version"] !== TAB_ARCHIVE_VERSION || !Array.isArray(raw["entries"])) return structuredClone(EMPTY_TAB_ARCHIVE);
  const seen = new Set<string>();
  const entries: ArchiveEntry[] = [];
  for (const candidate of raw["entries"]) {
    const entry = sanitizeEntry(candidate);
    if (entry === null || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  entries.sort((a, b) => b.archivedAt - a.archivedAt);
  return { version: TAB_ARCHIVE_VERSION, entries: entries.slice(0, MAX_ARCHIVE_ENTRIES) };
}

/**
 * The archive after retention: entries older than `retentionDays` are gone,
 * and past MAX_ARCHIVE_ENTRIES the oldest go first. Returns the same array
 * when nothing lapsed.
 */
export function pruneArchive(entries: readonly ArchiveEntry[], now: number, retentionDays: number): readonly ArchiveEntry[] {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  const kept = entries.filter((entry) => entry.archivedAt >= cutoff).slice(0, MAX_ARCHIVE_ENTRIES);
  return kept.length === entries.length ? entries : kept;
}
