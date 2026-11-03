import { describe, expect, it } from "vitest";
import { replaceAutoSpeed, speechIntervals, speedPlan } from "../src/lib/speed.js";
import { clicksOf } from "../src/lib/events.js";
import type { RecordedEvent, SpeedSegment } from "../src/lib/types.js";
import { FIXTURES, load, micLevels } from "./fixtures.js";

const overlaps = (s: SpeedSegment, [a, b]: [number, number]) => s.start < b && a < s.end;

describe("speechIntervals", () => {
  it("is a level over −40 dBFS for 300 ms, held 200 ms after", () => {
    expect(speechIntervals(micLevels(30, [[20, 23]]))).toEqual([[20, 23.2]]);
  });

  it("ignores a blip under 300 ms and bridges a dip under the hangover", () => {
    expect(speechIntervals(micLevels(10, [[2, 2.2]]))).toEqual([]);
    expect(speechIntervals(micLevels(10, [[2, 2.6], [2.75, 3.4]]))).toEqual([[2, 3.6]]);
  });

  it("reads −40 dBFS as linear RMS 0.01", () => {
    const quiet = new Float32Array(100).fill(0.009);
    const loud = new Float32Array(100).fill(0.011);
    expect(speechIntervals(quiet)).toEqual([]);
    expect(speechIntervals(loud)).toEqual([[0, 2]]);
    expect(speechIntervals(null)).toEqual([]);
  });
});

describe("speedPlan", () => {
  const idle = load("idle");
  const speech = speechIntervals(micLevels(30, [[20, 23]]));
  const plan = speedPlan(idle.events, 30, speech);

  it("speeds a short idle, keeping 0.4 s of head and 0.3 s of tail", () => {
    const first = plan[0]!;
    expect(first).toMatchObject({ id: "s1", auto: "idle" });
    // Idle from 2.3 to 5.2 (each capture frame lands 4 ms after its move; the page painting counts).
    expect(first.start).toBeCloseTo(2.304 + 0.4, 6);
    expect(first.end).toBeCloseTo(5.204 - 0.3, 6);
    expect(first.rate).toBeCloseTo((first.end - first.start) / 0.6, 3);
    expect(first.rate).toBeGreaterThanOrEqual(2);
    expect(first.rate).toBeLessThanOrEqual(8);
  });

  it("cuts an idle past 6 s; a caret blinking does not keep it alive", () => {
    const cut = plan.find((s) => s.start > 7 && s.start < 8)!;
    expect(cut.rate).toBe(Infinity);
    expect(Math.abs(cut.start - 7.7)).toBeLessThan(0.01);
    expect(Math.abs(cut.end - 16.4)).toBeLessThan(0.01);
  });

  it("never speeds up or cuts while the mic hears speech", () => {
    for (const segment of plan) for (const interval of speech) expect(overlaps(segment, interval)).toBe(false);
    const around = plan.filter((s) => s.start >= 18 && s.end <= 26);
    expect(around.map((s) => [Math.round(s.start * 100) / 100, Math.round(s.end * 100) / 100, s.rate])).toEqual([[18.7, 20, Infinity], [23.2, 25.4, Infinity]]);
    const unspoken = speedPlan(idle.events, 30, []);
    expect(unspoken.some((s) => s.start <= 20 && s.end >= 23)).toBe(true);
  });

  it("an animating page is not idle", () => {
    expect(plan.some((s) => s.end > 27.2)).toBe(false);
  });

  it("never within 0.5 s of a click, and nothing under 0.5 s", () => {
    for (const name of FIXTURES) {
      const { events } = load(name);
      const segments = speedPlan(events, 12, []);
      const clicks = clicksOf(events);
      segments.forEach((s, i) => {
        expect(s.id).toBe(`s${i + 1}`);
        expect(s.end - s.start).toBeGreaterThanOrEqual(0.5 - 1e-9);
        for (const click of clicks) expect(overlaps(s, [click.t - 0.5, click.t + 0.5])).toBe(false);
        if (i > 0) expect(s.start).toBeGreaterThanOrEqual(segments[i - 1]!.end - 1e-9);
      });
    }
  });

  it("types at 2× (3× past 6 s) and loads at 4×", () => {
    const typing = speedPlan(load("typing").events, 9, []).find((s) => s.auto === "typing")!;
    expect(typing).toMatchObject({ rate: 2 });
    expect(typing.start).toBeCloseTo(1.8, 6);
    expect(typing.end).toBeCloseTo(4.8, 6);

    const keys: RecordedEvent[] = [];
    for (let t = 1; t < 8.5; t += 0.25) keys.push({ t: t * 1000, k: "key", kind: "char" });
    expect(speedPlan(keys, 9, []).find((s) => s.auto === "typing")!.rate).toBe(3);

    const busy: RecordedEvent[] = [{ t: 1000, k: "load", loading: true }, { t: 3000, k: "load", loading: false }];
    for (let t = 0; t < 4; t += 0.1) busy.push({ t: t * 1000, k: "move", x: 100 + t * 50, y: 100 });
    const loading = speedPlan(busy, 4, []).find((s) => s.auto === "loading")!;
    expect(loading).toMatchObject({ start: 1, end: 3, rate: 4 });
  });

  it("re-solving keeps the segments a person made", () => {
    const mine: SpeedSegment = { id: "s9", start: 2, end: 4, rate: 1.5, auto: null };
    const merged = replaceAutoSpeed([mine, plan[1]!], plan);
    expect(merged[0]).toEqual(mine);
    expect(merged.some((s) => s.auto !== null && s.start < 4 && s.end > 2)).toBe(false);
    expect(merged.filter((s) => s.auto !== null)[0]!.id).toBe("s10");
  });
});
