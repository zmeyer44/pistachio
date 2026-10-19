import { describe, expect, it } from "vitest";
import { createStageBox, placeRect, relativeRect, stageArea, stageLayout } from "../src/react/index.js";

describe("stageArea", () => {
  it("is the viewport less its insets, never negative", () => {
    expect(stageArea({ w: 1440, h: 900 }, { top: 48, right: 100, bottom: 80, left: 20 })).toEqual({ x: 20, y: 48, w: 1320, h: 772 });
    expect(stageArea({ w: 100, h: 50 }, { top: 40, right: 80, bottom: 40, left: 40 })).toEqual({ x: 40, y: 40, w: 0, h: 0 });
  });
});

describe("stageLayout", () => {
  const stage = { w: 1600, h: 1000 };

  it("fits the whole stage into the area, centred, keeping its aspect", () => {
    const layout = stageLayout(stage, { x: 20, y: 40, w: 1000, h: 1000 });
    expect(layout.scale).toBeCloseTo(0.625);
    expect(layout.view).toEqual({ x: 20, y: 40 + (1000 - 625) / 2, w: 1000, h: 625 });
    expect(layout.visible).toEqual(layout.view);
  });

  it("scales a filled window to the area, the rest of the stage running off past it", () => {
    const frame = { x: 800, y: 500, w: 400, h: 250 };
    const area = { x: 0, y: 0, w: 1200, h: 900 };
    const layout = stageLayout(stage, area, frame);
    expect(layout.scale).toBeCloseTo(3);
    // The window's frame lands on the visible box, centred in the area.
    expect(placeRect(layout, frame)).toEqual(layout.visible);
    expect(layout.visible).toEqual({ x: 0, y: (900 - 750) / 2, w: 1200, h: 750 });
    expect(layout.view.w).toBeCloseTo(stage.w * 3);
    expect(layout.view.x).toBeCloseTo(-800 * 3);
  });

  it("ignores an empty fill", () => {
    const area = { x: 0, y: 0, w: 800, h: 500 };
    expect(stageLayout(stage, area, { x: 10, y: 10, w: 0, h: 20 })).toEqual(stageLayout(stage, area));
  });
});

describe("placeRect and relativeRect", () => {
  it("place a window's page box inside its frame on the page", () => {
    const layout = stageLayout({ w: 1000, h: 500 }, { x: 100, y: 50, w: 500, h: 250 });
    const frame = placeRect(layout, { x: 200, y: 100, w: 400, h: 300 });
    const page = placeRect(layout, { x: 200, y: 130, w: 400, h: 270 });
    expect(frame).toEqual({ x: 200, y: 100, w: 200, h: 150 });
    expect(relativeRect(page, frame)).toEqual({ x: 0, y: 15, w: 200, h: 135 });
  });
});

describe("createStageBox", () => {
  it("tells its listeners about a change, and only a change", () => {
    const box = createStageBox();
    let calls = 0;
    const off = box.subscribe(() => {
      calls += 1;
    });
    box.set({ x: 1, y: 2, w: 3, h: 4 });
    box.set({ x: 1, y: 2, w: 3, h: 4 });
    expect(calls).toBe(1);
    expect(box.get()).toEqual({ x: 1, y: 2, w: 3, h: 4 });
    off();
    box.set({ x: 0, y: 0, w: 1, h: 1 });
    expect(calls).toBe(1);
  });
});
