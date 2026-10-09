import { describe, expect, it } from "vitest";
import {
  pruneArchive,
  sanitizeTabArchive,
  archiveEntryView,
  isTabArchiveRequest,
  type ArchiveEntry,
} from "../src/tab-archive.js";
import {
  dayRowUnits,
  DEFAULT_TAB_GROUP_TITLE,
  groupedTabOrder,
  isPersonsGroup,
  isTabGroupCommand,
  MAX_TAB_GROUPS_PER_SPACE,
  nextTabGroupColor,
  sanitizeTabGroups,
  splitMembersOf,
  storedTabGroupTitle,
  tabGroupTitle,
  withoutTabs,
  type TabGroupInfo,
} from "../src/tab-groups.js";
import { sanitizeTabSession, TAB_SESSION_VERSION } from "../src/tab-session.js";

const group = (id: string, tabIds: string[], origin: TabGroupInfo["origin"] = "manual"): TabGroupInfo => ({
  id,
  title: id,
  color: "blue",
  tabIds,
  origin,
  open: false,
  createdAt: 1,
});

describe("sanitizeTabGroups", () => {
  it("keeps only groupable tabs, one group per tab, and an emptied group as an empty space", () => {
    const groups = sanitizeTabGroups(
      [
        { id: "g1", title: "  Lisbon   trip ", color: "amber", tabIds: ["a", "b", "pinned"], origin: "auto", open: true, createdAt: 5 },
        { id: "g2", title: "", color: "nope", tabIds: ["b", "c"] },
        { id: "g3", tabIds: ["gone"] },
        { id: "g1", tabIds: ["d"] },
        "junk",
      ],
      new Set(["a", "b", "c", "d"]),
    );
    expect(groups).toEqual([
      { id: "g1", title: "Lisbon trip", color: "amber", tabIds: ["a", "b"], origin: "auto", open: true, createdAt: 5 },
      { id: "g2", title: "New space", color: "gray", tabIds: ["c"], origin: "manual", open: false, createdAt: 0 },
      // (Until 2026-10-09 a group left with no members was dropped here.)
      { id: "g3", title: "New space", color: "gray", tabIds: [], origin: "manual", open: false, createdAt: 0 },
    ]);
  });

  it("keeps an empty drawn space where it stands, and drops a loose tab's or a page's group with no tab", () => {
    const groups = sanitizeTabGroups(
      [
        { id: "empty", title: "Trip", color: "green", tabIds: [], origin: "manual", createdAt: 3, beforeUnit: "group:other" },
        { id: "emptied", tabIds: ["gone"], beforeUnit: "tab-x" },
        { id: "unplaced", tabIds: [], beforeUnit: 7 },
        { id: "too-far", tabIds: [], beforeUnit: "x".repeat(201) },
        { id: "loose-gone", tabIds: ["gone"], loose: true },
        { id: "loose-none", tabIds: [], loose: true },
        { id: "page-gone", tabIds: [], anchorId: "fav" },
        // A space with tabs stands where its first tab does: a stored place means nothing to it.
        { id: "full", tabIds: ["a"], beforeUnit: "tab-x" },
      ],
      new Set(["a"]),
    );
    expect(groups.map((group) => [group.id, group.tabIds, group.beforeUnit ?? null, group.loose === true])).toEqual([
      ["empty", [], "group:other", false],
      ["emptied", [], "tab-x", false],
      ["unplaced", [], null, false],
      ["too-far", [], null, false],
      ["full", ["a"], null, false],
    ]);
    expect(groups[0]).toMatchObject({ title: "Trip", color: "green", origin: "manual", createdAt: 3 });
  });

  it("counts empty spaces among the drawn ones' bound", () => {
    const empties = Array.from({ length: MAX_TAB_GROUPS_PER_SPACE + 5 }, (_, index) => ({ id: `e${String(index)}`, tabIds: [] }));
    expect(sanitizeTabGroups([...empties, { id: "lone", tabIds: ["a"], loose: true }], new Set(["a"])).map((group) => group.id)).toEqual([
      ...empties.slice(0, MAX_TAB_GROUPS_PER_SPACE).map((group) => group.id),
      "lone",
    ]);
  });

  it("reads the default title from before 2026-10-09 as today's, and nothing else", () => {
    const groups = sanitizeTabGroups(
      [
        { id: "old", title: "New group", tabIds: ["a"] },
        { id: "spaced", title: "  New   group ", tabIds: ["b"] },
        { id: "named", title: "New groups to read", tabIds: ["c"] },
        { id: "lower", title: "new group", tabIds: ["d"] },
      ],
      new Set(["a", "b", "c", "d"]),
    );
    expect(groups.map((group) => group.title)).toEqual([DEFAULT_TAB_GROUP_TITLE, DEFAULT_TAB_GROUP_TITLE, "New groups to read", "new group"]);
    expect(DEFAULT_TAB_GROUP_TITLE).toBe("New space");
    expect(storedTabGroupTitle("New group")).toBe("New space");
    // A name typed now is the person's, whatever it says.
    expect(tabGroupTitle("New group")).toBe("New group");
  });

  it("reads anything that is not a list as no groups", () => {
    expect(sanitizeTabGroups(undefined, new Set())).toEqual([]);
    expect(sanitizeTabGroups({}, new Set())).toEqual([]);
  });

  it("bounds the drawn groups and the loose tabs' apart, so neither pushes the other out", () => {
    const tabs = Array.from({ length: 120 }, (_, index) => `t${String(index)}`);
    const looseGroups = tabs.slice(0, 60).map((tabId, index) => ({ id: `l${String(index)}`, tabIds: [tabId], loose: true }));
    const drawnGroups = tabs.slice(60, 111).map((tabId, index) => ({ id: `d${String(index)}`, tabIds: [tabId] }));
    const groups = sanitizeTabGroups([...looseGroups, ...drawnGroups], new Set(tabs));
    expect(groups.filter((candidate) => candidate.loose === true)).toHaveLength(60);
    expect(groups.filter((candidate) => candidate.loose !== true)).toHaveLength(50);
  });

  it("keeps a page's group with its entry's page, and without it makes it a group like any other", () => {
    const groups = sanitizeTabGroups(
      [
        { id: "led", tabIds: ["page", "a"], anchorId: "fav" },
        // Its page is some other entry's now: the group is a plain one, and the page is not its.
        { id: "strayed", tabIds: ["other-page", "b", "c"], anchorId: "fav-2" },
        { id: "alone", tabIds: ["d"], anchorId: "pin-gone" },
        // An entry's page is never a plain group's.
        { id: "plain", tabIds: ["page-2", "e"] },
      ],
      new Set(["a", "b", "c", "d", "e"]),
      new Map([
        ["page", "fav"],
        ["other-page", "pin-1"],
        ["page-2", "fav-3"],
      ]),
    );
    expect(groups.map((candidate) => [candidate.id, candidate.tabIds, candidate.anchorId ?? null, candidate.loose === true])).toEqual([
      ["led", ["page", "a"], "fav", false],
      ["strayed", ["b", "c"], null, false],
      ["alone", ["d"], null, true],
      ["plain", ["e"], null, false],
    ]);
  });

  it("keeps a loose tab's group loose only while it holds the one tab", () => {
    const groups = sanitizeTabGroups(
      [
        { id: "lone", tabIds: ["a"], loose: true },
        { id: "grown", tabIds: ["b", "c"], loose: true },
      ],
      new Set(["a", "b", "c"]),
    );
    expect(groups.map((candidate) => [candidate.id, candidate.loose === true])).toEqual([
      ["lone", true],
      ["grown", false],
    ]);
  });
});

describe("withoutTabs", () => {
  it("returns the same array when nothing left", () => {
    const groups = [group("g", ["a", "b"])];
    expect(withoutTabs(groups, new Set(["z"]))).toBe(groups);
  });

  it("dissolves an emptied group, and makes an auto group left with one tab that tab's loose space in place", () => {
    const groups = [group("mine", ["a", "b"]), group("made", ["c", "d"], "auto"), group("solo", ["e"])];
    // (Until 2026-10-09 the auto group dissolved, and its tab's loose group came afresh with a new id.)
    expect(withoutTabs(groups, new Set(["a", "c", "e"]))).toEqual([
      group("mine", ["b"]),
      { ...group("made", ["d"], "auto"), loose: true, color: "gray" },
    ]);
  });

  it("keeps the person's emptied spaces, and a kept auto group of one drawn", () => {
    const loose: TabGroupInfo = { ...group("loose", ["l"]), color: "gray", loose: true };
    const page: TabGroupInfo = { ...group("page", ["p"]), anchorId: "fav" };
    const groups = [group("mine", ["a"]), group("made", ["c", "d"], "auto"), group("stack", ["e"], "auto"), loose, page, group("untouched", [])];
    const asked: string[] = [];
    const keep = (candidate: TabGroupInfo): boolean => {
      asked.push(candidate.id);
      return candidate.id !== "stack" || candidate.tabIds.length === 1;
    };
    expect(withoutTabs(groups, new Set(["a", "c", "e", "l", "p"]), keep)).toEqual([
      group("mine", []),
      // Kept, an auto group of one stays a drawn group.
      group("made", ["d"], "auto"),
      // `keep` sees the group as it was: "stack" held "e" when asked.
      group("stack", [], "auto"),
      // A loose tab's space kept with no tab is drawn from then on; a page's keeps its anchor for the caller to let go of.
      { ...group("loose", []), color: "gray" },
      { ...group("page", []), anchorId: "fav" },
      group("untouched", []),
    ]);
    // Asked only of the groups that lost tabs.
    expect(asked).toEqual(["mine", "made", "stack", "loose", "page"]);
    // Not kept, each goes as before.
    expect(withoutTabs(groups, new Set(["a", "e", "l", "p"]), () => false)).toEqual([groups[1], groups[5]]);
  });

  it("leaves a manual group of one tab drawn, and never makes a page's group loose", () => {
    const page: TabGroupInfo = { ...group("page", ["p", "x"], "auto"), anchorId: "fav" };
    expect(withoutTabs([group("mine", ["a", "b"]), page], new Set(["a", "p"]))).toEqual([group("mine", ["b"]), { ...page, tabIds: ["x"] }]);
  });
});

describe("isPersonsGroup", () => {
  const none = { context: false, conversation: false, held: false };
  it("is the person's when made or touched by hand, and neither loose nor a page's", () => {
    expect(isPersonsGroup(group("mine", []), none)).toBe(true);
    expect(isPersonsGroup(group("made", [], "auto"), none)).toBe(false);
    // Every shell `create` says manual, a loose tab's and a page's too: that says nothing of whose they are.
    expect(isPersonsGroup({ ...group("loose", ["a"]), loose: true }, none)).toBe(false);
    expect(isPersonsGroup({ ...group("page", ["p"]), anchorId: "fav" }, none)).toBe(false);
  });

  it("is the person's, whatever made it, while it holds a Stack, a conversation, or a running turn", () => {
    for (const candidate of [group("made", [], "auto"), { ...group("loose", ["a"]), loose: true }, { ...group("page", ["p"]), anchorId: "fav" }]) {
      expect(isPersonsGroup(candidate, { ...none, context: true })).toBe(true);
      expect(isPersonsGroup(candidate, { ...none, conversation: true })).toBe(true);
      expect(isPersonsGroup(candidate, { ...none, held: true })).toBe(true);
      expect(isPersonsGroup(candidate, none)).toBe(false);
    }
  });
});

describe("dayRowUnits", () => {
  const empty = (id: string, createdAt: number, beforeUnit?: string): TabGroupInfo => ({
    ...group(id, []),
    createdAt,
    ...(beforeUnit === undefined ? {} : { beforeUnit }),
  });
  const ids = (units: { id: string }[]): string[] => units.map((unit) => unit.id);

  it("counts tabs, splits and groups as one unit each", () => {
    const units = dayRowUnits(["a", "b", "c", "d", "e"], [{ id: "s", tabIds: ["c", "d"] }], [group("g", ["b", "e"])]);
    expect(units).toEqual([
      { id: "a", kind: "tab", tabIds: ["a"] },
      { id: "group:g", kind: "group", tabIds: ["b", "e"] },
      { id: "split:s", kind: "split", tabIds: ["c", "d"] },
    ]);
  });

  it("stands an empty space before the unit it names, as a unit with no tabs", () => {
    const units = dayRowUnits(["a", "b", "c"], [], [group("g", ["c"]), empty("e", 5, "b")]);
    expect(units).toEqual([
      { id: "a", kind: "tab", tabIds: ["a"] },
      { id: "group:e", kind: "group", tabIds: [] },
      { id: "b", kind: "tab", tabIds: ["b"] },
      { id: "group:g", kind: "group", tabIds: ["c"] },
    ]);
    expect(ids(dayRowUnits(["a", "b", "c"], [], [group("g", ["c"]), empty("e", 5, "group:g")]))).toEqual(["a", "b", "group:e", "group:g"]);
  });

  it("stands an empty space whose unit is gone, or never named, after everything, oldest first", () => {
    expect(ids(dayRowUnits(["a", "b"], [], [empty("late", 9, "gone"), empty("early", 2), empty("mid", 5, "group:gone")]))).toEqual([
      "a",
      "b",
      "group:early",
      "group:mid",
      "group:late",
    ]);
  });

  it("orders two empty spaces before one unit oldest first, and one before another after it", () => {
    expect(ids(dayRowUnits(["a", "b"], [], [empty("second", 7, "b"), empty("first", 3, "b")]))).toEqual(["a", "group:first", "group:second", "b"]);
    // One stands before an empty space that stands before a tab — whichever came first.
    expect(ids(dayRowUnits(["a", "b"], [], [empty("lead", 1, "group:next"), empty("next", 4, "b")]))).toEqual(["a", "group:lead", "group:next", "b"]);
    // One stands before an empty space that has no unit of its own to stand by: after it, at the end.
    expect(ids(dayRowUnits(["a"], [], [empty("lead", 1, "group:tail"), empty("tail", 4, "gone")]))).toEqual(["a", "group:lead", "group:tail"]);
    // A ring of them is never lost: the oldest goes at the end, and the other stands before it, as it asked.
    expect(ids(dayRowUnits(["a"], [], [empty("x", 2, "group:y"), empty("y", 1, "group:x")]))).toEqual(["a", "group:x", "group:y"]);
    // Nor one that names itself.
    expect(ids(dayRowUnits(["a"], [], [empty("self", 3, "group:self")]))).toEqual(["a", "group:self"]);
  });

  it("splices in only drawn empty spaces", () => {
    const loose: TabGroupInfo = { ...empty("loose", 1), loose: true };
    const page: TabGroupInfo = { ...empty("page", 1), anchorId: "fav" };
    expect(ids(dayRowUnits(["a"], [], [loose, page]))).toEqual(["a"]);
    expect(ids(dayRowUnits([], [], [empty("only", 1)]))).toEqual(["group:only"]);
  });
});

describe("groupedTabOrder", () => {
  it("gathers each group at its first member, in the group's own order", () => {
    const order = ["pin", "a", "x", "b", "y", "c"];
    expect(groupedTabOrder(order, [group("g", ["c", "a", "b"])])).toEqual(["pin", "c", "a", "b", "x", "y"]);
  });

  it("leaves an ungrouped row untouched and ignores members that are not in the row", () => {
    expect(groupedTabOrder(["a", "b"], [])).toEqual(["a", "b"]);
    expect(groupedTabOrder(["a", "b"], [group("g", ["b", "ghost"])])).toEqual(["a", "b"]);
  });
});

describe("group helpers", () => {
  it("titles are one bounded line, never empty", () => {
    expect(tabGroupTitle("  a\n b  ")).toBe("a b");
    expect(tabGroupTitle("x".repeat(80))).toHaveLength(40);
    expect(tabGroupTitle(7)).toBe("New space");
  });

  it("picks a colour the neighbours are not using", () => {
    expect(nextTabGroupColor([])).toBe("blue");
    expect(nextTabGroupColor([{ color: "blue" }, { color: "amber" }])).toBe("green");
  });

  it("splits with every tab up to four, then the four most recently used in group order", () => {
    const used: Record<string, number> = { a: 1, b: 9, c: 8, d: 2, e: 7, f: 6 };
    const at = (id: string): number => used[id] ?? 0;
    expect(splitMembersOf({ tabIds: ["a", "b"] }, at, 4)).toEqual(["a", "b"]);
    expect(splitMembersOf({ tabIds: ["a", "b", "c", "d", "e", "f"] }, at, 4)).toEqual(["b", "c", "e", "f"]);
  });

  it("checks commands at the boundary", () => {
    expect(isTabGroupCommand({ type: "create", id: "g-1", tabIds: ["t1", "cloud:t2"] })).toBe(true);
    // An empty space (New space) — but never a loose tab's or a page's, which are their one tab's.
    expect(isTabGroupCommand({ type: "create", id: "g-1", tabIds: [] })).toBe(true);
    expect(isTabGroupCommand({ type: "create", id: "g-1", tabIds: [], select: true })).toBe(true);
    expect(isTabGroupCommand({ type: "create", id: "g-1", tabIds: [], select: "yes" })).toBe(false);
    expect(isTabGroupCommand({ type: "create", id: "g-1", tabIds: [], loose: true })).toBe(false);
    expect(isTabGroupCommand({ type: "create", id: "g-1", tabIds: [], anchored: true })).toBe(false);
    expect(isTabGroupCommand({ type: "create", id: "g-1", tabIds: [], loose: false, anchored: false })).toBe(true);
    expect(isTabGroupCommand({ type: "create", id: "g-1", tabIds: Array.from({ length: 201 }, (_, i) => `t${String(i)}`) })).toBe(false);
    // Choosing a space, with or without the window to put in use.
    expect(isTabGroupCommand({ type: "select", groupId: "g-1" })).toBe(true);
    expect(isTabGroupCommand({ type: "select", groupId: "g-1", tabId: "cloud:t2" })).toBe(true);
    expect(isTabGroupCommand({ type: "select", groupId: "g-1", tabId: "" })).toBe(false);
    expect(isTabGroupCommand({ type: "select", groupId: "g-1", tabId: "t".repeat(193) })).toBe(false);
    expect(isTabGroupCommand({ type: "select", groupId: "not an id" })).toBe(false);
    expect(isTabGroupCommand({ type: "select" })).toBe(false);
    expect(isTabGroupCommand({ type: "create", id: "g-1", tabIds: ["t1"], loose: true })).toBe(true);
    expect(isTabGroupCommand({ type: "create", id: "g-1", tabIds: ["t1", "t2"], loose: true })).toBe(false);
    expect(isTabGroupCommand({ type: "create", id: "g-1", tabIds: ["t1"], loose: "yes" })).toBe(false);
    // A page's group is of the one page, and never a loose tab's too.
    expect(isTabGroupCommand({ type: "create", id: "g-1", tabIds: ["t1"], anchored: true })).toBe(true);
    expect(isTabGroupCommand({ type: "create", id: "g-1", tabIds: ["t1", "t2"], anchored: true })).toBe(false);
    expect(isTabGroupCommand({ type: "create", id: "g-1", tabIds: ["t1"], anchored: true, loose: true })).toBe(false);
    expect(isTabGroupCommand({ type: "recolor", groupId: "g", color: "teal" })).toBe(false);
    expect(isTabGroupCommand({ type: "move", groupId: "g", index: -1 })).toBe(false);
    expect(isTabGroupCommand({ type: "close", groupId: "g" })).toBe(true);
    expect(isTabGroupCommand({ type: "explode", groupId: "g" })).toBe(false);
  });
});

describe("tab archive", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const entry = (id: string, archivedAt: number): ArchiveEntry => ({
    id,
    spaceId: "work",
    archivedAt,
    reason: "idle",
    runId: null,
    kind: "tab",
    tab: { title: id, url: `https://${id}.example/`, faviconUrl: null, lastActiveAt: 1 },
  });

  it("reads a file back newest first and drops what cannot be restored", () => {
    const file = sanitizeTabArchive({
      version: 1,
      entries: [
        entry("old", 10),
        { ...entry("bad", 20), tab: { url: "javascript:alert(1)" } },
        entry("new", 30),
        { id: "grp", spaceId: "work", archivedAt: 25, reason: "closed", runId: null, kind: "group", group: { title: "Trip", color: "amber", origin: "auto" }, tabs: [entry("x", 0).kind === "tab" ? { title: "x", url: "https://x.example/", faviconUrl: null, lastActiveAt: 1 } : null] },
        { id: "empty", spaceId: "work", archivedAt: 26, kind: "group", group: {}, tabs: [] },
      ],
    });
    expect(file.entries.map((e) => e.id)).toEqual(["new", "grp", "old"]);
    expect(sanitizeTabArchive({ version: 9, entries: [] }).entries).toEqual([]);
  });

  it("keeps a space's entry with no tabs when it says which space it is, and its id with it", () => {
    const space = { id: "space", spaceId: "work", archivedAt: 40, reason: "closed", runId: null, kind: "group", group: { title: "New group", color: "green", origin: "manual" }, tabs: [] };
    const file = sanitizeTabArchive({
      version: 1,
      entries: [
        { ...space, groupId: "g-7" },
        { ...space, id: "nameless", groupId: "not an id" },
        { ...space, id: "anonymous" },
      ],
    });
    expect(file.entries).toEqual([
      // (The default title from before 2026-10-09 reads as today's.)
      { id: "space", spaceId: "work", archivedAt: 40, reason: "closed", runId: null, kind: "group", groupId: "g-7", group: { title: "New space", color: "green", origin: "manual" }, tabs: [] },
    ]);
    const withTabs = sanitizeTabArchive({ version: 1, entries: [{ ...space, groupId: "g-8", tabs: [{ title: "x", url: "https://x.example/", faviconUrl: null, lastActiveAt: 1 }] }] });
    expect(withTabs.entries[0]).toMatchObject({ kind: "group", groupId: "g-8" });
  });

  it("the view carries no history or checkpoint", () => {
    const withHistory: ArchiveEntry = {
      ...entry("a", 1),
      kind: "tab",
      tab: { title: "a", url: "https://a.example/", faviconUrl: null, lastActiveAt: 1, history: { entries: [{ url: "https://a.example/", title: "a" }], index: 0 } },
    };
    expect(JSON.stringify(archiveEntryView(withHistory))).not.toContain("history");
  });

  it("prunes by age, and returns the same array when nothing lapsed", () => {
    const now = 100 * DAY;
    const entries = [entry("fresh", now - DAY), entry("stale", now - 40 * DAY)];
    expect(pruneArchive(entries, now, 30).map((e) => e.id)).toEqual(["fresh"]);
    const kept = [entry("fresh", now - DAY)];
    expect(pruneArchive(kept, now, 30)).toBe(kept);
  });

  it("checks requests at the boundary", () => {
    expect(isTabArchiveRequest({ type: "list", spaceId: "work" })).toBe(true);
    expect(isTabArchiveRequest({ type: "restore", entryId: "e1", tabIndex: 2 })).toBe(true);
    expect(isTabArchiveRequest({ type: "restore", entryId: "e1", tabIndex: -1 })).toBe(false);
    expect(isTabArchiveRequest({ type: "clear" })).toBe(false);
  });
});

describe("a space in the session file", () => {
  const tab = (id: string) => ({ id, spaceId: "work", title: id, url: `https://${id}.example/`, faviconUrl: null, anchorId: null, lastActiveAt: 1 });
  const space = (spaces: Record<string, unknown>) => sanitizeTabSession({ version: TAB_SESSION_VERSION, spaces });

  it("keeps a Profile with no tabs but a space, and drops one with neither", () => {
    const session = space({
      work: { tabs: [], activeTabId: null, recentTabIds: [], splitGroups: [], tabGroups: [{ id: "g", title: "Trip", tabIds: [], origin: "manual" }], currentGroupId: "g" },
      bare: { tabs: [], activeTabId: null, recentTabIds: [], splitGroups: [] },
      // Its one group is a loose tab's, whose tab is gone: nothing is left to keep.
      gone: { tabs: [], activeTabId: null, recentTabIds: [], splitGroups: [], tabGroups: [{ id: "l", tabIds: ["t"], loose: true }] },
    });
    expect(Object.keys(session.spaces)).toEqual(["work"]);
    expect(session.spaces["work"]).toMatchObject({ tabs: [], activeTabId: null, currentGroupId: "g" });
    expect(session.spaces["work"]?.tabGroups?.map((group) => [group.id, group.tabIds])).toEqual([["g", []]]);
  });

  it("keeps the current space only when it names one of the Profile's spaces", () => {
    const session = space({
      kept: { tabs: [tab("a")], activeTabId: "a", recentTabIds: [], splitGroups: [], tabGroups: [{ id: "g", tabIds: ["a"] }], currentGroupId: "g" },
      stranger: { tabs: [tab("b")], activeTabId: "b", recentTabIds: [], splitGroups: [], tabGroups: [{ id: "g", tabIds: ["b"] }], currentGroupId: "elsewhere" },
      dropped: { tabs: [tab("c")], activeTabId: "c", recentTabIds: [], splitGroups: [], tabGroups: [{ id: "l", tabIds: ["gone"], loose: true }], currentGroupId: "l" },
      odd: { tabs: [tab("d")], activeTabId: "d", recentTabIds: [], splitGroups: [], tabGroups: [{ id: "g", tabIds: ["d"] }], currentGroupId: 7 },
      none: { tabs: [tab("e")], activeTabId: "e", recentTabIds: [], splitGroups: [], currentGroupId: "g" },
    });
    expect(Object.fromEntries(Object.entries(session.spaces).map(([id, saved]) => [id, saved.currentGroupId ?? null]))).toEqual({
      kept: "g",
      stranger: null,
      dropped: null,
      odd: null,
      none: null,
    });
  });
});
