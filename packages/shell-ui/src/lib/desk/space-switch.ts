/**
 * How the desk's windows go and come when another space is chosen
 * (Settings → General → Switching spaces; docs/spaces.md §2). The exits
 * other than "tile" — the windows flying into their space's tile, the one
 * motion until 2026-10-14 — are the Space Switch Lab's variants, played as
 * timed POSES on each window's still where it stands: a scale, a drift
 * toward the desk's middle, a drop, a tilt back, an opacity and a blur.
 * The engine samples the pose every frame (DeskEngine #step) and writes it
 * (#write); nothing here moves a window's box, so main never lays a page
 * out for it. Pure, for the unit tests.
 */

import type { SpaceSwitchExit } from "@pistachio/shell-contracts/settings";
import { cubicBezier, EASE_SMOOTH_OUT } from "./motion";

/** A window's pose: what is done to its still on top of its box. */
export interface Pose {
  scale: number;
  /** How far its centre has drifted toward the desk's middle, as a share of the way there. */
  toward: number;
  /** How far down it has dropped, in px. */
  drop: number;
  /** How far it has tipped back about its anchor's horizontal line, in degrees (seen in perspective). */
  tilt: number;
  opacity: number;
  /** In px. */
  blur: number;
}

/** A window as it is: no pose at all. */
export const REST_POSE: Pose = { scale: 1, toward: 0, drop: 0, tilt: 0, opacity: 1, blur: 0 };

/**
 * What a pose's scale and tilt are about: the window's own centre, or —
 * the desk moving as one sheet — the desk's centre, its foot, or its top.
 */
export type PoseAnchor = "own" | "desk" | "foot" | "top";

/** Which window of a space goes (or comes) first, the rest a beat apart. */
export type StaggerOrder = "top" | "far" | "near" | "in-use";

interface Keyframe {
  /** Where along the motion (0–1, after its curve). */
  at: number;
  pose: Pose;
  /** The curve of the stretch from here to the next keyframe (linear when absent). */
  ease?: (t: number) => number;
}

export interface SwitchMotion {
  ms: number;
  anchor: PoseAnchor;
  /** The curve over the whole run. */
  ease: (t: number) => number;
  frames: readonly Keyframe[];
  /** The beat between one window and the next, in ms, and which goes first. */
  stagger: number;
  order: StaggerOrder;
  /** An entrance only: how long after the exit sets out the windows start to come, in ms. */
  handoff: number;
}

/** An exit that dismisses the windows where they stand (every one but "tile"). */
export type PosedExit = Exclude<SpaceSwitchExit, "tile">;

export function isPosedExit(exit: SpaceSwitchExit): exit is PosedExit {
  return exit !== "tile";
}

const linear = (t: number): number => t;
const pose = (part: Partial<Pose>): Pose => ({ ...REST_POSE, ...part });

/** Reduced motion: no scale, drift or blur, only a quick fade, every window at once. */
const REDUCED_OUT: SwitchMotion = { ms: 150, anchor: "own", ease: linear, frames: [{ at: 0, pose: REST_POSE }, { at: 1, pose: pose({ opacity: 0 }) }], stagger: 0, order: "top", handoff: 0 };
const REDUCED_IN: SwitchMotion = { ...REDUCED_OUT, frames: [{ at: 0, pose: pose({ opacity: 0 }) }, { at: 1, pose: REST_POSE }] };

/** How the windows go, as the lab has each exit. */
const EXITS: Record<PosedExit, SwitchMotion> = {
  // Swell a touch and blur away: passing through the desk rather than off it.
  bloom: {
    ms: 260,
    anchor: "own",
    ease: cubicBezier(0.25, 0.1, 0.25, 1),
    frames: [{ at: 0, pose: REST_POSE }, { at: 1, pose: pose({ scale: 1.06, blur: 10, opacity: 0 }) }],
    stagger: 12,
    order: "top",
    handoff: 0,
  },
  // The desk steps back as one sheet toward its middle.
  recede: {
    ms: 240,
    anchor: "desk",
    ease: cubicBezier(0.4, 0, 0.2, 1),
    frames: [{ at: 0, pose: REST_POSE }, { at: 1, pose: pose({ scale: 0.92, opacity: 0 }) }],
    stagger: 0,
    order: "top",
    handoff: 0,
  },
  // Drawn toward the desk's middle, the far windows first: the desk folds inward. Opaque for the first 30% of the way.
  gather: {
    ms: 320,
    anchor: "own",
    ease: cubicBezier(0.55, 0, 0.75, 0.1),
    frames: [
      { at: 0, pose: REST_POSE },
      { at: 0.3, pose: pose({ scale: 0.865, toward: 0.12 }) },
      { at: 1, pose: pose({ scale: 0.55, toward: 0.4, opacity: 0 }) },
    ],
    stagger: 30,
    order: "far",
    handoff: 0,
  },
  // A lift of 3.5% before each drops to 78% and fades, the window in use first.
  pop: {
    ms: 320,
    anchor: "own",
    ease: linear,
    frames: [
      { at: 0, pose: REST_POSE, ease: cubicBezier(0.3, 0, 0.4, 1) },
      { at: 0.28, pose: pose({ scale: 1.035 }), ease: cubicBezier(0.55, 0, 0.8, 0.2) },
      { at: 1, pose: pose({ scale: 0.78, opacity: 0 }) },
    ],
    stagger: 35,
    order: "in-use",
    handoff: 0,
  },
  // The desk tips back about its foot and sinks as it fades, a sheet laid down on a table.
  sink: {
    ms: 320,
    anchor: "foot",
    ease: cubicBezier(0.5, 0, 0.75, 0),
    frames: [{ at: 0, pose: REST_POSE }, { at: 1, pose: pose({ tilt: 9, drop: 28, scale: 0.9, opacity: 0 }) }],
    stagger: 0,
    order: "top",
    handoff: 0,
  },
};

/** How the chosen space's windows come with each exit ("matched"). */
const ENTRANCES: Record<PosedExit, SwitchMotion> = {
  // Sharpening in from a little smaller and blurred.
  bloom: {
    ms: 300,
    anchor: "own",
    ease: EASE_SMOOTH_OUT,
    frames: [{ at: 0, pose: pose({ scale: 0.97, blur: 8, opacity: 0 }) }, { at: 1, pose: REST_POSE }],
    stagger: 15,
    order: "top",
    handoff: 90,
  },
  // The next desk arrives from just in front, as the last one stepped back.
  recede: {
    ms: 300,
    anchor: "desk",
    ease: EASE_SMOOTH_OUT,
    frames: [{ at: 0, pose: pose({ scale: 1.04, opacity: 0 }) }, { at: 1, pose: REST_POSE }],
    stagger: 0,
    order: "top",
    handoff: 120,
  },
  // Opening out of the desk's middle with a small overshoot, the near windows first. Opaque from 35% of the way.
  gather: {
    ms: 420,
    anchor: "own",
    ease: cubicBezier(0.34, 1.2, 0.64, 1),
    frames: [
      { at: 0, pose: pose({ scale: 0.55, toward: 0.4, opacity: 0 }) },
      { at: 0.35, pose: pose({ scale: 0.7075, toward: 0.26 }) },
      { at: 1, pose: REST_POSE },
    ],
    stagger: 30,
    order: "near",
    handoff: 240,
  },
  // Up from 86% past 102%, the window in use first.
  pop: {
    ms: 380,
    anchor: "own",
    ease: linear,
    frames: [
      { at: 0, pose: pose({ scale: 0.86, opacity: 0 }), ease: cubicBezier(0.2, 0.8, 0.3, 1) },
      { at: 0.62, pose: pose({ scale: 1.02 }), ease: cubicBezier(0.4, 0, 0.6, 1) },
      { at: 1, pose: REST_POSE },
    ],
    stagger: 35,
    order: "in-use",
    handoff: 200,
  },
  // Settling from just above, tipped toward the person, about the desk's top.
  sink: {
    ms: 380,
    anchor: "top",
    ease: EASE_SMOOTH_OUT,
    frames: [{ at: 0, pose: pose({ tilt: -7, drop: -20, scale: 1.03, opacity: 0 }) }, { at: 1, pose: REST_POSE }],
    stagger: 0,
    order: "top",
    handoff: 150,
  },
};

export function exitMotion(exit: PosedExit, reduced: boolean): SwitchMotion {
  return reduced ? REDUCED_OUT : EXITS[exit];
}

export function entranceMotion(exit: PosedExit, reduced: boolean): SwitchMotion {
  return reduced ? REDUCED_IN : ENTRANCES[exit];
}

/** A window turned back mid-motion (its space chosen again): from the pose it has, back to rest. */
export function returnMotion(anchor: PoseAnchor): SwitchMotion {
  return { ms: 220, anchor, ease: EASE_SMOOTH_OUT, frames: [{ at: 0, pose: REST_POSE }, { at: 1, pose: REST_POSE }], stagger: 0, order: "top", handoff: 0 };
}

export function mixPose(a: Pose, b: Pose, k: number): Pose {
  // (At either end, the pose itself: a window at rest is exactly at rest.)
  const mix = (x: number, y: number): number => (k === 0 ? x : k === 1 ? y : x + (y - x) * k);
  return {
    scale: mix(a.scale, b.scale),
    toward: mix(a.toward, b.toward),
    drop: mix(a.drop, b.drop),
    tilt: mix(a.tilt, b.tilt),
    opacity: Math.min(1, Math.max(0, mix(a.opacity, b.opacity))),
    blur: Math.max(0, mix(a.blur, b.blur)),
  };
}

/**
 * The pose `t` (0–1 of the time) into a motion. `from`, when given, stands
 * in for its first keyframe: a window already posed (coming in, or turned
 * back) sets out from where it is, never jumping to the motion's start. A
 * curve that overshoots carries the pose past the last keyframe and back.
 */
export function poseAt(motion: SwitchMotion, t: number, from: Pose | null = null): Pose {
  const frames = from === null ? motion.frames : [{ ...motion.frames[0]!, pose: from }, ...motion.frames.slice(1)];
  const along = motion.ease(Math.min(1, Math.max(0, t)));
  let index = 0;
  while (index < frames.length - 2 && along > frames[index + 1]!.at) index += 1;
  const start = frames[index]!;
  const end = frames[index + 1]!;
  const span = end.at - start.at;
  const local = span <= 0 ? 1 : (along - start.at) / span;
  // (Within the stretch, its own curve; past either end — an overshoot — straight on.)
  const shaped = local >= 0 && local <= 1 && start.ease !== undefined ? start.ease(local) : local;
  return mixPose(start.pose, end.pose, shaped);
}

/** A window of a space switching, as the stagger orders them: its box (stage px), and whether it is the window in use. */
export interface StaggeredWindow {
  id: string;
  rect: { x: number; y: number; w: number; h: number };
  inUse: boolean;
}

/**
 * The windows in the order they set out, from a list bottom to top: "top"
 * the top window first; "far" and "near" by their centres' distance from
 * the desk's (`desk`: its width and height); "in-use" the window in use
 * first, then outward from it.
 */
export function staggerOrder(windows: readonly StaggeredWindow[], order: StaggerOrder, desk: { w: number; h: number }): string[] {
  const centre = (window: StaggeredWindow): { x: number; y: number } => ({ x: window.rect.x + window.rect.w / 2, y: window.rect.y + window.rect.h / 2 });
  const from = (point: { x: number; y: number }) => (window: StaggeredWindow): number => Math.hypot(centre(window).x - point.x, centre(window).y - point.y);
  const topFirst = [...windows].reverse();
  if (order === "top") return topFirst.map((window) => window.id);
  if (order === "in-use") {
    const lead = windows.find((window) => window.inUse) ?? topFirst[0];
    if (lead === undefined) return [];
    const distance = from(centre(lead));
    return [lead, ...topFirst.filter((window) => window !== lead).sort((a, b) => distance(a) - distance(b))].map((window) => window.id);
  }
  const distance = from({ x: desk.w / 2, y: desk.h / 2 });
  return topFirst.sort((a, b) => (order === "far" ? distance(b) - distance(a) : distance(a) - distance(b))).map((window) => window.id);
}
