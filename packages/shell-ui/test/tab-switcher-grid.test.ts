import { describe, expect, it } from "vitest";
import { tabSwitcherGrid } from "../src/lib/tab-switcher-grid";

describe("tabSwitcherGrid", () => {
  it("fits five cards to a row and three rows in a large window", () => {
    const grid = tabSwitcherGrid(1600, 1000, 15);
    expect(grid.columns).toBe(5);
    expect(grid.capacity).toBe(15);
    expect(grid.cardWidth).toBe(236);
  });

  it("sizes the panel to the cards it shows", () => {
    const two = tabSwitcherGrid(1600, 1000, 2);
    expect(two.columns).toBe(2);
    expect(two.panelWidth).toBe(2 * two.cardWidth + 4 + 24);
  });

  it("drops rows and columns a small window has no room for", () => {
    const grid = tabSwitcherGrid(700, 420, 15);
    expect(grid.columns).toBeLessThan(5);
    expect(grid.capacity).toBeLessThan(15);
    expect(grid.panelWidth).toBeLessThanOrEqual(700 - 64);
  });

  it("always has room for one card", () => {
    const grid = tabSwitcherGrid(200, 150, 4);
    expect(grid.columns).toBe(1);
    expect(grid.capacity).toBe(1);
  });
});
