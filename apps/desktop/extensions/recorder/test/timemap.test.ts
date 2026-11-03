import { describe, expect, it } from "vitest";
import { keptRanges, timeMap } from "../src/lib/timemap.js";
import type { Cut, SpeedSegment } from "../src/lib/types.js";

const speed = (start: number, end: number, rate: number): SpeedSegment => ({ id: `s${start}`, start, end, rate, auto: null });

describe("timeMap", () => {
  it("is the identity over one whole clip at real time", () => {
    const map = timeMap([{ in: 0, out: 10 }], [], 10);
    expect(map.duration).toBeCloseTo(10, 9);
    for (const t of [0, 1.5, 7.25, 10]) {
      expect(map.toSource(t)).toBeCloseTo(t, 9);
      expect(map.toOutput(t)).toBeCloseTo(t, 9);
    }
    expect(map.rateAt(5)).toBe(1);
    expect(timeMap([], [], 10).duration).toBeCloseTo(10, 9);
    // The media's length not known yet: the cuts say how long.
    expect(timeMap([{ in: 0, out: 6 }], [], 0).duration).toBeCloseTo(6, 9);
  });

  it("removes cuts and Infinity segments, reporting the joins", () => {
    const cuts: Cut[] = [{ in: 0, out: 4 }, { in: 6, out: 10 }];
    const map = timeMap(cuts, [speed(7, 8, Infinity)], 10);
    expect(keptRanges(cuts, [speed(7, 8, Infinity)], 10)).toEqual([[0, 4], [6, 7], [8, 10]]);
    expect(map.duration).toBeCloseTo(7, 9);
    expect(map.joins).toEqual([{ tOut: expect.closeTo(4, 9), from: 4, to: 6 }, { tOut: expect.closeTo(5, 9), from: 7, to: 8 }]);
    expect(map.toSource(4)).toBeCloseTo(6, 9);
    expect(map.toSource(3.999)).toBeCloseTo(3.999, 6);
    expect(map.toSource(5.5)).toBeCloseTo(8.5, 9);
    expect(map.toOutput(5)).toBeCloseTo(4, 9);
    expect(map.rateAt(map.joins![0]!.tOut)).toBe(Infinity);
    // Inside a range left out, the next kept output time (the editor's player seeks there).
    expect(map.toOutput(7.5)).toBeCloseTo(5, 9);
    expect(map.toSource(map.toOutput(7.5))).toBeCloseTo(8, 9);
    // Before the first kept second and past the last, the ends.
    expect(timeMap([{ in: 2, out: 4 }], [], 10).toOutput(1)).toBe(0);
    expect(timeMap([{ in: 2, out: 4 }], [], 10).toOutput(9)).toBeCloseTo(2, 9);
  });

  it("a 4× segment, eased over 0.25 s at each end", () => {
    const map = timeMap([{ in: 0, out: 10 }], [speed(2, 6, 4)], 10, 0.25);
    // Inside the ramps the rate climbs from 1 to 4 on a smoothstep; between them it is 4.
    expect(map.rateAt(map.toOutput(4))).toBeCloseTo(4, 9);
    const mid = map.rateAt(map.toOutput(2.125));
    expect(mid).toBeGreaterThan(1);
    expect(mid).toBeLessThan(4);
    expect(map.rateAt(map.toOutput(1))).toBe(1);
    // The plateau 2.25–5.75 takes 3.5 / 4; each ramp takes ∫ 1/rate over 0.25 s.
    const ramp = (() => {
      let sum = 0;
      const n = 10000;
      for (let i = 0; i < n; i++) {
        const u = (i + 0.5) / n;
        const s = u * u * (3 - 2 * u);
        sum += 0.25 / n / (1 + 3 * s);
      }
      return sum;
    })();
    expect(map.duration).toBeCloseTo(6 + 3.5 / 4 + 2 * ramp, 6);
  });

  it("is monotonic, and round-trips within a frame, over random cuts and speeds", () => {
    let seed = 11;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let trial = 0; trial < 20; trial++) {
      const duration = 20 + rand() * 40;
      const cuts: Cut[] = [];
      for (let t = 0; t < duration; ) {
        const len = 1 + rand() * 8;
        cuts.push({ in: t, out: Math.min(duration, t + len) });
        t += len + rand() * 3;
      }
      const segments: SpeedSegment[] = [];
      for (let t = rand() * 3; t < duration; t += 2 + rand() * 4) {
        const len = 0.2 + rand() * 3;
        segments.push(speed(t, Math.min(duration, t + len), rand() < 0.2 ? Infinity : 1.5 + rand() * 7));
      }
      const map = timeMap(cuts, segments, duration);
      let lastOut = -1;
      let lastSrc = -1;
      for (let i = 0; i <= 2000; i++) {
        const s = (duration * i) / 2000;
        const out = map.toOutput(s);
        expect(out).toBeGreaterThanOrEqual(lastOut - 1e-12);
        lastOut = out;
        const back = map.toSource((map.duration * i) / 2000);
        expect(back).toBeGreaterThanOrEqual(lastSrc - 1e-12);
        lastSrc = back;
      }
      for (const [a, b] of keptRanges(cuts, segments, duration)) {
        for (let k = 1; k < 10; k++) {
          const s = a + ((b - a) * k) / 10;
          expect(Math.abs(map.toSource(map.toOutput(s)) - s)).toBeLessThan(1 / 60);
        }
      }
      for (let k = 0; k <= 50; k++) {
        const t = (map.duration * k) / 50;
        expect(Math.abs(map.toOutput(map.toSource(t)) - t)).toBeLessThan(1e-6);
      }
    }
  });
});
