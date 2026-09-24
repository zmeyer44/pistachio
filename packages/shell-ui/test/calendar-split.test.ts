import { describe, expect, it } from "vitest";
import { clampSplit, getStoredSplit, MONTH_RAIL, storeSplit, WEEK_STRIP } from "../src/lib/calendar-split";

describe("calendar split sizes", () => {
  it("clamps to each pane's range and rounds to whole pixels", () => {
    expect(clampSplit(WEEK_STRIP, 100)).toBe(WEEK_STRIP.min);
    expect(clampSplit(WEEK_STRIP, 10_000)).toBe(WEEK_STRIP.max);
    expect(clampSplit(WEEK_STRIP, 300.6)).toBe(301);
    expect(clampSplit(MONTH_RAIL, Number.NaN)).toBe(MONTH_RAIL.default);
    expect(clampSplit(MONTH_RAIL, 350)).toBe(350);
  });

  it("falls back to the default when nothing is stored, and stores what it clamped", () => {
    // Under node there is no localStorage: reads default, writes are best effort.
    expect(getStoredSplit(WEEK_STRIP)).toBe(WEEK_STRIP.default);
    expect(storeSplit(MONTH_RAIL, 5)).toBe(MONTH_RAIL.min);
    expect(WEEK_STRIP.default).toBeGreaterThan(WEEK_STRIP.min);
    expect(MONTH_RAIL.default).toBeLessThan(MONTH_RAIL.max);
  });
});
