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

/** No larger than `bounds` (nor smaller than a window may be, room permitting), and wholly inside it. */
export function clampRect(rect: Rect, bounds: Rect): Rect {
  const w = Math.min(bounds.w, Math.max(Math.min(MIN_WINDOW_W, bounds.w), rect.w));
  const h = Math.min(bounds.h, Math.max(Math.min(MIN_WINDOW_H, bounds.h), rect.h));
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
export function rubberBandRect(rect: Rect, bounds: Rect, limit: number): Rect {
  const inside = clampRect(rect, bounds);
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
 * ends of an edge are the quarters in that corner.
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

/**
 * Where a THROWN window lands when every throw lands in a tile: the desk in
 * thirds, read at the point the throw would carry the pointer to. The
 * corners are quarters, the sides halves, the top middle the whole desk,
 * and the middle and bottom middle a comfortable window in the centre.
 */
export function thirdsZone(point: Point, bounds: Rect): SnapZone | "center" {
  const fx = (point.x - bounds.x) / Math.max(1, bounds.w);
  const fy = (point.y - bounds.y) / Math.max(1, bounds.h);
  const column = fx < 1 / 3 ? 0 : fx > 2 / 3 ? 2 : 1;
  const row = fy < 1 / 3 ? 0 : fy > 2 / 3 ? 2 : 1;
  const grid: ReadonlyArray<ReadonlyArray<SnapZone | "center">> = [
    ["top-left", "maximize", "top-right"],
    ["left", "center", "right"],
    ["bottom-left", "center", "bottom-right"],
  ];
  return grid[row]![column]!;
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
