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
 * - the desk's dock is the SIDEBAR's column beside it (docs/desk.md), not
 *   part of the desk: a tab's window comes out of its row there and goes
 *   back into it (the host finds the rows: DeskHost.homeOf), a row dragged
 *   out over the desk is its window in hand (pullFromSidebar), and while a
 *   window is carried near the desk's leading edge, a drop rail stands over
 *   the sidebar — back into the dock above, the tab closed below.
 * - the desk can pass to ANOTHER GROUP in place (switchGroup): this group's
 *   windows go into its row in the sidebar — each once it has a still to
 *   fly as — while the other group's come out of that group's row, to
 *   where they were left (or, never on a desk, its tab used last alone, in
 *   the middle).
 * - a window need not be a tab's (lib/desk/windows.ts): a DOCUMENT, one of
 *   the group's context files open in its viewer, is the shell's own DOM
 *   through and through. It is always drawn — it never has a native page —
 *   so it covers the pages under it like any drawn window, and moves,
 *   lifts and tilts as it is. Its home is the group's Stack (its context
 *   row in the sidebar), not a row of its own: it is put away into it and
 *   comes out of it.
 *   Main is never told of it; the pane the desk leaves as is always a tab's.
 * - a window can be MINIMIZED: small (the least a window may be), its page
 *   shown as if zoomed out (DESK_MINI_ZOOM — main's zoom, or for a page
 *   the shell draws, a CSS scale), and PARKED in the shelf at the desk's
 *   foot, each peeking up a quarter of its height beside the one before, the next
 *   to the right overlapping it by half. They lie over the windows there,
 *   as the Bar's notch does (#ledges): a window under them is cut short of
 *   them, its page stopping where they begin (#cutFor).
 *   The pointer on a parked window raises it into full view (hoverMini);
 *   dragged away it is a minimized window like any other, and let go at
 *   the desk's foot it parks again. Expand gives it back the box it had.
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

import { TRAFFIC_LIGHTS_H, type DragCursor } from "@pistachio/shell-contracts/chrome";
import {
  DESK_MINI_ZOOM,
  deskMaskKey,
  MAX_DESK_STILL_WIDTH,
  MAX_DESK_WINDOWS,
  MIN_DESK_MASK,
  type DeskGrab as NativeDeskGrab,
  type DeskMask,
  type DeskMaskedPage,
  type DeskZoomedPage,
} from "@pistachio/shell-contracts/desk";
import { nativeApi } from "../../api";
import { startPaneDrag } from "../../lib/pane-drag";
import {
  carrySize,
  cellZone,
  centeredRect,
  clampRect,
  DESK_GAP,
  denormalizeRect,
  dockDropAt,
  sidebarDrops,
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
  rescaleRect,
  sameRect,
  seamsAt,
  seamTravel,
  alongSeam,
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
  type Placement,
  type Point,
  type Rect,
  type Seam,
  type ThirdsCell,
  type TileZone,
} from "../../lib/desk/geometry";
import {
  BOUNCE_RESTITUTION,
  clamp,
  CARD_RESIZE_MS,
  DURATION_FAST_MS,
  DURATION_MICRO_MS,
  DURATION_QUICK_MS,
  DURATION_STAGGER_MS,
  EASE_SMOOTH_OUT,
  STAGGER_TOTAL_MS,
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
import { isTabWindow, windowKind, type DeskWindowKind } from "../../lib/desk/windows";

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

/** A minimized window's size: the least a window may be (its page shown zoomed out, DESK_MINI_ZOOM). */
export const MINI_SIZE = { w: MIN_WINDOW_W, h: MIN_WINDOW_H };
/** Parked at the desk's foot, a minimized window peeks up this share of its height (its title bar and a strip of its page); the next one along overlaps it by this share of its width. */
const MINI_PEEK = 0.25;
const MINI_OVERLAP = 0.5;
/**
 * The shelf stands this far in from the desk's sides: clear of the well's
 * rounded corners (`.desk-stage`'s radius), so a window peeking from its foot,
 * cut off square there, never pokes out past the corner's curve.
 */
export const SHELF_INSET = 18;
/** A window cut short over the desk's foot (#cutFor) keeps at least this much of its page; one that would keep less is covered there instead. */
const MIN_CUT_PAGE = 80;
/** How far a window's own clip reaches around it, so its shadow is kept (all but where the notch is a hole through it). */
const CLIP_MARGIN = 120;

/**
 * The Bar's notch as it is drawn now (setNotchShape), in the stage: the
 * Bar's box, rising from the desk's foot; the radius of its shoulders; and
 * of the flares where its sides meet the edge.
 */
export interface NotchShape {
  x: number;
  y: number;
  w: number;
  h: number;
  radius: number;
  flare: number;
}

/**
 * The notch's outline, offset by (dx, dy): out of the desk's foot at its
 * left flare, up its side to its shoulder, across, down and out at its right
 * flare — and on down past the foot, so nothing under it there (a window's
 * shadow) is left either.
 */
function notchOutline(shape: NotchShape, foot: number, dx: number, dy: number): string {
  const n = (value: number): string => value.toFixed(1);
  const f = shape.flare;
  const x0 = shape.x + dx;
  const x1 = shape.x + shape.w + dx;
  const top = shape.y + dy;
  const bottom = foot + dy;
  const r = Math.max(0, Math.min(shape.radius, shape.w / 2, bottom - f - top));
  return [
    `M ${n(x0 - f)} ${n(bottom)}`,
    `A ${n(f)} ${n(f)} 0 0 0 ${n(x0)} ${n(bottom - f)}`,
    `V ${n(top + r)}`,
    `A ${n(r)} ${n(r)} 0 0 1 ${n(x0 + r)} ${n(top)}`,
    `H ${n(x1 - r)}`,
    `A ${n(r)} ${n(r)} 0 0 1 ${n(x1)} ${n(top + r)}`,
    `V ${n(bottom - f)}`,
    `A ${n(f)} ${n(f)} 0 0 0 ${n(x1 + f)} ${n(bottom)}`,
    `V ${n(bottom + CLIP_MARGIN)}`,
    `H ${n(x0 - f)} Z`,
  ].join(" ");
}
/**
 * A raised parked window the pointer has left goes back down after this
 * long: an intent gate (transitions.dev's micro duration), so the pointer
 * crossing between its frame and its live page is not leaving.
 */
const MINI_LOWER_MS = DURATION_MICRO_MS;
/**
 * The shelf's own motions are timed, on the smooth ease-out, never past
 * their place, whatever the Feel's spring (transitions.dev's motion
 * tokens, by usage): rising into view is a hover lift in, quick and direct;
 * going back down is a close, quicker still; moving along the shelf as it
 * closes up is a position change.
 */
const SHELF_RISE_MS = DURATION_FAST_MS;
const SHELF_LOWER_MS = DURATION_QUICK_MS;
const SHELF_MOVE_MS = DURATION_FAST_MS;
/** Leaving, the window in use grows back into the pane in this long, on the smooth ease-out (a resize, by the motion tokens). */
const LEAVE_GROW_MS = DURATION_FAST_MS;

/**
 * Eased, the Feel's fourth Spring: the windows' motions are timed eases on
 * transitions.dev's motion tokens, all on the smooth ease-out, matched by
 * what each motion does (its transitions-polish skill: usage, never the
 * nearest number), instead of springs:
 * - a window come to rest elsewhere at its own size (let go, stuck to an
 *   edge, the end of a throw) is a position change, `--duration-fast`;
 * - one whose size changes (filled, tiled, arranged, let go of the desk,
 *   unmasked, expanded) is the card resize transition, its 300ms;
 * - one out of the dock, growing from its icon, is a dropdown opening from
 *   its trigger, `--duration-fast`; into the dock, the Close pad or another
 *   group's icon, a dropdown closing into it — quicker than it opened
 *   (`--duration-quick`), as every close is;
 * - the windows of an arrangement, or of a desk coming out, set off a
 *   stagger apart, the whole run under its total;
 * - nothing overshoots: a throw that meets an edge comes to rest against it
 *   rather than rebounding, and a window in hand lifts and settles
 *   critically damped (it follows the pointer, so it keeps a spring).
 */
const EASED_MOVE_MS = DURATION_FAST_MS;
const EASED_RESIZE_MS = CARD_RESIZE_MS;
const EASED_OPEN_MS = DURATION_FAST_MS;
const EASED_CLOSE_MS = DURATION_QUICK_MS;
/** Closed from its frame, a window draws in to this scale as it fades: a modal's close (transitions.dev's `--scale-large`). */
const CLOSE_SCALE = 0.96;
/** Eased: what still follows the pointer (a window letting go of the desk in hand, flying to the hand, its lift and tilt) settles critically damped. */
const EASED_SPRING: SpringConfig = { response: 0.25, damping: 1 };

/** Passing to another group: a live window waits at most this long for the still it flies home as. */
const SWITCH_STILL_WAIT_MS = 400;

/**
 * The desk's dock is the sidebar's column beside it (docs/desk.md): a tab's
 * window comes out of its row there, and goes back into it. A row's icon is
 * this big — a window coming out grows from it.
 */
const ROW_ICON = 16;
/** The drop rail stands this far inside the sidebar's column, all round. */
const RAIL_INSET = 6;
/** Held over the drop rail, a drawn window shrinks toward this width as it fades into the segment under it. */
const OVER_DOCK_WIDTH = 140;
/** How long a sidebar row bounces on taking a window back. */
const RECEIVE_MS = 560;
/** The drop rail comes over the sidebar once a carried window's pointer comes this near the desk's leading edge. */
const DROPS_NEAR = 180;
/** The leading edge's band that offers the left half (and its quarters at the ends): past it are the drop rail's segments. */
const LEFT_EDGE_BAND = 30;
/** A window taken from the sidebar while out on the desk flies to the hand on this. */
const CATCH_SPRING: SpringConfig = { response: 0.3, damping: 0.86 };

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
  /** Closed from its frame: it fades where it stands rather than on its way somewhere. */
  closing: boolean;
  /** The frame is showing — false while the window is the whole surface, entering or leaving. */
  framed: boolean;
  maximized: boolean;
  /** Minimized: parked in the shelf at the desk's foot, or out on the desk ("free"); null for a window at its own size. */
  mini: "parked" | "free" | null;
  /** A parked window raised into full view: the pointer is on it. */
  raised: boolean;
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
  /**
   * While a window is carried near the desk's leading edge, a drop rail
   * stands over the sidebar: back into the dock above, its tab closed
   * below. The two segments (in the stage's coordinates: the sidebar is left
   * of the stage, at negative x), whether they are showing, and the one a
   * release now would go to.
   */
  drops: DockDrops;
  dropsShown: boolean;
  dockDrop: DockDrop | null;
  /** Covers (setCover) no live page paints over any more: what the shell draws there can be seen. */
  clearCovers: ReadonlySet<string>;
  /** Shift is held over a window in hand: every release lands in the tile the pointer is over. */
  snapping: boolean;
  gesture: "move" | "resize" | "spawn" | null;
  phase: "entering" | "open" | "leaving";
}

/** The desk as the agent reads it (agentLayout): the windows out, bottom to top (documents among them), and the group's tabs in the dock. */
export interface DeskAgentLayout {
  windows: Array<{ tabId: string; kind: DeskWindowKind; box: DeskPercentBox; focused: boolean; masked: boolean; minimized: boolean }>;
  docked: string[];
}

/**
 * A window came out onto the desk, or left it, by the person's hand (or the
 * browser's choice of a tab): what the desk's smart layout hears
 * (onLayoutMoment, docs/desk-layout.md). Not the desk's own arranging, the
 * agent's, a group passing, or the desk coming up or going.
 */
export type DeskLayoutMoment =
  | {
      trigger: "opened";
      id: string;
      /** How it was placed (placeNewWindow): a hole, half a window's place, a free spot, or the desk's first. */
      how: Placement["kind"];
      /** The windows that may be laid out (layoutView), where they stood before it came out. */
      before: Map<string, Rect>;
    }
  | { trigger: "closed"; gone: Array<{ id: string; rect: Rect; how: "closed" | "collapsed" }> };

/** The desk as its smart layout reads it (layoutView). */
export interface DeskLayoutView {
  /** Where windows are laid out: the desk, above its foot band. */
  bounds: Rect;
  /** The windows that may be laid out, bottom to top, each where it is going (not masked, minimized, or leaving). */
  windows: Map<string, Rect>;
  /** The rest still on the desk (masked, minimized but out), which stay where they are. */
  others: Rect[];
  inUse: string | null;
  /** The layout as a string: two views with the same stamp have every window in the same place. */
  stamp: string;
}

/** Where every window was (layoutSnapshot), bottom to top: what Undo layout puts back. */
export interface DeskLayoutSnapshot {
  windows: Array<{ tabId: string; rect: Rect; mini: Minimized | null }>;
}

/** A minimized window's state: the box it grows back to, and whether it is parked in the shelf at the desk's foot. */
export interface Minimized {
  restore: Rect;
  parked: boolean;
}

export interface DeskHost {
  variants(): DeskVariants;
  /** A native page can be on screen for this tab right now: awake, not shell-drawn. */
  hasLivePage(tabId: string): boolean;
  /** Make this tab the active one (it wakes if it sleeps). Called for every window raised; a document's is the host's to ignore. */
  select(tabId: string): void;
  /** A window of the shell's own (a document) was chosen: its content takes the keyboard. */
  focusWindow?(id: string): void;
  /** Close this tab (its window closed from its frame, or let go on the drop rail's Close). */
  close(tabId: string): void;
  /** Edit this tab's address: the address palette, over the desk (a click on a window's title). */
  editAddress(tabId: string): void;
  save(windows: SavedDeskWindow[]): void;
  /**
   * A tab of the group sent to another group (its row's menu): the tab goes
   * into that group. Were it the tab in use, `next` (a window left on the
   * desk, or null for none) takes over first, so the desk is never left on a
   * tab not its own.
   */
  moveTabToGroup(tabId: string, groupId: string, next: string | null): void;
  /** The leaving motion is done: the surface can go back to panes. */
  leaveDone(): void;
  /** The sidebar's column beside the desk — its dock — in the window's coordinates, or null where there is none. */
  sidebar(): Rect | null;
  /**
   * Where a window lives in the sidebar, which it comes out of and goes back
   * into: a tab's row (its group folded away, the group's), another group's
   * row, or — a document's — the group's Stack. Null where there is none.
   */
  homeOf(kind: "tab" | "group" | "file", id: string): HTMLElement | null;
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
  /** Minimized: small, its page zoomed out; parked in the shelf, or out on the desk. */
  mini: Minimized | null;
  /**
   * Shrinking into minimized ("in") or growing back from it ("out"): drawn
   * until it lands. Its page is zoomed out from the start of the one, and,
   * through the other, held at the size it grows to (DeskZoomedPage zoom 1),
   * so it never lays out at a size between.
   */
  miniMotion: "in" | "out" | null;
  /** A timed move to `target` (the shelf's: #layShelf), eased on --ease-smooth-out; the spring takes over if its target changes some other way. */
  tween: { from: Rect; to: Rect; start: number; ms: number; scale?: { from: number; to: number } } | null;
  /**
   * Settling into a larger box than it had (filled, tiled, an edge zone, an
   * arrangement, expanded): `to` is that box, `from` where it set out. Its
   * page is laid out at `to` from the start (DeskZoomedPage at zoom 1) and it
   * grows there live, revealing the page — never its still, a picture of the
   * smaller window stretched to the larger, nor laid out anew once there.
   * It goes no further than `to` on the way (#step), so the page never shows
   * past what it is laid out at.
   */
  growTo: { from: Rect; to: Rect } | null;
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
  /** Closed from its frame (×): drawing in where it stands and fading, quicker than a flight's fade. */
  closing: boolean;
  /**
   * How far short of its frame's foot its page stops (#cutFor): above what
   * the shell draws at the desk's foot over it — the Bar's notch, the parked
   * windows — which its live page would otherwise paint over.
   */
  cut: number;
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
   * of the sidebar in hand (pullFromSidebar: drawn throughout, and back into
   * the dock if let go over the drop rail).
   */
  kind: "move" | "resize" | "spawn";
  /** The window's tab. */
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
  /** A resize from a gutter other windows meet the window across: the seams it moves, split-view style. */
  joint: Joint | null;
  tracker: VelocityTracker;
  /** The tile lit for the window in hand: an edge zone pushed into, or the snap tile under the pointer. */
  zone: TileZone | null;
  /** The zone is snap mode's (Shift held), and `cell` the cell of the desk in thirds it was read from. */
  snapping: boolean;
  cell: ThirdsCell | null;
  overDock: boolean;
  /** Over one of the drop rail's segments (dockDropAt): let go, and the window goes there. */
  drop: DockDrop | null;
  /** A window flying to the hand (taken by its row in the sidebar): how far it still is from where the hand holds it. */
  lag: { x: number; y: number; vx: number; vy: number } | null;
  /** A window spanning the desk (letGoSize): the size it lets go to once the pointer travels. */
  unfill: { w: number; h: number } | null;
  /** The size a moved window is growing or shrinking to in hand (it let go of the desk), or null for its own. */
  size: { w: number; h: number } | null;
  end: (() => void) | null;
}

/**
 * The seams a resize holds (seamsAt): its gutter on each axis (null where
 * the edge in hand is the window's alone), and where every window on them
 * stood at the press.
 */
interface Joint {
  x: Seam | null;
  y: Seam | null;
  start: Map<string, Rect>;
}

const ZERO_RECT: Rect = { x: 0, y: 0, w: 0, h: 0 };
/** No sidebar beside the desk: nowhere for the drop rail. */
const NO_DROPS: DockDrops = { away: ZERO_RECT, close: ZERO_RECT };

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
  #dropsEl: HTMLElement | null = null;
  /** What the shell draws over the desk (setCover): a card beside the sidebar, the Bar — in the stage's coordinates. */
  readonly #covers = new Map<string, Rect>();
  #clearCovers: ReadonlySet<string> = new Set();
  #guideEls: HTMLElement[] = [];
  readonly #thumbs = new Map<string, Still>();
  #gesture: Gesture | null = null;
  #phase: DeskView["phase"] = "entering";
  #raf = 0;
  #last = 0;
  #view: DeskView;
  readonly #listeners = new Set<() => void>();
  /** The smart layout's ear (onLayoutMoment). */
  readonly #momentListeners = new Set<(moment: DeskLayoutMoment) => void>();
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
  /** The drop rail's segments over the sidebar, in the stage (measure: the sidebar's column as the host says it stands). */
  #drops: DockDrops = NO_DROPS;
  /** The sidebar's column, in the stage (left of it), or null where there is none. */
  #side: Rect | null = null;
  #dirtyView = false;
  /** Shift is down — the snap key — as the latest key event or pointer sample said. */
  #shift = false;
  /** A tab's row in the sidebar is under the pointer: main takes ⇧⌫ for it (setDockHover). */
  #dockHover = false;
  /** The window whose page is frozen for its mask to be chosen (startMask). */
  #selecting: string | null = null;
  /** A window masked a moment ago, and the window it was cut from, fading until `until`. */
  #maskFade: { tabId: string; from: Rect; until: number; framed: boolean } | null = null;
  /** The masked window whose mask is being edited (editMask). */
  #editing: string | null = null;
  /** The group's tabs (start, syncTabs, switchGroup): the dock's, whose pictures are kept fresh. */
  #groupTabIds: readonly string[] = [];
  /**
   * The windows of a group the desk has passed from (switchGroup), each
   * waiting for a still to fly into its group's row as: the group, and
   * when it began waiting.
   */
  readonly #departing = new Map<string, { groupId: string; since: number }>();
  /** How many windows are still flying into each group's row: it bounces as the last lands. */
  readonly #folding = new Map<string, number>();
  /** The Bar's notch at the desk's foot, idle (setNotch): its size, centred there. */
  #notch: { w: number; h: number } | null = null;
  /** The Bar's notch as it is drawn now (setNotchShape): a hole through the well and the windows under it. */
  #notchShape: NotchShape | null = null;
  #wellHoled = false;
  /**
   * The windows of the shell's own this desk may show (the group's
   * documents: setShellWindows), or null until the host knows — windows
   * saved with the desk then come out, and go if they turn out not to be.
   */
  #shellIds: readonly string[] | null = null;
  /** The minimized windows parked in the shelf at the desk's foot, left to right. */
  #parked: string[] = [];
  /** Leaving, the window in use growing back into the pane as its live page, laid out at the pane's box already (leave). */
  #leaveTop: string | null = null;
  /** The parked window raised into full view, for the pointer on it. */
  #raised: string | null = null;
  /** Where the pointer is said to be on a minimized window: its frame (the shell's own pointer), or its live page (main's word). */
  #miniHover: { tabId: string; frame: boolean; page: boolean } | null = null;
  #lowerTimer = 0;

  constructor(host: DeskHost) {
    this.#host = host;
    this.#view = {
      windows: [],
      drops: this.#drops,
      dropsShown: false,
      dockDrop: null,
      clearCovers: this.#clearCovers,
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

  /** Windows coming out or leaving by the person's hand (DeskLayoutMoment), for the desk's smart layout. */
  onLayoutMoment(listener: (moment: DeskLayoutMoment) => void): () => void {
    this.#momentListeners.add(listener);
    return () => this.#momentListeners.delete(listener);
  }

  #moment(moment: DeskLayoutMoment): void {
    if (this.#phase !== "open") return;
    for (const listener of [...this.#momentListeners]) listener(moment);
  }

  /** A window the smart layout may move: out on the desk at its own size and shape, staying. */
  #laidOutByDesk(id: string): boolean {
    const win = this.#wins.get(id);
    return win !== undefined && win.flight !== "away" && win.mask === null && win.mini === null && !this.#departing.has(id);
  }

  /** The desk as the smart layout reads it: where each window is going, and what may be moved. */
  layoutView(): DeskLayoutView {
    const windows = new Map<string, Rect>();
    const others: Rect[] = [];
    for (const id of this.#order) {
      const win = this.#wins.get(id)!;
      const rect = { ...(win.target ?? win.rect) };
      if (this.#laidOutByDesk(id)) windows.set(id, rect);
      else if (win.flight !== "away" && win.mini?.parked !== true && !this.#departing.has(id)) others.push(rect);
    }
    const stamp = [...windows].map(([id, rect]) => `${id}:${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.w)},${Math.round(rect.h)}`).join("|");
    return { bounds: this.#usable(), windows, others, inUse: this.#focused, stamp };
  }

  /**
   * Windows sent to where the smart layout put them (docs/desk-layout.md),
   * each on the desk's own motion, a beat apart. Returns where every window
   * was going before, for Undo (restoreLayout) — or null, changing nothing,
   * when the desk is not open or a window is in hand.
   */
  applyLayout(layout: ReadonlyMap<string, Rect>): DeskLayoutSnapshot | null {
    if (this.#phase !== "open" || this.#gesture !== null) return null;
    const undo = this.layoutSnapshot();
    const moving = [...layout].filter(([id]) => this.#laidOutByDesk(id));
    moving.forEach(([id, rect], index) => {
      const win = this.#wins.get(id)!;
      win.target = { ...rect };
      win.restore = null;
      win.coasting = false;
      // (A window still coming out turns toward its new place in the air.)
      win.delay = win.flight !== null ? 0 : this.#beat(index, moving.length, 0, 0.035);
    });
    this.#save();
    this.#emit();
    this.#render();
    this.#kick();
    return undo;
  }

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

  /**
   * The shell windows this desk may show (the group's documents), or null
   * while the host does not know yet. One out whose document has gone
   * (taken out of the context) goes too.
   */
  setShellWindows(ids: readonly string[] | null): void {
    this.#shellIds = ids;
    if (ids === null) return;
    let changed = false;
    for (const [id, win] of [...this.#wins]) {
      if (isTabWindow(id) || ids.includes(id) || this.#departing.has(id) || win.flight === "away") continue;
      if (this.#gesture?.tabId === id) this.#cancelGesture();
      this.#remove(id);
      changed = true;
    }
    if (changed) {
      this.#save();
      this.#emit();
    }
    this.#render();
  }

  /** The dock's pads: the pointer's height is written to it (`--pointer-y`), and the lit pad's mark follows it. */
  attachDrops(el: HTMLElement | null): void {
    this.#dropsEl = el;
  }

  /**
   * Something the shell draws over the desk — a card beside the sidebar, the
   * Bar's answer — or null to take it away. A live page is a native view and would
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
    const pageH = Math.round(win.rect.h - insets.top - insets.bottom - win.cut);
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

  /** The stage moved or changed size: re-read it, and keep the arrangement in proportion. */
  measure(): void {
    const stage = this.#stage;
    if (stage === null) return;
    const box = stage.getBoundingClientRect();
    const before = this.#usable();
    const resized = this.#stageBox.width > 0 && (box.width !== this.#stageBox.width || box.height !== this.#stageBox.height);
    this.#stageBox = { left: box.left, top: box.top, width: box.width, height: box.height };
    this.#writeWell();
    this.#measureSide();
    if (resized && this.#phase === "open") {
      const after = this.#usable();
      const reach = this.#reach();
      for (const win of this.#wins.values()) {
        // (A parked window is the shelf's to place.)
        if (this.#gesture?.tabId === win.tabId || win.flight !== null || win.mini?.parked === true) continue;
        if (win.mask !== null || win.mini !== null) {
          // A picture — or a minimized window — keeps its size; only where it is follows the desk.
          const moved = denormalizeRect(normalizeRect(win.rect, before), after);
          win.rect = clampRect({ ...win.rect, x: moved.x, y: moved.y }, reach, this.#minSize(win));
          if (win.mini !== null) win.mini.restore = clampRect(denormalizeRect(normalizeRect(win.mini.restore, before), after), reach);
          continue;
        }
        // (Windows a gutter apart stay a gutter apart: a split stays one.)
        win.rect = clampRect(rescaleRect(win.rect, before, after), reach);
        if (win.target !== null) win.target = clampRect(rescaleRect(win.target, before, after), reach);
        if (win.restore !== null) win.restore = clampRect(rescaleRect(win.restore, before, after), reach);
      }
      this.#layShelf();
    }
    this.#render();
  }

  /**
   * The sidebar's column beside the desk, in the stage (left of it), and the
   * drop rail's segments over it — below the window's own buttons, where the
   * column runs up under them.
   */
  #measureSide(): void {
    const client = this.#host.sidebar();
    const { left, top } = this.#stageBox;
    const side = client === null || client.w < 1 ? null : { x: client.x - left, y: client.y - top, w: client.w, h: client.h };
    this.#side = side;
    const drops =
      side === null ? NO_DROPS : sidebarDrops(side, RAIL_INSET, DESK_GAP, Math.max(side.y + RAIL_INSET, client!.y < TRAFFIC_LIGHTS_H ? TRAFFIC_LIGHTS_H - top : side.y));
    if (!sameRect(drops.away, this.#drops.away, 0.5) || !sameRect(drops.close, this.#drops.close, 0.5)) {
      this.#drops = drops;
      this.#dirtyView = true;
    }
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
    if (gesture === null || gesture.kind === "resize") return;
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
    window.clearTimeout(this.#lowerTimer);
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
  start(saved: readonly SavedDeskWindow[], entryTabId: string | null, groupTabIds: readonly string[], shellIds: readonly string[] | null = null): void {
    this.#shellIds = shellIds;
    // The window in view goes on top.
    const { windows, entry } = this.#laidOut(saved, groupTabIds, entryTabId);
    this.#parked = windows.filter((window) => window.mini?.parked === true).map((window) => window.tabId);
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
        // Or minimized: small, zoomed out, and parked where it was, or out on the desk.
        win.mini = window.mini;
        win.delay = this.#beat(index, windows.length, 0.06, 0.04);
      }
      this.#wins.set(window.tabId, win);
      this.#order.push(window.tabId);
    });
    this.#stackShelf();
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
    /** Its documents (setShellWindows), or null while they are not known. */
    shellIds?: readonly string[] | null;
    saved: readonly SavedDeskWindow[];
    entry: string | null;
  }): void {
    if (this.#phase === "leaving") return;
    this.#cancelGesture();
    this.#selecting = null;
    this.#editing = null;
    this.#save();
    const now = performance.now();
    for (const tabId of this.#order) {
      const win = this.#wins.get(tabId)!;
      if (win.flight === "away" || this.#departing.has(tabId)) continue;
      win.coasting = false;
      this.#departing.set(tabId, { groupId: next.from, since: now });
    }
    if (this.#pendingFocus !== null && this.#departing.has(this.#pendingFocus)) this.#pendingFocus = null;
    // The shelf is the next group's: this one's parked windows wait where they are to fly home.
    this.#parked = [];
    this.#raised = null;
    this.#miniHover = null;
    this.#groupTabIds = next.tabIds;
    this.#shellIds = next.shellIds ?? null;
    // Out of the group's row in the sidebar, where it stands now.
    const from = this.#groupRect(next.groupId) ?? this.#sideMiddle();
    // The window in use on top. (A window of this group may still be on its
    // way home, the desk passed from it a moment ago: it is taken back where
    // it was left, not made anew.)
    const { windows, entry } = this.#laidOut(next.saved, next.tabIds, next.entry);
    windows.forEach((window, index) => {
      const homing = this.#wins.get(window.tabId);
      if (homing !== undefined) {
        this.#takeBack(homing, window.rect);
        homing.mini = window.mini;
        if (window.mini?.parked === true) this.#parked.push(window.tabId);
        return;
      }
      const win = this.#flyingIn(window.tabId, window.rect, from);
      win.mask = window.mask;
      win.mini = window.mini;
      if (window.mini?.parked === true) this.#parked.push(window.tabId);
      win.delay = this.#beat(index, windows.length, 0.03, 0.035);
      this.#wins.set(window.tabId, win);
      this.#order.push(window.tabId);
    });
    this.#stackShelf();
    // Nothing is flying into its icon now: it is the desk's group again, with no icon in the dock.
    this.#folding.delete(next.groupId);
    this.#focused = entry;
    this.#pendingFocus = entry;
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
   * A group's windows as they come out onto the desk (start, switchGroup):
   * each where it was left, in the desk as it is now, and the
   * tab the desk comes up on — out too, alone in the middle or in the room
   * left beside the others — on top. Past the desk's limit, the bottom ones
   * stay in the dock.
   */
  #laidOut(
    saved: readonly SavedDeskWindow[],
    tabIds: readonly string[],
    entryTabId: string | null,
    shellIds: readonly string[] | null = this.#shellIds,
  ): { windows: Array<{ tabId: string; rect: Rect; mask: DeskMask | null; mini: Minimized | null }>; entry: string | null } {
    const member = (id: string): boolean => (isTabWindow(id) ? tabIds.includes(id) : shellIds === null || shellIds.includes(id));
    const kept = saved.filter((window) => member(window.tabId));
    // The desk comes up on a tab: the pane it lifts off is a tab's page, and comes out at its own size, minimized or not.
    const entry = entryTabId !== null && tabIds.includes(entryTabId) ? entryTabId : (kept.filter((window) => isTabWindow(window.tabId)).at(-1)?.tabId ?? null);
    const parkedIds = kept.filter((window) => window.mini?.parked === true && window.mask === undefined && window.tabId !== entry).map((window) => window.tabId);
    const usable = this.#usable();
    const reach = this.#reach();
    const windows: Array<{ tabId: string; rect: Rect; mask: DeskMask | null; mini: Minimized | null }> = kept.map((window) => {
      if (window.mask !== undefined) return { tabId: window.tabId, rect: this.#maskedRectFrom(window.rect, window.mask), mask: window.mask, mini: null };
      const rect = clampRect(denormalizeRect(window.rect, usable), reach);
      if (window.mini === undefined) return { tabId: window.tabId, rect, mask: null, mini: null };
      const restore = clampRect(denormalizeRect(window.mini.restore, usable), reach);
      if (window.tabId === entry) return { tabId: window.tabId, rect: restore, mask: null, mini: null };
      const parked = parkedIds.indexOf(window.tabId);
      return parked >= 0
        ? { tabId: window.tabId, rect: this.#shelfRect(parked, parkedIds.length, false), mask: null, mini: { restore, parked: true } }
        : { tabId: window.tabId, rect: { ...rect, w: MINI_SIZE.w, h: MINI_SIZE.h }, mask: null, mini: { restore, parked: false } };
    });
    if (entry !== null && !windows.some((window) => window.tabId === entry)) {
      const out = windows.filter((window) => window.mini?.parked !== true).map((window) => window.rect);
      const rect = out.length === 0 ? centeredRect(usable) : freeSpot(out, { w: usable.w * 0.6, h: usable.h * 0.76 }, usable);
      windows.push({ tabId: entry, rect, mask: null, mini: null });
    }
    windows.sort((a, b) => Number(a.tabId === entry) - Number(b.tabId === entry));
    windows.splice(0, Math.max(0, windows.length - MAX_DESK_WINDOWS));
    return { windows, entry };
  }

  /** A window of the group the desk passed from, once it has its still (or has waited long enough): into its group's icon. */
  #departFor(win: Win, groupId: string): void {
    this.#sendAway(win, false, this.#groupRect(groupId) ?? this.#sideMiddle());
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
      this.#bounce(this.#host.homeOf("group", groupId) ?? undefined);
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
    this.#parked = [];
    this.#raised = null;
    this.#miniHover = null;
    // The pane the surface goes back to is a tab's: the window in use, or with a document in use, the top tab's.
    const top =
      this.#focused !== null && this.#wins.has(this.#focused) && isTabWindow(this.#focused) ? this.#focused : ([...this.#order].reverse().find(isTabWindow) ?? null);
    // Its live page is laid out at the pane's box from the start (DeskZoomedPage at zoom 1), and it grows there as
    // itself — never as a picture of its window stretched to the pane, nor laid out anew once it is there. (A masked
    // page grows back whole as it does when unmasked: main keeps it at its own box until it is shown there.)
    const topWin = top === null ? undefined : this.#wins.get(top);
    this.#leaveTop = top !== null && topWin !== undefined && topWin.mask === null && topWin.maskWanted === null && this.#host.hasLivePage(top) ? top : null;
    for (const win of this.#wins.values()) {
      win.coasting = false;
      win.delay = 0;
      win.lift = { scale: 1, tilt: 0 };
      if (win.tabId === top) {
        // It becomes the pane again: all of its page, minimized or not.
        win.mini = null;
        win.miniMotion = null;
        win.mask = null;
        win.maskWanted = null;
        win.flight = null;
        win.framed = false;
        win.target = this.#fullRect();
        win.onArrive = null;
        // On a timed ease, never past the pane (a live page swinging past it would paint beyond the desk).
        win.tween = { from: { ...win.rect }, to: win.target, start: performance.now(), ms: reducedMotion() ? 0 : LEAVE_GROW_MS };
      } else {
        this.#sendAway(win, false);
      }
    }
    // Over everything going home, the shelf's windows included.
    if (top !== null) this.#order = [...this.#order.filter((id) => id !== top), top];
    if (top === null) window.setTimeout(() => this.#host.leaveDone(), 220);
    this.#emit();
    // Main hears at once: the page is laid out at the pane's box before the window has grown at all.
    this.#render();
    this.#kick();
  }

  // ── What the rest of the browser did ───────────────────────────────────

  /** The tabs of the group now: a window whose tab left it (closed, moved out) goes. */
  syncTabs(groupTabIds: readonly string[]): void {
    this.#groupTabIds = groupTabIds;
    let changed = false;
    const gone: Array<{ id: string; rect: Rect; how: "closed" }> = [];
    for (const [tabId, win] of [...this.#wins]) {
      // (A window of a group the desk has passed from is on its way into that group's row; a document is setShellWindows'.)
      if (groupTabIds.includes(tabId) || !isTabWindow(tabId) || this.#departing.has(tabId) || win.flight === "away") continue;
      if (this.#gesture?.tabId === tabId) this.#cancelGesture();
      if (this.#laidOutByDesk(tabId)) gone.push({ id: tabId, rect: { ...(win.target ?? win.rect) }, how: "closed" });
      this.#remove(tabId);
      changed = true;
    }
    if (changed) {
      this.#save();
      this.#emit();
    }
    this.#render();
    if (gone.length > 0) this.#moment({ trigger: "closed", gone });
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
        // A window still waiting to take the keyboard (drawn) has lost it to this one.
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

  /**
   * The tab's window is out on the desk at its own size and in use: its row
   * pressed is then the address's, as any tab's in use is (TabList). Any
   * other press on a row of the desk's group is its window's (add).
   */
  inUse(tabId: string): boolean {
    const win = this.#wins.get(tabId);
    return win !== undefined && win.mini === null && win.flight === null && this.#focused === tabId;
  }

  windowTabIds(): string[] {
    return [...this.#order];
  }

  // ── Commands ───────────────────────────────────────────────────────────

  /** Bring a tab out of the inventory — or, if its window is out, to the top. */
  add(tabId: string, options: { focus?: boolean; rect?: Rect } = {}): void {
    if (this.#phase === "leaving") return;
    // Chosen from the dock (or the sidebar, a shortcut) while minimized: it grows back, and is in use.
    if (options.focus === true && this.#wins.get(tabId)?.mini != null && this.#wins.get(tabId)!.flight === null) {
      this.expand(tabId);
      return;
    }
    if (this.#wins.has(tabId)) {
      this.#raise(tabId);
      if (options.focus === true) {
        this.#pendingFocus = tabId;
      }
      this.#emit();
      this.#render();
      this.#kick();
      return;
    }
    this.#makeRoom();
    const before = this.layoutView().windows;
    const usable = this.#usable();
    // (The shelf's windows are at the desk's foot, below where windows go.)
    const staying = this.#staying().filter((id) => this.#wins.get(id)!.mini?.parked !== true);
    const rects = staying.map((id) => this.#wins.get(id)!.target ?? this.#wins.get(id)!.rect);
    // A masked window is a picture, and a minimized one small: neither is cut in two for a new one.
    const inUse = this.#focused === null || this.#wins.get(this.#focused)?.mask != null || this.#wins.get(this.#focused)?.mini != null ? -1 : staying.indexOf(this.#focused);
    // Where it goes is read from the desk as it is (placeNewWindow): a tiled
    // desk's hole, or half of the window in use, or a free spot.
    const placed: Placement = options.rect !== undefined ? { rect: options.rect, split: null, kind: "free" } : placeNewWindow(rects, usable, inUse < 0 ? null : inUse);
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
    // (A window put where it was asked to be is placed already.)
    if (options.rect === undefined && this.#laidOutByDesk(tabId)) this.#moment({ trigger: "opened", id: tabId, how: placed.kind, before });
  }

  /**
   * A tab's row let go over the desk (chrome/shelf-drag.tsx; a tab that was
   * not the group's has just joined it): its window comes out there, at the
   * size windows come out at, its title bar under the pointer near its
   * leading end — as it would have been carried — flying out of the row.
   */
  addAt(tabId: string, client: Point): void {
    if (this.#phase !== "open") return;
    if (this.#wins.has(tabId)) {
      this.add(tabId, { focus: true });
      return;
    }
    const usable = this.#usable();
    const at = this.#toStage(client);
    const size = windowSize(usable);
    const chrome = this.#host.variants().chrome;
    const pinTop = chrome === "bar" ? CHROME_INSETS.bar.top / 2 : CHROME_CARD_TOP[chrome] / 2;
    const rect = clampRect({ x: at.x - clamp(at.x - usable.x, 28, size.w / 2), y: at.y - pinTop, w: size.w, h: size.h }, usable);
    this.add(tabId, { focus: true, rect });
  }

  /**
   * A shell window brought out where something was let go (a file dropped
   * on the desk): centred on the point, at `share` of the desk (no wider
   * than its most), growing out of the point, in use. One already out comes
   * to the top instead.
   */
  openAt(id: string, client: Point, share: { w: number; h: number; maxW: number }): void {
    if (this.#phase !== "open") return;
    if (this.#wins.has(id) && this.#wins.get(id)!.flight !== "away") {
      this.add(id, { focus: true });
      return;
    }
    const usable = this.#usable();
    const at = this.#toStage(client);
    const w = Math.min(usable.w, Math.max(MIN_WINDOW_W, Math.min(share.maxW, usable.w * share.w)));
    const h = Math.min(usable.h, Math.max(MIN_WINDOW_H, usable.h * share.h));
    const rect = clampRect({ x: at.x - w / 2, y: at.y - h / 2, w, h }, usable);
    const returning = this.#wins.get(id);
    if (returning !== undefined) {
      // On its way into the Stack a moment ago: it turns back, to here.
      this.#recall(returning);
      returning.target = rect;
      returning.restore = null;
      returning.coasting = false;
      returning.delay = 0;
      this.#raise(id);
    } else {
      this.#makeRoom();
      this.#wins.set(id, this.#flyingIn(id, rect, { x: at.x - 24, y: at.y - 24, w: 48, h: 48 }));
      this.#order.push(id);
    }
    this.#focused = id;
    this.#pendingFocus = id;
    this.#host.select(id);
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
    const gone = this.#laidOutByDesk(tabId) ? { id: tabId, rect: { ...(win.target ?? win.rect) }, how: "collapsed" as const } : null;
    this.#sendAway(win, true);
    this.#emit();
    this.#kick();
    if (gone !== null) this.#moment({ trigger: "closed", gone: [gone] });
  }

  /**
   * Closed from its frame (×): the window draws in a little where it
   * stands and fades, as a window closing does, and once it is gone its tab
   * is closed (Reopen closed tab brings it back). A document's window only
   * closes: the file stays in the Stack (the host's close).
   */
  closeWindow(tabId: string): void {
    const win = this.#wins.get(tabId);
    if (win === undefined || win.flight === "away" || this.#phase === "leaving") return;
    if (this.#selecting === tabId) this.#selecting = null;
    if (this.#gesture?.tabId === tabId) this.#cancelGesture();
    const gone = this.#laidOutByDesk(tabId) ? { id: tabId, rect: { ...(win.target ?? win.rect) }, how: "closed" as const } : null;
    const r = win.rect;
    const inset = (1 - CLOSE_SCALE) / 2;
    this.#sendAway(win, true, { x: r.x + r.w * inset, y: r.y + r.h * inset, w: r.w * CLOSE_SCALE, h: r.h * CLOSE_SCALE });
    win.closing = true;
    const arrive = win.onArrive;
    win.onArrive = () => {
      arrive?.();
      this.#host.close(tabId);
    };
    this.#emit();
    this.#kick();
    if (gone !== null) this.#moment({ trigger: "closed", gone: [gone] });
  }

  /**
   * A tab of the group sent to another group from its row's menu in the
   * sidebar: its window flies into that group's row, as a group's windows go
   * home when the desk passes from it. With no window to fly, the group's
   * row bounces.
   */
  moveTabToGroup(tabId: string, groupId: string): void {
    if (this.#phase === "leaving" || !this.#groupTabIds.includes(tabId)) return;
    const flies = this.#wins.has(tabId);
    this.#moveToGroup(tabId, groupId);
    if (!flies) this.#bounce(this.#host.homeOf("group", groupId) ?? undefined);
    this.#emit();
    this.#render();
    this.#kick();
  }

  toggleMaximize(tabId: string): void {
    const win = this.#wins.get(tabId);
    if (win === undefined || win.flight !== null || this.#phase !== "open" || win.mask !== null) return;
    // Minimized, a double click on its frame expands it.
    if (win.mini !== null) {
      this.expand(tabId);
      return;
    }
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

  /**
   * Minimize: the window shrinks to a minimized window's size, its page
   * zoomed out (DESK_MINI_ZOOM), and parks in the shelf at the desk's foot,
   * after the ones already there, peeking up a quarter of its height. It keeps the
   * box it had, to grow back to (expand). The window in use, it passes the
   * keyboard to the window under it. A masked window is a picture of part
   * of a page and is not minimized.
   */
  minimize(tabId: string): void {
    const win = this.#wins.get(tabId);
    if (win === undefined || win.flight !== null || win.mini !== null || win.mask !== null || this.#phase !== "open") return;
    if (this.#gesture?.tabId === tabId) this.#cancelGesture();
    if (this.#selecting === tabId) this.#selecting = null;
    if (this.#editing === tabId) this.#editing = null;
    win.miniMotion = "in";
    win.coasting = false;
    win.delay = 0;
    win.lift = { scale: 1, tilt: 0 };
    this.#setMinimized(win, { restore: { ...(win.target ?? win.rect) }, parked: true });
    win.restore = null;
    if (this.#focused === tabId) {
      const next = this.#topWindow();
      this.#focused = next;
      if (next !== null) {
        this.#pendingFocus = next;
        this.#host.select(next);
      }
    }
    this.#save();
    this.#emit();
    this.#render();
    this.#kick();
  }

  /** Expand a minimized window: it grows back to the box it had, its page at its own size again, on top and in use. */
  expand(tabId: string): void {
    const win = this.#wins.get(tabId);
    if (win === undefined || win.mini === null || win.flight !== null || this.#phase !== "open") return;
    if (this.#gesture?.tabId === tabId) this.#cancelGesture();
    const restore = win.mini.restore;
    this.#unminimize(win);
    win.target = clampRect(restore, this.#reach());
    win.coasting = false;
    win.delay = 0;
    this.#raise(tabId);
    this.#pendingFocus = tabId;
    this.#save();
    this.#emit();
    this.#render();
    this.#kick();
  }

  /**
   * The pointer came onto a minimized window, or left it — told by the
   * shell's own pointer on its frame (and its drawn page), or by main while
   * it is on the window's live page, which the shell never hears. A parked
   * window rises into full view while the pointer is on it, and goes back
   * down a moment after it has left both (MINI_LOWER_MS).
   */
  hoverMini(tabId: string, from: "frame" | "page", over: boolean): void {
    const hover = this.#miniHover;
    if (over) {
      if (this.#wins.get(tabId)?.mini == null) return;
      const next = hover !== null && hover.tabId === tabId ? hover : { tabId, frame: false, page: false };
      next[from] = true;
      this.#miniHover = next;
      window.clearTimeout(this.#lowerTimer);
      this.#lowerTimer = 0;
      this.#raiseParked(tabId);
      return;
    }
    if (hover === null || hover.tabId !== tabId) return;
    hover[from] = false;
    if (hover.frame || hover.page) return;
    window.clearTimeout(this.#lowerTimer);
    this.#lowerTimer = window.setTimeout(() => {
      this.#lowerTimer = 0;
      if (this.#miniHover !== hover || hover.frame || hover.page) return;
      this.#miniHover = null;
      this.#raiseParked(null);
    }, MINI_LOWER_MS);
  }

  /** Raise this parked window into full view (the others down), or put the raised one back down (null). */
  #raiseParked(tabId: string | null): void {
    const next = tabId !== null && this.#parked.includes(tabId) ? tabId : null;
    // A window in hand is the pointer's business first.
    if (next === this.#raised || (this.#gesture !== null && next !== null)) return;
    this.#raised = next;
    this.#layShelf();
    this.#emit();
    this.#render();
    this.#kick();
  }

  /** Make a window minimized — parked in the shelf, or out on the desk — the shelf laid out afresh. */
  #setMinimized(win: Win, mini: Minimized): void {
    win.mini = { restore: { ...mini.restore }, parked: mini.parked };
    const at = this.#parked.indexOf(win.tabId);
    if (mini.parked && at < 0) this.#parked.push(win.tabId);
    if (!mini.parked && at >= 0) this.#parked.splice(at, 1);
    this.#layShelf();
  }

  /** A minimized window at its own size again (the caller gives it its box): out of the shelf, its page held at that box as it grows there. */
  #unminimize(win: Win): void {
    if (win.mini === null) return;
    this.#unpark(win);
    win.mini = null;
    win.miniMotion = "out";
    this.#dirtyView = true;
  }

  /** Out of the shelf, the ones after it closing up; still minimized, out on the desk. */
  #unpark(win: Win): void {
    const at = this.#parked.indexOf(win.tabId);
    if (win.mini !== null) win.mini.parked = false;
    if (at < 0) return;
    this.#parked.splice(at, 1);
    if (this.#raised === win.tabId) this.#raised = null;
    if (this.#miniHover?.tabId === win.tabId) this.#miniHover = null;
    this.#layShelf();
    this.#dirtyView = true;
  }

  /** A minimized window in hand is over the shelf's band at the desk's foot (where the parked ones peek up, and the gap above them): let go, it parks there. */
  #overShelf(win: Win, point: Point): boolean {
    return win.mini !== null && point.y >= this.#stageBox.height - Math.ceil(MINI_SIZE.h * MINI_PEEK) - DESK_GAP;
  }

  /** Where the shelf's `index`th of `count` parked windows goes: at the desk's foot, from its leading edge, peeking up — or, raised, in full view. */
  #shelfRect(index: number, count: number, raised: boolean): Rect {
    const { width, height } = this.#stageBox;
    const left = SHELF_INSET;
    const { w, h } = MINI_SIZE;
    // Each overlaps the one before by half, closer still when that would run past the desk.
    const room = Math.max(0, width - left - w - SHELF_INSET);
    const step = count <= 1 ? 0 : Math.min(w * (1 - MINI_OVERLAP), room / (count - 1));
    return { x: left + index * step, y: raised ? height - h - DESK_GAP : height - h * MINI_PEEK, w, h };
  }

  /** The shelf's windows to their places (a parked window in hand goes where the hand takes it), and above the rest, left to right. */
  #layShelf(): void {
    this.#parked = this.#parked.filter((id) => this.#wins.get(id)?.mini?.parked === true);
    this.#parked.forEach((tabId, index) => {
      const win = this.#wins.get(tabId)!;
      if (this.#gesture?.tabId === tabId || win.flight !== null) return;
      const target = this.#shelfRect(index, this.#parked.length, this.#raised === tabId);
      if (sameRect(win.target ?? win.rect, target, 0.5)) return;
      win.target = target;
      win.coasting = false;
      win.delay = 0;
      // Shrinking into the shelf, it rides the Feel's spring; once there, its moves along and up and down are timed.
      if (win.miniMotion !== null) return;
      const ms = reducedMotion() ? 0 : target.y < win.rect.y - 0.5 ? SHELF_RISE_MS : target.y > win.rect.y + 0.5 ? SHELF_LOWER_MS : SHELF_MOVE_MS;
      win.tween = { from: { ...win.rect }, to: target, start: performance.now(), ms };
    });
    this.#stackShelf();
  }

  /** The stack with the shelf on top: its windows left to right, each over the one before it, the raised one over all. */
  #stackShelf(): void {
    const shelf = this.#parked.filter((id) => id !== this.#raised && this.#order.includes(id));
    if (this.#raised !== null && this.#order.includes(this.#raised)) shelf.push(this.#raised);
    const next = [...this.#order.filter((id) => !this.#parked.includes(id)), ...shelf];
    if (next.length === this.#order.length && next.every((id, index) => id === this.#order[index])) return;
    this.#order = next;
    this.#dirtyView = true;
  }

  /** The top window that is not parked in the shelf (and not flying off the desk), or null. */
  #topWindow(): string | null {
    for (let index = this.#order.length - 1; index >= 0; index -= 1) {
      const id = this.#order[index]!;
      const win = this.#wins.get(id)!;
      if (win.flight !== "away" && win.mini?.parked !== true) return id;
    }
    return null;
  }

  /** Every window on the desk tiled, or fanned, in the inventory's order — each a beat after the last. */
  arrange(kind: "tile" | "cascade", groupTabIds: readonly string[] = this.#groupTabIds): void {
    if (this.#phase !== "open") return;
    this.#cancelGesture();
    // Masked windows are pictures: tiling would stretch them, so they stay where they are; minimized ones stay minimized.
    const arranged = (id: string): boolean =>
      this.#wins.has(id) && this.#wins.get(id)!.flight !== "away" && this.#wins.get(id)!.mask === null && this.#wins.get(id)!.mini === null;
    // The tabs in the dock's order, then the documents out, bottom to top.
    const ids = [...groupTabIds.filter(arranged), ...this.#order.filter((id) => !isTabWindow(id) && arranged(id))];
    const usable = this.#usable();
    const rects = kind === "tile" ? tileRects(ids.length, usable) : cascadeRects(ids.length, usable);
    ids.forEach((tabId, index) => {
      const win = this.#wins.get(tabId)!;
      win.target = rects[index]!;
      win.restore = null;
      win.coasting = false;
      win.delay = this.#beat(index, ids.length, 0, 0.035);
    });
    // A cascade reads front to back in the inventory's order.
    if (kind === "cascade") this.#order = [...this.#order.filter((tabId) => !ids.includes(tabId)), ...ids];
    this.#emit();
    this.#kick();
  }

  // ── The agent's hand (docs/desk-agent.md §2) ──────────────────────────

  /**
   * The Bar's notch at the desk's foot, idle (DeskBar): its size, centred on
   * the desk's foot, or null. The windows fill the desk under it, each cut
   * short of it (#cutFor), as of the parked windows beside it.
   */
  setNotch(size: { w: number; h: number } | null): void {
    const next = size === null ? null : { w: Math.max(0, Math.round(size.w)), h: Math.max(0, Math.round(size.h)) };
    const before = this.#notch;
    if (next === null ? before === null : before !== null && before.w === next.w && before.h === next.h) return;
    this.#notch = next;
    this.#render();
    this.#kick();
  }

  /**
   * The Bar's notch as it is drawn now, as it grows and shrinks (DeskBar),
   * or null: it is a hole through the well and through every window under
   * it, down to the shell's own ground (the surface's, the window's glass),
   * which nothing drawn over them could match — so the notch is that ground,
   * rising out of the edge, whatever the theme. (A live page is never under
   * it: cut short of the idle notch, covered by the grown one.)
   */
  setNotchShape(shape: NotchShape | null): void {
    const before = this.#notchShape;
    if (shape === null ? before === null : before !== null && (["x", "y", "w", "h", "radius", "flare"] as const).every((key) => Math.abs(before[key] - shape[key]) < 0.05))
      return;
    this.#notchShape = shape === null ? null : { ...shape };
    this.#writeWell();
    for (const win of this.#wins.values()) this.#write(win);
  }

  /** The well (the stage's ::before) with the notch a hole in it. */
  #writeWell(): void {
    const stage = this.#stage;
    if (stage === null) return;
    const shape = this.#notchShape;
    if (shape === null) {
      if (this.#wellHoled) stage.style.removeProperty("--desk-notch-clip");
      this.#wellHoled = false;
      return;
    }
    this.#wellHoled = true;
    const { width, height } = this.#stageBox;
    stage.style.setProperty("--desk-notch-clip", `path(evenodd, "M -2 -2 H ${(width + 2).toFixed(1)} V ${(height + 2).toFixed(1)} H -2 Z ${notchOutline(shape, height, 0, 0)}")`);
  }

  /**
   * A window's clip with the notch a hole in it, when the notch is over it:
   * not one carried, flying or turned (it passes over the notch), and only
   * what the window keeps of itself otherwise — its shadow all round, cut
   * off at the desk's edge (`below`) if it peeks from there.
   */
  #notchClip(win: Win, below: number, transformed: boolean): string | null {
    const shape = this.#notchShape;
    if (shape === null || transformed || win.flight !== null) return null;
    const gesture = this.#gesture;
    if (gesture !== null && gesture.tabId === win.tabId && gesture.kind !== "resize") return null;
    const { x, y, w, h } = win.rect;
    const foot = this.#stageBox.height;
    const hole = { x: shape.x - shape.flare, y: shape.y, w: shape.w + shape.flare * 2, h: foot + CLIP_MARGIN - shape.y };
    if (!rectsOverlap({ x: x - CLIP_MARGIN, y: y - CLIP_MARGIN, w: w + CLIP_MARGIN * 2, h: h + CLIP_MARGIN * 2 }, hole)) return null;
    const m = CLIP_MARGIN;
    const bottom = below > 0 ? h - below : h + m;
    return `path(evenodd, "M ${-m} ${-m} H ${(w + m).toFixed(1)} V ${bottom.toFixed(1)} H ${-m} Z ${notchOutline(shape, foot, -x, -y)}")`;
  }

  /** The tab is one of the group's (a tab the agent just opened may not be yet). */
  hasGroupTab(tabId: string): boolean {
    return this.#groupTabIds.includes(tabId);
  }

  /** A window this desk may show: one of the group's tabs, or one of its documents (known to be one: the agent names only what is there). */
  #isMember(id: string): boolean {
    return isTabWindow(id) ? this.#groupTabIds.includes(id) : this.#shellIds !== null && this.#shellIds.includes(id);
  }

  /** The desk as the agent reads it: every window out, bottom to top, where it is going, as percents of the desk. */
  agentLayout(): DeskAgentLayout {
    const usable = this.#usable();
    const out = this.#staying();
    return {
      windows: out.map((tabId) => {
        const win = this.#wins.get(tabId)!;
        return {
          tabId,
          kind: windowKind(tabId),
          box: percentBox(win.target ?? win.rect, usable),
          focused: tabId === this.#focused,
          masked: win.mask !== null,
          minimized: win.mini !== null,
        };
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
    const named = [...(plan.place ?? []).map((entry) => entry.tabId), ...(plan.putAway ?? []), ...(plan.bringOut ?? [])];
    const stranger = named.find((id) => !this.#isMember(id));
    if (stranger !== undefined) return isTabWindow(stranger) ? `tab ${stranger} is not on this desk` : `${stranger} is not one of this desk's documents`;
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
      // Minimized, it grows back into its place.
      if (win.mini !== null) this.#unminimize(win);
      // A masked window is a picture: it keeps its size, in the middle of its place.
      win.target = win.mask !== null ? clampRect({ ...win.rect, x: rect.x + (rect.w - win.rect.w) / 2, y: rect.y + (rect.h - win.rect.h) / 2 }, reach, MASK_MIN) : rect;
      win.restore = null;
      win.coasting = false;
      win.delay = this.#beat(index, (plan.place ?? []).length, 0, 0.035);
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
    return {
      windows: this.#staying().map((tabId) => {
        const win = this.#wins.get(tabId)!;
        return { tabId, rect: { ...(win.target ?? win.rect) }, mini: win.mini === null ? null : { restore: { ...win.mini.restore }, parked: win.mini.parked } };
      }),
    };
  }

  /**
   * Every window back where a snapshot had it: the ones it did not have go
   * into the dock (the window in use excepted), the ones it had come out,
   * and the stack is its order again — the window in use on top.
   */
  restoreLayout(snapshot: DeskLayoutSnapshot): void {
    if (this.#phase !== "open" || this.#gesture !== null) return;
    const wanted = snapshot.windows.filter((entry) => this.#isMember(entry.tabId));
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
      // Minimized or not, as it was.
      if (entry.mini === null && win.mini !== null) this.#unminimize(win);
      else if (entry.mini !== null) this.#setMinimized(win, entry.mini);
      win.target = { ...entry.rect };
      win.restore = null;
      win.coasting = false;
      win.delay = 0;
    }
    this.#layShelf();
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
      const staying = this.#staying().filter((id) => this.#wins.get(id)!.mini?.parked !== true);
      const rects = staying.map((id) => this.#wins.get(id)!.target ?? this.#wins.get(id)!.rect);
      const inUse = this.#focused === null || this.#wins.get(this.#focused)?.mask != null || this.#wins.get(this.#focused)?.mini != null ? -1 : staying.indexOf(this.#focused);
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
    // (A parked window is resized once it is out on the desk: half of it is below the desk's edge.)
    if (event.button !== 0 || win === undefined || this.#phase !== "open" || this.#gesture !== null || win.flight !== null || win.mini?.parked === true) return;
    this.#raise(tabId);
    const start = this.#toStage({ x: event.clientX, y: event.clientY });
    const joint = this.#jointAt(win, edges, start);
    // The windows on its seams are resized with it: none goes on moving as it was.
    for (const id of joint?.start.keys() ?? [tabId]) {
      const held = this.#wins.get(id)!;
      held.coasting = false;
      held.target = null;
      held.tween = null;
      held.vel = { ...ZERO_RECT };
      held.restore = null;
    }
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
      joint,
      tracker: new VelocityTracker(),
      zone: null,
      snapping: false,
      cell: null,
      overDock: false,
      drop: null,
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
    // Taken from the shelf: out on the desk, still minimized (let go at the desk's foot, it parks again).
    if (win.mini?.parked === true) {
      window.clearTimeout(this.#lowerTimer);
      this.#lowerTimer = 0;
      this.#unpark(win);
    }
    const origin = this.#toStage(start);
    win.coasting = false;
    win.target = null;
    win.tween = null;
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
      joint: null,
      tracker: new VelocityTracker(),
      zone: null,
      snapping: false,
      cell: null,
      overDock: false,
      drop: null,
      lag: null,
      // Spanning the desk (both ways, or its whole height or width): once it
      // is really moving, it lets go of the span, so it can be carried about.
      unfill: win.mask === null && win.mini === null ? letGoSize(win.rect, win.restore, usable) : null,
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

  /**
   * A tab's row in the sidebar dragged out over the desk (chrome/shelf-drag.tsx
   * hands it on here as the pointer crosses the desk's leading edge, the
   * button still down): it becomes the tab's window in hand, as an icon
   * pulled out of the Dock does (#takeInHand), and the gesture goes on from
   * here. False, and nothing happens, for a tab that is not the group's or
   * while the desk is busy.
   */
  pullFromSidebar(tabId: string, client: Point): boolean {
    if (this.#gesture !== null || this.#phase !== "open" || !this.#groupTabIds.includes(tabId)) return false;
    this.#noteShift(undefined);
    const point = this.#toStage(client);
    const gesture: Gesture = {
      kind: "spawn",
      tabId,
      startedAt: performance.now(),
      start: point,
      pointer: point,
      startRect: { x: point.x - ROW_ICON / 2, y: point.y - ROW_ICON / 2, w: ROW_ICON, h: ROW_ICON },
      grab: { x: 0.5, y: 0.5 },
      pinTop: null,
      edges: null,
      joint: null,
      tracker: new VelocityTracker(),
      zone: null,
      snapping: false,
      cell: null,
      overDock: false,
      drop: null,
      lag: null,
      unfill: null,
      size: null,
      end: null,
    };
    this.#gesture = gesture;
    // Every live page's still, now: the window in hand, and those it will pass over, need one.
    this.#prewarm(tabId, true);
    this.#takeInHand(gesture);
    gesture.end = startPaneDrag(client, {
      cursor: "grabbing",
      onMove: (next, shift) => this.#gestureMove(next, shift),
      onEnd: () => this.#gestureEnd(),
    });
    this.#emit();
    this.#gestureMove(client);
    this.#kick();
    return true;
  }

  /**
   * A tab's row pulled out of the sidebar: it becomes the tab's window, and
   * the hand holds it by its title bar, near the bar's leading end — the
   * window reaches out across the desk from the hand, not back over the
   * sidebar. A window already out comes to the hand as it is, flying there
   * from where it was — scaled down, its shape kept, if it is too big to
   * carry (carrySize); a tab not out comes out at the size windows come out
   * at, growing out of the row's icon under the pointer. From here it is any
   * window in hand: magnets, zones, Shift's snap, a throw, or back into the dock.
   */
  #takeInHand(gesture: Gesture): void {
    const usable = this.#usable();
    const variants = this.#host.variants();
    const lift = { scale: variants.motion === "lifted" ? LIFT_SCALE : 1, tilt: 0 };
    const point = gesture.pointer;
    const masked = this.#wins.get(gesture.tabId)?.mask != null;
    const pinTop = masked ? MASK_CARD_TOP / 2 : variants.chrome === "bar" ? CHROME_INSETS.bar.top / 2 : CHROME_CARD_TOP[variants.chrome] / 2;
    const holdX = (w: number): number => clamp(point.x - usable.x, 28, w / 2);
    gesture.overDock = false;
    gesture.pinTop = pinTop;
    gesture.tracker.reset();
    gesture.tracker.push(point.x, point.y, performance.now());
    const out = this.#wins.get(gesture.tabId);
    if (out !== undefined) {
      if (out.flight !== null) this.#land(out);
      if (out.mini?.parked === true) this.#unpark(out);
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
      win.scale = Math.max(0.04, ROW_ICON / size.w);
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
    win.tween = null;
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
    if (win === undefined) return;
    this.#noteShift(shift);
    const point = this.#toStage(client);
    gesture.pointer = point;
    gesture.tracker.push(point.x, point.y, performance.now());
    // A window spanning the desk lets go of the span once it is really on
    // the move (a grab starts at the press, before the pointer has gone anywhere).
    if (gesture.unfill !== null && Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y) >= CLICK_SLOP) {
      gesture.size = gesture.unfill;
      gesture.unfill = null;
      win.restore = null;
      this.#dirtyView = true;
    }
    if (gesture.kind === "resize") this.#placeResized(win, gesture);
    else this.#placeCarried(win, gesture);
    this.#render();
    this.#kick();
  }

  /**
   * The carried window under the pointer: the drop rail, the lit tile
   * (Shift's snap, or an edge zone pushed into), magnets, the desk's edges.
   *
   * The leading edge is read in depth, so no two targets overlap: the
   * desk's first LEFT_EDGE_BAND px offer the left half (its quarters at the
   * ends), and past the desk's edge — over the sidebar, or further — is the
   * drop rail, back into the dock above, the tab closed below.
   */
  #placeCarried(win: Win, gesture: Gesture): void {
    const usable = this.#usable();
    const point = gesture.pointer;
    gesture.drop = dockDropAt(point, this.#drops, 0);
    gesture.overDock = gesture.drop !== null;
    // Snap mode: Shift held, the desk is in thirds and the tile under the pointer is lit.
    // (Not for a masked window: a tile would stretch the picture. A minimized one snaps as any
    // window does, and is a window at its own size once in the tile — but over the shelf's band
    // at the desk's foot, where it parks again when let go, no tile is lit for it.)
    const picture = win.mask !== null;
    const overShelf = this.#overShelf(win, point);
    const snapping = this.#shift && !gesture.overDock && !picture && !overShelf;
    gesture.cell = snapping ? thirdsCell(point, usable, gesture.cell, SNAP_HYSTERESIS) : null;
    const zone =
      gesture.cell !== null ? cellZone(gesture.cell) : gesture.overDock || picture || overShelf ? null : edgeZone(point, usable, 18, 96, LEFT_EDGE_BAND);
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
    // A drawn window is the shell's picture and may travel anywhere (out over
    // the sidebar, to the drop rail); a live page is a native view the shell
    // cannot clip, so it stays on the desk.
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
    const dx = gesture.pointer.x - gesture.start.x;
    const dy = gesture.pointer.y - gesture.start.y;
    const joint = gesture.joint;
    const ownX = joint === null || joint.x === null;
    const ownY = joint === null || joint.y === null;
    // An edge that is the window's alone: out to the desk's leading edge; the desk's own edges stick on the way.
    const alone: Edges = { left: edges.left && ownX, right: edges.right && ownX, top: edges.top && ownY, bottom: edges.bottom && ownY };
    const free = magnetizeEdges(resizedRect(gesture.startRect, alone, dx, dy, this.#reach()), alone, this.#others(win.tabId), this.#usable());
    if (joint === null) {
      win.rect = free;
      return;
    }
    // A gutter other windows meet it across moves, and they give or take what it does.
    const others = this.#othersThan(joint.start);
    const tx = joint.x === null ? 0 : seamTravel(joint.start, joint.x, dx, others);
    const ty = joint.y === null ? 0 : seamTravel(joint.start, joint.y, dy, others);
    for (const [id, start] of joint.start) {
      const held = this.#wins.get(id);
      if (held === undefined) continue;
      let rect = start;
      if (joint.x !== null) rect = alongSeam(rect, joint.x, id, tx);
      if (joint.y !== null) rect = alongSeam(rect, joint.y, id, ty);
      // (A corner with a gutter one way only: the other way, its edge is its own.)
      if (id === win.tabId) rect = joint.x === null ? { ...rect, x: free.x, w: free.w } : joint.y === null ? { ...rect, y: free.y, h: free.h } : rect;
      held.rect = rect;
    }
  }

  /**
   * The seams a press on a window's edges takes hold of (seamsAt), among the
   * windows that can be on one: tabs' and documents' windows at rest on the
   * desk at their own size — not a picture (a masked window keeps its
   * shape), a minimized one, or one flying, settling or still coming out.
   * Null: no window meets it across the gutter there.
   */
  #jointAt(win: Win, edges: Edges, at: Point): Joint | null {
    const seamless = (held: Win): boolean =>
      held.mask !== null || held.maskWanted !== null || held.unmasking !== null || held.mini !== null || held.flight !== null || held.hold || this.#departing.has(held.tabId);
    if (seamless(win)) return null;
    const rects = new Map<string, Rect>();
    for (const id of this.#order) {
      const held = this.#wins.get(id)!;
      if (seamless(held) || (held !== win && (held.target !== null || held.coasting || held.tween !== null))) continue;
      rects.set(id, { ...held.rect });
    }
    const { x, y } = seamsAt(rects, win.tabId, edges, at);
    if (x === null && y === null) return null;
    const start = new Map<string, Rect>();
    for (const seam of [x, y]) for (const id of [...(seam?.before ?? []), ...(seam?.after ?? [])]) start.set(id, rects.get(id)!);
    return { x, y, start };
  }

  /** The windows a resize's seams may stick to: every window but those on them (#others). */
  #othersThan(on: ReadonlyMap<string, Rect>): Rect[] {
    const rects: Rect[] = [];
    for (const id of this.#order) {
      const win = this.#wins.get(id)!;
      if (on.has(id) || win.flight === "away" || win.mini?.parked === true) continue;
      rects.push(win.target ?? win.rect);
    }
    return rects;
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
    // Flung at the dock: fast, mostly sideways, and headed past the desk's leading edge into the sidebar.
    // (Not while Shift aims it at a tile: the tile it shows is where it goes; nor with no sidebar beside the desk.)
    const flungHome =
      this.#side !== null &&
      !gesture.snapping &&
      variants.physics !== "free" &&
      velocity.x < -PUT_AWAY_SPEED &&
      Math.abs(velocity.x) > Math.abs(velocity.y) &&
      gesture.pointer.x + glideReach(velocity.x) * 1.2 < 0;
    // Let go on the Close pad: into it, and the tab is closed once it is gone.
    // (Where it was before it was taken up is the place it leaves; a window just out of the dock left none.)
    const left = gesture.kind === "move" && this.#laidOutByDesk(win.tabId) ? { id: win.tabId, rect: { ...gesture.startRect } } : null;
    if (gesture.drop === "close") {
      this.#closeInto(win, this.#drops.close);
      this.#emit();
      this.#kick();
      if (left !== null) this.#moment({ trigger: "closed", gone: [{ ...left, how: "closed" }] });
      return;
    }
    if (gesture.overDock || flungHome) {
      this.#sendAway(win, true);
      this.#emit();
      this.#kick();
      if (left !== null) this.#moment({ trigger: "closed", gone: [{ ...left, how: "collapsed" }] });
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
    // A minimized window let go at the desk's foot parks again, at the place in the shelf nearest the pointer.
    if (win.mini !== null && this.#overShelf(win, gesture.pointer)) {
      const step = MINI_SIZE.w * (1 - MINI_OVERLAP);
      const at = clamp(Math.round((gesture.pointer.x - SHELF_INSET - MINI_SIZE.w / 2) / step), 0, this.#parked.length);
      win.mini.parked = true;
      this.#parked.splice(at, 0, win.tabId);
      this.#layShelf();
      this.#save();
      this.#emit();
      this.#render();
      this.#kick();
      return;
    }
    win.vel = { x: velocity.x, y: velocity.y, w: win.vel.w, h: win.vel.h };
    const inside = sameRect(clampRect(basis, this.#reach(), this.#minSize(win)), basis, 2);
    if (gesture.zone !== null) {
      // A minimized window snapped into a tile is a window at its own size again;
      // filling the desk, it can be given back the box it had before it was minimized.
      const mini = win.mini;
      if (mini !== null) this.#unminimize(win);
      // Filling the desk again, it can be given back the size it had — which,
      // for a window that let go of the desk on the way, is no size of its own.
      if (gesture.zone === "maximize") win.restore = mini !== null ? clampRect(mini.restore, this.#reach()) : gesture.size === null ? { ...gesture.startRect } : null;
      win.target = tileRect(gesture.zone, usable);
    } else if (variants.physics === "snap" && win.mask === null) {
      // Every release lands in a tile: a minimized window, too, which is then at its own size again.
      if (win.mini !== null) this.#unminimize(win);
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
    const win = this.#wins.get(gesture.tabId);
    if (win !== undefined) {
      win.lift = { scale: 1, tilt: 0 };
      win.target = gesture.kind === "spawn" ? null : this.#rest(win, win.rect);
      if (gesture.kind === "spawn") this.#sendAway(win, true);
    }
  }

  // ── Another group ──────────────────────────────────────────────────────

  /**
   * A tab of the group sent to another group: the tab goes into that group.
   * A window of it out on the desk goes too, flying into that group's row
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
    const eased = variants.spring === "eased";
    // Eased, a flight's scale is eased with its position (the tween, below); otherwise it rides the same spring.
    const easedFlight = eased && win.flight !== null && win.target !== null;
    const liftSpring = eased ? EASED_SPRING : LIFT_SPRING;
    const scale = easedFlight ? { x: win.scale, v: 0 } : stepSpring(win.scale, win.scaleV, scaleTarget, win.flight === null ? liftSpring : this.#spring(), dt);
    const tilt = stepSpring(win.tilt, win.tiltV, tiltTarget, liftSpring, dt);
    win.scale = scale.x;
    win.scaleV = scale.v;
    win.tilt = tilt.x;
    win.tiltV = tilt.v;
    const scaled = easedFlight || springAtRest(win.scale, win.scaleV, scaleTarget, 0.0005, 0.01);
    if (!scaled || !springAtRest(win.tilt, win.tiltV, tiltTarget, 0.05, 0.5)) moving = true;
    else {
      if (!easedFlight) win.scale = scaleTarget;
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
        const spring = reducedMotion() ? REDUCED_SPRING : eased ? EASED_SPRING : CATCH_SPRING;
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
      // Eased (the Feel's Spring), whatever set the target: a timed ease there, by what the motion does.
      // (Begun a frame back: this frame is its first step, not a frame standing still.)
      if (eased && (win.tween === null || !sameRect(win.tween.to, win.target, 0.01))) this.#easeTo(win, win.target, now - dt * 1_000);
      // A timed move (the shelf's, a leave's, or Eased's): eased along to its place, and arrived there once its time is up.
      const tween = win.tween;
      if (tween !== null && !sameRect(tween.to, win.target, 0.01)) win.tween = null;
      else if (tween !== null) {
        const t = tween.ms <= 0 ? 1 : clamp((now - tween.start) / tween.ms, 0, 1);
        const along = EASE_SMOOTH_OUT(t);
        win.vel = { ...ZERO_RECT };
        if (tween.scale !== undefined) {
          win.scale = t < 1 ? tween.scale.from + (tween.scale.to - tween.scale.from) * along : tween.scale.to;
          win.scaleV = 0;
        }
        if (t < 1) {
          win.rect = {
            x: tween.from.x + (tween.to.x - tween.from.x) * along,
            y: tween.from.y + (tween.to.y - tween.from.y) * along,
            w: tween.from.w + (tween.to.w - tween.from.w) * along,
            h: tween.from.h + (tween.to.h - tween.from.h) * along,
          };
          return true;
        }
        win.rect = { ...tween.to };
        win.tween = null;
      }
      const spring = this.#spring();
      const target = win.target;
      const x = stepSpring(win.rect.x, win.vel.x, target.x, spring, dt);
      const y = stepSpring(win.rect.y, win.vel.y, target.y, spring, dt);
      const w = stepSpring(win.rect.w, win.vel.w, target.w, spring, dt);
      const h = stepSpring(win.rect.h, win.vel.h, target.h, spring, dt);
      win.rect = { x: x.x, y: y.x, w: Math.max(1, w.x), h: Math.max(1, h.x) };
      win.vel = { x: x.v, y: y.v, w: w.v, h: h.v };
      // Growing, it goes no further than the box it grows to (its page is laid out at that box, and nothing past it).
      if (win.growTo !== null && sameRect(win.growTo.to, target, 0.01)) this.#keepInGrowth(win, win.growTo);
      if (
        springAtRest(win.rect.x, win.vel.x, target.x) &&
        springAtRest(win.rect.y, win.vel.y, target.y) &&
        springAtRest(win.rect.w, win.vel.w, target.w) &&
        springAtRest(win.rect.h, win.vel.h, target.h) &&
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
        // Minimized, or grown back from it: its page is live again, at the zoom it now has.
        if (win.miniMotion !== null) {
          win.miniMotion = null;
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
    // It may coast as far as the card's edges.
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
    // Each window cut short of what lies over the desk's foot (#cutFor): only what is left of its page need be clear.
    const ledges = this.#ledges();
    const frames = new Map<string, Rect>();
    for (const tabId of this.#order) {
      const win = this.#wins.get(tabId)!;
      win.cut = this.#cutFor(win, win.rect, ledges);
      frames.set(tabId, this.#liveBox(win));
    }
    const gesture = this.#gesture;
    const zone = gesture?.zone ?? null;
    // An armed zone is drawn by the shell too; pages under it must give way to it.
    let order = zone === null ? this.#order : [...this.#order.slice(0, -1), "\u0000zone", ...this.#order.slice(-1)];
    if (zone !== null) frames.set("\u0000zone", tileRect(zone, this.#usable()));
    // So must what is drawn over the desk above every window: a card beside the sidebar, the Bar's tooltips —
    // and the Bar's notch, over a window not cut short of it.
    const covers = new Map(this.#covers);
    const notch = this.#notchRect();
    if (notch !== null && this.#phase === "open") covers.set("\u0000notch", notch);
    // A window just masked: the rest of it fades from around its region, over whatever it stood on.
    const fade = this.#maskFade;
    if (fade !== null && (now >= fade.until || !this.#wins.has(fade.tabId))) {
      this.#maskFade = null;
      this.#dirtyView = true;
    } else if (fade !== null) covers.set("\u0000maskfade", fade.from);
    // Leaving, nothing of the desk stays over the window becoming the pane (the dock, the Bar, a card closing): it
    // waits on none of them, and goes live as it grows (leave).
    if (covers.size > 0 && this.#phase !== "leaving") {
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
      this.#latchGrowth(win);
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
      // So is a window shrinking into minimized: its page is laid out at the size it ends at. (Growing back from it, it is live: growTo.)
      const forced =
        win.flight !== null ||
        (this.#gesture?.kind === "spawn" && this.#gesture.tabId === win.tabId) ||
        this.#editing === win.tabId ||
        win.unmasking !== null ||
        win.miniMotion === "in";
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
      for (const win of this.#wins.values()) if (!win.drawn && rectsOverlap(this.#liveBox(win), rect)) live = true;
      if (!live) clear.add(key);
    }
    const before = this.#clearCovers;
    if (clear.size === before.size && [...clear].every((key) => before.has(key))) return;
    this.#clearCovers = clear;
    this.#dirtyView = true;
  }

  #spring(): SpringConfig {
    const feel = this.#host.variants().spring;
    return reducedMotion() ? REDUCED_SPRING : feel === "eased" ? EASED_SPRING : SPRING_PRESETS[feel];
  }

  #wantsStillForMotion(win: Win): boolean {
    // Leaving, the window in use grows into the pane as its live page: its page is laid out at the pane's box already.
    if (this.#phase === "leaving" && this.#leaveTop === win.tabId) return false;
    // So does any window growing into a larger box (growTo), once it is let go.
    if (win.growTo !== null && this.#gesture?.tabId !== win.tabId) return false;
    if (
      win.flight !== null ||
      win.hold ||
      win.unmasking !== null ||
      win.miniMotion === "in" ||
      this.#selecting === win.tabId ||
      this.#editing === win.tabId ||
      this.#departing.has(win.tabId)
    )
      return true;
    const gesture = this.#gesture;
    const carried = gesture?.tabId === win.tabId ? gesture : null;
    // A parked window rising into view, or going back down, stays live: its page never changes size (main holds it at its zoomed box).
    if (win.mini?.parked === true && carried === null) return false;
    if (carried?.kind === "spawn") return true;
    // A picture being resized is its still, stretched.
    if (carried?.kind === "resize" && win.mask !== null) return true;
    if (this.#host.variants().motion === "live") return false;
    if (carried?.kind === "move") return true;
    return win.coasting || win.target !== null || win.scale !== 1 || win.tilt !== 0;
  }

  /** Eased: a timed ease from where the window is to `target`, for as long as what it does takes (EASED_*), its scale along with it in flight. */
  #easeTo(win: Win, target: Rect, now: number): void {
    const resized = Math.abs(target.w - win.rect.w) > 1 || Math.abs(target.h - win.rect.h) > 1;
    const ms = reducedMotion() ? 0 : win.flight === "in" ? EASED_OPEN_MS : win.flight === "away" ? EASED_CLOSE_MS : resized ? EASED_RESIZE_MS : EASED_MOVE_MS;
    win.tween = {
      from: { ...win.rect },
      to: { ...target },
      start: now,
      ms,
      ...(win.flight !== null ? { scale: { from: win.scale, to: win.drawn ? win.lift.scale : 1 } } : {}),
    };
    win.vel = { ...ZERO_RECT };
  }

  /**
   * A beat between the windows of an arrangement, or of a desk coming out:
   * `lead` then `each` per window — or, Eased, the stagger token per window,
   * the whole run of `count` within its total. Seconds.
   */
  #beat(index: number, count: number, lead: number, each: number): number {
    if (this.#host.variants().spring !== "eased") return lead + index * each;
    return (index * Math.min(DURATION_STAGGER_MS, STAGGER_TOTAL_MS / Math.max(1, count))) / 1000;
  }

  /**
   * Whether a window is growing into a larger box (growTo), read as it sets
   * out — and kept until it gets there, or is sent somewhere else. Only a
   * tab's live page, at its own size and its own zoom: a masked one, a
   * minimized one and one coming off its mask have their own ways, a window
   * in hand or in flight is a picture anyway, and leaving, only the window
   * becoming the pane.
   */
  #latchGrowth(win: Win): void {
    const target = win.target;
    const latched = win.growTo;
    if (latched !== null && target !== null && sameRect(latched.to, target, 0.5)) return;
    win.growTo = null;
    if (
      target === null ||
      win.flight !== null ||
      win.coasting ||
      win.mask !== null ||
      win.maskWanted !== null ||
      win.unmasking !== null ||
      win.mini !== null ||
      win.miniMotion === "in" ||
      this.#gesture?.tabId === win.tabId ||
      (this.#phase === "leaving" && this.#leaveTop !== win.tabId) ||
      !isTabWindow(win.tabId) ||
      !this.#host.hasLivePage(win.tabId)
    )
      return;
    if (target.w <= win.rect.w + 2 && target.h <= win.rect.h + 2) return;
    win.growTo = { from: { ...win.rect }, to: { ...target } };
    this.#dirtyView = true;
  }

  /** A growing window held inside where it set out from and where it is going: its springs stop at the edge they would pass. */
  #keepInGrowth(win: Win, grow: { from: Rect; to: Rect }): void {
    const { from, to } = grow;
    const left = Math.min(from.x, to.x);
    const top = Math.min(from.y, to.y);
    const right = Math.max(from.x + from.w, to.x + to.w);
    const bottom = Math.max(from.y + from.h, to.y + to.h);
    let { x, y, w, h } = win.rect;
    const vel = { ...win.vel };
    if (x < left) {
      w -= left - x;
      x = left;
      vel.x = 0;
    }
    if (y < top) {
      h -= top - y;
      y = top;
      vel.y = 0;
    }
    if (x + w > right) {
      w = right - x;
      vel.w = 0;
    }
    if (y + h > bottom) {
      h = bottom - y;
      vel.h = 0;
    }
    win.rect = { x, y, w: Math.max(1, w), h: Math.max(1, h) };
    win.vel = vel;
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
    // A window peeking from the desk's foot is cut off at the desk's edge (its page's view is cut short there too, #report).
    const below = transformed ? 0 : Math.max(0, y + h - this.#stageBox.height);
    // Under the Bar's notch, the notch is a hole through it (setNotchShape).
    const notched = this.#notchClip(win, below, transformed);
    const key = `${transform}|${w.toFixed(1)}|${h.toFixed(1)}|${win.origin.x.toFixed(0)},${win.origin.y.toFixed(0)}|${revealKey}|${below.toFixed(1)}|${win.cut.toFixed(1)}|${notched ?? ""}`;
    if (key === win.written) return;
    win.written = key;
    // Cut short over the desk's foot, its page stops there (DeskWindow's page box), the rest of its frame under what lies there.
    el.style.setProperty("--desk-cut", `${win.cut.toFixed(1)}px`);
    el.style.clipPath = notched ?? (below > 0 ? `inset(-40px -40px ${below.toFixed(1)}px -40px)` : "");
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
    const ledges = this.#ledges();
    // The desk first: a masked page's view is placed only once main has its mask.
    this.#reportDesk(api, ledges);
    const views: Array<{ tabId: string; bounds: { x: number; y: number; width: number; height: number } }> = [];
    for (const tabId of this.#order) {
      const win = this.#wins.get(tabId)!;
      if (win.drawn) continue;
      const insets = this.#insets(win);
      const y = Math.round(top + win.rect.y + insets.top);
      // Peeking from the desk's foot, its view is cut short at the desk's edge: main shows the top of its (zoomed) page.
      const foot = Math.round(top + this.#stageBox.height);
      // Growing, its view is never larger than the page it is laid out at (growTo): one dimension may be shrinking meanwhile.
      const grow = win.growTo?.to ?? null;
      const width = Math.round(win.rect.w - insets.left - insets.right);
      // (Cut short, its foot is where what it is cut short of begins, as the frame's page box has it.)
      const height = win.cut > 0 ? Math.round(top + win.rect.y + win.rect.h - insets.bottom - win.cut) - y : Math.round(win.rect.h - insets.top - insets.bottom);
      const grown = grow === null ? height : Math.round(grow.h - insets.top - insets.bottom - this.#cutFor(win, grow, ledges));
      const bounds = {
        x: Math.round(left + win.rect.x + insets.left),
        y,
        width: Math.max(1, grow === null ? width : Math.min(width, Math.round(grow.w - insets.left - insets.right))),
        height: Math.max(1, Math.min(height, grown, foot - y)),
      };
      views.push({ tabId, bounds });
    }
    const payload = views.map(({ tabId, bounds }) => `${tabId}:${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`).join(" ");
    if (payload !== this.#sentLayout) {
      this.#sentLayout = payload;
      api.setLayout({ views, stacked: true });
    }
  }

  /** Which views are desk windows, the grab key, whether a tab's row in the sidebar is hovered, and the masked pages. */
  #reportDesk(api: NonNullable<ReturnType<typeof nativeApi>>, ledges: readonly Rect[]): void {
    const grab = this.#host.variants().grab;
    // (The dock is the sidebar's column, beside the desk: there is no place of it over a page for main to watch.)
    const dock = null;
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
    // Minimized pages, laid out at their box zoomed out; and a page growing back from minimized, held at the box it grows to.
    const zoomed: DeskZoomedPage[] = [];
    for (const tabId of leavingLast(this.#order)) {
      const win = this.#wins.get(tabId)!;
      if (!isTabWindow(tabId) || (win.mini === null && win.miniMotion !== "out")) continue;
      const insets = this.#insets(win);
      const box = win.target ?? win.rect;
      zoomed.push({
        tabId,
        width: Math.max(1, Math.round(box.w - insets.left - insets.right)),
        height: Math.max(1, Math.round(box.h - insets.top - insets.bottom)),
        zoom: win.mini !== null ? DESK_MINI_ZOOM : 1,
      });
    }
    // Growing into a larger box: laid out at it at once, as it grows there (growTo).
    for (const tabId of leavingLast(this.#order)) {
      const win = this.#wins.get(tabId)!;
      const grow = win.growTo;
      if (grow === null || zoomed.some((page) => page.tabId === tabId)) continue;
      const insets = this.#insets(win);
      // (As cut short there as it will be.)
      zoomed.push({
        tabId,
        width: Math.max(1, Math.round(grow.to.w - insets.left - insets.right)),
        height: Math.max(1, Math.round(grow.to.h - insets.top - insets.bottom - this.#cutFor(win, grow.to, ledges))),
        zoom: 1,
      });
    }
    // Leaving, the window in use: laid out at the pane's box at once, as it grows there.
    if (this.#leaveTop !== null && this.#wins.has(this.#leaveTop) && !zoomed.some((page) => page.tabId === this.#leaveTop))
      zoomed.push({ tabId: this.#leaveTop, width: Math.max(1, Math.round(this.#stageBox.width)), height: Math.max(1, Math.round(this.#stageBox.height)), zoom: 1 });
    zoomed.splice(MAX_DESK_WINDOWS);
    const dockHover = this.#dockHover;
    // Main hears of tabs' windows only: a document has no page of its own.
    const desk = { tabIds: leavingLast(this.#staying().filter(isTabWindow)).slice(0, MAX_DESK_WINDOWS), grab: grab === "off" ? null : grab, dock, dockHover, masks, zoomed };
    const deskKey = `${desk.tabIds.join(" ")}|${desk.grab ?? ""}|${dockHover ? "hover" : ""}|${masks
      .map((page) => `${page.tabId}:${deskMaskKey(page.mask)}:${page.width}x${page.height}`)
      .join(" ")}|${zoomed.map((page) => `${page.tabId}:${page.width}x${page.height}@${page.zoom}`).join(" ")}`;
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
    // A document's own content takes the keyboard, in the shell.
    if (!isTabWindow(tabId)) {
      this.#pendingFocus = null;
      this.#host.focusWindow?.(tabId);
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
          aiming: carried && gesture.zone !== null,
          intoDock: carried && gesture.overDock,
          flight: win.flight,
          closing: win.closing,
          framed: win.framed,
          // Letting go of the desk in hand, it is no longer the desk's size, whatever size it has reached.
          maximized: win.mask === null && win.mini === null && !(carried && gesture.size !== null) && sameRect(win.target ?? win.rect, usable, 2),
          mini: win.mini === null ? null : win.mini.parked ? "parked" : "free",
          raised: this.#raised === tabId,
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
      drops: this.#drops,
      dropsShown: this.#dropsNear,
      dockDrop: this.#armedDrop,
      clearCovers: this.#clearCovers,
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
      cut: 0,
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
      mini: null,
      miniMotion: null,
      tween: null,
      growTo: null,
      maskWanted: null,
      unmasking: null,
      revealed: false,
      homeward: false,
      closing: false,
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
    if (this.#selecting !== null && this.#selecting !== tabId) this.#selecting = null;
    if (this.#editing !== null && this.#editing !== tabId) {
      this.#editing = null;
      this.#dirtyView = true;
    }
    if (index !== this.#order.length - 1) {
      this.#order.splice(index, 1);
      this.#order.push(tabId);
      // The shelf stays over the rest: nothing else reaches the desk's foot, save the window raised from it.
      this.#stackShelf();
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
    const home = to ?? this.#iconRect(win.tabId) ?? this.#sideMiddle();
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
    // Minimized, it goes as it is; the shelf closes up behind it.
    if (win.mini !== null) {
      this.#unpark(win);
      win.mini = null;
    }
    win.miniMotion = null;
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
        const next = this.#topWindow();
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

  /** The tab's row in the sidebar gives a little bounce: its window has just come back into it (a document's, the Stack's row). */
  #receive(tabId: string): void {
    this.#bounce(this.#host.homeOf(isTabWindow(tabId) ? "tab" : "file", tabId) ?? undefined);
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
    const win = this.#wins.get(tabId);
    if (win !== undefined) this.#unpark(win);
    this.#wins.delete(tabId);
    this.#order = this.#order.filter((id) => id !== tabId);
    if (this.#selecting === tabId) this.#selecting = null;
    if (this.#editing === tabId) this.#editing = null;
    if (this.#focused === tabId) this.#focused = this.#topWindow();
    this.#dirtyView = true;
  }

  /**
   * Where a released window rests: on the desk, as far as its leading edge —
   * stuck to whatever edge it is beside, the desk's own among them.
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
      // (The shelf is below where windows go: nothing sticks to it.)
      if (win.flight === "away" || win.mini?.parked === true) continue;
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
      // A minimized window is kept minimized, with the box it grows back to (parked, where it is is the shelf's to say).
      const mini = win.mini === null ? undefined : { restore: normalizeRect(clampRect(win.mini.restore, this.#reach()), usable), parked: win.mini.parked };
      windows.push(
        mask !== null
          ? { tabId, rect: normalizeRect(clampRect(rect, this.#reach(), min), usable), mask }
          : mini !== undefined
            ? { tabId, rect: normalizeRect(clampRect(rect, this.#reach()), usable), mini }
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
   * The desk windows are laid out on: the whole of the desk's card, so a
   * window filling the desk fills the card, as a page fills its pane — the
   * Bar's notch and the parked windows lie over its foot (#cutFor). Tiles,
   * filling the desk, the arrangements and where a new window comes out
   * use it.
   */
  #usable(): Rect {
    const { width, height } = this.#stageBox;
    return { x: 0, y: 0, w: Math.max(1, width), h: Math.max(1, height) };
  }

  /**
   * Where a window may be: the same box as #usable. (They differed while the
   * desk had a dock of its own over its leading edge, which a window could
   * lie behind but no layout used.)
   */
  #reach(): Rect {
    return this.#usable();
  }

  /** The Bar's notch in the stage (setNotch), or null. */
  #notchRect(): Rect | null {
    const notch = this.#notch;
    if (notch === null || notch.w < 1 || notch.h < 1) return null;
    const { width, height } = this.#stageBox;
    return { x: (width - notch.w) / 2, y: height - notch.h, w: notch.w, h: notch.h };
  }

  /**
   * What the shell draws at the desk's foot over the windows there: the
   * Bar's notch, and each parked window where it peeks up (raised, its
   * place down there still counts: the windows under it are not cut anew
   * for a hover, only covered).
   */
  #ledges(): Rect[] {
    const ledges: Rect[] = [];
    const notch = this.#notchRect();
    if (notch !== null) ledges.push(notch);
    this.#parked.forEach((_, index) => ledges.push(this.#shelfRect(index, this.#parked.length, false)));
    return ledges;
  }

  /**
   * How far short of its frame's foot a window at `rect` stops its page: at
   * the top of what lies over the desk's foot under its page (#ledges), so
   * its live page never paints over them — they are drawn over the rest of
   * its frame there, as a notch in a screen with the menu bar around it. A
   * tab's window at its own size only, on the open desk: a minimized or
   * masked one, or a document (the shell's own, under them anyway), is
   * covered by them instead; so is one that would keep too little page.
   */
  #cutFor(win: Win, rect: Rect, ledges: readonly Rect[]): number {
    if (this.#phase !== "open" || win.mini !== null || win.mask !== null || !isTabWindow(win.tabId)) return 0;
    const insets = this.#insets(win);
    const left = rect.x + insets.left;
    const right = rect.x + rect.w - insets.right;
    const top = rect.y + insets.top;
    const bottom = rect.y + rect.h - insets.bottom;
    let stop = bottom;
    for (const ledge of ledges) {
      if (ledge.x < right && left < ledge.x + ledge.w && ledge.y < bottom && ledge.y + ledge.h > top) stop = Math.min(stop, ledge.y);
    }
    const cut = bottom - stop;
    return cut > 0.01 && bottom - top - cut >= MIN_CUT_PAGE ? cut : 0;
  }

  /**
   * Where a window's live page may be over the desk: its frame, less what it
   * is cut short by at the desk's foot and the frame's foot below that (with
   * half a pixel to spare for main's rounding of its view).
   */
  #liveBox(win: Win): Rect {
    return win.cut > 0 ? { ...win.rect, h: win.rect.h - win.cut - this.#insets(win).bottom - 0.5 } : win.rect;
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
   * Where a window lives in the sidebar, which it flies out of and back into
   * — its row's icon, in the stage (left of it): a tab's row (its group
   * folded away, the group's row), or a document's, the Stack's. Null where
   * the sidebar shows none.
   */
  #iconRect(tabId: string): Rect | null {
    const el = this.#host.homeOf(isTabWindow(tabId) ? "tab" : "file", tabId);
    return el === null ? null : this.#iconOf(el);
  }

  /** Another group's row in the sidebar: its windows come out of it, and go back into it. */
  #groupRect(groupId: string): Rect | null {
    const el = this.#host.homeOf("group", groupId);
    return el === null ? null : this.#iconOf(el);
  }

  /** A row's icon, in the stage: its leading mark, which the sidebar's rows draw 8px in, on their middle. */
  #iconOf(el: HTMLElement): Rect | null {
    if (!el.isConnected) return null;
    const box = el.getBoundingClientRect();
    if (box.width < 1) return null;
    const size = Math.min(box.height, ROW_ICON * 1.5);
    return {
      x: box.left - this.#stageBox.left + 8 - (size - ROW_ICON) / 2,
      y: box.top - this.#stageBox.top + (box.height - size) / 2,
      w: size,
      h: size,
    };
  }

  /** The sidebar's middle, level with the desk's: where windows go, or come from, with no row of their own to find. */
  #sideMiddle(): Rect {
    const side = this.#side;
    const size = ROW_ICON * 1.5;
    return { x: side === null ? -size - DESK_GAP : side.x + side.w / 2 - size / 2, y: this.#stageBox.height / 2 - size / 2, w: size, h: size };
  }

  #toStage(client: Point): Point {
    return { x: client.x - this.#stageBox.left, y: client.y - this.#stageBox.top };
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
