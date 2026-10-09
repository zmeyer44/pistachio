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
  /** A favorite's or pin's page: the sidebar entry it is the page of. */
  anchorId?: string;
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
      groups: this.tabGroups().map((group) => ({ id: group.id, title: group.title, tabCount: group.tabIds.length })),
      idleAutoGroupIds: this.tabGroups()
        .filter((group) => group.origin === "auto" && group.tabIds.every((id) => this.row.some((tab) => tab.id === id && idle(tab))))
        .map((group) => group.id),
      staleHomeTabIds: [],
    };
  }

  /** The groups drawn among the day's tabs: not the pages' (TabGroupInfo.anchorId). */
  tabGroups(): TabGroupInfo[] {
    return this.groups.filter((group) => group.anchorId === undefined).map((group) => ({ ...group, tabIds: [...group.tabIds] }));
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

  createTabGroup(options: { id?: string; title?: string; color?: TabGroupInfo["color"]; tabIds: readonly string[]; origin: TabGroupInfo["origin"] }): TabGroupInfo | null {
    const tabIds = options.tabIds.filter((id) => this.row.some((tab) => tab.id === id));
    // (An id taken refuses, as the controller's does: Undo asks again without one.)
    if (tabIds.length === 0 || (options.id !== undefined && this.groups.some((group) => group.id === options.id))) return null;
    const group: TabGroupInfo = { id: options.id ?? `group-${(this.#made += 1)}`, title: options.title ?? "New group", color: options.color ?? "blue", tabIds, origin: options.origin, open: false, createdAt: 0 };
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

  favoriteGroupsDue(_spaceId: string, isFavorite: (anchorId: string) => boolean, now: number, idleMs: number, minIdleMs: number): Array<{ groupId: string; idle: boolean }> {
    return this.groups.flatMap((group) => {
      const members = group.tabIds.flatMap((id) => this.row.find((tab) => tab.id === id) ?? []);
      if (group.anchorId === undefined || members.length < 2 || !isFavorite(group.anchorId)) return [];
      if (members.some((tab) => tab.visible === true || now - tab.lastActiveAt < minIdleMs)) return [];
      return [{ groupId: group.id, idle: idleMs > 0 && members.every((tab) => now - tab.lastActiveAt >= idleMs) }];
    });
  }

  archivePageGroup(groupId: string): { anchorId: string; pageTabId: string; tabs: Array<{ tabId: string; index: number; tab: ArchivedTab }> } | null {
    const group = this.groups.find((candidate) => candidate.id === groupId);
    const page = this.row.find((tab) => group?.anchorId !== undefined && tab.anchorId === group.anchorId);
    if (group?.anchorId === undefined || page === undefined) return null;
    const anchorId = group.anchorId;
    page.anchorId = undefined;
    this.groups = this.groups.filter((candidate) => candidate.id !== groupId);
    this.groups.push({ ...group, anchorId: undefined });
    return { anchorId, pageTabId: page.id, tabs: this.archiveTabs(group.tabIds) };
  }

  bringDownPageGroup(groupId: string): { anchorId: string; pageTabId: string } | null {
    const group = this.groups.find((candidate) => candidate.id === groupId);
    const page = this.row.find((tab) => group?.anchorId !== undefined && tab.anchorId === group.anchorId);
    if (group?.anchorId === undefined || page === undefined) return null;
    const anchorId = group.anchorId;
    page.anchorId = undefined;
    delete group.anchorId;
    // After the day's tabs.
    this.row = [...this.row.filter((tab) => !group.tabIds.includes(tab.id)), ...group.tabIds.flatMap((id) => this.row.find((tab) => tab.id === id) ?? [])];
    return { anchorId, pageTabId: page.id };
  }

  leadGroup(groupId: string, tabId: string, anchorId: string): void {
    const group = this.groups.find((candidate) => candidate.id === groupId);
    const page = this.row.find((tab) => tab.id === tabId);
    if (group === undefined || page === undefined) return;
    group.anchorId = anchorId;
    page.anchorId = anchorId;
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

  it("files an archived space by its id, and Undo makes it again with that id — its Stack and conversation are kept by it", async () => {
    const host = new FakeHost([tab("Trip A", 20), tab("Trip B", 30)]);
    host.groups.push({ id: "trip", title: "Trip", color: "green", tabIds: ["trip-a", "trip-b"], origin: "auto", open: false, createdAt: 0 });
    const { tidy, archive } = tidyOver(host);
    await tidy.run("work", "manual");
    expect(archive.list("work")[0]).toMatchObject({ kind: "group", groupId: "trip" });
    tidy.undo();
    expect(host.groups.map((group) => group.id)).toEqual(["trip"]);
  });

  it("makes a space again with a new id when its own was taken since", async () => {
    const host = new FakeHost([tab("Trip A", 20), tab("Trip B", 30), tab("Other", 1)]);
    host.groups.push({ id: "trip", title: "Trip", color: "green", tabIds: ["trip-a", "trip-b"], origin: "auto", open: false, createdAt: 0 });
    const { tidy } = tidyOver(host);
    await tidy.run("work", "manual");
    host.groups.push({ id: "trip", title: "Someone else", color: "blue", tabIds: ["other"], origin: "manual", open: false, createdAt: 0 });
    tidy.undo();
    expect(host.groups.map((group) => group.title).sort()).toEqual(["Someone else", "Trip"]);
    expect(host.groups.find((group) => group.title === "Trip")?.id).not.toBe("trip");
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

describe("a favorite's group, at the favorites reset", () => {
  /** X's page (a favorite's), with two tabs opened on its desk, after a lone day tab. */
  const withGroup = (idleHours: [number, number, number], extra: Partial<FakeTab> = {}): FakeHost => {
    const host = new FakeHost([tab("Day", 1), tab("X page", idleHours[0], { anchorId: "fav-x", ...extra }), tab("X one", idleHours[1]), tab("X two", idleHours[2])]);
    host.groups.push({ id: "x-group", title: "New group", color: "gray", tabIds: ["x-page", "x-one", "x-two"], origin: "manual", open: false, createdAt: 0, anchorId: "fav-x" });
    return host;
  };
  const page = (host: FakeHost) => host.row.find((candidate) => candidate.id === "x-page");

  it("comes down into the day's tabs as a group like any other, after them, the favorite left closed — and Undo makes it the favorite's again", async () => {
    const host = withGroup([2, 1, 30], {});
    host.row.push(tab("Later", 1));
    const { tidy, announced } = tidyOver(host);
    const summary = await tidy.run("work", "manual");
    expect(summary).toMatchObject({ favoriteGroups: 1, archivedTabs: 0 });
    expect(host.groups.find((group) => group.id === "x-group")?.anchorId).toBeUndefined();
    expect(page(host)?.anchorId).toBeUndefined();
    expect(host.titles()).toEqual(["Day", "Later", "X page", "X one", "X two"]);
    expect(announced).toEqual([]);
    expect(tidy.undo()).toBe(true);
    expect(host.groups.find((group) => group.id === "x-group")?.anchorId).toBe("fav-x");
    expect(page(host)?.anchorId).toBe("fav-x");
    expect(host.titles()).toEqual(["Day", "X page", "X one", "X two", "Later"]);
  });

  it("goes to the archive whole, under the favorite's name, once all of it has gone idle — and Undo brings it back led by its page", async () => {
    const host = withGroup([20, 30, 40]);
    const { tidy, archive } = tidyOver(host);
    const summary = await tidy.run("work", "manual");
    expect(summary).toMatchObject({ archivedTabs: 3, favoriteGroups: 0 });
    expect(host.titles()).toEqual(["Day"]);
    const [entry] = archive.list("work");
    expect(entry?.kind === "group" ? [entry.group.title, entry.tabs.map((archived) => archived.title)] : null).toEqual(["X", ["X page", "X one", "X two"]]);
    // The space's own id, so a Restore from the archive brings it back as itself.
    expect(entry?.kind === "group" ? entry.groupId : null).toBe("x-group");
    expect(tidy.undo()).toBe(true);
    expect(host.titles()).toEqual(["Day", "X page", "X one", "X two"]);
    const back = host.groups.find((group) => group.anchorId === "fav-x");
    expect(back?.id).toBe("x-group");
    expect(back?.tabIds.map((id) => host.row.find((candidate) => candidate.id === id)?.title)).toEqual(["X page", "X one", "X two"]);
    expect(host.row.find((candidate) => candidate.title === "X page")?.anchorId).toBe("fav-x");
  });

  it("is left alone while any of it is in view, by the clock until it has settled, and never for a pin", async () => {
    const shown = withGroup([2, 1, 30], { visible: true });
    expect(await tidyOver(shown).tidy.run("work", "manual")).toMatchObject({ favoriteGroups: 0, archivedTabs: 0 });
    expect(shown.groups[0]?.anchorId).toBe("fav-x");

    // Its own clock waits a quarter of an hour after the last of it was used; asked, it does not wait.
    const recent = withGroup([2, 1, 30]);
    recent.row.find((candidate) => candidate.id === "x-one")!.lastActiveAt = NOW - 5 * 60_000;
    const { tidy } = tidyOver(recent);
    expect(await tidy.run("work", "auto")).toMatchObject({ favoriteGroups: 0 });
    expect(await tidy.run("work", "manual")).toMatchObject({ favoriteGroups: 1 });

    const pinned = withGroup([20, 30, 40], { anchorId: "pin-1" });
    pinned.groups[0]!.anchorId = "pin-1";
    expect(await tidyOver(pinned).tidy.run("work", "manual")).toMatchObject({ favoriteGroups: 0, archivedTabs: 0 });
    expect(pinned.titles()).toEqual(["Day", "X page", "X one", "X two"]);
  });

  it("makes a Space due on Tidy's own clock, which says what it did", async () => {
    const host = withGroup([2, 1, 3]);
    const { tidy, announced } = tidyOver(host);
    await tidy.sweep();
    expect(announced.map((summary) => summary.favoriteGroups)).toEqual([1]);
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
