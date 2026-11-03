import { describe, expect, it } from "vitest";
import { interestsOf, replaceAutoZooms, zoomSegments } from "../src/lib/zoom.js";
import type { RecordedEvent, ZoomSegment, ZoomSettings } from "../src/lib/types.js";
import { FIXTURES, load } from "./fixtures.js";

const settings: ZoomSettings = { auto: true, feel: "mellow", maxLevel: 2.5 };

function solve(name: Parameters<typeof load>[0], over: Partial<ZoomSettings> = {}, dpr?: number, filter?: (e: RecordedEvent) => boolean): ZoomSegment[] {
  const { meta, events } = load(name);
  return zoomSegments(filter ? events.filter(filter) : events, meta.view, dpr ?? meta.capture.dpr, { ...settings, ...over });
}

describe("zoomSegments", () => {
  it("a click on a button: 0.35 s lead, 1.4 s hold, a tiny target capped at 2×, centred on it", () => {
    const [first] = solve("click");
    expect(first).toMatchObject({ id: "z1", start: 1.65, end: 3.4, level: 2, auto: true, ease: "spring", follow: true });
    expect(first!.center[0]).toBeCloseTo(820 / 1600, 3);
    expect(first!.center[1]).toBeCloseTo(318 / 900, 3);
    expect(first!.anchors).toBeUndefined();
  });

  it("a click on a big target frames the point at the default level, the viewport kept inside the content", () => {
    const second = solve("click")[1]!;
    expect(second).toMatchObject({ id: "z2", start: 5.65, end: 7.4, level: 2 });
    expect(second.center[0]).toBeCloseTo(0.25, 6);
    expect(second.center[1]).toBeCloseTo(0.5, 6);
  });

  it("caps the level at dpr × 1.25 and at the max-level setting", () => {
    expect(solve("click", {}, 1).every((s) => s.level === 1.25)).toBe(true);
    expect(solve("click", { maxLevel: 1.5 }).every((s) => s.level <= 1.5)).toBe(true);
    expect(solve("click", { maxLevel: 1 })).toEqual([]);
  });

  it("merges a click, its field's focus and the typing into one segment that fits the field, keeping anchors", () => {
    const segments = solve("typing");
    expect(segments).toHaveLength(1);
    const s = segments[0]!;
    expect(s.start).toBeCloseTo(0.85, 6);
    expect(s.end).toBeCloseTo(4.8 + 1.4, 6);
    // 760 × 44 padded 18% a side → 1600 / (760 × 1.36); over 2% of the view, so no 2× cap.
    expect(s.level).toBeCloseTo(1600 / (760 * 1.36), 3);
    expect(s.anchors).toHaveLength(3);
    expect(s.anchors!.map((a) => a[2])).toEqual([1.2, 1.25, 1.8]);
  });

  it("a navigation breaks a merge: the zoom ends at the nav and the next click starts its own; a link that navigates at once makes none", () => {
    const segments = solve("nav");
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ start: 1.65, end: 2.55 });
    expect(segments[1]).toMatchObject({ start: 2.55, end: 4.3 });
    expect(segments.some((s) => s.start < 7.2 && s.end > 6.7)).toBe(false);
  });

  it("a scroll run over 0.6 s breaks a merge; without it the two clicks merge", () => {
    const broken = solve("scroll");
    expect(broken).toHaveLength(2);
    expect(broken[0]!.end).toBeCloseTo(1.5, 6);
    const merged = solve("scroll", {}, undefined, (e) => e.k !== "wheel" && e.k !== "scroll");
    expect(merged).toHaveLength(1);
    expect(merged[0]!.anchors).toHaveLength(2);
  });

  it("keys that leaked into a password field make no typing interest", () => {
    const { meta, events } = load("password");
    const typing = interestsOf(events, meta.view).filter((i) => i.kind === "typing");
    expect(typing).toHaveLength(1);
    expect(typing[0]!.t0).toBeCloseTo(1.4, 6);
  });

  it("is sorted, never overlaps, keeps the viewport inside the content and numbers z1…", () => {
    for (const name of FIXTURES) {
      const segments = solve(name);
      segments.forEach((s, i) => {
        expect(s.id).toBe(`z${i + 1}`);
        expect(s.end).toBeGreaterThan(s.start);
        expect(s.level).toBeGreaterThanOrEqual(1.25);
        expect(s.level).toBeLessThanOrEqual(2.5);
        const half = 0.5 / s.level;
        expect(s.center[0]).toBeGreaterThanOrEqual(half - 1e-4);
        expect(s.center[0]).toBeLessThanOrEqual(1 - half + 1e-4);
        if (i > 0) expect(s.start).toBeGreaterThanOrEqual(segments[i - 1]!.end - 1e-9);
      });
    }
  });

  it("returns nothing when auto zoom is off", () => {
    expect(solve("click", { auto: false })).toEqual([]);
  });

  it("re-solving keeps the segments a person touched", () => {
    const solved = solve("click");
    const touched: ZoomSegment = { ...solved[0]!, id: "z7", auto: false, level: 1.8 };
    const merged = replaceAutoZooms([touched, solved[1]!], solved);
    expect(merged.map((s) => [s.id, s.auto])).toEqual([["z7", false], ["z8", true]]);
  });
});
