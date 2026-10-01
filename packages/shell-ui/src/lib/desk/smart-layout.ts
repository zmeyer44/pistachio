/**
 * The desk's smart layout, the geometry half (docs/desk-layout.md): which
 * moves the desk can make now, the words the layout model reads for where
 * each window is, and — once the model has given its opinion and
 * `decideDeskLayout` has chosen — where every window goes.
 *
 * The model names a move and, for some, a window; it never says where
 * anything goes. Every rectangle here comes from the desk's own rules: a
 * gap closed up as a split view closes a pane (the seams' gutter kept), the
 * desk tiled, one window given the main place, a new window set beside the
 * one it goes with.
 *
 * Pure on purpose — no DOM, no engine — so vitest pins it under node.
 */

import type { DeskLayoutMove } from "@pistachio/shell-contracts/desk-layout";
import {
  bottomOf,
  centerOf,
  DESK_GAP,
  fillsDesk,
  MIN_WINDOW_H,
  MIN_WINDOW_W,
  rectsOverlap,
  rightOf,
  sameRect,
  SEAM_SLACK,
  splitRect,
  tileRects,
  zoneRect,
  type Rect,
} from "./geometry";

/** The share of the desk's width the main window takes (focus). */
export const FOCUS_SHARE = 0.62;

/* --------------------------------- words --------------------------------- */

const ZONE_WORDS: ReadonlyArray<[Parameters<typeof zoneRect>[0], string]> = [
  ["left", "the left half of the desk"],
  ["right", "the right half of the desk"],
  ["top-left", "the top-left quarter of the desk"],
  ["top-right", "the top-right quarter of the desk"],
  ["bottom-left", "the bottom-left quarter of the desk"],
  ["bottom-right", "the bottom-right quarter of the desk"],
];

/**
 * Where a window is, in the words the model reads: the whole desk, a half or
 * a quarter by name, or a size and a part of the desk ("a small window at
 * the top right"), overlapping others if it does.
 */
export function placeWords(rect: Rect, bounds: Rect, others: readonly Rect[] = []): string {
  if (fillsDesk(rect, bounds)) return "the whole desk";
  const near = (other: Rect): boolean => sameRect(rect, other, Math.max(12, bounds.w * 0.02));
  for (const [zone, words] of ZONE_WORDS) if (near(zoneRect(zone, bounds))) return words;
  const halfH = (bounds.h - DESK_GAP) / 2;
  if (near({ x: bounds.x, y: bounds.y, w: bounds.w, h: halfH })) return "the top half of the desk";
  if (near({ x: bounds.x, y: bounds.y + halfH + DESK_GAP, w: bounds.w, h: halfH })) return "the bottom half of the desk";
  const share = (rect.w * rect.h) / Math.max(1, bounds.w * bounds.h);
  const size = share >= 0.45 ? "a large window" : share >= 0.18 ? "a medium window" : "a small window";
  const center = centerOf(rect);
  const across = (center.x - bounds.x) / Math.max(1, bounds.w);
  const down = (center.y - bounds.y) / Math.max(1, bounds.h);
  const column = across < 1 / 3 ? "left" : across > 2 / 3 ? "right" : "";
  const row = down < 1 / 3 ? "top" : down > 2 / 3 ? "bottom" : "";
  const part = row === "" && column === "" ? "in the middle of the desk" : row === "" ? `on the ${column}` : column === "" ? `at the ${row}` : `at the ${row} ${column}`;
  const overlapping = others.some((other) => rectsOverlap(rect, other)) ? ", overlapping others" : "";
  return `${size} ${part}${overlapping}`;
}

/* ---------------------------------- moves --------------------------------- */

/**
 * The windows beside a gap that can grow into it exactly, and the boxes they
 * grow to — as the other pane of a split view takes a closed pane's place.
 * A side qualifies when the windows along it are each a gutter from the gap,
 * lie within its span, and together (a gutter apart) cover the whole of it;
 * of those, the side with the fewest windows (a single window over a row of
 * them), the side ones before top and bottom. Null when no side can: the
 * windows lay loose around it.
 */
export function fillGap(windows: ReadonlyMap<string, Rect>, gap: Rect, gutter = DESK_GAP): Map<string, Rect> | null {
  type Side = "left" | "right" | "top" | "bottom";
  const along = (side: Side) => (side === "left" || side === "right" ? ([gap.y, bottomOf(gap)] as const) : ([gap.x, rightOf(gap)] as const));
  const span = (rect: Rect, side: Side): [number, number] => (side === "left" || side === "right" ? [rect.y, bottomOf(rect)] : [rect.x, rightOf(rect)]);
  const beside = (rect: Rect, side: Side): boolean => {
    const off =
      side === "left" ? gap.x - rightOf(rect) : side === "right" ? rect.x - rightOf(gap) : side === "top" ? gap.y - bottomOf(rect) : rect.y - bottomOf(gap);
    return Math.abs(off - gutter) <= SEAM_SLACK;
  };
  let best: { side: Side; ids: string[] } | null = null;
  for (const side of ["left", "right", "top", "bottom"] as const) {
    const [from, to] = along(side);
    const ids = [...windows]
      .filter(([, rect]) => {
        if (!beside(rect, side)) return false;
        const [a, b] = span(rect, side);
        return Math.min(b, to) - Math.max(a, from) > 1;
      })
      .sort((a, b) => span(a[1], side)[0] - span(b[1], side)[0])
      .map(([id]) => id);
    if (ids.length === 0) continue;
    // They cover the gap's span exactly, end to end, a gutter apart, none reaching past it.
    let at = from;
    let covers = true;
    for (const [index, id] of ids.entries()) {
      const [a, b] = span(windows.get(id)!, side);
      if (Math.abs(a - (index === 0 ? from : at + gutter)) > SEAM_SLACK) covers = false;
      at = b;
    }
    if (!covers || Math.abs(at - to) > SEAM_SLACK) continue;
    if (best === null || ids.length < best.ids.length) best = { side, ids };
  }
  if (best === null) return null;
  const grown = new Map<string, Rect>();
  for (const id of best.ids) {
    const rect = windows.get(id)!;
    grown.set(
      id,
      best.side === "left"
        ? { ...rect, w: rightOf(gap) - rect.x }
        : best.side === "right"
          ? { ...rect, x: gap.x, w: rightOf(rect) - gap.x }
          : best.side === "top"
            ? { ...rect, h: bottomOf(gap) - rect.y }
            : { ...rect, y: gap.y, h: bottomOf(rect) - gap.y },
    );
  }
  return grown;
}

/** Every gap closed in turn (fillGap), each with the desk as the last left it. Null when none could be. */
export function fillGaps(windows: ReadonlyMap<string, Rect>, gaps: readonly Rect[]): Map<string, Rect> | null {
  const layout = new Map(windows);
  let filled = false;
  for (const gap of gaps) {
    const grown = fillGap(layout, gap);
    if (grown === null) continue;
    for (const [id, rect] of grown) layout.set(id, rect);
    filled = true;
  }
  return filled ? layout : null;
}

/**
 * The desk tiled (tileRects), each tile going to the window nearest it so
 * windows travel least — the main window, if there is one, in the first
 * tile, the largest when the tiles are not all alike (three windows: the
 * left half).
 */
export function tiledLayout(windows: ReadonlyMap<string, Rect>, bounds: Rect, main: string | null): Map<string, Rect> {
  const tiles = tileRects(windows.size, bounds);
  const left = new Set(windows.keys());
  const layout = new Map<string, Rect>();
  tiles.forEach((tile, index) => {
    let chosen: string | null = index === 0 && main !== null && left.has(main) ? main : null;
    if (chosen === null) {
      const target = centerOf(tile);
      let distance = Number.POSITIVE_INFINITY;
      for (const id of left) {
        const center = centerOf(windows.get(id)!);
        const d = Math.hypot(center.x - target.x, center.y - target.y);
        if (d < distance) {
          distance = d;
          chosen = id;
        }
      }
    }
    if (chosen === null) return;
    left.delete(chosen);
    layout.set(chosen, tile);
  });
  return layout;
}

/** How many windows the column beside a main window holds, each at least a window's least height. */
export function focusRoom(bounds: Rect): number {
  const side = bounds.w - Math.round((bounds.w - DESK_GAP) * FOCUS_SHARE) - DESK_GAP;
  if (side < Math.min(MIN_WINDOW_W, bounds.w)) return 0;
  return Math.max(0, Math.floor((bounds.h + DESK_GAP) / (MIN_WINDOW_H + DESK_GAP)));
}

/**
 * One window the main one: the desk's full height on the left, FOCUS_SHARE
 * of its width; the others stacked in the column to its right, top to
 * bottom in the order they stand now. Null when the column cannot hold them.
 */
export function focusLayout(windows: ReadonlyMap<string, Rect>, bounds: Rect, main: string): Map<string, Rect> | null {
  if (!windows.has(main)) return null;
  const others = [...windows].filter(([id]) => id !== main);
  if (others.length === 0) return new Map([[main, { ...bounds }]]);
  if (others.length > focusRoom(bounds)) return null;
  const mainW = Math.round((bounds.w - DESK_GAP) * FOCUS_SHARE);
  const sideX = bounds.x + mainW + DESK_GAP;
  const sideW = rightOf(bounds) - sideX;
  const cellH = (bounds.h - DESK_GAP * (others.length - 1)) / others.length;
  const layout = new Map<string, Rect>([[main, { x: bounds.x, y: bounds.y, w: mainW, h: bounds.h }]]);
  others
    .sort((a, b) => centerOf(a[1]).y - centerOf(b[1]).y)
    .forEach(([id], index) => layout.set(id, { x: sideX, y: bounds.y + index * (cellH + DESK_GAP), w: sideW, h: cellH }));
  return layout;
}

/**
 * A new window beside the one it goes with: the desk as it was before it
 * came out, with that window's place cut in two along its longer side
 * (splitRect) — the window keeping the first half, the new one the second.
 * Null when that window is too small to share.
 */
export function pairedLayout(before: ReadonlyMap<string, Rect>, opened: string, partner: string): Map<string, Rect> | null {
  const place = before.get(partner);
  if (place === undefined || partner === opened) return null;
  const halves = splitRect(place);
  if (halves === null) return null;
  const layout = new Map(before);
  layout.delete(opened);
  layout.set(partner, halves[0]);
  layout.set(opened, halves[1]);
  return layout;
}

/* ------------------------------ what is offered ------------------------------ */

/** How a new window came out: into a tiled desk's hole, sharing a window's place, or over the others. */
export type OpenedHow = "hole" | "split" | "free";

/** What the desk can do now, by what happened (the moves the model is offered). */
export function offeredMoves(
  trigger: "opened" | "closed" | "asked",
  windows: ReadonlyMap<string, Rect>,
  bounds: Rect,
  extra: { gaps?: readonly Rect[]; before?: ReadonlyMap<string, Rect>; opened?: string; how?: OpenedHow } = {},
): DeskLayoutMove[] {
  const moves: DeskLayoutMove[] = trigger === "asked" ? [] : ["keep"];
  if (trigger === "closed" && extra.gaps !== undefined && fillGaps(windows, extra.gaps) !== null) moves.push("fill");
  // A window that came out into a tiled desk's hole is where it belongs already; one that split a window, or lies over them, may go beside another.
  if (trigger === "opened" && extra.how !== "hole" && extra.before !== undefined && extra.opened !== undefined) {
    const pairable = [...extra.before.keys()].some((id) => id !== extra.opened && splitRect(extra.before!.get(id)!) !== null);
    if (pairable) moves.push("pair");
  }
  if (windows.size >= 1) moves.push("tile");
  if (windows.size >= 2 && windows.size - 1 <= focusRoom(bounds)) moves.push("focus");
  return moves;
}

/** Whether a layout moves anything (a pixel's slack). */
export function changesLayout(current: ReadonlyMap<string, Rect>, next: ReadonlyMap<string, Rect>): boolean {
  for (const [id, rect] of next) {
    const now = current.get(id);
    if (now === undefined || !sameRect(now, rect, 1)) return true;
  }
  return false;
}
