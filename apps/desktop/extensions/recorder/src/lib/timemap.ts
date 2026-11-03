/**
 * Output time ↔ source time over the cuts and the speed segments
 * (docs/recorder.md §4). Pure.
 *
 * Kept source = the cuts (clamped to the source, merged; none at all means the
 * whole source) minus every speed segment of rate Infinity. Inside it,
 * `tOut(tSrc) = ∫ 1 / rate`, where a segment's rate is eased from 1 over
 * `ramp` seconds at each of its ends (smoothstep on the rate, inside the
 * segment; a segment shorter than two ramps eases over half its length).
 * Where segments overlap, the one that started last is in force.
 *
 * The integral is tabulated at 240 Hz of source time (Simpson's rule per step)
 * and both directions interpolate the same knots linearly, so the map is
 * monotonic and `toSource(toOutput(s))` returns `s` for any kept `s`, to float
 * precision. At a join the output time maps to the source after the jump.
 */
import type { Cut, SpeedSegment, TimeMap } from "./types.js";
import { type Interval, clamp, mergeIntervals, smoothstep, subtractIntervals, upperBound } from "./util.js";

/** Knots per source second. */
const TABLE_HZ = 240;

/** The eased rate at a source time over the finite speed segments (1 outside them). */
export function rateCurve(speed: readonly SpeedSegment[], ramp = 0.25): (tSrc: number) => number {
  const finite = speed.filter((s) => Number.isFinite(s.rate) && s.rate > 0 && s.end > s.start).slice().sort((a, b) => a.start - b.start);
  return (t) => {
    let found: SpeedSegment | null = null;
    for (const s of finite) {
      if (s.start > t) break;
      if (t < s.end) found = s;
    }
    if (found === null) return 1;
    const a = Math.min(Math.max(ramp, 1e-6), (found.end - found.start) / 2);
    const envelope = Math.min(smoothstep((t - found.start) / a), smoothstep((found.end - t) / a));
    return 1 + (found.rate - 1) * envelope;
  };
}

/**
 * The source ranges played, in order: the cuts minus the Infinity-rate
 * segments. A `sourceDuration` that is not positive (the media's length not
 * known yet) falls back to the last cut's end.
 */
export function keptRanges(cuts: readonly Cut[], speed: readonly SpeedSegment[], sourceDuration: number): Interval[] {
  const known = Number.isFinite(sourceDuration) && sourceDuration > 0;
  const end = known ? sourceDuration : Math.max(0, ...cuts.map((c) => c.out).filter(Number.isFinite));
  const clips = cuts.filter((c) => Number.isFinite(c.in) && Number.isFinite(c.out)).map((c): Interval => [clamp(c.in, 0, end), clamp(c.out, 0, end)]);
  const base = cuts.length === 0 ? [[0, end] as Interval] : mergeIntervals(clips);
  const removed = speed.filter((s) => s.rate === Infinity && s.end > s.start).map((s): Interval => [s.start, s.end]);
  const out: Interval[] = [];
  for (const range of base) for (const piece of subtractIntervals(range, removed)) if (piece[1] - piece[0] > 1e-9) out.push(piece);
  return out;
}

export function timeMap(cuts: Cut[], speed: SpeedSegment[], sourceDuration: number, rampSeconds = 0.25): TimeMap {
  const ranges = keptRanges(cuts, speed, sourceDuration);
  const rate = rateCurve(speed, rampSeconds);
  const inverse = (t: number) => 1 / Math.max(1e-6, rate(t));

  let total = 0;
  for (const [a, b] of ranges) total += Math.ceil((b - a) * TABLE_HZ) + 1;
  const src = new Float64Array(total);
  const out = new Float64Array(total);
  const joins: { tOut: number; from: number; to: number }[] = [];
  let k = 0;
  let acc = 0;
  let previousEnd: number | null = null;
  for (const [a, b] of ranges) {
    if (previousEnd !== null) joins.push({ tOut: acc, from: previousEnd, to: a });
    const steps = Math.ceil((b - a) * TABLE_HZ);
    const h = (b - a) / steps;
    src[k] = a;
    out[k] = acc;
    k++;
    for (let i = 0; i < steps; i++) {
      const s0 = a + i * h;
      const s1 = i === steps - 1 ? b : a + (i + 1) * h;
      acc += ((s1 - s0) / 6) * (inverse(s0) + 4 * inverse((s0 + s1) / 2) + inverse(s1));
      src[k] = s1;
      out[k] = acc;
      k++;
    }
    previousEnd = b;
  }
  const duration = acc;
  const n = k;

  const toOutput = (tSrc: number): number => {
    if (n === 0 || !Number.isFinite(tSrc)) return 0;
    if (tSrc <= (src[0] as number)) return 0;
    if (tSrc >= (src[n - 1] as number)) return duration;
    const i = upperBound(src, tSrc) - 1;
    const s0 = src[i] as number;
    const s1 = src[i + 1] as number;
    const o0 = out[i] as number;
    const o1 = out[i + 1] as number;
    return s1 > s0 ? o0 + ((o1 - o0) * (tSrc - s0)) / (s1 - s0) : o1;
  };

  const toSource = (tOut: number): number => {
    if (n === 0) return 0;
    if (!Number.isFinite(tOut) || tOut <= 0) return src[0] as number;
    if (tOut >= duration) return src[n - 1] as number;
    const i = upperBound(out, tOut) - 1;
    if (i >= n - 1) return src[n - 1] as number;
    const o0 = out[i] as number;
    const o1 = out[i + 1] as number;
    const s0 = src[i] as number;
    const s1 = src[i + 1] as number;
    return o1 > o0 ? s0 + ((s1 - s0) * (tOut - o0)) / (o1 - o0) : s1;
  };

  return {
    toSource,
    toOutput,
    duration,
    rateAt(tOut: number): number {
      for (const join of joins) if (Math.abs(join.tOut - tOut) < 1e-9) return Infinity;
      return rate(toSource(tOut));
    },
    joins,
  };
}
