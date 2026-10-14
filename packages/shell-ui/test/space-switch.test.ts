/**
 * How the desk's windows go and come when another space is chosen
 * (src/lib/desk/space-switch.ts): every exit sets out from rest and ends
 * unseen, every entrance the other way round, each with the shape the
 * Space Switch Lab gave it; a window already posed sets out from where it
 * is; and the windows go in the order each one names.
 */

import { describe, expect, it } from "vitest";
import { SPACE_SWITCH_EXITS } from "@pistachio/shell-contracts/settings";
import { entranceMotion, exitMotion, isPosedExit, poseAt, REST_POSE, returnMotion, staggerOrder, type PosedExit } from "../src/lib/desk/space-switch";

const POSED = SPACE_SWITCH_EXITS.filter(isPosedExit);

describe("the exits and their entrances", () => {
  it("are every exit but the flight into the tile", () => {
    expect(POSED).toEqual(["bloom", "recede", "gather", "pop", "sink"]);
  });

  it.each(POSED)("%s: the windows set out as they are and end unseen; the next ones set out unseen and end as they are", (exit: PosedExit) => {
    expect(poseAt(exitMotion(exit, false), 0)).toEqual(REST_POSE);
    expect(poseAt(exitMotion(exit, false), 1).opacity).toBe(0);
    expect(poseAt(entranceMotion(exit, false), 0).opacity).toBe(0);
    expect(poseAt(entranceMotion(exit, false), 1)).toEqual(REST_POSE);
  });

  it("Bloom swells and blurs away about each window's own centre, and the next space sharpens in", () => {
    const motion = exitMotion("bloom", false);
    expect(motion.anchor).toBe("own");
    const mid = poseAt(motion, 0.5);
    expect(mid.scale).toBeGreaterThan(1);
    expect(mid.scale).toBeLessThan(1.06);
    expect(mid.blur).toBeGreaterThan(0);
    expect(poseAt(motion, 1)).toMatchObject({ scale: 1.06, blur: 10 });
    expect(poseAt(entranceMotion("bloom", false), 0)).toMatchObject({ scale: 0.97, blur: 8 });
  });

  it("Gather keeps the windows whole for the first stretch of their drift, then draws them in", () => {
    const motion = exitMotion("gather", false);
    // (Its curve eases in: a fifth of the time is well short of the 30% of the way where the fade begins.)
    expect(poseAt(motion, 0.2).opacity).toBe(1);
    expect(poseAt(motion, 0.2).toward).toBeGreaterThan(0);
    expect(poseAt(motion, 1)).toMatchObject({ scale: 0.55, toward: 0.4 });
  });

  it("Pop lifts each window a touch before it drops", () => {
    const motion = exitMotion("pop", false);
    expect(poseAt(motion, 0.28).scale).toBeCloseTo(1.035, 3);
    expect(poseAt(motion, 0.28).opacity).toBe(1);
    expect(poseAt(motion, 1).scale).toBeCloseTo(0.78, 5);
  });

  it("Gather's entrance overshoots its place and settles back", () => {
    const motion = entranceMotion("gather", false);
    const scales = Array.from({ length: 41 }, (_, index) => poseAt(motion, index / 40).scale);
    expect(Math.max(...scales)).toBeGreaterThan(1);
    expect(scales.at(-1)).toBe(1);
  });

  it("Recede and Sink move the desk as one sheet: about its centre, its foot and its top", () => {
    expect(exitMotion("recede", false).anchor).toBe("desk");
    expect(exitMotion("sink", false).anchor).toBe("foot");
    expect(entranceMotion("sink", false).anchor).toBe("top");
    expect(poseAt(exitMotion("sink", false), 1)).toMatchObject({ tilt: 9, drop: 28, scale: 0.9 });
  });

  it("with reduced motion, only fade", () => {
    for (const exit of POSED) {
      for (const motion of [exitMotion(exit, true), entranceMotion(exit, true)]) {
        for (const t of [0, 0.5, 1]) expect(poseAt(motion, t)).toMatchObject({ scale: 1, toward: 0, drop: 0, tilt: 0, blur: 0 });
        expect(motion.stagger).toBe(0);
      }
    }
  });

  it("sets a posed window out from the pose it has, and brings one turned back to rest", () => {
    const halfway = poseAt(entranceMotion("bloom", false), 0.4);
    expect(poseAt(exitMotion("bloom", false), 0, halfway)).toEqual(halfway);
    const back = returnMotion("own");
    expect(poseAt(back, 0, halfway)).toEqual(halfway);
    expect(poseAt(back, 1, halfway)).toEqual(REST_POSE);
  });
});

describe("the order the windows go in", () => {
  const desk = { w: 1000, h: 800 };
  // Bottom to top: a far corner, the middle, the window in use near the other corner.
  const windows = [
    { id: "corner", rect: { x: 0, y: 0, w: 100, h: 100 }, inUse: false },
    { id: "middle", rect: { x: 450, y: 350, w: 100, h: 100 }, inUse: false },
    { id: "in-use", rect: { x: 800, y: 600, w: 100, h: 100 }, inUse: true },
  ];

  it("top first, farthest from the middle first, nearest first, or the window in use and then outward from it", () => {
    expect(staggerOrder(windows, "top", desk)).toEqual(["in-use", "middle", "corner"]);
    expect(staggerOrder(windows, "far", desk)).toEqual(["corner", "in-use", "middle"]);
    expect(staggerOrder(windows, "near", desk)).toEqual(["middle", "in-use", "corner"]);
    expect(staggerOrder(windows, "in-use", desk)).toEqual(["in-use", "middle", "corner"]);
  });
});
