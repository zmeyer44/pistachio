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

/**
 * One window on the desk, as the agent is told of it: a tab's page, or one
 * of the group's context files open as a document (docs/desk-documents.md),
 * whose id is `file:<the item's id>` (fileWindowId).
 */
export interface DeskAgentWindow {
  /** The window's id: its tab's, or `file:<item id>` for a document. */
  tabId: string;
  kind: "tab" | "file";
  title: string;
  /** The tab's address; "" for a document. */
  url: string;
  box: DeskPercentBox;
  /** The window in use (it has the keyboard when the person is in a page). */
  focused: boolean;
  /** Only part of its page shows (the desk's mask). */
  masked: boolean;
  /** Minimized: small, its page zoomed out, most often parked at the desk's foot. Placing it gives it its size back. */
  minimized?: boolean;
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
 * A document's window on the desk (docs/desk-documents.md): a context
 * file's, named `file:<its item id>` — never a tab id, which are UUIDs.
 */
export const FILE_WINDOW_PREFIX = "file:";

export function fileWindowId(itemId: string): string {
  return `${FILE_WINDOW_PREFIX}${itemId}`;
}

/** The context item a document window shows, or null for a tab's window. */
export function fileItemOf(windowId: string): string | null {
  return windowId.startsWith(FILE_WINDOW_PREFIX) ? windowId.slice(FILE_WINDOW_PREFIX.length) : null;
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
      return (
        (entry["kind"] === "tab" || entry["kind"] === "file") &&
        isDeskPercentBox(entry["box"]) &&
        typeof entry["focused"] === "boolean" &&
        typeof entry["masked"] === "boolean" &&
        (entry["minimized"] === undefined || typeof entry["minimized"] === "boolean")
      );
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
      const marks = [window.focused ? "in use" : "", window.masked ? "masked" : "", window.minimized === true ? "minimized" : ""].filter((mark) => mark !== "").join(", ");
      const what = window.kind === "file" ? `document ${window.tabId} “${window.title}”` : `tab ${window.tabId} “${window.title}” ${window.url}`;
      lines.push(`- ${what} — ${box(window.box)}${marks === "" ? "" : ` — ${marks}`}`);
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
/** Word and Excel files, as the Stack keeps them (docs/desk-documents.md). */
export const DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const DOC_MEDIA_TYPE = "application/msword";
export const XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * What the Stack takes: what the agent can read, and what the desk opens as
 * a document window (docs/desk-documents.md). Pictures the model cannot
 * look at as they are (SVG, BMP, AVIF, HEIC, TIFF) and Word and Excel
 * files are turned into what it can read when it reads them.
 */
export const GROUP_CONTEXT_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
  "image/bmp",
  "image/avif",
  "image/heic",
  "image/heif",
  "image/tiff",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/calendar",
  "application/json",
  DOCX_MEDIA_TYPE,
  DOC_MEDIA_TYPE,
  XLSX_MEDIA_TYPE,
] as const;
export type GroupContextMediaType = (typeof GROUP_CONTEXT_MEDIA_TYPES)[number];

export function isGroupContextMediaType(value: unknown): value is GroupContextMediaType {
  return typeof value === "string" && (GROUP_CONTEXT_MEDIA_TYPES as readonly string[]).includes(value);
}

/** Text the agent reads as text; the rest (images, PDFs) it sees as files. */
export function isTextMediaType(mediaType: string): boolean {
  return mediaType.startsWith("text/") || mediaType === "application/json";
}

const MEDIA_TYPE_BY_EXTENSION: Record<string, GroupContextMediaType> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  avif: "image/avif",
  heic: "image/heic",
  heif: "image/heif",
  tif: "image/tiff",
  tiff: "image/tiff",
  pdf: "application/pdf",
  txt: "text/plain",
  text: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  ics: "text/calendar",
  json: "application/json",
  docx: DOCX_MEDIA_TYPE,
  doc: DOC_MEDIA_TYPE,
  xlsx: XLSX_MEDIA_TYPE,
};

/**
 * The media type a file is kept as: its extension's when it names a kind
 * the Stack takes (Finder reports nothing for many text files, and the
 * extension is what the person sees), else the one the drop reported, when
 * that is such a kind. Null for anything else.
 */
export function groupContextMediaTypeOf(name: string, reported: string): GroupContextMediaType | null {
  const extension = name.toLowerCase().split(".").pop() ?? "";
  const byName = name.includes(".") ? MEDIA_TYPE_BY_EXTENSION[extension] : undefined;
  if (byName !== undefined) return byName;
  const type = reported.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "image/jpg") return "image/jpeg";
  return isGroupContextMediaType(type) ? type : null;
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
  /** When its bytes were last changed on the desk (a document edited in its window). */
  editedAt?: string;
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
  /** The files taken, as items — one already in the context (the same bytes dropped again) is that item. */
  added?: Array<{ id: string; name: string }>;
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
    return {
      id: item["id"],
      kind: "file",
      name: item["name"],
      mediaType: item["mediaType"],
      byteLength,
      blobId: item["blobId"],
      addedAt: item["addedAt"],
      addedBy,
      ...(typeof item["editedAt"] === "string" ? { editedAt: item["editedAt"] } : {}),
    };
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
  const lines = ["The group's context (files and facts kept for this task; read one with context_read; a file opens on the desk as the document file:<its id>):"];
  for (const item of items) {
    if (item.kind === "file") lines.push(`- ${item.id} file “${item.name}” (${item.mediaType}, ${String(Math.max(1, Math.round(item.byteLength / 1024)))} KB)`);
    else {
      const text = item.text.length > 200 ? `${item.text.slice(0, 200)}…` : item.text;
      lines.push(`- ${item.id} ${item.kind} “${text.replace(/\s+/g, " ")}”${item.url === undefined ? "" : ` from ${item.url}`}`);
    }
  }
  return lines;
}

/* ---------------------------- document windows ---------------------------- */

/**
 * A context file's bytes, for its window on the desk (docs/desk-documents.md).
 * `shown` is what the window draws instead when the shell cannot draw the
 * file itself: a Word 97–2004 document as a .docx, a HEIC or TIFF picture as
 * a PNG (macOS converts them).
 */
export interface GroupFileContent {
  itemId: string;
  blobId: string;
  name: string;
  mediaType: GroupContextMediaType;
  bytes: Uint8Array;
  shown?: { mediaType: string; bytes: Uint8Array };
}

/**
 * A document edited in its window, saved: its new bytes, over the version
 * it was edited from (`baseBlobId`) — refused if the file has changed since
 * (another Mac, another window), so nobody's edit is silently lost. `as`
 * says the bytes are a .docx to be kept as the item's own kind (a .doc).
 */
export interface GroupFileWrite {
  groupId: string;
  itemId: string;
  baseBlobId: string;
  bytes: Uint8Array;
  as?: "docx";
  /** Write over a version changed since, the person having chosen to keep theirs. */
  force?: boolean;
}

export type GroupFileWriteResult =
  | { ok: true; item: GroupContextFile }
  | { ok: false; reason: "changed" | "gone" | "too-large" | "failed"; message: string };

export function isGroupFileWrite(value: unknown): value is GroupFileWrite {
  if (typeof value !== "object" || value === null) return false;
  const write = value as Record<string, unknown>;
  return (
    isId(write["groupId"]) &&
    isGroupContextItemId(write["itemId"]) &&
    isGroupBlobId(write["baseBlobId"]) &&
    write["bytes"] instanceof Uint8Array &&
    (write["as"] === undefined || write["as"] === "docx") &&
    (write["force"] === undefined || typeof write["force"] === "boolean")
  );
}

/**
 * A context file as a message carries it when the person @mentions it in
 * the Bar: its text, or the file itself for the model to look at — or, too
 * large to attach, neither (the agent can still read it with context_read).
 */
export type GroupFileForMessage =
  | { kind: "text"; name: string; text: string }
  | { kind: "file"; name: string; mediaType: string; dataUrl: string }
  | { kind: "reference"; name: string; reason: string };

/** How a document window draws a context file (docs/desk-documents.md §2). */
export type FileViewerKind = "text" | "markdown" | "document" | "sheet" | "image" | "pdf";

export function fileViewerKind(mediaType: string): FileViewerKind | null {
  if (mediaType === "text/markdown") return "markdown";
  if (mediaType === "text/plain" || mediaType === "application/json" || mediaType === "text/calendar") return "text";
  if (mediaType === DOCX_MEDIA_TYPE || mediaType === DOC_MEDIA_TYPE) return "document";
  if (mediaType === XLSX_MEDIA_TYPE || mediaType === "text/csv") return "sheet";
  if (mediaType === "application/pdf") return "pdf";
  if (mediaType.startsWith("image/")) return "image";
  return null;
}
