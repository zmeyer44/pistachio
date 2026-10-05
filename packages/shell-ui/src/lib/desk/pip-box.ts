/**
 * The desk's floating player's box (docs/desk.md, "Now playing"): where it
 * may stand, how large it may be, and what a press on one of its edges makes
 * of it. Its picture is the video's, drawn whole (object-fit: contain), so it
 * keeps the widescreen shape it opens at, as a browser's picture in picture
 * does.
 */

import type { DragCursor } from "@pistachio/shell-contracts/chrome";
import { DESK_PIP_OUTSET, type DeskPipEdge } from "@pistachio/shell-contracts/desk";
import { resizedKeepingAspect } from "./geometry";

/** The player's picture as it opens: a widescreen frame, as a browser's picture in picture opens at. */
export const PIP_W = 320;
export const PIP_H = 180;
/** As small as it may be made: its controls still in their rows across it. */
export const PIP_MIN_W = 240;

export interface PipBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Size = { width: number; height: number };

/** The cursor over each edge and corner, and the drag layer's while one is in hand. */
export const PIP_EDGE_CURSORS: Readonly<Record<DeskPipEdge, DragCursor>> = {
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
};

/** The height of a picture this wide: its shape kept. */
export function pipHeight(width: number): number {
  return Math.round((width * PIP_H) / PIP_W);
}

/** A width the player may have in a window this size: whole in it with its edges' ring, no smaller than its controls want (unless the window is). */
export function pipWidth(width: number, size: Size): number {
  const widest = Math.max(1, Math.min(size.width - DESK_PIP_OUTSET * 2, ((size.height - DESK_PIP_OUTSET * 2) * PIP_W) / PIP_H));
  return Math.round(Math.min(widest, Math.max(PIP_MIN_W, width)));
}

/** The player kept whole in the window, and the ring its edges stand on (DESK_PIP_OUTSET) with it. */
export function clampPipBox(box: PipBox, size: Size): PipBox {
  const inset = DESK_PIP_OUTSET;
  return {
    ...box,
    x: Math.round(Math.min(Math.max(inset, box.x), Math.max(inset, size.width - inset - box.width))),
    y: Math.round(Math.min(Math.max(inset, box.y), Math.max(inset, size.height - inset - box.height))),
  };
}

/**
 * The player as a press on an edge or corner leaves it, the pointer having
 * travelled (dx, dy) since: resized as a masked window is, its shape kept
 * (geometry.ts, resizedKeepingAspect) — the edge or corner opposite holds
 * still, a corner goes by the way the pointer has moved more — no smaller
 * than its controls want, and whole in the window with its edges' ring.
 */
export function resizedPipBox(start: PipBox, edge: DeskPipEdge, dx: number, dy: number, size: Size): PipBox {
  const edges = { left: edge.includes("w"), right: edge.includes("e"), top: edge.includes("n"), bottom: edge.includes("s") };
  const inset = DESK_PIP_OUTSET;
  const bounds = { x: inset, y: inset, w: size.width - inset * 2, h: size.height - inset * 2 };
  const rect = resizedKeepingAspect({ x: start.x, y: start.y, w: start.width, h: start.height }, edges, dx, dy, bounds, 0, pipHeight(PIP_MIN_W));
  const width = Math.round(rect.w);
  const height = pipHeight(width);
  return {
    x: edges.left ? start.x + start.width - width : start.x,
    y: edges.top ? start.y + start.height - height : start.y,
    width,
    height,
  };
}
