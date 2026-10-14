/**
 * The double sidebar's rules (docs/double-sidebar.md, since 2026-10-13): the
 * rail holds every drawn space in the row's order and every page's group of
 * two or more in its entry's order; the card shows Home's view while the
 * space in use is one of Home's; a drop among Today's rows is counted among
 * all the day's units (the rail's spaces stand among them); a tile carried
 * along the rail moves its space among the units; a drop in a space's view
 * is a place among its rows; and the card's outline is one closed path with
 * its tab where it is asked for, below the traffic lights' shoulder. Since
 * the review of 2026-10-13: only a Home tab grown into a space waits for its
 * flight, a row let go on the rail lands only on an item that can be seen,
 * and a page's space has a menu of its own.
 */

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import type { MenuEntry } from "../src/components/ContextMenu";
import {
  backingOutline,
  cardOutline,
  columnViewOf,
  fullUnitIndex,
  grewInto,
  HOME_VIEW,
  homeTabIdsOf,
  isHomeSpace,
  railMoveIndex,
  railSpacesOf,
  railTargetAt,
  spaceColumnWidth,
  visibleUnitIndex,
  type RailSnapshot,
} from "../src/components/space-rail/rail-model";
import { SpaceHead } from "../src/components/space-rail/SpaceHead";
import { pageSpaceMenu } from "../src/components/space-rail/space-menu";
import { spaceDropAt, type MeasuredRow } from "../src/lib/sidebar-tree";

const group = (id: string, tabIds: string[], fields: Partial<TabGroupInfo> = {}): TabGroupInfo => ({
  id,
  title: id.toUpperCase(),
  color: "blue",
  tabIds,
  origin: "manual",
  open: false,
  createdAt: 1,
  ...fields,
});

const tab = (id: string, anchorId: string | null = null): { id: string; anchorId: string | null } => ({ id, anchorId });

/** a (loose), b+c (space "trip"), d (loose), an empty space after them, a favorite's page with a tab beside it, a pin's page alone. */
function snapshot(): RailSnapshot {
  return {
    tabs: [tab("a"), tab("b"), tab("c"), tab("d"), tab("fav-page", "fav"), tab("beside"), tab("pin-page", "pin")],
    tabGroups: [group("trip", ["b", "c"]), group("empty", [], { createdAt: 5 })],
    splitGroups: [],
    looseGroups: [group("loose-a", ["a"], { loose: true }), group("loose-d", ["d"], { loose: true })],
    anchorGroups: [group("pin-group", ["pin-page"], { anchorId: "pin" }), group("fav-group", ["fav-page", "beside"], { anchorId: "fav" })],
  };
}

describe("the rail's spaces", () => {
  it("are the drawn spaces in the row's order, then the pages' groups of two or more in their entries' order", () => {
    const spaces = railSpacesOf(snapshot(), ["fav", "pin"]);
    expect(spaces.map((space) => [space.group.id, space.page])).toEqual([
      ["trip", false],
      ["empty", false],
      ["fav-group", true],
    ]);
  });

  it("orders pages' spaces by their entries, favorites before pins", () => {
    const base = snapshot();
    const spaces = railSpacesOf({ ...base, tabs: [...base.tabs, tab("pin-beside")], anchorGroups: [group("pin-group", ["pin-page", "pin-beside"], { anchorId: "pin" }), ...base.anchorGroups!.slice(1)] }, ["fav", "pin"]);
    expect(spaces.filter((space) => space.page).map((space) => space.group.id)).toEqual(["fav-group", "pin-group"]);
  });

  it("is none before the snapshot", () => {
    expect(railSpacesOf(null)).toEqual([]);
  });
});

describe("the card's view", () => {
  it("is Home's for a loose tab's space, a page's alone, or none; else the space's", () => {
    const snap = snapshot();
    expect(columnViewOf(null, snap)).toBe(HOME_VIEW);
    expect(columnViewOf("loose-a", snap)).toBe(HOME_VIEW);
    expect(columnViewOf("pin-group", snap)).toBe(HOME_VIEW);
    expect(columnViewOf("trip", snap)).toBe("trip");
    expect(columnViewOf("empty", snap)).toBe("empty");
    expect(columnViewOf("fav-group", snap)).toBe("fav-group");
    expect(columnViewOf("gone", snap)).toBe(HOME_VIEW);
  });

  it("tells Home's spaces from the rail's", () => {
    const snap = snapshot();
    expect(isHomeSpace("loose-d", snap)).toBe(true);
    expect(isHomeSpace("pin-group", snap)).toBe(true);
    expect(isHomeSpace("fav-group", snap)).toBe(false);
    expect(isHomeSpace("trip", snap)).toBe(false);
  });
});

describe("a Home tab grown into a space", () => {
  const snap = snapshot();
  const before = { view: HOME_VIEW, rail: railSpacesOf(snap), homeTabIds: homeTabIdsOf(snap) };
  const withSpace = (space: TabGroupInfo) => [...before.rail, { group: space, page: false }];

  it("knows Home's tabs: the loose ones, and a page alone (not a page with tabs beside it)", () => {
    expect([...homeTabIdsOf(snap)].sort()).toEqual(["a", "d", "pin-page"]);
    expect(homeTabIdsOf(null).size).toBe(0);
  });

  it("is a new space chosen from Home holding a tab that was Home's", () => {
    const grown = group("grown", ["a", "new"], { origin: "auto" });
    expect(grewInto(before, "grown", withSpace(grown))).toBe(true);
    // (A pin's page given a tab beside it: its page's space, up from Home too.)
    expect(grewInto(before, "pin-group", [...before.rail, { group: group("pin-group", ["pin-page", "beside-pin"], { anchorId: "pin" }), page: true }])).toBe(true);
  });

  it("is not ⌘N's or New space's empty space, a space of tabs that were no Home tabs, one already on the rail, nor a turn from a space", () => {
    expect(grewInto(before, "fresh", withSpace(group("fresh", [])))).toBe(false);
    expect(grewInto(before, "made", withSpace(group("made", ["b", "c"])))).toBe(false);
    expect(grewInto(before, "trip", before.rail)).toBe(false);
    expect(grewInto({ ...before, view: "trip" }, "grown", withSpace(group("grown", ["a", "new"])))).toBe(false);
    expect(grewInto(before, HOME_VIEW, before.rail)).toBe(false);
  });
});

describe("a row let go on the rail", () => {
  // Home 62–100, three tiles in a list showing 120–220 (the third scrolled half out of it, a fourth wholly), New space 240–276.
  const home = { id: "home", top: 62, bottom: 100, listed: false };
  const tiles = [
    { id: "one", top: 125, bottom: 163, listed: true },
    { id: "two", top: 173, bottom: 211, listed: true },
    { id: "three", top: 205, bottom: 243, listed: true },
    { id: "four", top: 253, bottom: 291, listed: true },
  ];
  const fresh = { id: "new", top: 240, bottom: 276, listed: false };
  const targets = [home, ...tiles, fresh];
  const list = { top: 120, bottom: 220 };
  const at = (y: number): string | null => railTargetAt(targets, y, list)?.id ?? null;

  it("lands on the item under the pointer, or within half the gap past its edge", () => {
    expect(at(80)).toBe("home");
    expect(at(104)).toBe("home");
    expect(at(140)).toBe("one");
    expect(at(166)).toBe("one");
    expect(at(170)).toBe("two");
    expect(at(110)).toBeNull();
  });

  it("finds a tile only where the list shows it, never one scrolled out under the foot", () => {
    expect(at(215)).toBe("two");
    expect(at(219)).toBe("three");
    // Below the list's edge: the half-hidden tile and the hidden one are not there; New space is.
    expect(at(230)).toBeNull();
    expect(at(250)).toBe("new");
    expect(at(260)).toBe("new");
    // A tile scrolled up out of the list is not under Home either.
    expect(railTargetAt([{ id: "up", top: 70, bottom: 108, listed: true }, home], 80, list)?.id).toBe("home");
  });
});

describe("a page's space's menu", () => {
  const labels = (entries: MenuEntry[]): string[] => entries.flatMap((entry) => ("label" in entry ? [entry.label] : []));
  const entry = (entries: MenuEntry[], label: string) => entries.find((candidate) => "label" in candidate && candidate.label === label) as Extract<MenuEntry, { label: string }>;
  const calls: string[] = [];
  const act = {
    newTab: () => calls.push("newTab"),
    ownSpace: () => calls.push("ownSpace"),
    release: () => calls.push("release"),
    closeBeside: (tabIds: readonly string[]) => calls.push(`close ${tabIds.join(",")}`),
  };

  it("offers what fits a page with tabs beside it: no rename, colour, keep open or close space", () => {
    const entries = pageSpaceMenu(group("fav-group", ["fav-page", "x", "y"], { anchorId: "fav" }), "fav-page", act);
    expect(labels(entries)).toEqual(["New tab in space", "Make it a space of its own", "Release the tabs", "Close the tabs beside it"]);
    expect(entries.some((candidate) => "swatches" in candidate)).toBe(false);
    entry(entries, "Close the tabs beside it").onSelect();
    entry(entries, "Make it a space of its own").onSelect();
    expect(calls).toEqual(["close x,y", "ownSpace"]);
  });

  it("has nothing to release or close with the page alone", () => {
    const entries = pageSpaceMenu(group("pin-group", ["pin-page"], { anchorId: "pin" }), "pin-page", act);
    expect(entry(entries, "Release the tabs").disabled).toBe(true);
    expect(entry(entries, "Close the tabs beside it").disabled).toBe(true);
    expect(labels(pageSpaceMenu(group("g", ["p", "x"], { anchorId: "pin" }), "p", act))).toContain("Close the tab beside it");
  });
});

describe("Today's drops among the day's units", () => {
  // The units as main counts them: a, [trip], d, [empty], e — Today draws a, d and e.
  const units = [{ kind: "tab" }, { kind: "group" }, { kind: "tab" }, { kind: "group" }, { kind: "tab" }];
  const drawn = (unit: { kind: string }): boolean => unit.kind !== "group";

  it("go just after the drawn unit before them, or before the first at the top", () => {
    expect(fullUnitIndex(units, 0, drawn)).toBe(0);
    expect(fullUnitIndex(units, 1, drawn)).toBe(1);
    expect(fullUnitIndex(units, 2, drawn)).toBe(3);
    expect(fullUnitIndex(units, 3, drawn)).toBe(5);
    expect(fullUnitIndex(units, 9, drawn)).toBe(5);
  });

  it("start behind a space standing first, and go after every unit with none drawn", () => {
    expect(fullUnitIndex([{ kind: "group" }, { kind: "tab" }], 0, drawn)).toBe(1);
    expect(fullUnitIndex([{ kind: "group" }], 0, drawn)).toBe(1);
  });

  it("read back as the drawn place", () => {
    for (let index = 0; index <= 3; index++) expect(visibleUnitIndex(units, fullUnitIndex(units, index, drawn), drawn)).toBe(index);
  });
});

describe("a tile carried along the rail", () => {
  const units = [{ id: "a" }, { id: "group:one" }, { id: "b" }, { id: "group:two" }, { id: "group:three" }];

  it("moves its space just before or after the tile it was let go on, counted without itself", () => {
    expect(railMoveIndex(units, "three", "one", false)).toBe(1);
    expect(railMoveIndex(units, "three", "one", true)).toBe(2);
    expect(railMoveIndex(units, "one", "two", true)).toBe(3);
    expect(railMoveIndex(units, "one", "missing", true)).toBeNull();
    expect(railMoveIndex(units, "page", "one", true)).toBeNull();
  });
});

describe("a drop in a space's view", () => {
  const row = (top: number, groupId = "trip", kind: MeasuredRow["kind"] = "member"): MeasuredRow => ({ kind, entityId: `r${String(top)}`, folderId: null, groupId, top, height: 32 });

  it("is a place among the space's rows, by the rows' middles", () => {
    const rows = [row(0), row(34), row(68)];
    expect(spaceDropAt(rows, 5, "trip")).toEqual({ zone: "group", groupId: "trip", index: 0 });
    expect(spaceDropAt(rows, 40, "trip")).toEqual({ zone: "group", groupId: "trip", index: 1 });
    expect(spaceDropAt(rows, 500, "trip")).toEqual({ zone: "group", groupId: "trip", index: 3 });
  });

  it("is nothing with no row of the space to drop among (a page's space draws its rows as its entry's)", () => {
    expect(spaceDropAt([row(0, "trip", "tab")], 10, "trip")).toBeNull();
  });
});

describe("the card's outline", () => {
  const frame = { x0: 56, x1: 304, y0: 8, y1: 892, bx: 78, by: 36, tabLeft: 3 };
  const numbers = (d: string): number[] => (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);

  it("is one closed path round the card, the tab and the shoulder, every corner an arc", () => {
    const d = cardOutline(frame, { top: 120, bottom: 170 });
    expect(d.startsWith("M")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    expect(d.match(/A/g)).toHaveLength(10);
    expect(numbers(d).every(Number.isFinite)).toBe(true);
    // The tab reaches out over the rail; nothing passes the card's trailing edge.
    expect(Math.min(...numbers(d).filter((_, index) => index % 2 === 0))).toBeLessThanOrEqual(3);
    expect(Math.max(...numbers(d))).toBeLessThanOrEqual(892);
  });

  it("keeps the tab below the shoulder, and draws none when asked for none", () => {
    expect(cardOutline(frame, { top: 0, bottom: 20 })).toContain(" 40A");
    expect(cardOutline(frame, null).match(/A/g)).toHaveLength(6);
  });

  it("backs a tile on the rail alone with a rounded box", () => {
    const d = backingOutline(3, 53, 120, 170);
    expect(d.match(/A/g)).toHaveLength(4);
    expect(d.endsWith("Z")).toBe(true);
  });

  it("makes the column the rail alone, or the rail, the card and the gap to the desk", () => {
    expect(spaceColumnWidth("rail", 248)).toBe(56);
    expect(spaceColumnWidth("whole", 248)).toBe(312);
    expect(spaceColumnWidth("hidden", 200)).toBe(264);
  });
});

describe("a space's head", () => {
  it("says a space is being named, and names a page's space after its page", () => {
    const naming = renderToStaticMarkup(createElement(SpaceHead, { group: group("trip", ["b", "c"], { naming: true }), page: false, count: 2 }));
    expect(naming).toContain("Naming…");
    expect(naming).toContain("data-naming");
    expect(naming).toContain('data-testid="space-more"');
    const named = renderToStaticMarkup(createElement(SpaceHead, { group: group("trip", ["b", "c"]), page: false, count: 2 }));
    expect(named).toContain("TRIP");
    expect(named).toContain("2 windows");
    const empty = renderToStaticMarkup(createElement(SpaceHead, { group: group("empty", []), page: false, count: 0 }));
    expect(empty).not.toContain("space-count");
  });
});
