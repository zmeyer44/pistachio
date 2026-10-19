import { describe, expect, it } from "vitest";
import {
  fitStage,
  normalizedToStage,
  normalizedToViewport,
  pageLocal,
  stagePoint,
  stageRectToViewport,
  stageToNormalized,
  viewportToNormalized,
  windowAt,
  type LiveDeskFrame,
  type LiveWindow,
  type Rect,
} from "../src/index.js";

function win(id: string, frame: Rect, extra: Partial<LiveWindow> = {}): LiveWindow {
  return {
    id,
    kind: "page",
    title: id,
    origin: null,
    favicon: null,
    frame,
    page: { x: frame.x, y: frame.y + 30, w: frame.w, h: frame.h - 30 },
    focused: false,
    minimized: false,
    controllable: false,
    track: null,
    paused: false,
    ...extra,
  };
}

function deskOf(windows: LiveWindow[]): LiveDeskFrame {
  return { v: 1, seq: 1, stage: { w: 1000, h: 500 }, hostPresent: true, space: { title: "S", color: "#3E63DD" }, windows };
}

describe("fitStage", () => {
  it("letterboxes a wide stage in a tall viewport, centred", () => {
    expect(fitStage({ w: 1600, h: 900 }, { w: 800, h: 900 })).toEqual({ scale: 0.5, x: 0, y: 225, w: 800, h: 450 });
  });

  it("pillarboxes a tall stage and leaves the padding free", () => {
    const fit = fitStage({ w: 1000, h: 1000 }, { w: 1200, h: 820 }, 10);
    expect(fit.scale).toBeCloseTo(0.8);
    expect(fit).toMatchObject({ w: 800, h: 800, x: 200, y: 10 });
  });

  it("scales up as well as down, and survives an empty stage", () => {
    expect(fitStage({ w: 400, h: 300 }, { w: 800, h: 600 }).scale).toBe(2);
    expect(fitStage({ w: 0, h: 0 }, { w: 800, h: 600 })).toEqual({ scale: 0, x: 400, y: 300, w: 0, h: 0 });
  });
});

describe("conversions", () => {
  const stage = { w: 1440, h: 900 };
  const fit = fitStage(stage, { w: 720, h: 600 });

  it("goes stage px → normalized → viewport and back", () => {
    const n = stageToNormalized(stage, { x: 720, y: 225 });
    expect(n).toEqual({ x: 0.5, y: 0.25 });
    expect(normalizedToStage(stage, n)).toEqual({ x: 720, y: 225 });
    const v = normalizedToViewport(fit, n);
    expect(v).toEqual({ x: 360, y: fit.y + 112.5 });
    expect(viewportToNormalized(fit, v)).toEqual(n);
  });

  it("maps a window's frame onto the guest's stage", () => {
    expect(stageRectToViewport(fit, { x: 144, y: 90, w: 720, h: 450 })).toEqual({ x: 72, y: fit.y + 45, w: 360, h: 225 });
  });

  it("reads a client point over the stage element, clamped, and says whether it was inside", () => {
    const box = { left: 100, top: 50, width: 400, height: 200 };
    expect(stagePoint(box, 300, 150)).toEqual({ x: 0.5, y: 0.5, inside: true });
    expect(stagePoint(box, 50, 300)).toEqual({ x: 0, y: 1, inside: false });
    expect(stagePoint({ left: 0, top: 0, width: 0, height: 0 }, 1, 1).inside).toBe(false);
  });
});

describe("windowAt", () => {
  const bottom = win("bottom", { x: 0, y: 0, w: 600, h: 400 });
  const top = win("top", { x: 300, y: 100, w: 600, h: 300 });

  it("finds the top-most window under a point", () => {
    const frame = deskOf([bottom, top]);
    expect(windowAt(frame, 0.1, 0.1)?.id).toBe("bottom");
    expect(windowAt(frame, 0.4, 0.4)?.id).toBe("top");
    expect(windowAt(frame, 0.95, 0.95)).toBeNull();
  });

  it("skips minimized windows", () => {
    const frame = deskOf([bottom, { ...top, minimized: true }]);
    expect(windowAt(frame, 0.4, 0.4)?.id).toBe("bottom");
  });
});

describe("pageLocal", () => {
  it("is 0..1 of the page box, and null on the title strip", () => {
    const w = win("w", { x: 100, y: 100, w: 400, h: 230 });
    const stage = { w: 1000, h: 500 };
    expect(pageLocal(stage, w, 0.3, 0.46)).toEqual({ x: 0.5, y: 0.5 });
    expect(pageLocal(stage, w, 0.3, 0.21)).toBeNull();
  });
});
