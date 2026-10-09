/**
 * Spaces in main (docs/spaces.md §2): the pure rules BrowserController
 * applies as it keeps its spaces (tab groups) true — saved splits folded
 * into spaces, the current space chosen when nothing says, where an empty
 * space stands, which tabs need a space, what Tidy may not touch, what
 * makes a space the person's — and the session file carrying empty spaces,
 * their place and the current one across a launch. The controller itself
 * is Electron's and is covered by the e2e specs.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_TAB_GROUPS_PER_SPACE, dayRowUnits, isPersonsGroup, sanitizeTabGroups, withoutTabs, type TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import { TAB_SESSION_VERSION, type DurableSpaceSession, type DurableTab } from "@pistachio/shell-contracts/tab-session";
import { DeskConversationStore } from "../src/main/desk-conversations";
import { GroupContextStore } from "../src/main/group-context-store";
import {
  chooseCurrentGroup,
  foldSplitGroups,
  keepWithRoom,
  mostRecentTab,
  newestEmptySpace,
  overCapEmptySpaces,
  roomForDrawn,
  placeAmongUnits,
  settleBeforeUnits,
  spaceHolds,
  tabsWithoutSpace,
  tidyReach,
  unitsInHand,
} from "../src/main/spaces";
import { TabSessionStore } from "../src/main/tab-session-store";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "pistachio-spaces-"));
}

function tab(id: string, anchorId: string | null = null, lastActiveAt = 1): DurableTab {
  return { id, spaceId: "work", title: id, url: `https://${id}.example/`, faviconUrl: null, anchorId, lastActiveAt };
}

function space(id: string, tabIds: string[], extra: Partial<TabGroupInfo> = {}): TabGroupInfo {
  return { id, title: id, color: "blue", tabIds, origin: "manual", open: false, createdAt: 1, ...extra };
}

/* ------------------------------ saved splits ----------------------------- */

describe("foldSplitGroups", () => {
  const split = (id: string, tabIds: string[]) => ({ id, tabIds, primaryTabId: tabIds[0]!, secondaryTabId: tabIds[1] ?? tabIds[0]!, mode: "vertical" as const, gridLayout: "span-bottom" as const });
  const session = (tabs: DurableTab[], splitGroups: ReturnType<typeof split>[], tabGroups?: TabGroupInfo[]): DurableSpaceSession => ({
    tabs,
    activeTabId: tabs[0]?.id ?? null,
    recentTabIds: [],
    splitGroups,
    ...(tabGroups === undefined ? {} : { tabGroups }),
  });

  it("makes two loose day tabs of a split a space of their own, in pane order, with the split's id", () => {
    const folded = foldSplitGroups(session([tab("a"), tab("b"), tab("c")], [split("split-1", ["c", "a"])]), { now: 42 });
    expect(folded.splitGroups).toEqual([]);
    expect(folded.tabGroups).toEqual([{ id: "split-1", title: "New space", color: "blue", tabIds: ["c", "a"], origin: "manual", open: false, createdAt: 42 }]);
  });

  it("drops a split whose tabs are one space's already, one with a single day tab, and one with a tab gone", () => {
    const grouped = space("trip", ["a", "b"]);
    const folded = foldSplitGroups(
      session([tab("a"), tab("b"), tab("c"), tab("pin", "pin-1")], [split("s1", ["a", "b"]), split("s2", ["c", "pin"]), split("s3", ["c", "gone"])], [grouped]),
    );
    expect(folded.splitGroups).toEqual([]);
    expect(folded.tabGroups).toEqual([grouped]);
  });

  it("takes the tabs out of their loose spaces, keeps the others, and colours the new space beside them", () => {
    const loose = space("loose-a", ["a"], { loose: true, color: "gray" });
    const blue = space("blue", ["x"]);
    const folded = foldSplitGroups(session([tab("a"), tab("b"), tab("x")], [split("s1", ["a", "b"])], [loose, blue]), { now: 7 });
    expect(folded.tabGroups?.map((group) => group.id)).toEqual(["blue", "s1"]);
    expect(folded.tabGroups?.[1]).toMatchObject({ tabIds: ["a", "b"], color: "amber" });
  });

  it("is idempotent, and leaves a session with no splits as it is", () => {
    const plain = session([tab("a")], []);
    expect(foldSplitGroups(plain)).toBe(plain);
    const once = foldSplitGroups(session([tab("a"), tab("b")], [split("s1", ["a", "b"])]), { now: 1 });
    expect(foldSplitGroups(once)).toBe(once);
  });

  it("keeps a loose space of the person's (a Stack, a conversation) as an empty space with its id, where its tab was; the other loose space goes", () => {
    const mine = space("loose-mine", ["a"], { loose: true, color: "gray" });
    const other = space("loose-other", ["b"], { loose: true, color: "gray" });
    const folded = foldSplitGroups(session([tab("a"), tab("b")], [split("s1", ["a", "b"])], [mine, other]), { now: 7, keep: (groupId) => groupId === "loose-mine" });
    expect(folded.tabGroups?.map((group) => group.id).sort()).toEqual(["loose-mine", "s1"]);
    expect(folded.tabGroups?.find((group) => group.id === "s1")).toMatchObject({ tabIds: ["a", "b"], origin: "manual" });
    const kept = folded.tabGroups?.find((group) => group.id === "loose-mine");
    expect(kept).toMatchObject({ tabIds: [], beforeUnit: "group:s1" });
    expect(kept?.loose).toBeUndefined();
    // A space drawn on its own, which the keep rule then holds: the contract counts it the person's for its Stack.
    expect(isPersonsGroup(kept!, { context: true, conversation: false, held: false })).toBe(true);
    expect(dayRowUnits(["a", "b"], [], folded.tabGroups!).map((unit) => unit.id)).toEqual(["group:loose-mine", "group:s1"]);
  });

  it("gives the space a new id when the split's is taken by a space already", () => {
    const folded = foldSplitGroups(session([tab("a"), tab("b"), tab("c")], [split("taken", ["a", "b"])], [space("taken", ["c"])]), { newId: () => "fresh" });
    expect(folded.tabGroups?.map((group) => group.id)).toEqual(["taken", "fresh"]);
  });
});

/* ---------------------------- the current space -------------------------- */

describe("chooseCurrentGroup", () => {
  const groups = [space("g1", ["a", "b"]), space("loose-c", ["c"], { loose: true }), space("empty", [])];
  const at: Record<string, number> = { a: 10, b: 30, c: 20 };
  const lastActiveAt = (tabId: string) => at[tabId] ?? 0;

  it("keeps the saved space when it is one of the Profile's", () => {
    expect(chooseCurrentGroup({ groups, saved: "empty", activeTabId: "c" })).toBe("empty");
  });

  it("else takes the tab in use's, then the tab used last's, then the space whose tab was used latest", () => {
    expect(chooseCurrentGroup({ groups, saved: "gone", activeTabId: "c" })).toBe("loose-c");
    expect(chooseCurrentGroup({ groups, activeTabId: "nowhere", recentTabIds: ["zzz", "a"] })).toBe("g1");
    expect(chooseCurrentGroup({ groups, lastActiveAt })).toBe("g1");
    expect(chooseCurrentGroup({ groups: [groups[1]!, groups[0]!], lastActiveAt: (tabId) => (tabId === "c" ? 99 : 1) })).toBe("loose-c");
  });

  it("is null when no space holds a tab and none was saved: the caller makes a fresh one", () => {
    expect(chooseCurrentGroup({ groups: [space("empty", [])] })).toBeNull();
    expect(chooseCurrentGroup({ groups: [] })).toBeNull();
  });
});

describe("newestEmptySpace", () => {
  it("is the empty drawn space made last — never one with tabs, a loose tab's or a page's, nor the one going", () => {
    const groups = [
      space("old", [], { createdAt: 1 }),
      space("new", [], { createdAt: 3 }),
      space("full", ["a"], { createdAt: 9 }),
      space("page", [], { anchorId: "fav", createdAt: 8 }),
      space("loose", [], { loose: true, createdAt: 7 }),
    ];
    expect(newestEmptySpace(groups)).toBe("new");
    expect(newestEmptySpace(groups, "new")).toBe("old");
    expect(newestEmptySpace([space("full", ["a"])])).toBeNull();
  });

  // Fifty empty spaces of the person's and one loose tab, closed: no space holds a tab, and the bound refuses a fresh
  // one — the current space is then the newest empty one, never none (BrowserController #settleCurrentGroups,
  // #settleClose, #passFrom).
  it("gives a Profile at the bound with no tab a current space all the same", () => {
    const empties = Array.from({ length: MAX_TAB_GROUPS_PER_SPACE }, (_, index) => space(`e${String(index)}`, [], { createdAt: index }));
    expect(chooseCurrentGroup({ groups: empties })).toBeNull();
    expect(roomForDrawn(empties, "work", () => "work")).toBe(false);
    expect(newestEmptySpace(empties)).toBe(`e${String(MAX_TAB_GROUPS_PER_SPACE - 1)}`);
  });
});

describe("mostRecentTab", () => {
  it("takes the first in the recents, else the latest used, else nothing", () => {
    expect(mostRecentTab(["a", "b", "c"], ["x", "b", "a"])).toBe("b");
    expect(mostRecentTab(["a", "b"], [], (tabId) => (tabId === "b" ? 5 : 1))).toBe("b");
    expect(mostRecentTab(["a", "b"], [])).toBe("a");
    expect(mostRecentTab([], ["a"])).toBeUndefined();
  });
});

/* --------------------------- where an empty space stands ------------------ */

describe("settleBeforeUnits", () => {
  it("stands a space that just emptied where its last tab was, not at the end", () => {
    const groups = [space("e", [])];
    const previous = ["a", "group:e", "b", "c"];
    expect(settleBeforeUnits(groups, previous, new Set(), new Set(["a", "group:e", "b", "c"]))).toEqual(new Map([["e", "b"]]));
    // Its next unit gone too (the last tabs closed together): the first after it still here.
    expect(settleBeforeUnits(groups, previous, new Set(), new Set(["a", "group:e", "c"]))).toEqual(new Map([["e", "c"]]));
    // Nothing after it: the end.
    expect(settleBeforeUnits(groups, ["a", "group:e"], new Set(), new Set(["a", "group:e"]))).toEqual(new Map([["e", undefined]]));
  });

  it("keeps a unit still here, and re-resolves one that went to its successor", () => {
    expect(settleBeforeUnits([space("e", [], { beforeUnit: "b" })], ["a", "group:e", "b"], new Set(["group:e"]), new Set(["a", "group:e", "b"])).size).toBe(0);
    expect(settleBeforeUnits([space("e", [], { beforeUnit: "b" })], ["a", "group:e", "b", "c"], new Set(["group:e"]), new Set(["a", "group:e", "c"]))).toEqual(new Map([["e", "c"]]));
  });

  it("leaves one standing at the end on purpose — moved there, or never in the row (New space) — and never one before itself", () => {
    expect(settleBeforeUnits([space("e", [])], ["a", "group:e", "b"], new Set(["group:e"]), new Set(["a", "group:e", "b"])).size).toBe(0);
    expect(settleBeforeUnits([space("new", [])], ["a", "b"], new Set(), new Set(["a", "b", "group:new"])).size).toBe(0);
    expect(settleBeforeUnits([space("e", [], { beforeUnit: "group:e" })], ["a", "group:e", "b"], new Set(["group:e"]), new Set(["a", "group:e", "b"]))).toEqual(new Map([["e", "b"]]));
  });

  it("asks nothing of a space with tabs, a loose tab's, or a page's", () => {
    const groups = [space("full", ["a"]), space("loose", ["b"], { loose: true }), space("page", ["c"], { anchorId: "fav" })];
    expect(settleBeforeUnits(groups, ["group:full", "b"], new Set(), new Set(["group:full", "b"])).size).toBe(0);
  });

  it("puts the space back where dayRowUnits draws it", () => {
    const groups = [space("g", ["x", "y"]), space("e", [], { beforeUnit: "c" })];
    expect(dayRowUnits(["a", "x", "y", "c"], [], groups).map((unit) => unit.id)).toEqual(["a", "group:g", "group:e", "c"]);
  });

  // reorderTab by the tab order (BrowserController #keepEmptySpacesFrom): the tab an empty space stood before moves
  // away, and is counted gone — the space stays where it is drawn, before the unit that followed the tab.
  it("keeps an empty space where it is drawn when the tab it stood before is dragged away", () => {
    const e = space("e", [], { beforeUnit: "b" });
    const previous = ["a", "group:e", "b", "c"];
    const settled = settleBeforeUnits([e], previous, new Set(["group:e"]), new Set(["a", "group:e", "c"]));
    expect(settled).toEqual(new Map([["e", "c"]]));
    // b set down at the end: the row reads a, e, c, b — e did not go along with b (it would have, still before b).
    expect(dayRowUnits(["a", "c", "b"], [], [{ ...e, beforeUnit: settled.get("e")! }]).map((unit) => unit.id)).toEqual(["a", "group:e", "c", "b"]);
    expect(dayRowUnits(["a", "c", "b"], [], [e]).map((unit) => unit.id)).toEqual(["a", "c", "group:e", "b"]);
    // The tab was last: the space stands at the end, where it was drawn.
    expect(settleBeforeUnits([space("e", [], { beforeUnit: "b" })], ["a", "group:e", "b"], new Set(["group:e"]), new Set(["a", "group:e"]))).toEqual(new Map([["e", undefined]]));
  });
});

describe("placeAmongUnits", () => {
  const units = [
    { id: "a", kind: "tab", tabIds: ["a"] },
    { id: "group:e", kind: "group", tabIds: [] },
    { id: "x", kind: "tab", tabIds: ["x"] },
  ];

  it("sets a run down before the index-th unit's first tab, every empty space standing before the unit after it", () => {
    // Before the empty space: it stands before x, after the run.
    expect(placeAmongUnits(units, 1, "m")).toEqual({ beforeTabId: "x", beforeUnits: new Map([["e", "x"]]) });
    // After it: the run goes before x's tab all the same, and the space now stands before the run.
    expect(placeAmongUnits(units, 2, "m")).toEqual({ beforeTabId: "x", beforeUnits: new Map([["e", "m"]]) });
    // Past the end: after every tab.
    expect(placeAmongUnits(units, 9, "m")).toEqual({ beforeTabId: undefined, beforeUnits: new Map([["e", "x"]]) });
  });

  it("moves an empty space itself by its unit", () => {
    expect(placeAmongUnits([units[0]!, units[2]!], 0, "group:f")).toEqual({ beforeTabId: "a", beforeUnits: new Map([["f", "a"]]) });
    expect(placeAmongUnits([units[0]!, units[2]!], 2, "group:f")).toEqual({ beforeTabId: undefined, beforeUnits: new Map([["f", undefined]]) });
  });

  it("reads back, through dayRowUnits, as the row it meant", () => {
    for (const [index, row] of [
      [1, ["a", "m", "group:e", "x"]],
      [2, ["a", "group:e", "m", "x"]],
      [3, ["a", "group:e", "x", "m"]],
    ] as const) {
      const { beforeTabId, beforeUnits } = placeAmongUnits(units, index, "m");
      const tabs = ["a", "x"];
      tabs.splice(beforeTabId === undefined ? tabs.length : tabs.indexOf(beforeTabId), 0, "m");
      const beforeUnit = beforeUnits.get("e");
      expect(dayRowUnits(tabs, [], [space("e", [], beforeUnit === undefined ? {} : { beforeUnit })]).map((unit) => unit.id)).toEqual(row);
    }
  });
});

describe("unitsInHand", () => {
  /**
   * What main does with a drop at `index` among the units in hand (BrowserController #placeAtDayUnit): the run goes
   * before `beforeTabId` in the tab order, every empty space takes its `beforeUnit` — and the row is read back.
   */
  function drop(dayTabs: string[], groups: TabGroupInfo[], moving: string[], index: number, unit = moving.length === 1 ? moving[0]! : ""): string[] {
    const inHand = new Set(moving);
    const { beforeTabId, beforeUnits } = placeAmongUnits(unitsInHand(dayTabs, groups, inHand, unit), index, unit);
    const rest = dayTabs.filter((tabId) => !inHand.has(tabId));
    const at = beforeTabId === undefined ? -1 : rest.indexOf(beforeTabId);
    rest.splice(at < 0 ? rest.length : at, 0, ...moving);
    const placed = groups.map((group) => {
      if (group.tabIds.length > 0 || !beforeUnits.has(group.id)) return group;
      const { beforeUnit: _beforeUnit, ...others } = group;
      const beforeUnit = beforeUnits.get(group.id);
      return beforeUnit === undefined ? others : { ...others, beforeUnit };
    });
    return dayRowUnits(rest, [], placed).map((unit) => unit.id);
  }

  // The shell's fixture (packages/shell-ui/test/spaces-shell.test.ts, "a row let go among the day's rows"): T in hand,
  // X empty and standing before T (where T's row was), Y empty before R. As drawn: P · X · Q · Y · R.
  const spaces = (): TabGroupInfo[] => [space("x", [], { beforeUnit: "T", createdAt: 1 }), space("y", [], { beforeUnit: "R", createdAt: 2 })];
  const day = ["P", "T", "Q", "R"];

  it("counts the units as drawn, with T in hand: an empty space standing before T stays where it is drawn", () => {
    expect(unitsInHand(day, spaces(), new Set(["T"])).map((unit) => unit.id)).toEqual(["P", "group:x", "Q", "group:y", "R"]);
  });

  it("lands the tab exactly where it was dropped among them, every empty space keeping its place", () => {
    expect(drop(day, spaces(), ["T"], 0)).toEqual(["T", "P", "group:x", "Q", "group:y", "R"]);
    expect(drop(day, spaces(), ["T"], 2)).toEqual(["P", "group:x", "T", "Q", "group:y", "R"]);
    expect(drop(day, spaces(), ["T"], 3)).toEqual(["P", "group:x", "Q", "T", "group:y", "R"]);
    expect(drop(day, spaces(), ["T"], 4)).toEqual(["P", "group:x", "Q", "group:y", "T", "R"]);
    expect(drop(day, spaces(), ["T"], 5)).toEqual(["P", "group:x", "Q", "group:y", "R", "T"]);
  });

  it("counts as the shell does once the tab has left its space: gone with it, or kept empty where it stood", () => {
    // The auto space G that held only T went with it (main's reconcile after the shell's removeTab): P · Q.
    expect(unitsInHand(["P", "T", "Q"], [], new Set(["T"])).map((unit) => unit.id)).toEqual(["P", "Q"]);
    expect(drop(["P", "T", "Q"], [], ["T"], 1)).toEqual(["P", "T", "Q"]);
    // The person's G, kept empty before Q: P · G · Q, and T just below it goes below it.
    const kept = [space("g", [], { beforeUnit: "Q" })];
    expect(unitsInHand(["P", "T", "Q"], kept, new Set(["T"])).map((unit) => unit.id)).toEqual(["P", "group:g", "Q"]);
    expect(drop(["P", "T", "Q"], kept, ["T"], 2)).toEqual(["P", "group:g", "T", "Q"]);
  });

  it("keeps a space a lifted tab still belongs to as a unit (its header is drawn), and lifts a dragged space whole", () => {
    // T, the one tab of G, in hand: G's header stays a slot.
    expect(unitsInHand(["P", "T", "Q"], [space("g", ["T"])], new Set(["T"])).map((unit) => unit.id)).toEqual(["P", "group:g", "Q"]);
    // G (a, b) dragged by its header to the end, X standing before it: X stays where it is drawn, before R.
    const groups = [space("x", [], { beforeUnit: "group:g", createdAt: 1 }), space("g", ["a", "b"])];
    expect(unitsInHand(["P", "a", "b", "R"], groups, new Set(["a", "b"]), "group:g").map((unit) => unit.id)).toEqual(["P", "group:x", "R"]);
    expect(drop(["P", "a", "b", "R"], groups, ["a", "b"], 3, "group:g")).toEqual(["P", "group:x", "R", "group:g"]);
    // An empty space dragged by its header, another standing before it: that one stays, the dragged one lands.
    const empties = [space("x", [], { beforeUnit: "group:z", createdAt: 1 }), space("z", [], { beforeUnit: "R", createdAt: 2 })];
    expect(unitsInHand(["P", "R"], empties, new Set(), "group:z").map((unit) => unit.id)).toEqual(["P", "group:x", "R"]);
    expect(drop(["P", "R"], empties, [], 0, "group:z")).toEqual(["group:z", "P", "group:x", "R"]);
  });
});

/* ------------------------------- every tab a space ------------------------ */

describe("tabsWithoutSpace", () => {
  it("names each listed tab in no space, an entry's page once per entry", () => {
    const groups = [space("g", ["a"]), space("page", ["f1"], { anchorId: "fav-1" })];
    expect(
      tabsWithoutSpace(
        [
          { id: "a", anchorId: null },
          { id: "b", anchorId: null },
          { id: "f1", anchorId: "fav-1" },
          { id: "f2", anchorId: "fav-2" },
          { id: "f2-again", anchorId: "fav-2" },
          { id: "f1-again", anchorId: "fav-1" },
        ],
        groups,
      ),
    ).toEqual([
      { tabId: "b", anchorId: null },
      { tabId: "f2", anchorId: "fav-2" },
    ]);
  });

  it("stops at the bound the loose and the pages' spaces share", () => {
    const groups = [space("l", ["a"], { loose: true })];
    expect(tabsWithoutSpace([{ id: "b", anchorId: null }, { id: "c", anchorId: null }], groups, 2)).toEqual([{ tabId: "b", anchorId: null }]);
  });
});

/* ---------------------------------- Tidy ---------------------------------- */

describe("tidyReach", () => {
  const groups = [
    space("current", ["c1", "c2"], { origin: "auto" }),
    space("tidy-made", ["t1", "t2"], { origin: "auto" }),
    space("with-stack", ["s1", "s2"], { origin: "auto" }),
    space("loose-mine", ["l1"], { loose: true }),
    space("loose-other", ["l2"], { loose: true }),
    space("drawn-mine", ["d1"]),
  ];
  const stacks = new Set(["with-stack", "loose-mine"]);
  const reach = tidyReach(groups, "current", (group) => isPersonsGroup(group, { context: stacks.has(group.id), conversation: false, held: false }));

  it("spares the current space and every space that is the person's, whole", () => {
    expect([...reach.spareGroupIds].sort()).toEqual(["current", "drawn-mine", "loose-mine", "with-stack"]);
  });

  it("spares the tabs of the current space and of a loose space that is the person's — never another loose tab", () => {
    expect([...reach.spareTabIds].sort()).toEqual(["c1", "c2", "l1"]);
  });

  // A favorite's page space with a Stack (docs/spaces.md §1: Tidy never touches a space that is the person's): the
  // favorites reset neither brings it down nor archives it (favoriteGroupsDue skips spareGroupIds), nor re-addresses
  // its page; nor a window on the desk, though asleep — the current page space's minimized favorite included.
  const pages = [
    space("page-mine", ["p1", "p2"], { origin: "auto", anchorId: "fav-1" }),
    space("page-other", ["q1", "q2"], { origin: "auto", anchorId: "fav-2" }),
    space("page-current", ["r1", "r2"], { origin: "auto", anchorId: "fav-3" }),
    space("tidy-made", ["t1", "t2"], { origin: "auto" }),
  ];
  const pageReach = tidyReach(pages, "page-current", (group) => isPersonsGroup(group, { context: group.id === "page-mine", conversation: false, held: false }), ["r2", "t2"]);

  it("leaves a page's space that is the person's whole: no bringing down, no archiving, no reset", () => {
    expect([...pageReach.spareGroupIds].sort()).toEqual(["page-current", "page-mine"]);
    expect(pageReach.keepAddressTabIds.has("p1")).toBe(true);
    expect(pageReach.keepAddressTabIds.has("p2")).toBe(true);
    // (Its tabs stay out of spareTabIds: they are grouped, and Tidy's regrouping never takes a grouped tab.)
    expect(pageReach.spareTabIds.has("p1")).toBe(false);
  });

  it("keeps every window on the desk at its address, asleep or not, and only what is spared or there", () => {
    expect([...pageReach.keepAddressTabIds].sort()).toEqual(["p1", "p2", "r1", "r2", "t2"]);
  });
});

/* -------------------------------- the bound -------------------------------- */

describe("keepWithRoom", () => {
  /** `count` drawn spaces in the Profile "work", each with a tab of its own. */
  const drawn = (count: number): TabGroupInfo[] => Array.from({ length: count }, (_, index) => space(`d${String(index)}`, [`d${String(index)}-tab`], { createdAt: index }));
  const stacked = new Set(["loose-mine", "loose-too"]);
  const persons = (group: TabGroupInfo): boolean => isPersonsGroup(group, { context: stacked.has(group.id), conversation: false, held: false });
  const close = (groups: TabGroupInfo[], gone: string[]): TabGroupInfo[] => [...withoutTabs(groups, new Set(gone), keepWithRoom(groups, new Set(gone), persons, () => "work"))];
  /** What a save writes and the next launch reads back (TabSessionStore → sanitizeTabGroups). */
  const roundTrip = (groups: TabGroupInfo[]): string[] =>
    sanitizeTabGroups(JSON.parse(JSON.stringify(groups)) as unknown, new Set(groups.flatMap((group) => group.tabIds))).map((group) => group.id);

  it("at the bound, lets a loose space of the person's go with its last tab: no 51st space, and the same 50 come back after a launch", () => {
    const groups = [...drawn(MAX_TAB_GROUPS_PER_SPACE), space("loose-mine", ["t"], { loose: true })];
    const after = close(groups, ["t"]);
    expect(after.map((group) => group.id)).toEqual(drawn(MAX_TAB_GROUPS_PER_SPACE).map((group) => group.id));
    expect(roundTrip(after)).toEqual(after.map((group) => group.id));
  });

  it("below the bound, keeps it as before — an empty drawn space with its id, which a launch keeps too", () => {
    const groups = [...drawn(MAX_TAB_GROUPS_PER_SPACE - 1), space("loose-mine", ["t"], { loose: true })];
    const after = close(groups, ["t"]);
    const kept = after.find((group) => group.id === "loose-mine");
    expect(kept).toMatchObject({ tabIds: [] });
    expect(kept?.loose).toBeUndefined();
    expect(after).toHaveLength(MAX_TAB_GROUPS_PER_SPACE);
    expect(roundTrip(after)).toContain("loose-mine");
  });

  it("counts as it keeps: two emptied at once with room for one keeps the first; a drawn space of the person's needs no room", () => {
    const groups = [...drawn(MAX_TAB_GROUPS_PER_SPACE - 1), space("loose-mine", ["t"], { loose: true }), space("loose-too", ["u"], { loose: true })];
    expect(close(groups, ["t", "u"]).map((group) => group.id)).toContain("loose-mine");
    expect(close(groups, ["t", "u"]).map((group) => group.id)).not.toContain("loose-too");
    const full = [...drawn(MAX_TAB_GROUPS_PER_SPACE)];
    expect(close(full, ["d0-tab"]).map((group) => group.id)).toContain("d0");
  });
});

describe("overCapEmptySpaces", () => {
  const persons = (group: TabGroupInfo): boolean => isPersonsGroup(group, { context: false, conversation: false, held: false });

  it("names the empty drawn spaces past the bound that are nobody's, oldest first — never the current one, nor one with tabs", () => {
    const groups = [
      ...Array.from({ length: MAX_TAB_GROUPS_PER_SPACE - 1 }, (_, index) => space(`d${String(index)}`, [`t${String(index)}`], { createdAt: 100 + index })),
      space("empty-old", [], { createdAt: 1, origin: "auto" }),
      space("empty-current", [], { createdAt: 2, origin: "auto" }),
      space("empty-new", [], { createdAt: 3, origin: "auto" }),
    ];
    // 52 drawn: two must go — the oldest empties that are not current.
    expect([...overCapEmptySpaces(groups, () => "work", () => "empty-current", persons)].sort()).toEqual(["empty-new", "empty-old"]);
    expect(overCapEmptySpaces(groups.slice(0, MAX_TAB_GROUPS_PER_SPACE), () => "work", () => null, persons).size).toBe(0);
  });

  it("never names a space that is the person's: past the bound with only theirs left, it keeps them all", () => {
    const groups = [
      ...Array.from({ length: MAX_TAB_GROUPS_PER_SPACE - 1 }, (_, index) => space(`d${String(index)}`, [`t${String(index)}`], { createdAt: 100 + index })),
      space("made-by-hand", [], { createdAt: 1 }),
      space("tidy-made", [], { createdAt: 2, origin: "auto" }),
      space("also-mine", [], { createdAt: 3 }),
    ];
    expect([...overCapEmptySpaces(groups, () => "work", () => null, persons)]).toEqual(["tidy-made"]);
    expect(overCapEmptySpaces(groups.filter((group) => group.id !== "tidy-made"), () => "work", () => null, persons).size).toBe(0);
  });
});

describe("a tab moved into a space at the bound (BrowserController addToTabGroup)", () => {
  // 49 drawn spaces — the oldest an empty one the person made — and the destination D: 50. The loose tab t's space
  // holds a Stack. t moves into D, which is rebuilt by hand and so is not among the spaces it is taken out of.
  const stacked = new Set(["loose-t"]);
  const persons = (group: TabGroupInfo): boolean => isPersonsGroup(group, { context: stacked.has(group.id), conversation: false, held: false });
  const others = [
    space("made-by-hand", [], { createdAt: 0 }),
    ...Array.from({ length: MAX_TAB_GROUPS_PER_SPACE - 2 }, (_, index) => space(`d${String(index)}`, [`x${String(index)}`], { createdAt: 10 + index })),
  ];
  const destination = space("dest", ["y"], { createdAt: 5 });
  const loose = space("loose-t", ["t"], { loose: true, createdAt: 7 });

  it("counts the destination as it will be after the move: t's emptied space goes, and no space the person made is lost", () => {
    const from = [...others, loose];
    const gone = new Set(["t"]);
    const after = [...withoutTabs(from, gone, keepWithRoom(from, gone, persons, () => "work", ["work"])), { ...destination, tabIds: ["y", "t"] }];
    expect(after.map((group) => group.id)).not.toContain("loose-t");
    expect(after.filter((group) => group.loose !== true && group.anchorId === undefined)).toHaveLength(MAX_TAB_GROUPS_PER_SPACE);
    // Nothing past the bound for the backstop to take — "made-by-hand" stays.
    expect(overCapEmptySpaces(after, () => "work", () => null, persons).size).toBe(0);
    expect(after.map((group) => group.id)).toContain("made-by-hand");
  });
});

/* ------------------------------ what is theirs ---------------------------- */

describe("spaceHolds", () => {
  it("reads a Stack with something in it and a bound conversation whose thread is kept, from the stores", () => {
    const contexts = new GroupContextStore(scratch());
    const conversations = new DeskConversationStore(null);
    const kept = new Set<string>(["run-1"]);
    const holds = spaceHolds({ contexts, conversations, threads: { has: (runId) => kept.has(runId) } });

    expect(holds("g1")).toEqual({ context: false, conversation: false });
    const fact = contexts.addText("g1", "Lisbon", { kind: "fact", text: "Hotel QX7F2L" }, "person");
    expect(holds("g1").context).toBe(true);
    // An entry left with no items is no Stack: the space may go with its last tab.
    contexts.remove("g1", fact.id);
    expect(contexts.get("g1")).not.toBeNull();
    expect(holds("g1").context).toBe(false);

    conversations.bind("g1", "run-1");
    expect(holds("g1").conversation).toBe(true);
    // The thread pruned since: the binding is left behind, and is no conversation.
    kept.delete("run-1");
    expect(holds("g1").conversation).toBe(false);
  });

  it("feeds the contract's rule: an emptied auto or loose space stays only for what it holds", () => {
    const contexts = new GroupContextStore(scratch());
    const holds = spaceHolds({ contexts, conversations: null, threads: null });
    const persons = (group: TabGroupInfo) => isPersonsGroup(group, { ...holds(group.id), held: false });
    expect(persons(space("tidy", [], { origin: "auto" }))).toBe(false);
    expect(persons(space("mine", []))).toBe(true);
    contexts.addText("tidy", "Tidy", { kind: "fact", text: "kept" }, "person");
    expect(persons(space("tidy", [], { origin: "auto" }))).toBe(true);
  });

  it("holds nothing without the stores (a unit test's controller, the cloud host)", () => {
    expect(spaceHolds({ contexts: null, conversations: null, threads: null })("g1")).toEqual({ context: false, conversation: false });
  });
});

/* ------------------------------- the session file ------------------------- */

describe("a session with spaces across a launch", () => {
  it("keeps empty spaces with their place, the current space, and a Profile with no tabs", () => {
    const dir = scratch();
    const store = new TabSessionStore(dir, () => new Set(["work", "home"]));
    expect(store.existed()).toBe(false);
    store.save({
      version: TAB_SESSION_VERSION,
      spaces: {
        work: {
          tabs: [tab("a"), tab("b")],
          activeTabId: null,
          recentTabIds: ["b"],
          splitGroups: [],
          tabGroups: [space("trip", ["a"]), space("stack-only", [], { beforeUnit: "b" }), space("loose-b", ["b"], { loose: true, color: "gray" })],
          currentGroupId: "stack-only",
        },
        home: {
          tabs: [],
          activeTabId: null,
          recentTabIds: [],
          splitGroups: [],
          tabGroups: [space("new-space", [])],
          currentGroupId: "new-space",
        },
      },
    });
    store.flush();

    const relaunched = new TabSessionStore(dir, () => new Set(["work", "home"]));
    expect(relaunched.existed()).toBe(true);
    const work = relaunched.get().spaces["work"]!;
    // (The tab in use reads as the first tab whatever was saved — an older build's fallback; the current space is what launch follows.)
    expect(work.currentGroupId).toBe("stack-only");
    expect(work.tabGroups?.find((group) => group.id === "stack-only")).toMatchObject({ tabIds: [], beforeUnit: "b" });
    expect(work.tabGroups?.find((group) => group.id === "loose-b")).toMatchObject({ tabIds: ["b"], loose: true });
    // A Profile (Space) with spaces and no tabs is kept, its empty space current.
    expect(relaunched.get().spaces["home"]).toMatchObject({ tabs: [], currentGroupId: "new-space", tabGroups: [{ id: "new-space", tabIds: [] }] });
  });

  it("reads a current space that is not one of the Profile's as none, and an unreadable file as no session at all", () => {
    const dir = scratch();
    writeFileSync(
      join(dir, "tab-session.json"),
      JSON.stringify({ version: TAB_SESSION_VERSION, spaces: { work: { tabs: [tab("a")], activeTabId: "a", recentTabIds: [], splitGroups: [], currentGroupId: "elsewhere" } } }),
    );
    const store = new TabSessionStore(dir, () => new Set(["work"]));
    expect(store.existed()).toBe(true);
    expect(store.get().spaces["work"]?.currentGroupId).toBeUndefined();

    const broken = scratch();
    writeFileSync(join(broken, "tab-session.json"), "{ not json");
    // A file that cannot be read counts as none: that launch is a fresh install's, with its home tab.
    expect(new TabSessionStore(broken, () => new Set(["work"])).existed()).toBe(false);
  });
});
