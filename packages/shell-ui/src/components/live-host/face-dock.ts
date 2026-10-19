/**
 * Where the faces sit on the host's desk (docs/live-share.md §1): stacked
 * at the top trailing corner of the stage until the host drags them, then
 * along whichever edge they were let go nearest, as far along it as they
 * were. Pure, so test/live-host-faces.test.ts holds the snapping.
 */

import type { LiveRect } from "@pistachio/shell-contracts/live-share";

export type FaceEdge = "top" | "right" | "bottom" | "left";

/** An edge of the stage and how far along it (0 at its top or left end, 1 at the other). */
export interface FaceDock {
  edge: FaceEdge;
  t: number;
}

/** The top trailing corner. */
export const DEFAULT_FACE_DOCK: FaceDock = { edge: "right", t: 0 };

/** How far the faces keep from the stage's edges, px. */
export const FACE_INSET = 14;

const clampUnit = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

/** The dock nearest a point (window px): the closest edge, and where along it the point is. */
export function nearestDock(stage: LiveRect, x: number, y: number): FaceDock {
  const distances: Array<[FaceEdge, number]> = [
    ["left", Math.abs(x - stage.x)],
    ["right", Math.abs(stage.x + stage.w - x)],
    ["top", Math.abs(y - stage.y)],
    ["bottom", Math.abs(stage.y + stage.h - y)],
  ];
  const [edge] = distances.reduce((best, next) => (next[1] < best[1] ? next : best));
  const along = edge === "left" || edge === "right" ? (y - stage.y) / stage.h : (x - stage.x) / stage.w;
  return { edge, t: clampUnit(along) };
}

/**
 * Where the stack goes for a dock: the point it hangs from (window px) and
 * the share of its own size to shift it by, so it stays inside the stage at
 * either end of the edge; a stack on the top or bottom edge runs across.
 */
export function dockPlacement(stage: LiveRect, dock: FaceDock): { x: number; y: number; shiftX: number; shiftY: number; direction: "column" | "row" } {
  const t = clampUnit(dock.t);
  const across = stage.x + FACE_INSET + t * Math.max(0, stage.w - FACE_INSET * 2);
  const down = stage.y + FACE_INSET + t * Math.max(0, stage.h - FACE_INSET * 2);
  switch (dock.edge) {
    case "right":
      return { x: stage.x + stage.w - FACE_INSET, y: down, shiftX: -1, shiftY: -t, direction: "column" };
    case "left":
      return { x: stage.x + FACE_INSET, y: down, shiftX: 0, shiftY: -t, direction: "column" };
    case "top":
      return { x: across, y: stage.y + FACE_INSET, shiftX: -t, shiftY: 0, direction: "row" };
    case "bottom":
      return { x: across, y: stage.y + stage.h - FACE_INSET, shiftX: -t, shiftY: -1, direction: "row" };
  }
}
