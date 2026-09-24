import { describe, expect, it } from "vitest";
import { clampSidebarWidth } from "../src/lib/sidebar";
import { SIDEBAR_DEFAULT_W, SIDEBAR_MAX_W, SIDEBAR_MIN_W } from "@pistachio/shell-contracts/chrome";

describe("sidebar width", () => {
  it("clamps to the chrome contract's bounds and whole pixels", () => {
    expect(clampSidebarWidth(SIDEBAR_MIN_W - 1)).toBe(SIDEBAR_MIN_W);
    expect(clampSidebarWidth(SIDEBAR_MAX_W + 1)).toBe(SIDEBAR_MAX_W);
    expect(clampSidebarWidth(SIDEBAR_DEFAULT_W + 0.4)).toBe(SIDEBAR_DEFAULT_W);
  });

  it("falls back to the default for anything that is not a width", () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_W);
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY)).toBe(SIDEBAR_DEFAULT_W);
  });
});
