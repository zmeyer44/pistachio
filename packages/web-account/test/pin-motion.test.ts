import { describe, expect, it } from "vitest";
import { wrapIntoRing } from "../src/pin-motion";

/**
 * The wrap is geometry, and geometry is checkable without a browser: the first
 * keyframe must be exactly where the boxes already are, and the last must be a
 * ring whose circumference is the row's own length, with the boxes as far
 * apart on it as they were in the row. Get either end wrong and the animation
 * either jumps on start or lands in a shape that is not a circle.
 */

const PITCH = 68;
const COUNT = 6;

/** `translate(Xpx, Ypx)` back to numbers. */
function point(transform: string): { x: number; y: number } {
  const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/u.exec(transform);
  if (match === null) throw new Error(`not a translate: ${transform}`);
  return { x: Number(match[1]), y: Number(match[2]) };
}

function lift(transform: string): number {
  const match = /translateY\((-?[\d.]+)px\)/u.exec(transform);
  if (match === null) throw new Error(`not a translateY: ${transform}`);
  return Number(match[1]);
}

describe("rolling a row of PIN circles into a ring", () => {
  const motion = wrapIntoRing({ count: COUNT, pitch: PITCH, steps: 40 });

  it("makes a ring the row is exactly long enough to close", () => {
    expect(motion.radius).toBeCloseTo((COUNT * PITCH) / (2 * Math.PI), 6);
  });

  it("starts where the boxes already are, so nothing jumps on the first frame", () => {
    for (const box of motion.boxes) {
      expect(point(box[0]!)).toEqual({ x: 0, y: 0 });
    }
    expect(lift(motion.group[0]!)).toBe(0);
  });

  it("gives every box a keyframe at every step", () => {
    expect(motion.boxes).toHaveLength(COUNT);
    for (const box of motion.boxes) expect(box).toHaveLength(40);
    expect(motion.group).toHaveLength(40);
  });

  it("ends with the boxes on the ring, evenly spaced", () => {
    // The group lifts by the radius, which puts the ring's centre back on the
    // row's own centre. Positions are measured from there.
    expect(lift(motion.group.at(-1)!)).toBeCloseTo(-motion.radius, 1);

    const centres = motion.boxes.map((box, i) => {
      const delta = point(box.at(-1)!);
      const row = (i + 0.5) * PITCH - (COUNT * PITCH) / 2;
      return { x: row + delta.x, y: delta.y - motion.radius };
    });

    for (const centre of centres) {
      expect(Math.hypot(centre.x, centre.y)).toBeCloseTo(motion.radius, 1);
    }

    const angles = centres.map((centre) => Math.atan2(centre.y, centre.x));
    for (let i = 1; i < angles.length; i++) {
      const step = Math.abs(angles[i]! - angles[i - 1]!);
      expect(Math.min(step, 2 * Math.PI - step)).toBeCloseTo((2 * Math.PI) / COUNT, 3);
    }
  });

  it("sweeps the ends furthest and the middle least, which is what reads as a wrap", () => {
    const travelled = motion.boxes.map((box) => {
      const end = point(box.at(-1)!);
      return Math.hypot(end.x, end.y);
    });
    const middle = Math.min(...travelled.slice(2, 4));
    const ends = Math.min(travelled[0]!, travelled.at(-1)!);
    expect(ends).toBeGreaterThan(middle * 2);
  });

  it("survives a single step without dividing by zero", () => {
    const one = wrapIntoRing({ count: COUNT, pitch: PITCH, steps: 1 });
    expect(one.group).toHaveLength(1);
    for (const box of one.boxes) {
      expect(Number.isFinite(point(box[0]!).x)).toBe(true);
      expect(Number.isFinite(point(box[0]!).y)).toBe(true);
    }
  });
});
