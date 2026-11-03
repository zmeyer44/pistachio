/**
 * The Pistachio extension API, v1 (docs/extensions.md §5).
 *
 * A global `pistachio` exists in every context of a Pistachio extension: its
 * worker, its panel, and its pages. Every call returns a Promise; every
 * `onX(fn)` returns a function that unsubscribes. Errors are `ExtError`s
 * whose `code` is one of PERMISSION_DENIED, NOT_FOUND, INVALID_ARGUMENT,
 * UNAVAILABLE, TIMEOUT, RATE_LIMITED or CANCELLED and whose message says
 * what to add to pistachio.json or what to change.
 *
 * `@capability` names the permission a member needs (declared under
 * `permissions` in pistachio.json and approved by the person); none means
 * every extension has it. `@context` names where a member works when it is
 * not everywhere.
 *
 * `pistachio` exists before the page's first script, but which extension it
 * is arrives a moment later: `runtime.ready` resolves then. Every call waits
 * for it on its own; read `runtime.id`, `runtime.manifest`,
 * `runtime.context` or `files.data.url()` only after
 * `await pistachio.runtime.ready`.
 */

declare namespace Pistachio {
  type Unsubscribe = () => void;
  type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

  interface ExtError extends Error {
    code: "PERMISSION_DENIED" | "NOT_FOUND" | "INVALID_ARGUMENT" | "UNAVAILABLE" | "TIMEOUT" | "RATE_LIMITED" | "CANCELLED";
  }

  /** The manifest, as loaded. */
  interface Manifest {
    api: 1;
    id: string;
    name: string;
    version: string;
    description?: string;
    permissions?: string[];
    hosts?: string[];
    [key: string]: unknown;
  }

  /** A port between two of this extension's contexts (a page and the worker). Main is off the path. */
  interface Port {
    name: string;
    postMessage(message: Json): void;
    /** What arrived before the first listener waits for it, in order: listen after an await and lose nothing. */
    onMessage(fn: (message: Json) => void): Unsubscribe;
    onDisconnect(fn: () => void): Unsubscribe;
    disconnect(): void;
  }

  interface Runtime {
    /**
     * Resolves once this context knows which extension it is (Pistachio's
     * answer, a moment after the page starts). Calls wait for it on their
     * own; `id`, `manifest`, `context` and `files.data.url()` throw before it.
     */
    readonly ready: Promise<void>;
    /** This extension's id, as in pistachio.json. */
    readonly id: string;
    readonly manifest: Manifest;
    /** Which context this is. */
    readonly context: "worker" | "panel" | "page";
    /** Milliseconds, sub-millisecond, on the clock every capture and input event uses. */
    now(): number;
    /** Open a port to the worker (from a page or the panel), or to a page by its page name (from the worker). */
    connect(name?: string): Port;
    /** The worker's side of `connect`. */
    onConnect(fn: (port: Port) => void): Unsubscribe;
    /** A one-shot message to the worker (from a page) or to every open page and the panel (from the worker). */
    sendMessage(message: Json): Promise<Json | undefined>;
    onMessage(fn: (message: Json, from: "worker" | "panel" | "page") => Json | Promise<Json> | void): Unsubscribe;
    /** Hold the worker up (it otherwise stops after thirty minutes idle). Returns the release. */
    keepAlive(reason: string): Promise<Unsubscribe>;
    /** After a first load, an update, or a reload from the dev folder. */
    onInstalled(fn: (details: { reason: "install" | "update" | "dev-reload" }) => void): Unsubscribe;
    /** The Ledge icon was clicked (an extension with `"action": true` and no panel). @context worker */
    onAction(fn: (ctx: { tabId: string | null; spaceId: string | null }) => void): Unsubscribe;
    /** Write to the extension's log (`.pistachio/log.ndjson` for a dev folder, Settings → Extensions → Logs). */
    log(level: "info" | "warn" | "error", message: string, data?: Json): void;
  }

  interface StorageArea {
    get(keys?: string | string[]): Promise<Record<string, Json>>;
    set(items: Record<string, Json>): Promise<void>;
    remove(keys: string | string[]): Promise<void>;
    onChanged(fn: (changes: Record<string, { oldValue?: Json; newValue?: Json }>) => void): Unsubscribe;
  }

  interface Storage {
    /** Kept by main, 5 MB, the same from every context. */
    local: StorageArea;
  }

  interface Settings {
    /** A declared setting's value; a `secret` reads only in the worker. */
    get(key: string): Promise<Json | undefined>;
    getAll(): Promise<Record<string, Json>>;
    onChanged(fn: (key: string, value: Json | undefined) => void): Unsubscribe;
  }

  interface Ui {
    /** Open this extension's panel beside the sidebar. */
    openPanel(): Promise<void>;
    closePanel(): Promise<void>;
    /** Open a declared page as a desk window in the current space (or `space`); answers its tab id. */
    openPage(name: string, options?: { query?: string; space?: "current" | "new" | string }): Promise<string>;
    /** A small notice from this extension, with its icon. */
    toast(toast: { title: string; body?: string; action?: { id: string; title: string } }): Promise<void>;
    /** The badge on the Ledge icon (≤ 4 characters), or null to clear. */
    setBadge(text: string | null): Promise<void>;
    /**
     * A live pill the shell draws beside the Bar's nub — never in any capture — with
     * actions that come back through `onStatusAction`. Null clears it.
     */
    setStatus(status: { text: string; actions?: { id: string; title: string }[] } | null): Promise<void>;
    onStatusAction(fn: (action: string) => void): Unsubscribe;
    /** A toast's action was chosen. */
    onToastAction(fn: (action: string) => void): Unsubscribe;
  }

  interface BarCommandContext {
    arg: string;
    spaceId: string | null;
    tabId: string | null;
    selection: string | null;
  }

  interface Bar {
    /** A declared `/` command of kind `event` ran. Return `{ prompt }` to hand a request to the agent, or `{ openPage }`. @context worker */
    onCommand(name: string, fn: (ctx: BarCommandContext) => void | { prompt: string } | { openPage: string; query?: string } | Promise<void | { prompt: string } | { openPage: string; query?: string }>): Unsubscribe;
  }

  interface MenuClick {
    tabId: string | null;
    pageUrl: string | null;
    linkUrl?: string;
    selectionText?: string;
    srcUrl?: string;
    /** The desk window's tab, for a `window` item. */
    windowTabId?: string;
  }

  interface ContextMenus {
    /** A declared context-menu item was chosen. @context worker */
    onClicked(id: string, fn: (info: MenuClick) => void): Unsubscribe;
  }

  interface Commands {
    /** A declared key command was pressed. @context worker */
    onCommand(id: string, fn: (ctx: { tabId: string | null; spaceId: string | null }) => void): Unsubscribe;
  }

  interface Tab {
    id: string;
    spaceId: string | null;
    profileId: string;
    title: string;
    url: string;
    favIconUrl: string | null;
    active: boolean;
    loading: boolean;
    /** What the page is: a site, a shell page (home, notes, terminal…), or one of this extension's pages. */
    kind: "page" | "shell" | "extension";
  }

  interface Tabs {
    /** @capability tabs:read — the tabs of the Profiles this extension is on in; never hidden agent tabs. `url` is a match pattern. */
    query(query?: { spaceId?: string; active?: boolean; url?: string }): Promise<Tab[]>;
    /** @capability tabs:read */
    get(id: string): Promise<Tab>;
    /** @capability tabs:write — in the current space unless `space`; `show: false` leaves the desk as it is. */
    create(options: { url: string; space?: "current" | "new" | string; show?: boolean }): Promise<Tab>;
    /** @capability tabs:write */
    navigate(id: string, url: string): Promise<void>;
    /** @capability tabs:write — bring it in front. */
    show(id: string): Promise<void>;
    /** @capability tabs:write */
    close(id: string): Promise<void>;
    /** @capability tabs:read */
    onCreated(fn: (tab: Tab) => void): Unsubscribe;
    /** @capability tabs:read — coalesced per publish tick. */
    onUpdated(fn: (tab: Tab, changed: ("title" | "url" | "loading" | "favIconUrl")[]) => void): Unsubscribe;
    /** @capability tabs:read */
    onRemoved(fn: (tabId: string) => void): Unsubscribe;
    /** @capability tabs:read */
    onActivated(fn: (tabId: string | null) => void): Unsubscribe;
  }

  interface Space {
    id: string;
    name: string;
    color: string | null;
    tabIds: string[];
  }

  interface Spaces {
    /** @capability tabs:read */
    list(): Promise<Space[]>;
    /** @capability tabs:read */
    current(): Promise<Space | null>;
    /** @capability tabs:read */
    onCurrentChanged(fn: (space: Space | null) => void): Unsubscribe;
  }

  interface DeskWindow {
    tabId: string;
    /** Stage pixels, from the desk's top-left. */
    box: { x: number; y: number; width: number; height: number };
    z: number;
    inUse: boolean;
    minimized: boolean;
    pageKind: "page" | "shell" | "extension";
    title: string;
  }

  interface DeskState {
    spaceId: string | null;
    stage: { width: number; height: number };
    windows: DeskWindow[];
  }

  interface Desk {
    /** @capability desk — the current space's desk, or `spaceId`'s. */
    state(spaceId?: string): Promise<DeskState>;
    /** @capability desk — at most four times a second. */
    onChanged(fn: (state: DeskState) => void): Unsubscribe;
  }

  interface Pages {
    /** @capability pages:read with a host grant for the tab's site, or a gesture grant on that tab. */
    read(tabId: string, options?: { format?: "text" | "markdown" | "elements" }): Promise<string>;
    /** @capability pages:read — a PNG of the page as shown. */
    screenshot(tabId: string): Promise<Blob>;
  }

  interface CaptureSource {
    tabId: string;
    title: string;
    url: string;
    favIconUrl: string | null;
    /** The window's still, a data URL, when the desk has one. */
    still: string | null;
    inUse: boolean;
  }

  interface Capture {
    /** @capability capture:tab — the desk's windows that can be recorded (pages, never another extension's). */
    sources(): Promise<CaptureSource[]>;
    /**
     * @capability capture:tab @context worker — a live MediaStream of the tab: its video at
     * `scale` × the view's size (2 keeps zoom crisp; the page renders at that ratio
     * meanwhile) and, with `audio`, the page's sound in stereo (the page keeps playing).
     * Chromium draws the system cursor into it while the mouse moves over the page.
     */
    tab(tabId: string, options?: { audio?: boolean; scale?: 1 | 2; frameRate?: 30 | 60 }): Promise<MediaStream>;
    /** @capability capture:tab — keep the tab awake, unarchived and at its zoom while held. Returns the release. */
    hold(tabId: string): Promise<Unsubscribe>;
  }

  type InputEventKind = "move" | "down" | "up" | "key" | "wheel" | "scroll" | "caret" | "focus" | "cursor" | "nav" | "load" | "box";

  /** Coordinates are the view's CSS pixels; `t` is `runtime.now()` milliseconds. */
  type InputEvent =
    | { t: number; k: "move"; x: number; y: number }
    | { t: number; k: "down" | "up"; x: number; y: number; button: "left" | "right" | "middle"; target?: { x: number; y: number; w: number; h: number; role: string } }
    | { t: number; k: "key"; kind: "char" | "chord" | "nav"; chord?: string }
    | { t: number; k: "wheel"; x: number; y: number; dx: number; dy: number }
    | { t: number; k: "scroll"; x: number; y: number }
    | { t: number; k: "caret"; rect: { x: number; y: number; w: number; h: number } }
    | { t: number; k: "focus"; rect: { x: number; y: number; w: number; h: number } | null; secret: boolean }
    | { t: number; k: "cursor"; type: string }
    | { t: number; k: "nav"; url: string; title: string }
    | { t: number; k: "load"; loading: boolean }
    | { t: number; k: "box"; view: { x: number; y: number; w: number; h: number }; visible: boolean };

  interface InputSubscription {
    onEvent(fn: (event: InputEvent) => void): Unsubscribe;
    stop(): Promise<void>;
  }

  interface Input {
    /**
     * @capability input:events @context worker — what the person does in a tab while subscribed:
     * pointer moves and presses (with the clicked element's rect), key *kinds* (never the
     * characters, nothing at all while a password field has focus), scrolls, the caret,
     * the cursor's shape, navigations and the view's box.
     */
    subscribe(tabId: string, kinds?: InputEventKind[]): Promise<InputSubscription>;
  }

  interface DataFile {
    path: string;
    size: number;
    modifiedAt: number;
    kind: "file" | "dir";
  }

  /** An open write; chunks are copied to main and written in order with backpressure. */
  interface DataWritable {
    write(chunk: ArrayBuffer | Uint8Array): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
  }

  interface Data {
    /** @capability files:data — the extension's own files (`data/` under its data folder). `path` is relative, no `..`. */
    open(path: string, options?: { append?: boolean }): Promise<DataWritable>;
    /** @capability files:data — write a whole file at once. */
    write(path: string, data: ArrayBuffer | Uint8Array | string | Blob): Promise<void>;
    /** @capability files:data — a byte range, or the whole file. */
    read(path: string, range?: { start: number; end?: number }): Promise<ArrayBuffer>;
    /** @capability files:data */
    list(dir?: string): Promise<DataFile[]>;
    /** @capability files:data */
    remove(path: string): Promise<void>;
    /** @capability files:data — a URL playable in `<video>` or `<img>` (served with Range support). */
    url(path: string): string;
    /** @capability files:data — free bytes on the volume. */
    freeSpace(): Promise<number>;
  }

  interface Files {
    /** A native open dialog; the person's choice is the grant. Answers paths. */
    pick(options?: { accept?: string[]; multiple?: boolean }): Promise<string[]>;
    /** A native save dialog for bytes or for one of this extension's data files (`{ dataPath }`). Answers the path saved, or null. */
    save(data: ArrayBuffer | Uint8Array | Blob | { dataPath: string }, options: { suggestedName: string; folder?: "downloads" | "screenshots" | "ask" }): Promise<string | null>;
    /** Show a file this extension saved or owns in the Finder. */
    reveal(path: string): Promise<void>;
    /** Start a drag of one of this extension's data files out of a page (on a pointer gesture). */
    startDrag(dataPath: string): Promise<void>;
    data: Data;
  }

  interface Clipboard {
    /** @capability clipboard:write — text, html, an image, or a file this extension owns (its data path or a path it saved). */
    write(content: { text?: string; html?: string; image?: Blob; filePath?: string }): Promise<void>;
    /** @capability clipboard:read — within five seconds of a gesture on this extension. */
    readText(): Promise<string>;
  }

  interface Notifications {
    /** @capability notifications — the Mac's notification, with the extension's name. */
    show(notification: { title: string; body?: string; action?: { id: string; title: string } }): Promise<void>;
    onAction(fn: (action: string) => void): Unsubscribe;
  }

  interface Net {
    /**
     * `fetch`, run by main in this extension's own partition (never a Profile's cookies): no
     * CORS, the host checked against `hosts` in pistachio.json, every request in the ledger.
     */
    fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string | ArrayBuffer | Uint8Array }): Promise<{ status: number; /** 200–299. */ ok: boolean; headers: Record<string, string>; text(): Promise<string>; json(): Promise<Json>; arrayBuffer(): Promise<ArrayBuffer> }>;
  }

  interface NoteSummary {
    id: string;
    title: string;
    updatedAt: number;
  }

  interface Notes {
    /** @capability notes:read */
    list(): Promise<NoteSummary[]>;
    /** @capability notes:read */
    search(query: string, limit?: number): Promise<NoteSummary[]>;
    /** @capability notes:read — the note as markdown. */
    read(id: string): Promise<{ id: string; title: string; markdown: string }>;
    /** @capability notes:write */
    create(note: { title: string; markdown: string }): Promise<{ id: string }>;
    /** @capability notes:write — replace the note, append to it, or replace one section by its heading. */
    update(id: string, change: { mode: "replace" | "append" | "section"; markdown: string; section?: string }): Promise<void>;
  }

  interface ToolContext {
    runId: string;
    spaceId: string | null;
    signal: AbortSignal;
    /** A line in the agent's trace while the tool works. */
    progress(text: string): void;
  }

  interface Agent {
    /** @capability agent:tools @context worker — handle a declared tool. Return JSON; throw to fail the step. */
    onToolCall<Input = Record<string, Json>>(name: string, fn: (input: Input, ctx: ToolContext) => Promise<Json>): Unsubscribe;
    /** @capability agent:ask — a visible turn in the space's conversation, credited to this extension. */
    ask(prompt: string, options?: { spaceId?: string }): Promise<void>;
  }

  interface Power {
    /** @capability power — keep the Mac (and the display) awake. Returns the release. */
    preventSleep(): Promise<Unsubscribe>;
  }

  interface Api {
    runtime: Runtime;
    storage: Storage;
    settings: Settings;
    ui: Ui;
    bar: Bar;
    contextMenus: ContextMenus;
    commands: Commands;
    tabs: Tabs;
    spaces: Spaces;
    desk: Desk;
    pages: Pages;
    capture: Capture;
    input: Input;
    files: Files;
    clipboard: Clipboard;
    notifications: Notifications;
    net: Net;
    notes: Notes;
    agent: Agent;
    power: Power;
  }
}

declare const pistachio: Pistachio.Api;
