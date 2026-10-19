/**
 * How the live-host window's marks that belong to a window — the outlines
 * and the names on them — go under the browser's own surfaces over the desk
 * (docs/live-share.md §6.3). The window lies over the whole browser window,
 * so whatever it draws is over the shell's too; main says where the shell's
 * surfaces lie (`chrome`, window px: a cover's box, a side card's column,
 * the notice stack's cards), and the layer of those marks is clipped to
 * what is left of the window — or not drawn at all while something no box
 * holds lies over the desk (an overlay, a menu, a passing).
 *
 * Pure: the layer applies what this answers (WindowMarks.tsx), and
 * test/live-host-chrome-cut.test.ts drives it with boxes of its own.
 */

import type { LiveRect } from "@pistachio/shell-contracts/live-share";

/** How the layer is drawn: whole, cut out where the browser's surfaces lie (`clipPath`, what is left), or not at all. */
export type ChromeCut = { kind: "whole" } | { kind: "hidden" } | { kind: "cut"; holes: LiveRect[]; clipPath: string };

/** A box grown out to whole px: a mark's edge half a px into a surface would still show on it. */
function outward(rect: LiveRect): LiveRect {
  const x = Math.floor(rect.x);
  const y = Math.floor(rect.y);
  return { x, y, w: Math.ceil(rect.x + rect.w) - x, h: Math.ceil(rect.y + rect.h) - y };
}

/**
 * The parts of `area` no box of `holes` lies over, as boxes that do not
 * overlap: the area cut into columns at every hole's sides — so each hole
 * lies over a column wholly or not at all — and each column into the runs
 * between the holes over it; a run level with the one beside it, and as
 * tall, is one box with it.
 */
export function uncovered(area: LiveRect, holes: readonly LiveRect[]): LiveRect[] {
  const right = area.x + area.w;
  const bottom = area.y + area.h;
  const edges = [...new Set([area.x, right, ...holes.flatMap((hole) => [hole.x, hole.x + hole.w])])].filter((x) => x >= area.x && x <= right).sort((a, b) => a - b);
  const runs: LiveRect[] = [];
  for (let index = 0; index + 1 < edges.length; index += 1) {
    const left = edges[index]!;
    const next = edges[index + 1]!;
    const over = holes
      .filter((hole) => hole.x <= left && hole.x + hole.w >= next)
      .map((hole) => [Math.max(area.y, hole.y), Math.min(bottom, hole.y + hole.h)] as const)
      .filter(([top, end]) => end > top)
      .sort((a, b) => a[0] - b[0]);
    let y = area.y;
    const column: LiveRect[] = [];
    for (const [top, end] of over) {
      if (top > y) column.push({ x: left, y, w: next - left, h: top - y });
      y = Math.max(y, end);
    }
    if (bottom > y) column.push({ x: left, y, w: next - left, h: bottom - y });
    for (const run of column) {
      const beside = runs.find((box) => box.x + box.w === run.x && box.y === run.y && box.h === run.h);
      if (beside === undefined) runs.push(run);
      else beside.w += run.w;
    }
  }
  return runs;
}

const px = (value: number): string => String(Math.round(value * 100) / 100);

/**
 * How to draw the layer over a window of `size` (px) with the browser's own
 * surfaces `over` it (window px): not at all for null (something no box
 * holds), whole with none on the window, else clipped to what they leave.
 */
export function chromeCut(over: readonly LiveRect[] | null, size: { w: number; h: number }): ChromeCut {
  if (over === null) return { kind: "hidden" };
  const area: LiveRect = { x: 0, y: 0, w: size.w, h: size.h };
  const holes = over.map(outward).filter((hole) => hole.w > 0 && hole.h > 0 && hole.x < area.w && hole.y < area.h && hole.x + hole.w > 0 && hole.y + hole.h > 0);
  if (holes.length === 0) return { kind: "whole" };
  const left = uncovered(area, holes);
  if (left.length === 0) return { kind: "hidden" };
  // (One path of boxes that do not overlap, all wound the same way: nonzero fills each, and nothing between.)
  const path = left.map((box) => `M${px(box.x)} ${px(box.y)}h${px(box.w)}v${px(box.h)}h${px(-box.w)}z`).join("");
  return { kind: "cut", holes, clipPath: `path("${path}")` };
}
