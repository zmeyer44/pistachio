import { describe, expect, it } from "vitest";
import { Progress, frameSchedule, gifSize } from "../src/export/schedule.js";
import { defaultProject } from "../src/lib/project.js";
import { outputSize } from "../src/lib/render.js";
import { piecewiseMap } from "./export-fixtures.js";

describe("the export's frame schedule", () => {
  it("gives every output frame its source time, one range when nothing is cut", () => {
    const schedule = frameSchedule(piecewiseMap([{ length: 3, src: 0, rate: 1 }]), 30);
    expect(schedule.count).toBe(90);
    expect(schedule.tSrc[45]).toBeCloseTo(1.5, 9);
    expect(schedule.ranges).toEqual([{ first: 0, last: 89, start: 0, end: 89 / 30 }]);
  });

  it("opens a new range where a cut jumps the source, so the decoder seeks", () => {
    // 0–1 s kept, then 5 s left out, then 1 s more.
    const schedule = frameSchedule(
      piecewiseMap([
        { length: 1, src: 0, rate: 1 },
        { length: 1, src: 6, rate: 1 },
      ]),
      60,
    );
    expect(schedule.count).toBe(120);
    expect(schedule.ranges).toHaveLength(2);
    expect(schedule.ranges[0]).toMatchObject({ first: 0, last: 59, start: 0 });
    expect(schedule.ranges[1]).toMatchObject({ first: 60, last: 119, start: 6 });
  });

  it("decodes through a sped-up stretch rather than seeking every frame", () => {
    const schedule = frameSchedule(
      piecewiseMap([
        { length: 1, src: 0, rate: 1 },
        { length: 1, src: 1, rate: 8 },
        { length: 1, src: 9, rate: 1 },
      ]),
      30,
    );
    expect(schedule.ranges).toHaveLength(1);
    expect(schedule.tSrc[45]).toBeCloseTo(1 + 0.5 * 8, 9);
  });

  it("refuses an edit that keeps nothing", () => {
    expect(() => frameSchedule(piecewiseMap([{ length: 0, src: 0, rate: 1 }]), 30)).toThrow(/Nothing to export/);
  });
});

describe("the export's size", () => {
  const view = { w: 1600, h: 900 };
  const look = defaultProject().look;

  it("is the lib's output size: the height is the short side, both sides even", () => {
    expect(outputSize(look, view, 1080)).toEqual({ w: 1920, h: 1080 });
    expect(outputSize(look, view, 2160)).toEqual({ w: 3840, h: 2160 });
    expect(outputSize({ ...look, aspect: "9:16" }, view, 1080)).toEqual({ w: 1080, h: 1920 });
    expect(outputSize({ ...look, aspect: "1:1" }, view, 720)).toEqual({ w: 720, h: 720 });
    expect(outputSize({ ...look, aspect: "4:3" }, view, 1080)).toEqual({ w: 1440, h: 1080 });
    expect(outputSize(look, view, 1440)).toEqual({ w: 2560, h: 1440 });
  });

  it("makes a GIF 960 on its long side, in the video's shape", () => {
    expect(gifSize(look, view)).toEqual({ w: 960, h: 540 });
    expect(gifSize({ ...look, aspect: "9:16" }, view)).toEqual({ w: 540, h: 960 });
    expect(gifSize({ ...look, aspect: "4:3" }, view)).toEqual({ w: 960, h: 720 });
    // Fit: the window with its frame and padding, as the video and the preview are.
    const fit = outputSize({ ...look, aspect: "fit" }, view, 1080);
    const gif = gifSize({ ...look, aspect: "fit" }, view);
    expect(gif.w).toBe(960);
    expect(gif.w / gif.h).toBeCloseTo(fit.w / fit.h, 1);
  });
});

describe("the export's progress", () => {
  it("has no ETA before a pace is known, then extrapolates the pace so far", () => {
    let now = 0;
    const progress = new Progress(() => now);
    expect(progress.at(0)).toEqual({ fraction: 0, etaSeconds: null });
    now = 100;
    expect(progress.at(0.1).etaSeconds).toBeNull(); // under a quarter second
    now = 2000;
    expect(progress.at(0.25)).toEqual({ fraction: 0.25, etaSeconds: 6 });
    expect(progress.at(1)).toEqual({ fraction: 1, etaSeconds: 0 });
  });
});
