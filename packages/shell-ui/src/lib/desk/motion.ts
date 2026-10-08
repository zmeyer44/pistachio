/**
 * The desk's motion (components/desk): springs, a velocity read from the
 * pointer's last moments, and the coast of a thrown window. Seconds and
 * pixels throughout; velocities are px/s.
 *
 * Springs are described the way a person tunes them — how long a swing
 * takes (`response`) and how much of it dies each swing (`damping`, 1 =
 * none past the target) — and stepped in small substeps, so a dropped frame
 * never makes one explode.
 *
 * Pure on purpose — no DOM — so vitest pins it under node.
 */

export interface SpringConfig {
  /** Seconds for one undamped swing. */
  response: number;
  /** 1 settles without overshoot; below it, bounces. */
  damping: number;
}

export type SpringPreset = "snappy" | "bouncy" | "smooth";

export const SPRING_PRESETS: Record<SpringPreset, SpringConfig> = {
  snappy: { response: 0.26, damping: 0.86 },
  bouncy: { response: 0.42, damping: 0.56 },
  smooth: { response: 0.48, damping: 1 },
};

const SUBSTEP_S = 1 / 240;

/** One damped spring axis, `dt` seconds on. */
export function stepSpring(x: number, v: number, target: number, spring: SpringConfig, dt: number): { x: number; v: number } {
  const stiffness = (2 * Math.PI / spring.response) ** 2;
  const friction = (4 * Math.PI * spring.damping) / spring.response;
  let position = x;
  let velocity = v;
  let remaining = Math.max(0, dt);
  while (remaining > 1e-9) {
    const h = Math.min(remaining, SUBSTEP_S);
    const acceleration = -stiffness * (position - target) - friction * velocity;
    velocity += acceleration * h;
    position += velocity * h;
    remaining -= h;
  }
  return { x: position, v: velocity };
}

/** Close enough, and slow enough, to call it arrived. */
export function springAtRest(x: number, v: number, target: number, epsilon = 0.4, speed = 6): boolean {
  return Math.abs(x - target) <= epsilon && Math.abs(v) <= speed;
}

/** How long a thrown window keeps its speed: after this many seconds it has lost 63% of it. */
export const GLIDE_TAU_S = 0.3;
/** Below this a coasting window has stopped. */
export const GLIDE_STOP_SPEED = 40;
/** The share of its speed a window keeps when it bounces off an edge. */
export const BOUNCE_RESTITUTION = 0.42;

/**
 * Glide's deceleration as a person sets it (the dock's Feel settings): the
 * share of its speed a coasting window loses every 100 ms, in percent.
 * The default, 28, is a coast of about GLIDE_TAU_S.
 */
export const GLIDE_DECELERATION = { min: 6, max: 60, default: 28 } as const;

/** The coast's time constant (seconds to lose 63% of its speed) for a deceleration in percent per 100 ms. */
export function glideTauFor(deceleration: number): number {
  const lost = clamp(deceleration, GLIDE_DECELERATION.min, GLIDE_DECELERATION.max) / 100;
  return -0.1 / Math.log(1 - lost);
}

/** Speed after `dt` seconds of coasting. */
export function glideDecay(v: number, dt: number, tau = GLIDE_TAU_S): number {
  return v * Math.exp(-dt / tau);
}

/** How far a throw at `v` coasts before it stops — where the window is headed. */
export function glideReach(v: number, tau = GLIDE_TAU_S): number {
  return v * tau;
}

/**
 * The pointer's velocity at release, from its last moments.
 *
 * A least-squares slope over the samples of the last `windowMs` — one
 * noisy sample cannot fling a window — and zero when the pointer stood
 * still before letting go, since a person who paused and then released
 * meant to place the window, not to throw it.
 */
export class VelocityTracker {
  readonly #samples: Array<{ x: number; y: number; t: number }> = [];
  readonly #windowMs: number;

  constructor(windowMs = 90) {
    this.#windowMs = windowMs;
  }

  push(x: number, y: number, t: number): void {
    const last = this.#samples[this.#samples.length - 1];
    if (last !== undefined && t <= last.t) {
      last.x = x;
      last.y = y;
      return;
    }
    this.#samples.push({ x, y, t });
    while (this.#samples.length > 2 && t - this.#samples[0]!.t > this.#windowMs * 2) this.#samples.shift();
  }

  reset(): void {
    this.#samples.length = 0;
  }

  velocity(now: number): { x: number; y: number } {
    const last = this.#samples[this.#samples.length - 1];
    if (last === undefined || now - last.t > 70) return { x: 0, y: 0 };
    const recent = this.#samples.filter((sample) => last.t - sample.t <= this.#windowMs);
    if (recent.length < 2) return { x: 0, y: 0 };
    const meanT = recent.reduce((sum, s) => sum + s.t, 0) / recent.length;
    const meanX = recent.reduce((sum, s) => sum + s.x, 0) / recent.length;
    const meanY = recent.reduce((sum, s) => sum + s.y, 0) / recent.length;
    let tt = 0;
    let tx = 0;
    let ty = 0;
    for (const sample of recent) {
      const dt = sample.t - meanT;
      tt += dt * dt;
      tx += dt * (sample.x - meanX);
      ty += dt * (sample.y - meanY);
    }
    if (tt <= 0) return { x: 0, y: 0 };
    // Per millisecond → per second.
    return { x: (tx / tt) * 1_000, y: (ty / tt) * 1_000 };
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/*
 * Timed motion, for the desk's smaller moves (a minimized window raised
 * from the shelf, going back down, moving along it): a duration and an
 * easing curve, as CSS has them, rather than a spring. The values are
 * transitions.dev's motion tokens (its transitions-polish skill), matched
 * by what the motion does: a hover lift in is quick and direct, a close
 * quicker still, a position change as quick as a lift — all on the smooth
 * ease-out, which never overshoots.
 */

/** `--duration-fast`: a hover lift in, a position change. */
export const DURATION_FAST_MS = 250;
/** `--duration-quick`: a close (the lift going back down). */
export const DURATION_QUICK_MS = 150;
/** `--duration-micro`: an intent gate, filtering what is not meant (the pointer crossing between a window's frame and its page). */
export const DURATION_MICRO_MS = 80;
/** `--duration-stagger`: one item of a sequence after the one before. */
export const DURATION_STAGGER_MS = 40;
/** A stagger's whole run (offset × items) stays under this, so the last one is never late (transitions-polish). */
export const STAGGER_TOTAL_MS = 300;
/** transitions.dev's card resize: a box tweened from one size to another (its 300ms, on the smooth ease-out). */
export const CARD_RESIZE_MS = 300;

/**
 * A CSS cubic-bézier timing function: progress through the motion (0–1)
 * to progress along it, solved for x by Newton's method, by bisection
 * where that stalls (as browsers do).
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number): number => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number): number => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number): number => (3 * ax * t + 2 * bx) * t + cx;
  const solveX = (x: number): number => {
    let t = x;
    for (let i = 0; i < 8; i += 1) {
      const error = sampleX(t) - x;
      if (Math.abs(error) < 1e-6) return t;
      const slope = slopeX(t);
      if (Math.abs(slope) < 1e-6) break;
      t -= error / slope;
    }
    let low = 0;
    let high = 1;
    t = x;
    while (high - low > 1e-7) {
      const value = sampleX(t);
      if (Math.abs(value - x) < 1e-6) return t;
      if (x > value) low = t;
      else high = t;
      t = (low + high) / 2;
    }
    return t;
  };
  return (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : sampleY(solveX(x)));
}

/** `--ease-smooth-out`, cubic-bezier(0.22, 1, 0.36, 1): fast away, a long soft settle, never past the end. */
export const EASE_SMOOTH_OUT = cubicBezier(0.22, 1, 0.36, 1);

/** transitions.dev's plus → menu morph's open, cubic-bezier(0.34, 1.25, 0.64, 1): out with a little overshoot. */
export const EASE_MORPH_OPEN = cubicBezier(0.34, 1.25, 0.64, 1);

/**
 * A spring let go from rest at 0 toward 1, `t` seconds on: where it is, the
 * spring stepSpring steps (a hair off it), in closed form — so a motion read off the clock
 * is the same wherever it is read (the Bar's nub in the shell and in main's
 * notch view), and a slowed clock slows it whole.
 */
export function springAt(t: number, spring: SpringConfig): number {
  if (t <= 0) return 0;
  const omega = (2 * Math.PI) / spring.response;
  const zeta = spring.damping;
  if (zeta >= 1) return 1 - Math.exp(-omega * t) * (1 + omega * t);
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * omega * t) * (Math.cos(wd * t) + ((zeta * omega) / wd) * Math.sin(wd * t));
}

/** Whether a spring let go `t` seconds ago has come to rest (its swing under a thousandth). */
export function springDone(t: number, spring: SpringConfig): boolean {
  const omega = (2 * Math.PI) / spring.response;
  return t > 0 && Math.exp(-Math.min(1, spring.damping) * omega * t) * (1 + omega * t) < 0.001;
}
