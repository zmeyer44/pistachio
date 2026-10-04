/**
 * The geometry of a tab dragged out of the sidebar's column toward the page
 * (chrome/shelf-drag.tsx): where the split zones are. The column is vertical
 * and the page beside it, so travel OUT of the column — "lift" — runs +X,
 * right into the content.
 *
 * Pure on purpose — no React, no store — so vitest pins the zone geometry
 * under node.
 */

import type { ContentBounds, SplitSide } from "@pistachio/shell-contracts/ipc";

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

/**
 * The split zone a pointer names, or null while it is anywhere but over the
 * page: short of SPLIT_ARM_PX into the box from its leading edge, past the
 * box's trailing edge (beside the page is the agent console, and a lone row
 * dragged onto it must not split), or above or below the box.
 */
export function splitZoneAt(area: ContentBounds, p: PointerLike): SplitZone | null {
  if (p.clientX < area.x + SPLIT_ARM_PX || p.clientX > area.x + area.width) return null;
  if (p.clientY < area.y || p.clientY > area.y + area.height) return null;
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
