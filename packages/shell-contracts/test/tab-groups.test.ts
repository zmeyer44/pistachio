import { describe, expect, it } from "vitest";
import {
  pruneArchive,
  sanitizeTabArchive,
  archiveEntryView,
  isTabArchiveRequest,
  type ArchiveEntry,
} from "../src/tab-archive.js";
import {
  groupedTabOrder,
  isTabGroupCommand,
  nextTabGroupColor,
  sanitizeTabGroups,
  splitMembersOf,
  tabGroupTitle,
  withoutTabs,
  type TabGroupInfo,
} from "../src/tab-groups.js";

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
  it("keeps only groupable tabs, one group per tab, and drops emptied groups", () => {
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
      { id: "g2", title: "New group", color: "gray", tabIds: ["c"], origin: "manual", open: false, createdAt: 0 },
    ]);
  });

  it("reads anything that is not a list as no groups", () => {
    expect(sanitizeTabGroups(undefined, new Set())).toEqual([]);
    expect(sanitizeTabGroups({}, new Set())).toEqual([]);
  });
});

describe("withoutTabs", () => {
  it("returns the same array when nothing left", () => {
    const groups = [group("g", ["a", "b"])];
    expect(withoutTabs(groups, new Set(["z"]))).toBe(groups);
  });

  it("dissolves an emptied group, and an auto group left with one tab", () => {
    const groups = [group("mine", ["a", "b"]), group("made", ["c", "d"], "auto"), group("solo", ["e"])];
    expect(withoutTabs(groups, new Set(["a", "c", "e"]))).toEqual([group("mine", ["b"])]);
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
    expect(tabGroupTitle(7)).toBe("New group");
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
    expect(isTabGroupCommand({ type: "create", id: "g-1", tabIds: [] })).toBe(false);
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
