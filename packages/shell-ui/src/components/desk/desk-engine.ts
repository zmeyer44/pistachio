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
 * - a MASKED window (DeskMask) is a picture of part of its page: main shows
 *   the region alone, scaled, while the page keeps laying out at its old
 *   size. It has a handle for a frame, keeps its shape when resized (drawn
 *   meanwhile, its still stretched like the picture it is), and is used as
 *   any page is: main maps the pointer on it to the page's own point. Its
 *   still shows the region, or, taken before it was masked, the whole page,
 *   cropped to the region.
 * - the dock floats over the desk, and a window may lie behind it: the
 *   dock's place is a cover too, so a window there is drawn, under the
 *   dock's glass — except the window in use, which must be live. For that
 *   one the dock steps aside, and comes back once the pointer comes to its
 *   place (#yielding).
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
import {
  deskMaskKey,
  MAX_DESK_STILL_WIDTH,
  MAX_DESK_WINDOWS,
  MIN_DESK_MASK,
  type DeskGrab as NativeDeskGrab,
  type DeskMask,
  type DeskMaskedPage,
} from "@pistachio/shell-contracts/desk";
import { nativeApi } from "../../api";
import { startPaneDrag } from "../../lib/pane-drag";
import {
  bottomOf,
  carrySize,
  cellZone,
  centeredRect,
  clampRect,
  containsPoint,
  DESK_GAP,
  denormalizeRect,
  dockDropAt,
  dockDrops,
  edgeZone,
  fillsDesk,
  freeSpot,
  magnetize,
  magnetizeEdges,
  MIN_WINDOW_H,
  MIN_WINDOW_W,
  normalizeRect,
  placeNewWindow,
  rectsOverlap,
  resizedKeepingAspect,
  resizedRect,
  rubberBandRect,
  sameRect,
  cascadeRects,
  thirdsCell,
  thirdsZone,
  tileRect,
  tileRects,
  uncoveredWindows,
  unfilledSize,
  windowSize,
  type DockDrop,
  type DockDrops,
  type Edges,
  type Guide,
  type MinSize,
  type Point,
  type Rect,
  type ThirdsCell,
  type TileZone,
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

/** A masked window's frame is the bare frame's handle, riding above its region: nothing beside or below it. */
export const MASK_INSETS: Insets = CHROME_INSETS.bare;
export const MASK_CARD_TOP = CHROME_CARD_TOP.bare;
/** A masked window's least size: its region's shorter side no less than a mask may be. */
const MASK_MIN: MinSize = { w: MIN_DESK_MASK, h: MIN_DESK_MASK + MASK_INSETS.top };
/** Masked, the rest of the window fades from around its region in this long. */
const MASK_FADE_MS = 260;
/** A mask put back waits at most this long for a still of the whole window to fade from. */
const MASK_BACK_WAIT_MS = 1_500;

/** The dock's column on the desk's leading side, and an icon in it. */
export const DOCK_W = 60;
export const DOCK_ICON = 40;
/** An icon dragged this far past the dock's edge turns into its window, held by the title bar. */
const DOCK_PULL = 24;
/** Held over one of the dock's pads, a drawn window shrinks toward this width as it fades into the pad. */
const OVER_DOCK_WIDTH = 140;
/** How long a dock icon bounces on taking a window back. */
const RECEIVE_MS = 560;
/** The pads show once a carried window's pointer comes this near the desk's leading edge. */
const DROPS_NEAR = 180;
/** The leading edge's band that offers the left half (and its quarters at the ends): past it are the pads. */
const LEFT_EDGE_BAND = 30;
/** A window taken from the desk by its icon flies to the hand on this. */
const CATCH_SPRING: SpringConfig = { response: 0.3, damping: 0.86 };
/** A preview shown from the dock is freshened if its picture is older than this. */
const PEEK_FRESH_MS = 1_500;
/** The dock's shelf slides out of the way in this long; its place stays covered until it has gone. */
const DOCK_STEP_ASIDE_MS = 240;
/** The pointer is at the dock's place this far above or below its shelf, too. */
const DOCK_PLACE_SLACK = 8;

/** A lifted window's scale, and its tilt per px/s of swing. */
const LIFT_SCALE = 1.035;
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
/** Snap mode: how far past a line between two cells the pointer must go before the other tile is aimed at. */
const SNAP_HYSTERESIS = 16;

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
  /** In hand with a tile lit for it (an edge zone, or Shift's snap): let go, and it goes there. */
  aiming: boolean;
  /** In hand over one of the dock's pads: drawn, it shrinks and fades into the pad, which stands for it. */
  intoDock: boolean;
  /** On its way into the inventory ("away") or out of it ("in"). */
  flight: "in" | "away" | null;
  /** The frame is showing — false while the window is the whole surface, entering or leaving. */
  framed: boolean;
  maximized: boolean;
  /** Masked: only this region of its page shows (DeskMask). */
  mask: DeskMask | null;
  /** What `still` is a picture of: the whole page box, the mask's region, or nothing it can stand for now. */
  stillShows: "page" | "region" | "none";
  /** Its page is frozen for a region to be chosen from it (startMask). */
  selecting: boolean;
  /** Masked a moment ago: where the window it was cut from stood, from its own corner — fading out. */
  maskFade: Rect | null;
}

export interface DeskView {
  windows: readonly DeskWindowView[];
  thumbs: ReadonlyMap<string, string>;
  /**
   * While a window is carried the dock slides away, and two pads stand in
   * its column: back into the dock, and its tab closed. The pads (in the
   * stage's coordinates), whether they are showing (the pointer is near the
   * desk's leading edge), and the one a release now would go to.
   */
  drops: DockDrops;
  dropsShown: boolean;
  dockDrop: DockDrop | null;
  /** A tab's icon is in hand, dragged out of the dock, not yet its window. */
  iconDrag: string | null;
  /** Covers (setCover) no live page paints over any more: what the shell draws there can be seen. */
  clearCovers: ReadonlySet<string>;
  /**
   * The dock is out of the way: it has stepped aside for the window in use,
   * which lies behind it, or it waits for the page under its place to give
   * way to a still before it comes back.
   */
  dockAside: boolean;
  /** Shift is held over a window in hand: every release lands in the tile the pointer is over. */
  snapping: boolean;
  gesture: "move" | "resize" | "spawn" | "icon" | null;
  phase: "entering" | "open" | "leaving";
}

export interface DeskHost {
  variants(): DeskVariants;
  /** A native page can be on screen for this tab right now: awake, not shell-drawn. */
  hasLivePage(tabId: string): boolean;
  /** Make this tab the active one (it wakes if it sleeps). */
  select(tabId: string): void;
  /** Close this tab (a window let go on the dock's Close pad). */
  close(tabId: string): void;
  save(windows: SavedDeskWindow[]): void;
  /** The leaving motion is done: the surface can go back to panes. */
  leaveDone(): void;
}

interface Still {
  src: string;
  /** When it was asked for — the moment it is a picture of. */
  at: number;
  /** The mask it shows the region of (deskMaskKey), or null: the whole page. */
  mask: string | null;
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
  /** Masked (DeskMask): a picture of part of its page. */
  mask: DeskMask | null;
  /**
   * A mask to put back (the desk reopened on this masked window): it lands
   * whole, and once a still of it as it now stands is painted it is masked
   * again and goes to `rect`. `since` is when it landed.
   */
  maskWanted: { mask: DeskMask; rect: Rect; since: number | null; asked: boolean } | null;
}

interface Gesture {
  /**
   * "move" a window on the desk; "resize" one; "spawn" a window just come out
   * of the dock in hand (drawn throughout, and back into the dock if let go
   * over it); "icon" a tab's icon dragged in the dock, before it is pulled
   * clear and becomes one of the others.
   */
  kind: "move" | "resize" | "spawn" | "icon";
  tabId: string;
  startedAt: number;
  start: Point;
  pointer: Point;
  startRect: Rect;
  /** Where the pointer holds the window, as fractions of its size — kept as a pulled-out window grows. */
  grab: Point;
  /**
   * Held by its title bar (or tab, or handle): the pointer's distance below
   * the window's top edge, kept whatever the window's size, so a window
   * that shrinks in hand stays held by its bar. Null: `grab.y` holds.
   */
  pinTop: number | null;
  edges: Edges | null;
  tracker: VelocityTracker;
  /** The tile lit for the window in hand: an edge zone pushed into, or the snap tile under the pointer. */
  zone: TileZone | null;
  /** The zone is snap mode's (Shift held), and `cell` the cell of the desk in thirds it was read from. */
  snapping: boolean;
  cell: ThirdsCell | null;
  overDock: boolean;
  /** Over one of the dock's pads (dockDropAt): let go, and the window goes there. */
  drop: DockDrop | null;
  /** An icon in hand: where on the icon the pointer holds it. */
  ghost: Point | null;
  /** A window flying to the hand (taken by its icon): how far it still is from where the hand holds it. */
  lag: { x: number; y: number; vx: number; vy: number } | null;
  /** A window that filled the desk: the size it lets go to once the pointer travels. */
  unfill: { w: number; h: number } | null;
  /** The size a moved window is growing or shrinking to in hand (it let go of the desk), or null for its own. */
  size: { w: number; h: number } | null;
  end: (() => void) | null;
}

const ZERO_RECT: Rect = { x: 0, y: 0, w: 0, h: 0 };

/** A pointer press, as the shell's handlers hand it on (Shift, when known, is the snap key). */
interface PressEvent {
  clientX: number;
  clientY: number;
  button: number;
  shiftKey?: boolean;
}

export class DeskEngine {
  readonly #host: DeskHost;
  readonly #wins = new Map<string, Win>();
  /** Bottom to top. */
  #order: string[] = [];
  #focused: string | null = null;
  #stage: HTMLElement | null = null;
  #stageBox = { left: 0, top: 0, width: 0, height: 0 };
  #zoneEl: HTMLElement | null = null;
  #ghostEl: HTMLElement | null = null;
  #dropsEl: HTMLElement | null = null;
  /** What the shell draws over the desk beside the dock (setCover), in the stage's coordinates. */
  readonly #covers = new Map<string, Rect>();
  #clearCovers: ReadonlySet<string> = new Set();
  readonly #thumbAskedAt = new Map<string, number>();
  #guideEls: HTMLElement[] = [];
  readonly #iconEls = new Map<string, HTMLElement>();
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
  #retryTimer = 0;
  #pendingFocus: string | null = null;
  #lastClick: { tabId: string; at: number } | null = null;
  #leaveFrames = -1;
  #destroyed = false;
  #armedDrop: DockDrop | null = null;
  #dropsNear = false;
  #drops: DockDrops = dockDrops(0, DOCK_W);
  #dirtyView = false;
  /** Shift is down — the snap key — as the latest key event or pointer sample said. */
  #shift = false;
  /** Where the dock's shelf stands (setDockShelf), in the stage — its resting box, wherever it is sliding. */
  #shelf: Rect | null = null;
  /** The window the person chose to use: if it lies behind the dock, the dock steps aside for it (#yielding). */
  #asideFor: string | null = null;
  /** When the dock began to step aside, for as long as it is aside. */
  #asideSince: number | null = null;
  #dockAside = false;
  /** The pointer is at the dock's place, as the shell's pointer events or main (pointerAtDock) last said. */
  #pointerAtDock = false;
  /** What the dock has open beside it (the Feel menu): it stands while any is. */
  readonly #dockHolds = new Set<string>();
  /** The window whose page is frozen for its mask to be chosen (startMask). */
  #selecting: string | null = null;
  /** A window masked a moment ago, and the window it was cut from, fading until `until`. */
  #maskFade: { tabId: string; from: Rect; until: number } | null = null;

  constructor(host: DeskHost) {
    this.#host = host;
    this.#view = {
      windows: [],
      thumbs: new Map(),
      drops: this.#drops,
      dropsShown: false,
      dockDrop: null,
      iconDrag: null,
      clearCovers: this.#clearCovers,
      dockAside: false,
      snapping: false,
      gesture: null,
      phase: "entering",
    };
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

  /** A tab's icon in the dock: where its window flies out of, and back into. */
  attachIcon(tabId: string, el: HTMLElement | null): void {
    if (el === null) this.#iconEls.delete(tabId);
    else this.#iconEls.set(tabId, el);
  }

  /** The icon in hand while one is dragged out of the dock. */
  attachGhost(el: HTMLElement | null): void {
    this.#ghostEl = el;
  }

  /** The dock's pads: the pointer's height is written to it (`--pointer-y`), and the lit pad's mark follows it. */
  attachDrops(el: HTMLElement | null): void {
    this.#dropsEl = el;
  }

  /**
   * Something the shell draws over the desk beside the dock — a preview, a
   * menu — or null to take it away. A live page is a native view and would
   * paint over it, so the windows under it give way to their stills; the
   * view's `clearCovers` says once none is left there, and it can be shown.
   */
  setCover(key: string, rect: Rect | null): void {
    const before = this.#covers.get(key);
    if (rect === null) {
      if (before === undefined) return;
      this.#covers.delete(key);
    } else {
      if (before !== undefined && sameRect(before, rect, 0.5)) return;
      this.#covers.set(key, { ...rect });
    }
    this.#render();
    this.#kick();
  }

  /** Where the dock's shelf stands, in the stage: its resting box (a slide away does not move it). */
  setDockShelf(rect: Rect | null): void {
    const before = this.#shelf;
    if (rect === null ? before === null : before !== null && sameRect(before, rect, 0.5)) return;
    this.#shelf = rect === null ? null : { ...rect };
    this.#render();
    this.#kick();
  }

  /** The dock has something open beside it (the Feel menu), or no longer: it stands while it does. */
  holdDock(key: string, held: boolean): void {
    if (held === this.#dockHolds.has(key)) return;
    if (held) this.#dockHolds.add(key);
    else this.#dockHolds.delete(key);
    this.#render();
    this.#kick();
  }

  /**
   * The pointer moved over the shell (null: it left the desk). Come to the
   * dock's place, it brings the dock back from where it stepped aside; gone
   * from it, the dock steps aside again for the window in use behind it.
   */
  notePointer(client: Point | null): void {
    const place = this.#dockPlace();
    const at = client !== null && place !== null && containsPoint(place, this.#toStage(client));
    if (at === this.#pointerAtDock) return;
    this.#pointerAtDock = at;
    this.#render();
    this.#kick();
  }

  /** Main: the pointer came to the dock's place over a live page, which the shell never hears (DeskPageInput "dock"). */
  pointerAtDock(): void {
    if (this.#pointerAtDock) return;
    this.#pointerAtDock = true;
    this.#render();
    this.#kick();
  }

  // ── Masks ──────────────────────────────────────────────────────────────

  /**
   * Choose part of a window's page to keep: the page freezes (its still),
   * and a drag over it picks the region (applyMask). Only a live web page
   * can be masked — the shell draws its own pages, and a sleeping one has
   * nothing to show. Again, or Escape, and it is called off (cancelMask).
   */
  startMask(tabId: string): void {
    const win = this.#wins.get(tabId);
    if (win === undefined || win.mask !== null || win.flight !== null || this.#phase !== "open" || !this.#host.hasLivePage(tabId)) return;
    if (this.#gesture !== null) this.#cancelGesture();
    this.#raise(tabId);
    this.#selecting = tabId;
    this.#dirtyView = true;
    this.#render();
    this.#kick();
  }

  cancelMask(): void {
    if (this.#selecting === null) return;
    this.#selecting = null;
    this.#dirtyView = true;
    this.#render();
    this.#kick();
  }

  /**
   * The region chosen, in the page's box (its px, from its top-left): the
   * window becomes that region, where it is, at its own size — the rest of
   * the window fades from around it — and main shows the region alone from
   * then on, the page laying out at the box it had.
   */
  applyMask(tabId: string, region: Rect): void {
    const win = this.#wins.get(tabId);
    if (this.#selecting !== tabId || win === undefined || win.mask !== null) return;
    const insets = this.#insets(win);
    const pageW = Math.round(win.rect.w - insets.left - insets.right);
    const pageH = Math.round(win.rect.h - insets.top - insets.bottom);
    if (pageW < MIN_DESK_MASK || pageH < MIN_DESK_MASK) {
      this.cancelMask();
      return;
    }
    this.#selecting = null;
    const x = Math.round(clamp(region.x, 0, pageW - MIN_DESK_MASK));
    const y = Math.round(clamp(region.y, 0, pageH - MIN_DESK_MASK));
    const width = Math.round(clamp(region.w, MIN_DESK_MASK, pageW - x));
    const height = Math.round(clamp(region.h, MIN_DESK_MASK, pageH - y));
    this.#maskWindow(win, { x, y, width, height, pageWidth: pageW, pageHeight: pageH }, null);
    // In use as it was: its page takes the keyboard once it is live again.
    this.#pendingFocus = tabId;
    this.#render();
    this.#kick();
  }

  /**
   * The window becomes its mask's region, where the region lies on its page
   * now, at the page's own scale — the rest of the window fades from around
   * it — and then, given `then`, goes there (a mask put back, to where it
   * was left).
   */
  #maskWindow(win: Win, mask: DeskMask, then: Rect | null): void {
    const insets = this.#insets(win);
    const from = { ...win.rect };
    const pageX = win.rect.x + insets.left;
    const pageY = win.rect.y + insets.top;
    win.mask = mask;
    win.maskWanted = null;
    win.rect = {
      x: pageX + mask.x - MASK_INSETS.left,
      y: pageY + mask.y - MASK_INSETS.top,
      w: mask.width + MASK_INSETS.left + MASK_INSETS.right,
      h: mask.height + MASK_INSETS.top + MASK_INSETS.bottom,
    };
    win.target = then !== null && !sameRect(then, win.rect, 1) ? { ...then } : null;
    win.restore = null;
    win.coasting = false;
    win.delay = 0;
    win.written = "";
    this.#maskFade = { tabId: win.tabId, from, until: performance.now() + MASK_FADE_MS };
    this.#dirtyView = true;
    this.#save();
  }

  /**
   * A mask put back on a window that landed whole (the desk reopened on it):
   * once a still of the page as it now stands is painted — the page the
   * region is cut from, and fades away around it — or after a while
   * without one, it is masked again, and goes where it was left.
   */
  #putMaskBack(win: Win, now: number): void {
    const wanted = win.maskWanted;
    if (wanted === null || wanted.since === null || this.#phase === "leaving" || win.flight !== null) return;
    const painted = win.paintedAt >= wanted.since && win.still !== null && win.still.mask === null;
    if (painted || now - wanted.since > MASK_BACK_WAIT_MS) {
      this.#maskWindow(win, wanted.mask, wanted.rect);
      return;
    }
    if (!wanted.asked) {
      wanted.asked = true;
      this.#queueCapture(win.tabId, true);
      // If no still comes, the wait ends all the same.
      this.#renderIn(MASK_BACK_WAIT_MS + 20);
    }
  }

  /** The whole page back: the window grows back around its region, at its own scale, the region staying where it is. */
  unmask(tabId: string): void {
    const win = this.#wins.get(tabId);
    if (win === undefined || win.mask === null || win.flight !== null || this.#phase !== "open") return;
    if (this.#gesture?.tabId === tabId) this.#cancelGesture();
    win.target = this.#unmaskedRect(win);
    win.mask = null;
    win.coasting = false;
    win.delay = 0;
    this.#raise(tabId);
    this.#pendingFocus = tabId;
    this.#dirtyView = true;
    this.#save();
    this.#render();
    this.#kick();
  }

  /** The dock is showing this tab's preview: see that its picture is recent. */
  peek(tabId: string): void {
    const now = performance.now();
    if (this.#wins.has(tabId)) {
      this.#queueCapture(tabId, false);
      this.#flushCaptures();
      return;
    }
    const thumb = this.#thumbs.get(tabId);
    const asked = this.#thumbAskedAt.get(tabId) ?? Number.NEGATIVE_INFINITY;
    if ((thumb === undefined || now - thumb.at > PEEK_FRESH_MS) && now - asked > PEEK_FRESH_MS) {
      this.#thumbAskedAt.set(tabId, now);
      this.#requestThumbs([tabId]);
    }
  }

  /** The stage moved or changed size: re-read it, and keep the arrangement in proportion. */
  measure(): void {
    const stage = this.#stage;
    if (stage === null) return;
    const box = stage.getBoundingClientRect();
    const before = this.#usable();
    const resized = this.#stageBox.width > 0 && (box.width !== this.#stageBox.width || box.height !== this.#stageBox.height);
    this.#stageBox = { left: box.left, top: box.top, width: box.width, height: box.height };
    const drops = dockDrops(box.height, DOCK_W);
    if (!sameRect(drops.away, this.#drops.away, 0.5) || !sameRect(drops.close, this.#drops.close, 0.5)) {
      this.#drops = drops;
      this.#dirtyView = true;
    }
    if (resized && this.#phase === "open") {
      const after = this.#usable();
      const reach = this.#reach();
      for (const win of this.#wins.values()) {
        if (this.#gesture?.tabId === win.tabId || win.flight !== null) continue;
        if (win.mask !== null) {
          // A picture keeps its size; only where it is follows the desk.
          const moved = denormalizeRect(normalizeRect(win.rect, before), after);
          win.rect = clampRect({ ...win.rect, x: moved.x, y: moved.y }, reach, MASK_MIN);
          continue;
        }
        win.rect = clampRect(denormalizeRect(normalizeRect(win.rect, before), after), reach);
        if (win.target !== null) win.target = clampRect(denormalizeRect(normalizeRect(win.target, before), after), reach);
        if (win.restore !== null) win.restore = clampRect(denormalizeRect(normalizeRect(win.restore, before), after), reach);
      }
    }
    this.#render();
  }

  /** Anything the host knows changed — a tab woke, the overlay rose, a variant was switched. */
  refresh(): void {
    this.#render();
    this.#kick();
  }

  /**
   * Shift went down or up — the snap key. Held while a window is in hand,
   * the desk is in snap mode: the tile under the pointer lights, and a
   * release lands the window in it. A window in hand re-aims at once,
   * without waiting for the pointer to move.
   */
  setShift(held: boolean): void {
    if (held === this.#shift) return;
    this.#shift = held;
    const gesture = this.#gesture;
    // An icon in hand is not its window yet: that stays where it is (Shift counts once it is taken).
    if (gesture === null || gesture.kind === "resize" || gesture.kind === "icon") return;
    const win = this.#wins.get(gesture.tabId);
    if (win === undefined) return;
    this.#placeCarried(win, gesture);
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
    window.clearTimeout(this.#retryTimer);
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
    const reach = this.#reach();
    const windows: Array<{ tabId: string; rect: Rect; mask: DeskMask | null }> = saved
      .filter((window) => groupTabIds.includes(window.tabId))
      .map((window) =>
        window.mask !== undefined
          ? { tabId: window.tabId, rect: this.#maskedRectFrom(window.rect, window.mask), mask: window.mask }
          : { tabId: window.tabId, rect: clampRect(denormalizeRect(window.rect, usable), reach), mask: null },
      );
    if (entryTabId !== null && !windows.some((window) => window.tabId === entryTabId)) {
      const rect = windows.length === 0 ? centeredRect(usable) : freeSpot(windows.map((window) => window.rect), { w: usable.w * 0.6, h: usable.h * 0.76 }, usable);
      windows.push({ tabId: entryTabId, rect, mask: null });
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
        win.hold = true;
        win.holdUntil = now + 320;
        win.framed = false;
        // Masked, it lifts off whole — the page it is in view as — lands as
        // the window it was cut from, and is masked again there (#putMaskBack).
        if (window.mask !== null) {
          win.target = this.#wholeFor(window.rect, window.mask);
          win.maskWanted = { mask: window.mask, rect: window.rect, since: null, asked: false };
          const wanted = win.maskWanted;
          win.onArrive = () => {
            wanted.since = performance.now();
            this.#dirtyView = true;
          };
        } else {
          win.target = window.rect;
        }
      } else {
        win = this.#flyingIn(window.tabId, window.rect);
        // It comes back masked: main shows only the region, and its stills are of it.
        win.mask = window.mask;
        win.delay = 0.06 + index * 0.04;
      }
      this.#wins.set(window.tabId, win);
      this.#order.push(window.tabId);
    });
    this.#focused = entry;
    this.#phase = windows.length === 0 ? "open" : "entering";
    this.#thumbTimer = window.setInterval(() => this.#requestThumbs(groupTabIds.filter((tabId) => !this.#wins.has(tabId))), THUMB_REFRESH_MS);
    this.#coveredTimer = window.setInterval(() => this.#refreshCovered(), COVERED_REFRESH_MS);
    this.#emit();
    this.#render();
    // After the first render has told main of the masks: a masked page's
    // picture is then of its region, the one its window flies in with.
    this.#requestThumbs(groupTabIds);
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
    this.#selecting = null;
    this.#save();
    this.#phase = "leaving";
    const top = this.#focused !== null && this.#wins.has(this.#focused) ? this.#focused : this.#order[this.#order.length - 1] ?? null;
    for (const win of this.#wins.values()) {
      win.coasting = false;
      win.delay = 0;
      win.lift = { scale: 1, tilt: 0 };
      if (win.tabId === top) {
        // It becomes the pane again: all of its page.
        win.mask = null;
        win.maskWanted = null;
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
      // Chosen from outside the desk (the sidebar, a shortcut), not by a raise of the desk's own.
      const chosen = this.#focused !== tabId;
      if (this.#order[this.#order.length - 1] !== tabId && this.#gesture === null) this.#raise(tabId);
      this.#focused = tabId;
      if (chosen && this.#gesture === null) {
        this.#asideFor = tabId;
        // A window still waiting to take the keyboard (let go behind the dock, drawn) has lost it to this one.
        if (this.#pendingFocus !== tabId) this.#pendingFocus = null;
      }
      this.#emit();
      this.#render();
      this.#kick();
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
      if (options.focus === true) {
        this.#pendingFocus = tabId;
        this.#asideFor = tabId;
      }
      this.#emit();
      this.#render();
      this.#kick();
      return;
    }
    this.#makeRoom();
    const usable = this.#usable();
    const staying = this.#staying();
    const rects = staying.map((id) => this.#wins.get(id)!.target ?? this.#wins.get(id)!.rect);
    // A masked window is a picture: it is never cut in two for a new one.
    const inUse = this.#focused === null || this.#wins.get(this.#focused)?.mask != null ? -1 : staying.indexOf(this.#focused);
    // Where it goes is read from the desk as it is (placeNewWindow): a tiled
    // desk's hole, or half of the window in use, or a free spot.
    const placed = options.rect !== undefined ? { rect: options.rect, split: null } : placeNewWindow(rects, usable, inUse < 0 ? null : inUse);
    if (placed.split !== null) {
      const giving = this.#wins.get(staying[placed.split.index]!)!;
      giving.target = placed.split.rect;
      giving.restore = null;
      giving.coasting = false;
      giving.delay = 0;
    }
    const target = placed.rect;
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
    if (this.#selecting === tabId) this.#selecting = null;
    if (this.#gesture?.tabId === tabId) this.#cancelGesture();
    this.#sendAway(win, true);
    this.#emit();
    this.#kick();
  }

  toggleMaximize(tabId: string): void {
    const win = this.#wins.get(tabId);
    if (win === undefined || win.flight !== null || this.#phase !== "open" || win.mask !== null) return;
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
    // Masked windows are pictures: tiling would stretch them, so they stay where they are.
    const ids = groupTabIds.filter((tabId) => this.#wins.has(tabId) && this.#wins.get(tabId)!.flight !== "away" && this.#wins.get(tabId)!.mask === null);
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
  press(tabId: string, event: PressEvent, kind: "frame" | "content"): void {
    if (event.button !== 0 || this.#phase !== "open" || !this.#wins.has(tabId) || this.#gesture !== null) return;
    this.#noteShift(event.shiftKey);
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
        this.#asideFor = tabId;
        this.#render();
        this.#kick();
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
  grab(tabId: string, client: Point, shift?: boolean): void {
    if (this.#phase !== "open" || !this.#wins.has(tabId) || this.#gesture !== null) return;
    this.#noteShift(shift);
    this.#raise(tabId);
    this.#beginMove(tabId, client, null);
  }

  /** Main took a press with the grab key from a live page (@pistachio/shell-contracts/desk). */
  grabFromPage(grab: NativeDeskGrab): void {
    this.grab(grab.tabId, { x: grab.x, y: grab.y });
  }

  /** A press on a resize edge or corner. */
  resize(tabId: string, edges: Edges, event: PressEvent): void {
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
      pinTop: null,
      edges,
      tracker: new VelocityTracker(),
      zone: null,
      snapping: false,
      cell: null,
      overDock: false,
      drop: null,
      ghost: null,
      lag: null,
      unfill: null,
      size: null,
      end: null,
    };
    // A masked window is drawn while it is resized (its still, stretched like the picture it is).
    this.#prewarm(tabId, win.mask !== null);
    this.#gesture.end = startPaneDrag(
      { x: event.clientX, y: event.clientY },
      { cursor: resizeCursor(edges), onMove: (point, shift) => this.#gestureMove(point, shift), onEnd: () => this.#gestureEnd() },
    );
    this.#emit();
    this.#kick();
  }

  /**
   * A press on a tab's icon in the dock. A click brings the tab out — or its
   * window, if it is out, to the top. A drag takes the icon in hand, and once
   * it is pulled clear of the dock it becomes the tab's window, held by its
   * title bar (#takeInHand).
   */
  pressIcon(tabId: string, event: PressEvent): void {
    if (event.button !== 0 || this.#phase !== "open" || this.#gesture !== null) return;
    this.#noteShift(event.shiftKey);
    const start = { x: event.clientX, y: event.clientY };
    this.#trackPress(start, {
      onDrag: (point) => this.#beginIconDrag(tabId, start, point),
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
      this.#noteShift(event.shiftKey);
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
    // In hand, the dock is out of the way for it; let go behind the dock, the dock comes back over it.
    this.#asideFor = null;
    win.coasting = false;
    win.target = null;
    win.delay = 0;
    win.vel = { ...ZERO_RECT };
    const lifted = this.#host.variants().motion === "lifted";
    win.lift = { scale: lifted ? LIFT_SCALE : 1, tilt: 0 };
    win.origin = { x: origin.x - win.rect.x, y: origin.y - win.rect.y };
    const usable = this.#usable();
    const barHeight = this.#insets(win).top;
    if (this.#selecting === tabId) this.#selecting = null;
    this.#gesture = {
      kind: "move",
      tabId,
      startedAt: performance.now(),
      start: origin,
      pointer: origin,
      startRect: { ...win.rect },
      grab: { x: (origin.x - win.rect.x) / Math.max(1, win.rect.w), y: (origin.y - win.rect.y) / Math.max(1, win.rect.h) },
      pinTop: win.origin.y >= 0 && win.origin.y <= barHeight ? win.origin.y : null,
      edges: null,
      tracker: new VelocityTracker(),
      zone: null,
      snapping: false,
      cell: null,
      overDock: false,
      drop: null,
      ghost: null,
      lag: null,
      // Too big to carry anywhere: once it is really moving, it lets go of the desk.
      unfill: win.mask === null && fillsDesk(win.rect, usable) ? unfilledSize(win.restore, usable) : null,
      size: null,
      end: null,
    };
    this.#gesture.tracker.push(origin.x, origin.y, performance.now());
    this.#prewarm(tabId, true);
    this.#gesture.end = startPaneDrag(start, {
      cursor: "grabbing",
      onMove: (point, shift) => this.#gestureMove(point, shift),
      onEnd: () => this.#gestureEnd(),
    });
    this.#emit();
    if (current !== null) this.#gestureMove(current);
    this.#kick();
  }

  #beginIconDrag(tabId: string, start: Point, current: Point): void {
    if (this.#gesture !== null || this.#phase !== "open") return;
    const origin = this.#toStage(start);
    const icon = this.#iconRect(tabId) ?? { x: origin.x - DOCK_ICON / 2, y: origin.y - DOCK_ICON / 2, w: DOCK_ICON, h: DOCK_ICON };
    this.#gesture = {
      kind: "icon",
      tabId,
      startedAt: performance.now(),
      start: origin,
      pointer: origin,
      startRect: { ...icon },
      grab: { x: 0.5, y: 0.5 },
      pinTop: null,
      edges: null,
      tracker: new VelocityTracker(),
      zone: null,
      snapping: false,
      cell: null,
      overDock: true,
      drop: null,
      ghost: { x: clamp(origin.x - icon.x, 0, icon.w), y: clamp(origin.y - icon.y, 0, icon.h) },
      lag: null,
      unfill: null,
      size: null,
      end: null,
    };
    // Every live page's still, now: the window in hand, and those it will pass over, need one.
    this.#prewarm(tabId, true);
    this.#gesture.end = startPaneDrag(start, {
      cursor: "grabbing",
      onMove: (point, shift) => this.#gestureMove(point, shift),
      onEnd: () => this.#gestureEnd(),
    });
    this.#emit();
    this.#gestureMove(current);
    this.#kick();
  }

  /**
   * The icon in hand is pulled clear of the dock: it becomes the tab's
   * window, and the hand holds it by its title bar, near the bar's leading
   * end — the window reaches out across the desk from the hand, not back
   * over the dock. A window already out comes to the hand as it is, flying
   * there from where it was — scaled down, its shape kept, if it is too big
   * to carry (carrySize); a tab not out comes out at the size windows come out at,
   * growing out of the icon under the pointer. From here it is any window
   * in hand: magnets, zones, Shift's snap, a throw, or back into the dock.
   */
  #takeInHand(gesture: Gesture): void {
    const usable = this.#usable();
    const variants = this.#host.variants();
    const lift = { scale: variants.motion === "lifted" ? LIFT_SCALE : 1, tilt: 0 };
    const point = gesture.pointer;
    const masked = this.#wins.get(gesture.tabId)?.mask != null;
    const pinTop = masked ? MASK_CARD_TOP / 2 : variants.chrome === "bar" ? CHROME_INSETS.bar.top / 2 : CHROME_CARD_TOP[variants.chrome] / 2;
    const holdX = (w: number): number => clamp(point.x - usable.x, 28, w / 2);
    gesture.ghost = null;
    gesture.overDock = false;
    gesture.pinTop = pinTop;
    this.#asideFor = null;
    gesture.tracker.reset();
    gesture.tracker.push(point.x, point.y, performance.now());
    this.#showGhost(null);
    const out = this.#wins.get(gesture.tabId);
    if (out !== undefined) {
      if (out.flight !== null) this.#land(out);
      // Its own size, or scaled to be carried, its shape kept.
      const fit = carrySize(out.rect, usable);
      const size = fit.w < out.rect.w - 0.5 ? fit : null;
      if (size !== null) out.restore = null;
      const w = size?.w ?? out.rect.w;
      const h = size?.h ?? out.rect.h;
      const hold = { x: holdX(w), y: pinTop };
      gesture.kind = "move";
      gesture.startRect = { ...out.rect };
      gesture.grab = { x: hold.x / w, y: hold.y / h };
      gesture.size = size;
      gesture.lag = { x: out.rect.x - (point.x - hold.x), y: out.rect.y - (point.y - hold.y), vx: 0, vy: 0 };
      out.coasting = false;
      out.target = null;
      out.delay = 0;
      out.vel = { ...ZERO_RECT };
      out.lift = lift;
      out.origin = { x: hold.x * (out.rect.w / w), y: hold.y };
      this.#raise(gesture.tabId);
    } else {
      this.#makeRoom();
      const size = windowSize(usable);
      const hold = { x: holdX(size.w), y: pinTop };
      const win = this.#newWin(gesture.tabId, { x: point.x - hold.x, y: point.y - hold.y, w: size.w, h: size.h });
      win.origin = hold;
      win.scale = Math.max(0.04, DOCK_ICON / size.w);
      win.lift = lift;
      this.#wins.set(gesture.tabId, win);
      this.#order.push(gesture.tabId);
      this.#focused = gesture.tabId;
      gesture.kind = "spawn";
      gesture.startRect = { ...win.rect };
      gesture.grab = { x: hold.x / size.w, y: hold.y / size.h };
      this.#host.select(gesture.tabId);
    }
    this.#dirtyView = true;
  }

  /** A window in flight — into the dock, or out of it — stops flying where it is, at full size. */
  #land(win: Win): void {
    win.flight = null;
    win.onArrive = null;
    win.target = null;
    win.written = "";
    this.#dirtyView = true;
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

  #gestureMove(client: Point, shift?: boolean): void {
    const gesture = this.#gesture;
    if (gesture === null) return;
    const win = this.#wins.get(gesture.tabId);
    if (win === undefined && gesture.kind !== "icon") return;
    this.#noteShift(shift);
    const point = this.#toStage(client);
    gesture.pointer = point;
    gesture.tracker.push(point.x, point.y, performance.now());
    if (gesture.kind === "icon") {
      // Still an icon while it is near the dock; pulled clear, it is the window.
      if (point.x <= DOCK_W + DOCK_PULL) {
        this.#showGhost({ x: point.x - gesture.ghost!.x, y: point.y - gesture.ghost!.y });
        this.#render();
        return;
      }
      this.#takeInHand(gesture);
    }
    // A window that filled the desk lets go of it once it is really on the
    // move (a grab starts at the press, before the pointer has gone anywhere).
    if (gesture.unfill !== null && Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y) >= CLICK_SLOP) {
      gesture.size = gesture.unfill;
      gesture.unfill = null;
      win!.restore = null;
      this.#dirtyView = true;
    }
    const carried = this.#wins.get(gesture.tabId)!;
    if (gesture.kind === "resize") this.#placeResized(carried, gesture);
    else this.#placeCarried(carried, gesture);
    this.#render();
    this.#kick();
  }

  /**
   * The carried window under the pointer: the dock's pads, the lit tile
   * (Shift's snap, or an edge zone pushed into), magnets, the desk's edges.
   *
   * The leading edge is read in depth, so no two targets overlap: the
   * desk's first LEFT_EDGE_BAND px offer the left half (its quarters at the
   * ends), and past the desk's edge — the column the dock slid out of, or
   * further — are the pads, back into the dock above, the tab closed below.
   */
  #placeCarried(win: Win, gesture: Gesture): void {
    const usable = this.#usable();
    const point = gesture.pointer;
    gesture.drop = dockDropAt(point, this.#drops, DOCK_W + DESK_GAP / 2, this.#stageBox.height);
    gesture.overDock = gesture.drop !== null;
    // Snap mode: Shift held, the desk is in thirds and the tile under the pointer is lit.
    // (Not for a masked window: a tile would stretch the picture.)
    const picture = win.mask !== null;
    const snapping = this.#shift && !gesture.overDock && !picture;
    gesture.cell = snapping ? thirdsCell(point, usable, gesture.cell, SNAP_HYSTERESIS) : null;
    const zone =
      gesture.cell !== null ? cellZone(gesture.cell) : gesture.overDock || picture ? null : edgeZone(point, usable, 18, 96, LEFT_EDGE_BAND);
    if ((zone === null) !== (gesture.zone === null) || snapping !== gesture.snapping) this.#dirtyView = true;
    gesture.zone = zone;
    gesture.snapping = snapping;
    const hold = { x: gesture.grab.x * win.rect.w, y: gesture.pinTop ?? gesture.grab.y * win.rect.h };
    // Taken by its icon, a window is still on its way to the hand.
    const lag = gesture.lag ?? { x: 0, y: 0 };
    let rect: Rect = { x: point.x - hold.x + lag.x, y: point.y - hold.y + lag.y, w: win.rect.w, h: win.rect.h };
    let guides: Guide[] = [];
    if (!gesture.overDock && zone === null && gesture.kind === "move" && gesture.lag === null) {
      const stuck = magnetize(rect, this.#others(win.tabId), usable);
      rect = stuck.rect;
      guides = stuck.guides;
    }
    // A drawn window is the shell's picture and may travel anywhere; a live
    // page is a native view the shell cannot clip, so it stays on the desk
    // (the dock's column is the desk's: a window may lie behind the dock).
    if (!win.drawn) rect = rubberBandRect(rect, this.#reach(), LIVE_OVERSHOOT, this.#minSize(win));
    win.rect = rect;
    // It lifts and turns about the point it is held by, wherever that is as the window changes size.
    win.origin = hold;
    this.#showGuides(guides);
    this.#showZone(zone === null ? null : tileRect(zone, usable), snapping);
    if (this.#host.variants().motion === "lifted") {
      win.lift = { ...win.lift, scale: gesture.overDock ? clamp(OVER_DOCK_WIDTH / Math.max(1, win.rect.w), 0.08, 0.5) : LIFT_SCALE };
    }
    const near = gesture.overDock || point.x < usable.x + DROPS_NEAR;
    if (near) this.#dropsEl?.style.setProperty("--pointer-y", `${point.y.toFixed(1)}px`);
    if (gesture.drop !== this.#armedDrop || near !== this.#dropsNear) {
      this.#armedDrop = gesture.drop;
      this.#dropsNear = near;
      this.#dirtyView = true;
    }
  }

  /** A reading of Shift from a press or a pointer sample (undefined: it did not say). */
  #noteShift(shift: boolean | undefined): void {
    if (shift !== undefined) this.#shift = shift;
  }

  #placeResized(win: Win, gesture: Gesture): void {
    const edges = gesture.edges!;
    if (win.mask !== null) {
      // A picture: it keeps its region's shape, and scales.
      const dx = gesture.pointer.x - gesture.start.x;
      const dy = gesture.pointer.y - gesture.start.y;
      win.rect = resizedKeepingAspect(gesture.startRect, edges, dx, dy, this.#reach(), MASK_INSETS.top, MIN_DESK_MASK);
      return;
    }
    const resized = resizedRect(gesture.startRect, edges, gesture.pointer.x - gesture.start.x, gesture.pointer.y - gesture.start.y, this.#reach());
    // Out to the desk's leading edge, behind the dock; the dock's own edge sticks on the way.
    win.rect = magnetizeEdges(resized, edges, this.#others(win.tabId), this.#usable());
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
    this.#showZone(null, false);
    // Let go while still an icon — never pulled clear of the dock: nothing changes.
    if (gesture.kind === "icon") {
      this.#showGhost(null);
      this.#emit();
      this.#render();
      return;
    }
    this.#armedDrop = null;
    this.#dropsNear = false;
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
    // (Not while Shift aims it at a tile: the tile it shows is where it goes.)
    const flungHome =
      !gesture.snapping &&
      variants.physics !== "free" &&
      velocity.x < -PUT_AWAY_SPEED &&
      Math.abs(velocity.x) > Math.abs(velocity.y) &&
      gesture.pointer.x + glideReach(velocity.x) * 1.2 < DOCK_W;
    // Let go on the Close pad: into it, and the tab is closed once it is gone.
    if (gesture.drop === "close") {
      this.#closeInto(win, this.#drops.close);
      this.#emit();
      this.#kick();
      return;
    }
    if (gesture.overDock || flungHome) {
      this.#sendAway(win, true);
      this.#emit();
      this.#kick();
      return;
    }
    // A window letting go of the whole desk lands at the size it was headed
    // for, around the point the pointer holds; the spring finishes the change.
    const size = gesture.size;
    const basis: Rect =
      size === null
        ? win.rect
        : {
            x: gesture.pointer.x - gesture.grab.x * size.w,
            y: gesture.pointer.y - (gesture.pinTop ?? gesture.grab.y * size.h),
            w: size.w,
            h: size.h,
          };
    win.vel = { x: velocity.x, y: velocity.y, w: win.vel.w, h: win.vel.h };
    const inside = sameRect(clampRect(basis, this.#reach(), this.#minSize(win)), basis, 2);
    if (gesture.zone !== null) {
      // Filling the desk again, it can be given back the size it had — which,
      // for a window that let go of the desk on the way, is no size of its own.
      if (gesture.zone === "maximize") win.restore = gesture.size === null ? { ...gesture.startRect } : null;
      win.target = tileRect(gesture.zone, usable);
    } else if (variants.physics === "snap" && win.mask === null) {
      const aim = { x: gesture.pointer.x + velocity.x * 0.16, y: gesture.pointer.y + velocity.y * 0.16 };
      win.target = tileRect(thirdsZone(aim, usable), usable);
    } else if (variants.physics === "glide" && Math.hypot(velocity.x, velocity.y) > 220 && inside && size === null) {
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
    this.#showZone(null, false);
    this.#armedDrop = null;
    this.#dropsNear = false;
    this.#showGhost(null);
    const win = gesture.kind === "icon" ? undefined : this.#wins.get(gesture.tabId);
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
    if (this.#maskFade !== null) active = true;
    // (A render may have asked for the next frame itself.)
    if (active && this.#raf === 0) this.#raf = requestAnimationFrame(this.#tick);
  };

  /** One window's motion over `dt`. True while it is still moving. */
  #step(win: Win, dt: number, now: number): boolean {
    // (An icon in hand is not its window yet: that stays as it is.)
    const gesture = this.#gesture?.tabId === win.tabId && this.#gesture.kind !== "icon" ? this.#gesture : null;
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
      let moved = false;
      // In hand and changing size — letting go of the whole desk — about the point the pointer holds.
      const size = gesture.kind === "move" ? gesture.size : null;
      if (size !== null && (win.rect.w !== size.w || win.rect.h !== size.h)) {
        const spring = this.#spring();
        const w = stepSpring(win.rect.w, win.vel.w, size.w, spring, dt);
        const h = stepSpring(win.rect.h, win.vel.h, size.h, spring, dt);
        const arrived = springAtRest(w.x, w.v, size.w) && springAtRest(h.x, h.v, size.h);
        win.rect = { ...win.rect, w: arrived ? size.w : w.x, h: arrived ? size.h : h.x };
        win.vel = { ...win.vel, w: arrived ? 0 : w.v, h: arrived ? 0 : h.v };
        moved = true;
      }
      // Taken by its icon: on its way to the hand.
      const lag = gesture.lag;
      if (lag !== null) {
        const spring = reducedMotion() ? REDUCED_SPRING : CATCH_SPRING;
        const x = stepSpring(lag.x, lag.vx, 0, spring, dt);
        const y = stepSpring(lag.y, lag.vy, 0, spring, dt);
        gesture.lag = springAtRest(x.x, x.v, 0) && springAtRest(y.x, y.v, 0) ? null : { x: x.x, y: y.x, vx: x.v, vy: y.v };
        moved = true;
      }
      if (moved) this.#placeCarried(win, gesture);
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
    // It may coast in behind the dock, as far as the desk's leading edge.
    const reach = this.#reach();
    const vx = glideDecay(win.vel.x, dt);
    const vy = glideDecay(win.vel.y, dt);
    let x = win.rect.x + vx * dt;
    let y = win.rect.y + vy * dt;
    const maxX = reach.x + Math.max(0, reach.w - win.rect.w);
    const maxY = reach.y + Math.max(0, reach.h - win.rect.h);
    const hitX = x < reach.x || x > maxX;
    const hitY = y < reach.y || y > maxY;
    x = clamp(x, reach.x, maxX);
    y = clamp(y, reach.y, maxY);
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
    const gesture = this.#gesture;
    const zone = gesture?.zone ?? null;
    // An armed zone is drawn by the shell too; pages under it must give way to it.
    let order = zone === null ? this.#order : [...this.#order.slice(0, -1), "\u0000zone", ...this.#order.slice(-1)];
    if (zone !== null) frames.set("\u0000zone", tileRect(zone, this.#usable()));
    // So must what is drawn over the desk beside the dock, above every window: the icon in hand, a preview, a menu.
    const covers = new Map(this.#covers);
    if (gesture?.kind === "icon" && gesture.ghost !== null) {
      const at = { x: gesture.pointer.x - gesture.ghost.x - 8, y: gesture.pointer.y - gesture.ghost.y - 8 };
      covers.set("\u0000ghost", { ...at, w: DOCK_ICON + 16, h: DOCK_ICON + 16 });
    }
    // And the dock itself, over any window lying behind it — unless it has
    // stepped aside (and finished sliding away) for the window in use there.
    const yielding = this.#yielding();
    if (!yielding) this.#asideSince = null;
    else this.#asideSince ??= now;
    const shelf = this.#shelfCover();
    const dockStands = shelf !== null && (!yielding || now - this.#asideSince! < DOCK_STEP_ASIDE_MS);
    if (dockStands) covers.set("\u0000dock", shelf);
    // Sliding aside: its place is uncovered once it has gone, a frame from now or later.
    if (yielding && dockStands) this.#kick();
    // A window just masked: the rest of it fades from around its region, over whatever it stood on.
    const fade = this.#maskFade;
    if (fade !== null && (now >= fade.until || !this.#wins.has(fade.tabId))) {
      this.#maskFade = null;
      this.#dirtyView = true;
    } else if (fade !== null) covers.set("\u0000maskfade", fade.from);
    // While a window is carried, the drop rail stands in its column once it shows.
    if (this.#dropsNear && (gesture?.kind === "move" || gesture?.kind === "spawn")) covers.set("\u0000drops", this.#railCover());
    if (covers.size > 0) {
      order = [...order];
      for (const [key, rect] of covers) {
        order.push(`\u0000cover:${key}`);
        frames.set(`\u0000cover:${key}`, rect);
      }
    }
    for (const win of this.#wins.values()) this.#putMaskBack(win, now);
    const uncovered = uncoveredWindows(order, frames);
    for (const win of this.#wins.values()) {
      const wants = !uncovered.has(win.tabId) || this.#wantsStillForMotion(win);
      if (wants) {
        // Only a still asked for from now on will do: ask at once, however recently one was.
        const began = win.wantStillSince === null;
        win.wantStillSince ??= this.#gesture?.startedAt ?? now;
        if (!this.#fresh(win)) this.#queueCapture(win.tabId, began);
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
    this.#checkCovers();
    // The dock slides back only once no live page is left under its place.
    const blocked = dockStands && [...this.#wins.values()].some((win) => !win.drawn && rectsOverlap(win.rect, shelf));
    const aside = yielding || blocked;
    if (aside !== this.#dockAside) {
      this.#dockAside = aside;
      this.#dirtyView = true;
    }
    if (this.#dirtyView) this.#emit();
    this.#report();
    this.#flushCaptures();
    this.#focusPending();
  }

  /** Which covers no live page is under any more (the view's `clearCovers`). */
  #checkCovers(): void {
    const clear = new Set<string>();
    for (const [key, rect] of this.#covers) {
      let live = false;
      for (const win of this.#wins.values()) if (!win.drawn && rectsOverlap(win.rect, rect)) live = true;
      if (!live) clear.add(key);
    }
    const before = this.#clearCovers;
    if (clear.size === before.size && [...clear].every((key) => before.has(key))) return;
    this.#clearCovers = clear;
    this.#dirtyView = true;
  }

  #spring(): SpringConfig {
    return reducedMotion() ? REDUCED_SPRING : SPRING_PRESETS[this.#host.variants().spring];
  }

  #wantsStillForMotion(win: Win): boolean {
    if (win.flight !== null || win.hold || this.#selecting === win.tabId) return true;
    const gesture = this.#gesture;
    const carried = gesture?.tabId === win.tabId ? gesture : null;
    if (carried?.kind === "spawn") return true;
    // A picture being resized is its still, stretched.
    if (carried?.kind === "resize" && win.mask !== null) return true;
    if (this.#host.variants().motion === "live") return false;
    if (carried?.kind === "move") return true;
    return win.coasting || win.target !== null || win.scale !== 1 || win.tilt !== 0;
  }

  #fresh(win: Win): boolean {
    return win.wantStillSince !== null && win.paintedAt >= win.wantStillSince - STILL_GRACE_MS && stillShows(win.still, win.mask) !== "none";
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

  /** The live pages to main, bottom to top, and which views are desk windows (and masked). */
  #report(): void {
    const api = nativeApi();
    if (api === null) return;
    const { left, top } = this.#stageBox;
    // The desk first: a masked page's view is placed only once main has its mask.
    this.#reportDesk(api, left, top);
    const views: Array<{ tabId: string; bounds: { x: number; y: number; width: number; height: number } }> = [];
    for (const tabId of this.#order) {
      const win = this.#wins.get(tabId)!;
      if (win.drawn) continue;
      const insets = this.#insets(win);
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
  }

  /** Which views are desk windows, the grab key, where the dock stands aside, and the masked pages. */
  #reportDesk(api: NonNullable<ReturnType<typeof nativeApi>>, left: number, top: number): void {
    const grab = this.#host.variants().grab;
    // Aside for a window whose page is under its place, the dock comes back
    // as the pointer comes there: main hears that pointer, the shell does not.
    const place = this.#asideSince !== null ? this.#dockPlace() : null;
    const dock =
      place === null ? null : { x: Math.round(left + place.x), y: Math.round(top + place.y), width: Math.round(place.w), height: Math.round(place.h) };
    const masks: DeskMaskedPage[] = [];
    for (const tabId of this.#order) {
      const win = this.#wins.get(tabId)!;
      if (win.mask === null) continue;
      const size = this.#maskShownAt(win);
      masks.push({ tabId, mask: win.mask, width: size.w, height: size.h });
    }
    // A window on its way into the inventory is drawn, with no page to grab.
    const desk = { tabIds: this.#staying(), grab: grab === "off" ? null : grab, dock, masks };
    const deskKey = `${desk.tabIds.join(" ")}|${desk.grab ?? ""}|${dock === null ? "" : `${dock.x},${dock.y},${dock.width},${dock.height}`}|${masks
      .map((page) => `${page.tabId}:${deskMaskKey(page.mask)}:${page.width}x${page.height}`)
      .join(" ")}`;
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
        const carried = gesture?.tabId === tabId && gesture.kind !== "resize" && gesture.kind !== "icon";
        return {
          tabId,
          z: index,
          focused: tabId === this.#focused,
          drawn: win.drawn,
          still: win.still?.src ?? this.#thumbs.get(tabId)?.src ?? null,
          carried,
          lifted: carried && this.#host.variants().motion === "lifted",
          aiming: carried && gesture.zone !== null,
          intoDock: carried && gesture.overDock,
          flight: win.flight,
          framed: win.framed,
          // Letting go of the desk in hand, it is no longer the desk's size, whatever size it has reached.
          maximized: win.mask === null && !(carried && gesture.size !== null) && sameRect(win.target ?? win.rect, usable, 2),
          mask: win.mask,
          stillShows: stillShows(win.still ?? this.#thumbs.get(tabId) ?? null, win.mask),
          selecting: this.#selecting === tabId,
          maskFade:
            this.#maskFade?.tabId === tabId
              ? { x: this.#maskFade.from.x - win.rect.x, y: this.#maskFade.from.y - win.rect.y, w: this.#maskFade.from.w, h: this.#maskFade.from.h }
              : null,
        };
      }),
      thumbs,
      drops: this.#drops,
      dropsShown: this.#dropsNear,
      dockDrop: this.#armedDrop,
      iconDrag: gesture?.kind === "icon" ? gesture.tabId : null,
      clearCovers: this.#clearCovers,
      dockAside: this.#dockAside,
      snapping: gesture?.snapping ?? false,
      gesture: gesture?.kind ?? null,
      phase: this.#phase,
    };
    for (const listener of this.#listeners) listener();
  }

  // ── Stills ─────────────────────────────────────────────────────────────

  #queueCapture(tabId: string, force: boolean): void {
    if (this.#inflight.has(tabId) || !this.#host.hasLivePage(tabId)) return;
    const last = this.#requestedAt.get(tabId);
    const wait = force || last === undefined ? 0 : STILL_RETRY_MS - (performance.now() - last);
    if (wait > 0) {
      // Too soon to ask again — but nothing else may render by then, and a
      // window waiting on its still (a cover waiting on the window) would wait for good.
      this.#renderIn(wait);
      return;
    }
    this.#captureQueue.add(tabId);
  }

  /** Render again in `ms`, unless a render is already due by then. */
  #renderIn(ms: number): void {
    if (this.#retryTimer !== 0 || this.#destroyed) return;
    this.#retryTimer = window.setTimeout(() => {
      this.#retryTimer = 0;
      this.#render();
      this.#kick();
    }, ms + 1);
  }

  #flushCaptures(): void {
    if (this.#captureQueue.size === 0) return;
    const api = nativeApi();
    const tabIds = [...this.#captureQueue];
    this.#captureQueue.clear();
    if (api === null) return;
    const at = performance.now();
    let width = 0;
    for (const tabId of tabIds) {
      this.#inflight.add(tabId);
      this.#requestedAt.set(tabId, at);
      const win = this.#wins.get(tabId);
      const insets = win === undefined ? CHROME_INSETS[this.#host.variants().chrome] : this.#insets(win);
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
          const mask = still.mask ?? null;
          if (win === undefined) {
            this.#thumbs.set(still.tabId, { src: still.dataUrl, at, mask });
            continue;
          }
          win.still = { src: still.dataUrl, at, mask };
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
          if (current === undefined || current.at < at) this.#thumbs.set(still.tabId, { src: still.dataUrl, at, mask: still.mask ?? null });
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
      mask: null,
      maskWanted: null,
    };
  }

  /** A window coming out of the inventory: at its thumbnail, scaled down to it, headed for `target` at full size. */
  #flyingIn(tabId: string, target: Rect): Win {
    const thumb = this.#iconRect(tabId) ?? shrunk(target);
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
    if (this.#asideFor !== tabId) this.#asideFor = null;
    if (this.#selecting !== null && this.#selecting !== tabId) this.#selecting = null;
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
  #sendAway(win: Win, focusNext: boolean, to?: Rect): void {
    const home = to ?? this.#iconRect(win.tabId) ?? { x: DOCK_W / 2 - 40, y: this.#stageBox.height / 2 - 25, w: 80, h: 50 };
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
    const intoIcon = to === undefined;
    win.onArrive = () => {
      this.#remove(win.tabId);
      if (intoIcon) this.#receive(win.tabId);
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

  /** The dock's icon for this tab gives a little bounce: its window has just come back into it. */
  #receive(tabId: string): void {
    const el = this.#iconEls.get(tabId);
    if (el === undefined || el.dataset === undefined) return;
    delete el.dataset["received"];
    // Restart the bounce if one is running (a style read between the two writes).
    void el.offsetWidth;
    el.dataset["received"] = "";
    window.setTimeout(() => {
      if (el.dataset["received"] !== undefined) delete el.dataset["received"];
    }, RECEIVE_MS);
  }

  /**
   * Into the Close pad, as into the dock — shrinking onto the middle of the
   * pad and fading — and once it is gone, its tab is closed. (A tab closed
   * this way comes back as any other: Reopen closed tab.)
   */
  #closeInto(win: Win, pad: Rect): void {
    const w = Math.min(pad.w, pad.h) * 0.7;
    const h = w * (win.rect.h / Math.max(1, win.rect.w));
    this.#sendAway(win, true, { x: pad.x + (pad.w - w) / 2, y: pad.y + (pad.h - h) / 2, w, h });
    const arrive = win.onArrive;
    win.onArrive = () => {
      arrive?.();
      this.#host.close(win.tabId);
    };
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
    if (this.#asideFor === tabId) this.#asideFor = null;
    if (this.#selecting === tabId) this.#selecting = null;
    if (this.#focused === tabId) this.#focused = this.#order[this.#order.length - 1] ?? null;
    this.#dirtyView = true;
  }

  /**
   * Where a released window rests: on the desk — behind the dock too, as far
   * as the desk's leading edge — stuck to whatever edge it is beside, the
   * dock's own edge among them.
   */
  #rest(win: Win, rect: Rect): Rect {
    const reach = this.#reach();
    const min = this.#minSize(win);
    const inside = clampRect(rect, reach, min);
    return clampRect(magnetize(inside, this.#others(win.tabId), this.#usable()).rect, reach, min);
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
      // A masked window is kept masked, where it is (or, its mask not yet put back, where it is going).
      const mask = win.mask ?? win.maskWanted?.mask ?? null;
      const rect = win.mask === null && win.maskWanted !== null ? win.maskWanted.rect : (win.target ?? win.rect);
      const min = mask !== null ? MASK_MIN : undefined;
      windows.push(
        mask !== null
          ? { tabId, rect: normalizeRect(clampRect(rect, this.#reach(), min), usable), mask }
          : { tabId, rect: normalizeRect(clampRect(rect, this.#reach()), usable) },
      );
    }
    this.#host.save(windows);
  }

  /** Where a window's page sits in it: its frame's insets, or a masked window's handle. */
  #insets(win: Win): Insets {
    return win.mask !== null ? MASK_INSETS : CHROME_INSETS[this.#host.variants().chrome];
  }

  #minSize(win: Win): MinSize {
    return win.mask !== null ? MASK_MIN : { w: MIN_WINDOW_W, h: MIN_WINDOW_H };
  }

  /**
   * A masked window's whole window: its page box as it was when masked,
   * framed, placed so the region lies where it is now (at the page's own
   * scale, whatever the picture's), and kept on the desk.
   */
  #unmaskedRect(win: Win): Rect {
    return this.#wholeFor(win.rect, win.mask!);
  }

  /** The whole window a masked window at `rect` was cut from, as #unmaskedRect. */
  #wholeFor(rect: Rect, mask: DeskMask): Rect {
    const insets = CHROME_INSETS[this.#host.variants().chrome];
    const regionX = rect.x + MASK_INSETS.left;
    const regionY = rect.y + MASK_INSETS.top;
    return clampRect(
      {
        x: regionX - mask.x - insets.left,
        y: regionY - mask.y - insets.top,
        w: mask.pageWidth + insets.left + insets.right,
        h: mask.pageHeight + insets.top + insets.bottom,
      },
      this.#reach(),
    );
  }

  /**
   * A masked window as it was saved (fractions of the desk): where it was,
   * at the width it had in proportion to the desk, and — a picture — its
   * region's shape kept, whatever the desk's shape is now.
   */
  #maskedRectFrom(saved: Rect, mask: DeskMask): Rect {
    const box = denormalizeRect(saved, this.#usable());
    const w = Math.max(MIN_DESK_MASK, box.w);
    const h = (w - MASK_INSETS.left - MASK_INSETS.right) * (mask.height / mask.width) + MASK_INSETS.top + MASK_INSETS.bottom;
    const reach = this.#reach();
    // Too big for the desk now: shrunk as a whole, its shape kept.
    const fit = Math.min(1, reach.w / w, reach.h / h);
    return clampRect({ x: box.x, y: box.y, w: w * fit, h: (h - MASK_INSETS.top) * fit + MASK_INSETS.top }, reach, MASK_MIN);
  }

  /**
   * The size a masked window shows its region at, as main should size its
   * view: where it is headed, not each frame on the way — and, while it is
   * being resized (drawn, its still stretched), the size it started at.
   */
  #maskShownAt(win: Win): { w: number; h: number } {
    const gesture = this.#gesture?.tabId === win.tabId ? this.#gesture : null;
    const box =
      gesture?.kind === "resize" ? gesture.startRect : gesture?.kind === "move" && gesture.size !== null ? gesture.size : (win.target ?? win.rect);
    return {
      w: Math.max(1, Math.round(box.w - MASK_INSETS.left - MASK_INSETS.right)),
      h: Math.max(1, Math.round(box.h - MASK_INSETS.top - MASK_INSETS.bottom)),
    };
  }

  /**
   * The desk windows are laid out on: the stage, less the dock's column and
   * the gap beside it. Tiles, filling the desk, the arrangements and where a
   * new window comes out keep clear of the dock, as the Dock's are kept
   * clear of; a window put somewhere by hand may go further (#reach).
   */
  #usable(): Rect {
    const { width, height } = this.#stageBox;
    return { x: DOCK_W + DESK_GAP, y: 0, w: Math.max(1, width - DOCK_W - DESK_GAP), h: Math.max(1, height) };
  }

  /** Where a window may be: the whole stage — behind the dock too, as far as the desk's leading edge. */
  #reach(): Rect {
    const { width, height } = this.#stageBox;
    return { x: 0, y: 0, w: Math.max(1, width), h: Math.max(1, height) };
  }

  /**
   * The dock steps aside for the window in use when that window lies behind
   * it: a live page is a native view and would paint over the dock, and the
   * window in use must be live. The dock stands again once the pointer
   * comes to its place, or while something of it is open (holdDock), or
   * once another window is used, or that one is moved out from behind it.
   */
  #yielding(): boolean {
    const tabId = this.#asideFor;
    const shelf = this.#shelfCover();
    if (tabId === null || shelf === null || this.#phase !== "open" || this.#pointerAtDock || this.#dockHolds.size > 0) return false;
    if (this.#focused !== tabId || this.#gesture?.kind === "icon" || !this.#host.hasLivePage(tabId)) return false;
    const win = this.#wins.get(tabId);
    return win !== undefined && win.flight === null && rectsOverlap(win.target ?? win.rect, shelf);
  }

  /** What the dock's shelf covers of the desk where it stands (its ring included), or null before it has laid out. */
  #shelfCover(): Rect | null {
    const shelf = this.#shelf;
    if (shelf === null || this.#phase === "leaving") return null;
    return { x: shelf.x - 2, y: shelf.y - 2, w: shelf.w + 4, h: shelf.h + 4 };
  }

  /** What the drop rail covers while it stands in the dock's column. */
  #railCover(): Rect {
    const top = this.#drops.away.y;
    return { x: 0, y: top - 2, w: DOCK_W + 2, h: bottomOf(this.#drops.close) - top + 4 };
  }

  /** Where the pointer finds the dock: its column and the gap beside it, level with its shelf. */
  #dockPlace(): Rect | null {
    const shelf = this.#shelf;
    if (shelf === null) return null;
    return { x: 0, y: shelf.y - DOCK_PLACE_SLACK, w: DOCK_W + DESK_GAP, h: shelf.h + DOCK_PLACE_SLACK * 2 };
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

  /**
   * Where a tab's icon rests in the dock — not where it is this frame: the
   * dock slides away while a window is carried, and a window put away on
   * letting go flies to its icon as the dock slides back.
   */
  #iconRect(tabId: string): Rect | null {
    const el = this.#iconEls.get(tabId);
    if (el === undefined || !el.isConnected) return null;
    const box = el.getBoundingClientRect();
    if (box.width < 1) return null;
    const slide = dockSlide(el);
    return { x: box.left - this.#stageBox.left - slide, y: box.top - this.#stageBox.top, w: box.width, h: box.height };
  }

  #toStage(client: Point): Point {
    return { x: client.x - this.#stageBox.left, y: client.y - this.#stageBox.top };
  }

  /** The icon in hand, at `at` (its corner, in the stage) — or put down. */
  #showGhost(at: Point | null): void {
    const el = this.#ghostEl;
    if (el === null) return;
    if (at === null) {
      if (el.dataset["on"] !== undefined) delete el.dataset["on"];
      return;
    }
    el.style.transform = `translate3d(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px, 0)`;
    el.dataset["on"] = "";
  }

  /** Light the tile a carried window would land in — snap mode's own look while Shift aims it. */
  #showZone(rect: Rect | null, snapping: boolean): void {
    const el = this.#zoneEl;
    if (el === null) return;
    if (rect === null) {
      if (el.dataset["on"] !== undefined) delete el.dataset["on"];
      return;
    }
    if (snapping) el.dataset["snap"] = "";
    else delete el.dataset["snap"];
    // Lit afresh, it appears where its tile is and only fades in; once lit,
    // it glides from tile to tile.
    const appearing = el.dataset["on"] === undefined;
    if (appearing) el.style.transition = "opacity 140ms ease";
    el.style.transform = `translate3d(${rect.x}px, ${rect.y}px, 0)`;
    el.style.width = `${rect.w}px`;
    el.style.height = `${rect.h}px`;
    if (appearing) {
      // Commit the jump before the transitions come back.
      void el.offsetWidth;
      el.style.transition = "";
    }
    el.dataset["on"] = "";
  }

  #showGuides(guides: readonly Guide[]): void {
    this.#guideEls.forEach((el, index) => {
      const guide = guides[index];
      if (guide === undefined) {
        // Out of sight and out of the page's box: a hidden line left long would make the shell scrollable.
        el.style.opacity = "0";
        el.style.width = "0px";
        el.style.height = "0px";
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

/** How far the dock's shelf holding `el` is slid off its place right now (its transform's x), or 0. */
function dockSlide(el: HTMLElement): number {
  if (typeof el.closest !== "function" || typeof DOMMatrixReadOnly === "undefined") return 0;
  const shelf = el.closest<HTMLElement>(".desk-dock-shelf");
  if (shelf === null) return 0;
  const transform = getComputedStyle(shelf).transform;
  if (transform === "" || transform === "none") return 0;
  try {
    return new DOMMatrixReadOnly(transform).m41;
  } catch {
    return 0;
  }
}

/** What a still can stand for, for a window masked with `mask` (or not): its region, the whole page (cropped if masked), or nothing. */
function stillShows(still: Still | null, mask: DeskMask | null): "page" | "region" | "none" {
  if (still === null) return "none";
  if (still.mask === null) return "page";
  return mask !== null && still.mask === deskMaskKey(mask) ? "region" : "none";
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
