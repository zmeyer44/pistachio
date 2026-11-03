/**
 * `pistachio.input.subscribe` (docs/extensions.md §5 `input`; docs/recorder.md
 * §3): what the person does in a tab, as events in the view's own pixels
 * (DIP: the CSS px of the page at 100%) on main's clock, batched to the
 * subscriber every 50 ms.
 *
 * Main hears most of it itself, on the tab's own contents: `before-mouse-event`
 * (moves at input rate, presses, the wheel), `before-input-event` (keys: their
 * kind alone, never the character), `cursor-changed`, the navigations and
 * loads; a 60 Hz read of the OS pointer fills the gaps while it is over the
 * view's box (a page's view hides the pointer from everything else), and of
 * the view's box itself. The tab preload (preload/tab.ts, every frame) adds
 * what only the page knows — the pressed element's rect and role, the focused
 * field (and whether it is a secret one), the caret, the scroll — and sends it
 * only while main has told its frame a subscription exists.
 *
 * A frame of another site reports in its own coordinates: main finds where it
 * lies by matching its press to the press main itself heard (within
 * DOWN_MATCH_MS), and keeps that offset for its later reports. While any frame
 * says a secret field (a password, a card number, a one-time code) has focus,
 * no key and no caret leaves here at all.
 *
 * The pure parts (classifyKey, screenToView, the batching) are tested
 * (test/extensions-input.test.ts) on stand-ins for the contents.
 */

import type { ExtInputEvent, ExtInputEventKind, ExtRect } from "@pistachio/extension-api";
import type { IPC } from "@pistachio/shell-contracts/ipc";

/** How often a subscriber hears what happened (ms). */
export const INPUT_BATCH_MS = 50;
/** How long a press waits for its page's word on what was pressed (the preload's report), and how far apart the two may be. */
export const DOWN_MATCH_MS = 100;
/** The OS pointer's and the view box's read, while anyone subscribes. */
export const INPUT_POLL_MS = 16;
/** A polled pointer is said only when the page's own moves have been quiet this long. */
const POLL_QUIET_MS = 20;
/** At most this many events wait for one subscriber (a stalled one loses its oldest). */
const MAX_QUEUED = 5_000;

/** Main's word to a frame that it should report (true) or stop (false); the reports come on IPC.extensionInput. */
const EXTENSION_INPUT_ON_CHANNEL: typeof IPC.extensionInputOn = "pistachio:extension-input-on";

export const INPUT_EVENT_KINDS: readonly ExtInputEventKind[] = ["move", "down", "up", "key", "wheel", "scroll", "caret", "focus", "cursor", "nav", "load", "box"];

export function isInputEventKind(value: unknown): value is ExtInputEventKind {
  return typeof value === "string" && (INPUT_EVENT_KINDS as readonly string[]).includes(value);
}

/* --------------------------------- keys --------------------------------- */

export interface KeyFacts {
  key: string;
  code?: string;
  meta?: boolean;
  control?: boolean;
  alt?: boolean;
  shift?: boolean;
}

const MODIFIER_KEYS = new Set(["Shift", "Meta", "Control", "Alt", "AltGraph", "CapsLock", "Fn", "FnLock", "Hyper", "Super", "OS", "NumLock", "ScrollLock"]);
const NAV_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Tab", "Escape", "Backspace", "Delete", "Home", "End", "PageUp", "PageDown"]);
const KEY_GLYPHS: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Enter: "↩",
  Tab: "⇥",
  Escape: "⎋",
  Backspace: "⌫",
  Delete: "⌦",
  Home: "↖",
  End: "↘",
  PageUp: "⇞",
  PageDown: "⇟",
  " ": "Space",
};

/** A key that types: one character, or the parts of one (a dead key, an input method's). */
function types(key: string): boolean {
  return [...key].length === 1 || key === "Dead" || key === "Process" || key === "Compose";
}

/** The key's label in a chord: the physical key for letters and digits (Option composes something else into `key`), else its glyph. */
function chordKey(facts: KeyFacts): string | null {
  const code = facts.code ?? "";
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter !== null) return letter[1]!;
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit !== null) return digit[1]!;
  const glyph = KEY_GLYPHS[facts.key];
  if (glyph !== undefined) return glyph;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(facts.key)) return facts.key;
  if ([...facts.key].length === 1 && /^[!-~]$/.test(facts.key)) return facts.key.toUpperCase();
  return null;
}

/**
 * What a key press says, with nothing typed in it: `char` for a key that types
 * (a letter, a digit, a symbol — with Shift, or with Option alone on a Mac,
 * which composes one), `nav` for the keys that move or edit (the arrows,
 * Enter, Tab, Escape, Backspace, Delete, Home/End, Page Up/Down), `chord` with
 * its label (`⌘K`, `⌃⇧P`; `Ctrl+K` off the Mac) for one held with ⌘ or ⌃ (or
 * a function key). Null for a modifier alone, or a key that is none of these.
 */
export function classifyKey(facts: KeyFacts, platform: "darwin" | "other"): { kind: "char" | "nav" } | { kind: "chord"; chord: string } | null {
  const { key } = facts;
  if (key === "" || MODIFIER_KEYS.has(key)) return null;
  const meta = facts.meta === true;
  const control = facts.control === true;
  const alt = facts.alt === true;
  const shift = facts.shift === true;
  const functionKey = /^F([1-9]|1[0-9]|2[0-4])$/.test(key);
  // Option alone on a Mac composes a character (⌥e is ´), and is typing.
  const composes = alt && platform === "darwin" && types(key) && !NAV_KEYS.has(key);
  if (meta || control || (alt && !composes) || functionKey) {
    const label = chordKey(facts);
    if (label === null) return null;
    const mods =
      platform === "darwin"
        ? `${control ? "⌃" : ""}${alt ? "⌥" : ""}${shift ? "⇧" : ""}${meta ? "⌘" : ""}`
        : [control ? "Ctrl+" : "", alt ? "Alt+" : "", shift ? "Shift+" : "", meta ? "Meta+" : ""].join("");
    return { kind: "chord", chord: `${mods}${label}` };
  }
  if (NAV_KEYS.has(key)) return { kind: "nav" };
  return types(key) ? { kind: "char" } : null;
}

/* ------------------------------- geometry ------------------------------- */

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The OS pointer (screen DIP) in a view's own pixels: less the window's content origin, less the view's. */
export function screenToView(screen: Point, content: Point, view: Point): Point {
  return { x: screen.x - content.x - view.x, y: screen.y - content.y - view.y };
}

/** Whether a point in a view's own pixels is on the view. */
export function onView(point: Point, view: { width: number; height: number }): boolean {
  return point.x >= 0 && point.y >= 0 && point.x < view.width && point.y < view.height;
}

const round = (value: number): number => Math.round(value * 10) / 10;

/** A frame's rect (its CSS px at the page's zoom `z`) in the view's pixels, past the frame's offset. */
export function rectInView(rect: ExtRect, zoom: number, offset: Point): ExtRect {
  return { x: round(rect.x * zoom + offset.x), y: round(rect.y * zoom + offset.y), w: round(rect.w * zoom), h: round(rect.h * zoom) };
}

/* ------------------------------- batching ------------------------------- */

export interface InputSubscriber {
  id: number;
  extensionId: string;
  tabId: string;
  /** The kinds asked for; null for every kind. */
  kinds: ReadonlySet<ExtInputEventKind> | null;
  deliver(events: ExtInputEvent[]): void;
}

/** One subscriber's queue: what it asked for, sent at most every INPUT_BATCH_MS, in order. */
export class InputBatch {
  readonly subscriber: InputSubscriber;
  #queue: ExtInputEvent[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;

  constructor(subscriber: InputSubscriber) {
    this.subscriber = subscriber;
  }

  wants(kind: ExtInputEventKind): boolean {
    return this.subscriber.kinds === null || this.subscriber.kinds.has(kind);
  }

  push(event: ExtInputEvent): void {
    if (this.#closed || !this.wants(event.k)) return;
    this.#queue.push(event);
    if (this.#queue.length > MAX_QUEUED) this.#queue.splice(0, this.#queue.length - MAX_QUEUED);
    if (this.#timer === null) this.#timer = setTimeout(() => this.flush(), INPUT_BATCH_MS);
  }

  flush(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    if (this.#queue.length === 0) return;
    const events = this.#queue;
    this.#queue = [];
    try {
      this.subscriber.deliver(events);
    } catch {
      // A subscriber gone mid-send hears nothing more.
    }
  }

  /** Sent what it has, and closed. */
  close(): void {
    this.flush();
    this.#closed = true;
  }
}

/* ---------------------------- the preload's word ---------------------------- */

/** What the tab preload reports, in its frame's CSS px (validated here: a page's renderer is no authority). */
export type PreloadInput =
  | { k: "down"; x: number; y: number; button: "left" | "right" | "middle"; target: (ExtRect & { role: string }) | null; z: number }
  | { k: "focus"; rect: ExtRect | null; secret: boolean; z: number }
  | { k: "caret"; rect: ExtRect; z: number }
  | { k: "scroll"; x: number; y: number };

const finite = (value: unknown, limit = 1e6): value is number => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;

function rectOf(value: unknown): ExtRect | null {
  if (typeof value !== "object" || value === null) return null;
  const rect = value as Record<string, unknown>;
  if (!finite(rect["x"]) || !finite(rect["y"]) || !finite(rect["w"]) || !finite(rect["h"]) || (rect["w"] as number) < 0 || (rect["h"] as number) < 0) return null;
  return { x: rect["x"] as number, y: rect["y"] as number, w: rect["w"] as number, h: rect["h"] as number };
}

const zoomOf = (value: unknown): number => (finite(value, 10) && value > 0 ? value : 1);

export function parsePreloadInput(value: unknown): PreloadInput | null {
  if (typeof value !== "object" || value === null) return null;
  const message = value as Record<string, unknown>;
  switch (message["k"]) {
    case "down": {
      const button = message["button"];
      if (!finite(message["x"]) || !finite(message["y"]) || (button !== "left" && button !== "right" && button !== "middle")) return null;
      const rawTarget = message["target"];
      const rect = rectOf(rawTarget);
      const role = typeof rawTarget === "object" && rawTarget !== null ? (rawTarget as { role?: unknown }).role : undefined;
      const target = rect === null ? null : { ...rect, role: typeof role === "string" ? role.slice(0, 40) : "" };
      return { k: "down", x: message["x"], y: message["y"], button, target, z: zoomOf(message["z"]) };
    }
    case "focus":
      return { k: "focus", rect: rectOf(message["rect"]), secret: message["secret"] === true, z: zoomOf(message["z"]) };
    case "caret": {
      const rect = rectOf(message["rect"]);
      return rect === null ? null : { k: "caret", rect, z: zoomOf(message["z"]) };
    }
    case "scroll":
      return finite(message["x"], 1e8) && finite(message["y"], 1e8) ? { k: "scroll", x: message["x"], y: message["y"] } : null;
    default:
      return null;
  }
}

/* ------------------------------- the taps ------------------------------- */

/** The part of a webContents a tap listens on (Electron's, or a test's stand-in). */
export interface TapContents {
  readonly id: number;
  isDestroyed(): boolean;
  getURL(): string;
  getTitle(): string;
  isLoading(): boolean;
  readonly mainFrame: TapFrame;
  on(event: string, listener: (...args: never[]) => void): unknown;
  removeListener(event: string, listener: (...args: never[]) => void): unknown;
}

export interface TapFrame {
  readonly processId: number;
  readonly routingId: number;
  readonly framesInSubtree: readonly TapFrame[];
  send(channel: string, ...args: unknown[]): void;
}

export interface InputHost {
  /** The tab's live page, or null while it has none (asleep). */
  contents(tabId: string): TapContents | null;
  /** Whether the tab is still there (an asleep tab is). */
  exists(tabId: string): boolean;
  /** The tab's view in the window's content box (DIP), and whether it is shown; null without one. */
  view(tabId: string): { bounds: Box; visible: boolean } | null;
  /** The OS pointer in the window's content box (DIP), or null when it cannot be read. */
  pointer(): Point | null;
  /**
   * Whether the window is the one in front (focused): the OS pointer over its box is the page's only then — with
   * another application in front, a pointer over the same place is that application's. Absent: taken as in front.
   */
  focused?(): boolean;
  /** Main's clock (`performance.timeOrigin + performance.now()`, what the extension's `runtime.now()` reads). */
  now(): number;
  platform: "darwin" | "other";
}

const frameKey = (frame: { processId: number; routingId: number }): string => `${String(frame.processId)}:${String(frame.routingId)}`;
const boxKey = (view: { bounds: Box; visible: boolean }): string =>
  `${String(view.bounds.x)},${String(view.bounds.y)},${String(view.bounds.width)},${String(view.bounds.height)},${String(view.visible)}`;

interface Outgoing {
  event: ExtInputEvent;
  /** A press still waiting on its page's word (the element pressed). */
  waiting: boolean;
  /** When main heard it (ms, main's clock), for the match. */
  at: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** One tab's taps: main's listeners on its contents, and its subscribers' batches. */
class TabTap {
  readonly tabId: string;
  readonly batches = new Map<number, InputBatch>();
  readonly #host: InputHost;
  #contents: TapContents | null = null;
  #listeners: [string, (...args: never[]) => void][] = [];
  #outbox: Outgoing[] = [];
  /** Where each frame of another site lies in the view, learned from its presses. */
  readonly #offsets = new Map<string, Point>();
  /** Frames that say a secret field has focus: while any does, no key and no caret goes out. */
  readonly #secretFrames = new Set<string>();
  #lastMove: Point | null = null;
  #lastMoveAt = Number.NEGATIVE_INFINITY;
  #lastBox = "";
  #lastCursor: string | null = null;
  #lastNav = "";

  constructor(tabId: string, host: InputHost) {
    this.tabId = tabId;
    this.#host = host;
  }

  get contents(): TapContents | null {
    return this.#contents;
  }

  /** Whether a secret field has focus in any frame still there: a frame taken out of the page says no focusout, so its word is pruned against the frame tree. */
  get silenced(): boolean {
    if (this.#secretFrames.size === 0) return false;
    const contents = this.#contents;
    if (contents !== null && !contents.isDestroyed()) {
      let live: Set<string> | null = null;
      try {
        live = new Set(contents.mainFrame.framesInSubtree.map((frame) => frameKey(frame)));
      } catch {
        live = null;
      }
      if (live !== null) for (const key of [...this.#secretFrames]) if (!live.has(key)) this.#secretFrames.delete(key);
    }
    return this.#secretFrames.size > 0;
  }

  wants(kind: ExtInputEventKind): boolean {
    for (const batch of this.batches.values()) if (batch.wants(kind)) return true;
    return false;
  }

  /** Listen on the tab's page now (null: it has none). */
  attach(contents: TapContents | null): void {
    if (contents === this.#contents) return;
    this.detach();
    if (contents === null || contents.isDestroyed()) return;
    this.#contents = contents;
    const on = (event: string, listener: (...args: never[]) => void): void => {
      contents.on(event, listener);
      this.#listeners.push([event, listener]);
    };
    on("before-mouse-event", ((_event: unknown, mouse: Electron.MouseInputEvent) => this.#mouse(mouse)) as never);
    on("before-input-event", ((_event: unknown, input: Electron.Input) => this.#key(input)) as never);
    on("cursor-changed", ((_event: unknown, type: string) => this.#cursor(type)) as never);
    on("did-navigate", ((_event: unknown, url: string) => this.#navigated(url, true)) as never);
    on("did-navigate-in-page", ((_event: unknown, url: string, isMainFrame: boolean) => {
      if (isMainFrame) this.#navigated(url, false);
    }) as never);
    on("page-title-updated", ((_event: unknown, title: string) => this.#titled(title)) as never);
    on("did-start-loading", (() => this.emit({ t: this.#host.now(), k: "load", loading: true })) as never);
    on("did-stop-loading", (() => this.emit({ t: this.#host.now(), k: "load", loading: false })) as never);
    // A frame's new document has a preload that knows nothing yet: told again.
    on("did-frame-navigate", ((_event: unknown, _url: string, _code: number, _status: string, isMainFrame: boolean, processId: number, routingId: number) => {
      if (!isMainFrame) {
        this.#secretFrames.delete(frameKey({ processId, routingId }));
        this.#offsets.delete(frameKey({ processId, routingId }));
      }
      this.tellFrames(true);
    }) as never);
    on("did-frame-finish-load", (() => this.tellFrames(true)) as never);
    on("destroyed", (() => this.detach()) as never);
    this.tellFrames(true);
  }

  detach(): void {
    const contents = this.#contents;
    this.#contents = null;
    if (contents === null) return;
    for (const [event, listener] of this.#listeners) contents.removeListener(event, listener);
    this.#listeners = [];
    this.#offsets.clear();
    this.#secretFrames.clear();
    if (!contents.isDestroyed()) this.#tell(contents, false);
  }

  /** Tell every frame of the page whether to report (the preload listens only while told so). */
  tellFrames(on: boolean): void {
    const contents = this.#contents;
    if (contents !== null && !contents.isDestroyed()) this.#tell(contents, on);
  }

  #tell(contents: TapContents, on: boolean): void {
    let frames: readonly TapFrame[];
    try {
      frames = contents.mainFrame.framesInSubtree;
    } catch {
      return;
    }
    for (const frame of frames) {
      try {
        frame.send(EXTENSION_INPUT_ON_CHANNEL, on);
      } catch {
        // A frame going away hears nothing.
      }
    }
  }

  /** What the subscriber is shown first: where the view is, the page it is on, whether it loads. */
  greet(batch: InputBatch): void {
    const t = this.#host.now();
    const view = this.#host.view(this.tabId);
    if (view !== null) {
      // (The poll says the box again only once it changes.)
      this.#lastBox = boxKey(view);
      batch.push({ t, k: "box", view: { x: view.bounds.x, y: view.bounds.y, w: view.bounds.width, h: view.bounds.height }, visible: view.visible });
    }
    const contents = this.#contents;
    if (contents !== null && !contents.isDestroyed()) {
      batch.push({ t, k: "nav", url: contents.getURL(), title: contents.getTitle() });
      batch.push({ t, k: "load", loading: contents.isLoading() });
    }
  }

  /** An event for every subscriber that asked for its kind, in the order heard (a press waits for its page's word). */
  emit(event: ExtInputEvent, waiting = false): Outgoing {
    const entry: Outgoing = { event, waiting, at: this.#host.now(), timer: null };
    if (waiting) {
      entry.timer = setTimeout(() => {
        entry.waiting = false;
        entry.timer = null;
        this.#drain();
      }, DOWN_MATCH_MS);
    }
    this.#outbox.push(entry);
    this.#drain();
    return entry;
  }

  #drain(): void {
    while (this.#outbox.length > 0 && !this.#outbox[0]!.waiting) {
      const { event } = this.#outbox.shift()!;
      for (const batch of this.batches.values()) batch.push(event);
    }
  }

  close(): void {
    for (const entry of this.#outbox) if (entry.timer !== null) clearTimeout(entry.timer);
    for (const entry of this.#outbox) entry.waiting = false;
    this.#drain();
    for (const batch of this.batches.values()) batch.close();
    this.batches.clear();
    this.detach();
  }

  /* ----------------------------- main's own ----------------------------- */

  #mouse(mouse: Electron.MouseInputEvent): void {
    const t = this.#host.now();
    const x = round(mouse.x);
    const y = round(mouse.y);
    switch (mouse.type) {
      case "mouseMove":
        this.#lastMove = { x, y };
        this.#lastMoveAt = t;
        if (this.wants("move")) this.emit({ t, k: "move", x, y });
        return;
      case "mouseDown":
        // (Waited on even when nobody asked for presses: a frame's offset is learned from them.)
        this.emit({ t, k: "down", x, y, button: mouse.button ?? "left" }, true);
        return;
      case "mouseUp":
        if (this.wants("up")) this.emit({ t, k: "up", x, y, button: mouse.button ?? "left" });
        return;
      case "mouseWheel": {
        if (!this.wants("wheel")) return;
        const wheel = mouse as Electron.MouseWheelInputEvent;
        this.emit({ t, k: "wheel", x, y, dx: round(wheel.deltaX ?? 0), dy: round(wheel.deltaY ?? 0) });
        return;
      }
      default:
        return;
    }
  }

  #key(input: Electron.Input): void {
    if (input.type !== "keyDown" || this.silenced || !this.wants("key")) return;
    const kind = classifyKey(input, this.#host.platform);
    if (kind === null) return;
    this.emit({ t: this.#host.now(), k: "key", ...kind });
  }

  #cursor(type: string): void {
    if (typeof type !== "string" || type === this.#lastCursor) return;
    this.#lastCursor = type;
    if (this.wants("cursor")) this.emit({ t: this.#host.now(), k: "cursor", type });
  }

  #navigated(url: string, newDocument: boolean): void {
    if (newDocument) {
      // A new document: its fields and frames are new too.
      this.#secretFrames.clear();
      this.#offsets.clear();
    }
    const contents = this.#contents;
    const title = contents === null || contents.isDestroyed() ? "" : contents.getTitle();
    this.#lastNav = `${url}\n${title}`;
    if (this.wants("nav")) this.emit({ t: this.#host.now(), k: "nav", url, title });
  }

  #titled(title: string): void {
    const contents = this.#contents;
    if (contents === null || contents.isDestroyed()) return;
    const url = contents.getURL();
    const key = `${url}\n${title}`;
    if (key === this.#lastNav) return;
    this.#lastNav = key;
    if (this.wants("nav")) this.emit({ t: this.#host.now(), k: "nav", url, title });
  }

  /* --------------------------- the poll (60 Hz) --------------------------- */

  poll(): void {
    const t = this.#host.now();
    const view = this.#host.view(this.tabId);
    if (view === null) return;
    const box = boxKey(view);
    if (box !== this.#lastBox) {
      this.#lastBox = box;
      if (this.wants("box")) this.emit({ t, k: "box", view: { x: view.bounds.x, y: view.bounds.y, w: view.bounds.width, h: view.bounds.height }, visible: view.visible });
    }
    if (!view.visible || !this.wants("move") || t - this.#lastMoveAt < POLL_QUIET_MS) return;
    if (!(this.#host.focused?.() ?? true)) return;
    const pointer = this.#host.pointer();
    if (pointer === null) return;
    const at = { x: round(pointer.x - view.bounds.x), y: round(pointer.y - view.bounds.y) };
    if (!onView(at, view.bounds)) return;
    if (this.#lastMove !== null && this.#lastMove.x === at.x && this.#lastMove.y === at.y) return;
    this.#lastMove = at;
    this.emit({ t, k: "move", x: at.x, y: at.y });
  }

  /** The OS pointer in the view's pixels, when it can be read and is on the view. */
  #pointerOnView(): Point | null {
    const view = this.#host.view(this.tabId);
    const pointer = this.#host.pointer();
    if (view === null || pointer === null) return null;
    const at = { x: pointer.x - view.bounds.x, y: pointer.y - view.bounds.y };
    return onView(at, view.bounds) ? at : null;
  }

  /* --------------------------- the preload's word --------------------------- */

  fromPreload(frame: { processId: number; routingId: number }, isMain: boolean, message: PreloadInput): void {
    const key = frameKey(frame);
    switch (message.k) {
      case "down": {
        const down = this.#outbox.find(
          (entry) => entry.waiting && entry.event.k === "down" && entry.event.button === message.button && this.#host.now() - entry.at <= DOWN_MATCH_MS,
        );
        if (down !== undefined && down.event.k === "down") {
          const offset = isMain ? { x: 0, y: 0 } : { x: down.event.x - message.x * message.z, y: down.event.y - message.y * message.z };
          if (!isMain) this.#offsets.set(key, offset);
          if (message.target !== null) down.event.target = { ...rectInView(message.target, message.z, offset), role: message.target.role };
          if (down.timer !== null) clearTimeout(down.timer);
          down.timer = null;
          down.waiting = false;
          this.#drain();
          return;
        }
        // A press main never heard: one in a frame of another site, which the page's own widget takes straight from
        // the OS (before-mouse-event is the top frame's). Where it lies is where the pointer is now, or where the frame
        // was found before.
        const pointer = isMain ? null : this.#pointerOnView();
        const offset = isMain ? { x: 0, y: 0 } : pointer !== null ? { x: pointer.x - message.x * message.z, y: pointer.y - message.y * message.z } : this.#offsets.get(key);
        if (offset === undefined) return;
        if (!isMain) this.#offsets.set(key, offset);
        const at = { x: round(message.x * message.z + offset.x), y: round(message.y * message.z + offset.y) };
        this.emit({
          t: this.#host.now(),
          k: "down",
          ...at,
          button: message.button,
          ...(message.target === null ? {} : { target: { ...rectInView(message.target, message.z, offset), role: message.target.role } }),
        });
        return;
      }
      case "focus": {
        if (message.secret) this.#secretFrames.add(key);
        else this.#secretFrames.delete(key);
        if (!this.wants("focus")) return;
        const offset = isMain ? { x: 0, y: 0 } : this.#offsets.get(key);
        const rect = message.rect === null || offset === undefined ? null : rectInView(message.rect, message.z, offset);
        this.emit({ t: this.#host.now(), k: "focus", rect, secret: message.secret });
        return;
      }
      case "caret": {
        if (this.silenced || !this.wants("caret")) return;
        const offset = isMain ? { x: 0, y: 0 } : this.#offsets.get(key);
        if (offset === undefined) return;
        this.emit({ t: this.#host.now(), k: "caret", rect: rectInView(message.rect, message.z, offset) });
        return;
      }
      case "scroll":
        if (this.wants("scroll")) this.emit({ t: this.#host.now(), k: "scroll", x: round(message.x), y: round(message.y) });
        return;
    }
  }
}

/**
 * Every input subscription of every extension, by tab: one tap per tab,
 * however many subscribe to it, listening only while one does.
 */
export class InputTaps {
  readonly #host: InputHost;
  readonly #taps = new Map<string, TabTap>();
  readonly #ended: (subscriber: InputSubscriber, reason: string) => void;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(host: InputHost, ended: (subscriber: InputSubscriber, reason: string) => void = () => undefined) {
    this.#host = host;
    this.#ended = ended;
  }

  subscribe(subscriber: InputSubscriber): void {
    let tap = this.#taps.get(subscriber.tabId);
    if (tap === undefined) {
      tap = new TabTap(subscriber.tabId, this.#host);
      this.#taps.set(subscriber.tabId, tap);
    }
    const batch = new InputBatch(subscriber);
    tap.batches.set(subscriber.id, batch);
    tap.attach(this.#host.contents(subscriber.tabId));
    tap.greet(batch);
    this.#sync();
  }

  stop(subscriptionId: number): InputSubscriber | null {
    for (const tap of this.#taps.values()) {
      const batch = tap.batches.get(subscriptionId);
      if (batch === undefined) continue;
      batch.close();
      tap.batches.delete(subscriptionId);
      if (tap.batches.size === 0) {
        tap.close();
        this.#taps.delete(tap.tabId);
      }
      this.#sync();
      return batch.subscriber;
    }
    return null;
  }

  /** Every subscription that `which` picks, stopped (an extension turned off, its worker gone, the person's Stop). */
  stopWhere(which: (subscriber: InputSubscriber) => boolean): InputSubscriber[] {
    const stopped: InputSubscriber[] = [];
    for (const tap of [...this.#taps.values()]) {
      for (const batch of [...tap.batches.values()]) {
        if (!which(batch.subscriber)) continue;
        const subscriber = this.stop(batch.subscriber.id);
        if (subscriber !== null) stopped.push(subscriber);
      }
    }
    return stopped;
  }

  subscribers(): InputSubscriber[] {
    return [...this.#taps.values()].flatMap((tap) => [...tap.batches.values()].map((batch) => batch.subscriber));
  }

  /** The tabs' pages may have changed (woken, replaced, closed): listen on the page each has now; a tab gone ends its subscriptions. */
  refresh(): void {
    for (const tap of [...this.#taps.values()]) {
      if (!this.#host.exists(tap.tabId)) {
        const gone = [...tap.batches.values()].map((batch) => batch.subscriber);
        tap.close();
        this.#taps.delete(tap.tabId);
        for (const subscriber of gone) this.#ended(subscriber, "closed");
        continue;
      }
      tap.attach(this.#host.contents(tap.tabId));
    }
    this.#sync();
  }

  /** A report from a tab preload's frame: to the tap on that page, if any. */
  fromPreload(contentsId: number, frame: { processId: number; routingId: number }, isMain: boolean, message: unknown): void {
    const parsed = parsePreloadInput(message);
    if (parsed === null) return;
    for (const tap of this.#taps.values()) {
      if (tap.contents?.id === contentsId) {
        tap.fromPreload(frame, isMain, parsed);
        return;
      }
    }
  }

  /** The 60 Hz read: each tapped view's box, and the pointer over it. Run by the timer; exposed for the test. */
  poll(): void {
    for (const tap of this.#taps.values()) tap.poll();
  }

  dispose(): void {
    for (const tap of this.#taps.values()) tap.close();
    this.#taps.clear();
    this.#sync();
  }

  #sync(): void {
    const polling = this.#taps.size > 0;
    if (polling && this.#timer === null) {
      this.#timer = setInterval(() => this.poll(), INPUT_POLL_MS);
      this.#timer.unref?.();
    } else if (!polling && this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }
}
