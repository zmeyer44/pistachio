import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_BAND_PX,
  CHAT_MAX_SHARE,
  CHAT_W,
  DOCK_GAP,
  FLOAT_EDGE,
  FLOAT_MIN,
  anchors,
  boxFromSpot,
  chatApproach,
  chatBox,
  chatResized,
  dockSlot,
  dockZone,
  dragFloor,
  fitFloatSize,
  nearestAnchor,
  readFloatSpot,
  resizedBox,
  restFor,
  restInStage,
  rubber,
  snapZone,
  spotFromBox,
  writeFloatSpot,
  zoneBox,
  type FloatArea,
} from "../src/lib/desk/answer-float";
import { DESK_GAP, SNAP_EDGE } from "../src/lib/desk/geometry";

/** A lane 1200×800 with the Bar 680 wide at its foot, 52 tall. */
const AREA: FloatArea = { w: 1200, h: 800, barX: 260, barW: 680, barTop: 748 };

describe("where the answer may float", () => {
  it("docks into a slot as wide as the pill, on it, its foot just above it", () => {
    expect(dockSlot(AREA, 300)).toEqual({ x: 260, y: 748 - DOCK_GAP - 300, w: 680, h: 300 });
    // Never wider than the pill, nor taller than the lane holds above it.
    expect(dockSlot({ ...AREA, barW: 300 }, 300)).toMatchObject({ x: 260, w: 300 });
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

/** The same lane in its desk (the stage reaching DESK_GAP past it either side), its Bar as the desk draws it: 480 wide, beside the nub. */
const DESK: FloatArea = { ...AREA, barX: 1200 - 46 - 480, barW: 480, stage: { x: -DESK_GAP, y: 0, w: 1200 + 2 * DESK_GAP, h: 800 } };
const RIGHT = 1200 + DESK_GAP;

describe("where the answer snaps", () => {
  it("lights a window's zones pushed into an edge, and the chat's own place toward the trailing side short of it", () => {
    expect(snapZone(DESK, { x: -DESK_GAP + 4, y: 400 })).toBe("left");
    // (Past an edge counts as at it.)
    expect(snapZone(DESK, { x: -60, y: 400 })).toBe("left");
    expect(snapZone(DESK, { x: RIGHT - 4, y: 400 })).toBe("right");
    expect(snapZone(DESK, { x: RIGHT - 4, y: 20 })).toBe("top-right");
    expect(snapZone(DESK, { x: 600, y: 4 })).toBe("maximize");
    // Short of the trailing edge: the chat's place, the whole band's width in from it.
    expect(snapZone(DESK, { x: RIGHT - SNAP_EDGE - 2, y: 400 })).toBe("chat");
    expect(snapZone(DESK, { x: RIGHT - SNAP_EDGE - CHAT_BAND_PX + 2, y: 120 })).toBe("chat");
    expect(snapZone(DESK, { x: RIGHT - SNAP_EDGE - CHAT_BAND_PX - 2, y: 400 })).toBeNull();
    expect(snapZone(DESK, { x: 600, y: 400 })).toBeNull();
    // Its hint brightens as the pointer comes toward it, whole at its band.
    expect(chatApproach(DESK, { x: 200, y: 400 })).toBe(0);
    expect(chatApproach(DESK, { x: RIGHT - SNAP_EDGE - CHAT_BAND_PX, y: 400 })).toBe(1);
    expect(chatApproach(DESK, { x: RIGHT - 300, y: 400 })).toBeGreaterThan(0);
  });

  it("puts the chat's place at the trailing side, the desk's whole height, as wide as it was left", () => {
    expect(chatBox(DESK, CHAT_W)).toEqual({ x: RIGHT - CHAT_W, y: 0, w: CHAT_W, h: 800 });
    expect(zoneBox(DESK, "chat", 400, { w: 440, h: 300 })).toMatchObject({ x: RIGHT - 400, w: 400 });
    // No narrower than a floating card, no wider than its share of the desk.
    expect(chatBox(DESK, 100).w).toBe(FLOAT_MIN.w);
    expect(chatBox(DESK, 5000).w).toBe((1200 + 2 * DESK_GAP) * CHAT_MAX_SHARE);
    // Resized from its leading edge: its trailing edge holds.
    const from = chatBox(DESK, CHAT_W);
    const wider = chatResized(DESK, from, -100);
    expect(wider.w).toBe(CHAT_W + 100);
    expect(wider.x + wider.w).toBe(RIGHT);
  });

  it("snaps into a window's tiles, stopping above the Bar over its span", () => {
    const half = (1200 + 2 * DESK_GAP - DESK_GAP) / 2;
    // The leading half lies beside the Bar's span here: the desk's whole height, flush with its edges.
    expect(zoneBox(DESK, "left", CHAT_W, { w: 440, h: 300 })).toEqual({ x: -DESK_GAP, y: 0, w: half, h: 800 });
    // The trailing half is over the Bar: down to a gap above its line.
    expect(zoneBox(DESK, "right", CHAT_W, { w: 440, h: 300 })).toEqual({ x: -DESK_GAP + half + DESK_GAP, y: 0, w: half, h: 748 - DESK_GAP });
    expect(zoneBox(DESK, "maximize", CHAT_W, { w: 440, h: 300 })).toMatchObject({ x: -DESK_GAP, y: 0, h: 748 - DESK_GAP });
    // The middle tile is the card at its own size, centred.
    const centre = zoneBox(DESK, "center", CHAT_W, { w: 440, h: 300 });
    expect(centre).toMatchObject({ w: 440, h: 300 });
    expect(centre.x + centre.w / 2).toBeCloseTo(600);
  });

  it("resized out of a tile, rests where it was, flush with the desk's edges and clear of the Bar", () => {
    expect(restInStage(DESK, { x: -DESK_GAP, y: 0, w: 500, h: 800 })).toEqual({ x: -DESK_GAP, y: 0 });
    expect(restInStage(DESK, { x: 760, y: 600, w: 500, h: 400 })).toEqual({ x: RIGHT - 500, y: 748 - DESK_GAP - 400 });
    // And a resize may reach the desk's edges, not only the lane's.
    const all = { l: false, r: false, t: false, b: false };
    expect(resizedBox(DESK, { x: -DESK_GAP, y: 0, w: 600, h: 800 }, { ...all, l: true }, -40, 0, DESK.stage).x).toBe(-DESK_GAP);
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

  it("keeps a card left in the desk's frame by a resize there: flush with the desk, not moved in to the lane's corner", () => {
    // A left tile resized: flush with the desk's leading edge (a gutter out of the lane), the desk's full height.
    const box = { x: -DESK_GAP, y: 0, w: 634, h: 800 };
    writeFloatSpot({ ...spotFromBox(DESK, box, true), inStage: true });
    const spot = readFloatSpot();
    expect(spot?.inStage).toBe(true);
    expect(boxFromSpot(DESK, spot!)).toEqual(box);
    // (As a floating card it would be moved in to the lane's corner and cut short of its edges: 12, 12, 634×776.)
    expect(boxFromSpot(DESK, { ...spot!, inStage: undefined })).toEqual({ x: FLOAT_EDGE, y: FLOAT_EDGE, w: 634, h: 776 });
    // In a zone it is the zone's, never the frame's.
    writeFloatSpot({ floating: true, fx: 0, fy: 0, w: 634, h: 800, zone: "left", inStage: true });
    expect(readFloatSpot()?.inStage).toBeUndefined();
  });

  it("keeps the zone it is snapped in and the chat's width, and comes back in that zone", () => {
    writeFloatSpot({ floating: true, fx: 0.5, fy: 0, w: 440, h: 360, zone: "chat", cw: 420 });
    const spot = readFloatSpot();
    expect(spot).toEqual({ floating: true, fx: 0.5, fy: 0, w: 440, h: 360, zone: "chat", cw: 420 });
    expect(boxFromSpot(DESK, spot!)).toEqual(chatBox(DESK, 420));
    // (A zone it does not know is no zone.)
    store.set("pistachio.desk.answer.v1", JSON.stringify({ floating: true, fx: 0, fy: 0, w: 440, h: 360, zone: "sideways" }));
    expect(readFloatSpot()?.zone).toBeUndefined();
  });

  it("reads nothing from what is not a spot", () => {
    store.set("pistachio.desk.answer.v1", JSON.stringify({ floating: "yes" }));
    expect(readFloatSpot()).toBeNull();
    store.set("pistachio.desk.answer.v1", "{");
    expect(readFloatSpot()).toBeNull();
  });
});
