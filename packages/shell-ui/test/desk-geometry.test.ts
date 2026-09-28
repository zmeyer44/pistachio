import { describe, expect, it } from "vitest";
import {
  cascadeRects,
  clampRect,
  DESK_GAP,
  denormalizeRect,
  edgeZone,
  freeSpot,
  magnetize,
  magnetizeEdges,
  normalizeRect,
  rectsOverlap,
  resizedRect,
  rubberBand,
  thirdsZone,
  tileRects,
  uncoveredWindows,
  zoneRect,
  type Rect,
} from "../src/lib/desk/geometry";
import { SPRING_PRESETS, springAtRest, stepSpring, VelocityTracker } from "../src/lib/desk/motion";
import { sanitizeVariants, DEFAULT_DESK_VARIANTS } from "../src/lib/desk/store";

const desk: Rect = { x: 184, y: 0, w: 1000, h: 700 };

describe("which desk windows may go live", () => {
  it("keeps every window whose frame nothing above it overlaps", () => {
    const frames = new Map<string, Rect>([
      ["a", { x: 0, y: 0, w: 100, h: 100 }],
      ["b", { x: 50, y: 50, w: 100, h: 100 }],
      ["c", { x: 400, y: 0, w: 100, h: 100 }],
    ]);
    // a is under b; c is alone; b is on top of a.
    expect([...uncoveredWindows(["a", "b", "c"], frames)].sort()).toEqual(["b", "c"]);
    // Raise a: now b is the covered one.
    expect([...uncoveredWindows(["b", "c", "a"], frames)].sort()).toEqual(["a", "c"]);
  });

  it("does not count windows that only touch", () => {
    expect(rectsOverlap({ x: 0, y: 0, w: 100, h: 100 }, { x: 100, y: 0, w: 100, h: 100 })).toBe(false);
    const frames = new Map<string, Rect>([
      ["a", { x: 0, y: 0, w: 100, h: 100 }],
      ["b", { x: 100, y: 0, w: 100, h: 100 }],
    ]);
    expect(uncoveredWindows(["a", "b"], frames).size).toBe(2);
  });
});

describe("edge zones", () => {
  it("offers halves on the sides, the whole desk at the top, quarters at the corners", () => {
    expect(edgeZone({ x: desk.x + 4, y: 350 }, desk)).toBe("left");
    expect(edgeZone({ x: desk.x + desk.w - 2, y: 350 }, desk)).toBe("right");
    expect(edgeZone({ x: 700, y: 3 }, desk)).toBe("maximize");
    expect(edgeZone({ x: desk.x + 2, y: 20 }, desk)).toBe("top-left");
    expect(edgeZone({ x: desk.x + desk.w - 30, y: desk.h - 2 }, desk)).toBe("bottom-right");
    expect(edgeZone({ x: 700, y: 350 }, desk)).toBeNull();
    // The middle of the bottom edge arms nothing.
    expect(edgeZone({ x: 700, y: desk.h - 1 }, desk)).toBeNull();
  });

  it("lays the zones out with the desk's gap between them", () => {
    const left = zoneRect("left", desk);
    const right = zoneRect("right", desk);
    expect(left.x).toBe(desk.x);
    expect(right.x - (left.x + left.w)).toBeCloseTo(DESK_GAP);
    expect(right.x + right.w).toBeCloseTo(desk.x + desk.w);
    const quarter = zoneRect("bottom-right", desk);
    expect(quarter.y + quarter.h).toBeCloseTo(desk.h);
    expect(zoneRect("maximize", desk)).toEqual(desk);
  });

  it("reads a throw's landing point in thirds", () => {
    expect(thirdsZone({ x: desk.x + 10, y: 10 }, desk)).toBe("top-left");
    expect(thirdsZone({ x: desk.x + desk.w / 2, y: 10 }, desk)).toBe("maximize");
    expect(thirdsZone({ x: desk.x + desk.w / 2, y: desk.h / 2 }, desk)).toBe("center");
    expect(thirdsZone({ x: desk.x + desk.w + 400, y: desk.h / 2 }, desk)).toBe("right");
  });
});

describe("magnets", () => {
  it("pulls a window's edge onto the desk's edge within reach", () => {
    const { rect } = magnetize({ x: desk.x + 9, y: 200, w: 400, h: 300 }, [], desk);
    expect(rect.x).toBe(desk.x);
    const far = magnetize({ x: desk.x + 40, y: 200, w: 400, h: 300 }, [], desk);
    expect(far.rect.x).toBe(desk.x + 40);
  });

  it("sets a window beside a neighbour, one gap away, and draws the guide", () => {
    const neighbour = { x: 300, y: 100, w: 300, h: 300 };
    const { rect, guides } = magnetize({ x: 600 + DESK_GAP + 10, y: 120, w: 300, h: 300 }, [neighbour], desk);
    expect(rect.x).toBe(600 + DESK_GAP);
    expect(guides).toHaveLength(1);
    expect(guides[0]!.axis).toBe("x");
  });

  it("ignores a neighbour that is nowhere level with it", () => {
    const neighbour = { x: 300, y: 0, w: 300, h: 100 };
    const { rect } = magnetize({ x: 612, y: 500, w: 300, h: 150 }, [neighbour], desk);
    expect(rect.x).toBe(612);
  });

  it("moves only the edges in hand while resizing", () => {
    const start = { x: 300, y: 100, w: 400, h: 300 };
    const edges = { left: false, right: true, top: false, bottom: false };
    const stuck = magnetizeEdges({ ...start, w: desk.x + desk.w - 300 - 6 }, edges, [], desk);
    expect(stuck.x).toBe(300);
    expect(stuck.x + stuck.w).toBe(desk.x + desk.w);
  });
});

describe("resizing", () => {
  it("never shrinks a window below its minimum, holding the opposite edge", () => {
    const start = { x: 400, y: 100, w: 400, h: 300 };
    const rect = resizedRect(start, { left: true, right: false, top: false, bottom: false }, 1_000, 0, desk);
    expect(rect.x + rect.w).toBe(800);
    expect(rect.w).toBeGreaterThanOrEqual(300);
  });

  it("stops at the desk's edges", () => {
    const start = { x: 400, y: 100, w: 400, h: 300 };
    const rect = resizedRect(start, { left: false, right: true, top: false, bottom: true }, 5_000, 5_000, desk);
    expect(rect.x + rect.w).toBe(desk.x + desk.w);
    expect(rect.y + rect.h).toBe(desk.h);
  });
});

describe("layouts", () => {
  it("tiles one, two, three and many windows over the whole desk without overlap", () => {
    for (const count of [1, 2, 3, 4, 5, 7]) {
      const rects = tileRects(count, desk);
      expect(rects).toHaveLength(count);
      for (const rect of rects) expect(clampRect(rect, desk)).toEqual(rect);
      for (let i = 0; i < rects.length; i += 1)
        for (let j = i + 1; j < rects.length; j += 1) expect(rectsOverlap(rects[i]!, rects[j]!)).toBe(false);
    }
  });

  it("fans a cascade down and to the right, inside the desk", () => {
    const rects = cascadeRects(4, desk);
    expect(rects[1]!.x).toBeGreaterThan(rects[0]!.x);
    expect(rects[1]!.y).toBeGreaterThan(rects[0]!.y);
    for (const rect of rects) expect(clampRect(rect, desk)).toEqual(rect);
  });

  it("puts a new window where it covers nothing when there is room", () => {
    const taken = [{ x: desk.x, y: 0, w: 480, h: 700 }];
    const spot = freeSpot(taken, { w: 400, h: 500 }, desk);
    expect(rectsOverlap(spot, taken[0]!)).toBe(false);
  });

  it("keeps an arrangement in proportion through a resize", () => {
    const rect = { x: 400, y: 100, w: 300, h: 200 };
    const normal = normalizeRect(rect, desk);
    const wider = { ...desk, w: 2_000 };
    const scaled = denormalizeRect(normal, wider);
    expect(scaled.w).toBeCloseTo(600);
    expect(denormalizeRect(normal, desk)).toEqual(rect);
  });

  it("gives less and less the further a window is pulled past an edge", () => {
    expect(rubberBand(0, 10)).toBe(0);
    expect(rubberBand(20, 10)).toBeLessThan(10);
    expect(rubberBand(200, 10)).toBeGreaterThan(rubberBand(20, 10));
    expect(rubberBand(10_000, 10)).toBeLessThan(10);
  });
});

describe("motion", () => {
  it("settles a spring on its target from any preset, even stepped at a bad frame rate", () => {
    for (const preset of Object.values(SPRING_PRESETS)) {
      let state = { x: 0, v: 2_000 };
      for (let frame = 0; frame < 120; frame += 1) state = stepSpring(state.x, state.v, 500, preset, 1 / 30);
      expect(springAtRest(state.x, state.v, 500)).toBe(true);
    }
  });

  it("overshoots when bouncy and not when smooth", () => {
    const peak = (preset: keyof typeof SPRING_PRESETS): number => {
      let state = { x: 0, v: 0 };
      let max = 0;
      for (let frame = 0; frame < 240; frame += 1) {
        state = stepSpring(state.x, state.v, 100, SPRING_PRESETS[preset], 1 / 120);
        max = Math.max(max, state.x);
      }
      return max;
    };
    expect(peak("bouncy")).toBeGreaterThan(105);
    expect(peak("smooth")).toBeLessThanOrEqual(100.01);
  });

  it("reads the pointer's speed at release, and nothing when it stood still first", () => {
    const tracker = new VelocityTracker();
    for (let t = 0; t <= 80; t += 16) tracker.push(t * 2, 0, t);
    expect(tracker.velocity(80).x).toBeCloseTo(2_000, -1);
    // A pause before letting go is a placement, not a throw.
    expect(tracker.velocity(80 + 120)).toEqual({ x: 0, y: 0 });
  });
});

describe("variants", () => {
  it("falls back to the defaults for anything it does not know", () => {
    expect(sanitizeVariants(null)).toEqual(DEFAULT_DESK_VARIANTS);
    expect(sanitizeVariants({ physics: "snap", chrome: "nope", grab: "alt" })).toEqual({
      ...DEFAULT_DESK_VARIANTS,
      physics: "snap",
      grab: "alt",
    });
  });
});
