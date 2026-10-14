/**
 * The desk's named layouts (docs/double-sidebar.md §1 "Layouts", §2): the
 * layouts a space's windows allow, as the space view's segmented control
 * offers them — Fill, Side by side, Stacked, Main and side, Tile, Columns,
 * Cascade — where every window goes for each, and which of them, if any,
 * the windows are in now.
 *
 * The rectangles are the desk's own: tileRects and cascadeRects (Tile and
 * Cascade, ⌘⌥T and ⌘⌥C, as they always were), the smart layout's main
 * place (focusLayout, FOCUS_SHARE of the width), and full-width rows and
 * full-height columns beside them (stackRects, columnRects), every one with
 * the desk's gutter. Which window goes where is the smart layout's rule
 * too: the window in use takes the main place (the main window's, the
 * first tile), and the rest go to the places nearest them, so windows
 * travel least (tiledLayout).
 *
 * Pure on purpose — no DOM, no engine — so vitest pins it under node.
 * (Added 2026-10-13 with the double sidebar; until then the desk had Tile
 * and Cascade, and the layout model's moves.)
 */

import { cascadeRects, centerOf, columnRects, DESK_GAP, MIN_WINDOW_H, MIN_WINDOW_W, rescaleRect, rightOf, sameRect, stackRects, tileRects, type Rect } from "./geometry";
import { FOCUS_SHARE, focusLayout, focusRoom, tiledLayout } from "./smart-layout";

export type DeskLayoutKind = "fill" | "halves" | "stack" | "focus" | "tile" | "columns" | "cascade";

/** How near a window's box must be to a layout's place for the desk to be in that layout: a couple of px. */
export const LAYOUT_SLACK = 2;

/**
 * Each layout's name and what it does, in the space view's words: the
 * label on its segment, and the caption under the track (after the label:
 * "Main and side: the window in use takes 62%, the rest stack beside it").
 */
export const LAYOUT_WORDS: Readonly<Record<DeskLayoutKind, { label: string; caption: (count: number) => string }>> = {
  fill: { label: "Fill", caption: () => "one window, the whole desk" },
  halves: { label: "Side by side", caption: () => "two equal halves" },
  stack: { label: "Stacked", caption: (count) => (count === 2 ? "two full-width rows" : "a full-width row for every window") },
  focus: { label: "Main and side", caption: () => `the window in use takes ${String(Math.round(FOCUS_SHARE * 100))}%, the rest stack beside it` },
  tile: {
    label: "Tile",
    caption: (count) => (count === 2 ? "two equal halves" : count === 3 ? "one on the left, two stacked on the right" : "an equal share for every window"),
  },
  columns: { label: "Columns", caption: () => "a full-height column for every window" },
  cascade: { label: "Cascade", caption: () => "stepped, so every title shows" },
};

/** The layout model's own (⌘⌥L), apart from the named layouts at the end of the track. */
export const ARRANGE_WORDS = { label: "Arrange for me", caption: "reads the windows' titles and picks tile, or main and side" } as const;

/**
 * The layouts `count` windows allow, in the track's order, most useful
 * first: one window, Fill; two, Side by side, Stacked, Main and side,
 * Cascade; three or four, Tile, Main and side, Columns, Cascade; five,
 * Tile, Main and side, Cascade; more, Tile and Cascade. Main and side only
 * while its column holds the rest (`room`: focusRoom of the desk — at five,
 * and on a short desk sooner); given the desk (`bounds`), Columns only while
 * each column is a window's least width, and Stacked while each row is its
 * least height (columnsFit, rowsFit), as Main and side's column is gated —
 * without it, as before, neither is (2026-10-13). layoutsOn says both from
 * the desk alone.
 */
export function layoutsFor(count: number, room = Number.POSITIVE_INFINITY, bounds?: Rect): DeskLayoutKind[] {
  if (count <= 0) return [];
  if (count === 1) return ["fill"];
  const focus: DeskLayoutKind[] = count - 1 <= room ? ["focus"] : [];
  const stack: DeskLayoutKind[] = bounds === undefined || rowsFit(count, bounds) ? ["stack"] : [];
  const columns: DeskLayoutKind[] = bounds === undefined || columnsFit(count, bounds) ? ["columns"] : [];
  if (count === 2) return ["halves", ...stack, ...focus, "cascade"];
  if (count <= 4) return ["tile", ...focus, ...columns, "cascade"];
  if (count === 5) return ["tile", ...focus, "cascade"];
  return ["tile", "cascade"];
}

/** The layouts `count` windows allow on this desk: layoutsFor with Main and side's room (focusRoom) and the least sizes read off it. */
export function layoutsOn(count: number, bounds: Rect): DeskLayoutKind[] {
  return layoutsFor(count, focusRoom(bounds), bounds);
}

/** Whether `count` full-height columns, a gutter apart, are each at least a window's least width (Columns). */
export function columnsFit(count: number, bounds: Rect, gap = DESK_GAP): boolean {
  return count > 0 && (bounds.w - gap * (count - 1)) / count >= MIN_WINDOW_W;
}

/** Whether `count` full-width rows, a gutter apart, are each at least a window's least height (Stacked). */
export function rowsFit(count: number, bounds: Rect, gap = DESK_GAP): boolean {
  return count > 0 && (bounds.h - gap * (count - 1)) / count >= MIN_WINDOW_H;
}

/**
 * The main window's place and the column beside it (focusLayout's, as a
 * set: the main place first, the column top to bottom), with any gutter —
 * a layout's line drawing uses a thin one. No room check: that is
 * layoutsFor's, and focusLayout's.
 */
export function focusRects(count: number, bounds: Rect, gap = DESK_GAP): Rect[] {
  if (count <= 0) return [];
  if (count === 1) return [{ ...bounds }];
  const mainW = Math.round((bounds.w - gap) * FOCUS_SHARE);
  const sideX = bounds.x + mainW + gap;
  const sideW = rightOf(bounds) - sideX;
  const others = count - 1;
  const cellH = (bounds.h - gap * (others - 1)) / others;
  return [
    { x: bounds.x, y: bounds.y, w: mainW, h: bounds.h },
    ...Array.from({ length: others }, (_, index) => ({ x: sideX, y: bounds.y + index * (cellH + gap), w: sideW, h: cellH })),
  ];
}

/**
 * The places of `kind` for `count` windows, in their order (the main place
 * first; a cascade back to front) — or null when the layout is not one for
 * that many: Fill is one window's, Side by side two's.
 */
export function slotRects(kind: DeskLayoutKind, count: number, bounds: Rect, gap = DESK_GAP): Rect[] | null {
  if (count <= 0) return null;
  switch (kind) {
    case "fill":
      return count === 1 ? [{ ...bounds }] : null;
    case "halves":
      return count === 2 ? columnRects(2, bounds, gap) : null;
    case "stack":
      return stackRects(count, bounds, gap);
    case "columns":
      return columnRects(count, bounds, gap);
    case "tile":
      return tileRects(count, bounds, gap);
    case "focus":
      return count >= 2 ? focusRects(count, bounds, gap) : null;
    case "cascade":
      return cascadeRects(count, bounds);
  }
}

/** Windows in reading order along an axis: by their middles, the other axis breaking ties. */
function along(windows: ReadonlyMap<string, Rect>, axis: "x" | "y"): string[] {
  const other = axis === "x" ? "y" : "x";
  return [...windows].sort((a, b) => centerOf(a[1])[axis] - centerOf(b[1])[axis] || centerOf(a[1])[other] - centerOf(b[1])[other]).map(([id]) => id);
}

/**
 * Where every window goes for `kind`, in the order they set off (a beat
 * apart) — or null when these windows cannot be laid out so (Fill for
 * more than one, Side by side for other than two, Main and side when its
 * column cannot hold the rest, Columns and Stacked when a column or a row
 * would be less than a window's least size).
 *
 * - Tile: the window in use in the first tile (the left half, of three),
 *   each other tile to the window nearest it (tiledLayout).
 * - Main and side: the window in use in the main place — or, none of these
 *   in use, the largest — the rest down the column in the order they stand
 *   (focusLayout).
 * - Side by side, Columns, Stacked: the windows keep their order across
 *   (left to right) or down (top to bottom), so none crosses another.
 * - Cascade: `windows` are given bottom to top, and keep that order down
 *   the steps, the window in use brought to the front (the caller stacks
 *   them so: the map's order is back to front).
 */
export function layoutRects(kind: DeskLayoutKind, windows: ReadonlyMap<string, Rect>, bounds: Rect, inUse: string | null): Map<string, Rect> | null {
  const count = windows.size;
  const slots = slotRects(kind, count, bounds);
  if (slots === null) return null;
  const main = inUse !== null && windows.has(inUse) ? inUse : null;
  switch (kind) {
    case "tile":
      return tiledLayout(windows, bounds, main);
    case "focus": {
      if (count - 1 > focusRoom(bounds)) return null;
      const largest = [...windows].reduce((best, entry) => (entry[1].w * entry[1].h > best[1].w * best[1].h ? entry : best))[0];
      return focusLayout(windows, bounds, main ?? largest);
    }
    case "cascade": {
      const order = [...windows.keys()].filter((id) => id !== main);
      if (main !== null) order.push(main);
      return new Map(order.map((id, index) => [id, slots[index]!]));
    }
    case "stack":
      if (!rowsFit(count, bounds)) return null;
      return new Map(along(windows, "y").map((id, index) => [id, slots[index]!]));
    case "columns":
      if (!columnsFit(count, bounds)) return null;
      return new Map(along(windows, "x").map((id, index) => [id, slots[index]!]));
    default:
      // fill, halves.
      return new Map(along(windows, "x").map((id, index) => [id, slots[index]!]));
  }
}

/**
 * A layout with its windows moved round its places `turn` times (Tab on a
 * layout looked at in the space view, since 2026-10-14): the places in
 * reading order — top to bottom, left to right, so a cascade's run back to
 * front — and each window in the place `turn` after its own, the last
 * coming round to the first; a negative turn goes the other way. Two
 * windows trade places at each turn; Main and side gives each in turn the
 * main place. The order of the entries is the places' (a cascade's stacking).
 */
export function cycledLayout(layout: ReadonlyMap<string, Rect>, turn: number): Map<string, Rect> {
  const places = [...layout].sort(([, a], [, b]) => a.y - b.y || a.x - b.x);
  const count = places.length;
  const shift = count === 0 ? 0 : ((Math.trunc(turn) % count) + count) % count;
  if (shift === 0) return new Map(places);
  return new Map(places.map(([, rect], index) => [places[(index - shift + count) % count]![0], rect]));
}

/**
 * Whether the windows' boxes are the places of `kind`: as sets — any window
 * in any place (Main and side's main place is whichever window holds it) —
 * each within `slack` px.
 */
export function isLaidOutAs(kind: DeskLayoutKind, rects: readonly Rect[], bounds: Rect, slack = LAYOUT_SLACK): boolean {
  const slots = slotRects(kind, rects.length, bounds);
  if (slots === null) return false;
  const free = [...slots];
  for (const rect of rects) {
    const index = free.findIndex((slot) => sameRect(rect, slot, slack));
    if (index < 0) return false;
    free.splice(index, 1);
  }
  return true;
}

/**
 * The layout the windows are in (where each is going: the engine reads
 * `target ?? rect`), of those their number allows on this desk (layoutsOn)
 * — or null, set down by hand. One window filling the desk is Fill; two
 * side by side are Side by side, which is also how Tile lays out two.
 */
export function layoutOf(rects: readonly Rect[], bounds: Rect): DeskLayoutKind | null {
  for (const kind of layoutsOn(rects.length, bounds)) if (isLaidOutAs(kind, rects, bounds)) return kind;
  return null;
}

/**
 * A named layout as the desk laid it out (the engine's layOut, or the
 * smart layout's when it is one): its kind, the desk it was laid out on,
 * and the box it gave each window.
 */
export interface LaidOutAs {
  kind: DeskLayoutKind;
  desk: Rect;
  boxes: ReadonlyMap<string, Rect>;
}

/**
 * Whether the windows still stand where `laid` put them — the same
 * windows, each in its box carried over to the desk as it is now — within
 * `slack` px. Carried as the desk carries its windows when it is resized or
 * gives room to the chat (rescaleRect: a gutter stays a gutter); a desk
 * coming back from its saved fractions, or ⌃Z's snapshot, carries them in
 * plain proportion, which differs by at most a gutter's share of the change,
 * so that much more is allowed.
 */
export function holdsLayout(laid: LaidOutAs, windows: ReadonlyMap<string, Rect>, bounds: Rect, slack = LAYOUT_SLACK): boolean {
  if (windows.size === 0 || windows.size !== laid.boxes.size) return false;
  const change = Math.max(Math.abs((bounds.w + DESK_GAP) / Math.max(1, laid.desk.w + DESK_GAP) - 1), Math.abs((bounds.h + DESK_GAP) / Math.max(1, laid.desk.h + DESK_GAP) - 1));
  const within = slack + DESK_GAP * change;
  for (const [id, rect] of windows) {
    const box = laid.boxes.get(id);
    if (box === undefined || !sameRect(rect, rescaleRect(box, laid.desk, bounds), within)) return false;
  }
  return true;
}

/**
 * The layout the desk is in: the one it was laid out in (`laid`), while the
 * windows stand where it put them (holdsLayout) and their number still
 * allows it here — else the one their boxes read as (layoutOf). Geometry
 * alone loses a layout once the desk is resized (⌘S, the window, the chat's
 * room): a cascade's 32px step and centred box, and Tile's grid, are not in
 * proportion with the desk, and Main and side's main place is rounded — so
 * they are no longer its places, though nobody moved a window. A window
 * moved by hand, one more or one fewer, and only geometry is asked.
 * (2026-10-13; until then the layout was read off the boxes alone.)
 */
export function layoutNow(windows: ReadonlyMap<string, Rect>, bounds: Rect, laid: LaidOutAs | null): DeskLayoutKind | null {
  if (laid !== null && layoutsOn(windows.size, bounds).includes(laid.kind) && holdsLayout(laid, windows, bounds)) return laid.kind;
  return layoutOf([...windows.values()], bounds);
}
