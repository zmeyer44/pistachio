/**
 * Speed ramps and dead-time cuts (docs/recorder.md §4 `speed.ts`). Pure.
 *
 * - Idle: the complement of `activeIntervals` (input within ±0.3 s, a pointer
 *   move over 3 px, the page painting) longer than `idleMin`: keep
 *   `idleKeepHead` of head and `idleKeepTail` of tail, then a rate of
 *   `clamp(len / 0.6, 2, maxRate)` — or a cut (`rate: Infinity`) when the idle
 *   lasts past `idleCut`.
 * - Typing: bursts of ≥ `typingKeys` char keys over ≥ `typingMin` s at
 *   `typingRate` (`typingRateLong` past 6 s).
 * - Loading: `load` spans over `loadMin` at `loadRate`.
 * - Where these overlap, the faster wins. Then never while the mic hears speech
 *   and never within 0.5 s of a click (any button); pieces under 0.5 s are
 *   dropped. Ids `s1…` in time order. Times are source seconds.
 *
 * The rates are eased over `ramp` by the time map (`timemap.ts`), not here.
 */
import type { RecordedEvent, SpeedSegment } from "./types.js";
import { activeIntervals, clicksOf, loadsOf, typingBursts } from "./events.js";
import { type Interval, clamp, complementIntervals, mergeIntervals, subtractIntervals } from "./util.js";

export interface SpeedTuning {
  idleMin: number; idleKeepHead: number; idleKeepTail: number; idleCut: number; typingMin: number; typingKeys: number; typingRate: number; typingRateLong: number; loadMin: number; loadRate: number; maxRate: number; ramp: number;
  /** Seconds kept at real time on each side of a click. */
  clickGuard: number;
  /** Pieces shorter than this (seconds) are dropped. */
  minLen: number;
  /** An idle stretch is sped so it lasts about this long (seconds) in the output. */
  idleTarget: number;
  /** Typing past this long (seconds) takes `typingRateLong`. */
  typingLong: number;
}

export const SPEED_DEFAULTS: SpeedTuning = { idleMin: 1.5, idleKeepHead: 0.4, idleKeepTail: 0.3, idleCut: 6, typingMin: 2, typingKeys: 10, typingRate: 2, typingRateLong: 3, loadMin: 1.0, loadRate: 4, maxRate: 8, ramp: 0.25, clickGuard: 0.5, minLen: 0.5, idleTarget: 0.6, typingLong: 6 };

/** Speech: a level over this (dBFS) … */
export const SPEECH_DBFS = -40;
/** … for at least this long (seconds), held this long after it falls. */
export const SPEECH_MIN = 0.3;
export const SPEECH_HANGOVER = 0.2;

/**
 * Intervals (source seconds) where the mic hears speech, from `mic.levels`
 * (linear RMS, 0..1, at `hz`): frames over −40 dBFS, dips shorter than the
 * 200 ms hangover bridged, runs of at least 300 ms kept and held 200 ms past
 * their end.
 */
export function speechIntervals(levels: Float32Array | null, hz = 50): [number, number][] {
  if (levels === null || levels.length === 0 || !(hz > 0)) return [];
  const threshold = Math.pow(10, SPEECH_DBFS / 20);
  const runs: Interval[] = [];
  let open = -1;
  for (let i = 0; i <= levels.length; i++) {
    const level = i < levels.length ? (levels[i] as number) : 0;
    const loud = Number.isFinite(level) && Math.abs(level) > threshold;
    if (loud && open < 0) open = i;
    else if (!loud && open >= 0) {
      runs.push([open / hz, i / hz]);
      open = -1;
    }
  }
  const bridged: Interval[] = [];
  for (const run of runs) {
    const last = bridged[bridged.length - 1];
    if (last && run[0] - last[1] <= SPEECH_HANGOVER) last[1] = run[1];
    else bridged.push([run[0], run[1]]);
  }
  const end = levels.length / hz;
  return mergeIntervals(bridged.filter(([a, b]) => b - a >= SPEECH_MIN - 1e-9).map(([a, b]): Interval => [a, Math.min(end, b + SPEECH_HANGOVER)]));
}

interface Piece {
  start: number;
  end: number;
  rate: number;
  auto: "idle" | "typing" | "loading";
}

export function speedPlan(events: RecordedEvent[], duration: number, speech: [number, number][], tuning?: Partial<SpeedTuning>): SpeedSegment[] {
  const T = { ...SPEED_DEFAULTS, ...tuning };
  const candidates: Piece[] = [];

  for (const [a0, b0] of complementIntervals(activeIntervals(events), 0, Math.max(0, duration))) {
    const length = b0 - a0;
    if (length <= T.idleMin) continue;
    const start = a0 + T.idleKeepHead;
    const end = b0 - T.idleKeepTail;
    if (end <= start) continue;
    const rate = length > T.idleCut ? Infinity : clamp((end - start) / T.idleTarget, 2, T.maxRate);
    candidates.push({ start, end, rate, auto: "idle" });
  }
  for (const burst of typingBursts(events)) {
    const length = burst.t1 - burst.t0;
    if (burst.count >= T.typingKeys && length >= T.typingMin) candidates.push({ start: burst.t0, end: burst.t1, rate: length > T.typingLong ? T.typingRateLong : T.typingRate, auto: "typing" });
  }
  for (const [a, b] of loadsOf(events, duration)) {
    if (b - a > T.loadMin) candidates.push({ start: a, end: Math.min(b, duration), rate: T.loadRate, auto: "loading" });
  }

  // Overlaps: the faster wins (a cut is fastest).
  candidates.sort((p, q) => q.rate - p.rate || p.start - q.start);
  const placed: Piece[] = [];
  for (const piece of candidates) {
    for (const [start, end] of subtractIntervals([piece.start, piece.end], placed.map((p): Interval => [p.start, p.end]))) placed.push({ ...piece, start, end });
  }

  // Never over speech, never near a click.
  const spared: Interval[] = [...speech.map(([a, b]): Interval => [a, b]), ...clicksOf(events).map((c): Interval => [c.t - T.clickGuard, c.t + T.clickGuard])];
  const out: Piece[] = [];
  for (const piece of placed) {
    for (const [start, end] of subtractIntervals([piece.start, piece.end], spared)) {
      if (end - start >= T.minLen) out.push({ ...piece, start, end });
    }
  }
  out.sort((p, q) => p.start - q.start);
  return out.map((p, i) => ({ id: `s${i + 1}`, start: round(p.start), end: round(p.end), rate: p.rate === Infinity ? Infinity : round(p.rate), auto: p.auto }));
}

function round(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

/**
 * Re-solving after edits: every segment the person made or touched
 * (`auto: null`) stays; a solved one joins only where it overlaps none of
 * them, with a fresh id after the highest `s<n>` in use. Sorted by start.
 */
export function replaceAutoSpeed(current: readonly SpeedSegment[], solved: readonly SpeedSegment[]): SpeedSegment[] {
  const kept = current.filter((segment) => segment.auto === null);
  let next = 1;
  for (const segment of kept) {
    const n = /^s(\d+)$/.exec(segment.id);
    if (n) next = Math.max(next, Number(n[1]) + 1);
  }
  const added = solved.filter((s) => !kept.some((k) => s.start < k.end && k.start < s.end)).map((s) => ({ ...s, id: `s${next++}` }));
  return [...kept, ...added].sort((a, b) => a.start - b.start);
}
