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
}

export interface ExtSpace {
  id: string;
  name: string;
  color: string | null;
  tabIds: string[];
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
  installed: { reason: "install" | "update" | "dev-reload" };
}
