/**
 * The geometry of a row of PIN circles rolling up into a ring.
 *
 * The animation is not six boxes flying to six destinations — that reads as a
 * scatter. It is one strip being WRAPPED: at every moment the boxes lie on a
 * circle of radius `R / w` tangent to the row at its midpoint, and `w` goes 0
 * to 1. At `w = 0` that circle is infinite, which is a straight line: the row,
 * exactly where it already is. At `w = 1` its circumference is the row's own
 * length, so the strip closes on itself and the boxes come to rest evenly
 * spaced around it, like a train coming round to meet its own tail.
 *
 * Doing it this way is what makes the ends sweep and the middle barely move,
 * which is the whole read of the thing, and it falls out of the geometry
 * rather than out of a per-box delay.
 *
 * Pure, and separate from the component, so the shape can be checked without
 * a DOM (`test/pin-motion.test.ts`).
 */

/** The transforms one wrap is made of, sampled into keyframes. */
export interface WrapMotion {
  /** Radius of the finished ring, in the same units as `pitch`. */
  radius: number;
  /** One array of `transform` values per box, in row order. */
  boxes: string[][];
  /**
   * The group's own transform. The strip curls DOWNWARD — the circle it wraps
   * onto sits below the row — so the group rises by exactly as much as the
   * circle has closed, which keeps the finished ring centred on the row the
   * reader was just typing into.
   */
  group: string[];
}

/** Gentle at both ends: the strip eases into the curl and settles out of it. */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function round(value: number): number {
  // Sub-hundredth pixels are noise in a transform string, and trimming them
  // keeps the keyframes small enough to read in a debugger.
  return Math.round(value * 100) / 100;
}

/**
 * Sample the wrap into `steps` keyframes.
 *
 * The default is high on purpose. A keyframe list is interpolated LINEARLY
 * between its samples, so every sample is a corner in the velocity — sample a
 * curved path 30 times over two thirds of a second and the corners land about
 * every other frame, which is seen, not as slowness but as grain. Ninety-six
 * puts several samples inside every frame at 60 Hz, and the cost is a few
 * hundred short strings built once.
 *
 * `pitch` is one box's share of the row — its width plus the gap after it —
 * which is what makes the finished ring's circumference the row's own length
 * and therefore the boxes exactly as far apart on the ring as they were in
 * the row.
 */
export function wrapIntoRing({
  count,
  pitch,
  steps = 96,
}: {
  count: number;
  pitch: number;
  steps?: number;
}): WrapMotion {
  const length = count * pitch;
  const radius = length / (2 * Math.PI);
  // Arc length from the strip's midpoint to each box's centre. Symmetric
  // about zero, so the middle pair hardly travels and the ends go furthest.
  const offsets = Array.from({ length: count }, (_, i) => (i + 0.5) * pitch - length / 2);

  const boxes: string[][] = offsets.map(() => []);
  const group: string[] = [];

  for (let step = 0; step < steps; step++) {
    const w = easeInOutCubic(steps === 1 ? 1 : step / (steps - 1));
    offsets.forEach((s, i) => {
      // w = 0 is the degenerate case: an infinite radius, which is the row.
      // Taking the limit rather than dividing by zero keeps the first
      // keyframe exactly where the box already is, so nothing jumps on start.
      const x = w === 0 ? s : (radius / w) * Math.sin((s * w) / radius);
      const y = w === 0 ? 0 : (radius / w) * (1 - Math.cos((s * w) / radius));
      boxes[i]?.push(`translate(${String(round(x - s))}px, ${String(round(y))}px)`);
    });
    group.push(`translateY(${String(round(-radius * w))}px)`);
  }

  return { radius, boxes, group };
}
