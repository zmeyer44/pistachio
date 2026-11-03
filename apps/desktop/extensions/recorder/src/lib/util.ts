/**
 * Small pure helpers the solvers share: numbers, easing, intervals, rects,
 * searches. Internal to `src/lib/` (not re-exported by `index.ts`).
 */
import type { Point, Rect, Size } from "./types.js";

/** `[start, end]` in source seconds. */
export type Interval = [number, number];

export function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

export function lerp(a: number, b: number, u: number): number {
  return a + (b - a) * u;
}

export function smoothstep(u: number): number {
  const x = clamp(u, 0, 1);
  return x * x * (3 - 2 * x);
}

export function easeInOutCubic(u: number): number {
  const x = clamp(u, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

export function easeOutCubic(u: number): number {
  const x = clamp(u, 0, 1);
  return 1 - Math.pow(1 - x, 3);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

// ── Searches over sorted arrays ──────────────────────────────────────────────

/** The first index whose value is greater than `x` (`length` when none is). */
export function upperBound(values: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((values[mid] as number) <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The last index whose value is at most `x` (−1 when none is). */
export function lastAtOrBefore(values: ArrayLike<number>, x: number): number {
  return upperBound(values, x) - 1;
}

// ── Intervals (source seconds) ───────────────────────────────────────────────

/** Sorted, with overlapping or touching intervals joined; empty ones dropped. */
export function mergeIntervals(list: readonly Interval[]): Interval[] {
  const sorted = list.filter(([a, b]) => b > a).map(([a, b]): Interval => [a, b]).sort((p, q) => p[0] - q[0]);
  const out: Interval[] = [];
  for (const interval of sorted) {
    const last = out[out.length - 1];
    if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
    else out.push(interval);
  }
  return out;
}

/** Intervals that overlap, joined; ones that merely touch stay apart (a clip split in two is two clips, `[0,12]` and `[12,30]`). */
export function mergeOverlappingIntervals(list: readonly Interval[]): Interval[] {
  const sorted = list.filter(([a, b]) => b > a).map(([a, b]): Interval => [a, b]).sort((p, q) => p[0] - q[0]);
  const out: Interval[] = [];
  for (const interval of sorted) {
    const last = out[out.length - 1];
    if (last && interval[0] < last[1]) last[1] = Math.max(last[1], interval[1]);
    else out.push(interval);
  }
  return out;
}

/** What `[lo, hi]` holds outside the (merged) intervals. */
export function complementIntervals(list: readonly Interval[], lo: number, hi: number): Interval[] {
  const out: Interval[] = [];
  let cursor = lo;
  for (const [a, b] of mergeIntervals(list)) {
    if (b <= cursor) continue;
    if (a >= hi) break;
    if (a > cursor) out.push([cursor, Math.min(a, hi)]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < hi) out.push([cursor, hi]);
  return out;
}

/** `interval` with every cutter removed: zero, one or several pieces. */
export function subtractIntervals(interval: Interval, cutters: readonly Interval[]): Interval[] {
  let pieces: Interval[] = [[interval[0], interval[1]]];
  for (const [ca, cb] of cutters) {
    if (cb <= ca) continue;
    const next: Interval[] = [];
    for (const [a, b] of pieces) {
      if (cb <= a || ca >= b) {
        next.push([a, b]);
        continue;
      }
      if (ca > a) next.push([a, ca]);
      if (cb < b) next.push([cb, b]);
    }
    pieces = next;
    if (pieces.length === 0) break;
  }
  return pieces;
}

// ── Rects (view CSS px) ──────────────────────────────────────────────────────

export function area(rect: Size): number {
  return Math.max(0, rect.w) * Math.max(0, rect.h);
}

export function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function rectCenter(rect: Rect): Point {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

/** The rect grown on every side by `fraction` of its own size. */
export function padRect(rect: Rect, fraction: number): Rect {
  const dx = rect.w * fraction;
  const dy = rect.h * fraction;
  return { x: rect.x - dx, y: rect.y - dy, w: rect.w + 2 * dx, h: rect.h + 2 * dy };
}

export function isRect(value: unknown): value is Rect {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return isFiniteNumber(r.x) && isFiniteNumber(r.y) && isFiniteNumber(r.w) && isFiniteNumber(r.h) && (r.w as number) >= 0 && (r.h as number) >= 0;
}
