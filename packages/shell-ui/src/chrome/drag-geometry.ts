/**
 * The geometry of a tab drag, described once per axis so the horizontal
 * strip and the vertical list share one implementation (chrome/tab-drag.ts):
 * which offset is "along the row", which pointer coordinate follows it, and
 * which way "lift" — travel OUT of the row toward the page — goes. For the
 * strip (axis "x") the row is horizontal and lift is +Y, down into the
 * content. For the list (axis "y") the row is vertical and lift is +X, right
 * into the content. Everything the drag does — the clamps, the drop index,
 * the split zones, the settle animation — is written against those two
 * directions and never mentions left or top.
 *
 * Pure on purpose — no React, no store — so vitest pins the zone geometry
 * under node.
 */

import type { ContentBounds, SplitSide } from "@pistachio/shell-contracts/ipc";
import { n } from "../lib/folder";

export type DragAxis = "x" | "y";
export type SplitZone = SplitSide;

/** How far into the content area the pointer must travel before a drop means "split". */
export const SPLIT_ARM_PX = 24;
/**
 * The browser surface's padding (components/ContentArea.tsx, `p-2`): the
 * content box the shell publishes is the surface, and the tab views — which
 * paint over anything beneath them — begin this far inside it.
 */
export const SURFACE_INSET = 8;

export interface PointerLike {
  clientX: number;
  clientY: number;
}

/** One axis's reading of layout, pointer, and content geometry. */
export interface AxisGeometry {
  /** Layout position along the row (offsetLeft | offsetTop). */
  start(el: HTMLElement): number;
  /** Layout size along the row (offsetWidth | offsetHeight). */
  size(el: HTMLElement): number;
  /** The pointer's coordinate along the row. */
  along(p: PointerLike): number;
  /** The pointer's coordinate along the lift direction. */
  lift(p: PointerLike): number;
  /** Viewport position of the layout origin (the offsetParent's near edge). */
  origin(rect: DOMRect): number;
  /** Window extent along the row. */
  window(): number;
  /** Room between the element's far lift edge and the window's: how far it may lift. */
  liftRoom(rect: DOMRect): number;
  /** The element's near and far edges along the lift direction (top/bottom for "x", left/right for "y"). */
  liftStart(rect: DOMRect): number;
  liftEnd(rect: DOMRect): number;
  /** The content box's extent along the row. */
  areaStart(area: ContentBounds): number;
  areaSize(area: ContentBounds): number;
  /** The content box's near edge along the lift direction. */
  areaLiftStart(area: ContentBounds): number;
  /** The content box's extent along the lift direction. */
  areaLiftSize(area: ContentBounds): number;
  /** A CSS transform of `along` px along the row and `lift` px out of it. */
  translate(along: number, lift: number): string;
  /** The transform origin for a grab `along` px into the element. */
  transformOrigin(grab: number): string;
}

export const AXES: Record<DragAxis, AxisGeometry> = {
  x: {
    start: (el) => el.offsetLeft,
    size: (el) => el.offsetWidth,
    along: (p) => p.clientX,
    lift: (p) => p.clientY,
    origin: (rect) => rect.left,
    window: () => window.innerWidth,
    liftRoom: (rect) => window.innerHeight - rect.bottom,
    liftStart: (rect) => rect.top,
    liftEnd: (rect) => rect.bottom,
    areaStart: (area) => area.x,
    areaSize: (area) => area.width,
    areaLiftStart: (area) => area.y,
    areaLiftSize: (area) => area.height,
    translate: (along, lift) => `translate(${n(along)}px, ${n(lift)}px)`,
    transformOrigin: (grab) => `${n(grab)}px 50%`,
  },
  y: {
    start: (el) => el.offsetTop,
    size: (el) => el.offsetHeight,
    along: (p) => p.clientY,
    lift: (p) => p.clientX,
    origin: (rect) => rect.top,
    window: () => window.innerHeight,
    liftRoom: (rect) => window.innerWidth - rect.right,
    liftStart: (rect) => rect.left,
    liftEnd: (rect) => rect.right,
    areaStart: (area) => area.y,
    areaSize: (area) => area.height,
    areaLiftStart: (area) => area.x,
    areaLiftSize: (area) => area.width,
    translate: (along, lift) => `translate(${n(lift)}px, ${n(along)}px)`,
    transformOrigin: (grab) => `50% ${n(grab)}px`,
  },
};

/**
 * The split zone a pointer names, or null while it is anywhere but over the
 * page: short of SPLIT_ARM_PX into the box along the lift axis, past the
 * box's far edge along it (beside the page is the agent console, and a lone
 * row dragged onto it must not split), or off the box along the row axis.
 */
export function splitZoneAt(axis: DragAxis, area: ContentBounds, p: PointerLike): SplitZone | null {
  const g = AXES[axis];
  const lift = g.lift(p);
  if (lift < g.areaLiftStart(area) + SPLIT_ARM_PX || lift > g.areaLiftStart(area) + g.areaLiftSize(area)) return null;
  if (g.along(p) < g.areaStart(area) || g.along(p) > g.areaStart(area) + g.areaSize(area)) return null;
  // Each point belongs to its nearest page edge. This makes all four targets
  // generous without overlapping them or reserving a dead area in the middle.
  const distances: Array<[SplitZone, number]> = [
    ["left", p.clientX - area.x],
    ["right", area.x + area.width - p.clientX],
    ["top", p.clientY - area.y],
    ["bottom", area.y + area.height - p.clientY],
  ];
  return distances.reduce((nearest, candidate) => candidate[1] < nearest[1] ? candidate : nearest)[0];
}
