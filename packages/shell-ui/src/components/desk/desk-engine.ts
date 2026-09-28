/**
 * The desk's engine: every window's box, its motion, and which of them may
 * show a live page — run imperatively, a frame at a time, outside React.
 *
 * A desk window is two things drawn by two processes. Its FRAME (title
 * bar, shadow, resize edges) is the shell's DOM; its PAGE is the tab's
 * native view, which main places over the hole the frame leaves. A native
 * view paints over everything the shell draws, so two rules keep the
 * picture honest:
 *
 * - a window with anything stacked over it is DRAWN — the shell paints its
 *   still where the page would be, and the stacking is the DOM's, always
 *   right. Only uncovered windows go live (geometry.uncoveredWindows).
 * - a window in motion that the shell wants to transform (lifted, tilted,
 *   flying into the inventory) is drawn too: a native view cannot scale or
 *   rotate. The "live" variant keeps a carried window's page instead, flat.
 *
 * A still has to exist before a live page may be taken down for it, and it
 * must be recent enough to pass for the page: each window records when it
 * began wanting one, and only a still captured after that (and painted)
 * stands in. Until then the page stays up; the views are stacked in the
 * windows' order (BrowserLayout.stacked), so even then the pages overlap
 * the right way round and only a frame can be briefly hidden.
 *
 * Nothing here changes per frame in React: positions are written straight
 * to the elements, the layout straight to main. React hears only of
 * structural changes (a window added, raised, drawn or live) via subscribe.
 */

import type { DragCursor } from "@pistachio/shell-contracts/chrome";
import { MAX_DESK_STILL_WIDTH, MAX_DESK_WINDOWS, type DeskGrab as NativeDeskGrab } from "@pistachio/shell-contracts/desk";
import { nativeApi } from "../../api";
import { startPaneDrag } from "../../lib/pane-drag";
import {
  centeredRect,
  clampRect,
  DESK_GAP,
  denormalizeRect,
  edgeZone,
  freeSpot,
  magnetize,
  magnetizeEdges,
  normalizeRect,
  resizedRect,
  rubberBandRect,
  sameRect,
  cascadeRects,
  thirdsZone,
  tileRects,
  uncoveredWindows,
  zoneRect,
  type Edges,
  type Guide,
  type Point,
  type Rect,
  type SnapZone,
} from "../../lib/desk/geometry";
import {
  BOUNCE_RESTITUTION,
  clamp,
  GLIDE_STOP_SPEED,
  glideDecay,
  glideReach,
  SPRING_PRESETS,
  springAtRest,
  stepSpring,
  VelocityTracker,
  type SpringConfig,
} from "../../lib/desk/motion";
import type { DeskChrome, DeskVariants, SavedDeskWindow } from "../../lib/desk/store";

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Where the page sits inside a window of each frame style. */
export const CHROME_INSETS: Record<DeskChrome, Insets> = {
  bar: { top: 34, right: 5, bottom: 5, left: 5 },
  tab: { top: 30, right: 4, bottom: 4, left: 4 },
  bare: { top: 18, right: 0, bottom: 0, left: 0 },
};

/** How far below the window's top edge its card begins (the tab or the handle rides above it). */
export const CHROME_CARD_TOP: Record<DeskChrome, number> = { bar: 0, tab: 26, bare: 18 };

/** The inventory's column on the desk's leading side. */
export const RAIL_W = 176;

/** A lifted window's scale, and its tilt per px/s of swing. */
const LIFT_SCALE = 1.035;
/** Held over the inventory, a lifted window shrinks toward it: let go, and it goes in. */
const OVER_RAIL_SCALE = 0.72;
/** Reduced motion: every settle is quick and still, whatever spring is chosen. */
const REDUCED_SPRING: SpringConfig = { response: 0.14, damping: 1 };
const TILT_PER_SPEED = 1 / 280;
const MAX_TILT = 6;
const LIFT_SPRING: SpringConfig = { response: 0.32, damping: 0.62 };
/** A press that travels less than this is a click. */
const CLICK_SLOP = 4;
const DOUBLE_CLICK_MS = 380;
/** A still taken this long before a window began wanting one still passes for its page. */
const STILL_GRACE_MS = 200;
/** Never ask for the same tab's still more often than this. */
const STILL_RETRY_MS = 450;
/** A covered window's still is refreshed this often, so what shows behind is not stale. */
const COVERED_REFRESH_MS = 3_000;
const THUMB_REFRESH_MS = 8_000;
const THUMB_WIDTH = 360;
/** A throw toward the inventory this fast, that would carry the window mostly off the desk, puts it away. */
const PUT_AWAY_SPEED = 1_100;
const LIVE_OVERSHOOT = 6;

export interface DeskWindowView {
  tabId: string;
  z: number;
  focused: boolean;
  /** The shell paints this window's page (its still, a placeholder or a shell page); no live view is over it. */
  drawn: boolean;
  still: string | null;
  /** In hand: above everything on the desk, the inventory included. */
  carried: boolean;
  lifted: boolean;
  /** On its way into the inventory ("away") or out of it ("in"). */
  flight: "in" | "away" | null;
  /** The frame is showing — false while the window is the whole surface, entering or leaving. */
  framed: boolean;
  maximized: boolean;
}

export interface DeskView {
  windows: readonly DeskWindowView[];
  thumbs: ReadonlyMap<string, string>;
  /** A carried window would be put away if it were let go now. */
  railArmed: boolean;
  gesture: "move" | "resize" | "spawn" | null;
  phase: "entering" | "open" | "leaving";
}

export interface DeskHost {
  variants(): DeskVariants;
  /** A native page can be on screen for this tab right now: awake, not shell-drawn. */
  hasLivePage(tabId: string): boolean;
  /** Make this tab the active one (it wakes if it sleeps). */
  select(tabId: string): void;
  save(windows: SavedDeskWindow[]): void;
  /** The leaving motion is done: the surface can go back to panes. */
  leaveDone(): void;
}

interface Still {
  src: string;
  /** When it was asked for — the moment it is a picture of. */
  at: number;
}

interface Win {
  tabId: string;
  rect: Rect;
  vel: Rect;
  target: Rect | null;
  /** Seconds before the spring to `target` starts (a staggered arrangement). */
  delay: number;
  coasting: boolean;
  restore: Rect | null;
  scale: number;
  scaleV: number;
  tilt: number;
  tiltV: number;
  lift: { scale: number; tilt: number };
  origin: Point;
  el: HTMLElement | null;
  written: string;
  /** The latest still, shown as soon as React has it. */
  still: Still | null;
  /** When the newest still known to be ON SCREEN was asked for; a newer one arriving does not lower it. */
  paintedAt: number;
  wantStillSince: number | null;
  flight: "in" | "away" | null;
  onArrive: (() => void) | null;
  /** Entering: the window waits, live at the whole surface, until its still can stand in for it. */
  hold: boolean;
  holdUntil: number;
  framed: boolean;
  drawn: boolean;
}

interface Gesture {
  kind: "move" | "resize" | "spawn";
  tabId: string;
  startedAt: number;
  start: Point;
  pointer: Point;
  startRect: Rect;
  /** Where the pointer holds the window, as fractions of its size — kept as a pulled-out window grows. */
  grab: Point;
  edges: Edges | null;
  tracker: VelocityTracker;
  zone: SnapZone | null;
  overRail: boolean;
  thumbSize: { w: number; h: number } | null;
  spawnSize: { w: number; h: number } | null;
  end: (() => void) | null;
}

const ZERO_RECT: Rect = { x: 0, y: 0, w: 0, h: 0 };

export class DeskEngine {
  readonly #host: DeskHost;
  readonly #wins = new Map<string, Win>();
  /** Bottom to top. */
  #order: string[] = [];
  #focused: string | null = null;
  #stage: HTMLElement | null = null;
  #stageBox = { left: 0, top: 0, width: 0, height: 0 };
  #zoneEl: HTMLElement | null = null;
  #guideEls: HTMLElement[] = [];
  readonly #thumbEls = new Map<string, HTMLElement>();
  readonly #thumbs = new Map<string, Still>();
  #gesture: Gesture | null = null;
  #phase: DeskView["phase"] = "entering";
  #raf = 0;
  #last = 0;
  #view: DeskView;
  readonly #listeners = new Set<() => void>();
  /** Null until the first layout goes out: an empty one (every window drawn) must still clear the panes main had up. */
  #sentLayout: string | null = null;
  #sentDesk = "";
  readonly #captureQueue = new Set<string>();
  readonly #inflight = new Set<string>();
  readonly #requestedAt = new Map<string, number>();
  #thumbTimer = 0;
  #coveredTimer = 0;
  #pendingFocus: string | null = null;
  #lastClick: { tabId: string; at: number } | null = null;
  #leaveFrames = -1;
  #destroyed = false;
  #armedRail = false;
  #dirtyView = false;

  constructor(host: DeskHost) {
    this.#host = host;
    this.#view = { windows: [], thumbs: new Map(), railArmed: false, gesture: null, phase: "entering" };
  }

  // ── React's side ────────────────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getView = (): DeskView => this.#view;

  attachStage(el: HTMLElement | null): void {
    this.#stage = el;
    if (el !== null) this.measure();
  }

  attachZone(el: HTMLElement | null): void {
    this.#zoneEl = el;
  }

  attachGuides(el: HTMLElement | null): void {
    this.#guideEls = el === null ? [] : [...el.children].filter((child): child is HTMLElement => child instanceof HTMLElement);
  }

  attachWindow(tabId: string, el: HTMLElement | null): void {
    const win = this.#wins.get(tabId);
    if (win === undefined) return;
    win.el = el;
    win.written = "";
    if (el !== null) this.#write(win);
  }

  attachThumb(tabId: string, el: HTMLElement | null): void {
    if (el === null) this.#thumbEls.delete(tabId);
    else this.#thumbEls.set(tabId, el);
  }

  /** The stage moved or changed size: re-read it, and keep the arrangement in proportion. */
  measure(): void {
    const stage = this.#stage;
    if (stage === null) return;
    const box = stage.getBoundingClientRect();
    const before = this.#usable();
    const resized = this.#stageBox.width > 0 && (box.width !== this.#stageBox.width || box.height !== this.#stageBox.height);
    this.#stageBox = { left: box.left, top: box.top, width: box.width, height: box.height };
    if (resized && this.#phase === "open") {
      const after = this.#usable();
      for (const win of this.#wins.values()) {
        if (this.#gesture?.tabId === win.tabId || win.flight !== null) continue;
        win.rect = clampRect(denormalizeRect(normalizeRect(win.rect, before), after), after);
        if (win.target !== null) win.target = clampRect(denormalizeRect(normalizeRect(win.target, before), after), after);
        if (win.restore !== null) win.restore = clampRect(denormalizeRect(normalizeRect(win.restore, before), after), after);
      }
    }
    this.#render();
  }

  /** Anything the host knows changed — a tab woke, the overlay rose, a variant was switched. */
  refresh(): void {
    this.#render();
    this.#kick();
  }

  destroy(): void {
    this.#destroyed = true;
    const gesture = this.#gesture;
    this.#gesture = null;
    gesture?.end?.();
    if (this.#raf !== 0) cancelAnimationFrame(this.#raf);
    window.clearInterval(this.#thumbTimer);
    window.clearInterval(this.#coveredTimer);
    nativeApi()?.setDesk(null);
    this.#listeners.clear();
  }

  // ── Opening and leaving ────────────────────────────────────────────────

  /**
   * Put the saved windows out. The window of the tab in view starts as the
   * whole surface — exactly where its page already is, so nothing moves —
   * and, once its still can stand in, shrinks into its place on the desk.
   * The others fly out of the inventory a beat apart.
   */
  start(saved: readonly SavedDeskWindow[], entryTabId: string | null, groupTabIds: readonly string[]): void {
    const usable = this.#usable();
    const windows = saved
      .filter((window) => groupTabIds.includes(window.tabId))
      .map((window) => ({ tabId: window.tabId, rect: clampRect(denormalizeRect(window.rect, usable), usable) }));
    if (entryTabId !== null && !windows.some((window) => window.tabId === entryTabId)) {
      const rect = windows.length === 0 ? centeredRect(usable) : freeSpot(windows.map((window) => window.rect), { w: usable.w * 0.6, h: usable.h * 0.76 }, usable);
      windows.push({ tabId: entryTabId, rect });
    }
    const entry = entryTabId ?? windows[windows.length - 1]?.tabId ?? null;
    // The window in view goes on top; past the desk's limit, the bottom ones stay in the inventory.
    windows.sort((a, b) => Number(a.tabId === entry) - Number(b.tabId === entry));
    windows.splice(0, Math.max(0, windows.length - MAX_DESK_WINDOWS));
    const now = performance.now();
    windows.forEach((window, index) => {
      const isEntry = window.tabId === entry;
      let win: Win;
      if (isEntry) {
        win = this.#newWin(window.tabId, this.#fullRect());
        win.target = window.rect;
        win.hold = true;
        win.holdUntil = now + 320;
        win.framed = false;
      } else {
        win = this.#flyingIn(window.tabId, window.rect);
        win.delay = 0.06 + index * 0.04;
      }
      this.#wins.set(window.tabId, win);
      this.#order.push(window.tabId);
    });
    this.#focused = entry;
    this.#phase = windows.length === 0 ? "open" : "entering";
    this.#requestThumbs(groupTabIds);
    this.#thumbTimer = window.setInterval(() => this.#requestThumbs(groupTabIds.filter((tabId) => !this.#wins.has(tabId))), THUMB_REFRESH_MS);
    this.#coveredTimer = window.setInterval(() => this.#refreshCovered(), COVERED_REFRESH_MS);
    this.#emit();
    this.#render();
    this.#kick();
  }

  /**
   * Put the desk away: the window in use grows back into the whole surface
   * — to the pixel where its page sits as a pane — and goes live there; the
   * rest fly home into the inventory. Only then does the surface go back to
   * panes, so the swap shows nothing.
   */
  leave(): void {
    if (this.#phase === "leaving") return;
    this.#cancelGesture();
    this.#save();
    this.#phase = "leaving";
    const top = this.#focused !== null && this.#wins.has(this.#focused) ? this.#focused : this.#order[this.#order.length - 1] ?? null;
    for (const win of this.#wins.values()) {
      win.coasting = false;
      win.delay = 0;
      win.lift = { scale: 1, tilt: 0 };
      if (win.tabId === top) {
        win.flight = null;
        win.framed = false;
        win.target = this.#fullRect();
        win.onArrive = null;
      } else {
        this.#sendAway(win, false);
      }
    }
    if (top === null) window.setTimeout(() => this.#host.leaveDone(), 220);
    this.#emit();
    this.#kick();
  }

  // ── What the rest of the browser did ───────────────────────────────────

  /** The tabs of the group now: a window whose tab left it (closed, moved out) goes. */
  syncTabs(groupTabIds: readonly string[]): void {
    let changed = false;
    for (const tabId of [...this.#wins.keys()]) {
      if (groupTabIds.includes(tabId)) continue;
      if (this.#gesture?.tabId === tabId) this.#cancelGesture();
      this.#remove(tabId);
      changed = true;
    }
    if (changed) {
      this.#save();
      this.#emit();
    }
    this.#render();
  }

  /** The browser's active tab changed; if it is on the desk it comes to the top, if not it comes out. */
  activeChanged(tabId: string): void {
    if (this.#phase === "leaving") return;
    if (this.#wins.has(tabId)) {
      if (this.#order[this.#order.length - 1] !== tabId && this.#gesture === null) this.#raise(tabId);
      this.#focused = tabId;
      this.#emit();
      this.#render();
      return;
    }
    this.add(tabId, { focus: true });
  }

  /** Which window's tab is in use — the top one, unless one was just put away. */
  focusedTabId(): string | null {
    return this.#focused;
  }

  windowTabIds(): string[] {
    return [...this.#order];
  }

  // ── Commands ───────────────────────────────────────────────────────────

  /** Bring a tab out of the inventory — or, if its window is out, to the top. */
  add(tabId: string, options: { focus?: boolean; rect?: Rect } = {}): void {
    if (this.#phase === "leaving") return;
    if (this.#wins.has(tabId)) {
      this.#raise(tabId);
      if (options.focus === true) this.#pendingFocus = tabId;
      this.#emit();
      this.#render();
      this.#kick();
      return;
    }
    this.#makeRoom();
    const usable = this.#usable();
    const others = this.#order.map((id) => this.#wins.get(id)!.target ?? this.#wins.get(id)!.rect);
    const target =
      options.rect ?? (others.length === 0 ? centeredRect(usable) : freeSpot(others, { w: usable.w * 0.58, h: usable.h * 0.74 }, usable));
    const win = this.#flyingIn(tabId, target);
    this.#wins.set(tabId, win);
    this.#order.push(tabId);
    this.#focused = tabId;
    if (options.focus !== false) this.#pendingFocus = tabId;
    this.#host.select(tabId);
    this.#emit();
    this.#render();
    this.#kick();
  }

  /** Into the inventory: the window flies to its thumbnail and is gone. The tab stays open. */
  putAway(tabId: string): void {
    const win = this.#wins.get(tabId);
    if (win === undefined || win.flight === "away" || this.#phase === "leaving") return;
    if (this.#gesture?.tabId === tabId) this.#cancelGesture();
    this.#sendAway(win, true);
    this.#emit();
    this.#kick();
  }

  toggleMaximize(tabId: string): void {
    const win = this.#wins.get(tabId);
    if (win === undefined || win.flight !== null || this.#phase !== "open") return;
    const usable = this.#usable();
    const current = win.target ?? win.rect;
    if (sameRect(current, usable, 2)) {
      win.target = win.restore ?? centeredRect(usable);
      win.restore = null;
    } else {
      win.restore = { ...current };
      win.target = { ...usable };
    }
    win.coasting = false;
    this.#raise(tabId);
    this.#pendingFocus = tabId;
    this.#emit();
    this.#kick();
  }

  /** Every window on the desk tiled, or fanned, in the inventory's order — each a beat after the last. */
  arrange(kind: "tile" | "cascade", groupTabIds: readonly string[]): void {
    if (this.#phase !== "open") return;
    this.#cancelGesture();
    const ids = groupTabIds.filter((tabId) => this.#wins.has(tabId) && this.#wins.get(tabId)!.flight !== "away");
    const usable = this.#usable();
    const rects = kind === "tile" ? tileRects(ids.length, usable) : cascadeRects(ids.length, usable);
    ids.forEach((tabId, index) => {
      const win = this.#wins.get(tabId)!;
      win.target = rects[index]!;
      win.restore = null;
      win.coasting = false;
      win.delay = index * 0.035;
    });
    // A cascade reads front to back in the inventory's order.
    if (kind === "cascade") this.#order = [...this.#order.filter((tabId) => !ids.includes(tabId)), ...ids];
    this.#emit();
    this.#kick();
  }

  /** Every tab of the group out on the desk — as many as it holds, in the inventory's order — tiled. */
  gather(groupTabIds: readonly string[]): void {
    if (this.#phase !== "open") return;
    let room = MAX_DESK_WINDOWS - this.#staying().length;
    for (const tabId of groupTabIds) {
      if (room <= 0) break;
      if (this.#wins.has(tabId)) continue;
      this.add(tabId, { focus: false });
      room -= 1;
    }
    this.arrange("tile", groupTabIds);
  }

  // ── Presses and gestures ───────────────────────────────────────────────

  /**
   * A press on a window's frame (`frame`) or on its drawn page (`content`).
   * The window comes to the top at once, as a window does when pressed.
   * If the pointer then travels it becomes a move; if it does not, it was
   * a click — and two on the frame in quick succession maximize.
   */
  press(tabId: string, event: { clientX: number; clientY: number; button: number }, kind: "frame" | "content"): void {
    if (event.button !== 0 || this.#phase !== "open" || !this.#wins.has(tabId) || this.#gesture !== null) return;
    this.#raise(tabId);
    this.#emit();
    this.#render();
    const start = { x: event.clientX, y: event.clientY };
    this.#trackPress(start, {
      onDrag: (point) => this.#beginMove(tabId, start, point),
      onClick: () => {
        const now = performance.now();
        if (kind === "frame" && this.#lastClick?.tabId === tabId && now - this.#lastClick.at < DOUBLE_CLICK_MS) {
          this.#lastClick = null;
          this.toggleMaximize(tabId);
          return;
        }
        this.#lastClick = { tabId, at: now };
        this.#pendingFocus = tabId;
        this.#render();
      },
    });
  }

  /** To the top, and the tab in use — a press on a shell-drawn page, which keeps its pointer. */
  bringForward(tabId: string): void {
    if (this.#phase !== "open" || !this.#wins.has(tabId)) return;
    this.#raise(tabId);
    this.#emit();
    this.#render();
  }

  /** A press with the grab key, from the frame or anywhere on a drawn page: the move starts at once. */
  grab(tabId: string, client: Point): void {
    if (this.#phase !== "open" || !this.#wins.has(tabId) || this.#gesture !== null) return;
    this.#raise(tabId);
    this.#beginMove(tabId, client, null);
  }

  /** Main took a press with the grab key from a live page (@pistachio/shell-contracts/desk). */
  grabFromPage(grab: NativeDeskGrab): void {
    this.grab(grab.tabId, { x: grab.x, y: grab.y });
  }

  /** A press on a resize edge or corner. */
  resize(tabId: string, edges: Edges, event: { clientX: number; clientY: number; button: number }): void {
    const win = this.#wins.get(tabId);
    if (event.button !== 0 || win === undefined || this.#phase !== "open" || this.#gesture !== null || win.flight !== null) return;
    this.#raise(tabId);
    const start = this.#toStage({ x: event.clientX, y: event.clientY });
    win.coasting = false;
    win.target = null;
    win.vel = { ...ZERO_RECT };
    win.restore = null;
    this.#gesture = {
      kind: "resize",
      tabId,
      startedAt: performance.now(),
      start,
      pointer: start,
      startRect: { ...win.rect },
      grab: { x: 0, y: 0 },
      edges,
      tracker: new VelocityTracker(),
      zone: null,
      overRail: false,
      thumbSize: null,
      spawnSize: null,
      end: null,
    };
    this.#prewarm(tabId, false);
    this.#gesture.end = startPaneDrag(
      { x: event.clientX, y: event.clientY },
      { cursor: resizeCursor(edges), onMove: (point) => this.#gestureMove(point), onEnd: () => this.#gestureEnd() },
    );
    this.#emit();
    this.#kick();
  }

  /**
   * A press on a thumbnail in the inventory. A click brings that tab out (or
   * its window to the top); a drag pulls it out as a window that grows from
   * the thumbnail's size to a window's as it leaves the column, and lands
   * wherever it is dropped — or back in the column, if it never left it.
   */
  pressThumb(tabId: string, event: { clientX: number; clientY: number; button: number }): void {
    if (event.button !== 0 || this.#phase !== "open" || this.#gesture !== null) return;
    const start = { x: event.clientX, y: event.clientY };
    this.#trackPress(start, {
      onDrag: (point) => {
        if (this.#wins.has(tabId)) this.add(tabId, { focus: true });
        else this.#beginSpawn(tabId, start, point);
      },
      onClick: () => this.add(tabId, { focus: true }),
    });
  }

  #trackPress(start: Point, handlers: { onDrag: (point: Point) => void; onClick: () => void }): void {
    const cleanup = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
    const onMove = (event: PointerEvent): void => {
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < CLICK_SLOP) return;
      cleanup();
      handlers.onDrag({ x: event.clientX, y: event.clientY });
    };
    const onUp = (): void => {
      cleanup();
      handlers.onClick();
    };
    const onCancel = (): void => cleanup();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  }

  #beginMove(tabId: string, start: Point, current: Point | null): void {
    const win = this.#wins.get(tabId);
    if (win === undefined || win.flight !== null) return;
    const origin = this.#toStage(start);
    win.coasting = false;
    win.target = null;
    win.delay = 0;
    win.vel = { ...ZERO_RECT };
    const lifted = this.#host.variants().motion === "lifted";
    win.lift = { scale: lifted ? LIFT_SCALE : 1, tilt: 0 };
    win.origin = { x: origin.x - win.rect.x, y: origin.y - win.rect.y };
    this.#gesture = {
      kind: "move",
      tabId,
      startedAt: performance.now(),
      start: origin,
      pointer: origin,
      startRect: { ...win.rect },
      grab: { x: (origin.x - win.rect.x) / Math.max(1, win.rect.w), y: (origin.y - win.rect.y) / Math.max(1, win.rect.h) },
      edges: null,
      tracker: new VelocityTracker(),
      zone: null,
      overRail: false,
      thumbSize: null,
      spawnSize: null,
      end: null,
    };
    this.#gesture.tracker.push(origin.x, origin.y, performance.now());
    this.#prewarm(tabId, true);
    this.#gesture.end = startPaneDrag(start, {
      cursor: "grabbing",
      onMove: (point) => this.#gestureMove(point),
      onEnd: () => this.#gestureEnd(),
    });
    this.#emit();
    if (current !== null) this.#gestureMove(current);
    this.#kick();
  }

  #beginSpawn(tabId: string, start: Point, current: Point): void {
    const thumb = this.#thumbRect(tabId);
    if (thumb === null) {
      this.add(tabId, { focus: true });
      return;
    }
    this.#makeRoom();
    const usable = this.#usable();
    const origin = this.#toStage(start);
    const win = this.#newWin(tabId, thumb);
    win.lift = { scale: this.#host.variants().motion === "lifted" ? LIFT_SCALE : 1, tilt: 0 };
    win.origin = { x: origin.x - thumb.x, y: origin.y - thumb.y };
    this.#wins.set(tabId, win);
    this.#order.push(tabId);
    this.#focused = tabId;
    this.#gesture = {
      kind: "spawn",
      tabId,
      startedAt: performance.now(),
      start: origin,
      pointer: origin,
      startRect: { ...thumb },
      grab: { x: (origin.x - thumb.x) / Math.max(1, thumb.w), y: (origin.y - thumb.y) / Math.max(1, thumb.h) },
      edges: null,
      tracker: new VelocityTracker(),
      zone: null,
      overRail: true,
      thumbSize: { w: thumb.w, h: thumb.h },
      spawnSize: { w: Math.round(usable.w * 0.58), h: Math.round(usable.h * 0.74) },
      end: null,
    };
    this.#host.select(tabId);
    this.#prewarm(tabId, true);
    this.#gesture.end = startPaneDrag(start, {
      cursor: "grabbing",
      onMove: (point) => this.#gestureMove(point),
      onEnd: () => this.#gestureEnd(),
    });
    this.#emit();
    this.#gestureMove(current);
    this.#kick();
  }

  /** Stills for every window with a live page, captured now, so none is late when the gesture needs it. */
  #prewarm(tabId: string, carried: boolean): void {
    const now = performance.now();
    for (const win of this.#wins.values()) {
      if (win.tabId === tabId && !carried) continue;
      if (win.still !== null && win.still.at >= now - STILL_GRACE_MS) continue;
      this.#queueCapture(win.tabId, true);
    }
  }

  #gestureMove(client: Point): void {
    const gesture = this.#gesture;
    if (gesture === null) return;
    const win = this.#wins.get(gesture.tabId);
    if (win === undefined) return;
    const point = this.#toStage(client);
    gesture.pointer = point;
    gesture.tracker.push(point.x, point.y, performance.now());
    if (gesture.kind === "resize") this.#placeResized(win, gesture);
    else this.#placeCarried(win, gesture);
    this.#render();
    this.#kick();
  }

  /** The carried window under the pointer: armed zones, the inventory, magnets, the desk's edges. */
  #placeCarried(win: Win, gesture: Gesture): void {
    const usable = this.#usable();
    const point = gesture.pointer;
    gesture.overRail = point.x < RAIL_W + DESK_GAP / 2 && point.y > -24 && point.y < this.#stageBox.height + 24;
    gesture.zone = gesture.overRail ? null : edgeZone(point, usable);
    let rect: Rect = {
      x: point.x - gesture.grab.x * win.rect.w,
      y: point.y - gesture.grab.y * win.rect.h,
      w: win.rect.w,
      h: win.rect.h,
    };
    let guides: Guide[] = [];
    if (!gesture.overRail && gesture.zone === null && gesture.kind === "move") {
      const stuck = magnetize(rect, this.#others(win.tabId), usable);
      rect = stuck.rect;
      guides = stuck.guides;
    }
    // A drawn window is the shell's picture and may travel anywhere; a live
    // page is a native view the shell cannot clip, so it stays on the desk.
    if (!win.drawn) rect = rubberBandRect(rect, usable, LIVE_OVERSHOOT);
    win.rect = rect;
    this.#showGuides(guides);
    this.#showZone(gesture.zone === null ? null : zoneRect(gesture.zone, usable));
    if (this.#host.variants().motion === "lifted") win.lift = { ...win.lift, scale: gesture.overRail ? OVER_RAIL_SCALE : LIFT_SCALE };
    if (gesture.overRail !== this.#armedRail) {
      this.#armedRail = gesture.overRail;
      this.#dirtyView = true;
    }
  }

  #placeResized(win: Win, gesture: Gesture): void {
    const usable = this.#usable();
    const edges = gesture.edges!;
    const resized = resizedRect(gesture.startRect, edges, gesture.pointer.x - gesture.start.x, gesture.pointer.y - gesture.start.y, usable);
    win.rect = magnetizeEdges(resized, edges, this.#others(win.tabId), usable);
  }

  /**
   * The pointer let go. What the window does next is the variant's
   * character: coast on (glide), land in a tile (snap), or stay put (free)
   * — after the things every variant honours: the inventory takes a window
   * dropped on it or flung hard at it, and an armed edge zone takes one
   * dropped there.
   */
  #gestureEnd(): void {
    const gesture = this.#gesture;
    if (gesture === null) return;
    this.#gesture = null;
    this.#showGuides([]);
    this.#showZone(null);
    this.#armedRail = false;
    const win = this.#wins.get(gesture.tabId);
    if (win === undefined) {
      this.#emit();
      return;
    }
    win.lift = { scale: 1, tilt: 0 };
    this.#pendingFocus = win.tabId;
    if (gesture.kind === "resize") {
      this.#save();
      this.#emit();
      this.#render();
      this.#kick();
      return;
    }
    const velocity = gesture.tracker.velocity(performance.now());
    const usable = this.#usable();
    const variants = this.#host.variants();
    // Flung at the inventory: fast, mostly sideways, and headed into its column.
    const flungHome =
      variants.physics !== "free" &&
      velocity.x < -PUT_AWAY_SPEED &&
      Math.abs(velocity.x) > Math.abs(velocity.y) &&
      gesture.pointer.x + glideReach(velocity.x) * 1.2 < RAIL_W;
    if (gesture.overRail || flungHome) {
      this.#sendAway(win, true);
      this.#emit();
      this.#kick();
      return;
    }
    // A window pulled out of the inventory lands at its full size, grown
    // around the point the pointer holds; the spring finishes the growth.
    const basis: Rect =
      gesture.spawnSize === null
        ? win.rect
        : {
            x: gesture.pointer.x - gesture.grab.x * gesture.spawnSize.w,
            y: gesture.pointer.y - gesture.grab.y * gesture.spawnSize.h,
            w: gesture.spawnSize.w,
            h: gesture.spawnSize.h,
          };
    win.vel = { x: velocity.x, y: velocity.y, w: win.vel.w, h: win.vel.h };
    const inside = sameRect(clampRect(basis, usable), basis, 2);
    if (gesture.zone !== null) {
      if (gesture.zone === "maximize") win.restore = { ...gesture.startRect };
      win.target = zoneRect(gesture.zone, usable);
    } else if (variants.physics === "snap") {
      const aim = { x: gesture.pointer.x + velocity.x * 0.16, y: gesture.pointer.y + velocity.y * 0.16 };
      const zone = thirdsZone(aim, usable);
      win.target = zone === "center" ? centeredRect(usable) : zoneRect(zone, usable);
    } else if (variants.physics === "glide" && Math.hypot(velocity.x, velocity.y) > 220 && inside && gesture.spawnSize === null) {
      win.coasting = true;
    } else if (variants.physics === "glide") {
      // Off the desk, or still growing: the spring carries the throw instead of the coast.
      win.target = this.#rest(win, { ...basis, x: basis.x + glideReach(velocity.x) * 0.6, y: basis.y + glideReach(velocity.y) * 0.6 });
    } else {
      win.target = this.#rest(win, basis);
    }
    this.#emit();
    this.#render();
    this.#kick();
  }

  #cancelGesture(): void {
    const gesture = this.#gesture;
    if (gesture === null) return;
    this.#gesture = null;
    gesture.end?.();
    this.#showGuides([]);
    this.#showZone(null);
    this.#armedRail = false;
    const win = this.#wins.get(gesture.tabId);
    if (win !== undefined) {
      win.lift = { scale: 1, tilt: 0 };
      win.target = gesture.kind === "spawn" ? null : this.#rest(win, win.rect);
      if (gesture.kind === "spawn") this.#sendAway(win, true);
    }
  }

  // ── The frame loop ─────────────────────────────────────────────────────

  #kick(): void {
    if (this.#raf !== 0 || this.#destroyed) return;
    this.#last = performance.now();
    this.#raf = requestAnimationFrame(this.#tick);
  }

  #tick = (now: number): void => {
    this.#raf = 0;
    if (this.#destroyed) return;
    const dt = clamp((now - this.#last) / 1_000, 0, 1 / 30);
    this.#last = now;
    let active = this.#gesture !== null;
    for (const win of [...this.#wins.values()]) if (this.#step(win, dt, now)) active = true;
    if (this.#phase === "entering" && !active) {
      this.#phase = "open";
      this.#dirtyView = true;
      this.#save();
    }
    this.#render();
    if (this.#phase === "leaving") active = this.#stepLeave() || active;
    if (active) this.#raf = requestAnimationFrame(this.#tick);
  };

  /** One window's motion over `dt`. True while it is still moving. */
  #step(win: Win, dt: number, now: number): boolean {
    const gesture = this.#gesture?.tabId === win.tabId ? this.#gesture : null;
    let moving = false;
    // Lift and tilt ride their own spring, carried or not.
    const variants = this.#host.variants();
    let tiltTarget = win.lift.tilt;
    if (gesture !== null && gesture.kind !== "resize" && variants.motion === "lifted" && !reducedMotion()) {
      const velocity = gesture.tracker.velocity(now);
      tiltTarget = clamp((velocity.x * (0.5 - gesture.grab.y) - velocity.y * (0.5 - gesture.grab.x)) * 2 * TILT_PER_SPEED, -MAX_TILT, MAX_TILT);
    }
    // A live page cannot be scaled or turned: the lift only shows on a
    // drawn window, and grows in from flat once the still is up.
    const scaleTarget = win.drawn ? win.lift.scale : 1;
    if (!win.drawn) tiltTarget = 0;
    // A flight's scale is its size, so it rides the same spring as its position.
    const scale = stepSpring(win.scale, win.scaleV, scaleTarget, win.flight === null ? LIFT_SPRING : this.#spring(), dt);
    const tilt = stepSpring(win.tilt, win.tiltV, tiltTarget, LIFT_SPRING, dt);
    win.scale = scale.x;
    win.scaleV = scale.v;
    win.tilt = tilt.x;
    win.tiltV = tilt.v;
    if (!springAtRest(win.scale, win.scaleV, scaleTarget, 0.0005, 0.01) || !springAtRest(win.tilt, win.tiltV, tiltTarget, 0.05, 0.5)) moving = true;
    else {
      win.scale = scaleTarget;
      win.tilt = tiltTarget;
      win.scaleV = 0;
      win.tiltV = 0;
    }

    if (gesture !== null) {
      if (gesture.kind === "spawn" && gesture.thumbSize !== null && gesture.spawnSize !== null) {
        const size = gesture.overRail ? gesture.thumbSize : gesture.spawnSize;
        const spring = this.#spring();
        const w = stepSpring(win.rect.w, win.vel.w, size.w, spring, dt);
        const h = stepSpring(win.rect.h, win.vel.h, size.h, spring, dt);
        win.rect = { ...win.rect, w: w.x, h: h.x };
        win.vel = { ...win.vel, w: w.v, h: h.v };
        this.#placeCarried(win, gesture);
      }
      return true;
    }

    if (win.hold) {
      // Entering: wait for the still (or give up waiting) before the window moves.
      if (win.drawn || now >= win.holdUntil || this.#host.variants().motion === "live") {
        win.hold = false;
        win.framed = true;
        this.#dirtyView = true;
      }
      return true;
    }

    if (win.coasting) {
      this.#coast(win, dt);
      return true;
    }

    if (win.target !== null) {
      if (win.delay > 0) {
        win.delay -= dt;
        return true;
      }
      const spring = this.#spring();
      const target = win.target;
      const x = stepSpring(win.rect.x, win.vel.x, target.x, spring, dt);
      const y = stepSpring(win.rect.y, win.vel.y, target.y, spring, dt);
      const w = stepSpring(win.rect.w, win.vel.w, target.w, spring, dt);
      const h = stepSpring(win.rect.h, win.vel.h, target.h, spring, dt);
      win.rect = { x: x.x, y: y.x, w: Math.max(1, w.x), h: Math.max(1, h.x) };
      win.vel = { x: x.v, y: y.v, w: w.v, h: h.v };
      if (
        springAtRest(x.x, x.v, target.x) &&
        springAtRest(y.x, y.v, target.y) &&
        springAtRest(w.x, w.v, target.w) &&
        springAtRest(h.x, h.v, target.h) &&
        // A flight is a picture growing or shrinking: it has arrived when its scale has too.
        (win.flight === null || !moving)
      ) {
        win.rect = { ...target };
        win.vel = { ...ZERO_RECT };
        win.target = null;
        const arrive = win.onArrive;
        win.onArrive = null;
        if (win.flight === "in") {
          win.flight = null;
          this.#dirtyView = true;
        }
        if (this.#phase === "open") this.#save();
        arrive?.();
        return moving;
      }
      return true;
    }
    return moving;
  }

  /**
   * A thrown window: momentum that fades until it slows enough to settle.
   * Meeting an edge ends the coast — the window rests against that edge,
   * and the spring that takes it there starts with the speed it bounced
   * off at, so it visibly rebounds and comes back to lie flush.
   */
  #coast(win: Win, dt: number): void {
    const usable = this.#usable();
    const vx = glideDecay(win.vel.x, dt);
    const vy = glideDecay(win.vel.y, dt);
    let x = win.rect.x + vx * dt;
    let y = win.rect.y + vy * dt;
    const maxX = usable.x + Math.max(0, usable.w - win.rect.w);
    const maxY = usable.y + Math.max(0, usable.h - win.rect.h);
    const hitX = x < usable.x || x > maxX;
    const hitY = y < usable.y || y > maxY;
    x = clamp(x, usable.x, maxX);
    y = clamp(y, usable.y, maxY);
    win.rect = { ...win.rect, x, y };
    if (hitX || hitY) {
      win.coasting = false;
      // Where the rest of the throw was headed, pinned to the edge it met.
      const aim = { ...win.rect, x: hitX ? x : x + glideReach(vx), y: hitY ? y : y + glideReach(vy) };
      win.vel = { ...win.vel, x: hitX ? -vx * BOUNCE_RESTITUTION : vx, y: hitY ? -vy * BOUNCE_RESTITUTION : vy };
      win.target = this.#rest(win, aim);
      return;
    }
    win.vel = { ...win.vel, x: vx, y: vy };
    if (Math.hypot(vx, vy) < GLIDE_STOP_SPEED) {
      win.coasting = false;
      // Where it stopped, pulled onto whatever edge it came to rest beside.
      win.target = this.#rest(win, win.rect);
    }
  }

  /** Leaving: once the window in use is back as the whole surface and live there, hand over to panes. */
  #stepLeave(): boolean {
    const top = [...this.#wins.values()].find((win) => win.flight === null);
    if (top !== undefined && (top.target !== null || (top.drawn && this.#host.hasLivePage(top.tabId)))) return true;
    if (this.#leaveFrames < 0) this.#leaveFrames = 2;
    this.#leaveFrames -= 1;
    if (this.#leaveFrames > 0) return true;
    this.#host.leaveDone();
    return false;
  }

  // ── Drawing and reporting ──────────────────────────────────────────────

  #render(): void {
    if (this.#destroyed) return;
    const now = performance.now();
    const frames = new Map<string, Rect>();
    for (const tabId of this.#order) frames.set(tabId, this.#wins.get(tabId)!.rect);
    const zone = this.#gesture?.zone ?? null;
    // An armed zone is drawn by the shell too; pages under it must give way to it.
    const order = zone === null ? this.#order : [...this.#order.slice(0, -1), "\u0000zone", ...this.#order.slice(-1)];
    if (zone !== null) frames.set("\u0000zone", zoneRect(zone, this.#usable()));
    const uncovered = uncoveredWindows(order, frames);
    for (const win of this.#wins.values()) {
      const wants = !uncovered.has(win.tabId) || this.#wantsStillForMotion(win);
      if (wants) {
        win.wantStillSince ??= this.#gesture?.startedAt ?? now;
        if (!this.#fresh(win)) this.#queueCapture(win.tabId, false);
      } else {
        win.wantStillSince = null;
      }
      const native = this.#host.hasLivePage(win.tabId);
      const forced = win.flight !== null || (this.#gesture?.kind === "spawn" && this.#gesture.tabId === win.tabId);
      const drawn = !native || forced || (wants && this.#fresh(win));
      if (drawn !== win.drawn) {
        win.drawn = drawn;
        this.#dirtyView = true;
      }
      this.#write(win);
    }
    if (this.#dirtyView) this.#emit();
    this.#report();
    this.#flushCaptures();
    this.#focusPending();
  }

  #spring(): SpringConfig {
    return reducedMotion() ? REDUCED_SPRING : SPRING_PRESETS[this.#host.variants().spring];
  }

  #wantsStillForMotion(win: Win): boolean {
    if (win.flight !== null || win.hold) return true;
    const gesture = this.#gesture;
    const carried = gesture?.tabId === win.tabId ? gesture : null;
    if (carried?.kind === "spawn") return true;
    if (this.#host.variants().motion === "live") return false;
    if (carried?.kind === "move") return true;
    return win.coasting || win.target !== null || win.scale !== 1 || win.tilt !== 0;
  }

  #fresh(win: Win): boolean {
    return win.wantStillSince !== null && win.paintedAt >= win.wantStillSince - STILL_GRACE_MS;
  }

  /** Position one window's element, only when something about it changed. */
  #write(win: Win): void {
    const el = win.el;
    if (el === null) return;
    const { x, y, w, h } = win.rect;
    const transformed = win.drawn && (win.scale !== 1 || win.tilt !== 0);
    const transform = transformed
      ? `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) rotate(${win.tilt.toFixed(3)}deg) scale(${win.scale.toFixed(4)})`
      : `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`;
    const key = `${transform}|${w.toFixed(1)}|${h.toFixed(1)}|${win.origin.x.toFixed(0)},${win.origin.y.toFixed(0)}`;
    if (key === win.written) return;
    win.written = key;
    el.style.transform = transform;
    el.style.width = `${w.toFixed(1)}px`;
    el.style.height = `${h.toFixed(1)}px`;
    el.style.transformOrigin = `${win.origin.x.toFixed(0)}px ${win.origin.y.toFixed(0)}px`;
  }

  /** The live pages to main, bottom to top, and which views are desk windows. */
  #report(): void {
    const api = nativeApi();
    if (api === null) return;
    const insets = CHROME_INSETS[this.#host.variants().chrome];
    const { left, top } = this.#stageBox;
    const views: Array<{ tabId: string; bounds: { x: number; y: number; width: number; height: number } }> = [];
    for (const tabId of this.#order) {
      const win = this.#wins.get(tabId)!;
      if (win.drawn) continue;
      const bounds = {
        x: Math.round(left + win.rect.x + insets.left),
        y: Math.round(top + win.rect.y + insets.top),
        width: Math.max(1, Math.round(win.rect.w - insets.left - insets.right)),
        height: Math.max(1, Math.round(win.rect.h - insets.top - insets.bottom)),
      };
      views.push({ tabId, bounds });
    }
    const payload = views.map(({ tabId, bounds }) => `${tabId}:${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`).join(" ");
    if (payload !== this.#sentLayout) {
      this.#sentLayout = payload;
      api.setLayout({ views, stacked: true });
    }
    const grab = this.#host.variants().grab;
    // A window on its way into the inventory is drawn, with no page to grab.
    const desk = { tabIds: this.#staying(), grab: grab === "off" ? null : grab };
    const deskKey = `${desk.tabIds.join(" ")}|${desk.grab ?? ""}`;
    if (deskKey !== this.#sentDesk) {
      this.#sentDesk = deskKey;
      api.setDesk(desk);
    }
  }

  /** The keyboard follows a click, once the window clicked is live to take it. */
  #focusPending(): void {
    const tabId = this.#pendingFocus;
    if (tabId === null || this.#gesture !== null) return;
    const win = this.#wins.get(tabId);
    if (win === undefined) {
      this.#pendingFocus = null;
      return;
    }
    if (!this.#host.hasLivePage(tabId)) {
      this.#pendingFocus = null;
      this.#host.select(tabId);
      return;
    }
    if (win.drawn) return;
    this.#pendingFocus = null;
    nativeApi()?.focusTab(tabId);
  }

  #emit(): void {
    this.#dirtyView = false;
    const thumbs = new Map<string, string>();
    for (const [tabId, still] of this.#thumbs) thumbs.set(tabId, still.src);
    for (const win of this.#wins.values())
      if (win.still !== null && (this.#thumbs.get(win.tabId)?.at ?? -1) < win.still.at) thumbs.set(win.tabId, win.still.src);
    const usable = this.#usable();
    const gesture = this.#gesture;
    this.#view = {
      windows: this.#order.map((tabId, index) => {
        const win = this.#wins.get(tabId)!;
        const carried = gesture?.tabId === tabId && gesture.kind !== "resize";
        return {
          tabId,
          z: index,
          focused: tabId === this.#focused,
          drawn: win.drawn,
          still: win.still?.src ?? this.#thumbs.get(tabId)?.src ?? null,
          carried,
          lifted: carried && this.#host.variants().motion === "lifted",
          flight: win.flight,
          framed: win.framed,
          maximized: sameRect(win.target ?? win.rect, usable, 2),
        };
      }),
      thumbs,
      railArmed: this.#armedRail,
      gesture: gesture?.kind ?? null,
      phase: this.#phase,
    };
    for (const listener of this.#listeners) listener();
  }

  // ── Stills ─────────────────────────────────────────────────────────────

  #queueCapture(tabId: string, force: boolean): void {
    if (this.#inflight.has(tabId) || !this.#host.hasLivePage(tabId)) return;
    const last = this.#requestedAt.get(tabId);
    if (!force && last !== undefined && performance.now() - last < STILL_RETRY_MS) return;
    this.#captureQueue.add(tabId);
  }

  #flushCaptures(): void {
    if (this.#captureQueue.size === 0) return;
    const api = nativeApi();
    const tabIds = [...this.#captureQueue];
    this.#captureQueue.clear();
    if (api === null) return;
    const at = performance.now();
    const insets = CHROME_INSETS[this.#host.variants().chrome];
    let width = 0;
    for (const tabId of tabIds) {
      this.#inflight.add(tabId);
      this.#requestedAt.set(tabId, at);
      const win = this.#wins.get(tabId);
      width = Math.max(width, (win?.target?.w ?? win?.rect.w ?? 640) - insets.left - insets.right, 640);
    }
    const devicePixels = Math.min(MAX_DESK_STILL_WIDTH, Math.round(width * (window.devicePixelRatio || 1)));
    void api
      .captureTabStills(tabIds, devicePixels)
      .catch(() => [])
      .then(async (stills) => {
        const decoded = await Promise.all(stills.map(async (still) => ((await decodes(still.dataUrl)) ? still : null)));
        for (const tabId of tabIds) this.#inflight.delete(tabId);
        if (this.#destroyed) return;
        const landed: Array<{ win: Win; src: string }> = [];
        for (const still of decoded) {
          if (still === null) continue;
          const win = this.#wins.get(still.tabId);
          if (win === undefined) {
            this.#thumbs.set(still.tabId, { src: still.dataUrl, at });
            continue;
          }
          win.still = { src: still.dataUrl, at };
          landed.push({ win, src: still.dataUrl });
        }
        this.#emit();
        // On screen only once React has put the new source there: two frames from now.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            for (const { win, src } of landed) if (win.still?.src === src) win.paintedAt = Math.max(win.paintedAt, at);
            this.#render();
            this.#kick();
          }),
        );
      });
  }

  #requestThumbs(tabIds: readonly string[]): void {
    const api = nativeApi();
    if (api === null || tabIds.length === 0) return;
    const at = performance.now();
    const wanted = tabIds.filter((tabId) => this.#host.hasLivePage(tabId));
    if (wanted.length === 0) return;
    void api
      .captureTabStills(wanted, Math.round(THUMB_WIDTH * Math.min(2, window.devicePixelRatio || 1)))
      .catch(() => [])
      .then((stills) => {
        if (this.#destroyed || stills.length === 0) return;
        for (const still of stills) {
          const current = this.#thumbs.get(still.tabId);
          if (current === undefined || current.at < at) this.#thumbs.set(still.tabId, { src: still.dataUrl, at });
        }
        this.#emit();
      });
  }

  /** Covered windows show their stills for as long as they stay covered; keep those current. */
  #refreshCovered(): void {
    if (this.#gesture !== null || this.#phase !== "open") return;
    let any = false;
    for (const win of this.#wins.values()) {
      if (!win.drawn || win.flight !== null || !this.#host.hasLivePage(win.tabId)) continue;
      this.#queueCapture(win.tabId, true);
      any = true;
    }
    if (any) this.#flushCaptures();
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  #newWin(tabId: string, rect: Rect): Win {
    return {
      tabId,
      rect: { ...rect },
      vel: { ...ZERO_RECT },
      target: null,
      delay: 0,
      coasting: false,
      restore: null,
      scale: 1,
      scaleV: 0,
      tilt: 0,
      tiltV: 0,
      lift: { scale: 1, tilt: 0 },
      origin: { x: rect.w / 2, y: 16 },
      el: null,
      written: "",
      still: null,
      paintedAt: Number.NEGATIVE_INFINITY,
      wantStillSince: null,
      flight: null,
      onArrive: null,
      hold: false,
      holdUntil: 0,
      framed: true,
      drawn: true,
    };
  }

  /** A window coming out of the inventory: at its thumbnail, scaled down to it, headed for `target` at full size. */
  #flyingIn(tabId: string, target: Rect): Win {
    const thumb = this.#thumbRect(tabId) ?? shrunk(target);
    const win = this.#newWin(tabId, { x: thumb.x, y: thumb.y, w: target.w, h: target.h });
    win.origin = { x: 0, y: 0 };
    win.scale = Math.max(0.05, thumb.w / Math.max(1, target.w));
    win.lift = { scale: 1, tilt: 0 };
    win.target = target;
    win.flight = "in";
    return win;
  }

  #raise(tabId: string): void {
    const index = this.#order.indexOf(tabId);
    if (index < 0) return;
    this.#focused = tabId;
    if (index !== this.#order.length - 1) {
      this.#order.splice(index, 1);
      this.#order.push(tabId);
      this.#save();
    }
    this.#dirtyView = true;
    this.#host.select(tabId);
  }

  /**
   * Into the inventory: the window keeps its size and SHRINKS, as a picture
   * does, onto its thumbnail — resizing it instead would crop its still and
   * rewrap its frame on the way down. The scale is re-anchored at the
   * window's corner first, keeping what is on screen where it is.
   */
  #sendAway(win: Win, focusNext: boolean): void {
    const home = this.#thumbRect(win.tabId) ?? { x: RAIL_W / 2 - 40, y: this.#stageBox.height / 2 - 25, w: 80, h: 50 };
    const shown = win.drawn ? win.scale : 1;
    win.rect = {
      ...win.rect,
      x: win.rect.x + win.origin.x * (1 - shown),
      y: win.rect.y + win.origin.y * (1 - shown),
    };
    win.origin = { x: 0, y: 0 };
    win.scale = shown;
    win.written = "";
    win.flight = "away";
    win.coasting = false;
    win.delay = 0;
    win.hold = false;
    win.lift = { scale: Math.max(0.05, home.w / Math.max(1, win.rect.w)), tilt: 0 };
    win.vel = { ...win.vel, w: 0, h: 0 };
    win.target = { x: home.x, y: home.y, w: win.rect.w, h: win.rect.h };
    if (win.still !== null) this.#thumbs.set(win.tabId, win.still);
    win.onArrive = () => {
      this.#remove(win.tabId);
      if (focusNext && this.#focused === null) {
        const next = this.#order[this.#order.length - 1] ?? null;
        this.#focused = next;
        if (next !== null) this.#pendingFocus = next;
      }
      this.#save();
      this.#emit();
    };
    if (this.#focused === win.tabId) this.#focused = null;
  }

  /** The windows staying on the desk, bottom to top: all but those flying into the inventory. */
  #staying(): string[] {
    return this.#order.filter((tabId) => this.#wins.get(tabId)!.flight !== "away");
  }

  /**
   * Main keeps at most MAX_DESK_WINDOWS desk windows
   * (@pistachio/shell-contracts/desk): one coming out onto a full desk
   * sends the bottom window home first.
   */
  #makeRoom(): void {
    let staying = this.#staying();
    while (staying.length >= MAX_DESK_WINDOWS) {
      const bottom = staying.find((tabId) => tabId !== this.#gesture?.tabId);
      if (bottom === undefined) return;
      this.#sendAway(this.#wins.get(bottom)!, false);
      staying = this.#staying();
    }
  }

  #remove(tabId: string): void {
    this.#wins.delete(tabId);
    this.#order = this.#order.filter((id) => id !== tabId);
    if (this.#focused === tabId) this.#focused = this.#order[this.#order.length - 1] ?? null;
    this.#dirtyView = true;
  }

  /** Where a released window rests: inside the desk, stuck to whatever edge it is beside. */
  #rest(win: Win, rect: Rect): Rect {
    const usable = this.#usable();
    const inside = clampRect(rect, usable);
    return clampRect(magnetize(inside, this.#others(win.tabId), usable).rect, usable);
  }

  #others(tabId: string): Rect[] {
    const rects: Rect[] = [];
    for (const id of this.#order) {
      if (id === tabId) continue;
      const win = this.#wins.get(id)!;
      if (win.flight === "away") continue;
      rects.push(win.target ?? win.rect);
    }
    return rects;
  }

  #save(): void {
    if (this.#phase !== "open") return;
    const usable = this.#usable();
    if (usable.w <= 1 || usable.h <= 1) return;
    const windows: SavedDeskWindow[] = [];
    for (const tabId of this.#order) {
      const win = this.#wins.get(tabId)!;
      if (win.flight === "away" || !win.framed) continue;
      windows.push({ tabId, rect: normalizeRect(clampRect(win.target ?? win.rect, usable), usable) });
    }
    this.#host.save(windows);
  }

  /** The desk windows may use: the stage, less the inventory's column and the gap beside it. */
  #usable(): Rect {
    const { width, height } = this.#stageBox;
    return { x: RAIL_W + DESK_GAP, y: 0, w: Math.max(1, width - RAIL_W - DESK_GAP), h: Math.max(1, height) };
  }

  /** A window whose page is exactly the stage: the pane the surface shows without a desk. */
  #fullRect(): Rect {
    const insets = CHROME_INSETS[this.#host.variants().chrome];
    const { width, height } = this.#stageBox;
    return {
      x: -insets.left,
      y: -insets.top,
      w: width + insets.left + insets.right,
      h: height + insets.top + insets.bottom,
    };
  }

  #thumbRect(tabId: string): Rect | null {
    const el = this.#thumbEls.get(tabId);
    if (el === undefined || !el.isConnected) return null;
    const box = el.getBoundingClientRect();
    if (box.width < 1) return null;
    return { x: box.left - this.#stageBox.left, y: box.top - this.#stageBox.top, w: box.width, h: box.height };
  }

  #toStage(client: Point): Point {
    return { x: client.x - this.#stageBox.left, y: client.y - this.#stageBox.top };
  }

  #showZone(rect: Rect | null): void {
    const el = this.#zoneEl;
    if (el === null) return;
    if (rect === null) {
      if (el.dataset["on"] !== undefined) delete el.dataset["on"];
      return;
    }
    el.dataset["on"] = "";
    el.style.transform = `translate3d(${rect.x}px, ${rect.y}px, 0)`;
    el.style.width = `${rect.w}px`;
    el.style.height = `${rect.h}px`;
  }

  #showGuides(guides: readonly Guide[]): void {
    this.#guideEls.forEach((el, index) => {
      const guide = guides[index];
      if (guide === undefined) {
        el.style.opacity = "0";
        return;
      }
      el.style.opacity = "1";
      if (guide.axis === "x") {
        el.style.transform = `translate3d(${guide.at - 0.5}px, ${guide.from}px, 0)`;
        el.style.width = "1px";
        el.style.height = `${guide.to - guide.from}px`;
      } else {
        el.style.transform = `translate3d(${guide.from}px, ${guide.at - 0.5}px, 0)`;
        el.style.width = `${guide.to - guide.from}px`;
        el.style.height = "1px";
      }
    });
  }
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function shrunk(rect: Rect): Rect {
  return { x: rect.x + rect.w * 0.3, y: rect.y + rect.h * 0.3, w: rect.w * 0.4, h: rect.h * 0.4 };
}

function resizeCursor(edges: Edges): DragCursor {
  const horizontal = edges.left || edges.right;
  const vertical = edges.top || edges.bottom;
  if (horizontal && vertical) return (edges.left && edges.top) || (edges.right && edges.bottom) ? "nwse-resize" : "nesw-resize";
  return horizontal ? "ew-resize" : "ns-resize";
}

/** Decode off the main thread before the source is shown, so the swap to it never waits on a decode. */
async function decodes(src: string): Promise<boolean> {
  try {
    const image = new Image();
    image.src = src;
    await image.decode();
    return true;
  } catch {
    return false;
  }
}
