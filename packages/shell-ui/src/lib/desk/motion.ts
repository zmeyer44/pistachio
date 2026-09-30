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
