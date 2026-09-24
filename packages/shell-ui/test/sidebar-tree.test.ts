import { describe, expect, it } from "vitest";
import { favoriteDropAt, GROUP_END, GROUP_INDENT, listDropAt, PIN_INDENT, pinnedRows, type MeasuredRow, type MeasuredTile } from "../src/lib/sidebar-tree";
import type { SidebarEntry } from "@pistachio/shell-contracts/sidebar";

const H = 32;

/** Rows stacked from the top, each H tall, in the order given. */
function stack(specs: Array<Omit<MeasuredRow, "top" | "height">>): MeasuredRow[] {
  return specs.map((spec, i) => ({ ...spec, top: i * H, height: H }));
}

const folder = (id: string, collapsed = false): Omit<MeasuredRow, "top" | "height"> => ({ kind: "folder", entityId: id, folderId: null, collapsed });
const pin = (id: string, folderId: string | null = null): Omit<MeasuredRow, "top" | "height"> => ({ kind: "pin", entityId: id, folderId });
const divider = (): Omit<MeasuredRow, "top" | "height"> => ({ kind: "divider", entityId: "__new-tab", folderId: null });
const tab = (id: string): Omit<MeasuredRow, "top" | "height"> => ({ kind: "tab", entityId: id, folderId: null });

/** The middle of row i. */
const mid = (i: number): number => i * H + H / 2;
/** Just above the middle of row i — "before it". */
const before = (i: number): number => i * H + 4;
/** Just below the middle of row i — "after it". */
const after = (i: number): number => i * H + H - 4;

describe("pinnedRows", () => {
  const entries: SidebarEntry[] = [
    { kind: "pin", id: "a", url: "https://a/", title: "a", faviconUrl: null, folderId: null },
    { kind: "folder", id: "f", name: "F", collapsed: true, color: null, emoji: null },
    { kind: "pin", id: "f1", url: "https://f1/", title: "f1", faviconUrl: null, folderId: "f" },
    { kind: "folder", id: "g", name: "G", collapsed: false, color: null, emoji: null },
    { kind: "pin", id: "g1", url: "https://g1/", title: "g1", faviconUrl: null, folderId: "g" },
  ];

  it("lists folders with their pins indented, and hides a collapsed folder's pins", () => {
    const rows = pinnedRows(entries);
    expect(rows.map((r) => (r.kind === "folder" ? `${r.folder.id}(${String(r.count)})` : `${r.pin.id}@${String(r.depth)}`))).toEqual([
      "a@0",
      "f(1)",
      "g(1)",
      "g1@1",
    ]);
  });

  it("shows a collapsed folder's pins while a drag is aimed at it", () => {
    const rows = pinnedRows(entries, { openFolderId: "f" });
    expect(rows.map((r) => (r.kind === "folder" ? r.folder.id : r.pin.id))).toEqual(["a", "f", "f1", "g", "g1"]);
  });
});

describe("listDropAt", () => {
  // a · F(open) · f1 · f2 · b · [new tab] · t1 · t2
  const rows = stack([pin("a"), folder("F"), pin("f1", "F"), pin("f2", "F"), pin("b"), divider(), tab("t1"), tab("t2")]);

  it("names a top-level slot by the rows' centres", () => {
    expect(listDropAt(rows, "pin", before(0), 0)).toEqual({ zone: "pinned", folderId: null, index: 0 });
    expect(listDropAt(rows, "pin", after(0), 0)).toEqual({ zone: "pinned", folderId: null, index: 1 });
    // Below b, above the divider: after the last top-level entry (a, F, b → 3).
    expect(listDropAt(rows, "pin", before(5), 0)).toEqual({ zone: "pinned", folderId: null, index: 3 });
  });

  it("drops into a folder at its head just below an open header, and between its pins by position", () => {
    expect(listDropAt(rows, "pin", after(1), 0)).toEqual({ zone: "pinned", folderId: "F", index: 0 });
    expect(listDropAt(rows, "tab", after(2), 0)).toEqual({ zone: "pinned", folderId: "F", index: 1 });
  });

  it("hovering the middle of a header drops into the folder at its end — a collapsed one included", () => {
    expect(listDropAt(rows, "pin", mid(1), 0)).toEqual({ zone: "pinned", folderId: "F", index: 2 });
    const collapsed = stack([folder("C", true), pin("z"), divider()]);
    expect(listDropAt(collapsed, "pin", mid(0), 0)).toEqual({ zone: "pinned", folderId: "C", index: 0 });
    // Just below a collapsed header is after it, not inside it.
    expect(listDropAt(collapsed, "pin", after(0), 0)).toEqual({ zone: "pinned", folderId: null, index: 1 });
  });

  it("resolves the slot below a folder's last pin by x: indented stays inside, flush leaves", () => {
    expect(listDropAt(rows, "pin", after(3), PIN_INDENT)).toEqual({ zone: "pinned", folderId: "F", index: 2 });
    expect(listDropAt(rows, "pin", after(3), 0)).toEqual({ zone: "pinned", folderId: null, index: 2 });
  });

  it("puts anything below the divider among the day's tabs", () => {
    expect(listDropAt(rows, "pin", after(5), 0)).toEqual({ zone: "today", index: 0 });
    expect(listDropAt(rows, "tab", after(6), 0)).toEqual({ zone: "today", index: 1 });
    expect(listDropAt(rows, "tab", after(7), 0)).toEqual({ zone: "today", index: 2 });
    expect(listDropAt(rows, "favorite", 10_000, 0)).toEqual({ zone: "today", index: 2 });
  });

  it("keeps a split pair among the day's tabs even when dragged above the divider", () => {
    expect(listDropAt(rows, "split", before(0), 0)).toEqual({ zone: "today", index: 0 });
    expect(listDropAt(rows, "split", mid(1), 0)).toEqual({ zone: "today", index: 0 });
  });

  it("keeps a folder at the top level, stepping past another folder's pins, and above the divider", () => {
    expect(listDropAt(rows, "folder", after(2), PIN_INDENT)).toEqual({ zone: "pinned", folderId: null, index: 2 });
    expect(listDropAt(rows, "folder", mid(1), 0)).toEqual({ zone: "pinned", folderId: null, index: 1 });
    expect(listDropAt(rows, "folder", 10_000, 0)).toEqual({ zone: "pinned", folderId: null, index: 3 });
  });

  it("handles an empty pinned section", () => {
    const bare = stack([divider(), tab("t1")]);
    expect(listDropAt(bare, "tab", before(0), 0)).toEqual({ zone: "pinned", folderId: null, index: 0 });
    expect(listDropAt(bare, "tab", after(0), 0)).toEqual({ zone: "today", index: 0 });
  });
});

describe("listDropAt over tab groups", () => {
  const group = (id: string, collapsed = false): Omit<MeasuredRow, "top" | "height"> => ({ kind: "group", entityId: `group:${id}`, folderId: null, groupId: id, collapsed });
  const member = (id: string, groupId: string): Omit<MeasuredRow, "top" | "height"> => ({ kind: "member", entityId: id, folderId: null, groupId });
  // [new tab] · t1 · G(open) · g1 · g2 · t2 · H(closed) · t3
  const rows = stack([divider(), tab("t1"), group("G"), member("g1", "G"), member("g2", "G"), tab("t2"), group("H", true), tab("t3")]);

  it("counts the day's slots in units: a group is one, its tabs are none", () => {
    expect(listDropAt(rows, "tab", before(1), 0)).toEqual({ zone: "today", index: 0 });
    // Above the group's header: after t1, before the group.
    expect(listDropAt(rows, "tab", before(2), 0)).toEqual({ zone: "today", index: 1 });
    // After t2: t1, G, t2 are three units, however many tabs G is showing.
    expect(listDropAt(rows, "tab", after(5), 0)).toEqual({ zone: "today", index: 3 });
    expect(listDropAt(rows, "tab", after(7), 0)).toEqual({ zone: "today", index: 5 });
  });

  it("the middle of a header drops into the group at its end — a closed one included", () => {
    expect(listDropAt(rows, "tab", mid(2), 0)).toEqual({ zone: "group", groupId: "G", index: GROUP_END });
    // A closed group has no rows to count, so the end is said without counting.
    expect(listDropAt(rows, "tab", mid(6), 0)).toEqual({ zone: "group", groupId: "H", index: GROUP_END });
    // A split can join a group too.
    expect(listDropAt(rows, "split", mid(6), 0)).toEqual({ zone: "group", groupId: "H", index: GROUP_END });
  });

  it("drops at a group's head just below an open header, and between its tabs by position", () => {
    expect(listDropAt(rows, "tab", after(2), 0)).toEqual({ zone: "group", groupId: "G", index: 0 });
    expect(listDropAt(rows, "tab", after(3), 0)).toEqual({ zone: "group", groupId: "G", index: 1 });
  });

  it("resolves the slot below a group's last tab by x: indented stays inside, flush leaves", () => {
    expect(listDropAt(rows, "tab", after(4), GROUP_INDENT)).toEqual({ zone: "group", groupId: "G", index: 2 });
    expect(listDropAt(rows, "tab", after(4), GROUP_INDENT - 1)).toEqual({ zone: "today", index: 2 });
  });

  it("the edges of a closed group's header are the slots around it", () => {
    expect(listDropAt(rows, "tab", before(6), 0)).toEqual({ zone: "today", index: 3 });
    expect(listDropAt(rows, "tab", after(6), 0)).toEqual({ zone: "today", index: 4 });
  });

  it("a group, a pin, or a favorite never lands inside a group: its tabs are not rows to them", () => {
    expect(listDropAt(rows, "group", mid(3), 40)).toEqual({ zone: "today", index: 2 });
    expect(listDropAt(rows, "group", mid(6), 40)).toEqual({ zone: "today", index: 3 });
    expect(listDropAt(rows, "pin", mid(2), 40)).toEqual({ zone: "today", index: 1 });
    expect(listDropAt(rows, "favorite", mid(4), 40)).toEqual({ zone: "today", index: 2 });
  });
});

describe("favoriteDropAt", () => {
  // A 3-column grid of 40px tiles with 6px gaps.
  const tiles: MeasuredTile[] = Array.from({ length: 5 }, (_, i) => ({
    id: String(i),
    left: (i % 3) * 46,
    top: Math.floor(i / 3) * 46,
    width: 40,
    height: 40,
  }));

  it("counts the tiles before the pointer in reading order", () => {
    expect(favoriteDropAt(tiles, 5, 20)).toBe(0);
    expect(favoriteDropAt(tiles, 30, 20)).toBe(1);
    expect(favoriteDropAt(tiles, 130, 20)).toBe(3);
    expect(favoriteDropAt(tiles, 5, 66)).toBe(3);
    expect(favoriteDropAt(tiles, 80, 66)).toBe(5);
    expect(favoriteDropAt([], 10, 10)).toBe(0);
  });
});
