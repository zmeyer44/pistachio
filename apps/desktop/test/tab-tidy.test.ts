import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ArchivedTab } from "@pistachio/shell-contracts/tab-archive";
import type { TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import type { TidyAnswer, TidyInput, TidySummary } from "@pistachio/shell-contracts/tidy";
import { TabArchiveStore } from "../src/main/tab-archive-store";
import { scriptedTidyJudge, TabTidy, type TidyCandidates, type TidyHost } from "../src/main/tab-tidy";

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

interface FakeTab {
  id: string;
  title: string;
  url: string;
  lastActiveAt: number;
  visible?: boolean;
}

/** The tabs' owner, reduced to what Tidy asks of it: one Space, an ordered row, groups by id. */
class FakeHost implements TidyHost<{ tabId: string; url: string }> {
  row: FakeTab[];
  groups: TabGroupInfo[] = [];
  favorites: Array<{ tabId: string; anchorId: string; url: string }> = [];
  commits = 0;
  #made = 0;

  constructor(tabs: FakeTab[]) {
    this.row = tabs;
  }

  titles(): string[] {
    return this.row.map((tab) => tab.title);
  }

  tidyCandidates(_spaceId: string, now: number, idleMs: number): TidyCandidates {
    const grouped = new Set(this.groups.flatMap((group) => group.tabIds));
    const idle = (tab: FakeTab): boolean => idleMs > 0 && tab.visible !== true && now - tab.lastActiveAt >= idleMs;
    return {
      tabs: this.row.filter((tab) => !grouped.has(tab.id)).map((tab) => ({ id: tab.id, title: tab.title, url: tab.url, lastActiveAt: tab.lastActiveAt, eligible: idle(tab) })),
      groups: this.groups.map((group) => ({ id: group.id, title: group.title, tabCount: group.tabIds.length })),
      idleAutoGroupIds: this.groups
        .filter((group) => group.origin === "auto" && group.tabIds.every((id) => this.row.some((tab) => tab.id === id && idle(tab))))
        .map((group) => group.id),
      staleHomeTabIds: [],
    };
  }

  tabGroups(): TabGroupInfo[] {
    return this.groups.map((group) => ({ ...group, tabIds: [...group.tabIds] }));
  }

  archiveTabs(tabIds: readonly string[]): Array<{ tabId: string; index: number; tab: ArchivedTab }> {
    const closed: Array<{ tabId: string; index: number; tab: ArchivedTab }> = [];
    for (const tabId of tabIds) {
      const index = this.row.findIndex((tab) => tab.id === tabId);
      const tab = this.row[index];
      if (tab === undefined || tab.visible === true) continue;
      closed.push({ tabId, index, tab: { title: tab.title, url: tab.url, faviconUrl: null, lastActiveAt: tab.lastActiveAt } });
      this.row.splice(index, 1);
      this.groups = this.groups.map((group) => ({ ...group, tabIds: group.tabIds.filter((id) => id !== tabId) })).filter((group) => group.tabIds.length > 0);
    }
    return closed;
  }

  restoreArchivedTabs(_spaceId: string, tabs: readonly ArchivedTab[], indexes?: readonly number[]): string[] {
    return tabs.map((tab, i) => {
      const id = `restored-${(this.#made += 1)}`;
      const restored: FakeTab = { id, title: tab.title, url: tab.url, lastActiveAt: tab.lastActiveAt };
      const at = indexes?.[i];
      if (at === undefined) this.row.push(restored);
      else this.row.splice(Math.min(at, this.row.length), 0, restored);
      return id;
    });
  }

  createTabGroup(options: { title?: string; color?: TabGroupInfo["color"]; tabIds: readonly string[]; origin: TabGroupInfo["origin"] }): TabGroupInfo | null {
    const tabIds = options.tabIds.filter((id) => this.row.some((tab) => tab.id === id));
    if (tabIds.length === 0) return null;
    const group: TabGroupInfo = { id: `group-${(this.#made += 1)}`, title: options.title ?? "New group", color: options.color ?? "blue", tabIds, origin: options.origin, open: false, createdAt: 0 };
    this.groups.push(group);
    this.#gather();
    return group;
  }

  /** What the real owner does before every publish: a group's tabs sit together, where its first one does. */
  #gather(): void {
    const byId = new Map(this.row.map((tab) => [tab.id, tab]));
    const groupOf = (id: string): TabGroupInfo | undefined => this.groups.find((group) => group.tabIds.includes(id));
    const placed = new Set<string>();
    const next: FakeTab[] = [];
    for (const tab of this.row) {
      const group = groupOf(tab.id);
      if (group === undefined) next.push(tab);
      else if (!placed.has(group.id)) {
        placed.add(group.id);
        next.push(...group.tabIds.flatMap((id) => byId.get(id) ?? []));
      }
    }
    this.row = next;
  }

  tabOrderOf(): string[] {
    return this.row.map((tab) => tab.id);
  }

  restoreTabOrder(_spaceId: string, order: readonly string[]): void {
    const byId = new Map(this.row.map((tab) => [tab.id, tab]));
    const known = new Set(order);
    this.row = [...order.flatMap((id) => byId.get(id) ?? []), ...this.row.filter((tab) => !known.has(tab.id))];
  }

  addToTabGroup(groupId: string, tabIds: readonly string[]): string[] {
    const group = this.groups.find((candidate) => candidate.id === groupId);
    if (group === undefined) return [];
    const added = tabIds.filter((id) => this.row.some((tab) => tab.id === id) && !group.tabIds.includes(id));
    group.tabIds.push(...added);
    this.#gather();
    return added;
  }

  removeFromTabGroups(tabIds: readonly string[]): void {
    this.groups = this.groups.map((group) => ({ ...group, tabIds: group.tabIds.filter((id) => !tabIds.includes(id)) })).filter((group) => group.tabIds.length > 0);
  }

  dissolveTabGroups(groupIds: readonly string[]): void {
    this.groups = this.groups.filter((group) => !groupIds.includes(group.id));
  }

  resetFavoriteTabs(_spaceId: string, homeOf: (anchorId: string) => { url: string; title: string } | null): Promise<Array<{ tabId: string; url: string }>> {
    const reset: Array<{ tabId: string; url: string }> = [];
    for (const favorite of this.favorites) {
      const home = homeOf(favorite.anchorId);
      if (home === null || home.url === favorite.url) continue;
      reset.push({ tabId: favorite.tabId, url: favorite.url });
      favorite.url = home.url;
    }
    return Promise.resolve(reset);
  }

  restoreFavoriteTabs(previous: ReadonlyArray<{ tabId: string; url: string }>): void {
    for (const was of previous) {
      const favorite = this.favorites.find((candidate) => candidate.tabId === was.tabId);
      if (favorite !== undefined) favorite.url = was.url;
    }
  }

  commitTidy(): void {
    this.commits += 1;
  }
}

const tab = (title: string, idleHours: number, extra: Partial<FakeTab> = {}): FakeTab => ({
  id: title.toLowerCase().replaceAll(" ", "-"),
  title,
  url: `https://example.com/${encodeURIComponent(title)}`,
  lastActiveAt: NOW - idleHours * HOUR,
  ...extra,
});

function tidyOver(
  host: FakeHost,
  options: { answer?: (input: TidyInput) => TidyAnswer | null; settings?: Partial<{ archiveAfterHours: number; groupRelated: boolean; resetFavorites: boolean }>; clock?: { now: number } } = {},
): { tidy: TabTidy<{ tabId: string; url: string }>; archive: TabArchiveStore; announced: TidySummary[]; asked: TidyInput[] } {
  const clock = options.clock ?? { now: NOW };
  const archive = new TabArchiveStore(mkdtempSync(join(tmpdir(), "pistachio-tidy-")), () => 30, () => clock.now);
  const announced: TidySummary[] = [];
  const asked: TidyInput[] = [];
  const tidy = new TabTidy({
    host,
    archive,
    settings: () => ({ archiveAfterHours: 12, groupRelated: true, resetFavorites: true, ...options.settings }),
    spaceIds: () => ["work"],
    activeSpaceId: () => "work",
    favoriteHome: (_spaceId, anchorId) => (anchorId === "fav-x" ? { url: "https://x.com/", title: "X" } : null),
    judge: (input) => {
      asked.push(input);
      return Promise.resolve(options.answer?.(input) ?? null);
    },
    announce: (summary) => announced.push(summary),
    now: () => clock.now,
  });
  return { tidy, archive, announced, asked };
}

describe("TabTidy", () => {
  it("archives idle tabs by the clock alone when there is no model", async () => {
    const host = new FakeHost([tab("Fresh", 1), tab("Stale", 20), tab("Older", 40)]);
    const { tidy, archive } = tidyOver(host);
    const summary = await tidy.run("work", "manual");
    expect(host.titles()).toEqual(["Fresh"]);
    expect(summary).toMatchObject({ archivedTabs: 2, newGroups: 0, usedModel: false, firstRun: true });
    expect(archive.list("work").map((entry) => (entry.kind === "tab" ? entry.tab.title : entry.group.title)).sort()).toEqual(["Older", "Stale"]);
  });

  it("groups what the model relates, files all-idle groups together, and never takes the tab in view", async () => {
    const host = new FakeHost([tab("Flights", 1), tab("Hotels", 20), tab("Desk A", 30), tab("Desk B", 30), tab("Reading", 50, { visible: true })]);
    const { tidy, archive } = tidyOver(host, {
      answer: () => ({
        groups: [
          { title: "Lisbon trip", tabIds: ["flights", "hotels"] },
          { title: "Desk research", tabIds: ["desk-a", "desk-b"] },
        ],
        joins: [],
        archive: ["reading"],
      }),
    });
    const summary = await tidy.run("work", "manual");
    expect(summary).toMatchObject({ archivedTabs: 2, newGroups: 1, usedModel: true });
    expect(host.titles()).toEqual(["Flights", "Hotels", "Reading"]);
    expect(host.groups.map((group) => [group.title, group.origin, group.tabIds])).toEqual([["Lisbon trip", "auto", ["flights", "hotels"]]]);
    const [entry] = archive.list("work");
    expect(entry).toMatchObject({ kind: "group", group: { title: "Desk research" } });
  });

  it("does not ask the model when grouping is off", async () => {
    const host = new FakeHost([tab("A", 1), tab("B", 1)]);
    const { tidy, asked } = tidyOver(host, { settings: { groupRelated: false } });
    await tidy.run("work", "manual");
    expect(asked).toEqual([]);
  });

  it("plans against the tabs as they are AFTER the model answered", async () => {
    const host = new FakeHost([tab("Clicked", 20), tab("Stale", 20)]);
    const clicked = host.row[0]!;
    const { tidy } = tidyOver(host, {
      answer: () => {
        clicked.lastActiveAt = NOW; // the person went back to it while the model was thinking
        return { groups: [], joins: [], archive: ["clicked", "stale"] };
      },
    });
    await tidy.run("work", "manual");
    expect(host.titles()).toEqual(["Clicked"]);
  });

  it("undo puts everything back where it was", async () => {
    const host = new FakeHost([tab("One", 1), tab("Old A", 20), tab("Two", 1), tab("Old B", 30), tab("Three", 1)]);
    host.groups.push({ id: "made", title: "Made", color: "amber", tabIds: ["one"], origin: "manual", open: false, createdAt: 0 });
    host.favorites.push({ tabId: "fav", anchorId: "fav-x", url: "https://x.com/someone/status/1" });
    const { tidy, archive } = tidyOver(host, {
      answer: () => ({ groups: [{ title: "Pair", tabIds: ["two", "three"] }], joins: [], archive: [] }),
    });
    const summary = await tidy.run("work", "manual");
    expect(summary).toMatchObject({ archivedTabs: 2, newGroups: 1, favoritesReset: 1 });
    expect(host.favorites[0]?.url).toBe("https://x.com/");
    expect(tidy.status().canUndo).toBe(true);

    expect(tidy.undo()).toBe(true);
    expect(host.titles()).toEqual(["One", "Old A", "Two", "Old B", "Three"]);
    expect(host.groups.map((group) => group.title)).toEqual(["Made"]);
    expect(host.favorites[0]?.url).toBe("https://x.com/someone/status/1");
    expect(archive.list("work")).toEqual([]);
    expect(tidy.undo()).toBe(false);
  });

  it("undo scatters grouped and joined tabs back to where they were, not just out of their groups", async () => {
    // A · B · C · D · E — grouping A with C, and joining E to the group B is in, moves C and E up the row.
    const host = new FakeHost([tab("A", 1), tab("B", 1), tab("C", 1), tab("D", 1), tab("E", 1)]);
    host.groups.push({ id: "mine", title: "Mine", color: "red", tabIds: ["b"], origin: "manual", open: false, createdAt: 0 });
    const { tidy } = tidyOver(host, {
      answer: () => ({ groups: [{ title: "Pair", tabIds: ["a", "c"] }], joins: [{ groupId: "mine", tabIds: ["e"] }], archive: [] }),
    });
    await tidy.run("work", "manual");
    expect(host.titles()).toEqual(["A", "C", "B", "E", "D"]);
    tidy.undo();
    expect(host.titles()).toEqual(["A", "B", "C", "D", "E"]);
    expect(host.groups.map((group) => [group.title, group.tabIds])).toEqual([["Mine", ["b"]]]);
  });

  it("undo leaves a tab opened since the run where it is, after the ones it puts back", async () => {
    const host = new FakeHost([tab("A", 1), tab("Old", 20), tab("B", 1)]);
    const { tidy } = tidyOver(host);
    await tidy.run("work", "manual");
    host.row.push(tab("Since", 0));
    tidy.undo();
    expect(host.titles()).toEqual(["A", "Old", "B", "Since"]);
  });

  it("undo does not reopen what the person already restored or removed from the archive", async () => {
    const host = new FakeHost([tab("Keep", 1), tab("Old A", 20), tab("Old B", 30), tab("Old C", 40), tab("Desk A", 50), tab("Desk B", 50)]);
    const { tidy, archive } = tidyOver(host, {
      answer: () => ({ groups: [{ title: "Desk research", tabIds: ["desk-a", "desk-b"] }], joins: [], archive: [] }),
    });
    await tidy.run("work", "manual");
    expect(host.titles()).toEqual(["Keep"]);
    const entries = archive.list("work");
    const entryFor = (title: string): string => entries.find((entry) => entry.kind === "tab" && entry.tab.title === title)?.id ?? "";
    // Through the archive page: one restored (it is a tab again), one removed for good, one tab taken out of the group entry.
    const restored = archive.remove(entryFor("Old A"));
    if (restored?.kind === "tab") host.restoreArchivedTabs("work", [restored.tab]);
    archive.remove(entryFor("Old B"));
    const deskEntry = entries.find((entry) => entry.kind === "group");
    const deskA = archive.removeGroupTab(deskEntry?.id ?? "", 0);
    if (deskA !== null) host.restoreArchivedTabs("work", [deskA]);
    expect(host.titles()).toEqual(["Keep", "Old A", "Desk A"]);

    expect(tidy.undo()).toBe(true);
    // Only what was still in the archive comes back: no second Old A or Desk A, and no Old B at all.
    expect(host.titles().sort()).toEqual(["Desk A", "Desk B", "Keep", "Old A", "Old C"]);
    expect(archive.list("work")).toEqual([]);
  });

  it("archives an auto group once every tab in it is idle, and undo re-forms it", async () => {
    const host = new FakeHost([tab("Trip A", 20), tab("Trip B", 30), tab("Mine A", 20), tab("Mine B", 20)]);
    host.groups.push(
      { id: "auto", title: "Trip", color: "green", tabIds: ["trip-a", "trip-b"], origin: "auto", open: false, createdAt: 0 },
      { id: "mine", title: "Mine", color: "red", tabIds: ["mine-a", "mine-b"], origin: "manual", open: false, createdAt: 0 },
    );
    const { tidy, archive } = tidyOver(host);
    await tidy.run("work", "manual");
    expect(host.titles()).toEqual(["Mine A", "Mine B"]);
    expect(archive.list("work")[0]).toMatchObject({ kind: "group", group: { title: "Trip", color: "green" } });
    tidy.undo();
    expect(host.titles()).toEqual(["Trip A", "Trip B", "Mine A", "Mine B"]);
    expect(host.groups.map((group) => group.title).sort()).toEqual(["Mine", "Trip"]);
  });

  it("the sweep runs a due Space once, says so, and then keeps its distance", async () => {
    const clock = { now: NOW };
    const host = new FakeHost([tab("Fresh", 1), tab("Stale", 20)]);
    const { tidy, announced } = tidyOver(host, { clock });
    await tidy.sweep();
    expect(announced).toHaveLength(1);
    expect(announced[0]).toMatchObject({ trigger: "auto", archivedTabs: 1 });
    host.row.push(tab("Another stale", 20));
    clock.now += 10 * 60 * 1000;
    await tidy.sweep();
    expect(host.titles()).toContain("Another stale");
    clock.now += 30 * 60 * 1000;
    await tidy.sweep();
    expect(host.titles()).not.toContain("Another stale");
  });

  it("never runs on its own when archiving is set to Never, but still runs when asked", async () => {
    const host = new FakeHost([tab("A", 100), tab("B", 100)]);
    const { tidy, announced } = tidyOver(host, {
      settings: { archiveAfterHours: 0 },
      answer: () => ({ groups: [{ title: "Pair", tabIds: ["a", "b"] }], joins: [], archive: ["a"] }),
    });
    await tidy.sweep();
    expect(announced).toEqual([]);
    const summary = await tidy.run("work", "manual");
    expect(summary).toMatchObject({ archivedTabs: 0, newGroups: 1 });
    expect(host.titles()).toEqual(["A", "B"]);
  });
});

describe("scriptedTidyJudge", () => {
  it("is for specs only, and names tabs by their titles", async () => {
    const script = JSON.stringify({ groups: [{ title: "Trip", titles: ["Flights", "Hotels"] }], archive: ["Old"] });
    expect(scriptedTidyJudge({ PISTACHIO_TIDY_SCRIPT: script })).toBeNull();
    const judge = scriptedTidyJudge({ PISTACHIO_E2E: "1", PISTACHIO_TIDY_SCRIPT: script });
    const answer = await judge?.({
      now: NOW,
      groups: [],
      tabs: [
        { id: "1", title: "Flights to Lisbon", url: "https://a.example/", lastActiveAt: NOW, eligible: false },
        { id: "2", title: "Hotels in Lisbon", url: "https://b.example/", lastActiveAt: NOW, eligible: false },
        { id: "3", title: "Old news", url: "https://c.example/", lastActiveAt: 0, eligible: true },
      ],
    });
    expect(answer).toEqual({ groups: [{ title: "Trip", tabIds: ["1", "2"] }], joins: [], archive: ["3"] });
  });
});
