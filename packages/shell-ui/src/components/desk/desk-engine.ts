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
 *   cropped to the region. Its mask can be EDITED (editMask): the window is
 *   drawn, the whole page shown around the region at its scale, and the
 *   region's edges dragged; main shows the whole page meanwhile through the
 *   same override (the page's box never changes, so the page never knows).
 * - the desk can pass to ANOTHER GROUP in place (switchGroup): the dock
 *   lists the Space's other groups under its tabs, and choosing one sends
 *   this group's windows into their group's new icon there — each once it
 *   has a still to fly as — while the other group's come out of the icon
 *   chosen, to where they were left (or, never on a desk, its tab used last
 *   alone, in the middle).
 * - the dock floats over the desk, and a window may lie behind it: the
 *   dock's place is a cover too, so a window there is drawn, under the
 *   dock's glass — except the window in use, which must be live. For that
 *   one the dock steps aside, and comes back once the pointer comes to its
 *   place (#yielding).
 * - the dock's icons can be REARRANGED: a tab's among the group's tabs, a
 *   group's among the other groups (each in its own section, the icons
 *   there making room for it), and a tab's let go on another group's icon
 *   goes into that group, its window flying there too (#dropInDock). The
 *   browser holds the order; the dock shows the one a drop made until the
 *   browser says the same (dockSettle).
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

import { TRAFFIC_LIGHTS_H, TRAFFIC_LIGHTS_W, type DragCursor } from "@pistachio/shell-contracts/chrome";
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
import { movedOrder } from "../../lib/desk/dock-order";
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
  letGoSize,
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
  glideTauFor,
  SPRING_PRESETS,
  springAtRest,
  stepSpring,
  VelocityTracker,
  type SpringConfig,
} from "../../lib/desk/motion";
import type { DeskChrome, DeskVariants, SavedDeskWindow } from "../../lib/desk/store";
import type { DeskArrangePlan, DeskPercentBox } from "@pistachio/shell-contracts/desk-agent";
import { boxRect, deskZoneRect, percentBox } from "../../lib/desk/agent";

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
/** Editing a mask: its bar (Cancel, Done) stands this far above the page shown around the region. */
export const MASK_EDIT_BAR = { w: 236, h: 34 };
const MASK_EDIT_BAR_GAP = 8;

/** Passing to another group: a live window waits at most this long for the still it flies home as. */
const SWITCH_STILL_WAIT_MS = 400;

/** The dock's column on the desk's leading side, and an icon in it. */
export const DOCK_W = 60;
export const DOCK_ICON = 40;
/** An icon dragged this far past the dock's edge turns into its window, held by the title bar. */
const DOCK_PULL = 24;
/** A tab's icon in hand is over another group's once its middle is inside that icon grown by this much: let go, the tab goes into the group. */
const INTO_SLACK = 4;
/** Another group's icon in hand is held in the dock: past its edge, it goes at most this much further, however far the pointer goes. */
const GROUP_REACH = 36;
/** An icon let go in the dock flies to its place there, or into another group's icon, in this long (the ghost's transition in shell.css). */
const GHOST_LAND_MS = 200;
/** After a drop in the dock, it shows the order the drop made until the browser's says the same — or this long, if it never does. */
const DOCK_SETTLE_MS = 1_500;
/** The drop rail sits this far inside the dock's column, top and bottom (dockDrops). */
const DOCK_DROP_INSET = 6;
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
  /**
   * Growing back from this mask to its whole page (unmask): its still is
   * drawn at the page's place (the window's `--reveal-*` properties, which
   * the engine moves each frame), whichever of the two it shows.
   */
  unmasking: DeskMask | null;
  /** Its page is frozen for a region to be chosen from it (startMask). */
  selecting: boolean;
  /**
   * Its mask is being edited (editMask): where its whole page is shown
   * around the region, and the editor's bar, from the window's corner;
   * `shown` once no live page is left under them, so they can be seen.
   */
  editing: { page: Rect; bar: Rect; shown: boolean } | null;
  /**
   * Masked a moment ago (or its mask edited): where the page it was cut from
   * stood, from its own corner — fading out. `framed`: that is a whole
   * window, its page inside its frame; otherwise the page box alone.
   */
  maskFade: (Rect & { framed: boolean }) | null;
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
  /**
   * The band at the top of the dock's column that the window's own buttons
   * (macOS's traffic lights) sit over, where the stage reaches the window's
   * top-left corner: the shelf keeps clear of it, and of as much at its
   * foot, so it stays centred; the drop rail starts below it.
   */
  dockClear: number;
  dockDrop: DockDrop | null;
  /** A tab's icon is in hand, dragged out of the dock, not yet its window — or let go in the dock, flying to its place there. */
  iconDrag: string | null;
  /** Another group's icon is in hand, moved among the groups — or let go, flying to its place. */
  groupDrag: string | null;
  /** An icon in hand in the dock: where it would go if let go now (the dock opens a gap there). */
  dockDrag: DockDragView | null;
  /** The order a drop in the dock made, shown until the browser's says the same. */
  dockSettle: DockSettleView | null;
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

/**
 * An icon in hand in the dock (DeskView.dockDrag): a tab's among the
 * group's tabs, or another group's among the groups. Each stays in its own
 * section; a tab's may also be let go on another group's icon, as an app is
 * dropped into a folder, and goes into that group.
 */
export interface DockDragView {
  kind: "tab" | "group";
  /** The tab's id, or the group's. */
  id: string;
  /** Its section's icons as they stood when the drag began, top to bottom (it among them). */
  order: readonly string[];
  /** Where it would go among them, counted without it; null while it is nowhere in the section (over another group, say). */
  to: number | null;
  /** A tab's icon over another group's: let go, the tab goes into that group. */
  into: string | null;
  /** From one icon's place to the next's, in px. */
  pitch: number;
}

/** What the dock shows after a drop in it, until the browser has said the same (DeskView.dockSettle). */
export interface DockSettleView {
  /** The group's tabs, top to bottom, as the drop left them. */
  tabs: readonly string[] | null;
  /** The other groups, top to bottom. */
  groups: readonly string[] | null;
  /** A tab let go into another group: no longer the dock's. */
  gone: string | null;
}

/** The desk as the agent reads it (agentLayout): the windows out, bottom to top, and the group's tabs in the dock. */
export interface DeskAgentLayout {
  windows: Array<{ tabId: string; box: DeskPercentBox; focused: boolean; masked: boolean }>;
  docked: string[];
}

/** Where every window was (layoutSnapshot), bottom to top: what Undo layout puts back. */
export interface DeskLayoutSnapshot {
  windows: Array<{ tabId: string; rect: Rect }>;
}

/** A window of another group's desk, drawn small (sketchGroup). */
export interface DeskSketchWindow {
  tabId: string;
  /** Its box in the stage. */
  rect: Rect;
  mask: DeskMask | null;
  /** On top: the window in use, once the desk has passed to the group. */
  focused: boolean;
  still: string | null;
  /** What `still` is a picture of (DeskWindowView's). */
  stillShows: "page" | "region" | "none";
}

/** Another group's desk as it would come out (sketchGroup): the stage's size, and its windows bottom to top. */
export interface DeskSketch {
  width: number;
  height: number;
  windows: DeskSketchWindow[];
}

export interface DeskHost {
  variants(): DeskVariants;
  /** A native page can be on screen for this tab right now: awake, not shell-drawn. */
  hasLivePage(tabId: string): boolean;
  /** Make this tab the active one (it wakes if it sleeps). */
  select(tabId: string): void;
  /** Close this tab (a window let go on the dock's Close pad). */
  close(tabId: string): void;
  /** Edit this tab's address: the address palette, over the desk (a click on a window's title). */
  editAddress(tabId: string): void;
  save(windows: SavedDeskWindow[]): void;
  /** Another of the Space's groups was chosen in the dock: its desk takes this one's place (switchGroup follows). */
  switchGroup(groupId: string): void;
  /** A tab's icon let go at another place in the dock: the tab goes to `index` among the group's other tabs. */
  reorderTab(tabId: string, index: number): void;
  /**
   * A tab's icon let go on another group's: the tab goes into that group.
   * Were it the tab in use, `next` (a window left on the desk, or null for
   * none) takes over first, so the desk is never left on a tab not its own.
   */
  moveTabToGroup(tabId: string, groupId: string, next: string | null): void;
  /** Another group's icon let go at another place among the groups: `order` is the dock's groups as they are to be, top to bottom. */
  reorderGroup(groupId: string, order: readonly string[]): void;
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
  /** Growing back from a mask to its whole page (unmask): see Unmasking. */
  unmasking: Unmasking | null;
  /** Its element carries the `--reveal-*` properties (#write). */
  revealed: boolean;
  /**
   * Flying into its own icon in the dock (#sendAway with nowhere else to
   * go) — the one flight that can be turned back (#recall). Not into the
   * Close pad, which closes its tab on arrival, nor into another group.
   */
  homeward: boolean;
}

/**
 * A window growing back from its mask to its whole page. It is drawn all
 * the way: the page's picture is revealed around the region as the window
 * grows, the region staying where it was, never scaled to the window's box
 * (the window's `--reveal-*` properties, #revealBox). Its page is never
 * given any of the sizes between: main keeps it laid out at its own box
 * until its view is shown there, once the window has landed.
 */
interface Unmasking {
  mask: DeskMask;
  /** The region's box as it was shown, in the stage, and the scale it was shown at. */
  from: Rect;
  scale: number;
  /** Where the whole page lands, in the stage (its own size). */
  to: Rect;
}

interface Gesture {
  /**
   * "move" a window on the desk; "resize" one; "spawn" a window just come out
   * of the dock in hand (drawn throughout, and back into the dock if let go
   * over it); "icon" a tab's icon dragged in the dock, before it is pulled
   * clear and becomes one of the others — or another group's icon, moved
   * among the groups (`dock`), which never leaves the dock.
   */
  kind: "move" | "resize" | "spawn" | "icon";
  /** The window's tab (for "icon", the tab whose icon is in hand; "" for a group's icon). */
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
  /** A window spanning the desk (letGoSize): the size it lets go to once the pointer travels. */
  unfill: { w: number; h: number } | null;
  /** The size a moved window is growing or shrinking to in hand (it let go of the desk), or null for its own. */
  size: { w: number; h: number } | null;
  /** An icon in hand in the dock: where it would go there (DockDrag). */
  dock: DockDrag | null;
  end: (() => void) | null;
}

/**
 * An icon in hand in the dock, and its section as it stood when the drag
 * began: each icon's box in its section's scrolled content (so a scroll
 * meanwhile moves nothing it is read against), and the scroller.
 */
interface DockDrag {
  kind: "tab" | "group";
  id: string;
  items: DockSlot[];
  scroller: Element | null;
  /** Its place among `items`. */
  from: number;
  pitch: number;
  /** A tab's icon: the other groups' icons, which it can be let go on. */
  groups: DockSlot[];
  groupScroller: Element | null;
  to: number | null;
  into: string | null;
}

/** An icon let go in the dock, on its way to its place there (or into a group's icon). */
interface Landing {
  kind: "tab" | "group";
  id: string;
  /** Where it goes, read on the frame after the drop (the dock drawn with the drop by then); null once read. */
  aim: (() => Rect) | null;
  into: boolean;
  /** When it is there. */
  until: number;
  done: () => void;
}

interface DockSlot {
  id: string;
  /** In the stage, as if its section were scrolled to the top (its box then, plus the section's scroll then). */
  rect: Rect;
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
  /** DeskView.dockClear. */
  #dockClear = 0;
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
  /** A tab's icon in the dock is under the pointer: main takes ⇧⌫ for it (setDockHover). */
  #dockHover = false;
  /** The window whose page is frozen for its mask to be chosen (startMask). */
  #selecting: string | null = null;
  /** A window masked a moment ago, and the window it was cut from, fading until `until`. */
  #maskFade: { tabId: string; from: Rect; until: number; framed: boolean } | null = null;
  /** The masked window whose mask is being edited (editMask). */
  #editing: string | null = null;
  /** The group's tabs (start, syncTabs, switchGroup): the dock's, whose pictures are kept fresh. */
  #groupTabIds: readonly string[] = [];
  /** The dock's icons for the Space's other groups (attachGroupIcon). */
  readonly #groupIconEls = new Map<string, HTMLElement>();
  /** When a group's pictures were last asked for from the dock (peekGroup). */
  readonly #groupPeekedAt = new Map<string, number>();
  /** Another group's icon pressed in the dock, and where it stood then: its windows come out of there (switchGroup). */
  #groupPress: { groupId: string; rect: Rect } | null = null;
  /**
   * The windows of a group the desk has passed from (switchGroup), each
   * waiting for a still to fly into its group's icon as: the group, and
   * when it began waiting.
   */
  readonly #departing = new Map<string, { groupId: string; since: number }>();
  /** How many windows are still flying into each group's icon: it bounces as the last lands. */
  readonly #folding = new Map<string, number>();
  /** An icon let go in the dock, flying to its place there or into a group's icon (#landGhost): its place stays faint until it lands. */
  #landing: Landing | null = null;
  /** DeskView.dockSettle, and the timer that gives up on it. */
  #dockSettle: DockSettleView | null = null;
  #settleTimer = 0;
  /** The Bar's band at the desk's foot (setBarBand): windows keep above it. */
  #barBand = 0;

  constructor(host: DeskHost) {
    this.#host = host;
    this.#view = {
      windows: [],
      thumbs: new Map(),
      drops: this.#drops,
      dropsShown: false,
      dockClear: 0,
      dockDrop: null,
      iconDrag: null,
      groupDrag: null,
      dockDrag: null,
      dockSettle: null,
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

  attachGroupIcon(groupId: string, el: HTMLElement | null): void {
    if (el === null) this.#groupIconEls.delete(groupId);
    else this.#groupIconEls.set(groupId, el);
  }

  /** Another group's icon is under the pointer: its tabs' pictures are fetched, so its windows come out as themselves. */
  peekGroup(groupId: string, tabIds: readonly string[]): void {
    const now = performance.now();
    if (now - (this.#groupPeekedAt.get(groupId) ?? Number.NEGATIVE_INFINITY) < PEEK_FRESH_MS) return;
    this.#groupPeekedAt.set(groupId, now);
    this.#requestThumbs(tabIds.slice(0, MAX_DESK_WINDOWS).filter((tabId) => (this.#thumbs.get(tabId)?.at ?? Number.NEGATIVE_INFINITY) < now - PEEK_FRESH_MS));
  }

  /** Another group's icon was clicked: where it stands is kept, for its windows to come out of, and the host passes the desk to it. */
  chooseGroup(groupId: string): void {
    if (this.#phase === "leaving") return;
    const rect = this.#groupIconRect(groupId);
    this.#groupPress = rect === null ? null : { groupId, rect };
    this.#host.switchGroup(groupId);
  }

  /**
   * A press on another group's icon in the dock: a click (`onClick`) passes
   * the desk to it; a drag takes the icon in hand, to be moved among the
   * groups, where the others make room for it.
   */
  pressGroup(groupId: string, event: PressEvent, onClick: () => void): void {
    // (A click counts while the desk is still passing to another group — it can turn straight back — a drag only once it is open.)
    if (event.button !== 0 || this.#phase === "leaving") return;
    const start = { x: event.clientX, y: event.clientY };
    this.#trackPress(start, {
      onDrag: (point) => this.#beginDockDrag("group", groupId, start, point),
      onClick,
    });
  }

  /**
   * Another group's desk as it would come out if the desk passed to it now
   * (laid out as switchGroup lays it out): the stage's size, and its windows
   * in the stage, bottom to top, each with the latest picture of its page —
   * for the dock to draw it small beside the group's icon.
   */
  sketchGroup(tabIds: readonly string[], saved: readonly SavedDeskWindow[], entry: string | null): DeskSketch {
    const { windows, entry: top } = this.#laidOut(saved, tabIds, entry);
    return {
      width: this.#stageBox.width,
      height: this.#stageBox.height,
      windows: windows.map((window) => {
        const still = this.#latestStill(window.tabId);
        return { ...window, focused: window.tabId === top, still: still?.src ?? null, stillShows: stillShows(still, window.mask) };
      }),
    };
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
   * A tab's icon in the dock is under the pointer, or no longer: while one
   * is, ⇧⌫ closes its tab wherever the keyboard is — main takes the key
   * (DeskState.dockHover), and the dock closes the tab it is told of.
   */
  setDockHover(hovered: boolean): void {
    if (hovered === this.#dockHover) return;
    this.#dockHover = hovered;
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
    this.#maskFade = { tabId: win.tabId, from, until: performance.now() + MASK_FADE_MS, framed: true };
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
    if (this.#editing === tabId) this.#editing = null;
    const target = this.#unmaskedRect(win);
    const mask = win.mask;
    const insets = CHROME_INSETS[this.#host.variants().chrome];
    const from = {
      x: win.rect.x + MASK_INSETS.left,
      y: win.rect.y + MASK_INSETS.top,
      w: Math.max(1, win.rect.w - MASK_INSETS.left - MASK_INSETS.right),
      h: Math.max(1, win.rect.h - MASK_INSETS.top - MASK_INSETS.bottom),
    };
    win.unmasking = {
      mask,
      from,
      scale: from.w / Math.max(1, mask.width),
      to: { x: target.x + insets.left, y: target.y + insets.top, w: mask.pageWidth, h: mask.pageHeight },
    };
    win.target = target;
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

  /**
   * Edit a masked window's region: the window is drawn, its whole page
   * shown around the region at the region's scale (the rest dimmed), and
   * the region's edges and corners can be dragged, or the region moved
   * (DeskWindow's MaskEditor). Main shows the whole page meanwhile — the
   * same override, aimed at all of the page's box — so a still of it can
   * be taken. Done (commitMaskEdit) or called off (cancelMaskEdit).
   */
  editMask(tabId: string): void {
    const win = this.#wins.get(tabId);
    if (win === undefined || win.mask === null || win.flight !== null || this.#phase !== "open" || !this.#host.hasLivePage(tabId)) return;
    if (this.#gesture !== null) this.#cancelGesture();
    this.#raise(tabId);
    this.#editing = tabId;
    this.#dirtyView = true;
    this.#render();
    this.#kick();
  }

  cancelMaskEdit(): void {
    const tabId = this.#editing;
    if (tabId === null) return;
    this.#editing = null;
    this.#pendingFocus = tabId;
    this.#dirtyView = true;
    this.#render();
    this.#kick();
  }

  /**
   * The edited region, in the page's box: the window becomes it, where it
   * lies on the page shown, at the same scale — the rest of the page fading
   * from around it, as when it was first masked.
   */
  commitMaskEdit(tabId: string, region: Rect): void {
    const win = this.#wins.get(tabId);
    if (this.#editing !== tabId || win === undefined || win.mask === null) return;
    const mask = win.mask;
    const page = this.#editPage(win);
    const scale = page.w / mask.pageWidth;
    this.#editing = null;
    const x = Math.round(clamp(region.x, 0, mask.pageWidth - MIN_DESK_MASK));
    const y = Math.round(clamp(region.y, 0, mask.pageHeight - MIN_DESK_MASK));
    const next: DeskMask = {
      x,
      y,
      width: Math.round(clamp(region.w, MIN_DESK_MASK, mask.pageWidth - x)),
      height: Math.round(clamp(region.h, MIN_DESK_MASK, mask.pageHeight - y)),
      pageWidth: mask.pageWidth,
      pageHeight: mask.pageHeight,
    };
    if (deskMaskKey(next) !== deskMaskKey(mask)) {
      win.mask = next;
      win.rect = {
        x: page.x + next.x * scale - MASK_INSETS.left,
        y: page.y + next.y * scale - MASK_INSETS.top,
        w: next.width * scale + MASK_INSETS.left + MASK_INSETS.right,
        h: next.height * scale + MASK_INSETS.top + MASK_INSETS.bottom,
      };
      // Where the region lies may be off the desk: the window keeps its size, and comes back onto it.
      const reach = this.#reach();
      const onDesk = {
        ...win.rect,
        x: clamp(win.rect.x, reach.x, Math.max(reach.x, reach.x + reach.w - win.rect.w)),
        y: clamp(win.rect.y, reach.y, Math.max(reach.y, reach.y + reach.h - win.rect.h)),
      };
      win.target = sameRect(onDesk, win.rect, 0.5) ? null : onDesk;
      win.restore = null;
      win.coasting = false;
      win.delay = 0;
      win.written = "";
      this.#maskFade = { tabId, from: page, until: performance.now() + MASK_FADE_MS, framed: false };
      this.#save();
    }
    this.#pendingFocus = tabId;
    this.#dirtyView = true;
    this.#render();
    this.#kick();
  }

  /** Editing a mask: where the whole page is shown, in the stage — around the region, where it is, at its scale. */
  #editPage(win: Win): Rect {
    const mask = win.mask!;
    const scale = Math.max(0.01, (win.rect.w - MASK_INSETS.left - MASK_INSETS.right) / mask.width);
    return {
      x: win.rect.x + MASK_INSETS.left - mask.x * scale,
      y: win.rect.y + MASK_INSETS.top - mask.y * scale,
      w: mask.pageWidth * scale,
      h: mask.pageHeight * scale,
    };
  }

  /** The mask editor's bar: above the page shown, centred on what of it is on the desk — or inside its top, with no room above. */
  #editBar(page: Rect): Rect {
    const reach = this.#reach();
    const left = Math.max(page.x, reach.x);
    const right = Math.min(page.x + page.w, reach.x + reach.w);
    const x = clamp((left + right) / 2 - MASK_EDIT_BAR.w / 2, reach.x + MASK_EDIT_BAR_GAP, reach.x + reach.w - MASK_EDIT_BAR.w - MASK_EDIT_BAR_GAP);
    const above = page.y - MASK_EDIT_BAR_GAP - MASK_EDIT_BAR.h;
    const y = above >= reach.y + MASK_EDIT_BAR_GAP ? above : Math.max(page.y, reach.y) + MASK_EDIT_BAR_GAP;
    return { x, y, ...MASK_EDIT_BAR };
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
    // The window's buttons over the top of the dock's column (the stage at the window's top-left corner).
    const clear = box.left < TRAFFIC_LIGHTS_W ? Math.max(0, Math.round(TRAFFIC_LIGHTS_H - box.top)) : 0;
    if (clear !== this.#dockClear) {
      this.#dockClear = clear;
      this.#dirtyView = true;
    }
    const drops = dockDrops(box.height, DOCK_W, DOCK_DROP_INSET, DESK_GAP, Math.max(DOCK_DROP_INSET, clear));
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
    window.clearTimeout(this.#settleTimer);
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
    // The window in view goes on top.
    const { windows, entry } = this.#laidOut(saved, groupTabIds, entryTabId);
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
    this.#groupTabIds = groupTabIds;
    this.#thumbTimer = window.setInterval(() => this.#requestThumbs(this.#groupTabIds.filter((tabId) => !this.#wins.has(tabId))), THUMB_REFRESH_MS);
    this.#coveredTimer = window.setInterval(() => this.#refreshCovered(), COVERED_REFRESH_MS);
    this.#emit();
    this.#render();
    // After the first render has told main of the masks: a masked page's
    // picture is then of its region, the one its window flies in with.
    this.#requestThumbs(groupTabIds);
    this.#kick();
  }

  /**
   * The desk passes to another of the Space's groups, in place. The group
   * left is saved as it was left (the host still saves under its id), and
   * its windows fly into its icon in the dock — each once a still of it is
   * up, so it flies as what it showed (#departFor). The other group's
   * windows come out of the icon chosen (chooseGroup) to where they were
   * last left — or, never on a desk, its tab used last comes out alone, in
   * the middle — and that tab is chosen, and takes the keyboard.
   */
  switchGroup(next: {
    /** The group the desk passes from: its windows go into its icon. */
    from: string;
    groupId: string;
    tabIds: readonly string[];
    saved: readonly SavedDeskWindow[];
    entry: string | null;
  }): void {
    if (this.#phase === "leaving") return;
    this.#cancelGesture();
    this.#selecting = null;
    this.#editing = null;
    this.#save();
    // The dock's order is the other group's now (a tab just let go into that group among it).
    this.#settleDock(null);
    const now = performance.now();
    for (const tabId of this.#order) {
      const win = this.#wins.get(tabId)!;
      if (win.flight === "away" || this.#departing.has(tabId)) continue;
      win.coasting = false;
      this.#departing.set(tabId, { groupId: next.from, since: now });
    }
    if (this.#pendingFocus !== null && this.#departing.has(this.#pendingFocus)) this.#pendingFocus = null;
    this.#groupTabIds = next.tabIds;
    const from = this.#groupPress?.groupId === next.groupId ? this.#groupPress.rect : this.#dockMiddle();
    this.#groupPress = null;
    // The window in use on top. (A window of this group may still be on its
    // way home, the desk passed from it a moment ago: it is taken back where
    // it was left, not made anew.)
    const { windows, entry } = this.#laidOut(next.saved, next.tabIds, next.entry);
    windows.forEach((window, index) => {
      const homing = this.#wins.get(window.tabId);
      if (homing !== undefined) {
        this.#takeBack(homing, window.rect);
        return;
      }
      const win = this.#flyingIn(window.tabId, window.rect, from);
      win.mask = window.mask;
      win.delay = 0.03 + index * 0.035;
      this.#wins.set(window.tabId, win);
      this.#order.push(window.tabId);
    });
    // Nothing is flying into its icon now: it is the desk's group again, with no icon in the dock.
    this.#folding.delete(next.groupId);
    this.#focused = entry;
    this.#pendingFocus = entry;
    this.#asideFor = null;
    this.#phase = "entering";
    if (entry !== null) this.#host.select(entry);
    this.#dirtyView = true;
    this.#render();
    // After the render has told main of the masks (as start does).
    this.#requestThumbs(next.tabIds.filter((tabId) => this.#wins.has(tabId)));
    // A window whose still never comes flies all the same once the wait is up.
    this.#renderIn(SWITCH_STILL_WAIT_MS + 20);
    this.#kick();
  }

  /** A window on its way into its group's icon, that group come back to the desk: it turns round, to where it was left, on top. */
  #takeBack(win: Win, rect: Rect): void {
    this.#departing.delete(win.tabId);
    if (win.flight === "away") {
      win.flight = "in";
      win.onArrive = null;
      win.lift = { scale: 1, tilt: 0 };
    }
    win.target = rect;
    win.delay = 0;
    win.coasting = false;
    this.#order = [...this.#order.filter((tabId) => tabId !== win.tabId), win.tabId];
  }

  /**
   * A group's windows as they come out onto the desk (start, switchGroup,
   * sketchGroup): each where it was left, in the desk as it is now, and the
   * tab the desk comes up on — out too, alone in the middle or in the room
   * left beside the others — on top. Past the desk's limit, the bottom ones
   * stay in the dock.
   */
  #laidOut(
    saved: readonly SavedDeskWindow[],
    tabIds: readonly string[],
    entryTabId: string | null,
  ): { windows: Array<{ tabId: string; rect: Rect; mask: DeskMask | null }>; entry: string | null } {
    const usable = this.#usable();
    const reach = this.#reach();
    const windows: Array<{ tabId: string; rect: Rect; mask: DeskMask | null }> = saved
      .filter((window) => tabIds.includes(window.tabId))
      .map((window) =>
        window.mask !== undefined
          ? { tabId: window.tabId, rect: this.#maskedRectFrom(window.rect, window.mask), mask: window.mask }
          : { tabId: window.tabId, rect: clampRect(denormalizeRect(window.rect, usable), reach), mask: null },
      );
    const entry = entryTabId !== null && tabIds.includes(entryTabId) ? entryTabId : (windows[windows.length - 1]?.tabId ?? null);
    if (entry !== null && !windows.some((window) => window.tabId === entry)) {
      const rect = windows.length === 0 ? centeredRect(usable) : freeSpot(windows.map((window) => window.rect), { w: usable.w * 0.6, h: usable.h * 0.76 }, usable);
      windows.push({ tabId: entry, rect, mask: null });
    }
    windows.sort((a, b) => Number(a.tabId === entry) - Number(b.tabId === entry));
    windows.splice(0, Math.max(0, windows.length - MAX_DESK_WINDOWS));
    return { windows, entry };
  }

  /** A window of the group the desk passed from, once it has its still (or has waited long enough): into its group's icon. */
  #departFor(win: Win, groupId: string): void {
    this.#sendAway(win, false, this.#groupIconRect(groupId) ?? this.#dockMiddle());
    this.#folding.set(groupId, (this.#folding.get(groupId) ?? 0) + 1);
    const arrive = win.onArrive;
    win.onArrive = () => {
      arrive?.();
      const left = (this.#folding.get(groupId) ?? 1) - 1;
      if (left > 0) {
        this.#folding.set(groupId, left);
        return;
      }
      this.#folding.delete(groupId);
      this.#bounce(this.#groupIconEls.get(groupId));
    };
    this.#dirtyView = true;
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
    this.#editing = null;
    this.#departing.clear();
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
    this.#groupTabIds = groupTabIds;
    // The browser's order has caught up with a drop in the dock: the dock shows its own again.
    const settled = this.#dockSettle?.tabs;
    if (settled != null && settled.length === groupTabIds.length && settled.every((tabId, index) => tabId === groupTabIds[index])) {
      this.#settleDock(null);
      this.#emit();
    }
    let changed = false;
    for (const [tabId, win] of [...this.#wins]) {
      // (A window of a group the desk has passed from is on its way into that group's icon.)
      if (groupTabIds.includes(tabId) || this.#departing.has(tabId) || win.flight === "away") continue;
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

  /**
   * A tab of the group sent to another group from its icon's menu: as if
   * its icon were let go on that group's (#dropInDock) — gone from the dock
   * at once, its window flying into the group's icon — without an icon in
   * hand to fly there. With no window to fly, the group's icon bounces.
   */
  moveTabToGroup(tabId: string, groupId: string): void {
    if (this.#phase === "leaving" || !this.#groupTabIds.includes(tabId)) return;
    const flies = this.#wins.has(tabId);
    this.#settleDock({ tabs: this.#groupTabIds.filter((id) => id !== tabId), groups: null, gone: tabId });
    this.#moveToGroup(tabId, groupId);
    if (!flies) this.#bounce(this.#groupIconEls.get(groupId));
    this.#emit();
    this.#render();
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
  arrange(kind: "tile" | "cascade", groupTabIds: readonly string[] = this.#groupTabIds): void {
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

  // ── The agent's hand (docs/desk-agent.md §2) ──────────────────────────

  /**
   * The Bar's band at the desk's foot, or 0: the desk stops above it, as it
   * stops beside the dock, and the windows spring into the smaller desk.
   */
  setBarBand(height: number): void {
    const band = Math.max(0, Math.round(height));
    if (band === this.#barBand) return;
    const before = this.#usable();
    this.#barBand = band;
    const after = this.#usable();
    const reach = this.#reach();
    if (this.#phase === "open") {
      for (const win of this.#wins.values()) {
        if (this.#gesture?.tabId === win.tabId || win.flight !== null) continue;
        const from = win.target ?? win.rect;
        if (win.mask !== null) {
          // A picture keeps its size; only where it is follows the desk.
          const moved = denormalizeRect(normalizeRect(from, before), after);
          win.target = clampRect({ ...from, x: moved.x, y: moved.y }, reach, MASK_MIN);
        } else {
          win.target = clampRect(denormalizeRect(normalizeRect(from, before), after), reach);
          if (win.restore !== null) win.restore = clampRect(denormalizeRect(normalizeRect(win.restore, before), after), reach);
        }
        win.coasting = false;
      }
    }
    this.#emit();
    this.#render();
    this.#kick();
  }

  /** The tab is one of the group's (a tab the agent just opened may not be yet). */
  hasGroupTab(tabId: string): boolean {
    return this.#groupTabIds.includes(tabId);
  }

  /** The desk as the agent reads it: every window out, bottom to top, where it is going, as percents of the desk. */
  agentLayout(): DeskAgentLayout {
    const usable = this.#usable();
    const out = this.#staying();
    return {
      windows: out.map((tabId) => {
        const win = this.#wins.get(tabId)!;
        return { tabId, box: percentBox(win.target ?? win.rect, usable), focused: tabId === this.#focused, masked: win.mask !== null };
      }),
      docked: this.#groupTabIds.filter((tabId) => !out.includes(tabId)),
    };
  }

  /**
   * The agent's arrangement, all at once, moving as the person's do: tabs
   * brought out of the dock, windows put away, a tile or cascade, windows
   * placed in zones or boxes. The window in use keeps the keyboard and
   * stays out; a new window comes out under it. An error says what could
   * not be done, and then nothing moved.
   */
  arrangeFor(plan: DeskArrangePlan): string | null {
    if (this.#phase !== "open") return "the desk is not open yet";
    if (this.#gesture !== null) return "the person has a window in hand; try again in a moment";
    const members = new Set(this.#groupTabIds);
    const named = [...(plan.place ?? []).map((entry) => entry.tabId), ...(plan.putAway ?? []), ...(plan.bringOut ?? [])];
    const stranger = named.find((tabId) => !members.has(tabId));
    if (stranger !== undefined) return `tab ${stranger} is not on this desk`;
    if (this.#focused !== null && plan.putAway?.includes(this.#focused) === true) return "the window in use stays out: the person is using it";
    if ((plan.place ?? []).some((entry) => entry.zone === undefined && entry.box === undefined)) return "each window placed needs a zone or a box";
    const placed = new Set((plan.place ?? []).map((entry) => entry.tabId));
    if ((plan.putAway ?? []).some((tabId) => placed.has(tabId))) return "a window cannot be placed and put away at once";
    for (const tabId of plan.bringOut ?? []) if (!placed.has(tabId)) this.#addQuiet(tabId);
    for (const tabId of plan.putAway ?? []) {
      const win = this.#wins.get(tabId);
      if (win !== undefined && win.flight !== "away") this.#sendAway(win, false);
    }
    if (plan.layout !== undefined) this.arrange(plan.layout);
    const usable = this.#usable();
    const reach = this.#reach();
    (plan.place ?? []).forEach((entry, index) => {
      const rect = entry.zone !== undefined ? deskZoneRect(entry.zone, usable) : boxRect(entry.box!, usable);
      const win = this.#wins.get(entry.tabId);
      if (win === undefined) {
        this.#addQuiet(entry.tabId, rect);
        return;
      }
      // Still on its way into the dock (put away a moment ago): it turns back. On its way to be closed, or to another group, it goes on.
      if (win.flight === "away" && !this.#recall(win)) return;
      // A masked window is a picture: it keeps its size, in the middle of its place.
      win.target = win.mask !== null ? clampRect({ ...win.rect, x: rect.x + (rect.w - win.rect.w) / 2, y: rect.y + (rect.h - win.rect.h) / 2 }, reach, MASK_MIN) : rect;
      win.restore = null;
      win.coasting = false;
      win.delay = index * 0.035;
    });
    this.#save();
    this.#emit();
    this.#render();
    this.#kick();
    return null;
  }

  /** A tab the agent opened in the group: out onto the desk beside the window in use, without the keyboard. */
  bringOutQuietly(tabId: string): void {
    if (this.#phase !== "open" || !this.#groupTabIds.includes(tabId) || this.#wins.has(tabId)) return;
    this.#addQuiet(tabId);
    this.#emit();
    this.#render();
    this.#kick();
  }

  /** Where every window is going now: what Undo layout puts back. */
  layoutSnapshot(): DeskLayoutSnapshot {
    return { windows: this.#staying().map((tabId) => ({ tabId, rect: { ...(this.#wins.get(tabId)!.target ?? this.#wins.get(tabId)!.rect) } })) };
  }

  /**
   * Every window back where a snapshot had it: the ones it did not have go
   * into the dock (the window in use excepted), the ones it had come out,
   * and the stack is its order again — the window in use on top.
   */
  restoreLayout(snapshot: DeskLayoutSnapshot): void {
    if (this.#phase !== "open" || this.#gesture !== null) return;
    const wanted = snapshot.windows.filter((entry) => this.#groupTabIds.includes(entry.tabId));
    const keep = new Set(wanted.map((entry) => entry.tabId));
    for (const tabId of this.#staying()) {
      if (keep.has(tabId) || tabId === this.#focused) continue;
      this.#sendAway(this.#wins.get(tabId)!, false);
    }
    for (const entry of wanted) {
      const win = this.#wins.get(entry.tabId);
      if (win === undefined) {
        this.#addQuiet(entry.tabId, entry.rect);
        continue;
      }
      // Still on its way into the dock (put away a moment ago): it turns back, rather than being lost to it.
      // On its way to be closed, or to another group, it goes on: that was the person's doing.
      if (win.flight === "away" && !this.#recall(win)) continue;
      win.target = { ...entry.rect };
      win.restore = null;
      win.coasting = false;
      win.delay = 0;
    }
    const order = wanted.map((entry) => entry.tabId).filter((tabId) => this.#wins.has(tabId));
    const rest = this.#order.filter((tabId) => !order.includes(tabId));
    const stack = [...rest, ...order];
    const focused = this.#focused;
    this.#order = focused !== null && stack.includes(focused) ? [...stack.filter((tabId) => tabId !== focused), focused] : stack;
    this.#save();
    this.#emit();
    this.#render();
    this.#kick();
  }

  /**
   * Out of the dock without taking the keyboard or the selection: into
   * `rect`, or where the desk has room (placeNewWindow, as a click in the
   * dock places one), and under the window in use in the stack.
   */
  #addQuiet(tabId: string, rect?: Rect): void {
    if (this.#phase !== "open") return;
    // Out already — unless it is on its way into the dock, when it turns back instead (#recall makes room for it).
    const returning = this.#wins.get(tabId);
    if (returning !== undefined && (returning.flight !== "away" || !returning.homeward)) return;
    if (returning === undefined) this.#makeRoom();
    let target = rect;
    if (target === undefined) {
      const staying = this.#staying();
      const rects = staying.map((id) => this.#wins.get(id)!.target ?? this.#wins.get(id)!.rect);
      const inUse = this.#focused === null || this.#wins.get(this.#focused)?.mask != null ? -1 : staying.indexOf(this.#focused);
      const placed = placeNewWindow(rects, this.#usable(), inUse < 0 ? null : inUse);
      if (placed.split !== null) {
        const giving = this.#wins.get(staying[placed.split.index]!)!;
        giving.target = placed.split.rect;
        giving.restore = null;
        giving.coasting = false;
        giving.delay = 0;
      }
      target = placed.rect;
    }
    if (returning !== undefined) {
      this.#recall(returning);
      returning.target = target;
      returning.restore = null;
      returning.coasting = false;
      returning.delay = 0;
      return;
    }
    this.#wins.set(tabId, this.#flyingIn(tabId, target));
    const under = this.#focused === null ? -1 : this.#order.indexOf(this.#focused);
    if (under < 0) this.#order.push(tabId);
    else this.#order.splice(under, 0, tabId);
    this.#dirtyView = true;
  }

  // ── Presses and gestures ───────────────────────────────────────────────

  /**
   * A press on a window's frame (`frame`), its title (`title`) or its drawn
   * page (`content`). The window comes to the top at once, as a window does
   * when pressed. If the pointer then travels it becomes a move; if it does
   * not, it was a click — two on the frame in quick succession maximize,
   * and one on the title opens its address to edit (the host's editAddress).
   */
  press(tabId: string, event: PressEvent, kind: "frame" | "title" | "content"): void {
    if (event.button !== 0 || this.#phase !== "open" || !this.#wins.has(tabId) || this.#gesture !== null) return;
    this.#noteShift(event.shiftKey);
    this.#raise(tabId);
    this.#emit();
    this.#render();
    const start = { x: event.clientX, y: event.clientY };
    this.#trackPress(start, {
      onDrag: (point) => this.#beginMove(tabId, start, point),
      onClick: () => {
        // The title, clicked: its address, to edit (the palette takes the keyboard).
        if (kind === "title") {
          this.#lastClick = null;
          this.#asideFor = tabId;
          this.#host.editAddress(tabId);
          this.#render();
          this.#kick();
          return;
        }
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
      dock: null,
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
      onDrag: (point) => this.#beginDockDrag("tab", tabId, start, point),
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
      // Spanning the desk (both ways, or its whole height or width): once it
      // is really moving, it lets go of the span, so it can be carried about.
      unfill: win.mask === null ? letGoSize(win.rect, win.restore, usable) : null,
      size: null,
      dock: null,
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

  /** An icon in the dock taken in hand: a tab's (`id` its tab), or another group's. */
  #beginDockDrag(kind: "tab" | "group", id: string, start: Point, current: Point): void {
    if (this.#gesture !== null || this.#phase !== "open") return;
    // Taken up again while it was still flying to its place.
    if (this.#landing !== null) this.#endLanding();
    const origin = this.#toStage(start);
    const icon = (kind === "tab" ? this.#iconRect(id) : this.#groupIconRect(id)) ?? {
      x: origin.x - DOCK_ICON / 2,
      y: origin.y - DOCK_ICON / 2,
      w: DOCK_ICON,
      h: DOCK_ICON,
    };
    this.#gesture = {
      kind: "icon",
      tabId: kind === "tab" ? id : "",
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
      dock: this.#readDock(kind, id),
      end: null,
    };
    // Every live page's still, now: the window in hand, and those it will pass over, need one.
    this.#prewarm(this.#gesture.tabId, true);
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
      const dock = gesture.dock;
      // Still an icon while it is near the dock, making room for itself
      // there; pulled clear, a tab's is its window. A group's never leaves
      // the dock: past its edge, the icon follows the pointer only a little.
      if (point.x <= DOCK_W + DOCK_PULL || dock?.kind === "group") {
        const x = point.x - gesture.ghost!.x;
        const over = x - (DOCK_W + DOCK_PULL / 2 - DOCK_ICON);
        const at = { x: dock?.kind === "group" && over > 0 ? x - over + (over * GROUP_REACH) / (over + GROUP_REACH) : x, y: point.y - gesture.ghost!.y };
        this.#showGhost(at);
        if (dock !== null) this.#aimDock(dock, { x: at.x + DOCK_ICON / 2, y: at.y + DOCK_ICON / 2 });
        this.#render();
        return;
      }
      // Out of the dock: its section closes up again, as it was.
      if (dock !== null) {
        gesture.dock = null;
        this.#showGhostInto(false);
        this.#dirtyView = true;
      }
      this.#takeInHand(gesture);
    }
    // A window spanning the desk lets go of the span once it is really on
    // the move (a grab starts at the press, before the pointer has gone anywhere).
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
    // Let go while still an icon — never pulled clear of the dock: nothing on
    // the desk changes, and the icon goes where the dock made room for it.
    if (gesture.kind === "icon") {
      if (gesture.dock === null) this.#showGhost(null);
      else this.#dropInDock(gesture.dock);
      this.#emit();
      this.#render();
      this.#kick();
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
      const tau = glideTauFor(variants.deceleration);
      win.target = this.#rest(win, { ...basis, x: basis.x + glideReach(velocity.x, tau) * 0.6, y: basis.y + glideReach(velocity.y, tau) * 0.6 });
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
    this.#showGhostInto(false);
    const win = gesture.kind === "icon" ? undefined : this.#wins.get(gesture.tabId);
    if (win !== undefined) {
      win.lift = { scale: 1, tilt: 0 };
      win.target = gesture.kind === "spawn" ? null : this.#rest(win, win.rect);
      if (gesture.kind === "spawn") this.#sendAway(win, true);
    }
  }

  // ── Rearranging the dock ───────────────────────────────────────────────

  /**
   * An icon's section of the dock as it stands at the start of a drag: each
   * icon where it rests, top to bottom. A tab's drag reads the other groups'
   * icons too, which it can be let go on. Null if the icon is not there.
   */
  #readDock(kind: "tab" | "group", id: string): DockDrag | null {
    const read = (els: ReadonlyMap<string, HTMLElement>): { items: DockSlot[]; scroller: Element | null } => {
      const items: DockSlot[] = [];
      let scroller: Element | null = null;
      for (const [key, el] of els) {
        const rect = this.#restingRect(el);
        if (rect === null) continue;
        scroller ??= dockSection(el);
        items.push({ id: key, rect });
      }
      const scrolled = scroller?.scrollTop ?? 0;
      for (const item of items) item.rect.y += scrolled;
      items.sort((a, b) => middleY(a.rect) - middleY(b.rect));
      return { items, scroller };
    };
    const own = read(kind === "tab" ? this.#iconEls : this.#groupIconEls);
    const from = own.items.findIndex((item) => item.id === id);
    if (from < 0) return null;
    const groups = kind === "tab" ? read(this.#groupIconEls) : { items: [], scroller: null };
    const first = own.items[0]!.rect;
    const last = own.items[own.items.length - 1]!.rect;
    return {
      kind,
      id,
      items: own.items,
      scroller: own.scroller,
      from,
      // (From their middles: the icon pressed has grown about its middle.)
      pitch: own.items.length > 1 ? (middleY(last) - middleY(first)) / (own.items.length - 1) : first.h + 10,
      groups: groups.items,
      groupScroller: groups.scroller,
      to: from,
      into: null,
    };
  }

  /**
   * Where the icon in hand would go, its middle at `at`: among its section's
   * icons, past the middle of each it has passed — or, a tab's over another
   * group's icon, into that group (the section closes up, as without it).
   */
  #aimDock(dock: DockDrag, at: Point): void {
    let into: string | null = null;
    if (dock.kind === "tab" && at.x <= DOCK_W + INTO_SLACK) {
      const y = at.y + (dock.groupScroller?.scrollTop ?? 0);
      into = dock.groups.find(({ rect }) => y >= rect.y - INTO_SLACK && y <= rect.y + rect.h + INTO_SLACK)?.id ?? null;
    }
    const y = at.y + (dock.scroller?.scrollTop ?? 0);
    const to = into !== null ? null : dock.items.filter((item, index) => index !== dock.from && middleY(item.rect) < y).length;
    if (to === dock.to && into === dock.into) return;
    dock.to = to;
    dock.into = into;
    this.#showGhostInto(into !== null);
    this.#dirtyView = true;
  }

  /**
   * An icon let go in the dock goes where the dock made room for it: a tab
   * to that place among the group's tabs, or into the group it was let go
   * on; another group to that place among the groups; let go where it
   * started, back into its place. The dock shows the order it made at once
   * (DeskView.dockSettle), and the icon flies there.
   */
  #dropInDock(dock: DockDrag): void {
    const order = dock.items.map((item) => item.id);
    const into = dock.into;
    if (into !== null) {
      this.#settleDock({ tabs: order.filter((id) => id !== dock.id), groups: null, gone: dock.id });
      this.#moveToGroup(dock.id, into);
      // Into the group's icon where it stands once the tab has left the dock
      // (the shelf is shorter by it, and centred again); in the column's
      // middle, whatever it still shows of lighting up to take the tab.
      const aim = (): Rect => {
        const icon = this.#groupIconRect(into) ?? dock.groups.find((slot) => slot.id === into)?.rect ?? this.#dockMiddle();
        return { x: (DOCK_W - DOCK_ICON) / 2, y: middleY(icon) - DOCK_ICON / 2, w: DOCK_ICON, h: DOCK_ICON };
      };
      this.#landGhost(dock.kind, dock.id, aim, true, () => this.#bounce(this.#groupIconEls.get(into)));
      return;
    }
    const to = dock.to ?? dock.from;
    if (to !== dock.from) {
      const next = movedOrder(order, dock.from, to);
      if (dock.kind === "tab") {
        this.#settleDock({ tabs: next, groups: null, gone: null });
        this.#host.reorderTab(dock.id, to);
      } else {
        this.#settleDock({ tabs: null, groups: next, gone: null });
        this.#host.reorderGroup(dock.id, next);
      }
    }
    // The places stay where they were: it lands in the `to`th, where its section is scrolled now.
    const slot = dock.items[to]!.rect;
    const left = Math.min(...dock.items.map((item) => item.rect.x));
    const aim = (): Rect => ({ x: left, y: middleY(slot) - DOCK_ICON / 2 - (dock.scroller?.scrollTop ?? 0), w: DOCK_ICON, h: DOCK_ICON });
    this.#landGhost(dock.kind, dock.id, aim, false, null);
  }

  /**
   * A tab's icon let go on another group's: the tab goes into that group. A
   * window of it out on the desk goes too, flying into that group's icon
   * once it has a still to fly as, as a group's windows go home when the
   * desk passes from it (#departFor). Were it the window in use, the one
   * under it takes over — without coming up over it on its way out.
   */
  #moveToGroup(tabId: string, groupId: string): void {
    const win = this.#wins.get(tabId);
    if (win !== undefined && win.flight !== "away" && !this.#departing.has(tabId)) {
      win.coasting = false;
      this.#departing.set(tabId, { groupId, since: performance.now() });
    }
    if (this.#pendingFocus === tabId) this.#pendingFocus = null;
    if (this.#asideFor === tabId) this.#asideFor = null;
    let next: string | null = null;
    if (this.#focused === tabId) {
      next = this.#staying().filter((id) => id !== tabId && !this.#departing.has(id)).at(-1) ?? null;
      this.#focused = next;
      if (next !== null) {
        this.#pendingFocus = next;
        this.#host.select(next);
      }
    }
    this.#host.moveTabToGroup(tabId, groupId, next);
    this.#save();
    this.#dirtyView = true;
    // A window whose still never comes flies all the same once the wait is up.
    if (win !== undefined) this.#renderIn(SWITCH_STILL_WAIT_MS + 20);
  }

  /** The order a drop in the dock made, for the dock to show until the browser's says the same (or DOCK_SETTLE_MS passes). */
  #settleDock(settle: DockSettleView | null): void {
    window.clearTimeout(this.#settleTimer);
    this.#dockSettle = settle;
    this.#dirtyView = true;
    if (settle === null) return;
    this.#settleTimer = window.setTimeout(() => {
      if (this.#destroyed || this.#dockSettle !== settle) return;
      this.#settleDock(null);
      this.#emit();
    }, DOCK_SETTLE_MS);
  }

  /**
   * The icon let go flies to where `aim` says, on the ghost's CSS transition
   * (`.desk-dock-ghost[data-landing]` in shell.css) — into another group's
   * icon, shrinking and fading as it goes — and its place in the dock stays
   * faint until it is there (#endLanding). It sets off on the next frame,
   * once the dock is drawn with the drop (#aimLanding).
   */
  #landGhost(kind: "tab" | "group", id: string, aim: () => Rect, into: boolean, done: (() => void) | null): void {
    if (this.#ghostEl === null || reducedMotion()) {
      this.#showGhost(null);
      this.#showGhostInto(false);
      done?.();
      return;
    }
    this.#landing = { kind, id, aim, into, until: Number.POSITIVE_INFINITY, done: done ?? (() => undefined) };
    this.#dirtyView = true;
  }

  #aimLanding(landing: Landing, now: number): void {
    const rect = landing.aim!();
    landing.aim = null;
    landing.until = now + GHOST_LAND_MS;
    const el = this.#ghostEl;
    if (el === null) return;
    // (Scaled about its middle: that goes to the middle of the icon it goes into.)
    const x = rect.x + rect.w / 2 - DOCK_ICON / 2;
    const y = rect.y + rect.h / 2 - DOCK_ICON / 2;
    el.dataset["landing"] = landing.into ? "into" : "";
    el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) scale(${landing.into ? 0.4 : 1})`;
  }

  /** The icon let go is in its place: the ghost goes, and the place shows the icon again. */
  #endLanding(): void {
    const landing = this.#landing;
    if (landing === null) return;
    this.#landing = null;
    this.#showGhost(null);
    this.#showGhostInto(false);
    const el = this.#ghostEl;
    if (el !== null && el.dataset["landing"] !== undefined) delete el.dataset["landing"];
    landing.done();
    this.#dirtyView = true;
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
    // An icon let go in the dock: it sets off once the dock is drawn with the
    // drop, and is there once its flight (the ghost's CSS transition) is done.
    const landing = this.#landing;
    if (landing?.aim != null) this.#aimLanding(landing, now);
    else if (landing !== null && now >= landing.until) this.#endLanding();
    if (this.#landing !== null) active = true;
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
    // It slows as the person set the glide to (the Feel settings' deceleration).
    const tau = glideTauFor(this.#host.variants().deceleration);
    const vx = glideDecay(win.vel.x, dt, tau);
    const vy = glideDecay(win.vel.y, dt, tau);
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
      const aim = { ...win.rect, x: hitX ? x : x + glideReach(vx, tau), y: hitY ? y : y + glideReach(vy, tau) };
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
    // A mask being edited: its page shown around the region, and its bar,
    // are drawn over the desk, above every window — a cover (clearCovers says when it can be seen).
    const editing = this.#editing === null ? undefined : this.#wins.get(this.#editing);
    if (editing !== undefined && editing.mask !== null) {
      const page = this.#editPage(editing);
      const bar = this.#editBar(page);
      const x = Math.min(page.x, bar.x);
      const y = Math.min(page.y, bar.y);
      this.#covers.set("maskedit", { x, y, w: Math.max(page.x + page.w, bar.x + bar.w) - x, h: Math.max(page.y + page.h, bar.y + bar.h) - y });
    } else {
      if (editing === undefined && this.#editing !== null) this.#editing = null;
      this.#covers.delete("maskedit");
    }
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
      // Back at its whole page, at rest: the window is its live page again (main gives the page back its own size then).
      if (win.unmasking !== null && win.target === null && !win.coasting) {
        win.unmasking = null;
        this.#dirtyView = true;
      }
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
      // A mask being edited is drawn at once: main shows its whole page meanwhile, into a view sized for that, never over the region's box.
      // So is a window growing back from its mask: live, its page would be shown at every size it passes through.
      const forced =
        win.flight !== null || (this.#gesture?.kind === "spawn" && this.#gesture.tabId === win.tabId) || this.#editing === win.tabId || win.unmasking !== null;
      const drawn = !native || forced || (wants && this.#fresh(win));
      if (drawn !== win.drawn) {
        win.drawn = drawn;
        this.#dirtyView = true;
      }
      this.#write(win);
    }
    // Windows of a group the desk has passed from: each goes once its still stands in for it.
    for (const [tabId, departing] of [...this.#departing]) {
      const win = this.#wins.get(tabId);
      if (win !== undefined && !win.drawn && now - departing.since < SWITCH_STILL_WAIT_MS) continue;
      this.#departing.delete(tabId);
      if (win !== undefined) this.#departFor(win, departing.groupId);
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
    if (win.flight !== null || win.hold || win.unmasking !== null || this.#selecting === win.tabId || this.#editing === win.tabId || this.#departing.has(win.tabId))
      return true;
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
    const shows = stillShows(win.still, win.mask ?? win.unmasking?.mask ?? null);
    // Its mask being edited, or coming off, only a still of the whole page will do.
    if ((this.#editing === win.tabId || win.unmasking !== null) && shows !== "page") return false;
    return win.wantStillSince !== null && win.paintedAt >= win.wantStillSince - STILL_GRACE_MS && shows !== "none";
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
    const reveal = win.unmasking === null ? null : this.#revealBox(win, win.unmasking);
    const revealKey = reveal === null ? "" : `${reveal.x.toFixed(1)},${reveal.y.toFixed(1)},${reveal.w.toFixed(1)},${reveal.h.toFixed(1)}`;
    const key = `${transform}|${w.toFixed(1)}|${h.toFixed(1)}|${win.origin.x.toFixed(0)},${win.origin.y.toFixed(0)}|${revealKey}`;
    if (key === win.written) return;
    win.written = key;
    el.style.transform = transform;
    el.style.width = `${w.toFixed(1)}px`;
    el.style.height = `${h.toFixed(1)}px`;
    el.style.transformOrigin = `${win.origin.x.toFixed(0)}px ${win.origin.y.toFixed(0)}px`;
    if (reveal !== null) {
      el.style.setProperty("--reveal-x", `${reveal.x.toFixed(1)}px`);
      el.style.setProperty("--reveal-y", `${reveal.y.toFixed(1)}px`);
      el.style.setProperty("--reveal-w", `${reveal.w.toFixed(1)}px`);
      el.style.setProperty("--reveal-h", `${reveal.h.toFixed(1)}px`);
    } else if (win.revealed) {
      for (const name of ["--reveal-x", "--reveal-y", "--reveal-w", "--reveal-h"]) el.style.removeProperty(name);
    }
    win.revealed = reveal !== null;
  }

  /**
   * Where the whole page stands for a window growing back from its mask,
   * from its page area's corner: from where the region was shown (at its
   * scale), to where the page lands (at its own), as far as the window has
   * grown between the two — so the region stays put as the page is
   * revealed around it, and nothing in it is stretched to the window.
   */
  #revealBox(win: Win, unmasking: Unmasking): Rect {
    const insets = this.#insets(win);
    const page = { x: win.rect.x + insets.left, y: win.rect.y + insets.top, w: win.rect.w - insets.left - insets.right, h: win.rect.h - insets.top - insets.bottom };
    const { mask, from, scale, to } = unmasking;
    const growth = (now: number, start: number, end: number): number => (Math.abs(end - start) < 1 ? 1 : clamp((now - start) / (end - start), 0, 1));
    const t = Math.abs(to.w - from.w) >= Math.abs(to.h - from.h) ? growth(page.w, from.w, to.w) : growth(page.h, from.h, to.h);
    const start = { x: from.x - mask.x * scale, y: from.y - mask.y * scale, w: mask.pageWidth * scale, h: mask.pageHeight * scale };
    const between = (a: number, b: number): number => a + (b - a) * t;
    return {
      x: between(start.x, to.x) - page.x,
      y: between(start.y, to.y) - page.y,
      w: between(start.w, to.w),
      h: between(start.h, to.h),
    };
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

  /** Which views are desk windows, the grab key, where the dock stands aside, whether an icon in it is hovered, and the masked pages. */
  #reportDesk(api: NonNullable<ReturnType<typeof nativeApi>>, left: number, top: number): void {
    const grab = this.#host.variants().grab;
    // Aside for a window whose page is under its place, the dock comes back
    // as the pointer comes there: main hears that pointer, the shell does not.
    const place = this.#asideSince !== null ? this.#dockPlace() : null;
    const dock =
      place === null ? null : { x: Math.round(left + place.x), y: Math.round(top + place.y), width: Math.round(place.w), height: Math.round(place.h) };
    const masks: DeskMaskedPage[] = [];
    // Passing to another group, both groups' windows are out a moment: the
    // group come to the desk first, the one leaving after (waiting for its
    // still, or on its way home), within main's limit.
    const leaving = (id: string): boolean => this.#departing.has(id) || this.#wins.get(id)?.flight === "away";
    const leavingLast = (ids: readonly string[]): string[] => [...ids.filter((id) => !leaving(id)), ...ids.filter(leaving)];
    for (const tabId of leavingLast(this.#order)) {
      const win = this.#wins.get(tabId)!;
      if (win.mask === null) continue;
      if (this.#editing === tabId) {
        // Its mask being edited: the whole page, at the scale it is shown at,
        // for its still — but no larger than a still is kept (a small region
        // enlarged would ask for a page many screens wide), its shape kept.
        const page = this.#editPage(win);
        const fit = Math.min(1, MAX_DESK_STILL_WIDTH / Math.max(page.w, page.h));
        masks.push({ tabId, mask: wholeDeskMask(win.mask), width: Math.max(1, Math.round(page.w * fit)), height: Math.max(1, Math.round(page.h * fit)) });
        continue;
      }
      const size = this.#maskShownAt(win);
      masks.push({ tabId, mask: win.mask, width: size.w, height: size.h });
    }
    // A window on its way into the inventory is drawn, with no page to grab.
    masks.splice(MAX_DESK_WINDOWS);
    const dockHover = this.#dockHover;
    const desk = { tabIds: leavingLast(this.#staying()).slice(0, MAX_DESK_WINDOWS), grab: grab === "off" ? null : grab, dock, dockHover, masks };
    const deskKey = `${desk.tabIds.join(" ")}|${desk.grab ?? ""}|${dock === null ? "" : `${dock.x},${dock.y},${dock.width},${dock.height}`}|${dockHover ? "hover" : ""}|${masks
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
          stillShows: stillShows(win.still ?? this.#thumbs.get(tabId) ?? null, win.mask ?? win.unmasking?.mask ?? null),
          unmasking: win.unmasking?.mask ?? null,
          selecting: this.#selecting === tabId,
          editing: this.#editing === tabId && win.mask !== null ? this.#editView(win) : null,
          maskFade:
            this.#maskFade?.tabId === tabId
              ? {
                  x: this.#maskFade.from.x - win.rect.x,
                  y: this.#maskFade.from.y - win.rect.y,
                  w: this.#maskFade.from.w,
                  h: this.#maskFade.from.h,
                  framed: this.#maskFade.framed,
                }
              : null,
        };
      }),
      thumbs,
      drops: this.#drops,
      dropsShown: this.#dropsNear,
      dockClear: this.#dockClear,
      dockDrop: this.#armedDrop,
      iconDrag: gesture?.kind === "icon" && gesture.tabId !== "" ? gesture.tabId : this.#landing?.kind === "tab" ? this.#landing.id : null,
      groupDrag: gesture?.kind === "icon" && gesture.dock?.kind === "group" ? gesture.dock.id : this.#landing?.kind === "group" ? this.#landing.id : null,
      dockDrag:
        gesture?.kind === "icon" && gesture.dock !== null
          ? {
              kind: gesture.dock.kind,
              id: gesture.dock.id,
              order: gesture.dock.items.map((item) => item.id),
              to: gesture.dock.to,
              into: gesture.dock.into,
              pitch: gesture.dock.pitch,
            }
          : null,
      dockSettle: this.#dockSettle,
      clearCovers: this.#clearCovers,
      dockAside: this.#dockAside,
      snapping: gesture?.snapping ?? false,
      gesture: gesture?.kind ?? null,
      phase: this.#phase,
    };
    for (const listener of this.#listeners) listener();
  }

  /** The mask editor's page and bar, from the window's corner. */
  #editView(win: Win): { page: Rect; bar: Rect; shown: boolean } {
    const page = this.#editPage(win);
    const bar = this.#editBar(page);
    const from = (rect: Rect): Rect => ({ x: rect.x - win.rect.x, y: rect.y - win.rect.y, w: rect.w, h: rect.h });
    return { page: from(page), bar: from(bar), shown: this.#clearCovers.has("maskedit") };
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
      // A mask being edited is shown as its whole page.
      const shown = win !== undefined && this.#editing === tabId && win.mask !== null ? this.#editPage(win).w : (win?.target?.w ?? win?.rect.w ?? 640) - insets.left - insets.right;
      width = Math.max(width, shown, 640);
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

  /** The newest picture of a tab's page: its window's, or the dock's. */
  #latestStill(tabId: string): Still | null {
    const own = this.#wins.get(tabId)?.still ?? null;
    const thumb = this.#thumbs.get(tabId) ?? null;
    return own === null || (thumb !== null && thumb.at > own.at) ? thumb : own;
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
      unmasking: null,
      revealed: false,
      homeward: false,
    };
  }

  /** A window coming out of the inventory: at its thumbnail, scaled down to it, headed for `target` at full size. */
  #flyingIn(tabId: string, target: Rect, from?: Rect): Win {
    const thumb = from ?? this.#iconRect(tabId) ?? shrunk(target);
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
    if (this.#editing !== null && this.#editing !== tabId) {
      this.#editing = null;
      this.#dirtyView = true;
    }
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
    if (this.#editing === win.tabId) this.#editing = null;
    if (win.still !== null) this.#thumbs.set(win.tabId, win.still);
    const intoIcon = to === undefined;
    win.homeward = intoIcon;
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

  /**
   * A window on its way into its icon in the dock turns back (Undo layout,
   * or the agent bringing it out again): its arrival — which would take it
   * off the desk — is called off, and it grows back to full size as a
   * window coming out does. A desk already full sends its bottom window
   * home first, as for any window coming out (#makeRoom). The caller gives
   * it its place. False, and nothing changes, for any other flight: one
   * into the Close pad or another group's icon was the person's doing.
   */
  #recall(win: Win): boolean {
    if (win.flight !== "away" || !win.homeward) return false;
    this.#makeRoom();
    win.onArrive = null;
    win.flight = "in";
    win.homeward = false;
    win.lift = { scale: 1, tilt: 0 };
    win.written = "";
    this.#dirtyView = true;
    return true;
  }

  /** The dock's icon for this tab gives a little bounce: its window has just come back into it. */
  #receive(tabId: string): void {
    this.#bounce(this.#iconEls.get(tabId));
  }

  #bounce(el: HTMLElement | undefined): void {
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
    if (this.#editing === tabId) this.#editing = null;
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
      // (A window on its way into another group's icon is that group's now.)
      if (win.flight === "away" || !win.framed || this.#departing.has(tabId)) continue;
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
    return { x: DOCK_W + DESK_GAP, y: 0, w: Math.max(1, width - DOCK_W - DESK_GAP), h: Math.max(1, height - this.#barBand) };
  }

  /** Where a window may be: the whole stage above the Bar — behind the dock too, as far as the desk's leading edge. */
  #reach(): Rect {
    const { width, height } = this.#stageBox;
    return { x: 0, y: 0, w: Math.max(1, width), h: Math.max(1, height - this.#barBand) };
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
    return el === undefined ? null : this.#restingRect(el);
  }

  /** Another group's icon in the dock, where it rests (as #iconRect). */
  #groupIconRect(groupId: string): Rect | null {
    const el = this.#groupIconEls.get(groupId);
    return el === undefined ? null : this.#restingRect(el);
  }

  /** An icon in the dock, in the stage, wherever the shelf holding it is sliding (#iconRect). */
  #restingRect(el: HTMLElement): Rect | null {
    if (!el.isConnected) return null;
    const box = el.getBoundingClientRect();
    if (box.width < 1) return null;
    const slide = dockSlide(el);
    return { x: box.left - this.#stageBox.left - slide, y: box.top - this.#stageBox.top, w: box.width, h: box.height };
  }

  /** An icon's box in the middle of the dock's column: where windows go, or come from, with no icon of their own to find. */
  #dockMiddle(): Rect {
    return { x: DOCK_W / 2 - DOCK_ICON / 2, y: this.#stageBox.height / 2 - DOCK_ICON / 2, w: DOCK_ICON, h: DOCK_ICON };
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

  /** The tab's icon in hand is over another group's, as an app over a folder: it draws in a little. */
  #showGhostInto(on: boolean): void {
    const el = this.#ghostEl;
    if (el === null) return;
    if (on) el.dataset["into"] = "";
    else if (el.dataset["into"] !== undefined) delete el.dataset["into"];
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

/** The section of the dock holding icon `el` (the group's tabs, or the other groups), which scrolls when they outgrow it. */
function dockSection(el: HTMLElement): Element | null {
  return typeof el.closest === "function" ? el.closest(".desk-dock-icons, .desk-dock-groups") : null;
}

function middleY(rect: Rect): number {
  return rect.y + rect.h / 2;
}

/** What a still can stand for, for a window masked with `mask` (or not): its region, the whole page (cropped if masked), or nothing. */
function stillShows(still: Still | null, mask: DeskMask | null): "page" | "region" | "none" {
  if (still === null) return "none";
  if (still.mask === null) return "page";
  if (mask === null) return "none";
  if (still.mask === deskMaskKey(mask)) return "region";
  // Taken while the mask was edited: the whole page box, through the same override.
  return still.mask === deskMaskKey(wholeDeskMask(mask)) ? "page" : "none";
}

/** A mask's page box, all of it: what main shows while the mask is edited. */
function wholeDeskMask(mask: DeskMask): DeskMask {
  return { x: 0, y: 0, width: mask.pageWidth, height: mask.pageHeight, pageWidth: mask.pageWidth, pageHeight: mask.pageHeight };
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
