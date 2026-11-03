/**
 * The timeline's geometry (docs/recorder.md §2 "Edit"): the ruler and the lanes,
 * where each segment and clip piece sits in output time, and what a point hits.
 * Pure: the timeline draws from it and routes the pointer through `hitTest`.
 */
import type { Project, SpeedSegment, TimeMap, ZoomSegment } from "../lib/types.js";
import { clamp } from "./model.js";

export type LaneId = "chapters" | "clip" | "zoom" | "speed" | "events" | "mic";

export const LANES: readonly { id: LaneId; label: string; height: number }[] = [
  { id: "chapters", label: "Chapters", height: 20 },
  { id: "clip", label: "Clip", height: 30 },
  { id: "zoom", label: "Zoom", height: 24 },
  { id: "speed", label: "Speed", height: 24 },
  { id: "events", label: "Events", height: 20 },
  { id: "mic", label: "Mic", height: 28 },
];

export const RULER_HEIGHT = 24;
export const LANE_GAP = 4;
/** The grab zone at a bar's ends (px), smaller on a narrow bar. */
export const EDGE = 6;
/** How near a marker (a scissors, a cut in the speed plan, the playhead) catches the pointer (px). */
export const MARKER = 5;
/** Room before the first second and after the last (px). */
export const INSET = 12;

export function laneBox(id: LaneId): { top: number; height: number } {
  let top = RULER_HEIGHT + LANE_GAP;
  for (const lane of LANES) {
    if (lane.id === id) return { top, height: lane.height };
    top += lane.height + LANE_GAP;
  }
  return { top: 0, height: 0 };
}

export function lanesHeight(): number {
  return LANES.reduce((sum, lane) => sum + lane.height + LANE_GAP, RULER_HEIGHT + LANE_GAP);
}

export function laneAtY(y: number): LaneId | "ruler" | null {
  if (y >= 0 && y < RULER_HEIGHT) return "ruler";
  for (const lane of LANES) {
    const box = laneBox(lane.id);
    if (y >= box.top - LANE_GAP / 2 && y < box.top + box.height + LANE_GAP / 2) return lane.id;
  }
  return null;
}

/** Output time along x: `x = INSET + tOut × pps`. */
export interface Scale {
  pps: number;
  map: TimeMap;
}

export function xOfOut(scale: Scale, tOut: number): number {
  return INSET + tOut * scale.pps;
}

export function xOfSrc(scale: Scale, tSrc: number): number {
  return xOfOut(scale, scale.map.toOutput(tSrc));
}

export function outOfX(scale: Scale, x: number): number {
  return clamp((x - INSET) / scale.pps, 0, scale.map.duration);
}

export function srcOfX(scale: Scale, x: number): number {
  return scale.map.toSource(outOfX(scale, x));
}

export function contentWidth(scale: Scale): number {
  return INSET * 2 + scale.map.duration * scale.pps;
}

/** The px a second that fits the whole output into `width`. */
export function fitPps(width: number, duration: number): number {
  return Math.max(1, (width - INSET * 2) / Math.max(0.5, duration));
}

export interface Bar<T> {
  item: T;
  x0: number;
  x1: number;
}

export function zoomBars(project: Project, scale: Scale): Bar<ZoomSegment>[] {
  return project.zooms.map((item) => ({ item, x0: xOfSrc(scale, item.start), x1: xOfSrc(scale, item.end) }));
}

export function speedBars(project: Project, scale: Scale): Bar<SpeedSegment>[] {
  return project.speed.map((item) => ({ item, x0: xOfSrc(scale, item.start), x1: xOfSrc(scale, item.end) }));
}

/** The kept pieces, and the scissors marker between each two. */
export function clipBars(project: Project, scale: Scale): { pieces: Bar<number>[]; gaps: { index: number; x: number; removed: number }[] } {
  const pieces = project.cuts.map((cut, index) => ({ item: index, x0: xOfSrc(scale, cut.in), x1: xOfSrc(scale, cut.out) }));
  const gaps: { index: number; x: number; removed: number }[] = [];
  for (let i = 0; i < project.cuts.length - 1; i++) {
    const left = project.cuts[i]!;
    const right = project.cuts[i + 1]!;
    gaps.push({ index: i, x: xOfSrc(scale, left.out), removed: Math.max(0, right.in - left.out) });
  }
  return { pieces, gaps };
}

export type Hit =
  | { kind: "playhead" }
  | { kind: "ruler"; tOut: number }
  | { kind: "segment"; lane: "zoom" | "speed"; id: string; part: "body" | "start" | "end" }
  | { kind: "clip"; index: number; tOut: number }
  | { kind: "gap"; index: number }
  | { kind: "lane"; lane: LaneId; tOut: number };

function partOf(x: number, x0: number, x1: number): "body" | "start" | "end" | null {
  const width = x1 - x0;
  if (width < 2) return Math.abs(x - x0) <= MARKER ? "body" : null;
  if (x < x0 - 1 || x > x1 + 1) return null;
  const edge = Math.min(EDGE, width / 3);
  if (x <= x0 + edge) return "start";
  if (x >= x1 - edge) return "end";
  return "body";
}

/** What a point in the timeline's content (x from the content's left, y from the ruler's top) lands on. */
export function hitTest(project: Project, scale: Scale, x: number, y: number, playheadOut: number): Hit | null {
  const lane = laneAtY(y);
  if (lane === null) return null;
  const tOut = outOfX(scale, x);
  if (lane === "ruler") {
    if (Math.abs(x - xOfOut(scale, playheadOut)) <= MARKER) return { kind: "playhead" };
    return { kind: "ruler", tOut };
  }
  if (lane === "clip") {
    const { pieces, gaps } = clipBars(project, scale);
    for (const gap of gaps) if (Math.abs(x - gap.x) <= MARKER) return { kind: "gap", index: gap.index };
    for (const piece of pieces) if (x >= piece.x0 && x <= piece.x1) return { kind: "clip", index: piece.item, tOut };
    return { kind: "lane", lane, tOut };
  }
  if (lane === "zoom" || lane === "speed") {
    const bars: Bar<{ id: string }>[] = lane === "zoom" ? zoomBars(project, scale) : speedBars(project, scale);
    // The bar whose edge is nearest wins when two touch.
    let best: { id: string; part: "body" | "start" | "end"; score: number } | null = null;
    for (const bar of bars) {
      const part = partOf(x, bar.x0, bar.x1);
      if (part === null) continue;
      const score = part === "body" ? 100 : Math.min(Math.abs(x - bar.x0), Math.abs(x - bar.x1));
      if (best === null || score < best.score) best = { id: bar.item.id, part, score };
    }
    if (best !== null) return { kind: "segment", lane, id: best.id, part: best.part };
    return { kind: "lane", lane, tOut };
  }
  return { kind: "lane", lane, tOut };
}

/** Ruler ticks for a scale: a step that leaves at least `minGap` px between labels. */
export function rulerStep(pps: number, minGap = 64): { major: number; minor: number } {
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const major = steps.find((step) => step * pps >= minGap) ?? 600;
  const minor = major >= 1 ? major / (major === 15 || major === 30 ? 3 : major === 2 ? 2 : 5) : major / 5;
  return { major, minor };
}
