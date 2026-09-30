/**
 * The desk's agent (docs/desk-agent.md): what main and the shell tell each
 * other so the agent can work at a tab group's desk — the desk as the agent
 * is told of it, the requests main makes of the shell's desk (which only
 * the shell can answer: the layout is its engine's), the desk's
 * conversation, and the group's context (its files and facts).
 *
 * Pure on purpose — no Electron, no DOM — so vitest pins the guards under node.
 */

/* ------------------------------- the desk -------------------------------- */

/** A box as whole percents of the desk (0–100), which is what the agent reads and writes. */
export interface DeskPercentBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One window on the desk, as the agent is told of it. */
export interface DeskAgentWindow {
  tabId: string;
  title: string;
  url: string;
  box: DeskPercentBox;
  /** The window in use (it has the keyboard when the person is in a page). */
  focused: boolean;
  /** Only part of its page shows (the desk's mask). */
  masked: boolean;
}

/** The desk as it stands: windows bottom to top, and the group's tabs that are in the dock. */
export interface DeskAgentState {
  groupId: string;
  title: string;
  windows: DeskAgentWindow[];
  docked: Array<{ tabId: string; title: string; url: string }>;
}

/** Where the agent can put a window: a half, a quarter, the middle, or the whole desk. */
export const DESK_ZONES = ["left", "right", "top", "bottom", "top-left", "top-right", "bottom-left", "bottom-right", "center", "full"] as const;
export type DeskZone = (typeof DESK_ZONES)[number];

export function isDeskZone(value: unknown): value is DeskZone {
  return typeof value === "string" && (DESK_ZONES as readonly string[]).includes(value);
}

/**
 * A change to the desk's layout, all at once. `layout` tiles or cascades
 * every window first; `place` then puts named windows in a zone or a box
 * (a docked tab named there comes out to it); `putAway` sends windows into
 * the dock; `bringOut` brings docked tabs out where the desk has room.
 */
export interface DeskArrangePlan {
  layout?: "tile" | "cascade";
  place?: Array<{ tabId: string; zone?: DeskZone; box?: DeskPercentBox }>;
  putAway?: string[];
  bringOut?: string[];
}

/**
 * What main asks of the shell's desk. Each is answered with the desk as it
 * then stands. Each names the group whose desk it is for: the person may
 * have passed the desk to another group since, and the shell refuses a
 * request for a desk not in view before it changes anything.
 */
export type DeskRequest =
  | { type: "state"; groupId: string }
  | { type: "arrange"; groupId: string; plan: DeskArrangePlan }
  /** A tab the agent opened: out onto the desk without the keyboard or the selection. */
  | { type: "bringOut"; groupId: string; tabId: string }
  /** A short note on a window's frame, or none. */
  | { type: "note"; groupId: string; tabId: string; text: string | null };

export type DeskReply = { ok: true; state: DeskAgentState } | { ok: false; error: string };

export const MAX_DESK_NOTE_CHARS = 80;
/** The longest title and address, and the most tabs in the dock, a desk reply carries (isDeskAgentState). */
export const MAX_DESK_TITLE = 300;
export const MAX_DESK_URL = 2_048;
const MAX_TITLE = MAX_DESK_TITLE;
const MAX_URL = MAX_DESK_URL;
const MAX_WINDOWS = 64;
export const MAX_DESK_DOCKED = MAX_WINDOWS * 4;

function isString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

function isPercent(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -100 && value <= 200;
}

export function isDeskPercentBox(value: unknown): value is DeskPercentBox {
  if (typeof value !== "object" || value === null) return false;
  const box = value as Record<string, unknown>;
  return isPercent(box["x"]) && isPercent(box["y"]) && isPercent(box["w"]) && isPercent(box["h"]);
}

function isTabRef(value: unknown): value is { tabId: string; title: string; url: string } {
  if (typeof value !== "object" || value === null) return false;
  const tab = value as Record<string, unknown>;
  return isString(tab["tabId"], 192) && tab["tabId"] !== "" && isString(tab["title"], MAX_TITLE) && isString(tab["url"], MAX_URL);
}

/** The shell's desk, as main believes it: shapes checked and sizes bounded. */
export function isDeskAgentState(value: unknown): value is DeskAgentState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  if (!isString(state["groupId"], 192) || !isString(state["title"], MAX_TITLE)) return false;
  const windows = state["windows"];
  const docked = state["docked"];
  if (!Array.isArray(windows) || windows.length > MAX_WINDOWS || !Array.isArray(docked) || docked.length > MAX_DESK_DOCKED) return false;
  return (
    windows.every((window: unknown) => {
      if (!isTabRef(window)) return false;
      const entry = window as unknown as Record<string, unknown>;
      return isDeskPercentBox(entry["box"]) && typeof entry["focused"] === "boolean" && typeof entry["masked"] === "boolean";
    }) && docked.every(isTabRef)
  );
}

export function isDeskReply(value: unknown): value is DeskReply {
  if (typeof value !== "object" || value === null) return false;
  const reply = value as Record<string, unknown>;
  if (reply["ok"] === true) return isDeskAgentState(reply["state"]);
  return reply["ok"] === false && isString(reply["error"], 2_000);
}

/**
 * The desk as the model reads it, a line per window (docs/desk-agent.md §2):
 * which group, every window bottom to top with its box, the tabs in the
 * dock. The context's items are the caller's to add (main holds them).
 */
export function deskStateLines(state: DeskAgentState): string[] {
  const box = (b: DeskPercentBox): string => `${String(Math.round(b.x))} ${String(Math.round(b.y))} ${String(Math.round(b.w))} ${String(Math.round(b.h))}`;
  const lines = [`Desk: the tab group “${state.title}” (${String(state.windows.length + state.docked.length)} tabs).`];
  if (state.windows.length === 0) lines.push("No windows are out on the desk.");
  else {
    lines.push("Windows, bottom to top (x y w h as % of the desk):");
    for (const window of state.windows) {
      const marks = [window.focused ? "in use" : "", window.masked ? "masked" : ""].filter((mark) => mark !== "").join(", ");
      lines.push(`- tab ${window.tabId} “${window.title}” ${window.url} — ${box(window.box)}${marks === "" ? "" : ` — ${marks}`}`);
    }
  }
  if (state.docked.length > 0) {
    lines.push("In the dock (the group's tabs not out on the desk):");
    for (const tab of state.docked) lines.push(`- tab ${tab.tabId} “${tab.title}” ${tab.url}`);
  }
  return lines;
}

/* ---------------------------- the conversation ---------------------------- */

/**
 * The desk's conversation: the shell says when a desk is up and for which
 * group (`enter`, again for each group it passes to), when it is left, and
 * what the person chose — an existing conversation to continue in this
 * group, or a new one.
 */
export type DeskConversationCommand =
  | { type: "enter"; groupId: string }
  | { type: "leave" }
  | { type: "choose"; groupId: string; runId: string }
  | { type: "new"; groupId: string };

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,127}$/i.test(value);
}

export function isDeskConversationCommand(value: unknown): value is DeskConversationCommand {
  if (typeof value !== "object" || value === null) return false;
  const command = value as Record<string, unknown>;
  switch (command["type"]) {
    case "enter":
    case "new":
      return isId(command["groupId"]);
    case "leave":
      return true;
    case "choose":
      return isId(command["groupId"]) && isId(command["runId"]);
    default:
      return false;
  }
}

/* ----------------------------- group context ----------------------------- */

/** How much a group's context holds, and how big what it holds may be. */
export const MAX_GROUP_CONTEXT_ITEMS = 60;
export const MAX_GROUP_TEXT_CHARS = 4_000;
/** A file dropped on the Stack may be this large on the Mac it was dropped on. */
export const MAX_GROUP_FILE_BYTES = 20 * 1024 * 1024;
/** A file syncs to the person's other Macs only up to this size (it must fit the sync hub's frame budget once sealed). */
export const MAX_GROUP_BLOB_BYTES = 2 * 1024 * 1024;
/** What the agent can read, and so what the Stack takes. */
export const GROUP_CONTEXT_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/calendar",
  "application/json",
] as const;
export type GroupContextMediaType = (typeof GROUP_CONTEXT_MEDIA_TYPES)[number];

export function isGroupContextMediaType(value: unknown): value is GroupContextMediaType {
  return typeof value === "string" && (GROUP_CONTEXT_MEDIA_TYPES as readonly string[]).includes(value);
}

/** Text the agent reads as text; the rest (images, PDFs) it sees as files. */
export function isTextMediaType(mediaType: string): boolean {
  return mediaType.startsWith("text/") || mediaType === "application/json";
}

export type GroupContextAuthor = "person" | "agent";

/** A file in a group's context. Its bytes are `group-blob:<blobId>`, content-addressed. */
export interface GroupContextFile {
  id: string;
  kind: "file";
  name: string;
  mediaType: GroupContextMediaType;
  byteLength: number;
  /** sha256 of the bytes, 24 hex digits. */
  blobId: string;
  addedAt: string;
  addedBy: GroupContextAuthor;
}

/** A fact, a snippet of a page, or a link, kept as text. */
export interface GroupContextText {
  id: string;
  kind: "fact" | "snippet" | "link";
  text: string;
  /** Where it came from: a page's title and address. */
  title?: string;
  url?: string;
  addedAt: string;
  addedBy: GroupContextAuthor;
}

export type GroupContextItem = GroupContextFile | GroupContextText;

/** A context file's bytes, as main keeps and syncs them (`group-blob:<id>`). */
export interface GroupBlob {
  /** sha256 of the bytes, 24 hex digits. */
  id: string;
  mediaType: GroupContextMediaType;
  byteLength: number;
  /** base64 */
  data: string;
  createdAt: string;
}

/** One group's context: its title when last written (so another Mac can name it), and its items, oldest first. */
export interface GroupContext {
  groupId: string;
  title: string;
  items: GroupContextItem[];
  updatedAt: string;
}

/** A group's context as the shell draws it: each file says whether its bytes are on this Mac. */
export interface GroupContextView {
  groupId: string;
  title: string;
  items: Array<GroupContextItem & { here: boolean }>;
  updatedAt: string;
}

/** What the Stack asks of main. A file comes as base64; `title` is the group's, for another Mac to name the context by. */
export type GroupContextCommand =
  | { type: "addFiles"; groupId: string; title: string; files: Array<{ name: string; mediaType: string; data: string }> }
  | { type: "addText"; groupId: string; title: string; kind: "fact" | "snippet" | "link"; text: string; url?: string; sourceTitle?: string }
  | { type: "remove"; groupId: string; itemId: string }
  /** Open a file in the app the Mac opens it with. */
  | { type: "open"; groupId: string; itemId: string }
  /** Copy another group's context (from another Mac, its group not here) into this group's. */
  | { type: "adopt"; groupId: string; title: string; fromGroupId: string };

export interface GroupContextResult {
  /** Files that were not taken, and why (too large, not a kind the agent can read). */
  rejected: Array<{ name: string; reason: string }>;
}

const ITEM_ID = /^[a-f0-9]{12}$/;
const BLOB_ID = /^[a-f0-9]{24}$/;

export function isGroupContextItemId(value: unknown): value is string {
  return typeof value === "string" && ITEM_ID.test(value);
}

export function isGroupBlobId(value: unknown): value is string {
  return typeof value === "string" && BLOB_ID.test(value);
}

export function isGroupContextCommand(value: unknown): value is GroupContextCommand {
  if (typeof value !== "object" || value === null) return false;
  const command = value as Record<string, unknown>;
  const group = isId(command["groupId"]);
  switch (command["type"]) {
    case "addFiles": {
      const files = command["files"];
      return (
        group &&
        isString(command["title"], MAX_TITLE) &&
        Array.isArray(files) &&
        files.length > 0 &&
        files.length <= 20 &&
        files.every((file: unknown) => {
          if (typeof file !== "object" || file === null) return false;
          const entry = file as Record<string, unknown>;
          return isString(entry["name"], 255) && isString(entry["mediaType"], 120) && typeof entry["data"] === "string";
        })
      );
    }
    case "addText":
      return (
        group &&
        isString(command["title"], MAX_TITLE) &&
        (command["kind"] === "fact" || command["kind"] === "snippet" || command["kind"] === "link") &&
        isString(command["text"], MAX_GROUP_TEXT_CHARS * 4) &&
        (command["url"] === undefined || isString(command["url"], MAX_URL)) &&
        (command["sourceTitle"] === undefined || isString(command["sourceTitle"], MAX_TITLE))
      );
    case "remove":
    case "open":
      return group && isGroupContextItemId(command["itemId"]);
    case "adopt":
      return group && isString(command["title"], MAX_TITLE) && isId(command["fromGroupId"]);
    default:
      return false;
  }
}

function sanitizeItem(value: unknown): GroupContextItem | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Record<string, unknown>;
  if (!isGroupContextItemId(item["id"]) || typeof item["addedAt"] !== "string") return null;
  const addedBy: GroupContextAuthor = item["addedBy"] === "agent" ? "agent" : "person";
  if (item["kind"] === "file") {
    const byteLength = item["byteLength"];
    if (
      !isString(item["name"], 255) ||
      !isGroupContextMediaType(item["mediaType"]) ||
      typeof byteLength !== "number" ||
      !Number.isInteger(byteLength) ||
      byteLength < 0 ||
      byteLength > MAX_GROUP_FILE_BYTES ||
      !isGroupBlobId(item["blobId"])
    )
      return null;
    return { id: item["id"], kind: "file", name: item["name"], mediaType: item["mediaType"], byteLength, blobId: item["blobId"], addedAt: item["addedAt"], addedBy };
  }
  if (item["kind"] !== "fact" && item["kind"] !== "snippet" && item["kind"] !== "link") return null;
  if (!isString(item["text"], MAX_GROUP_TEXT_CHARS) || item["text"].trim() === "") return null;
  return {
    id: item["id"],
    kind: item["kind"],
    text: item["text"],
    ...(isString(item["title"], MAX_TITLE) ? { title: item["title"] } : {}),
    ...(isString(item["url"], MAX_URL) ? { url: item["url"] } : {}),
    addedAt: item["addedAt"],
    addedBy,
  };
}

/** A group's context read back from disk or handed over by another Mac: bad items dropped, bounds kept. */
export function sanitizeGroupContext(value: unknown): GroupContext | null {
  if (typeof value !== "object" || value === null) return null;
  const context = value as Record<string, unknown>;
  if (!isId(context["groupId"]) || !Array.isArray(context["items"])) return null;
  const items: GroupContextItem[] = [];
  const seen = new Set<string>();
  for (const raw of context["items"]) {
    const item = sanitizeItem(raw);
    if (item === null || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  return {
    groupId: context["groupId"],
    title: isString(context["title"], MAX_TITLE) ? context["title"] : "",
    items: items.slice(-MAX_GROUP_CONTEXT_ITEMS),
    updatedAt: typeof context["updatedAt"] === "string" ? context["updatedAt"] : new Date(0).toISOString(),
  };
}

/** The context's items as the model reads them in the desk block: id, kind, and what each is. */
export function groupContextLines(items: readonly GroupContextItem[]): string[] {
  if (items.length === 0) return ["The group's context is empty (the person can drop files and facts on the dock's Stack; save useful facts with context_save)."];
  const lines = ["The group's context (files and facts kept for this task; read one with context_read):"];
  for (const item of items) {
    if (item.kind === "file") lines.push(`- ${item.id} file “${item.name}” (${item.mediaType}, ${String(Math.max(1, Math.round(item.byteLength / 1024)))} KB)`);
    else {
      const text = item.text.length > 200 ? `${item.text.slice(0, 200)}…` : item.text;
      lines.push(`- ${item.id} ${item.kind} “${text.replace(/\s+/g, " ")}”${item.url === undefined ? "" : ` from ${item.url}`}`);
    }
  }
  return lines;
}
