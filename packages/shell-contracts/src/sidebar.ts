/**
 * The sidebar's persistent shelf: favorites, pinned pages, and the folders
 * that group them. Shared between main (which owns the
 * file and applies every change) and the renderers (which only read it off
 * the snapshot and ask for changes with a SidebarCommand).
 *
 * Why main and not the renderer's localStorage: the shelf must survive a
 * restart and is read from the address bar as well as the sidebar, and main
 * is the one place that also sees the live tabs an entry binds to. So it
 * rides on ShellSnapshot like the tabs do.
 *
 * The model:
 *
 * - A FAVORITE is a page kept as an icon in the grid under the address bar.
 *   The organization's PRESET LINKS (settings.organization.presetLinks) show in
 *   the same grid ahead of the person's own, managed and never removable
 *   here; they are not stored in this file, only rendered beside it.
 * - A PIN is a page kept as a row above the day's tabs, optionally inside a
 *   FOLDER. Folders hold pins only, one level deep.
 * - An ANCHOR is what a live tab binds to: a pin's or favorite's id (or a
 *   preset's, `preset:<url>`). The tab carries it as BrowserTabInfo.anchorId.
 *   Closing an anchored tab closes the page but keeps the entry — the row
 *   dims, and clicking it opens the page again. That is what makes a pin a
 *   pin rather than a tab that happens to sit at the top.
 *
 * `entries` is ONE flat list in display order — folders and pins interleave
 * at the top level, and a pin inside a folder names it with `folderId`. The
 * tree the sidebar draws is derived (`topLevelOf`, `childrenOf`), and every
 * move is expressed as "into this container, at this index among its
 * children" (`placeEntry`), which is also how the drag reports a drop.
 *
 * Pure on purpose — no Electron, no DOM — so vitest pins it under node.
 */

import { isTabGroupColor, type TabGroupColor } from "./tab-groups.js";
import { isAllowedNavigation } from "./url.js";

export interface SidebarFavorite {
  id: string;
  url: string;
  title: string;
  faviconUrl: string | null;
}

/** A folder's colour is one of a tab group's (tab-groups.ts): the same eight names, the same tones in the chrome. */
export type SidebarFolderColor = TabGroupColor;

export interface SidebarFolder {
  kind: "folder";
  id: string;
  name: string;
  collapsed: boolean;
  /** The tone its icon is drawn in, or null for the chrome's own ink. */
  color: SidebarFolderColor | null;
  /** One emoji shown in place of the folder icon, or null for the icon. */
  emoji: string | null;
}

export interface SidebarPin {
  kind: "pin";
  id: string;
  url: string;
  title: string;
  faviconUrl: string | null;
  /** The folder this pin sits in, or null at the top level. */
  folderId: string | null;
}

export type SidebarEntry = SidebarFolder | SidebarPin;

export interface SidebarState {
  favorites: SidebarFavorite[];
  entries: SidebarEntry[];
}

export const DEFAULT_SIDEBAR_STATE: SidebarState = { favorites: [], entries: [] };

/** A preset's anchor id is its address: presets have no id of their own. */
export const PRESET_ANCHOR_PREFIX = "preset:";

export function presetAnchorId(url: string): string {
  return `${PRESET_ANCHOR_PREFIX}${url}`;
}

export function isPresetAnchorId(anchorId: string): boolean {
  return anchorId.startsWith(PRESET_ANCHOR_PREFIX);
}

/* ------------------------------ limits --------------------------------- */

export const MAX_FAVORITES = 24;
export const MAX_ENTRIES = 400;
export const MAX_TITLE = 200;
export const MAX_FOLDER_NAME = 60;
/** The longest emoji sequences (a family, a subdivision flag) run to a couple of dozen UTF-16 units. */
export const MAX_FOLDER_EMOJI = 32;
const MAX_ID = 128;
const MAX_URL = 2_048;

/* ----------------------------- sanitize -------------------------------- */

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID;
}

function isUrl(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_URL && isAllowedNavigation(value);
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function favicon(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_URL ? value : null;
}

const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u;

/**
 * A folder's emoji as the row draws it: the FIRST grapheme of what was typed
 * or pasted, and only if it is an emoji — a pictograph, a flag, a keycap —
 * so the 16px slot never holds a word. Anything else is null: the folder icon.
 */
export function folderEmoji(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const [first] = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(trimmed);
  const emoji = first?.segment ?? "";
  return emoji.length <= MAX_FOLDER_EMOJI && EMOJI.test(emoji) ? emoji : null;
}

/**
 * Fold unknown JSON (the file from an older build) into a valid state. A bad
 * item is dropped, never the whole file; a pin whose folder is gone comes
 * back at the top level; a folder holding nothing is kept — an empty folder
 * is a thing a person made.
 */
export function sanitizeSidebarState(input: unknown): SidebarState {
  if (typeof input !== "object" || input === null) return structuredClone(DEFAULT_SIDEBAR_STATE);
  const root = input as Record<string, unknown>;
  const seen = new Set<string>();
  const favorites: SidebarFavorite[] = [];
  if (Array.isArray(root["favorites"])) {
    for (const raw of root["favorites"] as unknown[]) {
      if (typeof raw !== "object" || raw === null) continue;
      const item = raw as Record<string, unknown>;
      if (!isId(item["id"]) || !isUrl(item["url"]) || seen.has(item["id"])) continue;
      seen.add(item["id"]);
      favorites.push({ id: item["id"], url: item["url"], title: text(item["title"], MAX_TITLE), faviconUrl: favicon(item["faviconUrl"]) });
      if (favorites.length === MAX_FAVORITES) break;
    }
  }
  const entries: SidebarEntry[] = [];
  const folderIds = new Set<string>();
  if (Array.isArray(root["entries"])) {
    for (const raw of root["entries"] as unknown[]) {
      if (typeof raw !== "object" || raw === null) continue;
      const item = raw as Record<string, unknown>;
      if (!isId(item["id"]) || seen.has(item["id"])) continue;
      if (item["kind"] === "folder") {
        seen.add(item["id"]);
        folderIds.add(item["id"]);
        entries.push({
          kind: "folder",
          id: item["id"],
          name: text(item["name"], MAX_FOLDER_NAME),
          collapsed: item["collapsed"] === true,
          color: isTabGroupColor(item["color"]) ? item["color"] : null,
          emoji: folderEmoji(item["emoji"]),
        });
      } else if (item["kind"] === "pin" && isUrl(item["url"])) {
        seen.add(item["id"]);
        entries.push({
          kind: "pin",
          id: item["id"],
          url: item["url"],
          title: text(item["title"], MAX_TITLE),
          faviconUrl: favicon(item["faviconUrl"]),
          folderId: isId(item["folderId"]) ? item["folderId"] : null,
        });
      }
      if (entries.length === MAX_ENTRIES) break;
    }
  }
  for (const entry of entries) {
    if (entry.kind === "pin" && entry.folderId !== null && !folderIds.has(entry.folderId)) entry.folderId = null;
  }
  return { favorites, entries };
}

/* ------------------------------- tree ---------------------------------- */

export function folderOf(state: SidebarState, folderId: string): SidebarFolder | null {
  const entry = state.entries.find((e) => e.id === folderId);
  return entry !== undefined && entry.kind === "folder" ? entry : null;
}

export function pinOf(state: SidebarState, pinId: string): SidebarPin | null {
  const entry = state.entries.find((e) => e.id === pinId);
  return entry !== undefined && entry.kind === "pin" ? entry : null;
}

export function favoriteOf(state: SidebarState, favoriteId: string): SidebarFavorite | null {
  return state.favorites.find((f) => f.id === favoriteId) ?? null;
}

/** The pins inside `folderId` (null: the top-level pins), in display order. */
export function childrenOf(entries: readonly SidebarEntry[], folderId: string | null): SidebarPin[] {
  return entries.filter((e): e is SidebarPin => e.kind === "pin" && e.folderId === folderId);
}

/** Folders and top-level pins, in display order — what the sidebar draws at depth 0. */
export function topLevelOf(entries: readonly SidebarEntry[]): SidebarEntry[] {
  return entries.filter((e) => e.kind === "folder" || e.folderId === null);
}

/**
 * Where an entry goes: a container (a folder, or null for the top level)
 * and an index among that container's children as the sidebar shows them.
 * The flat list's order inside a container is display order, so placing
 * means "just before the child currently at `index`", or at the end.
 */
export interface Placement {
  folderId: string | null;
  index: number;
}

/**
 * Put `entry` into the list at `at`, replacing any existing entry with the
 * same id (a move is a remove and a place). A folder can only be placed at
 * the top level; a pin placed in an unknown folder lands at the top level.
 */
export function placeEntry(entries: readonly SidebarEntry[], entry: SidebarEntry, at: Placement): SidebarEntry[] {
  const rest = entries.filter((e) => e.id !== entry.id);
  const folderExists = at.folderId !== null && rest.some((e) => e.kind === "folder" && e.id === at.folderId);
  const folderId = entry.kind === "folder" || !folderExists ? null : at.folderId;
  const placed: SidebarEntry = entry.kind === "pin" ? { ...entry, folderId } : { ...entry };
  // The siblings the index counts: a folder's children, or the top level.
  const siblings = folderId === null ? topLevelOf(rest) : childrenOf(rest, folderId);
  const index = Math.max(0, Math.min(Math.floor(at.index), siblings.length));
  if (index >= siblings.length) {
    // After the container's last child — which, for a folder, means right
    // after its last pin so the folder's run stays contiguous; and for the
    // top level, the end of the list. An empty folder: right after its header.
    if (folderId === null) return [...rest, placed];
    const lastChild = siblings.at(-1);
    const anchor = lastChild === undefined ? rest.findIndex((e) => e.id === folderId) : rest.findIndex((e) => e.id === lastChild.id);
    return [...rest.slice(0, anchor + 1), placed, ...rest.slice(anchor + 1)];
  }
  const before = siblings[index];
  if (before === undefined) return [...rest, placed];
  const flat = rest.findIndex((e) => e.id === before.id);
  return [...rest.slice(0, flat), placed, ...rest.slice(flat)];
}

/** Drop an entry; a folder takes its pins to the top level, where it stood. */
export function removeEntry(entries: readonly SidebarEntry[], id: string): SidebarEntry[] {
  const target = entries.find((e) => e.id === id);
  if (target === undefined) return [...entries];
  if (target.kind === "pin") return entries.filter((e) => e.id !== id);
  const out: SidebarEntry[] = [];
  const orphans = childrenOf(entries, id).map<SidebarEntry>((pin) => ({ ...pin, folderId: null }));
  for (const entry of entries) {
    if (entry.id === id) {
      out.push(...orphans);
      continue;
    }
    if (entry.kind === "pin" && entry.folderId === id) continue;
    out.push(entry);
  }
  return out;
}

/** A favorite placed at `index` among the person's own favorites (presets are not in this list). */
export function placeFavorite(favorites: readonly SidebarFavorite[], favorite: SidebarFavorite, index: number): SidebarFavorite[] {
  const rest = favorites.filter((f) => f.id !== favorite.id);
  const at = Math.max(0, Math.min(Math.floor(index), rest.length));
  return [...rest.slice(0, at), favorite, ...rest.slice(at)];
}

/* ----------------------------- commands -------------------------------- */

/** How a favorite comes to be: from a live tab, from a pin (which it replaces), or from an address. */
export type FavoriteSource = { tabId: string } | { pinId: string } | { url: string; title: string };

/**
 * What a renderer asks main to do to the shelf. Main resolves each against
 * the live tabs (a pin's tab, a favorite's tab) and the store, then
 * publishes a snapshot; the renderer never edits the shelf itself.
 */
export type SidebarCommand =
  /** Show the page behind an anchor: its live tab if there is one, else a new tab bound to it. */
  | { type: "open"; anchorId: string }
  /** Keep a live tab as a pin, at a place in the tree. */
  | { type: "pinTab"; tabId: string; folderId: string | null; index: number }
  /** Drop a pin; its live tab (if any) becomes a day tab at `index` among them. Without a live tab, `index` opens one. */
  | { type: "unpin"; pinId: string; index?: number }
  | { type: "movePin"; pinId: string; folderId: string | null; index: number }
  /** Take a pin's live tab back to the address it was pinned at. */
  | { type: "returnToPinned"; pinId: string }
  /** `id` lets the renderer name the folder it is about to rename in place; an id already taken is ignored. */
  | { type: "createFolder"; name: string; id?: string; index?: number; pinIds?: string[] }
  | { type: "renameFolder"; folderId: string; name: string }
  /** Recolour a folder, swap its icon for an emoji, or both; null puts the default back, a field left out is left alone. */
  | { type: "styleFolder"; folderId: string; color?: SidebarFolderColor | null; emoji?: string | null }
  /** Delete the folder alone, or delete its saved pins too; pages behind removed pins become day tabs. */
  | { type: "deleteFolder"; folderId: string; includePins?: boolean }
  | { type: "toggleFolder"; folderId: string }
  | { type: "moveFolder"; folderId: string; index: number }
  | { type: "addFavorite"; source: FavoriteSource; index?: number }
  /** Drop a favorite; its live tab (if any) becomes a day tab at `index` among them. */
  | { type: "removeFavorite"; favoriteId: string; index?: number }
  | { type: "moveFavorite"; favoriteId: string; index: number }
  /** A favorite becomes a pin at a place in the tree, its live tab following. */
  | { type: "favoriteToPin"; favoriteId: string; folderId: string | null; index: number };

function isIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10_000;
}

function isOptionalIndex(value: unknown): value is number | undefined {
  return value === undefined || isIndex(value);
}

function isFolderRef(value: unknown): value is string | null {
  return value === null || isId(value);
}

function isFavoriteSource(value: unknown): value is FavoriteSource {
  if (typeof value !== "object" || value === null) return false;
  const source = value as Record<string, unknown>;
  if ("tabId" in source) return isId(source["tabId"]);
  if ("pinId" in source) return isId(source["pinId"]);
  return isUrl(source["url"]) && typeof source["title"] === "string" && source["title"].length <= MAX_TITLE;
}

/** Guards a value from another process: every field of every variant. */
export function isSidebarCommand(value: unknown): value is SidebarCommand {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  switch (c["type"]) {
    case "open":
      return isId(c["anchorId"]) && (c["anchorId"] as string).length <= MAX_URL + PRESET_ANCHOR_PREFIX.length;
    case "pinTab":
      return isId(c["tabId"]) && isFolderRef(c["folderId"]) && isIndex(c["index"]);
    case "unpin":
      return isId(c["pinId"]) && isOptionalIndex(c["index"]);
    case "movePin":
      return isId(c["pinId"]) && isFolderRef(c["folderId"]) && isIndex(c["index"]);
    case "returnToPinned":
      return isId(c["pinId"]);
    case "createFolder":
      return (
        typeof c["name"] === "string" &&
        c["name"].length <= MAX_FOLDER_NAME &&
        (c["id"] === undefined || isId(c["id"])) &&
        isOptionalIndex(c["index"]) &&
        (c["pinIds"] === undefined || (Array.isArray(c["pinIds"]) && c["pinIds"].every(isId) && c["pinIds"].length <= MAX_ENTRIES))
      );
    case "renameFolder":
      return isId(c["folderId"]) && typeof c["name"] === "string" && c["name"].length <= MAX_FOLDER_NAME;
    case "styleFolder":
      return (
        isId(c["folderId"]) &&
        (c["color"] === undefined || c["color"] === null || isTabGroupColor(c["color"])) &&
        (c["emoji"] === undefined || c["emoji"] === null || (typeof c["emoji"] === "string" && c["emoji"].length <= MAX_FOLDER_EMOJI))
      );
    case "deleteFolder":
      return isId(c["folderId"]) && (c["includePins"] === undefined || typeof c["includePins"] === "boolean");
    case "toggleFolder":
      return isId(c["folderId"]);
    case "moveFolder":
      return isId(c["folderId"]) && isIndex(c["index"]);
    case "addFavorite":
      return isFavoriteSource(c["source"]) && isOptionalIndex(c["index"]);
    case "removeFavorite":
      return isId(c["favoriteId"]) && isOptionalIndex(c["index"]);
    case "moveFavorite":
      return isId(c["favoriteId"]) && isIndex(c["index"]);
    case "favoriteToPin":
      return isId(c["favoriteId"]) && isFolderRef(c["folderId"]) && isIndex(c["index"]);
    default:
      return false;
  }
}
