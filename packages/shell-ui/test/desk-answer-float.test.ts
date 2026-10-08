import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DOCK_GAP,
  FLOAT_EDGE,
  FLOAT_MIN,
  anchors,
  boxFromSpot,
  dockSlot,
  dockZone,
  dragFloor,
  fitFloatSize,
  nearestAnchor,
  readFloatSpot,
  resizedBox,
  restFor,
  rubber,
  spotFromBox,
  writeFloatSpot,
  type FloatArea,
} from "../src/lib/desk/answer-float";

/** A lane 1200×800 with the Bar 680 wide at its foot, 52 tall. */
const AREA: FloatArea = { w: 1200, h: 800, barX: 260, barW: 680, barTop: 748 };

describe("where the answer may float", () => {
  it("docks into a slot as wide as the Bar, its foot just above it", () => {
    expect(dockSlot(AREA, 300)).toEqual({ x: 260, y: 748 - DOCK_GAP - 300, w: 680, h: 300 });
    // Never taller than the lane holds above the Bar.
    expect(dockSlot(AREA, 5000).y).toBe(FLOAT_EDGE);
  });

  it("rests clear of the Bar over its span, and down to the lane's foot beside it", () => {
    // Over the Bar: lifted above it.
    expect(restFor(AREA, { x: 400, y: 700, w: 440, h: 300 }, false)).toEqual({ x: 400, y: 748 - FLOAT_EDGE - 300 });
    // Beside it, in the corner, it may go down to the foot.
    expect(restFor(AREA, { x: 0, y: 700, w: 240, h: 300 }, false)).toEqual({ x: FLOAT_EDGE, y: 800 - 300 - FLOAT_EDGE });
    // Near an edge, it goes flush.
    expect(restFor(AREA, { x: 30, y: 30, w: 440, h: 300 })).toEqual({ x: FLOAT_EDGE, y: FLOAT_EDGE });
  });

  it("held over the Bar, goes no lower than its slot; moving onto the Bar's span lifts it smoothly", () => {
    const h = 300;
    const slotFoot = 748 - DOCK_GAP;
    expect(dragFloor(AREA, 400, 440, h)).toBe(slotFoot - h);
    expect(dragFloor(AREA, 0, 200, h)).toBe(800 - h);
    // From beside the Bar onto it, the floor falls by no more than a few px for each px moved.
    let last = dragFloor(AREA, 0, 240, h);
    for (let x = 1; x <= 60; x++) {
      const next = dragFloor(AREA, x, 240, h);
      expect(Math.abs(next - last)).toBeLessThan(5);
      last = next;
    }
  });

  it("settles into the anchors at each side's top, middle and foot, the foot clear of the Bar", () => {
    const spots = anchors(AREA, 440, 300);
    expect(spots).toEqual([
      { x: FLOAT_EDGE, y: FLOAT_EDGE },
      { x: FLOAT_EDGE, y: 250 },
      // (A card this wide lies over the Bar from either side, so its foot anchor is clear of it.)
      { x: FLOAT_EDGE, y: 748 - FLOAT_EDGE - 300 },
      { x: 1200 - 440 - FLOAT_EDGE, y: FLOAT_EDGE },
      { x: 1200 - 440 - FLOAT_EDGE, y: 250 },
      { x: 1200 - 440 - FLOAT_EDGE, y: 748 - FLOAT_EDGE - 300 },
    ]);
    expect(nearestAnchor(AREA, 1100, 120, 440, 300)?.spot).toEqual({ x: 1200 - 440 - FLOAT_EDGE, y: FLOAT_EDGE });
  });

  it("is over the dock zone with its foot down at the slot over the Bar, or with the pointer on the Bar", () => {
    const slot = dockSlot(AREA, 300);
    const above = { x: 380, y: 100, w: 440, h: 300 };
    expect(dockZone(AREA, slot, above, { x: 600, y: 120 }).inZone).toBe(false);
    const down = { x: 380, y: slot.y + slot.h - 300 - 10, w: 440, h: 300 };
    expect(dockZone(AREA, slot, down, { x: 600, y: 500 }).inZone).toBe(true);
    // Off to the side, low: not over the slot.
    expect(dockZone(AREA, slot, { x: 0, y: 440, w: 200, h: 300 }, { x: 100, y: 460 }).inZone).toBe(false);
    // The pointer on the Bar takes it, wherever the card hangs.
    expect(dockZone(AREA, slot, above, { x: 600, y: 770 }).inZone).toBe(true);
    // Coming nearer, the ghost's approach grows.
    const far = dockZone(AREA, slot, { ...above, y: 50 }, { x: 0, y: 0 }).approach;
    const near = dockZone(AREA, slot, { ...above, y: 300 }, { x: 0, y: 0 }).approach;
    expect(near).toBeGreaterThan(far);
  });

  it("resizes from an edge or corner, the opposite one holding still, no smaller than it may be and whole in the lane", () => {
    const from = { x: 400, y: 200, w: 440, h: 360 };
    const all = { l: false, r: false, t: false, b: false };
    expect(resizedBox(AREA, from, { ...all, r: true, b: true }, 100, 40)).toEqual({ x: 400, y: 200, w: 540, h: 400 });
    expect(resizedBox(AREA, from, { ...all, l: true, t: true }, -100, -40)).toEqual({ x: 300, y: 160, w: 540, h: 400 });
    // Squeezed: its smallest, the far edge holding.
    expect(resizedBox(AREA, from, { ...all, l: true }, 400, 0)).toEqual({ x: 840 - FLOAT_MIN.w, y: 200, w: FLOAT_MIN.w, h: 360 });
    // Stretched past the lane: whole in it.
    expect(resizedBox(AREA, from, { ...all, r: true }, 2000, 0).w).toBe(1200 - FLOAT_EDGE - 400);
  });

  it("fits a kept size to a smaller lane, and gives way past an edge with diminishing returns", () => {
    expect(fitFloatSize({ ...AREA, w: 300, h: 200 }, 440, 360)).toEqual({ w: 300 - 2 * FLOAT_EDGE, h: 200 - 2 * FLOAT_EDGE });
    expect(rubber(50, 0, 100)).toBe(50);
    expect(rubber(140, 0, 100)).toBeGreaterThan(100);
    expect(rubber(140, 0, 100)).toBeLessThan(140);
    expect(rubber(400, 0, 100) - 100).toBeLessThan(80);
    // Each side its own give: a floor pressed past hardly moves.
    expect(rubber(400, 0, 100, 80, 12) - 100).toBeLessThan(12);
    expect(rubber(-300, 0, 100, 80, 12)).toBeLessThan(-12);
  });
});

describe("the answer's spot, kept on this device", () => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  });
  afterEach(() => store.clear());

  it("is kept as a share of the lane, and comes back whole in a lane of another size", () => {
    const box = { x: 600, y: 100, w: 440, h: 360 };
    writeFloatSpot(spotFromBox(AREA, box, true));
    const spot = readFloatSpot();
    expect(spot).toEqual({ floating: true, fx: 0.5, fy: 0.125, w: 440, h: 360 });
    expect(boxFromSpot(AREA, spot!)).toEqual(box);
    // A smaller lane: same share of it, and whole in it.
    const small = { w: 800, h: 600, barX: 60, barW: 680, barTop: 548 };
    const back = boxFromSpot(small, spot!);
    expect(back.x + back.w).toBeLessThanOrEqual(800 - FLOAT_EDGE);
    expect(back.y).toBe(75);
  });

  it("reads nothing from what is not a spot", () => {
    store.set("pistachio.desk.answer.v1", JSON.stringify({ floating: "yes" }));
    expect(readFloatSpot()).toBeNull();
    store.set("pistachio.desk.answer.v1", "{");
    expect(readFloatSpot()).toBeNull();
  });
});
