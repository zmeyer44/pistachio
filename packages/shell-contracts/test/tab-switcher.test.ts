import { describe, expect, it } from "vitest";
import { recordTabVisit, tabSwitcherIndex } from "../src/tab-switcher.js";

describe("Control–Tab history", () => {
  it("keeps unique tabs in most-recently-visited order", () => {
    expect(recordTabVisit(recordTabVisit(["current", "older"], "older"), "newest")).toEqual([
      "newest",
      "older",
      "current",
    ]);
  });

  it("wraps forward and reverse cycling around the MRU list", () => {
    expect(tabSwitcherIndex(1, 5)).toBe(1);
    expect(tabSwitcherIndex(6, 5)).toBe(1);
    expect(tabSwitcherIndex(-1, 5)).toBe(4);
    expect(tabSwitcherIndex(-6, 5)).toBe(4);
    expect(tabSwitcherIndex(4, 0)).toBe(0);
  });
});
