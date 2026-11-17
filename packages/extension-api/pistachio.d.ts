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
    /**
     * A strip beside the Bar, along the foot of the desk: at most 6 rows, each drawn as a chip. Needs `"band": true`
     * in pistachio.json. Use it for the few things worth a glance while working — today's games, a build's state.
     * (`setStatus` is for something live that ends with the work: a recording, a timer. It is not kept.)
     */
    band: Rows;
    /**
     * A section of the sidebar, at the foot of the space's card: a heading (`title`, or this extension's name) and
     * at most 12 rows. Needs `"sidebar": true` in pistachio.json.
     */
    sidebar: Rows;
  }

  /**
   * One row Pistachio draws for this extension — its own row, filled in: never markup. `text` is what it says;
   * `detail` follows it, quieter; `value` stands at the trailing end in figures that line up (a score, a count, a
   * time); `mark` leads it (a glyph of one or two characters — a dot when left out — in a tone). Each is one line:
   * no line breaks. `text` and `detail` are 80 characters at most, `value` 24.
   *
   * A row with an `id` can be pressed, and so can its `buttons` (two at most, titles of 24 characters): the press
   * comes to `onPress`. Ids are letters, digits and `. _ : -` ("game:401"), each used once.
   */
  interface Row {
    id?: string;
    mark?: { glyph?: string; tone?: "neutral" | "green" | "amber" | "red" | "blue" };
    text: string;
    detail?: string;
    value?: string;
    buttons?: { id: string; title: string }[];
  }

  /** What a place shows: its rows, for every space or — `spaceId` — for one the person gave this extension. `title` heads a sidebar section. */
  interface RowsView {
    title?: string;
    rows: Row[];
    spaceId?: string;
  }

  /** A press: the row's `id` (null when a button of a row with no id was pressed), the button's (null: the row itself), and the space in front. */
  interface RowPress {
    site: "band" | "sidebar";
    row: string | null;
    button: string | null;
    spaceId: string | null;
  }

  /**
   * A place Pistachio fills with this extension's rows (`ui.band`, `ui.sidebar`). The rows are a value Pistachio
   * keeps and draws under this extension's icon: they are there after the worker has stopped and after a restart,
   * until the extension sets others, clears them, or the person removes them (a × on the place itself, or the
   * Extensions page). So a handler says what should be shown — `set` the same rows twice and nothing happens.
   */
  interface Rows {
    /**
     * Replace this extension's rows here, whole: for every space, or with `spaceId` for that one space — a space the
     * person gave it (a Bar command or a menu item run in it), else `PERMISSION_DENIED`. A space's own rows are the
     * ones drawn there, in place of the ones for every space. No rows is the same as `clear`.
     *
     * Rejects `INVALID_ARGUMENT` — with a sentence saying what to change — for a place pistachio.json does not
     * declare, too many rows, an id used twice, or a row that can be pressed in an extension with no worker.
     * Allowed in a trigger's handler.
     */
    set(view: RowsView): Promise<void>;
    /** Take this extension's rows off, for every space or for `spaceId`. Quiet when it has none there. */
    clear(options?: { spaceId?: string }): Promise<void>;
    /** Its rows there as it set them; null when it has none (never set, cleared, or removed by the person). */
    get(options?: { spaceId?: string }): Promise<RowsView | null>;
    /**
     * A row with an `id`, or one of its buttons, was pressed. @context worker
     *
     * The press is the person's own act: what a trigger's handler may not do (open a tab, write a note) is allowed
     * here. It does not give the extension the space in front.
     */
    onPress(fn: (press: RowPress) => void): Unsubscribe;
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
    /** True when the item was chosen from a tab's own menu (a `tab` item): `tabId` is that tab, `pageUrl` its address. */
    fromTab?: true;
    /**
     * The space whose menu the item was chosen from, for a `space` item. Choosing it there gives the extension that
     * space, as running a Bar command in it does: keep the id in storage for a trigger to act on.
     */
    spaceId?: string;
  }

  interface ContextMenus {
    /**
     * A declared context-menu item was chosen. @context worker
     *
     * An item whose `contexts` name "tab" is in a tab's own menu (a right-click on its row in the sidebar): `info`
     * carries that tab as `tabId` and `fromTab: true`.
     *
     * An item whose `contexts` name "space" is in a space's own menu (a right-click on its tile on the rail): `info`
     * then carries `spaceId`, with `tabId` and `pageUrl` null, and the choice gives this extension that space, as a
     * Bar command run in it does.
     */
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
    /** When it was last in use, ms since 1970 — for a tab opened behind others and not looked at yet, when it was opened. */
    lastActiveAt: number;
  }

  interface Tabs {
    /** @capability tabs:read — the tabs of the Profiles this extension is on in; never hidden agent tabs. `url` is a match pattern. */
    query(query?: { spaceId?: string; active?: boolean; url?: string }): Promise<Tab[]>;
    /** @capability tabs:read */
    get(id: string): Promise<Tab>;
    /**
     * @capability tabs:write — in the current space unless `space`; `show: false` leaves the desk as it is.
     *
     * Allowed in a trigger's handler, where it opens **behind** what is in front whatever `show` says (nobody is
     * moved by code), twelve an hour at most (`RATE_LIMITED` past that), and is written in the journal: the person's
     * Undo closes the tab. There it opens pages of the web only — never one of this extension's own pages — and
     * only in the space in front or a space on the rail named by its id: `space: "new"`, and the id of a Home tab's
     * space, reject `PERMISSION_DENIED`, as an own page does.
     */
    create(options: { url: string; space?: "current" | "new" | string; show?: boolean }): Promise<Tab>;
    /** @capability tabs:write */
    navigate(id: string, url: string): Promise<void>;
    /** @capability tabs:write — bring it in front. */
    show(id: string): Promise<void>;
    /** @capability tabs:write */
    close(id: string): Promise<void>;
    /**
     * @capability tabs:mark — put a small mark on a tab's row in the sidebar, or (`null`) take this extension's off.
     * One mark an extension a tab: setting it again replaces it. Pistachio keeps it and draws it — beside the tab's
     * title, said as "<this extension's name>: <label>" — whether or not the extension is running, until it is set
     * to `null`, the tab closes, the person removes it (the Extensions page, *What it shows*), or the extension is
     * turned off or removed. Any tab this extension could see (`NOT_FOUND` for one it could not); taking a mark off
     * a tab that has gone is quiet. Allowed in a trigger's handler; not written in the journal.
     */
    setMark(id: string, mark: SpaceMark | null): Promise<void>;
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
    /** When any tab of it was last in use, ms since 1970; 0 for a space with no tabs. */
    lastActiveAt: number;
    /**
     * The person's: they made it or made it theirs (named it, moved a tab into it, keep a Stack or a conversation
     * in it), or it grew from a tab of their own — and a Home tab's or a favorite's page's always is. False only for
     * a space Pistachio gathered by itself (Tidy) that nobody has touched since. "Tidy up what I am not using" leaves
     * `byPerson` spaces alone unless the person said otherwise.
     */
    byPerson: boolean;
  }

  /** A space that is away: off the rail, its tabs asleep, to come back as itself. `mine`: this extension sent it. */
  interface AwaySpace {
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

  interface Spaces {
    /** @capability tabs:read — the spaces that are here; one that is away is not among them (`away()`). */
    list(): Promise<Space[]>;
    /** @capability tabs:read */
    current(): Promise<Space | null>;
    /** @capability tabs:read */
    onCurrentChanged(fn: (space: Space | null) => void): Unsubscribe;
    /**
     * @capability spaces:write — send a space away: off the rail, its tabs asleep, kept exactly as it is. With
     * `until` (ms, a Date or an ISO string, in the future) Pistachio brings it back by itself at that time — or the
     * moment the Mac next wakes after it — whether or not this extension is running; without it, it stays away until
     * `bringBack` or the person's own press. Only a space the person ran one of this extension's commands in (a Bar
     * command, a menu item, a key, the icon): pass that handler's `ctx.spaceId`. The space in front passes the desk
     * on first. Rejects `PERMISSION_DENIED` for a space it was never run in, `UNAVAILABLE` while the space is busy
     * (shared live, recorded, the agent at work in it), `INVALID_ARGUMENT` for a past `until` or a Home tab.
     *
     * Safe to repeat: a space the person gave this extension that is away already resolves with it as it is, and
     * nothing changes — so a trigger's handler can say "away" every time without asking first. From a trigger's
     * handler (nobody there) it also rejects `UNAVAILABLE` for the space in front, one that is playing something
     * and one with a terminal open: let that out of the handler, and Pistachio runs the trigger again later. (The
     * space in front does go when Pistachio can see nobody is at the Mac: its screen is locked, or the handler is an
     * `idle` or `screen` signal's and that signal holds.)
     */
    sendAway(spaceId: string, options?: { until?: number | string | Date }): Promise<AwaySpace>;
    /**
     * @capability spaces:write — bring back a space this extension sent away, or one the person ran it in. Never
     * brings it in front: the person does that. Safe to repeat: one the person gave it that is here already resolves
     * and nothing changes.
     */
    bringBack(spaceId: string): Promise<void>;
    /**
     * @capability spaces:close — close a space into the archive, whole: what the person's own *Close space* does.
     * Its tabs close and the space is filed as one entry — restored from the archive as itself (its name, its colour,
     * its tabs, its Stack and conversation), until the archive lets it lapse (30 days unless the person changed it).
     * For "out of the way, back later" use `sendAway`, which never lapses; `close` is for "done with this".
     *
     * Only a space the person gave this extension — or, with `spaces:all`, any drawn space. Rejects
     * `PERMISSION_DENIED` otherwise, `NOT_FOUND` for one that is not here, `UNAVAILABLE` while it is busy (shared
     * live, recorded, the agent at work in it).
     *
     * Allowed in a trigger's handler: then it also rejects `UNAVAILABLE` for the space in front, one playing
     * something and one with a terminal (let it out; Pistachio tries again), and it is written in the journal — the
     * person's Undo restores the space. (As for `sendAway`, the space in front does go when Pistachio can see nobody
     * is at the Mac: its screen is locked, or the handler is an `idle` or `screen` signal's and that signal holds.)
     */
    close(spaceId: string): Promise<void>;
    /** @capability tabs:read — the spaces that are away, oldest first, whoever sent them. */
    away(): Promise<AwaySpace[]>;
    /** @capability tabs:read — a space went away, or came back (asked for, or by the clock). */
    onAwayChanged(fn: (change: { event: "sent" | "returned"; space: AwaySpace }) => void): Unsubscribe;
    /**
     * @capability spaces:mark — put a small mark on a space's tile on the rail, or (`null`) take this extension's
     * off. One mark an extension a space: setting it again replaces it. Pistachio keeps it and draws it — at the
     * tile's corner, said as "<this extension's name>: <label>" — whether or not the extension is running, until it
     * is set to `null`, the person removes it (the Extensions page, *What it shows*), or the extension is turned
     * off or removed. Only a space the person gave this extension (a Bar command, a `space` menu item, a key or the
     * icon run in it): `PERMISSION_DENIED` otherwise. Allowed in a trigger's handler; not written in the journal.
     */
    setMark(spaceId: string, mark: SpaceMark | null): Promise<void>;
  }

  /**
   * A small mark on a space's tile: a `glyph` — one or two characters as a person counts them (a letter, a digit, an
   * emoji); a dot when left out — in a `tone` ("neutral" when left out), and a `label` (1–60 characters) that says
   * what it means. It is the tile's tooltip and what a screen reader says.
   */
  interface SpaceMark {
    glyph?: string;
    tone?: "neutral" | "green" | "amber" | "red" | "blue";
    label: string;
  }

  /**
   * What lies behind a space's windows, drawn by Pistachio in the desk's well:
   *
   * - `{ color }` — one colour, `#rrggbb`.
   * - `{ gradient: { colors, angle? } }` — two to four `#rrggbb` colours; `angle` in CSS degrees (0 runs bottom to
   *   top, 90 left to right; 180, top to bottom, when left out).
   * - `{ image, fit?, dim? }` — a picture in this extension's own folder, by its path there ("art/field.svg"):
   *   .png, .jpg, .jpeg, .webp or .svg, at most 8 MB (an SVG 512 KB). An SVG is drawn as a picture: its scripts never
   *   run and nothing it links to is loaded. `fit` is "cover" (the default: fill the desk, cropped), "contain" or
   *   "tile". `dim` (0–0.8) lays Pistachio's own ground over it that far, so windows stand out on it in light and
   *   dark alike. Pistachio copies the file when `theme.set` is called and keeps the copy: changing the file later
   *   changes nothing until `set` is called again.
   */
  type Backdrop =
    | { color: string }
    | { gradient: { colors: string[]; angle?: number } }
    | { image: string; fit?: "cover" | "contain" | "tile"; dim?: number };

  /**
   * A theme: a backdrop and an accent colour, for every space or — `spaceId` — for one the person gave this
   * extension. `colors.accent` (`#rrggbb`) is the colour Pistachio tints its own surfaces with and draws its focus
   * ring in while that theme is in front. `backdrop: null`, or leaving it out, is no backdrop.
   */
  interface Theme {
    backdrop?: Backdrop | null;
    colors?: { accent?: string };
    spaceId?: string;
  }

  /**
   * The theme Pistachio draws for this extension. A value, never a view: the extension says what goes behind the
   * windows and Pistachio checks it, keeps it and paints it — whether or not the extension is running — until the
   * extension clears it, the person removes it (the space's menu: *Remove backdrop*; the Extensions page: *What it
   * shows*), another extension sets one for the same place, or this one is turned off or removed.
   */
  interface ThemeApi {
    /**
     * @capability theme — replace this extension's theme, whole: for every space, or with `spaceId` for that one
     * space. Safe to repeat, so a trigger's handler says what should be so (`holds ? set(…) : clear(…)`). A space's
     * own theme is the one drawn there, over one set for every space. One extension holds a place at a time: another
     * extension's `set` for the same place takes this one's, and `get` then answers null. A theme with neither a
     * backdrop nor an accent is `clear`.
     *
     * Rejects `PERMISSION_DENIED` for a `spaceId` the person never gave this extension (a Bar command, a `space`
     * menu item, a key or the icon run in that space gives it); `INVALID_ARGUMENT` for a picture that is missing,
     * too large or not a picture of its type, and for an accent that does not stand out at least 2:1 from both
     * Pistachio's light ground and its dark one (the message says the ratio and which way to go).
     *
     * Allowed in a trigger's handler; a theme set there, with nobody at the browser, is written in the journal the
     * person can undo from.
     */
    set(theme: Theme): Promise<void>;
    /** @capability theme — remove this extension's theme for every space, or for `spaceId`. Quiet when it has none there. */
    clear(options?: { spaceId?: string }): Promise<void>;
    /**
     * @capability theme — this extension's theme for every space, or for `spaceId`, as it set it; null when it has
     * none there: never set, cleared, removed by the person, or another extension's put in its place.
     */
    get(options?: { spaceId?: string }): Promise<Theme | null>;
  }

  /**
   * A trigger declared in pistachio.json (`triggers`), as Pistachio's clock has it now.
   *
   * - `during` (a window of the week): `holds` — whether the window is on now — and `changesAt`, when that next
   *   changes (ms since 1970; null when it never does).
   * - `at` (an instant that recurs): `at`, the latest one that came due (null when none has yet), and `next`, the
   *   one to come.
   * - `every` (an interval: `{ "minutes": 5, "while": "sunday" }`): `at`, the latest mark that came due — every five
   *   minutes is :00, :05, … — and `next`, the mark to come. `at` is null while the trigger its `while` names does
   *   not hold. However many marks passed while the Mac slept, the handler hears one.
   * - `when` (a signal — something Pistachio can see and the extension cannot: `{ "power": "battery" }`,
   *   `{ "network": "offline" }`, `{ "display": "external" }`, `{ "idle": { "minutes": 10 } }`,
   *   `{ "calendar": { "title": "stand-up", "early": 2 } }`): `holds` — whether it is so now. That is all the
   *   extension is told: never the event, its name or its guests. `known` is false while Pistachio cannot tell (no
   *   calendar is connected in the Profiles the extension is on in); then `holds` is false and no handler runs.
   *   The browser's own are signals too — `{ "page": { "host": "meet.google.com" } }` (a page of that site is open
   *   in a tab), `{ "space": "front" }` (a space the person gave this extension is in front), `{ "tabs": { "over":
   *   30 } }` — and so is `{ "screen": "locked" }`.
   * - `on` (an event — something that happens: `{ "tab": "opened" }`, `"closed"` or `"shown"` (it comes in front), `{ "page": { "host":
   *   "github.com", "path": "/pulls" } }` (a tab arrives at such a page), `{ "download": "finished" }`): `events`,
   *   what happened since the handler last ran, oldest first, at most twenty. Told while Pistachio is up and the
   *   extension is on; what happened while it was not is missed for good. `get` answers `events: []`.
   */
  type TriggerState =
    | { id: string; kind: "during"; holds: boolean; changesAt: number | null }
    | { id: string; kind: "at"; at: number | null; next: number | null }
    | { id: string; kind: "every"; at: number | null; next: number | null }
    | { id: string; kind: "when"; holds: boolean; known: boolean }
    | { id: string; kind: "on"; events: TriggerEvent[] };

  /**
   * One thing that happened: when (ms since 1970) and — for a tab's or a page's event — which tab. Never its
   * address: `tabs.get(tabId)` reads the tab, with `tabs:read`.
   */
  interface TriggerEvent {
    at: number;
    tabId?: string;
  }

  /**
   * When the extension runs by itself (pistachio.json → `triggers`). Pistachio keeps the clock: it asks each
   * declared trigger what holds — at launch, on wake, on unlock, and as the time comes — and runs the handler when
   * the answer is not the one the handler last heard, starting the worker if it is stopped. Never a timer of the
   * worker's own: it does not live until Sunday, and it does not stay up to poll — an `every` trigger is how
   * something is looked at again.
   */
  interface Triggers {
    /**
     * Handle a declared trigger (worker). The handler is given the state to reconcile to — make things match
     * `holds`, do not count on having heard the change before it: a Mac asleep all week hears one call. Return (or
     * await) what it does: a handler that throws or rejects was not delivered, and Pistachio runs it again later.
     * (An `on` trigger's handler is told what happened instead — `state.events` — once: a failure is logged, never
     * run again.)
     *
     * Nobody is there when it runs, so only what can be undone is allowed: reading (tabs, spaces, the desk), its own
     * storage and data files, `ui.toast` / `setBadge` / `setStatus`, `notifications.show`, `net.fetch`,
     * `spaces.sendAway` / `bringBack` / `close` of a space the person gave it, `tabs.create` (a page of the web,
     * behind what is in front), `ai.complete`, and what Pistachio draws for it — `theme.set` / `clear` / `get`,
     * `spaces.setMark`, `tabs.setMark`, and the rows of `ui.band` and `ui.sidebar`. A send, a return, a close, a tab
     * opened and a theme set
     * there are written in a journal the person can undo from; a mark, rows and a clear are not (each says whose it
     * is where it is drawn, and the person removes it in one press). Anything else
     * rejects `PERMISSION_DENIED` there: show a toast with an action, and do it in `ui.onToastAction`, which the
     * person's press is behind.
     */
    on(id: string, fn: (state: TriggerState) => unknown): Unsubscribe;
    /** A declared trigger as the clock has it now. Rejects `NOT_FOUND` for an id pistachio.json does not declare. */
    get(id: string): Promise<TriggerState>;
    /** Every declared trigger, in the manifest's order. */
    list(): Promise<TriggerState[]>;
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

  interface Ai {
    /**
     * @capability ai — one question to Pistachio's fast model: `prompt` (up to 24,000 characters) and, optionally,
     * `system` — how to answer (up to 4,000). Resolves with the answer's text. No tools, no memory, nothing shown in
     * any conversation; for JSON, ask for JSON and parse it — and expect to be wrong sometimes. `maxTokens` (16–2000,
     * 600 when left out) bounds the answer.
     *
     * What is sent is what this extension chooses to send, and it spends the person's AI usage: send the least that
     * answers the question (titles, not pages). Rejects `UNAVAILABLE` when no model can be asked (signed out, offline,
     * switched off) or none answered in time — have something to do then — and `RATE_LIMITED` past ten a minute.
     *
     * Allowed in a trigger's handler, a dozen an hour at most. Asked from a handler, the answer is waited for only
     * as long as the handler has left (a trigger's has ten seconds in all), so ask first thing: `UNAVAILABLE` comes
     * back with a second or so still to do the plain thing in.
     */
    complete(request: { prompt: string; system?: string; maxTokens?: number }): Promise<string>;
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
    triggers: Triggers;
    theme: ThemeApi;
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
    ai: Ai;
    power: Power;
  }
}

declare const pistachio: Pistachio.Api;
