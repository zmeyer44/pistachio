/**
 * The desk's geometry (components/desk): windows are rectangles in the
 * stage's own coordinates, and everything here — where a window may be
 * seen live, which edge zone the pointer arms, what a window sticks to,
 * how a set of windows tiles — is a pure function of rectangles.
 *
 * Pure on purpose — no DOM — so vitest pins it under node.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The space between two windows, and between a window and the inventory. */
export const DESK_GAP = 8;
export const MIN_WINDOW_W = 300;
export const MIN_WINDOW_H = 200;
/** How close an edge must come to another before it sticks to it. */
export const MAGNET_PX = 14;

export function rightOf(rect: Rect): number {
  return rect.x + rect.w;
}

export function bottomOf(rect: Rect): number {
  return rect.y + rect.h;
}

export function centerOf(rect: Rect): Point {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

/** Overlap with area — edges that only touch do not count. */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < rightOf(b) && b.x < rightOf(a) && a.y < bottomOf(b) && b.y < bottomOf(a);
}

export function containsPoint(rect: Rect, point: Point): boolean {
  return point.x >= rect.x && point.x < rightOf(rect) && point.y >= rect.y && point.y < bottomOf(rect);
}

export function sameRect(a: Rect, b: Rect, epsilon = 0.5): boolean {
  return (
    Math.abs(a.x - b.x) <= epsilon &&
    Math.abs(a.y - b.y) <= epsilon &&
    Math.abs(a.w - b.w) <= epsilon &&
    Math.abs(a.h - b.h) <= epsilon
  );
}

/** A window's least size: a page's, or — a masked window, a picture of part of one — as small as its mask may be. */
export interface MinSize {
  w: number;
  h: number;
}

const WINDOW_MIN: MinSize = { w: MIN_WINDOW_W, h: MIN_WINDOW_H };

/** No larger than `bounds` (nor smaller than `min`, room permitting), and wholly inside it. */
export function clampRect(rect: Rect, bounds: Rect, min: MinSize = WINDOW_MIN): Rect {
  const w = Math.min(bounds.w, Math.max(Math.min(min.w, bounds.w), rect.w));
  const h = Math.min(bounds.h, Math.max(Math.min(min.h, bounds.h), rect.h));
  return {
    x: Math.min(rightOf(bounds) - w, Math.max(bounds.x, rect.x)),
    y: Math.min(bottomOf(bounds) - h, Math.max(bounds.y, rect.y)),
    w,
    h,
  };
}

/**
 * Past an edge by `over` px, drawn this far past it: the further it is
 * pulled the less it gives, never reaching `limit`. The feel of a scroll
 * view pulled past its end.
 */
export function rubberBand(over: number, limit: number): number {
  if (over <= 0 || limit <= 0) return 0;
  return limit * (1 - 1 / ((over * 0.55) / limit + 1));
}

/** Kept inside `bounds`, except that a push past an edge gives a little, as rubber does. */
export function rubberBandRect(rect: Rect, bounds: Rect, limit: number, min: MinSize = WINDOW_MIN): Rect {
  const inside = clampRect(rect, bounds, min);
  const dx = rect.x - inside.x;
  const dy = rect.y - inside.y;
  return {
    ...inside,
    x: inside.x + Math.sign(dx) * rubberBand(Math.abs(dx), limit),
    y: inside.y + Math.sign(dy) * rubberBand(Math.abs(dy), limit),
  };
}

/** A rectangle as fractions of `bounds`, so an arrangement survives the window being resized. */
export function normalizeRect(rect: Rect, bounds: Rect): Rect {
  return {
    x: (rect.x - bounds.x) / Math.max(1, bounds.w),
    y: (rect.y - bounds.y) / Math.max(1, bounds.h),
    w: rect.w / Math.max(1, bounds.w),
    h: rect.h / Math.max(1, bounds.h),
  };
}

export function denormalizeRect(rect: Rect, bounds: Rect): Rect {
  return {
    x: bounds.x + rect.x * bounds.w,
    y: bounds.y + rect.y * bounds.h,
    w: rect.w * bounds.w,
    h: rect.h * bounds.h,
  };
}

/**
 * A rectangle carried from the desk at one size to the desk at another, in
 * proportion — each window counted with the gutter after it, so windows a
 * gutter apart stay a gutter apart (a seam stays one), and a window against
 * the desk's edge stays against it.
 */
export function rescaleRect(rect: Rect, before: Rect, after: Rect, gap = DESK_GAP): Rect {
  const sx = (after.w + gap) / Math.max(1, before.w + gap);
  const sy = (after.h + gap) / Math.max(1, before.h + gap);
  return {
    x: after.x + (rect.x - before.x) * sx,
    y: after.y + (rect.y - before.y) * sy,
    w: (rect.w + gap) * sx - gap,
    h: (rect.h + gap) * sy - gap,
  };
}

export function isFiniteRect(value: unknown): value is Rect {
  if (typeof value !== "object" || value === null) return false;
  const rect = value as Record<string, unknown>;
  return (["x", "y", "w", "h"] as const).every((key) => typeof rect[key] === "number" && Number.isFinite(rect[key]));
}

/**
 * The windows whose live page may be on screen: those nothing above them
 * overlaps. `order` runs bottom to top.
 *
 * A live page is a native view, and a native view paints over everything
 * the shell draws — including the frame of a window stacked above it. So a
 * window with anything over it is drawn by the shell (its still), where the
 * stacking is the DOM's and always right; only the uncovered ones go live.
 */
export function uncoveredWindows(order: readonly string[], frames: ReadonlyMap<string, Rect>): Set<string> {
  const uncovered = new Set<string>();
  for (let index = 0; index < order.length; index += 1) {
    const frame = frames.get(order[index]!);
    if (frame === undefined) continue;
    let covered = false;
    for (let above = index + 1; above < order.length && !covered; above += 1) {
      const other = frames.get(order[above]!);
      covered = other !== undefined && rectsOverlap(frame, other);
    }
    if (!covered) uncovered.add(order[index]!);
  }
  return uncovered;
}

/* ------------------------------ snap zones ------------------------------ */

export type SnapZone = "left" | "right" | "top-left" | "top-right" | "bottom-left" | "bottom-right" | "maximize";

/**
 * The zone a pointer arms by pushing into an edge of the desk while it
 * carries a window, the way a window pushed into a screen edge offers to
 * tile: a side edge is that half, the top edge is the whole desk, and the
 * ends of an edge are the quarters in that corner. Past an edge counts as
 * at it: a pointer carried out over the sidebar lights the left half, as one
 * carried off the window's right side lights the right.
 */
export function edgeZone(point: Point, bounds: Rect, edge = 18, corner = 96): SnapZone | null {
  const nearLeft = point.x <= bounds.x + edge;
  const nearRight = point.x >= rightOf(bounds) - edge;
  const nearTop = point.y <= bounds.y + edge;
  const nearBottom = point.y >= bottomOf(bounds) - edge;
  const topBand = point.y <= bounds.y + corner;
  const bottomBand = point.y >= bottomOf(bounds) - corner;
  const leftBand = point.x <= bounds.x + corner;
  const rightBand = point.x >= rightOf(bounds) - corner;
  if (nearLeft) return topBand ? "top-left" : bottomBand ? "bottom-left" : "left";
  if (nearRight) return topBand ? "top-right" : bottomBand ? "bottom-right" : "right";
  if (nearTop) return leftBand ? "top-left" : rightBand ? "top-right" : "maximize";
  if (nearBottom) return leftBand ? "bottom-left" : rightBand ? "bottom-right" : null;
  return null;
}

/** Where a window in `zone` sits. */
export function zoneRect(zone: SnapZone, bounds: Rect, gap = DESK_GAP): Rect {
  const halfW = (bounds.w - gap) / 2;
  const halfH = (bounds.h - gap) / 2;
  const leftX = bounds.x;
  const rightX = bounds.x + halfW + gap;
  const topY = bounds.y;
  const bottomY = bounds.y + halfH + gap;
  switch (zone) {
    case "maximize":
      return { ...bounds };
    case "left":
      return { x: leftX, y: topY, w: halfW, h: bounds.h };
    case "right":
      return { x: rightX, y: topY, w: halfW, h: bounds.h };
    case "top-left":
      return { x: leftX, y: topY, w: halfW, h: halfH };
    case "top-right":
      return { x: rightX, y: topY, w: halfW, h: halfH };
    case "bottom-left":
      return { x: leftX, y: bottomY, w: halfW, h: halfH };
    case "bottom-right":
      return { x: rightX, y: bottomY, w: halfW, h: halfH };
  }
}

/** A tile of the desk in thirds (thirdsZone): an edge zone's, or a comfortable window in the middle. */
export type TileZone = SnapZone | "center";

/** One of the nine cells of the desk in thirds, column and row from 0 to 2. */
export interface ThirdsCell {
  column: number;
  row: number;
}

const THIRDS_GRID: ReadonlyArray<ReadonlyArray<TileZone>> = [
  ["top-left", "maximize", "top-right"],
  ["left", "center", "right"],
  ["bottom-left", "center", "bottom-right"],
];

/**
 * The middle column's top cell — the whole desk — is only this much of the
 * desk's height, a band along its top edge: a window has to be taken up to
 * the top to fill the desk. A window carried by its title bar through the
 * middle of the desk has the pointer well up in the top third, and that
 * lands it centred.
 */
export const SNAP_TOP_SHARE = 0.07;

const THIRDS: readonly [number, number] = [1 / 3, 2 / 3];
const MIDDLE_ROWS: readonly [number, number] = [SNAP_TOP_SHARE, 2 / 3];

/**
 * The cell of the desk in thirds a point is in (past an edge, the cell at
 * that edge) — in the middle column, the top cell is the band along the top
 * edge (SNAP_TOP_SHARE). Given the cell it was in before, it stays there
 * until it is `hysteresis` px past that cell's edge — a pointer resting on
 * a line must not flicker between the two tiles either side of it.
 */
export function thirdsCell(point: Point, bounds: Rect, previous: ThirdsCell | null = null, hysteresis = 0): ThirdsCell {
  const band = (at: number, start: number, size: number, before: number | undefined, cuts: readonly [number, number]): number => {
    const f = (at - start) / Math.max(1, size);
    const plain = f < cuts[0] ? 0 : f > cuts[1] ? 2 : 1;
    if (before === undefined || plain === before) return plain;
    const edges = [0, cuts[0], cuts[1], 1];
    const slack = hysteresis / Math.max(1, size);
    return f >= edges[before]! - slack && f <= edges[before + 1]! + slack ? before : plain;
  };
  const column = band(point.x, bounds.x, bounds.w, previous?.column, THIRDS);
  return { column, row: band(point.y, bounds.y, bounds.h, previous?.row, column === 1 ? MIDDLE_ROWS : THIRDS) };
}

/** The tile a cell of the desk in thirds stands for. */
export function cellZone(cell: ThirdsCell): TileZone {
  return THIRDS_GRID[clampBand(cell.row)]![clampBand(cell.column)]!;
}

function clampBand(index: number): number {
  return Math.min(2, Math.max(0, Math.round(index)));
}

/**
 * The tiles a window can be put in, by where on the desk: the desk in
 * thirds. The corners are quarters, the sides halves, the band along the
 * top edge of the middle column the whole desk, and the rest of the middle
 * column a comfortable window in the centre. Read where a THROW would carry the pointer (the Snap throw), and
 * where the pointer is while Shift is held (snap mode, tileRect).
 */
export function thirdsZone(point: Point, bounds: Rect): TileZone {
  return cellZone(thirdsCell(point, bounds));
}

/** Where a window put in `zone` sits. */
export function tileRect(zone: TileZone, bounds: Rect, gap = DESK_GAP): Rect {
  return zone === "center" ? centeredRect(bounds) : zoneRect(zone, bounds, gap);
}

/**
 * The size a window comes out onto the desk at — pulled from the inventory,
 * or let go of the whole desk as it is dragged (letGoSize): big enough
 * to read, small enough to carry to a half or a quarter.
 */
export function windowSize(bounds: Rect): { w: number; h: number } {
  return {
    w: Math.max(Math.min(MIN_WINDOW_W, bounds.w), Math.round(bounds.w * 0.58)),
    h: Math.max(Math.min(MIN_WINDOW_H, bounds.h), Math.round(bounds.h * 0.74)),
  };
}

/** As good as the whole desk: this much of it both ways. */
export function fillsDesk(rect: Rect, bounds: Rect, share = 0.9): boolean {
  return rect.w >= bounds.w * share && rect.h >= bounds.h * share;
}

/**
 * The size a window that fills the desk takes as it is dragged, the way a
 * maximized window lets go of the screen when its title bar is pulled: the
 * size it had before it was made to fill the desk, if it had one, or else
 * the size windows come out at.
 */
export function unfilledSize(restore: Rect | null, bounds: Rect): { w: number; h: number } {
  if (restore !== null && !fillsDesk(restore, bounds)) {
    const kept = clampRect(restore, bounds);
    return { w: kept.w, h: kept.h };
  }
  return windowSize(bounds);
}

/**
 * The size a window spanning the desk takes as it is dragged, so it can be
 * carried about: filling it both ways, its size from before it filled the
 * desk (unfilledSize); only its whole height (a tall half), as wide as it
 * is and as tall as windows come out; only its whole width, as tall as it
 * is and as wide as windows come out. Null: it spans neither way, and keeps
 * its size.
 */
export function letGoSize(rect: Rect, restore: Rect | null, bounds: Rect, share = 0.9): { w: number; h: number } | null {
  if (fillsDesk(rect, bounds, share)) return unfilledSize(restore, bounds);
  const size = windowSize(bounds);
  if (rect.h >= bounds.h * share) return { w: rect.w, h: size.h };
  if (rect.w >= bounds.w * share) return { w: size.w, h: rect.h };
  return null;
}

/**
 * The size a window comes to the hand at when it is taken from the desk by
 * its icon: its own, or — too big to carry, a tall half or the whole desk —
 * scaled down, its shape kept, to fit in two thirds of the desk's width and
 * four fifths of its height.
 */
export function carrySize(rect: Rect, bounds: Rect): { w: number; h: number } {
  const fit = Math.min(1, (bounds.w * 0.66) / Math.max(1, rect.w), (bounds.h * 0.8) / Math.max(1, rect.h));
  return { w: rect.w * fit, h: rect.h * fit };
}

/** A single window's comfortable size and place: centred, most of the desk. */
export function centeredRect(bounds: Rect, widthShare = 0.66, heightShare = 0.82): Rect {
  const w = Math.max(Math.min(MIN_WINDOW_W, bounds.w), Math.round(bounds.w * widthShare));
  const h = Math.max(Math.min(MIN_WINDOW_H, bounds.h), Math.round(bounds.h * heightShare));
  return clampRect({ x: bounds.x + (bounds.w - w) / 2, y: bounds.y + (bounds.h - h) / 2, w, h }, bounds);
}

/* -------------------------------- magnets -------------------------------- */

/** A line drawn where two windows have just been aligned. */
export interface Guide {
  axis: "x" | "y";
  /** The aligned coordinate (x for a vertical line). */
  at: number;
  from: number;
  to: number;
}

interface Candidate {
  value: number;
  distance: number;
  guide: Guide | null;
}

/** Two spans are near enough on the other axis for their edges to be meant to meet. */
function spansNear(a0: number, a1: number, b0: number, b1: number, slack: number): boolean {
  return a0 < b1 + slack && b0 < a1 + slack;
}

function nearest(candidates: Candidate[], threshold: number): Candidate | null {
  let best: Candidate | null = null;
  for (const candidate of candidates) {
    if (candidate.distance > threshold) continue;
    if (best === null || candidate.distance < best.distance) best = candidate;
  }
  return best;
}

/**
 * A carried window sticks: an edge that comes within `threshold` of the
 * desk's edge, or of a neighbour's edge — beside it with the desk's gap, or
 * flush with its matching edge — is pulled onto it. Only neighbours level
 * with it on the other axis count; aligning to a window across the desk
 * would be a surprise. Returns the stuck rectangle and the guides to draw.
 */
export function magnetize(
  rect: Rect,
  others: readonly Rect[],
  bounds: Rect,
  threshold = MAGNET_PX,
  gap = DESK_GAP,
): { rect: Rect; guides: Guide[] } {
  const xs: Candidate[] = [];
  const ys: Candidate[] = [];
  const addX = (value: number, guide: Guide | null): void => {
    xs.push({ value, distance: Math.abs(value - rect.x), guide });
  };
  const addY = (value: number, guide: Guide | null): void => {
    ys.push({ value, distance: Math.abs(value - rect.y), guide });
  };
  addX(bounds.x, null);
  addX(rightOf(bounds) - rect.w, null);
  addY(bounds.y, null);
  addY(bottomOf(bounds) - rect.h, null);
  for (const other of others) {
    const top = Math.min(rect.y, other.y);
    const bottom = Math.max(bottomOf(rect), bottomOf(other));
    const left = Math.min(rect.x, other.x);
    const right = Math.max(rightOf(rect), rightOf(other));
    if (spansNear(rect.y, bottomOf(rect), other.y, bottomOf(other), 48)) {
      addX(rightOf(other) + gap, { axis: "x", at: rightOf(other) + gap / 2, from: top, to: bottom });
      addX(other.x - gap - rect.w, { axis: "x", at: other.x - gap / 2, from: top, to: bottom });
      addX(other.x, { axis: "x", at: other.x, from: top, to: bottom });
      addX(rightOf(other) - rect.w, { axis: "x", at: rightOf(other), from: top, to: bottom });
    }
    if (spansNear(rect.x, rightOf(rect), other.x, rightOf(other), 48)) {
      addY(bottomOf(other) + gap, { axis: "y", at: bottomOf(other) + gap / 2, from: left, to: right });
      addY(other.y - gap - rect.h, { axis: "y", at: other.y - gap / 2, from: left, to: right });
      addY(other.y, { axis: "y", at: other.y, from: left, to: right });
      addY(bottomOf(other) - rect.h, { axis: "y", at: bottomOf(other), from: left, to: right });
    }
  }
  const x = nearest(xs, threshold);
  const y = nearest(ys, threshold);
  const guides = [x?.guide, y?.guide].filter((guide): guide is Guide => guide !== null && guide !== undefined);
  return { rect: { ...rect, x: x?.value ?? rect.x, y: y?.value ?? rect.y }, guides };
}

export interface Edges {
  left: boolean;
  right: boolean;
  top: boolean;
  bottom: boolean;
}

/**
 * A window being resized sticks the same way, but only by the edges in
 * hand: the one being dragged is pulled onto the desk's edge or a
 * neighbour's, and the opposite edge stays where it is.
 */
export function magnetizeEdges(
  rect: Rect,
  edges: Edges,
  others: readonly Rect[],
  bounds: Rect,
  threshold = MAGNET_PX,
  gap = DESK_GAP,
): Rect {
  let { x, y, w, h } = rect;
  const pick = (current: number, targets: number[]): number => {
    let best = current;
    let distance = threshold + 1;
    for (const target of targets) {
      const d = Math.abs(target - current);
      if (d <= threshold && d < distance) {
        best = target;
        distance = d;
      }
    }
    return best;
  };
  const level = others.filter((other) => spansNear(rect.y, bottomOf(rect), other.y, bottomOf(other), 48));
  const stacked = others.filter((other) => spansNear(rect.x, rightOf(rect), other.x, rightOf(other), 48));
  if (edges.left) {
    const left = pick(x, [bounds.x, ...level.flatMap((o) => [rightOf(o) + gap, o.x])]);
    w += x - left;
    x = left;
  }
  if (edges.right) {
    const right = pick(x + w, [rightOf(bounds), ...level.flatMap((o) => [o.x - gap, rightOf(o)])]);
    w = right - x;
  }
  if (edges.top) {
    const top = pick(y, [bounds.y, ...stacked.flatMap((o) => [bottomOf(o) + gap, o.y])]);
    h += y - top;
    y = top;
  }
  if (edges.bottom) {
    const bottom = pick(y + h, [bottomOf(bounds), ...stacked.flatMap((o) => [o.y - gap, bottomOf(o)])]);
    h = bottom - y;
  }
  return { x, y, w, h };
}

/**
 * The rectangle a resize gesture makes: `start` with the edges in hand
 * moved by the pointer's travel, never smaller than a window may be (the
 * opposite edge holds still), never outside `bounds`.
 */
export function resizedRect(start: Rect, edges: Edges, dx: number, dy: number, bounds: Rect): Rect {
  const minW = Math.min(MIN_WINDOW_W, bounds.w);
  const minH = Math.min(MIN_WINDOW_H, bounds.h);
  let left = start.x;
  let right = rightOf(start);
  let top = start.y;
  let bottom = bottomOf(start);
  if (edges.left) left = Math.min(right - minW, Math.max(bounds.x, start.x + dx));
  if (edges.right) right = Math.max(left + minW, Math.min(rightOf(bounds), rightOf(start) + dx));
  if (edges.top) top = Math.min(bottom - minH, Math.max(bounds.y, start.y + dy));
  if (edges.bottom) bottom = Math.max(top + minH, Math.min(bottomOf(bounds), bottomOf(start) + dy));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/* --------------------------------- seams --------------------------------- */

/**
 * How far from the desk's gap two windows may stand and still meet across
 * it: rounding, and a desk resized a little since they were put there.
 * Nearer or further apart (flush, overlapping, or just near), they are two
 * windows, not a split.
 */
export const SEAM_SLACK = 2;

/**
 * Windows that meet across one gutter, as the panes of a split view do: on
 * an "x" seam those `before` it end at its left side and those `after` it
 * begin at its right; on a "y" seam, above it and below. Its gutter dragged,
 * every window on it gives or takes the same, and the gutter stays a gutter.
 */
export interface Seam {
  axis: "x" | "y";
  before: string[];
  after: string[];
}

const startOn = (rect: Rect, axis: "x" | "y"): number => (axis === "x" ? rect.x : rect.y);
const endOn = (rect: Rect, axis: "x" | "y"): number => (axis === "x" ? rightOf(rect) : bottomOf(rect));
/** Where a rectangle runs along a seam's line: its span on the other axis. */
const spanAlong = (rect: Rect, axis: "x" | "y"): [number, number] => (axis === "x" ? [rect.y, bottomOf(rect)] : [rect.x, rightOf(rect)]);

/** `a` ends the desk's gap short of where `b` begins, and the two run side by side for some of the way. */
function meetsAcross(a: Rect, b: Rect, axis: "x" | "y", gap: number): boolean {
  if (Math.abs(startOn(b, axis) - endOn(a, axis) - gap) > SEAM_SLACK) return false;
  const [a0, a1] = spanAlong(a, axis);
  const [b0, b1] = spanAlong(b, axis);
  return Math.min(a1, b1) - Math.max(a0, b0) > 1;
}

/** A seam as it is found: its sides, and where its gutter begins (the end of the windows before it). */
interface SeamFound {
  axis: "x" | "y";
  line: number;
  before: Set<string>;
  after: Set<string>;
}

/** Every window that meets one already on the seam across its gutter, on either side: moved without them, the gutter would close on them, or open. */
function spreadSeam(seam: SeamFound, rects: ReadonlyMap<string, Rect>, gap: number): void {
  const { axis, line, before, after } = seam;
  for (let grew = true; grew; ) {
    grew = false;
    for (const [id, rect] of rects) {
      if (before.has(id) || after.has(id)) continue;
      if (Math.abs(startOn(rect, axis) - line - gap) <= SEAM_SLACK && [...before].some((other) => meetsAcross(rects.get(other)!, rect, axis, gap))) {
        after.add(id);
        grew = true;
      } else if (Math.abs(endOn(rect, axis) - line) <= SEAM_SLACK && [...after].some((other) => meetsAcross(rect, rects.get(other)!, axis, gap))) {
        before.add(id);
        grew = true;
      }
    }
  }
}

/**
 * The seam a press on one of a window's edges takes hold of — `side` is the
 * window's side of it — if another window meets it across the gutter there,
 * beside the pointer (`along`: where the pointer is along the gutter, which
 * runs as far as the two run side by side, give or take its own width).
 */
function seamFrom(rects: ReadonlyMap<string, Rect>, id: string, axis: "x" | "y", side: "before" | "after", along: number, gap: number): SeamFound | null {
  const rect = rects.get(id);
  if (rect === undefined) return null;
  const [r0, r1] = spanAlong(rect, axis);
  const across = [...rects].find(([other, candidate]) => {
    if (other === id || !(side === "before" ? meetsAcross(rect, candidate, axis, gap) : meetsAcross(candidate, rect, axis, gap))) return false;
    const [c0, c1] = spanAlong(candidate, axis);
    return along >= Math.max(r0, c0) - gap && along <= Math.min(r1, c1) + gap;
  });
  if (across === undefined) return null;
  const seam: SeamFound = {
    axis,
    line: side === "before" ? endOn(rect, axis) : startOn(rect, axis) - gap,
    before: new Set(side === "before" ? [id] : [across[0]]),
    after: new Set(side === "before" ? [across[0]] : [id]),
  };
  spreadSeam(seam, rects, gap);
  return seam;
}

/** A window of `from` cornered where its gutter crosses `to`'s (one of its edges on `to`'s line) joins `to`, with whatever meets it there. True if any did. */
function joinAtCrossing(to: SeamFound, from: SeamFound, rects: ReadonlyMap<string, Rect>, gap: number): boolean {
  let joined = false;
  for (const id of [...from.before, ...from.after]) {
    if (to.before.has(id) || to.after.has(id)) continue;
    const rect = rects.get(id)!;
    if (Math.abs(endOn(rect, to.axis) - to.line) <= SEAM_SLACK) to.before.add(id);
    else if (Math.abs(startOn(rect, to.axis) - to.line - gap) <= SEAM_SLACK) to.after.add(id);
    else continue;
    joined = true;
  }
  if (joined) spreadSeam(to, rects, gap);
  return joined;
}

/**
 * The seams a press on a window's edge or corner (`edges`, at `at`) takes
 * hold of, among `rects` (the windows that may be on one, by id): the
 * gutter beside that edge where another window meets the window across the
 * desk's gap, as the panes of a split view meet — with every window on that
 * gutter, so nothing on it comes to overlap or leaves it. A corner takes
 * hold of both its gutters; where they cross (three or four windows
 * cornered there, as in a grid), each takes in the windows cornered there
 * on the other, so the crossing moves as one. Null for an edge nothing
 * meets the window across: that edge is the window's alone.
 */
export function seamsAt(rects: ReadonlyMap<string, Rect>, id: string, edges: Edges, at: Point, gap = DESK_GAP): { x: Seam | null; y: Seam | null } {
  const x = edges.left || edges.right ? seamFrom(rects, id, "x", edges.right ? "before" : "after", at.y, gap) : null;
  const y = edges.top || edges.bottom ? seamFrom(rects, id, "y", edges.bottom ? "before" : "after", at.x, gap) : null;
  if (x !== null && y !== null) {
    for (let grew = true; grew; ) grew = joinAtCrossing(x, y, rects, gap) || joinAtCrossing(y, x, rects, gap);
  }
  const done = (seam: SeamFound | null): Seam | null => (seam === null ? null : { axis: seam.axis, before: [...seam.before], after: [...seam.after] });
  return { x: done(x), y: done(y) };
}

/**
 * How far a seam's gutter goes for `travel` px of the pointer: no further
 * than leaves every window on it as large as a window may be (or, smaller
 * already, as large as it is), and on the way it sticks to the edges of
 * windows not on it (`others`) that run along it — another gutter's, say,
 * so two gutters of a grid can be lined up again.
 */
export function seamTravel(
  rects: ReadonlyMap<string, Rect>,
  seam: Seam,
  travel: number,
  others: readonly Rect[],
  min: MinSize = WINDOW_MIN,
  threshold = MAGNET_PX,
  gap = DESK_GAP,
): number {
  const { axis } = seam;
  const least = axis === "x" ? min.w : min.h;
  const size = (id: string): number => {
    const rect = rects.get(id)!;
    return axis === "x" ? rect.w : rect.h;
  };
  // Those before it narrow as it goes back, those after it as it goes on: each
  // side's smallest window says how far (and one under its least size, not at all).
  const lo = Math.min(0, Math.max(...seam.before.map((id) => least - size(id))));
  const hi = Math.max(0, Math.min(...seam.after.map((id) => size(id) - least)));
  const taken = Math.min(hi, Math.max(lo, travel));
  const members = [...seam.before, ...seam.after].map((id) => rects.get(id)!);
  const from = Math.min(...members.map((rect) => spanAlong(rect, axis)[0]));
  const to = Math.max(...members.map((rect) => spanAlong(rect, axis)[1]));
  const line = endOn(rects.get(seam.before[0]!)!, axis);
  let best = taken;
  let distance = threshold + 1;
  for (const other of others) {
    const [o0, o1] = spanAlong(other, axis);
    if (!spansNear(from, to, o0, o1, 48)) continue;
    // The windows before it end where the other ends, or those after it begin where it begins.
    for (const target of [endOn(other, axis) - line, startOn(other, axis) - gap - line]) {
      const d = Math.abs(target - taken);
      if (target >= lo && target <= hi && d <= threshold && d < distance) {
        best = target;
        distance = d;
      }
    }
  }
  return best;
}

/** A window with a seam's gutter moved by `travel`: one before it ends that much further on, one after it begins there; any other is as it was. */
export function alongSeam(rect: Rect, seam: Seam, id: string, travel: number): Rect {
  if (seam.before.includes(id)) return seam.axis === "x" ? { ...rect, w: rect.w + travel } : { ...rect, h: rect.h + travel };
  if (seam.after.includes(id)) return seam.axis === "x" ? { ...rect, x: rect.x + travel, w: rect.w - travel } : { ...rect, y: rect.y + travel, h: rect.h - travel };
  return rect;
}

/**
 * A mask's region being edited, in its page's box: the edges in hand moved
 * by the pointer's travel (`edges` null: the whole region moved), the
 * opposite edges holding still, never smaller than `min` either way, never
 * off the page.
 */
export function editedMaskRegion(start: Rect, edges: Edges | null, dx: number, dy: number, page: { w: number; h: number }, min: number): Rect {
  if (edges === null) {
    return {
      ...start,
      x: Math.min(page.w - start.w, Math.max(0, start.x + dx)),
      y: Math.min(page.h - start.h, Math.max(0, start.y + dy)),
    };
  }
  let left = start.x;
  let right = rightOf(start);
  let top = start.y;
  let bottom = bottomOf(start);
  if (edges.left) left = Math.min(right - min, Math.max(0, start.x + dx));
  if (edges.right) right = Math.max(left + min, Math.min(page.w, rightOf(start) + dx));
  if (edges.top) top = Math.min(bottom - min, Math.max(0, start.y + dy));
  if (edges.bottom) bottom = Math.max(top + min, Math.min(page.h, bottomOf(start) + dy));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/**
 * A resize that keeps the content's shape, as a picture is resized — a
 * masked window, whose region is a picture of part of its page. The content
 * is the window less a header `top` px tall. Whichever edge the pointer holds
 * sets the scale (at a corner, the one it has moved more); the edge or
 * corner opposite holds still — for a side edge, the top or left too — and
 * the scale stops where the content's shorter side would pass `minContent`,
 * or the window would pass `bounds`.
 */
export function resizedKeepingAspect(start: Rect, edges: Edges, dx: number, dy: number, bounds: Rect, top: number, minContent: number): Rect {
  const cw = Math.max(1, start.w);
  const ch = Math.max(1, start.h - top);
  const horizontal = edges.left || edges.right;
  const vertical = edges.top || edges.bottom;
  const sx = horizontal ? (cw + (edges.right ? dx : -dx)) / cw : null;
  const sy = vertical ? (ch + (edges.bottom ? dy : -dy)) / ch : null;
  let scale = sx !== null && sy !== null ? (Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy) : (sx ?? sy ?? 1);
  const right = rightOf(start);
  const bottom = bottomOf(start);
  const roomW = edges.left ? right - bounds.x : rightOf(bounds) - start.x;
  const roomH = (edges.top ? bottom - bounds.y : bottomOf(bounds) - start.y) - top;
  const most = Math.max(0, Math.min(roomW / cw, roomH / ch));
  const least = Math.min(most, minContent / Math.min(cw, ch));
  scale = Math.min(most, Math.max(least, scale));
  const w = cw * scale;
  const h = ch * scale + top;
  return { x: edges.left ? right - w : start.x, y: edges.top ? bottom - h : start.y, w, h };
}

/* -------------------------------- layouts -------------------------------- */

/**
 * `count` windows tiled over the desk: one fills it, two share it side by
 * side, three put one on the left and stack two on the right, and more
 * fill a grid whose last row spreads across the width.
 */
export function tileRects(count: number, bounds: Rect, gap = DESK_GAP): Rect[] {
  if (count <= 0) return [];
  if (count === 1) return [{ ...bounds }];
  if (count === 2) return [zoneRect("left", bounds, gap), zoneRect("right", bounds, gap)];
  if (count === 3) return [zoneRect("left", bounds, gap), zoneRect("top-right", bounds, gap), zoneRect("bottom-right", bounds, gap)];
  const aspect = bounds.w / Math.max(1, bounds.h);
  const columns = Math.max(2, Math.round(Math.sqrt(count * aspect * 0.8)));
  const rows = Math.ceil(count / columns);
  const cellH = (bounds.h - gap * (rows - 1)) / rows;
  const rects: Rect[] = [];
  for (let row = 0; row < rows; row += 1) {
    const inRow = Math.min(columns, count - row * columns);
    const cellW = (bounds.w - gap * (inRow - 1)) / inRow;
    for (let column = 0; column < inRow; column += 1)
      rects.push({ x: bounds.x + column * (cellW + gap), y: bounds.y + row * (cellH + gap), w: cellW, h: cellH });
  }
  return rects;
}

/** `count` windows fanned from the top left, each a step down and right of the last. */
export function cascadeRects(count: number, bounds: Rect, step = 32): Rect[] {
  if (count <= 0) return [];
  const span = step * (count - 1);
  const w = Math.max(Math.min(MIN_WINDOW_W, bounds.w), Math.min(bounds.w - span, Math.round(bounds.w * 0.62)));
  const h = Math.max(Math.min(MIN_WINDOW_H, bounds.h), Math.min(bounds.h - span, Math.round(bounds.h * 0.74)));
  const originX = bounds.x + Math.max(0, (bounds.w - w - span) / 2);
  const originY = bounds.y + Math.max(0, (bounds.h - h - span) / 2);
  return Array.from({ length: count }, (_, index) =>
    clampRect({ x: originX + index * step, y: originY + index * step, w, h }, bounds),
  );
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(rightOf(a), rightOf(b)) - Math.max(a.x, b.x);
  const h = Math.min(bottomOf(a), bottomOf(b)) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Where a window of `size` covers the least of the windows already out —
 * nothing at all when there is room — nearest the centre among equals.
 */
export function freeSpot(existing: readonly Rect[], size: { w: number; h: number }, bounds: Rect, step = 24): Rect {
  const w = Math.min(size.w, bounds.w);
  const h = Math.min(size.h, bounds.h);
  const center = centerOf(bounds);
  let best: Rect = clampRect({ x: center.x - w / 2, y: center.y - h / 2, w, h }, bounds);
  let bestCost = Number.POSITIVE_INFINITY;
  const xs = Math.max(0, Math.floor((bounds.w - w) / step));
  const ys = Math.max(0, Math.floor((bounds.h - h) / step));
  for (let i = 0; i <= xs; i += 1) {
    for (let j = 0; j <= ys; j += 1) {
      const candidate = {
        x: xs === 0 ? bounds.x + (bounds.w - w) / 2 : bounds.x + ((bounds.w - w) * i) / xs,
        y: ys === 0 ? bounds.y + (bounds.h - h) / 2 : bounds.y + ((bounds.h - h) * j) / ys,
        w,
        h,
      };
      const covered = existing.reduce((sum, other) => sum + overlapArea(candidate, other), 0);
      const middle = centerOf(candidate);
      // Overlap dominates; distance from the centre only breaks ties.
      const cost = covered * 1_000 + Math.hypot(middle.x - center.x, middle.y - center.y);
      if (cost < bestCost) {
        bestCost = cost;
        best = candidate;
      }
    }
  }
  return best;
}

/* ------------------------- where a new window goes ------------------------- */

/** Room worth putting a window in: a fair share of the desk each way, and never less than a window may be. */
export function roomy(rect: Rect, bounds: Rect): boolean {
  return rect.w >= Math.max(Math.min(MIN_WINDOW_W, bounds.w), bounds.w * 0.25) && rect.h >= Math.max(Math.min(MIN_WINDOW_H, bounds.h), bounds.h * 0.3);
}

/**
 * The biggest rectangle of the desk that no window is in, keeping the gap
 * from each — the hole a tiled desk has left — or null when there is none.
 * Between two of nearly the same size, the taller: side by side is how
 * pages are read.
 */
export function largestEmptyRect(existing: readonly Rect[], bounds: Rect, gap = DESK_GAP): Rect | null {
  const lines = new Set<number>([bounds.x, rightOf(bounds)]);
  for (const rect of existing) {
    for (const x of [rect.x - gap, rightOf(rect) + gap]) if (x > bounds.x && x < rightOf(bounds)) lines.add(x);
  }
  const xs = [...lines].sort((a, b) => a - b);
  let best: Rect | null = null;
  const consider = (candidate: Rect): void => {
    if (candidate.w <= 0 || candidate.h <= 0) return;
    const area = candidate.w * candidate.h;
    const bestArea = best === null ? 0 : best.w * best.h;
    if (area > bestArea * 1.01 || (best !== null && area >= bestArea * 0.99 && candidate.h > best.h)) best = candidate;
  };
  for (let i = 0; i < xs.length; i += 1) {
    for (let j = i + 1; j < xs.length; j += 1) {
      const left = xs[i]!;
      const right = xs[j]!;
      // The windows across this band, each the stretch of it they block.
      const blocked = existing
        .filter((rect) => rect.x - gap < right && rightOf(rect) + gap > left)
        .map((rect) => [rect.y - gap, bottomOf(rect) + gap] as const)
        .sort((a, b) => a[0] - b[0]);
      let top = bounds.y;
      for (const [from, to] of blocked) {
        if (from > top) consider({ x: left, y: top, w: right - left, h: Math.min(from, bottomOf(bounds)) - top });
        top = Math.max(top, to);
      }
      if (top < bottomOf(bounds)) consider({ x: left, y: top, w: right - left, h: bottomOf(bounds) - top });
    }
  }
  return best;
}

/**
 * A window placed as a tile: it lies along two of the desk's edges (a
 * half, a quarter, the whole desk) or is a cell of a tiled arrangement.
 */
export function isTile(rect: Rect, bounds: Rect, epsilon = 2): boolean {
  const edges = [
    Math.abs(rect.x - bounds.x) <= epsilon,
    Math.abs(rightOf(rect) - rightOf(bounds)) <= epsilon,
    Math.abs(rect.y - bounds.y) <= epsilon,
    Math.abs(bottomOf(rect) - bottomOf(bounds)) <= epsilon,
  ].filter(Boolean).length;
  if (edges >= 2) return true;
  for (let count = 4; count <= 12; count += 1) if (tileRects(count, bounds).some((tile) => sameRect(tile, rect, epsilon))) return true;
  return false;
}

/** A window cut in two along its longer side, the gap between — or null when a half would be smaller than a window may be. */
export function splitRect(rect: Rect, gap = DESK_GAP): [Rect, Rect] | null {
  if (rect.w >= rect.h) {
    const w = (rect.w - gap) / 2;
    if (w < MIN_WINDOW_W) return null;
    return [
      { ...rect, w },
      { ...rect, x: rect.x + w + gap, w },
    ];
  }
  const h = (rect.h - gap) / 2;
  if (h < MIN_WINDOW_H) return null;
  return [
    { ...rect, h },
    { ...rect, y: rect.y + h + gap, h },
  ];
}

/** Where a tab brought out of the dock goes: its window's box, and a window already out that gives up half of its own for it. */
export interface Placement {
  rect: Rect;
  split: { index: number; rect: Rect } | null;
  /** How: the desk's first window, a tiled desk's hole, half of a window's place (`split`), or a free spot over the others. */
  kind: "first" | "hole" | "split" | "free";
}

/**
 * Where a window brought out onto the desk goes, read from how the desk is
 * laid out now:
 *
 * - an empty desk: a comfortable window in the middle;
 * - a TILED desk (every window a tile, none overlapping): the hole it has
 *   left, if that is room enough — beside a half, the other half; with
 *   three quarters out, the fourth — and if there is no such hole, the
 *   window in use (`inUse`, an index into `existing`) splits in two along
 *   its longer side and gives the new one its second half, so the desk
 *   stays tiled;
 * - windows set down freely: the size windows come out at, where it
 *   covers the least of them.
 */
export function placeNewWindow(existing: readonly Rect[], bounds: Rect, inUse: number | null, gap = DESK_GAP): Placement {
  if (existing.length === 0) return { rect: centeredRect(bounds), split: null, kind: "first" };
  const overlapping = existing.some((rect, index) => existing.some((other, later) => later > index && rectsOverlap(rect, other)));
  const tiled = !overlapping && existing.every((rect) => isTile(rect, bounds));
  if (tiled) {
    const hole = largestEmptyRect(existing, bounds, gap);
    if (hole !== null && roomy(hole, bounds)) return { rect: hole, split: null, kind: "hole" };
    const order = existing.map((_, index) => index).sort((a, b) => existing[b]!.w * existing[b]!.h - existing[a]!.w * existing[a]!.h);
    for (const index of inUse !== null && existing[inUse] !== undefined ? [inUse, ...order] : order) {
      const halves = splitRect(existing[index]!, gap);
      if (halves !== null) return { rect: halves[1], split: { index, rect: halves[0] }, kind: "split" };
    }
  }
  return { rect: freeSpot(existing, windowSize(bounds), bounds), split: null, kind: "free" };
}

/**
 * The Bar's nub as it is drawn now (the engine's setNotchShape): a droplet
 * of the shell's ground in the desk's trailing foot corner — a circle
 * `radius` round, its centre `sink` in from both edges, so it is partly sunk
 * into the corner, joined to each edge by a fillet `fillet` round. Where it
 * lies is the stage's own corner, wherever that is.
 */
export interface NotchShape {
  radius: number;
  sink: number;
  fillet: number;
}

/**
 * The nub at rest, and swelled under the pointer: the circle larger and
 * drawn further out of the corner, as if pulled from it — its fillets
 * tightening as it goes, so where it meets the edges reaches no further
 * along them (2026-10-08, the user's call: the circle grows, not the joins).
 */
export const NUB_IDLE: NotchShape = { radius: 18, sink: 20, fillet: 11 };
export const NUB_SWELL: NotchShape = { radius: 22, sink: 27, fillet: 6 };

/** A nub `t` of the way from one shape to another (past 1 as a spring overshoots). */
export function nubBetween(from: NotchShape, to: NotchShape, t: number): NotchShape {
  return {
    radius: from.radius + (to.radius - from.radius) * t,
    sink: from.sink + (to.sink - from.sink) * t,
    fillet: from.fillet + (to.fillet - from.fillet) * t,
  };
}

/** How far from the corner the nub reaches along each edge: where its fillets leave the foot and the trailing edge. */
export function nubReach(shape: NotchShape): number {
  const { radius: r, sink: a, fillet: f } = shape;
  return a + Math.sqrt(Math.max(0, (r + f) ** 2 - (a - f) ** 2));
}

/** How far from the corner anything of the nub reaches, along each edge or out across the desk: the box it fills. */
export function nubExtent(shape: NotchShape): number {
  return Math.max(nubReach(shape), shape.sink + shape.radius);
}

/** Where the nub's face sits, from the corner: the middle of what shows of the circle, a hair up and in from its centre. */
export function nubFace(shape: NotchShape): Point {
  const k = shape.sink + 1;
  return { x: -k, y: -k };
}

/**
 * The nub's outline, its corner at (x, y) — the stage's trailing foot —
 * offset by (dx, dy): out of the foot at one fillet, round the far side of
 * the circle, into the trailing edge at the other fillet, down that edge and
 * round the stage's own corner (`corner`, its radius) back along the foot.
 * So it holds the whole corner, and nothing past the stage's curve: a window
 * filling the desk is rounded there as the desk is, and the hole matches it.
 * The notch view over a live page (NotchApp) is cut to the same outline.
 */
export function nubOutline(shape: NotchShape, x: number, y: number, corner: number, dx: number, dy: number): string {
  const n = (value: number): string => value.toFixed(2);
  const { radius: r, sink: a, fillet: f } = shape;
  const ex = x + dx;
  const ey = y + dy;
  const cx = ex - a;
  const cy = ey - a;
  const d = Math.sqrt(Math.max(0, (r + f) ** 2 - (a - f) ** 2));
  // The fillets' centres: one on the foot, one on the trailing edge, each just touching the circle.
  const foot = { x: cx - d, y: ey - f };
  const side = { x: ex - f, y: cy - d };
  const k = r / (r + f);
  const t1 = { x: cx + (foot.x - cx) * k, y: cy + (foot.y - cy) * k };
  const t2 = { x: cx + (side.x - cx) * k, y: cy + (side.y - cy) * k };
  // Round the circle's far side, clockwise on screen; the long way when the fillets meet it past its middle.
  const span = (Math.atan2(t2.y - cy, t2.x - cx) - Math.atan2(t1.y - cy, t1.x - cx) + Math.PI * 4) % (Math.PI * 2);
  const c = Math.max(0, Math.min(corner, a + d - f - 1));
  return [
    `M ${n(foot.x)} ${n(ey)}`,
    `A ${n(f)} ${n(f)} 0 0 0 ${n(t1.x)} ${n(t1.y)}`,
    `A ${n(r)} ${n(r)} 0 ${span > Math.PI ? 1 : 0} 1 ${n(t2.x)} ${n(t2.y)}`,
    `A ${n(f)} ${n(f)} 0 0 0 ${n(ex)} ${n(side.y)}`,
    `V ${n(ey - c)}`,
    c > 0 ? `A ${n(c)} ${n(c)} 0 0 1 ${n(ex - c)} ${n(ey)}` : `V ${n(ey)}`,
    "Z",
  ].join(" ");
}

/**
 * The nub's menu (DeskBar). Out, the nub lets go of the desk's edges: it is
 * a button of its own, a circle NUB_DROP_R round standing NUB_FREE_GAP clear
 * of the foot and the trailing edge (NUB_FREE: no fillets, and nothing of it
 * in the corner), its mark the menu's close. Its three droplets, as round as
 * it, fan out from it over the quarter the desk lies in — the prompt along
 * the foot, the microphone between, past chats up the trailing edge — each
 * NUB_FAN_R from its centre.
 */
export const NUB_DROP_R = 20;
export const NUB_FREE_GAP = 8;
export const NUB_FREE: NotchShape = { radius: NUB_DROP_R, sink: NUB_DROP_R + NUB_FREE_GAP, fillet: 0 };
export const NUB_FAN_R = 70;
/** The droplets' bearings from the nub's centre, in degrees (anticlockwise from the foot's way left: 180° is left, 90° up). */
const NUB_FAN_DEG = [180, 135, 90] as const;

/** The droplets' centres where they rest, from the corner. */
export function nubDrops(): Point[] {
  const c = -NUB_FREE.sink;
  return NUB_FAN_DEG.map((deg) => {
    const a = (deg * Math.PI) / 180;
    return { x: c + Math.cos(a) * NUB_FAN_R, y: c - Math.sin(a) * NUB_FAN_R };
  });
}

/**
 * The pill's close (DeskBar): while the pill is out, a small round button
 * stands above the nub, up the trailing edge where the menu's droplets once
 * stood in a column — NUB_CLOSE_R round, NUB_CLOSE_INSET in from the edge
 * and NUB_CLOSE_GAP above all the nub may fill swelled. Its centre, from the
 * corner.
 */
export const NUB_CLOSE_R = 16;
const NUB_CLOSE_INSET = 6;
const NUB_CLOSE_GAP = 8;

export function nubClose(): Point {
  return { x: -(NUB_CLOSE_INSET + NUB_CLOSE_R), y: -(nubExtent(NUB_SWELL) + NUB_CLOSE_GAP + NUB_CLOSE_R) };
}

/**
 * The nub as it lets go of the desk's edges for its menu, `t` of the way
 * (0 in the corner, 1 free): what is left of it in the corner — its hole,
 * and what is painted over the hole — drains into the corner and is gone
 * by 0.6 (null once it is), while the circle itself (`button`) lifts out
 * to where it stands free, past it a moment as a spring overshoots.
 */
export function nubLetGo(shape: NotchShape, t: number): { corner: NotchShape | null; button: NotchShape } {
  const left = 1 - Math.min(1, Math.max(0, t) / 0.6) ** 1.5;
  const corner = left < 0.01 ? null : { radius: shape.radius * left, sink: shape.sink * left, fillet: shape.fillet * left };
  return { corner, button: nubBetween(shape, NUB_FREE, t) };
}

/** A box's corner radii, from its top-left round (0: square). */
export interface CornerRadii {
  tl: number;
  tr: number;
  br: number;
  bl: number;
}

/** A box from (x0, y0) to (x1, y1) as an SVG path, clockwise, its corners rounded as given. */
export function roundedRectPath(x0: number, y0: number, x1: number, y1: number, radii: CornerRadii): string {
  const n = (value: number): string => value.toFixed(1);
  const arc = (r: number, x: number, y: number): string => (r > 0 ? ` A ${n(r)} ${n(r)} 0 0 1 ${n(x)} ${n(y)}` : "");
  return (
    `M ${n(x0 + radii.tl)} ${n(y0)} H ${n(x1 - radii.tr)}${arc(radii.tr, x1, y0 + radii.tr)}` +
    ` V ${n(y1 - radii.br)}${arc(radii.br, x1 - radii.br, y1)}` +
    ` H ${n(x0 + radii.bl)}${arc(radii.bl, x0, y1 - radii.bl)}` +
    ` V ${n(y0 + radii.tl)}${arc(radii.tl, x0 + radii.tl, y0)} Z`
  );
}

