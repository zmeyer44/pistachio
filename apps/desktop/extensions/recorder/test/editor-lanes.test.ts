import { describe, expect, it } from "vitest";
import type { Project, TimeMap } from "../src/lib/types.js";
import { INSET, RULER_HEIGHT, fitPps, hitTest, laneAtY, laneBox, outOfX, rulerStep, xOfOut, xOfSrc, type Scale } from "../src/editor/lanes.js";

/** Source = output, except that [10, 20) plays at 2× (output 10..15 covers it). */
function halfSpeedMap(): TimeMap {
  return {
    duration: 25,
    toOutput: (s) => (s < 10 ? s : s < 20 ? 10 + (s - 10) / 2 : s - 5),
    toSource: (o) => (o < 10 ? o : o < 15 ? 10 + (o - 10) * 2 : o + 5),
    rateAt: (o) => (o >= 10 && o < 15 ? 2 : 1),
  };
}

const project: Project = {
  v: 1,
  cuts: [
    { in: 0, out: 12 },
    { in: 12, out: 30 },
  ],
  zooms: [{ id: "z1", start: 2, end: 6, level: 2, center: [0.5, 0.5], auto: true, ease: "spring", follow: true }],
  speed: [
    { id: "s1", start: 10, end: 20, rate: 2, auto: "idle" },
    { id: "s2", start: 24, end: 27, rate: Infinity, auto: "idle" },
  ],
  zoom: { auto: true, feel: "mellow", maxLevel: 2.5 },
  look: { background: { type: "solid", color: "#fff" }, padding: 0.08, radius: 14, shadow: 0.6, frame: "none", aspect: "16:9" },
  cursor: { mode: "natural", size: 1, smoothing: 0.5, hideIdle: false, click: "ripple" },
  camera: { shape: "circle", size: 0.2, corner: "br", shrinkOnZoom: false },
  audio: { mic: 1, page: 1, muteSpedUp: true },
  export: { format: "mp4-h264", height: 1080, fps: 30, quality: "high" },
};

const scale: Scale = { pps: 20, map: halfSpeedMap() };
const mid = (lane: Parameters<typeof laneBox>[0]) => laneBox(lane).top + laneBox(lane).height / 2;

describe("the timeline's geometry", () => {
  it("places lanes under the ruler and finds them by y", () => {
    expect(laneAtY(4)).toBe("ruler");
    expect(laneBox("chapters").top).toBeGreaterThan(RULER_HEIGHT);
    for (const lane of ["chapters", "clip", "zoom", "speed", "events", "mic"] as const) expect(laneAtY(mid(lane))).toBe(lane);
    expect(laneAtY(10_000)).toBeNull();
  });

  it("maps source time through the time map into output pixels", () => {
    expect(xOfSrc(scale, 0)).toBe(INSET);
    expect(xOfSrc(scale, 20)).toBe(INSET + 15 * 20);
    expect(outOfX(scale, INSET + 15 * 20)).toBe(15);
    expect(outOfX(scale, -50)).toBe(0);
    expect(fitPps(1000 + INSET * 2, 25)).toBe(40);
  });

  it("picks ruler steps that leave room for labels", () => {
    expect(rulerStep(100).major).toBe(1);
    expect(rulerStep(10).major).toBe(10);
  });
});

describe("hit-testing", () => {
  it("finds the playhead on the ruler, else a time to seek to", () => {
    expect(hitTest(project, scale, xOfOut(scale, 7), 5, 7)).toEqual({ kind: "playhead" });
    expect(hitTest(project, scale, xOfOut(scale, 3), 5, 7)).toEqual({ kind: "ruler", tOut: 3 });
  });

  it("finds a zoom's edges and body, and empty lane beside it", () => {
    const y = mid("zoom");
    expect(hitTest(project, scale, xOfSrc(scale, 2) + 1, y, 0)).toEqual({ kind: "segment", lane: "zoom", id: "z1", part: "start" });
    expect(hitTest(project, scale, xOfSrc(scale, 6) - 1, y, 0)).toEqual({ kind: "segment", lane: "zoom", id: "z1", part: "end" });
    expect(hitTest(project, scale, xOfSrc(scale, 4), y, 0)).toEqual({ kind: "segment", lane: "zoom", id: "z1", part: "body" });
    expect(hitTest(project, scale, xOfSrc(scale, 9), y, 0)).toMatchObject({ kind: "lane", lane: "zoom" });
  });

  it("finds a speed segment in output space, and a cut in the plan as a marker", () => {
    const y = mid("speed");
    // Source 15 is output 12.5: the middle of the 2× bar.
    expect(hitTest(project, scale, xOfOut(scale, 12.5), y, 0)).toEqual({ kind: "segment", lane: "speed", id: "s1", part: "body" });
    // An Infinity segment has no width; it is caught near its start.
    const cut: Project = { ...project, speed: [{ id: "c", start: 24, end: 27, rate: Infinity, auto: "idle" }] };
    const zeroWidth: Scale = { pps: 20, map: { ...halfSpeedMap(), toOutput: (s) => (s < 24 ? s : s < 27 ? 24 : s - 3) } };
    expect(hitTest(cut, zeroWidth, xOfOut(zeroWidth, 24) + 2, y, 0)).toEqual({ kind: "segment", lane: "speed", id: "c", part: "body" });
  });

  it("finds clip pieces and the scissors between them", () => {
    const y = mid("clip");
    expect(hitTest(project, scale, xOfSrc(scale, 12), y, 0)).toEqual({ kind: "gap", index: 0 });
    expect(hitTest(project, scale, xOfSrc(scale, 3), y, 0)).toMatchObject({ kind: "clip", index: 0 });
    expect(hitTest(project, scale, xOfSrc(scale, 25), y, 0)).toMatchObject({ kind: "clip", index: 1 });
  });

  it("answers a time on the other lanes", () => {
    expect(hitTest(project, scale, xOfOut(scale, 4), mid("mic"), 0)).toEqual({ kind: "lane", lane: "mic", tOut: 4 });
  });
});
