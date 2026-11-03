/**
 * The camera path (docs/recorder.md §4 `camera.ts`): a critically damped
 * spring per axis, zoom in log space. Pure.
 *
 * The state is the viewport's centre (0..1 of the content) and ln(zoom),
 * integrated exactly (ζ = 1) four substeps a frame. With no segment in force
 * the target is the whole content (centre ½, zoom 1). Inside a segment the
 * target is its centre at its level; its anchors (merged interests) pull the
 * centre just enough to bring the anchor in force — from 0.35 s before its
 * time — into the middle 60% of the viewport; with `follow`, the cursor 150 ms
 * ahead does the same and wins. Every target and every sample keeps the
 * viewport inside the content ([0,1]²).
 *
 * A segment's `ease` governs the moves into it and out of it (into nothing):
 * `spring` (the default) springs, except that a jump farther than one zoomed
 * viewport between two zoomed targets flies van Wijk–Nuij's out-across-in path
 * (ρ 1.4, 0.8–1.0 s); `smooth` eases on a cubic over a fixed 600 ms; `cut`
 * jumps at once. Where segments overlap, the one that started last is in force.
 */
import type { CameraSample, Point, ZoomSegment, ZoomSettings } from "./types.js";
import { clamp, easeInOutCubic, lerp } from "./util.js";

/** rad/s: Quick 10, Mellow 7, Slow 5 — settles in about 4.75/ω seconds. */
export function omegaFor(feel: ZoomSettings["feel"]): number {
  return feel === "quick" ? 10 : feel === "slow" ? 5 : 7;
}

export interface CameraPathOptions {
  omega: number;
  fps: number;
  /** The cursor at a source time (view-normalized 0..1), for `follow`. */
  cursor: (tSrc: number) => Point | null;
  /** The content's width over its height (the view's), so a long jump is measured in like units both ways. Default 16/9. */
  aspect?: number;
}

/** Substeps a frame. */
const SUB = 4;
/** `smooth` moves take this long (seconds). */
export const SMOOTH_SECONDS = 0.6;
/** How far ahead `follow` looks at the cursor (seconds). */
const LOOK_AHEAD = 0.15;
/** The share of the viewport the cursor (or an anchor) may roam before the camera follows. */
const DEAD_ZONE = 0.6;
/** An anchor pulls from this long before its time (the segments' lead). */
const ANCHOR_LEAD = 0.35;
/** van Wijk–Nuij's ρ, and the zoom both ends must be at for a jump to fly. */
const RHO = 1.4;
const FLY_MIN_ZOOM = 1.15;

/**
 * One exact step of a critically damped spring (ζ = 1) toward a fixed
 * `target`: returns the new position and velocity after `dt` seconds.
 */
export function stepSpring(p: number, v: number, target: number, omega: number, dt: number): [number, number] {
  const x = p - target;
  const e = Math.exp(-omega * dt);
  const c = v + omega * x;
  return [target + (x + c * dt) * e, (v - omega * c * dt) * e];
}

/** A zoom/pan flight: total length `S` and the view at arc length `s` (centre and width in the caller's units). */
export interface ZoomFlight {
  S: number;
  at(s: number): { x: number; y: number; w: number };
}

/**
 * van Wijk & Nuij, "Smooth and efficient zooming and panning" (2003): the
 * optimal path from a view of width `w0` centred at (x0, y0) to one of width
 * `w1` at (x1, y1) — out, across, in. Positions and widths in one unit.
 */
export function vanWijkNuij(x0: number, y0: number, w0: number, x1: number, y1: number, w1: number, rho = RHO): ZoomFlight {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const d2 = dx * dx + dy * dy;
  const d1 = Math.sqrt(d2);
  const rho2 = rho * rho;
  if (d1 < 1e-9) {
    const S = Math.abs(Math.log(w1 / w0)) / rho;
    return { S, at: (s) => {
      const u = S > 0 ? clamp(s / S, 0, 1) : 1;
      return { x: x0 + u * dx, y: y0 + u * dy, w: w0 * Math.pow(w1 / w0, u) };
    } };
  }
  const b0 = (w1 * w1 - w0 * w0 + rho2 * rho2 * d2) / (2 * w0 * rho2 * d1);
  const b1 = (w1 * w1 - w0 * w0 - rho2 * rho2 * d2) / (2 * w1 * rho2 * d1);
  const r0 = -Math.asinh(b0);
  const r1 = -Math.asinh(b1);
  const S = (r1 - r0) / rho;
  const coshR0 = Math.cosh(r0);
  const sinhR0 = Math.sinh(r0);
  return { S, at: (s) => {
    const u = (w0 / (rho2 * d1)) * (coshR0 * Math.tanh(rho * s + r0) - sinhR0);
    return { x: x0 + u * dx, y: y0 + u * dy, w: (w0 * coshR0) / Math.cosh(rho * s + r0) };
  } };
}

/** The segment in force at a source time: the one that started last among those holding it. */
export function segmentAt(segments: readonly ZoomSegment[], tSrc: number): ZoomSegment | null {
  let found: ZoomSegment | null = null;
  for (const segment of segments) {
    if (segment.start <= tSrc && tSrc < segment.end && (found === null || segment.start >= found.start)) found = segment;
  }
  return found;
}

interface Target {
  x: number;
  y: number;
  lz: number;
}

type Move =
  | { kind: "smooth"; t0: number; x0: number; y0: number; lz0: number }
  | { kind: "flight"; t0: number; duration: number; flight: ZoomFlight };

/** Move `c` (one axis of the target) just enough to bring `p` inside the middle of a viewport of half-size `half`. */
function deadZone(c: number, p: number, half: number): number {
  const zone = DEAD_ZONE * half;
  if (p > c + zone) return p - zone;
  if (p < c - zone) return p + zone;
  return c;
}

function sample(x: number, y: number, lz: number): CameraSample {
  const z = Math.max(1, Math.exp(lz));
  const half = 0.5 / z;
  return { cx: clamp(x, half, 1 - half), cy: clamp(y, half, 1 - half), z };
}

/**
 * Samples at `fps` over `[0, duration]` source seconds; index = round(tSrc × fps).
 * Deterministic: the same segments, duration and options give the same path.
 */
export function cameraPath(segments: ZoomSegment[], duration: number, options: CameraPathOptions): CameraSample[] {
  const fps = options.fps > 0 ? options.fps : 60;
  const omega = options.omega > 0 ? options.omega : 7;
  const aspect = options.aspect !== undefined && options.aspect > 0 ? options.aspect : 16 / 9;
  const dt = 1 / (fps * SUB);
  const segs = segments.filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start && s.level > 0).slice().sort((a, b) => a.start - b.start);
  /** The latest end among segs[0..j], so the scan for the segment in force can stop early. */
  const reach: number[] = [];
  segs.forEach((s, j) => reach.push(Math.max(s.end, j > 0 ? (reach[j - 1] as number) : -Infinity)));
  const frames = Math.max(0, Math.floor(Math.max(0, duration) * fps + 1e-6)) + 1;
  const out: CameraSample[] = [];

  const targetAt = (seg: ZoomSegment | null, t: number): Target => {
    if (seg === null) return { x: 0.5, y: 0.5, lz: 0 };
    const level = Math.max(1, seg.level);
    const half = 0.5 / level;
    let x = seg.center[0];
    let y = seg.center[1];
    if (seg.anchors && seg.anchors.length > 0) {
      let anchor = seg.anchors[0] as [number, number, number];
      for (const a of seg.anchors) if (a[2] - ANCHOR_LEAD <= t) anchor = a;
      x = deadZone(x, anchor[0], half);
      y = deadZone(y, anchor[1], half);
    }
    if (seg.follow) {
      const p = options.cursor(t + LOOK_AHEAD);
      if (p !== null && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        x = deadZone(x, p.x, half);
        y = deadZone(y, p.y, half);
      }
    }
    return { x: clamp(x, half, 1 - half), y: clamp(y, half, 1 - half), lz: Math.log(level) };
  };

  let x = 0.5;
  let y = 0.5;
  let lz = 0;
  let vx = 0;
  let vy = 0;
  let vz = 0;
  let active: ZoomSegment | null = null;
  let move: Move | null = null;
  let started = 0;
  const steps = (frames - 1) * SUB;
  for (let i = 0; i <= steps; i++) {
    const t = i * dt;
    while (started < segs.length && (segs[started] as ZoomSegment).start <= t) started++;
    let seg: ZoomSegment | null = null;
    for (let j = started - 1; j >= 0 && (reach[j] as number) > t; j--) {
      const s = segs[j] as ZoomSegment;
      if (t < s.end) {
        seg = s;
        break;
      }
    }
    const target = targetAt(seg, t);

    if (seg !== active) {
      const ease = seg !== null ? seg.ease : (active as ZoomSegment).ease;
      move = null;
      if (ease === "cut") {
        x = target.x;
        y = target.y;
        lz = target.lz;
        vx = vy = vz = 0;
      } else if (ease === "smooth") {
        move = { kind: "smooth", t0: t, x0: x, y0: y, lz0: lz };
      } else {
        const z0 = Math.exp(lz);
        const z1 = Math.exp(target.lz);
        if (seg !== null && z0 >= FLY_MIN_ZOOM && z1 >= FLY_MIN_ZOOM && (Math.abs(target.x - x) > 1 / z0 || Math.abs(target.y - y) > 1 / z0)) {
          const flight = vanWijkNuij(x * aspect, y, aspect / z0, target.x * aspect, target.y, aspect / z1);
          move = { kind: "flight", t0: t, duration: 0.8 + 0.2 * clamp((flight.S - 1.2) / 0.8, 0, 1), flight };
        }
      }
      active = seg;
    }

    if (move !== null && move.kind === "smooth") {
      const u = (t - move.t0) / SMOOTH_SECONDS;
      if (u >= 1) {
        x = target.x;
        y = target.y;
        lz = target.lz;
        vx = vy = vz = 0;
        move = null;
      } else {
        const e = easeInOutCubic(u);
        const nx = lerp(move.x0, target.x, e);
        const ny = lerp(move.y0, target.y, e);
        const nz = lerp(move.lz0, target.lz, e);
        vx = (nx - x) / dt;
        vy = (ny - y) / dt;
        vz = (nz - lz) / dt;
        x = nx;
        y = ny;
        lz = nz;
      }
    } else if (move !== null && move.kind === "flight") {
      const u = (t - move.t0) / move.duration;
      const at = move.flight.at(move.flight.S * easeInOutCubic(Math.min(1, u)));
      const nx = at.x / aspect;
      const ny = at.y;
      const nz = Math.log(aspect / at.w);
      if (u >= 1) {
        vx = vy = vz = 0;
        move = null;
      } else {
        vx = (nx - x) / dt;
        vy = (ny - y) / dt;
        vz = (nz - lz) / dt;
      }
      x = nx;
      y = ny;
      lz = nz;
    }
    // The state now is the camera at `t`; the spring then carries it to `t + dt`.
    if (i % SUB === 0) out.push(sample(x, y, lz));
    if (move === null) {
      [x, vx] = stepSpring(x, vx, target.x, omega, dt);
      [y, vy] = stepSpring(y, vy, target.y, omega, dt);
      [lz, vz] = stepSpring(lz, vz, target.lz, omega, dt);
    }
  }
  return out;
}

/** The camera at a source time, interpolated between the path's samples (zoom in log space); the ends held. */
export function cameraAt(path: CameraSample[], fps: number, tSrc: number): CameraSample {
  const n = path.length;
  if (n === 0) return { cx: 0.5, cy: 0.5, z: 1 };
  const f = Number.isFinite(tSrc) ? tSrc * (fps > 0 ? fps : 60) : 0;
  if (f <= 0) return { ...(path[0] as CameraSample) };
  if (f >= n - 1) return { ...(path[n - 1] as CameraSample) };
  const i = Math.floor(f);
  const u = f - i;
  const a = path[i] as CameraSample;
  const b = path[i + 1] as CameraSample;
  return sample(lerp(a.cx, b.cx, u), lerp(a.cy, b.cy, u), lerp(Math.log(a.z), Math.log(b.z), u));
}

/**
 * The part of the content the camera shows, normalized to the content (0..1):
 * `1/z` wide around the centre. `aspect` is the shown region's width over its
 * height relative to the content's — 1 (the default) when the content quad
 * keeps the view's shape, which is how `render` draws it.
 */
export function viewportOf(sample: CameraSample, aspect = 1): { x: number; y: number; w: number; h: number } {
  const w = 1 / Math.max(1, sample.z);
  const h = w / (aspect > 0 ? aspect : 1);
  return { x: sample.cx - w / 2, y: sample.cy - h / 2, w, h };
}
