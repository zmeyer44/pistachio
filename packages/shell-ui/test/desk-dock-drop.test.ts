/**
 * A desk window carried over the sidebar's column (src/lib/desk/dock-drop.ts,
 * docs/desk.md "Over the sidebar"): which drop the pointer's place makes —
 * another space's tile moves its tab there, the desk's own tile (or Home, for
 * a space of Home's) and the card showing the desk's own space put the window
 * away, Home and New space send its tab there — the rail's ground, on none
 * of its items, as New space does — and the gap beside the card nothing; and
 * the row or tile the window is drawn as meanwhile.
 */

import { describe, expect, it } from "vitest";
import { DOCK_ROW_H, DOCK_ROW_INSET, DOCK_TILE, dockDropAt, dockOverAt, dockShapeRect, sameDockDrop, type DockRailItem, type DockTargets } from "../src/lib/desk/dock-drop";

const tile = (item: DockRailItem["item"], y: number, groupId: string | null = null, color: string | null = null, listed = item === "space"): DockRailItem => ({
  item,
  groupId,
  color,
  box: { x: 9, y, w: 38, h: 38 },
  listed,
});

/** The double sidebar, whole: the rail (Home, two spaces' tiles in its list, New space) and the card showing `shows`. */
function column(shows: string | null = "own", options: { homeSpace?: boolean; rail?: boolean; card?: boolean; spacesFull?: boolean } = {}): DockTargets {
  return {
    rail:
      options.rail === false
        ? null
        : {
            box: { x: 0, y: 0, w: 56, h: 900 },
            list: { top: 110, bottom: 600 },
            items: [tile("home", 62), tile("space", 115, "own", "blue"), tile("space", 163, "other", "green"), tile("space", 590, "low", "red"), tile("new", 820)],
          },
    card: options.card === false ? null : { box: { x: 56, y: 8, w: 224, h: 884 }, groupId: shows, list: { x: 56, y: 140, w: 224, h: 600 } },
    homeSpace: options.homeSpace ?? false,
    ...(options.spacesFull === undefined ? {} : { spacesFull: options.spacesFull }),
  };
}

describe("a window carried over the column", () => {
  it("moves its tab to another space's tile, and is put away on its own space's", () => {
    expect(dockDropAt({ x: 28, y: 180 }, column(), "own", "tab")).toMatchObject({ kind: "space", item: "space", groupId: "other", color: "green" });
    expect(dockDropAt({ x: 28, y: 130 }, column(), "own", "tab")).toMatchObject({ kind: "collapse", item: "space", groupId: "own", color: "blue" });
  });

  it("sends its tab Home, or to a space of its own on New space", () => {
    expect(dockDropAt({ x: 28, y: 80 }, column(), "own", "tab")).toMatchObject({ kind: "home", item: "home", groupId: null });
    expect(dockDropAt({ x: 28, y: 835 }, column(), "own", "tab")).toMatchObject({ kind: "new", item: "new" });
  });

  // (Until 2026-10-14 it did: main made no space, and the window was gone while its tab stayed where it was.)
  it("takes nothing on New space while the Profile holds as many spaces as it may — a tile there all the same", () => {
    const full = column("own", { spacesFull: true });
    expect(dockOverAt({ x: 28, y: 835 }, full, "own", "tab")).toEqual({ shape: "tile", drop: null });
    // Every other item takes it as ever.
    expect(dockDropAt({ x: 28, y: 180 }, full, "own", "tab")).toMatchObject({ kind: "space", groupId: "other" });
    expect(dockDropAt({ x: 28, y: 80 }, full, "own", "tab")).toMatchObject({ kind: "home" });
  });

  it("puts a Home tab's window away on Home, its own tile", () => {
    expect(dockDropAt({ x: 28, y: 80 }, column("own", { homeSpace: true }), "loose-1", "tab")).toMatchObject({ kind: "collapse", item: "home" });
  });

  // (Until 2026-10-26 nothing there took it: a neutral tile, and let go there it landed in the desk's left half.)
  it("makes a space of its tab on the rail's ground — between its items, below them, over its head — going into New space", () => {
    const ground = { kind: "new", item: "new", groupId: null, color: null, box: { x: 9, y: 820, w: 38, h: 38 } };
    expect(dockDropAt({ x: 28, y: 400 }, column(), "own", "tab")).toEqual(ground);
    expect(dockOverAt({ x: 28, y: 400 }, column(), "own", "tab")).toEqual({ shape: "tile", drop: ground });
    expect(dockDropAt({ x: 28, y: 30 }, column(), "own", "tab")).toEqual(ground);
    expect(dockDropAt({ x: 28, y: 880 }, column(), "own", "tab")).toEqual(ground);
    // (The low tile reaches past the list's foot: only its part in sight takes a drop; past it is the ground.)
    expect(dockDropAt({ x: 28, y: 595 }, column(), "own", "tab")).toMatchObject({ groupId: "low" });
    expect(dockDropAt({ x: 28, y: 620 }, column(), "own", "tab")).toEqual(ground);
    // With the Profile full, New space makes none: nothing there either — a tile all the same.
    expect(dockOverAt({ x: 28, y: 400 }, column("own", { spacesFull: true }), "own", "tab")).toEqual({ shape: "tile", drop: null });
  });

  it("puts it away over the card while the card shows the desk's own space, and takes nothing over another view — a window there", () => {
    expect(dockDropAt({ x: 150, y: 300 }, column("own"), "own", "tab")).toMatchObject({ kind: "collapse", item: "card", groupId: "own" });
    expect(dockOverAt({ x: 150, y: 300 }, column("own"), "own", "tab")?.shape).toBe("row");
    expect(dockOverAt({ x: 150, y: 300 }, column(null), "own", "tab")).toBeNull();
    expect(dockDropAt({ x: 150, y: 300 }, column("other"), "own", "tab")).toBeNull();
    // The gap between the card and the desk is the desk's own edge.
    expect(dockDropAt({ x: 284, y: 300 }, column("own"), "own", "tab")).toBeNull();
  });

  it("reads the rail alone with no card, and nothing with the column away", () => {
    const rail = column("own", { card: false });
    expect(dockDropAt({ x: 28, y: 180 }, rail, "own", "tab")).toMatchObject({ kind: "space", groupId: "other" });
    expect(dockDropAt({ x: 150, y: 300 }, rail, "own", "tab")).toBeNull();
    expect(dockDropAt({ x: 28, y: 180 }, null, "own", "tab")).toBeNull();
  });

  it("takes a document's window only over the card, into the Stack", () => {
    expect(dockOverAt({ x: 28, y: 180 }, column(), "own", "file")).toBeNull();
    expect(dockDropAt({ x: 28, y: 835 }, column(), "own", "file")).toBeNull();
    expect(dockOverAt({ x: 28, y: 400 }, column(), "own", "file")).toBeNull();
    expect(dockDropAt({ x: 150, y: 300 }, column(), "own", "file")).toMatchObject({ kind: "collapse", item: "card" });
  });

  it("is the same drop while the pointer moves within one target", () => {
    const a = dockDropAt({ x: 28, y: 170 }, column(), "own", "tab");
    const b = dockDropAt({ x: 20, y: 190 }, column(), "own", "tab");
    expect(sameDockDrop(a, b)).toBe(true);
    expect(sameDockDrop(a, dockDropAt({ x: 28, y: 130 }, column(), "own", "tab"))).toBe(false);
    expect(sameDockDrop(null, null)).toBe(true);
    expect(sameDockDrop(a, null)).toBe(false);
  });
});

describe("the shape it takes there", () => {
  it("is a rail tile centred on the pointer over the rail", () => {
    expect(dockOverAt({ x: 28, y: 180 }, column(), "own", "tab")?.shape).toBe("tile");
    expect(dockShapeRect("tile", { x: 30, y: 182 }, column())).toEqual({ x: 30 - DOCK_TILE / 2, y: 182 - DOCK_TILE / 2, w: DOCK_TILE, h: DOCK_TILE });
  });

  it("is a row of the card's list over the card: the list's rows' x and width, a row's height, its middle at the pointer", () => {
    const targets = column();
    expect(dockShapeRect("row", { x: 150, y: 300 }, targets)).toEqual({ x: 56 + DOCK_ROW_INSET, y: 300 - DOCK_ROW_H / 2, w: 224 - DOCK_ROW_INSET * 2, h: DOCK_ROW_H });
  });

  it("keeps the row within the card's list, above it or below it", () => {
    const targets = column();
    expect(dockShapeRect("row", { x: 150, y: 40 }, targets).y).toBe(140);
    expect(dockShapeRect("row", { x: 150, y: 870 }, targets).y).toBe(140 + 600 - DOCK_ROW_H);
  });
});
