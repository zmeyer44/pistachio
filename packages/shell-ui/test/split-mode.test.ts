import { describe, expect, it } from "vitest";
import { nextSplitMode, toggledSplitMode } from "../src/chrome/split-mode";

describe("split modes", () => {
  it("cycles from a button: single → vertical → horizontal → single", () => {
    expect(nextSplitMode("single")).toBe("vertical");
    expect(nextSplitMode("vertical")).toBe("horizontal");
    expect(nextSplitMode("horizontal")).toBe("grid");
    expect(nextSplitMode("grid")).toBe("single");
  });

  it("toggles from the key: any split goes back to single, single splits", () => {
    // ⌘\ has always been a toggle — one press in, the next press out — while
    // the visible button cycles through the orientations.
    expect(toggledSplitMode("single")).toBe("vertical");
    expect(toggledSplitMode("vertical")).toBe("single");
    expect(toggledSplitMode("horizontal")).toBe("single");
    expect(toggledSplitMode("grid")).toBe("single");
  });
});
