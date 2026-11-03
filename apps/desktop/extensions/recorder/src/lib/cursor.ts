/**
 * The cursor path (docs/recorder.md §4 `cursor.ts`). Pure.
 *
 * - `natural`: the raw pointer (`pointerAt`), so the drawn cursor covers the
 *   one Chromium bakes into the capture (R5).
 * - `smooth`: the pointer resampled at 120 Hz and followed by the camera's
 *   exact critically damped spring, ω from 40 (smoothing 0, tight) to 12
 *   (smoothing 1, floaty).
 * - `glide`: strokes (split where the pointer sat still and at clicks)
 *   simplified by Douglas–Peucker (6 px) and drawn through by a centripetal
 *   Catmull–Rom spline, each keypoint keeping its time.
 * - `hidden`: no cursor (`at` returns null).
 *
 * Every click pins the path back to the raw pointer over −120/+80 ms
 * (smoothstep), so the cursor is exactly where the click landed. Idle (with
 * `hideIdle`): fades out over 0.3 s after 2 s without a move over 3 px, back in
 * over 0.1 s on the next one; `visible` is false once fully faded, while the
 * view is covered (`box.visible`), and for the `none` cursor. Clicks: `press`
 * rises and falls (sine) over 90 ms — the renderer scales the sprite to 0.85 at
 * 1 — and `ripple` runs 0 → 1 over 400 ms (0 = no ring); `click: "none"` turns
 * both off. `type` is the latest `cursor` event's (`default` before any).
 */
import type { CursorSample, CursorSpec, RecordedEvent } from "./types.js";
import { type PointerTrack, clicksOf, pointerMoves, pointerTrack, trackAt, POINTER_HOLD_GAP, POINTER_MOVE_LEAD } from "./events.js";
import { stepSpring } from "./camera.js";
import { lastAtOrBefore, lerp, smoothstep } from "./util.js";

export interface CursorPath {
  at(tSrc: number): CursorSample | null;
}

export const CURSOR_TUNING = {
  /** Resampling rate (Hz). */
  hz: 120,
  /** ω (rad/s) for smoothing 0 and 1. */
  tight: 40,
  floaty: 12,
  /** Clicks pin to the raw pointer from this long before to this long after (s). */
  pinBefore: 0.12,
  pinAfter: 0.08,
  /** Idle: still this long (s), then fade out over `fadeOut`; back in over `fadeIn` on a move over `wakePx`. */
  idleAfter: 2,
  fadeOut: 0.3,
  fadeIn: 0.1,
  wakePx: 3,
  /** Click effect lengths (s). */
  press: 0.09,
  ripple: 0.4,
  /** Douglas–Peucker tolerance (view CSS px). */
  glideTolerance: 6,
};

interface Key {
  t: number;
  x: number;
  y: number;
  stroke: number;
}

/**
 * Douglas–Peucker over a polyline: the indices kept (always the first and the
 * last), every dropped point within `tolerance` of the simplified line.
 */
export function douglasPeucker(xs: ArrayLike<number>, ys: ArrayLike<number>, from: number, to: number, tolerance: number): number[] {
  if (to <= from) return [from];
  const keep = new Uint8Array(to - from + 1);
  keep[0] = 1;
  keep[to - from] = 1;
  const stack: [number, number][] = [[from, to]];
  while (stack.length > 0) {
    const [a, b] = stack.pop() as [number, number];
    let worst = -1;
    let worstDistance = tolerance;
    for (let i = a + 1; i < b; i++) {
      const d = segmentDistance(xs[i] as number, ys[i] as number, xs[a] as number, ys[a] as number, xs[b] as number, ys[b] as number);
      if (d > worstDistance) {
        worstDistance = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst - from] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < keep.length; i++) if (keep[i]) out.push(from + i);
  return out;
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const u = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + u * dx), py - (ay + u * dy));
}

/** A centripetal (α = ½) Catmull–Rom point between p1 and p2 at `u` ∈ [0, 1] (Barry–Goldman). */
export function catmullRom(p0: { x: number; y: number }, p1: { x: number; y: number }, p2: { x: number; y: number }, p3: { x: number; y: number }, u: number): { x: number; y: number } {
  const knot = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.max(Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)), 1e-4);
  const t0 = 0;
  const t1 = t0 + knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const t = t1 + (t2 - t1) * u;
  const mix = (a: { x: number; y: number }, b: { x: number; y: number }, ta: number, tb: number) => {
    const s = (t - ta) / (tb - ta);
    return { x: a.x + (b.x - a.x) * s, y: a.y + (b.y - a.y) * s };
  };
  const a1 = mix(p0, p1, t0, t1);
  const a2 = mix(p1, p2, t1, t2);
  const a3 = mix(p2, p3, t2, t3);
  const b1 = mix(a1, a2, t0, t2);
  const b2 = mix(a2, a3, t1, t3);
  return mix(b1, b2, t1, t2);
}

/** The glide keypoints: strokes split at still gaps and clicks, each simplified. */
function glideKeys(track: PointerTrack, clickTimes: readonly number[], tolerance: number): Key[] {
  const n = track.t.length;
  const keys: Key[] = [];
  let stroke = 0;
  let start = 0;
  const clickSet = new Set(clickTimes);
  const flush = (end: number) => {
    for (const i of douglasPeucker(track.x, track.y, start, end, tolerance)) {
      const last = keys[keys.length - 1];
      if (last && last.stroke === stroke && last.t === track.t[i]) continue;
      keys.push({ t: track.t[i] as number, x: track.x[i] as number, y: track.y[i] as number, stroke });
    }
    stroke += 1;
  };
  for (let i = 0; i < n - 1; i++) {
    const gap = (track.t[i + 1] as number) - (track.t[i] as number) > POINTER_HOLD_GAP;
    if (gap || clickSet.has(track.t[i] as number)) {
      flush(i);
      start = gap ? i + 1 : i;
    }
  }
  flush(n - 1);
  return keys;
}

function glideAt(keys: readonly Key[], keyTimes: Float64Array, t: number): { x: number; y: number } {
  const last = keys.length - 1;
  const j = lastAtOrBefore(keyTimes, t);
  if (j < 0) return keys[0] as Key;
  if (j >= last) return keys[last] as Key;
  const p1 = keys[j] as Key;
  const p2 = keys[j + 1] as Key;
  if (p1.stroke !== p2.stroke) {
    // Between strokes the pointer sat still: hold, then move in the last moment (as `trackAt` does).
    const from = p2.t - p1.t > POINTER_HOLD_GAP ? p2.t - POINTER_MOVE_LEAD : p1.t;
    const u = t <= from ? 0 : (t - from) / Math.max(p2.t - from, 1e-9);
    return { x: lerp(p1.x, p2.x, u), y: lerp(p1.y, p2.y, u) };
  }
  const before = keys[j - 1];
  const after = keys[j + 2];
  const p0 = before && before.stroke === p1.stroke ? before : p1;
  const p3 = after && after.stroke === p2.stroke ? after : p2;
  const u = p2.t > p1.t ? (t - p1.t) / (p2.t - p1.t) : 1;
  return catmullRom(p0, p1, p2, p3, u);
}

export function cursorPath(events: RecordedEvent[], spec: CursorSpec): CursorPath {
  if (spec.mode === "hidden") return { at: () => null };
  const T = CURSOR_TUNING;
  const track = pointerTrack(events);
  const n = track.t.length;
  if (n === 0) return { at: () => null };
  const first = track.t[0] as number;
  const lastT = track.t[n - 1] as number;
  const clickTimes = clicksOf(events).map((c) => c.t);

  /** How much a click pins the path to the raw pointer at `t` (0..1, 1 at the click). */
  const pinAt = (t: number) => {
    let w = 0;
    for (let i = lastAtOrBefore(clickTimes, t + T.pinBefore); i >= 0; i--) {
      const tc = clickTimes[i] as number;
      if (tc < t - T.pinAfter) break;
      w = Math.max(w, tc >= t ? smoothstep(1 - (tc - t) / T.pinBefore) : smoothstep(1 - (t - tc) / T.pinAfter));
    }
    return w;
  };

  // The smoothed or glided path on a 120 Hz grid (natural reads the raw track).
  let gridX: Float64Array | null = null;
  let gridY: Float64Array | null = null;
  const count = Math.floor((lastT - first) * T.hz) + 2;
  if (spec.mode === "smooth" || spec.mode === "glide") {
    gridX = new Float64Array(count);
    gridY = new Float64Array(count);
    const dt = 1 / T.hz;
    if (spec.mode === "smooth") {
      const omega = lerp(T.tight, T.floaty, Math.max(0, Math.min(1, spec.smoothing)));
      let px = track.x[0] as number;
      let py = track.y[0] as number;
      let vx = 0;
      let vy = 0;
      let prev = { x: px, y: py };
      for (let k = 0; k < count; k++) {
        const t = first + k * dt;
        const raw = trackAt(track, t) ?? prev;
        if (k > 0) {
          [px, vx] = stepSpring(px, vx, raw.x, omega, dt);
          [py, vy] = stepSpring(py, vy, raw.y, omega, dt);
          const w = pinAt(t);
          if (w > 0) {
            px = lerp(px, raw.x, w);
            py = lerp(py, raw.y, w);
            vx = lerp(vx, (raw.x - prev.x) / dt, w);
            vy = lerp(vy, (raw.y - prev.y) / dt, w);
          }
        }
        gridX[k] = px;
        gridY[k] = py;
        prev = raw;
      }
    } else {
      const keys = glideKeys(track, clickTimes, T.glideTolerance);
      const keyTimes = Float64Array.from(keys, (key) => key.t);
      for (let k = 0; k < count; k++) {
        const p = glideAt(keys, keyTimes, first + k * dt);
        gridX[k] = p.x;
        gridY[k] = p.y;
      }
    }
  }

  // Idle: the times the pointer really moved, and the wakes after an idle.
  const moves = pointerMoves(events, T.wakePx);
  const fadeOutAt = (still: number) => 1 - smoothstep((still - T.idleAfter) / T.fadeOut);
  const wakeTimes: number[] = [];
  const wakeFrom: number[] = [];
  for (let i = 1; i < moves.length; i++) {
    const gap = (moves[i] as number) - (moves[i - 1] as number);
    if (gap >= T.idleAfter) {
      wakeTimes.push(moves[i] as number);
      wakeFrom.push(fadeOutAt(gap));
    }
  }
  const fadeAt = (t: number) => {
    if (!spec.hideIdle) return 1;
    const j = lastAtOrBefore(moves, t);
    let fade = j < 0 ? 1 : fadeOutAt(t - (moves[j] as number));
    const w = lastAtOrBefore(wakeTimes, t);
    if (w >= 0) {
      const since = t - (wakeTimes[w] as number);
      if (since < T.fadeIn) {
        const from = wakeFrom[w] as number;
        fade = Math.min(fade, from + (1 - from) * smoothstep(since / T.fadeIn));
      }
    }
    return fade;
  };

  const boxTimes: number[] = [];
  const boxVisible: boolean[] = [];
  const typeTimes: number[] = [];
  const types: string[] = [];
  for (const event of events) {
    if (event.k === "box") {
      boxTimes.push(event.t / 1000);
      boxVisible.push(event.visible);
    } else if (event.k === "cursor") {
      typeTimes.push(event.t / 1000);
      types.push(event.type);
    }
  }

  return {
    at(tSrc: number): CursorSample | null {
      if (!Number.isFinite(tSrc) || tSrc < first) return null;
      const raw = trackAt(track, tSrc) as { x: number; y: number };
      let x = raw.x;
      let y = raw.y;
      if (gridX !== null && gridY !== null) {
        const f = Math.min((tSrc - first) * T.hz, count - 1);
        const k = Math.min(Math.floor(f), count - 2);
        const u = f - k;
        x = lerp(gridX[k] as number, gridX[k + 1] as number, u);
        y = lerp(gridY[k] as number, gridY[k + 1] as number, u);
        const w = pinAt(tSrc);
        if (w > 0) {
          x = lerp(x, raw.x, w);
          y = lerp(y, raw.y, w);
        }
      }
      const ti = lastAtOrBefore(typeTimes, tSrc);
      const type = ti >= 0 ? (types[ti] as string) : "default";
      const bi = lastAtOrBefore(boxTimes, tSrc);
      const shown = bi < 0 || (boxVisible[bi] as boolean);
      const fade = fadeAt(tSrc);
      let press = 0;
      let ripple = 0;
      const ci = lastAtOrBefore(clickTimes, tSrc);
      if (ci >= 0 && spec.click !== "none") {
        const since = tSrc - (clickTimes[ci] as number);
        if (since < T.press) press = Math.sin((Math.PI * since) / T.press);
        if (since < T.ripple) ripple = since / T.ripple;
      }
      return { x, y, type, visible: fade > 0 && shown && type !== "none", press, ripple, fade };
    },
  };
}
