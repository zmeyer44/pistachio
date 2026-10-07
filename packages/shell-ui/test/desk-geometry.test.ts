import { describe, expect, it } from "vitest";
import {
  carrySize,
  cascadeRects,
  cellZone,
  centeredRect,
  clampRect,
  resizedKeepingAspect,
  DESK_GAP,
  denormalizeRect,
  dockDropAt,
  sidebarDrops,
  editedMaskRegion,
  edgeZone,
  fillsDesk,
  freeSpot,
  isTile,
  largestEmptyRect,
  letGoSize,
  magnetize,
  magnetizeEdges,
  normalizeRect,
  placeNewWindow,
  rectsOverlap,
  alongSeam,
  rescaleRect,
  resizedRect,
  rubberBand,
  seamsAt,
  seamTravel,
  type Seam,
  SNAP_TOP_SHARE,
  splitRect,
  thirdsCell,
  thirdsZone,
  tileRect,
  tileRects,
  uncoveredWindows,
  unfilledSize,
  windowSize,
  zoneRect,
  type Rect,
} from "../src/lib/desk/geometry";
import { cubicBezier, EASE_SMOOTH_OUT, GLIDE_DECELERATION, GLIDE_TAU_S, glideDecay, glideTauFor, SPRING_PRESETS, springAtRest, stepSpring, VelocityTracker } from "../src/lib/desk/motion";
import { readPersistedDesk, sanitizeVariants, DEFAULT_DESK_VARIANTS } from "../src/lib/desk/store";

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

  it("fills the desk from the middle only at its top edge: the rest of the middle is the centre", () => {
    const middle = desk.x + desk.w / 2;
    // A window held by its title bar where the centre tile would put it: its bar is a tenth of the way down.
    const bar = centeredRect(desk).y + 17;
    expect(thirdsZone({ x: middle, y: bar }, desk)).toBe("center");
    expect(thirdsZone({ x: middle, y: desk.h * 0.2 }, desk)).toBe("center");
    expect(thirdsZone({ x: middle, y: desk.h * (SNAP_TOP_SHARE - 0.01) }, desk)).toBe("maximize");
    // Pushed up past the desk's top edge: the whole desk.
    expect(thirdsZone({ x: middle, y: -40 }, desk)).toBe("maximize");
    // The sides keep their thirds: the top corners are quarters.
    expect(thirdsZone({ x: desk.x + 10, y: desk.h * 0.2 }, desk)).toBe("top-left");
    expect(thirdsZone({ x: desk.x + desk.w - 10, y: desk.h * 0.3 }, desk)).toBe("top-right");
  });

  it("holds the whole desk until the pointer is well below the top band, and the centre until well into it", () => {
    const middle = desk.x + desk.w / 2;
    const line = desk.y + desk.h * SNAP_TOP_SHARE;
    const top = thirdsCell({ x: middle, y: line - 4 }, desk);
    expect(cellZone(top)).toBe("maximize");
    expect(cellZone(thirdsCell({ x: middle, y: line + 10 }, desk, top, 16))).toBe("maximize");
    const centre = thirdsCell({ x: middle, y: line + 20 }, desk, top, 16);
    expect(cellZone(centre)).toBe("center");
    expect(cellZone(thirdsCell({ x: middle, y: line - 10 }, desk, centre, 16))).toBe("center");
    expect(cellZone(thirdsCell({ x: middle, y: line - 20 }, desk, centre, 16))).toBe("maximize");
    // Across into a side column above the band, the top third there is its corner's quarter.
    expect(cellZone(thirdsCell({ x: desk.x + 10, y: desk.y + desk.h * 0.2 }, desk, centre, 16))).toBe("top-left");
  });

  it("holds a snap tile until the pointer is well past the line, so a resting pointer does not flicker", () => {
    const third = desk.x + desk.w / 3;
    const left = thirdsCell({ x: third - 4, y: 350 }, desk);
    expect(cellZone(left)).toBe("left");
    // Just over the line, coming from the left: still the left half.
    expect(cellZone(thirdsCell({ x: third + 10, y: 350 }, desk, left, 16))).toBe("left");
    // Well past it: the middle.
    const middle = thirdsCell({ x: third + 20, y: 350 }, desk, left, 16);
    expect(cellZone(middle)).toBe("center");
    // And back just over the line from the middle: still the middle.
    expect(cellZone(thirdsCell({ x: third - 10, y: 350 }, desk, middle, 16))).toBe("center");
    // With no cell before, the line is the line.
    expect(cellZone(thirdsCell({ x: third + 10, y: 350 }, desk))).toBe("center");
  });

  it("puts a tile's window where its zone is, and the middle's in the centre", () => {
    expect(tileRect("left", desk)).toEqual(zoneRect("left", desk));
    expect(tileRect("maximize", desk)).toEqual(desk);
    expect(tileRect("center", desk)).toEqual(centeredRect(desk));
  });
});

describe("letting go of the whole desk", () => {
  it("carries a window taken by its icon at its own size, or scaled down to be carried, its shape kept", () => {
    const small = { x: 300, y: 80, w: 480, h: 360 };
    expect(carrySize(small, desk)).toEqual({ w: 480, h: 360 });
    const tall = zoneRect("left", desk);
    const carried = carrySize(tall, desk);
    expect(carried.h).toBeCloseTo(desk.h * 0.8);
    expect(carried.w / carried.h).toBeCloseTo(tall.w / tall.h);
  });

  it("knows a window that fills the desk, near enough", () => {
    expect(fillsDesk(desk, desk)).toBe(true);
    expect(fillsDesk({ ...desk, w: desk.w * 0.95, h: desk.h * 0.94 }, desk)).toBe(true);
    expect(fillsDesk(zoneRect("left", desk), desk)).toBe(false);
    expect(fillsDesk(centeredRect(desk), desk)).toBe(false);
  });

  it("lets go of a span as it is dragged: a tall window of its height, a wide one of its width, one filling the desk of both", () => {
    const size = windowSize(desk);
    const left = zoneRect("left", desk);
    expect(letGoSize(left, null, desk)).toEqual({ w: left.w, h: size.h });
    const topHalf = { x: desk.x, y: desk.y, w: desk.w, h: (desk.h - DESK_GAP) / 2 };
    expect(letGoSize(topHalf, null, desk)).toEqual({ w: size.w, h: topHalf.h });
    expect(letGoSize(desk, null, desk)).toEqual(size);
    expect(letGoSize(desk, { x: 300, y: 80, w: 520, h: 400 }, desk)).toEqual({ w: 520, h: 400 });
    // Neither way: it keeps its size.
    expect(letGoSize(zoneRect("top-left", desk), null, desk)).toBeNull();
    expect(letGoSize(centeredRect(desk), null, desk)).toBeNull();
  });

  it("goes back to the size it had before it filled the desk, or to the size windows come out at", () => {
    expect(unfilledSize({ x: 300, y: 80, w: 520, h: 400 }, desk)).toEqual({ w: 520, h: 400 });
    expect(unfilledSize(null, desk)).toEqual(windowSize(desk));
    // A size to go back to that fills the desk too is no size to go back to.
    expect(unfilledSize({ ...desk }, desk)).toEqual(windowSize(desk));
    const size = windowSize(desk);
    expect(size.w).toBeLessThan(zoneRect("left", desk).w * 1.2);
    expect(size.h).toBeLessThan(desk.h);
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

describe("seams: windows a gutter apart, resized together", () => {
  const edge = (side: "left" | "right" | "top" | "bottom") => ({ left: side === "left", right: side === "right", top: side === "top", bottom: side === "bottom" });
  const rects = (entries: Record<string, Rect>): Map<string, Rect> => new Map(Object.entries(entries));
  const sorted = (seam: Seam | null) => (seam === null ? null : { axis: seam.axis, before: [...seam.before].sort(), after: [...seam.after].sort() });

  it("joins two halves across their gutter, from either side, and moves the gutter between them", () => {
    const halves = rects({ left: zoneRect("left", desk), right: zoneRect("right", desk) });
    const gutter = zoneRect("left", desk).x + zoneRect("left", desk).w;
    for (const [id, side] of [["left", "right"], ["right", "left"]] as const) {
      const { x, y } = seamsAt(halves, id, edge(side), { x: gutter + 4, y: 400 });
      expect(sorted(x)).toEqual({ axis: "x", before: ["left"], after: ["right"] });
      expect(y).toBeNull();
    }
    const seam = seamsAt(halves, "left", edge("right"), { x: gutter + 4, y: 400 }).x!;
    const travel = seamTravel(halves, seam, 120, []);
    expect(travel).toBe(120);
    const left = alongSeam(halves.get("left")!, seam, "left", travel);
    const right = alongSeam(halves.get("right")!, seam, "right", travel);
    expect(left.w).toBe(halves.get("left")!.w + 120);
    expect(right.x - (left.x + left.w)).toBe(DESK_GAP);
    expect(right.x + right.w).toBe(desk.x + desk.w);
  });

  it("only joins windows the desk's gap apart: flush, overlapping or further off, each edge is its own", () => {
    const left = { x: 100, y: 0, w: 500, h: 600 };
    for (const gap of [0, -20, DESK_GAP + 6, 40]) {
      const pair = rects({ left, right: { x: 600 + gap, y: 0, w: 500, h: 600 } });
      expect(seamsAt(pair, "left", edge("right"), { x: 602, y: 300 }).x).toBeNull();
    }
    // Rounding, or a desk resized a little since they were put there, still holds.
    const near = rects({ left, right: { x: 600 + DESK_GAP + 1.5, y: 0, w: 500, h: 600 } });
    expect(seamsAt(near, "left", edge("right"), { x: 604, y: 300 }).x).not.toBeNull();
  });

  it("is a gutter only where the two run side by side", () => {
    // A tall window, with a short one beside its top: the gutter runs down as far as the short one does.
    const pair = rects({ tall: { x: 100, y: 0, w: 500, h: 900 }, short: { x: 608, y: 0, w: 500, h: 300 } });
    expect(seamsAt(pair, "tall", edge("right"), { x: 604, y: 200 }).x).not.toBeNull();
    expect(seamsAt(pair, "tall", edge("right"), { x: 604, y: 700 }).x).toBeNull();
    // Off the end by no more than the gutter's own width (a press at the corner of the short one) still counts.
    expect(seamsAt(pair, "tall", edge("right"), { x: 604, y: 305 }).x).not.toBeNull();
  });

  it("takes in every window on the gutter: a half beside two stacked quarters moves them both", () => {
    const three = rects({ left: zoneRect("left", desk), top: zoneRect("top-right", desk), bottom: zoneRect("bottom-right", desk) });
    const gutterX = zoneRect("top-right", desk).x - DESK_GAP / 2;
    // Pressed beside either quarter, or from either quarter, it is the same seam.
    for (const [id, side, y] of [["left", "right", 200], ["left", "right", 700], ["top", "left", 200], ["bottom", "left", 700]] as const) {
      expect(sorted(seamsAt(three, id, edge(side), { x: gutterX, y }).x)).toEqual({ axis: "x", before: ["left"], after: ["bottom", "top"] });
    }
    // The gutter between the quarters is theirs alone.
    const gutterY = zoneRect("bottom-right", desk).y - DESK_GAP / 2;
    expect(sorted(seamsAt(three, "top", edge("bottom"), { x: 1000, y: gutterY }).y)).toEqual({ axis: "y", before: ["top"], after: ["bottom"] });
  });

  it("in a grid, an edge moves its own row's gutter, and the crossing moves all four", () => {
    const grid = rects({
      tl: zoneRect("top-left", desk),
      tr: zoneRect("top-right", desk),
      bl: zoneRect("bottom-left", desk),
      br: zoneRect("bottom-right", desk),
    });
    const cross = { x: zoneRect("top-right", desk).x - DESK_GAP / 2, y: zoneRect("bottom-left", desk).y - DESK_GAP / 2 };
    const row = seamsAt(grid, "tl", edge("right"), { x: cross.x, y: 200 });
    expect(sorted(row.x)).toEqual({ axis: "x", before: ["tl"], after: ["tr"] });
    // Any of the four corners at the crossing takes hold of both gutters, whole.
    for (const [id, corner] of [
      ["tl", { left: false, right: true, top: false, bottom: true }],
      ["br", { left: true, right: false, top: true, bottom: false }],
    ] as const) {
      const { x, y } = seamsAt(grid, id, corner, cross);
      expect(sorted(x)).toEqual({ axis: "x", before: ["bl", "tl"], after: ["br", "tr"] });
      expect(sorted(y)).toEqual({ axis: "y", before: ["tl", "tr"], after: ["bl", "br"] });
    }
  });

  it("goes no further than leaves every window on it its least size, and sticks to a gutter it passes", () => {
    const left = { x: 100, y: 0, w: 500, h: 400 };
    const right = { x: 608, y: 0, w: 500, h: 400 };
    const pair = rects({ left, right });
    const seam: Seam = { axis: "x", before: ["left"], after: ["right"] };
    expect(seamTravel(pair, seam, 1_000, [])).toBe(500 - 300);
    expect(seamTravel(pair, seam, -1_000, [])).toBe(-(500 - 300));
    // Below them, another pair's gutter 30px to the right: within reach, the gutter lines up with it.
    const below = [
      { x: 100, y: 408, w: 530, h: 400 },
      { x: 638, y: 408, w: 470, h: 400 },
    ];
    expect(seamTravel(pair, seam, 24, below)).toBe(30);
    expect(seamTravel(pair, seam, 60, below)).toBe(60);
  });

  it("goes only as far as its smallest window on each side allows, and shrinks none already under its least size", () => {
    // One window left of the gutter; two right of it, stacked, one narrow and one wide.
    const after = rects({
      left: { x: 100, y: 0, w: 900, h: 808 },
      narrow: { x: 1008, y: 0, w: 320, h: 400 },
      wide: { x: 1008, y: 408, w: 700, h: 400 },
    });
    const right: Seam = { axis: "x", before: ["left"], after: ["narrow", "wide"] };
    expect(seamTravel(after, right, 400, [])).toBe(320 - 300);
    // The same, mirrored: two of different widths left of the gutter.
    const before = rects({
      narrow: { x: 680, y: 0, w: 320, h: 400 },
      wide: { x: 300, y: 408, w: 700, h: 400 },
      right: { x: 1008, y: 0, w: 900, h: 808 },
    });
    const left: Seam = { axis: "x", before: ["narrow", "wide"], after: ["right"] };
    expect(seamTravel(before, left, -400, [])).toBe(-(320 - 300));
    // A window smaller than a window may be already: the gutter does not go its way, but goes the other.
    const under = rects({
      left: { x: 100, y: 0, w: 900, h: 808 },
      narrow: { x: 1008, y: 0, w: 280, h: 400 },
      wide: { x: 1008, y: 408, w: 700, h: 400 },
    });
    expect(seamTravel(under, right, 100, [])).toBe(0);
    expect(seamTravel(under, right, -100, [])).toBe(-100);
  });
});

describe("carrying the desk to another size", () => {
  it("keeps a gutter a gutter, and a window against the desk's edge against it", () => {
    const after = { ...desk, w: desk.w * 1.6, h: desk.h * 0.8 };
    const tiles = (["top-left", "top-right", "bottom-left", "bottom-right"] as const).map((zone) => rescaleRect(zoneRect(zone, desk), desk, after));
    for (const [index, zone] of (["top-left", "top-right", "bottom-left", "bottom-right"] as const).entries()) {
      const expected = zoneRect(zone, after);
      for (const key of ["x", "y", "w", "h"] as const) expect(tiles[index]![key]).toBeCloseTo(expected[key], 6);
    }
    expect(rescaleRect(desk, desk, after)).toEqual(after);
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

  it("frames windows with the Drawer by default; a desk saved before it was, with the old default's Title bar, comes back with the Drawer once", () => {
    expect(DEFAULT_DESK_VARIANTS.chrome).toBe("drawer");
    expect(readPersistedDesk(null).variants.chrome).toBe("drawer");
    // Saved before (no version): "bar" was every desk's, chosen or not.
    expect(readPersistedDesk(JSON.stringify({ variants: { chrome: "bar", grab: "alt" } })).variants).toMatchObject({ chrome: "drawer", grab: "alt" });
    // Another frame was a choice.
    expect(readPersistedDesk(JSON.stringify({ variants: { chrome: "tab" } })).variants.chrome).toBe("tab");
    // Saved since: the Title bar is a choice too.
    expect(readPersistedDesk(JSON.stringify({ version: 2, variants: { chrome: "bar" } })).variants.chrome).toBe("bar");
  });

  it("keeps Glide's deceleration a whole percent within its range, and the default for anything else", () => {
    expect(sanitizeVariants({ deceleration: 44.6 }).deceleration).toBe(45);
    expect(sanitizeVariants({ deceleration: 2 }).deceleration).toBe(GLIDE_DECELERATION.min);
    expect(sanitizeVariants({ deceleration: 99 }).deceleration).toBe(GLIDE_DECELERATION.max);
    expect(sanitizeVariants({ deceleration: "fast" }).deceleration).toBe(GLIDE_DECELERATION.default);
    expect(sanitizeVariants({ deceleration: Number.NaN }).deceleration).toBe(GLIDE_DECELERATION.default);
  });
});

describe("Glide's deceleration", () => {
  it("is the share of its speed a coasting window loses every 100 ms", () => {
    for (const deceleration of [10, 28, 60]) {
      expect(glideDecay(1_000, 0.1, glideTauFor(deceleration))).toBeCloseTo(1_000 * (1 - deceleration / 100), 6);
    }
  });

  it("by default coasts as the desk always has", () => {
    expect(Math.abs(glideTauFor(GLIDE_DECELERATION.default) - GLIDE_TAU_S)).toBeLessThan(0.01);
  });

  it("coasts for less time the higher it is, and holds to its range", () => {
    expect(glideTauFor(60)).toBeLessThan(glideTauFor(28));
    expect(glideTauFor(28)).toBeLessThan(glideTauFor(10));
    expect(glideTauFor(0)).toBe(glideTauFor(GLIDE_DECELERATION.min));
    expect(glideTauFor(100)).toBe(glideTauFor(GLIDE_DECELERATION.max));
  });
});

describe("where a window brought out of the dock goes", () => {
  it("goes in the middle of an empty desk", () => {
    expect(placeNewWindow([], desk, null)).toEqual({ rect: centeredRect(desk), split: null, kind: "first" });
  });

  it("takes the other half beside a half, and the fourth quarter beside three", () => {
    expect(placeNewWindow([zoneRect("left", desk)], desk, 0)).toEqual({ rect: zoneRect("right", desk), split: null, kind: "hole" });
    const three = [zoneRect("top-left", desk), zoneRect("top-right", desk), zoneRect("bottom-left", desk)];
    const placed = placeNewWindow(three, desk, 2);
    expect(placed.split).toBeNull();
    expect(placed.rect.x).toBeCloseTo(zoneRect("bottom-right", desk).x);
    expect(placed.rect.y).toBeCloseTo(zoneRect("bottom-right", desk).y);
    expect(placed.rect.w).toBeCloseTo(zoneRect("bottom-right", desk).w);
    expect(placed.rect.h).toBeCloseTo(zoneRect("bottom-right", desk).h);
  });

  it("splits the window in use when a tiled desk is full: one filling it becomes the two halves", () => {
    expect(placeNewWindow([{ ...desk }], desk, 0)).toEqual({
      rect: zoneRect("right", desk),
      split: { index: 0, rect: zoneRect("left", desk) },
      kind: "split",
    });
    // Two halves: the one in use splits top and bottom (it is taller than wide).
    const halves = [zoneRect("left", desk), zoneRect("right", desk)];
    const placed = placeNewWindow(halves, desk, 1);
    expect(placed.split?.index).toBe(1);
    expect(placed.split?.rect).toEqual(splitRect(zoneRect("right", desk))![0]);
    expect(placed.rect).toEqual(splitRect(zoneRect("right", desk))![1]);
  });

  it("sets a window down among freely placed ones where it covers least, at the size windows come out at", () => {
    const loose = [
      { x: desk.x + 60, y: 40, w: 420, h: 300 },
      { x: desk.x + 200, y: 120, w: 420, h: 300 },
    ];
    const placed = placeNewWindow(loose, desk, 1);
    expect(placed.split).toBeNull();
    expect(placed.rect).toEqual(freeSpot(loose, windowSize(desk), desk));
    // A single window floating in the middle is not a tile either.
    expect(placeNewWindow([centeredRect(desk)], desk, 0).split).toBeNull();
  });

  it("finds the hole a tiled desk has left, and knows a tile", () => {
    expect(largestEmptyRect([{ ...desk }], desk)).toBeNull();
    const hole = largestEmptyRect([zoneRect("left", desk)], desk)!;
    expect(hole.x).toBeCloseTo(zoneRect("right", desk).x);
    expect(hole.w).toBeCloseTo(zoneRect("right", desk).w);
    expect(isTile(zoneRect("top-left", desk), desk)).toBe(true);
    expect(isTile(tileRects(9, desk)[4]!, desk)).toBe(true);
    expect(isTile(centeredRect(desk), desk)).toBe(false);
  });
});

describe("the drop rail over the sidebar", () => {
  // The sidebar's column, left of the stage: a rail of 48px, from the window's top (the stage starts 8px down).
  const side = { x: -48, y: -8, w: 48, h: 896 };
  it("stands in the sidebar's column: back into the dock above, a smaller close below", () => {
    const drops = sidebarDrops(side);
    expect(drops.away.x).toBe(-42);
    expect(drops.away.w).toBe(36);
    expect(drops.away.y).toBe(-2);
    expect(drops.close.y + drops.close.h).toBe(882);
    expect(drops.close.h).toBeLessThan(drops.away.h);
    expect(drops.close.y - (drops.away.y + drops.away.h)).toBe(DESK_GAP);
    // A short column still has both.
    const short = sidebarDrops({ ...side, h: 260 });
    expect(short.close.h).toBeGreaterThan(40);
    expect(short.away.h).toBeGreaterThan(40);
    // The window's buttons over the column's top: the rail starts below them, and ends where it did.
    const clear = sidebarDrops(side, 6, DESK_GAP, 34);
    expect(clear.away.y).toBe(34);
    expect(clear.close.y + clear.close.h).toBe(882);
    expect(clear.close.y - (clear.away.y + clear.away.h)).toBe(DESK_GAP);
  });

  it("takes a pointer left of the desk, split where its segments meet; the desk's own edge band is the left half's", () => {
    const drops = sidebarDrops(side);
    const edge = 0;
    expect(dockDropAt({ x: -24, y: 200 }, drops, edge)).toBe("away");
    expect(dockDropAt({ x: -24, y: 800 }, drops, edge)).toBe("close");
    // Further out, past the sidebar, is still the rail.
    expect(dockDropAt({ x: -140, y: 300 }, drops, edge)).toBe("away");
    expect(dockDropAt({ x: edge + 1, y: 300 }, drops, edge)).toBeNull();
    // Nowhere to drop without a sidebar.
    expect(dockDropAt({ x: -24, y: 300 }, { away: { x: 0, y: 0, w: 0, h: 0 }, close: { x: 0, y: 0, w: 0, h: 0 } }, edge)).toBeNull();
    const bounds = { x: 8, y: 0, w: 1100, h: 880 };
    expect(edgeZone({ x: edge + 1, y: 440 }, bounds, 18, 96, 30)).toBe("left");
    expect(edgeZone({ x: bounds.x + 28, y: 440 }, bounds, 18, 96, 30)).toBe("left");
    expect(edgeZone({ x: bounds.x + 28, y: 30 }, bounds, 18, 96, 30)).toBe("top-left");
    expect(edgeZone({ x: bounds.x + 40, y: 440 }, bounds, 18, 96, 30)).toBeNull();
  });
});

describe("resizing a picture (a masked window)", () => {
  const bounds = { x: 0, y: 0, w: 1600, h: 1000 };
  // A 400×300 region under an 18px handle.
  const start = { x: 200, y: 100, w: 400, h: 318 };
  const all = (edges: Partial<Record<"left" | "right" | "top" | "bottom", boolean>>) => ({ left: false, right: false, top: false, bottom: false, ...edges });

  it("keeps the region's shape from a side edge, the opposite side and the top holding still", () => {
    const wider = resizedKeepingAspect(start, all({ right: true }), 200, 0, bounds, 18, 16);
    expect(wider).toEqual({ x: 200, y: 100, w: 600, h: 450 + 18 });
    const fromLeft = resizedKeepingAspect(start, all({ left: true }), 100, 0, bounds, 18, 16);
    expect(fromLeft.x + fromLeft.w).toBeCloseTo(600);
    expect(fromLeft.w / (fromLeft.h - 18)).toBeCloseTo(4 / 3);
  });

  it("scales by the axis moved more at a corner, the opposite corner holding still", () => {
    const corner = resizedKeepingAspect(start, all({ right: true, bottom: true }), 40, 150, bounds, 18, 16);
    expect(corner.h - 18).toBeCloseTo(450);
    expect(corner.w).toBeCloseTo(600);
    const topLeft = resizedKeepingAspect(start, all({ left: true, top: true }), 100, 10, bounds, 18, 16);
    expect(topLeft.x + topLeft.w).toBeCloseTo(600);
    expect(topLeft.y + topLeft.h).toBeCloseTo(418);
    expect(topLeft.w).toBeCloseTo(300);
  });

  it("stops at the least region and at the desk's edge, its shape kept", () => {
    const tiny = resizedKeepingAspect(start, all({ right: true }), -1000, 0, bounds, 18, 16);
    expect(tiny.h - 18).toBeCloseTo(16);
    expect(tiny.w).toBeCloseTo(16 * (4 / 3));
    const huge = resizedKeepingAspect(start, all({ right: true, bottom: true }), 5000, 5000, bounds, 18, 16);
    expect(huge.y + huge.h).toBeLessThanOrEqual(1000 + 1e-6);
    expect(huge.w / (huge.h - 18)).toBeCloseTo(4 / 3);
  });

  it("lets a masked window be smaller than a page window may be", () => {
    expect(clampRect({ x: 10, y: 10, w: 80, h: 60 }, bounds, { w: 16, h: 34 })).toEqual({ x: 10, y: 10, w: 80, h: 60 });
    expect(clampRect({ x: 10, y: 10, w: 80, h: 60 }, bounds).w).toBe(300);
  });
});

describe("editedMaskRegion", () => {
  const page = { w: 1000, h: 700 };
  const start = { x: 200, y: 150, w: 400, h: 300 };
  const edges = (on: Partial<Record<"left" | "right" | "top" | "bottom", boolean>>) => ({ left: false, right: false, top: false, bottom: false, ...on });

  it("moves the edges in hand, the opposite ones holding still", () => {
    expect(editedMaskRegion(start, edges({ right: true, bottom: true }), 50, -20, page, 16)).toEqual({ x: 200, y: 150, w: 450, h: 280 });
    expect(editedMaskRegion(start, edges({ left: true, top: true }), -30, 40, page, 16)).toEqual({ x: 170, y: 190, w: 430, h: 260 });
  });

  it("never passes the page's edges", () => {
    expect(editedMaskRegion(start, edges({ left: true, top: true }), -500, -500, page, 16)).toEqual({ x: 0, y: 0, w: 600, h: 450 });
    expect(editedMaskRegion(start, edges({ right: true, bottom: true }), 900, 900, page, 16)).toEqual({ x: 200, y: 150, w: 800, h: 550 });
  });

  it("never grows smaller than the least a mask may be", () => {
    expect(editedMaskRegion(start, edges({ right: true }), -900, 0, page, 16)).toEqual({ x: 200, y: 150, w: 16, h: 300 });
    expect(editedMaskRegion(start, edges({ top: true }), 0, 900, page, 16)).toEqual({ x: 200, y: 434, w: 400, h: 16 });
  });

  it("moves the whole region, kept on the page", () => {
    expect(editedMaskRegion(start, null, 100, 50, page, 16)).toEqual({ x: 300, y: 200, w: 400, h: 300 });
    expect(editedMaskRegion(start, null, 900, -900, page, 16)).toEqual({ x: 600, y: 0, w: 400, h: 300 });
  });
});

describe("timed motion's easing", () => {
  it("is CSS's cubic-bézier: from 0 to 1, as a browser computes it", () => {
    const ease = cubicBezier(0.25, 0.1, 0.25, 1);
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    // CSS `ease` halfway through its time is about 80% of the way.
    expect(ease(0.5)).toBeCloseTo(0.8024, 3);
    expect(cubicBezier(0, 0, 1, 1)(0.3)).toBeCloseTo(0.3, 5);
  });

  it("smooth ease-out goes most of the way early, settles softly, and never past the end", () => {
    let last = 0;
    for (let step = 1; step <= 100; step += 1) {
      const value = EASE_SMOOTH_OUT(step / 100);
      expect(value).toBeGreaterThanOrEqual(last);
      expect(value).toBeLessThanOrEqual(1);
      last = value;
    }
    expect(EASE_SMOOTH_OUT(0.25)).toBeGreaterThan(0.6);
  });
});
