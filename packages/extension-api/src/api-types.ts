/**
 * The data shapes the API passes (docs/extensions.md §5), importable by main
 * and the preload. `pistachio.d.ts` declares the same shapes for authors as
 * an ambient global; a test keeps the two in step.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type ExtContext = "worker" | "panel" | "page";

export interface ExtTab {
  id: string;
  spaceId: string | null;
  profileId: string;
  title: string;
  url: string;
  favIconUrl: string | null;
  active: boolean;
  loading: boolean;
  kind: "page" | "shell" | "extension";
  /** When it was last in use, ms since 1970 — for a tab opened behind others and not looked at yet, when it was opened. */
  lastActiveAt: number;
}

export interface ExtSpace {
  id: string;
  name: string;
  color: string | null;
  tabIds: string[];
  /** When any tab of it was last in use, ms since 1970; 0 for a space with no tabs. */
  lastActiveAt: number;
  /**
   * The person's: they made it or made it theirs (named it, moved a tab into it, keep a Stack or a conversation in
   * it), or it grew from a tab of their own — and a Home tab's or a favorite's page's always is. False only for a
   * space Pistachio gathered by itself (Tidy) that nobody has touched since: what Tidy itself may file when idle.
   */
  byPerson: boolean;
}

/**
 * A space that is away (docs/primitives.md §2): off the rail, its tabs asleep, to come back as itself — at `until`
 * by Pistachio's own clock, or when asked. `mine`: this extension sent it.
 */
export interface ExtAwaySpace {
  id: string;
  name: string;
  color: string | null;
  tabCount: number;
  /** When it went, ms since 1970. */
  since: number;
  /** When it is due back, ms since 1970; absent, it stays away until someone brings it back. */
  until?: number;
  mine: boolean;
}

/** What lies behind a space's windows (./theme.ts backdropSchema): a colour, a gradient, or a picture of the extension's folder. */
export type ExtBackdrop =
  | { color: string }
  | { gradient: { colors: string[]; angle?: number } }
  | { image: string; fit?: "cover" | "contain" | "tile"; dim?: number };

/**
 * A theme the shell draws for an extension (docs/primitives.md §4): a backdrop for the desk and an accent colour,
 * for every space or — `spaceId` — for one the person gave it. Main keeps it; nothing of the extension's runs to
 * keep it there.
 */
export interface ExtTheme {
  backdrop?: ExtBackdrop | null;
  colors?: { accent?: string };
  spaceId?: string;
}

/** A small mark on a space's tile (./theme.ts markSchema). */
export interface ExtSpaceMark {
  glyph?: string;
  tone?: "neutral" | "green" | "amber" | "red" | "blue";
  label: string;
}

/** A row's leading mark (./sites.ts rowMarkSchema): a glyph — a dot when left out — in a tone. */
export interface ExtRowMark {
  glyph?: string;
  tone?: "neutral" | "green" | "amber" | "red" | "blue";
}

/**
 * One row of the band or of a sidebar section (./sites.ts rowSchema): the shell's own row, filled by the extension.
 * With an `id` it can be pressed; its `buttons` are pressed on their own.
 */
export interface ExtRow {
  id?: string;
  mark?: ExtRowMark;
  text: string;
  /** Said after the text, quieter. */
  detail?: string;
  /** At the row's trailing end, in figures that line up: a score, a count, a time. */
  value?: string;
  buttons?: { id: string; title: string }[];
}

/**
 * What an extension has a place showing (docs/primitives.md §4.5): for every space or — `spaceId` — for one the
 * person gave it. `title` heads a sidebar section. Main keeps it; nothing of the extension's runs to keep it there.
 */
export interface ExtSiteView {
  title?: string;
  rows: ExtRow[];
  spaceId?: string;
}

/** A press on a row the shell draws for the extension: which row (null for one with no id whose button was pressed), which button (null: the row itself), and the space in front. */
export interface ExtRowPress {
  site: "band" | "sidebar";
  row: string | null;
  button: string | null;
  spaceId: string | null;
}

/**
 * A declared trigger as main's clock has it now (docs/primitives.md §3; pistachio.json → triggers).
 *
 * - `during` (a window): `holds` — whether the window is on now — and `changesAt`, when that next changes (ms since
 *   1970; null when it never does).
 * - `at` (an instant): `at`, the latest one that came due (null when none has yet), and `next`, the one to come.
 * - `every` (an interval): `at`, the latest mark that came due — null while the trigger its `while` names does not
 *   hold — and `next`, the mark to come.
 * - `when` (a signal): `holds` — whether what it names is so now — and `known`: false while main cannot tell (a
 *   calendar not connected), and then `holds` is false and no handler is run.
 * - `on` (an event): `events` — what happened since the handler last ran, oldest first, at most twenty; empty from
 *   `triggers.get`, which has nothing to say of an event but that it is declared.
 *
 * A handler is handed the same shape when the answer is not the one it last heard: it reconciles to it, it does
 * not count on having heard the one before. An event's handler is the exception: it is told what happened, once.
 */
export type ExtTriggerState =
  | { id: string; kind: "during"; holds: boolean; changesAt: number | null }
  | { id: string; kind: "at"; at: number | null; next: number | null }
  | { id: string; kind: "every"; at: number | null; next: number | null }
  | { id: string; kind: "when"; holds: boolean; known: boolean }
  | { id: string; kind: "on"; events: ExtTriggerEvent[] };

/**
 * One thing that happened (an `on` trigger): when, and — for a tab's and a page's — which tab. Never an address:
 * reading the tab is `tabs:read`'s to allow (`tabs.get`).
 */
export interface ExtTriggerEvent {
  at: number;
  tabId?: string;
}

export interface ExtDeskWindow {
  tabId: string;
  box: { x: number; y: number; width: number; height: number };
  z: number;
  inUse: boolean;
  minimized: boolean;
  pageKind: "page" | "shell" | "extension";
  title: string;
}

export interface ExtDeskState {
  spaceId: string | null;
  stage: { width: number; height: number };
  windows: ExtDeskWindow[];
}

export interface ExtCaptureSource {
  tabId: string;
  title: string;
  url: string;
  favIconUrl: string | null;
  still: string | null;
  inUse: boolean;
}

export type ExtInputEventKind = "move" | "down" | "up" | "key" | "wheel" | "scroll" | "caret" | "focus" | "cursor" | "nav" | "load" | "box";

export interface ExtRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ExtInputEvent =
  | { t: number; k: "move"; x: number; y: number }
  | { t: number; k: "down" | "up"; x: number; y: number; button: "left" | "right" | "middle"; target?: ExtRect & { role: string } }
  | { t: number; k: "key"; kind: "char" | "chord" | "nav"; chord?: string }
  | { t: number; k: "wheel"; x: number; y: number; dx: number; dy: number }
  | { t: number; k: "scroll"; x: number; y: number }
  | { t: number; k: "caret"; rect: ExtRect }
  | { t: number; k: "focus"; rect: ExtRect | null; secret: boolean }
  | { t: number; k: "cursor"; type: string }
  | { t: number; k: "nav"; url: string; title: string }
  | { t: number; k: "load"; loading: boolean }
  | { t: number; k: "box"; view: ExtRect; visible: boolean };

export interface ExtDataFile {
  path: string;
  size: number;
  modifiedAt: number;
  kind: "file" | "dir";
}

export interface ExtNoteSummary {
  id: string;
  title: string;
  updatedAt: number;
}

export interface ExtToast {
  title: string;
  body?: string;
  action?: { id: string; title: string };
}

export interface ExtStatus {
  text: string;
  actions?: { id: string; title: string }[];
}

export interface ExtMenuClick {
  tabId: string | null;
  pageUrl: string | null;
  linkUrl?: string;
  selectionText?: string;
  srcUrl?: string;
  windowTabId?: string;
  /** The item was chosen from a tab's own menu — its row in the sidebar (a `tab` item): `tabId` is that tab. */
  fromTab?: true;
  /** The space whose menu the item was chosen from (a `space` item): the choice gives the extension that space. */
  spaceId?: string;
}

export interface ExtBarCommandContext {
  arg: string;
  spaceId: string | null;
  tabId: string | null;
  selection: string | null;
}

export interface ExtRuntimeInfo {
  id: string;
  manifest: Json;
  context: ExtContext;
  /** The page's declared name, for a page context. */
  page: string | null;
  /** `performance.timeOrigin` of main, so `now()` lines up with main's event clock. */
  timeOrigin: number;
}

export interface ExtFetchResult {
  status: number;
  headers: Record<string, string>;
  /** Base64 of the body. */
  body: string;
}

/**
 * Each method's arguments and result on the wire. A call is
 * `ipcRenderer.invoke(EXT_CALL_CHANNEL, method, args)` answered by an
 * `ExtReply`; binary goes as `ArrayBuffer`/`Uint8Array` (structured clone).
 */
export interface ExtMethodMap {
  "runtime.info": { args: Record<string, never>; result: ExtRuntimeInfo };
  /** To the worker from a page/panel, or to every page and the panel from the worker; the first handler's answer. */
  "runtime.sendMessage": { args: { message: Json }; result: Json | undefined };
  /** Main mints a MessageChannelMain pair, hands this context one end over the event channel (`runtime.connect` event), and the other to the target. */
  "runtime.connect": { args: { name: string; target: "worker" | { page: string } }; result: { portId: number } };
  "runtime.keepAlive": { args: { reason: string }; result: { holdId: number } };
  "runtime.release": { args: { holdId: number }; result: null };
  /** A handler's answer to an `invoke` on the event channel. */
  "runtime.done": { args: { id: number; v?: Json; error?: string }; result: null };
  "runtime.log": { args: { level: "info" | "warn" | "error"; message: string; data?: Json }; result: null };

  "storage.get": { args: { keys: string[] | null }; result: Record<string, Json> };
  "storage.set": { args: { items: Record<string, Json> }; result: null };
  "storage.remove": { args: { keys: string[] }; result: null };

  "settings.get": { args: { key: string | null }; result: Record<string, Json> };

  "ui.openPanel": { args: Record<string, never>; result: null };
  "ui.closePanel": { args: Record<string, never>; result: null };
  "ui.openPage": { args: { name: string; query?: string; space?: string }; result: { tabId: string } };
  "ui.toast": { args: ExtToast; result: null };
  "ui.setBadge": { args: { text: string | null }; result: null };
  "ui.setStatus": { args: { status: ExtStatus | null }; result: null };
  /** The panel's content size, so the side card fits it. */
  "ui.preferredSize": { args: { width: number; height: number }; result: null };

  "tabs.query": { args: { spaceId?: string; active?: boolean; url?: string }; result: ExtTab[] };
  "tabs.get": { args: { id: string }; result: ExtTab };
  "tabs.create": { args: { url: string; space?: string; show?: boolean }; result: ExtTab };
  "tabs.navigate": { args: { id: string; url: string }; result: null };
  "tabs.show": { args: { id: string }; result: null };
  "tabs.close": { args: { id: string }; result: null };
  "spaces.list": { args: Record<string, never>; result: ExtSpace[] };
  "spaces.current": { args: Record<string, never>; result: ExtSpace | null };
  /** `until`: an instant in ms (the runtime turns a Date or an ISO string into one). */
  "spaces.sendAway": { args: { spaceId: string; until?: number }; result: ExtAwaySpace };
  "spaces.bringBack": { args: { spaceId: string }; result: null };
  "spaces.away": { args: Record<string, never>; result: ExtAwaySpace[] };
  /** Put a mark on a space's tile, or (null) take this extension's off: a space the person gave it. */
  /** Close a space into the archive, whole (the person's own *Close space*): restored from there as itself. */
  "spaces.close": { args: { spaceId: string }; result: null };
  "spaces.setMark": { args: { spaceId: string; mark: ExtSpaceMark | null }; result: null };
  /** A small mark on a tab's row, or — null — this extension's taken off: any tab it could see. */
  "tabs.setMark": { args: { tabId: string; mark: ExtSpaceMark | null }; result: null };
  /** Replace this extension's theme for every space, or for `spaceId`. */
  "theme.set": { args: ExtTheme; result: null };
  "theme.clear": { args: { spaceId?: string }; result: null };
  /** This extension's theme there, as it set it; null when it has none (never set, cleared, removed by the person, or another's put in its place). */
  "theme.get": { args: { spaceId?: string }; result: ExtTheme | null };
  /** Replace what this extension has a place showing — the band, a sidebar section — for every space, or for `spaceId`. No rows takes it off. */
  "sites.set": { args: { site: "band" | "sidebar" } & ExtSiteView; result: null };
  "sites.clear": { args: { site: "band" | "sidebar"; spaceId?: string }; result: null };
  /** What it has there, as it set it; null when it has nothing (never set, cleared, removed by the person). */
  "sites.get": { args: { site: "band" | "sidebar"; spaceId?: string }; result: ExtSiteView | null };
  /** A declared trigger as the clock has it now; NOT_FOUND for an id pistachio.json does not declare. */
  "triggers.get": { args: { id: string }; result: ExtTriggerState };
  "triggers.list": { args: Record<string, never>; result: ExtTriggerState[] };
  "desk.state": { args: { spaceId?: string }; result: ExtDeskState };
  "pages.read": { args: { tabId: string; format: "text" | "markdown" | "elements" }; result: { text: string } };
  "pages.screenshot": { args: { tabId: string }; result: { png: ArrayBuffer } };

  "capture.sources": { args: Record<string, never>; result: ExtCaptureSource[] };
  /** Arm this context's session: its next `getDisplayMedia` (within ten seconds) is answered with the tab. Answers the constraints to ask for. */
  "capture.arm": { args: { tabId: string; audio: boolean; scale: 1 | 2; frameRate: 30 | 60 }; result: { width: number; height: number } };
  "capture.hold": { args: { tabId: string }; result: { holdId: number } };
  "capture.release": { args: { holdId: number }; result: null };
  "input.subscribe": { args: { tabId: string; kinds: ExtInputEventKind[] | null }; result: { subscriptionId: number } };
  "input.stop": { args: { subscriptionId: number }; result: null };

  "files.pick": { args: { accept?: string[]; multiple?: boolean }; result: { paths: string[] } };
  "files.save": { args: { data: ArrayBuffer | null; dataPath: string | null; suggestedName: string; folder: "downloads" | "screenshots" | "ask" }; result: { path: string | null } };
  "files.reveal": { args: { path: string }; result: null };
  "files.data.open": { args: { path: string; append: boolean }; result: { handle: number } };
  "files.data.write": { args: { handle: number | null; path: string | null; chunk: ArrayBuffer }; result: null };
  "files.data.close": { args: { handle: number; abort: boolean }; result: null };
  "files.data.read": { args: { path: string; start?: number; end?: number }; result: { bytes: ArrayBuffer } };
  "files.data.list": { args: { dir: string }; result: ExtDataFile[] };
  "files.data.remove": { args: { path: string }; result: null };
  "files.data.freeSpace": { args: Record<string, never>; result: { bytes: number } };
  "files.startDrag": { args: { dataPath: string }; result: null };

  "clipboard.write": { args: { text?: string; html?: string; imagePng?: ArrayBuffer; filePath?: string }; result: null };
  "clipboard.readText": { args: Record<string, never>; result: { text: string } };
  "notifications.show": { args: { title: string; body?: string; action?: { id: string; title: string } }; result: null };
  "net.fetch": { args: { url: string; method?: string; headers?: Record<string, string>; body?: ArrayBuffer | string }; result: ExtFetchResult };
  "notes.list": { args: Record<string, never>; result: ExtNoteSummary[] };
  "notes.search": { args: { query: string; limit?: number }; result: ExtNoteSummary[] };
  "notes.read": { args: { id: string }; result: { id: string; title: string; markdown: string } };
  "notes.create": { args: { title: string; markdown: string }; result: { id: string } };
  "notes.update": { args: { id: string; mode: "replace" | "append" | "section"; markdown: string; section?: string }; result: null };
  "agent.ask": { args: { prompt: string; spaceId?: string }; result: null };
  /** One question to a model, no tools: `system` says how to answer, `prompt` is the question. The answer's text. */
  "ai.complete": { args: { prompt: string; system?: string; maxTokens?: number }; result: { text: string } };
  "power.preventSleep": { args: Record<string, never>; result: { holdId: number } };
  "power.release": { args: { holdId: number }; result: null };

  /** Subscribe to an event; main answers a subscription id the event channel's messages carry. */
  "events.on": { args: { event: string; filter?: Json }; result: { subscriptionId: number } };
  "events.off": { args: { subscriptionId: number }; result: null };
}

export type ExtMethodArgs<M extends keyof ExtMethodMap> = ExtMethodMap[M]["args"];
export type ExtMethodResult<M extends keyof ExtMethodMap> = ExtMethodMap[M]["result"];

/** What each event carries on the event channel. */
export interface ExtEventMap {
  "storage.changed": { changes: Record<string, { oldValue?: Json; newValue?: Json }> };
  "settings.changed": { key: string; value: Json | undefined };
  "tabs.created": { tab: ExtTab };
  "tabs.updated": { tab: ExtTab; changed: ("title" | "url" | "loading" | "favIconUrl")[] };
  "tabs.removed": { tabId: string };
  "tabs.activated": { tabId: string | null };
  "spaces.currentChanged": { space: ExtSpace | null };
  "spaces.awayChanged": { event: "sent" | "returned"; space: ExtAwaySpace };
  "desk.changed": { state: ExtDeskState };
  "input.event": { subscriptionId: number; events: ExtInputEvent[] };
  "capture.ended": { tabId: string; reason: string };
  "runtime.message": { message: Json; from: ExtContext; replyId: number | null };
  /** A port arrives: `MessagePort` objects travel on `ipcRenderer.on`'s `event.ports`. */
  "runtime.connect": { portId: number; name: string; from: ExtContext };
}

/** What main invokes in a worker (`invoke` on the event channel), by kind. */
export interface ExtInvokeMap {
  tool: { input: Json; runId: string; spaceId: string | null };
  bar: ExtBarCommandContext;
  menu: ExtMenuClick;
  key: { tabId: string | null; spaceId: string | null };
  action: { tabId: string | null; spaceId: string | null };
  message: { message: Json; from: ExtContext };
  /** A status pill's or a toast's or a notification's action was chosen. */
  statusAction: { action: string; source: "status" | "toast" | "notification" };
  /** A row the shell draws for it was pressed, or one of the row's buttons (`name` is the place: "band", "sidebar"). */
  press: ExtRowPress;
  installed: { reason: "install" | "update" | "dev-reload" };
  /** A declared trigger's answer changed (`name` is its id): the state to reconcile to. */
  trigger: ExtTriggerState;
}
