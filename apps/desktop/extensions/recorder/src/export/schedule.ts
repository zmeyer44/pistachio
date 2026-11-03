/**
 * The export's frame schedule and the GIF's size (docs/recorder.md §2 "Export",
 * §5); a video's size is the lib's `outputSize`, as the preview's shape is.
 * Pure: unit-tested in Node, where there is no WebCodecs.
 */
import { outputSize } from "../lib/render.js";
import type { LookSpec, Size, TimeMap } from "../lib/types.js";

/**
 * A jump in source time bigger than this between two output frames is a cut:
 * the decoder seeks to the next kept range instead of decoding through the
 * part left out (≈ 2000 fps of decode at 1080p, so a second costs ~30 ms).
 */
export const SEEK_GAP = 1.0;

/** Output frames whose source times follow each other without a cut: one `samples(start, end)` iterator each. */
export interface FrameRange {
  /** The first and last output frame (inclusive). */
  first: number;
  last: number;
  /** Their source times, seconds. */
  start: number;
  end: number;
}

export interface FrameSchedule {
  fps: number;
  count: number;
  /** The source time of every output frame `i` (at `tOut = i / fps`). */
  tSrc: Float64Array;
  ranges: FrameRange[];
}

/** Every output frame's source time over the time map, cut into the ranges the decoder walks sequentially. */
export function frameSchedule(map: Pick<TimeMap, "toSource" | "duration">, fps: number, gap = SEEK_GAP): FrameSchedule {
  if (!(map.duration > 0)) throw new Error("Nothing to export: the edit keeps no time.");
  const count = Math.max(1, Math.round(map.duration * fps));
  const tSrc = new Float64Array(count);
  const ranges: FrameRange[] = [];
  let open: FrameRange | null = null;
  for (let i = 0; i < count; i++) {
    const t = map.toSource(i / fps);
    tSrc[i] = t;
    if (open !== null && (t - open.end > gap || t < open.end - 1e-6)) {
      ranges.push(open);
      open = null;
    }
    if (open === null) open = { first: i, last: i, start: t, end: t };
    else {
      open.last = i;
      open.end = t;
    }
  }
  if (open !== null) ranges.push(open);
  return { fps, count, tSrc, ranges };
}

const even = (n: number): number => Math.max(2, 2 * Math.round(n / 2));

/** A GIF's long side (docs/recorder.md §2: 960 px wide for the usual landscape frame). */
export const GIF_LONG_SIDE = 960;
export const GIF_FPS = 15;
/** GIFs past this are refused: the sheet offers MP4 instead (a little slack for rounding). */
export const GIF_MAX_SECONDS = 20;

/** A GIF's pixels: the video's shape (the lib's `outputSize`) with its long side at 960, both sides even. */
export function gifSize(look: LookSpec, view: Size): Size {
  const shape = outputSize(look, view, 1080);
  const ratio = shape.w / shape.h;
  return ratio >= 1 ? { w: even(GIF_LONG_SIDE), h: even(GIF_LONG_SIDE / ratio) } : { w: even(GIF_LONG_SIDE * ratio), h: even(GIF_LONG_SIDE) };
}

/** How often the Worker reports progress, in output frames. */
export const PROGRESS_EVERY = 30;

/** An ETA from the average pace so far; null until there is a pace worth trusting. */
export class Progress {
  readonly #start: number;
  readonly #now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
    this.#start = now();
  }

  /** Seconds since the start. */
  elapsed(): number {
    return (this.#now() - this.#start) / 1000;
  }

  at(fraction: number): { fraction: number; etaSeconds: number | null } {
    const f = Math.min(1, Math.max(0, fraction));
    const elapsed = this.elapsed();
    if (f >= 1) return { fraction: 1, etaSeconds: 0 };
    if (f < 0.005 || elapsed < 0.25) return { fraction: f, etaSeconds: null };
    return { fraction: f, etaSeconds: (elapsed * (1 - f)) / f };
  }
}
