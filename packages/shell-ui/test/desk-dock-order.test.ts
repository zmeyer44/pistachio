/**
 * The dock's order (src/lib/desk/dock-order.ts): an icon moved in the dock
 * lands where the drop counted, the other groups are listed as the sidebar
 * lists them, the dock shows a drop's order until the browser's catches up,
 * and a group moved among the dock's groups is moved among the day's rows
 * by the index main's `move` command counts in.
 */

import { describe, expect, it } from "vitest";
import type { BrowserTabInfo } from "@pistachio/shell-contracts/ipc";
import type { TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import { groupMoveIndex, groupsInRowOrder, movedOrder, settledOrder } from "../src/lib/desk/dock-order";

const group = (id: string, tabIds: string[]): TabGroupInfo => ({ id, title: id, color: "blue", tabIds, origin: "manual", open: false, createdAt: 0 });
const tab = (id: string, extra: Partial<BrowserTabInfo> = {}): BrowserTabInfo => ({ id, kind: "human", unlisted: false, anchorId: null, ...extra }) as BrowserTabInfo;

describe("an icon moved in the dock", () => {
  it("lands at the place counted without it, up or down", () => {
    expect(movedOrder(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(movedOrder(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(movedOrder(["a", "b", "c"], 1, 1)).toEqual(["a", "b", "c"]);
    expect(movedOrder(["a", "b", "c"], 0, 9)).toEqual(["b", "c", "a"]);
  });
});

describe("the dock's other groups", () => {
  it("are in the order the sidebar lists them: where their tabs sit in the row", () => {
    const groups = [group("late", ["t5", "t6"]), group("early", ["t1", "t2"]), group("middle", ["t4"])];
    const tabs = ["t0", "t1", "t2", "t3", "t4", "t5", "t6"].map((id) => tab(id));
    expect(groupsInRowOrder(groups, tabs).map((candidate) => candidate.id)).toEqual(["early", "middle", "late"]);
  });
});

describe("the order a drop made", () => {
  const items = ["a", "b", "c"].map((id) => ({ id }));

  it("is shown until the browser's says the same, with anything new after it, and a tab gone left out", () => {
    expect(settledOrder(items, ["c", "a", "b"], null).map((item) => item.id)).toEqual(["c", "a", "b"]);
    expect(settledOrder([...items, { id: "new" }], ["c", "a", "b"], null).map((item) => item.id)).toEqual(["c", "a", "b", "new"]);
    expect(settledOrder(items, ["a", "c"], "b").map((item) => item.id)).toEqual(["a", "c"]);
  });

  it("with nothing settling, is the items as they are", () => {
    expect(settledOrder(items, null, null)).toBe(items);
  });
});

describe("a group moved among the dock's groups", () => {
  // The row: a lone tab, group A, a lone tab, group B, group C.
  const snapshot = {
    tabs: ["x", "a1", "a2", "y", "b1", "c1", "c2"].map((id) => tab(id)),
    tabGroups: [group("A", ["a1", "a2"]), group("B", ["b1"]), group("C", ["c1", "c2"])],
    splitGroups: [],
  };

  it("goes before the group after it in the dock, counted among the day's rows without it", () => {
    // C up above B: the rows without C are x, A, y, B — B is the fourth (index 3).
    expect(groupMoveIndex(snapshot, "C", ["A", "C", "B"])).toBe(3);
    // A down between B and C: the rows without A are x, y, B, C — C is index 3.
    expect(groupMoveIndex(snapshot, "A", ["B", "A", "C"])).toBe(3);
  });

  it("last in the dock, goes straight after the group before it", () => {
    // A to the end: straight after C, the last of x, y, B, C.
    expect(groupMoveIndex(snapshot, "A", ["B", "C", "A"])).toBe(4);
  });

  it("counts only the day's tabs, as main does", () => {
    const pinned = { ...snapshot, tabs: [tab("p", { anchorId: "pin-1" }), tab("agent", { kind: "agent" }), ...snapshot.tabs] };
    expect(groupMoveIndex(pinned, "C", ["A", "C", "B"])).toBe(3);
  });

  it("is nowhere to go for a group the order does not name", () => {
    expect(groupMoveIndex(snapshot, "Z", ["A", "B"])).toBeNull();
    expect(groupMoveIndex(snapshot, "A", ["B", "C"])).toBeNull();
  });
});
