/**
 * The window's own marks under the browser's own surfaces
 * (docs/live-share.md §6.3, components/live-host/chrome-cut.ts): the layer
 * of the outlines is drawn whole with nothing over the desk, not at all
 * while something no box holds lies over it, and otherwise clipped to what
 * the boxes leave of the window — every point under a box cut out, every
 * other point drawn once — the boxes grown out to whole px, overlapping or
 * reaching off the window as they may; and the session hands the layer
 * main's word as it comes.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { idleLiveShare, type LiveRect } from "@pistachio/shell-contracts/live-share";
import { chromeCut, uncovered } from "../src/components/live-host/chrome-cut";
import { LiveHostSession } from "../src/components/live-host/host-session";

vi.mock("@pistachio/live-share/room", () => ({ LiveRoom: { connect: vi.fn() }, WINDOW_CAPTURE_MAX_SIDE: 2560, WINDOW_MAX_FPS: 30 }));

const WINDOW = { w: 1280, h: 820 };
/** A toast at the foot of the browser surface, and the Live card's column beside the sidebar. */
const TOAST: LiveRect = { x: 512.4, y: 726.5, w: 263.2, h: 50 };
const COLUMN: LiveRect = { x: 252, y: 40, w: 346, h: 790 };

const inside = (box: LiveRect, x: number, y: number): boolean => x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;

/** The boxes a clip path of `M x y h w v h h -w z` boxes draws, read back. */
function boxesOf(clipPath: string): LiveRect[] {
  const path = /^path\("(.*)"\)$/.exec(clipPath)?.[1] ?? "";
  return [...path.matchAll(/M(-?[\d.]+) (-?[\d.]+)h(-?[\d.]+)v(-?[\d.]+)h(-?[\d.]+)z/g)].map((match) => {
    const [x, y, w, h, back] = match.slice(1).map(Number) as [number, number, number, number, number];
    expect(back).toBe(-w);
    return { x, y, w, h };
  });
}

/** Every point of the window (at a 1 px grid, offset half a px) drawn by how many of `drawn`, and under any of `holes`. */
function sample(drawn: readonly LiveRect[], holes: readonly LiveRect[]): { twice: number; underHole: number; missing: number } {
  let twice = 0;
  let underHole = 0;
  let missing = 0;
  for (let y = 0.5; y < WINDOW.h; y += 4) {
    for (let x = 0.5; x < WINDOW.w; x += 4) {
      const count = drawn.filter((box) => inside(box, x, y)).length;
      const under = holes.some((hole) => inside(hole, x, y));
      if (count > 1) twice += 1;
      if (under && count > 0) underHole += 1;
      if (!under && count === 0) missing += 1;
    }
  }
  return { twice, underHole, missing };
}

describe("the outlines' layer under the browser's own surfaces", () => {
  it("is drawn whole with nothing over the desk, and with nothing over the window", () => {
    expect(chromeCut([], WINDOW)).toEqual({ kind: "whole" });
    expect(chromeCut([{ x: -400, y: 0, w: 300, h: 800 }, { x: 0, y: 900, w: 100, h: 10 }, { x: 10, y: 10, w: 0, h: 40 }], WINDOW)).toEqual({ kind: "whole" });
  });

  it("is not drawn at all while something no box holds lies over the desk (the palette's scrim, a menu, a passing)", () => {
    expect(chromeCut(null, WINDOW)).toEqual({ kind: "hidden" });
  });

  it("is not drawn at all when the boxes leave nothing of the window", () => {
    expect(chromeCut([{ x: -10, y: -10, w: 2000, h: 2000 }], WINDOW)).toEqual({ kind: "hidden" });
  });

  it("is cut out under a toast, grown out to whole px, and drawn everywhere else exactly once", () => {
    const cut = chromeCut([TOAST], WINDOW);
    expect(cut.kind).toBe("cut");
    if (cut.kind !== "cut") return;
    expect(cut.holes).toEqual([{ x: 512, y: 726, w: 264, h: 51 }]);
    const drawn = boxesOf(cut.clipPath);
    expect(sample(drawn, cut.holes)).toEqual({ twice: 0, underHole: 0, missing: 0 });
    // Right at the toast's edges: its own pixels cut, the ones beside them drawn.
    expect(drawn.some((box) => inside(box, 512.5, 750))).toBe(false);
    expect(drawn.some((box) => inside(box, 511.5, 750))).toBe(true);
    expect(drawn.some((box) => inside(box, 600, 776.5))).toBe(false);
    expect(drawn.some((box) => inside(box, 600, 777.5))).toBe(true);
  });

  it("is cut out under boxes that overlap, and under one reaching off the window, as their union", () => {
    const holes = [TOAST, COLUMN, { x: 1200, y: -20, w: 200, h: 60 }];
    const cut = chromeCut(holes, WINDOW);
    expect(cut.kind).toBe("cut");
    if (cut.kind !== "cut") return;
    const drawn = boxesOf(cut.clipPath);
    expect(sample(drawn, cut.holes)).toEqual({ twice: 0, underHole: 0, missing: 0 });
    expect(drawn.every((box) => box.x >= 0 && box.y >= 0 && box.x + box.w <= WINDOW.w && box.y + box.h <= WINDOW.h)).toBe(true);
  });

  it("keeps the path small: a run level with the one beside it, and as tall, is one box with it", () => {
    // One hole in the middle: above it, below it, and either side of it — four boxes, not a column's worth.
    expect(uncovered({ x: 0, y: 0, w: 100, h: 100 }, [{ x: 40, y: 40, w: 20, h: 20 }])).toEqual([
      { x: 0, y: 0, w: 40, h: 100 },
      { x: 40, y: 0, w: 20, h: 40 },
      { x: 40, y: 60, w: 20, h: 40 },
      { x: 60, y: 0, w: 40, h: 100 },
    ]);
    expect(uncovered({ x: 0, y: 0, w: 100, h: 100 }, [])).toEqual([{ x: 0, y: 0, w: 100, h: 100 }]);
  });
});

describe("main's word on what lies over the desk", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reaches the layer as it starts and as it changes, and no more once the share is over", () => {
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), devicePixelRatio: 2, innerWidth: 1280, innerHeight: 820 });
    const live = new LiveHostSession(
      { livekit: { url: "ws://room.test", token: "host-token" }, shareId: "share-1", state: { ...idleLiveShare(), status: "live" }, frame: null, shell: null, stage: null, chrome: [TOAST], admitted: [] },
      { sendLiveHostReport: () => undefined, liveHostSource: async () => null, liveHostShellSource: async () => null },
    );
    const heard: Array<readonly LiveRect[] | null> = [];
    live.onChrome((over) => heard.push(over));
    live.handle({ type: "chrome", over: [TOAST, COLUMN] });
    live.handle({ type: "chrome", over: null });
    live.dispose();
    live.handle({ type: "chrome", over: [] });
    expect(heard).toEqual([[TOAST], [TOAST, COLUMN], null]);
  });
});
