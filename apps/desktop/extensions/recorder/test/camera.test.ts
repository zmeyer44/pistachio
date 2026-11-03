import { describe, expect, it } from "vitest";
import { cameraAt, cameraPath, omegaFor, stepSpring, vanWijkNuij, viewportOf } from "../src/lib/camera.js";
import { pointerAt } from "../src/lib/events.js";
import { zoomSegments } from "../src/lib/zoom.js";
import type { CameraSample, Point, ZoomSegment } from "../src/lib/types.js";
import { FIXTURES, load } from "./fixtures.js";

const FPS = 60;
const noCursor = () => null;

function segment(over: Partial<ZoomSegment>): ZoomSegment {
  return { id: "z1", start: 1, end: 5, level: 2, center: [0.3, 0.4], auto: true, ease: "spring", follow: false, ...over };
}

function inside(sample: CameraSample): void {
  const half = 0.5 / sample.z;
  expect(sample.z).toBeGreaterThanOrEqual(1);
  expect(sample.cx - half).toBeGreaterThanOrEqual(-1e-9);
  expect(sample.cx + half).toBeLessThanOrEqual(1 + 1e-9);
  expect(sample.cy - half).toBeGreaterThanOrEqual(-1e-9);
  expect(sample.cy + half).toBeLessThanOrEqual(1 + 1e-9);
}

describe("the spring", () => {
  it("is the exact critically damped solution", () => {
    let p = 1;
    let v = 0;
    for (let i = 0; i < 100; i++) [p, v] = stepSpring(p, v, 0, 7, 0.007);
    const t = 0.7;
    expect(p).toBeCloseTo((1 + 7 * t) * Math.exp(-7 * t), 9);
  });

  it("Quick 10, Mellow 7, Slow 5", () => {
    expect([omegaFor("quick"), omegaFor("mellow"), omegaFor("slow")]).toEqual([10, 7, 5]);
  });
});

describe("cameraPath", () => {
  it("samples [0, duration] at fps", () => {
    expect(cameraPath([], 2, { omega: 7, fps: FPS, cursor: noCursor })).toHaveLength(121);
  });

  it("settles within 0.7 s at ω 7, in and back out", () => {
    const path = cameraPath([segment({})], 7, { omega: 7, fps: FPS, cursor: noCursor });
    expect(cameraAt(path, FPS, 1.0)).toEqual({ cx: 0.5, cy: 0.5, z: 1 });
    const settled = cameraAt(path, FPS, 1.7);
    expect(Math.abs(Math.log(settled.z) - Math.log(2))).toBeLessThanOrEqual(0.05 * Math.log(2));
    expect(Math.abs(settled.cx - 0.3)).toBeLessThanOrEqual(0.05 * 0.2);
    expect(Math.abs(settled.cy - 0.4)).toBeLessThanOrEqual(0.05 * 0.1);
    const out = cameraAt(path, FPS, 5.7);
    expect(Math.log(out.z)).toBeLessThanOrEqual(0.05 * Math.log(2));
  });

  it("Slow has not settled at 0.7 s; Quick has", () => {
    const at = (feel: "quick" | "slow") => cameraAt(cameraPath([segment({})], 3, { omega: omegaFor(feel), fps: FPS, cursor: noCursor }), FPS, 1.7).z;
    expect(at("quick")).toBeGreaterThan(at("slow"));
    expect(Math.log(at("slow"))).toBeLessThan(0.9 * Math.log(2));
  });

  it("never leaves the frame: edge centres, a cursor running off the view, overlapping and back-to-back segments", () => {
    const cursor = (t: number): Point => ({ x: 0.5 + 0.9 * Math.sin(t * 3), y: 0.5 + 0.9 * Math.cos(t * 2.3) });
    const segments: ZoomSegment[] = [
      segment({ start: 0.2, end: 2.4, level: 2.5, center: [0, 0], follow: true }),
      segment({ id: "z2", start: 2.4, end: 3.1, level: 2.5, center: [1, 1], follow: true }),
      segment({ id: "z3", start: 3.0, end: 6, level: 1.6, center: [0.95, 0.1], follow: true, anchors: [[0.05, 0.9, 3.2], [0.9, 0.95, 4]] }),
      segment({ id: "z4", start: 6.5, end: 7, level: 2.2, center: [0.1, 0.9], ease: "smooth" }),
      segment({ id: "z5", start: 7.2, end: 8, level: 2.4, center: [0.9, 0.2], ease: "cut" }),
    ];
    const path = cameraPath(segments, 9, { omega: 10, fps: FPS, cursor });
    for (const sample of path) inside(sample);
    for (let t = 0; t < 9; t += 0.013) inside(cameraAt(path, FPS, t));
  });

  it("never leaves the frame on the recorded fixtures, following the real pointer", () => {
    for (const name of FIXTURES) {
      const { meta, events } = load(name);
      const segments = zoomSegments(events, meta.view, meta.capture.dpr, { auto: true, feel: "quick", maxLevel: 2.5 });
      const cursor = (t: number) => {
        const p = pointerAt(events, t);
        return p ? { x: p.x / meta.view.w, y: p.y / meta.view.h } : null;
      };
      for (const sample of cameraPath(segments, 12, { omega: 10, fps: FPS, cursor, aspect: 16 / 9 })) inside(sample);
    }
  });

  it("follow keeps a slowly moving cursor inside the middle of the viewport", () => {
    const cursor = (t: number): Point => ({ x: 0.3 + (0.4 * Math.min(Math.max(t - 2, 0), 6)) / 6, y: 0.5 });
    const path = cameraPath([segment({ start: 0, end: 10, center: [0.5, 0.5], follow: true })], 10, { omega: 7, fps: FPS, cursor });
    for (let t = 1.5; t < 9.5; t += 0.05) {
      const cam = cameraAt(path, FPS, t);
      // The middle 60% of a 1/2-wide viewport is ±0.15 around the centre; allow the spring's lag.
      expect(Math.abs(cursor(t).x - cam.cx)).toBeLessThanOrEqual(0.15 + 0.02);
    }
  });

  it("anchors pull the centre so each one comes into view in its turn", () => {
    const path = cameraPath([segment({ start: 0, end: 6, level: 2.5, center: [0.5, 0.5], anchors: [[0.2, 0.5, 0.35], [0.8, 0.5, 3]] })], 6, { omega: 7, fps: FPS, cursor: noCursor });
    const half = 0.2;
    expect(cameraAt(path, FPS, 2.5).cx).toBeLessThan(0.5);
    expect(Math.abs(0.2 - cameraAt(path, FPS, 2.5).cx)).toBeLessThanOrEqual(0.6 * half + 0.01);
    expect(cameraAt(path, FPS, 5.5).cx).toBeGreaterThan(0.5);
    expect(Math.abs(0.8 - cameraAt(path, FPS, 5.5).cx)).toBeLessThanOrEqual(0.6 * half + 0.01);
  });

  it("ease: cut jumps at once; smooth arrives in 600 ms on a cubic", () => {
    const cut = cameraPath([segment({ ease: "cut" })], 6, { omega: 7, fps: FPS, cursor: noCursor });
    expect(cut[59]!.z).toBe(1);
    expect(cut[60]).toEqual({ cx: 0.3, cy: 0.4, z: 2 });
    expect(cut[300]).toEqual({ cx: 0.5, cy: 0.5, z: 1 });
    const smooth = cameraPath([segment({ ease: "smooth" })], 6, { omega: 7, fps: FPS, cursor: noCursor });
    expect(smooth[78]!.z).toBeCloseTo(Math.exp(Math.log(2) * 0.5), 2);
    expect(smooth[96]!.z).toBeCloseTo(2, 9);
    expect(smooth[96]!.cx).toBeCloseTo(0.3, 9);
  });

  it("a jump farther than a zoomed viewport flies out and back in (van Wijk–Nuij) in 0.8–1.0 s", () => {
    const segments = [segment({ start: 1, end: 3, level: 2.5, center: [0.2, 0.2] }), segment({ id: "z2", start: 3, end: 6, level: 2.5, center: [0.8, 0.8] })];
    const path = cameraPath(segments, 6, { omega: 7, fps: FPS, cursor: noCursor, aspect: 16 / 9 });
    let lowest = Infinity;
    for (let t = 3; t <= 4; t += 1 / FPS) lowest = Math.min(lowest, cameraAt(path, FPS, t).z);
    expect(lowest).toBeLessThan(1.8);
    const landed = cameraAt(path, FPS, 4.05);
    expect(landed.cx).toBeCloseTo(0.8, 2);
    expect(landed.cy).toBeCloseTo(0.8, 2);
    expect(landed.z).toBeCloseTo(2.5, 2);
  });

  it("is deterministic", () => {
    const { meta, events } = load("typing");
    const segments = zoomSegments(events, meta.view, 2, { auto: true, feel: "mellow", maxLevel: 2.5 });
    const options = { omega: 7, fps: FPS, cursor: (t: number) => pointerAt(events, t) };
    expect(cameraPath(segments, 9, options)).toEqual(cameraPath(segments, 9, options));
  });
});

describe("van Wijk–Nuij", () => {
  it("starts and ends where asked, wider in the middle", () => {
    const flight = vanWijkNuij(0, 0, 0.5, 1, 0.5, 0.4);
    const start = flight.at(0);
    const end = flight.at(flight.S);
    expect(start.x).toBeCloseTo(0, 9);
    expect(start.w).toBeCloseTo(0.5, 9);
    expect(end.x).toBeCloseTo(1, 9);
    expect(end.y).toBeCloseTo(0.5, 9);
    expect(end.w).toBeCloseTo(0.4, 9);
    expect(flight.at(flight.S / 2).w).toBeGreaterThan(0.5);
  });

  it("a pure zoom when the centres agree", () => {
    const flight = vanWijkNuij(0.5, 0.5, 1, 0.5, 0.5, 0.25);
    expect(flight.at(flight.S).w).toBeCloseTo(0.25, 9);
  });
});

describe("cameraAt and viewportOf", () => {
  it("interpolates between samples (zoom in log space) and holds the ends", () => {
    const path: CameraSample[] = [{ cx: 0.5, cy: 0.5, z: 1 }, { cx: 0.5, cy: 0.5, z: 4 }];
    expect(cameraAt(path, 1, 0.5).z).toBeCloseTo(2, 9);
    expect(cameraAt(path, 1, -3)).toEqual(path[0]);
    expect(cameraAt(path, 1, 99)).toEqual(path[1]);
    expect(cameraAt([], 60, 1)).toEqual({ cx: 0.5, cy: 0.5, z: 1 });
  });

  it("the viewport is 1/z of the content around the centre", () => {
    const v = viewportOf({ cx: 0.3, cy: 0.4, z: 2 });
    expect(v.x).toBeCloseTo(0.05, 12);
    expect(v.y).toBeCloseTo(0.15, 12);
    expect([v.w, v.h]).toEqual([0.5, 0.5]);
    expect(viewportOf({ cx: 0.5, cy: 0.5, z: 2 }, 2).h).toBe(0.25);
  });
});
