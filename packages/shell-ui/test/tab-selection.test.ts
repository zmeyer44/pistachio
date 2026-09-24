import { describe, expect, it } from "vitest";
import { updateTabSelection } from "../src/lib/tab-selection";

const order = ["a", "b", "c", "d"];

describe("updateTabSelection", () => {
  it("keeps a plain click as activation and resets bulk selection", () => {
    const next = updateTabSelection(order, new Set(["a", "c"]), "a", "b", {
      range: false,
      additive: false,
    });
    expect([...next.selected]).toEqual([]);
    expect(next.anchor).toBe("b");
    expect(next.activate).toBe(true);
  });

  it("selects a continuous range in either direction", () => {
    const forward = updateTabSelection(order, new Set(), "a", "c", {
      range: true,
      additive: false,
    });
    expect([...forward.selected]).toEqual(["a", "b", "c"]);
    expect(forward.anchor).toBe("a");

    const backward = updateTabSelection(order, new Set(), "d", "b", {
      range: true,
      additive: false,
    });
    expect([...backward.selected]).toEqual(["b", "c", "d"]);
  });

  it("toggles individual tabs and can add a range", () => {
    const toggled = updateTabSelection(order, new Set(["a"]), "a", "c", {
      range: false,
      additive: true,
    });
    expect([...toggled.selected]).toEqual(["a", "c"]);

    const removed = updateTabSelection(order, toggled.selected, toggled.anchor, "a", {
      range: false,
      additive: true,
    });
    expect([...removed.selected]).toEqual(["c"]);

    const extended = updateTabSelection(order, new Set(["a"]), "b", "d", {
      range: true,
      additive: true,
    });
    expect([...extended.selected]).toEqual(["a", "b", "c", "d"]);
  });
});
