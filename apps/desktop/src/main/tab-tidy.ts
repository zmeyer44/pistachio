/**
 * Tidy (docs/tab-tidy.md): the pass that archives a Space's idle tabs,
 * gathers related ones into tab groups, and sends favorites home — on the
 * tab lifecycle's clock, or when asked.
 *
 * This file is the run and its Undo. It owns no tabs: everything it does to
 * them goes through `TidyHost`, the slice of BrowserController it needs,
 * which is also what lets the tests drive it against a fake. What the model
 * may mean is decided by the pure policy (@pistachio/shell-contracts/tidy);
 * what is safe to touch is decided again by the host as each step lands —
 * the person may have clicked a tab while the model was thinking.
 */

import { randomUUID } from "node:crypto";
import type { ArchivedTab } from "@pistachio/shell-contracts/tab-archive";
import type { TabGroupColor, TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import {
  TIDY_LIMITS,
  tidyPlan,
  type TidyAnswer,
  type TidyGroupCandidate,
  type TidyInput,
  type TidySummary,
  type TidyTabCandidate,
  type TidyTrigger,
} from "@pistachio/shell-contracts/tidy";
import type { ArchiveDraft, TabArchiveStore } from "./tab-archive-store";

const SWEEP_MS = 60 * 1000;
/** On its own clock Tidy leaves a favorite alone until it has been out of view this long. */
const FAVORITE_SETTLE_MS = 15 * 60 * 1000;

export interface TidyCandidates {
  tabs: TidyTabCandidate[];
  groups: TidyGroupCandidate[];
  idleAutoGroupIds: string[];
  staleHomeTabIds: string[];
}

/** What Tidy needs of the tabs' owner. `R` is the host's own record of a favorite it re-addressed. */
export interface TidyHost<R> {
  tidyCandidates(spaceId: string, now: number, idleMs: number): TidyCandidates;
  tabGroups(spaceId: string): TabGroupInfo[];
  archiveTabs(tabIds: readonly string[]): Array<{ tabId: string; index: number; tab: ArchivedTab }>;
  restoreArchivedTabs(spaceId: string, tabs: readonly ArchivedTab[], indexes?: readonly number[]): string[];
  createTabGroup(options: { title?: string; color?: TabGroupColor; tabIds: readonly string[]; origin: TabGroupInfo["origin"] }): TabGroupInfo | null;
  addToTabGroup(groupId: string, tabIds: readonly string[], options: { byPerson: boolean }): string[];
  removeFromTabGroups(tabIds: readonly string[]): void;
  dissolveTabGroups(groupIds: readonly string[]): void;
  resetFavoriteTabs(
    spaceId: string,
    homeOf: (anchorId: string) => { url: string; title: string } | null,
    now: number,
    minIdleMs: number,
  ): Promise<R[]>;
  restoreFavoriteTabs(previous: readonly R[]): void;
  /** A Space's tabs in row order. */
  tabOrderOf(spaceId: string): string[];
  /** Put a Space's tabs back in a recorded order; tabs it does not name follow, ids that are gone are skipped. */
  restoreTabOrder(spaceId: string, order: readonly string[]): void;
  commitTidy(): void;
}

export interface TidySettings {
  archiveAfterHours: number;
  groupRelated: boolean;
  resetFavorites: boolean;
}

export interface TabTidyOptions<R> {
  host: TidyHost<R>;
  archive: TabArchiveStore;
  settings: () => TidySettings;
  spaceIds: () => string[];
  activeSpaceId: () => string;
  /** A favorite's (or organization preset's) own address; null for a pin or anything else. */
  favoriteHome: (spaceId: string, anchorId: string) => { url: string; title: string } | null;
  /** The model's reading, or null — signed out, switched off, timed out. Never throws. */
  judge: (input: TidyInput) => Promise<TidyAnswer | null>;
  /** A run on Tidy's own clock did something worth saying. */
  announce: (summary: TidySummary) => void;
  now?: () => number;
}

/** What one run did, kept until the next so it can be taken back. */
interface UndoRecord<R> {
  runId: string;
  spaceId: string;
  /**
   * The Space's row as the run found it. Archiving takes tabs out of it and
   * grouping GATHERS tabs within it — a group sits where its first tab does —
   * and neither reopening a tab nor dissolving a group puts anything back in
   * its place. The whole order does, in one step.
   */
  order: string[];
  /** What the run closed, by the id each tab had. */
  archived: Array<{ tabId: string; tab: ArchivedTab; group: number | null }>;
  /** Live groups the run archived whole, to be formed again. */
  groups: Array<{ title: string; color: TabGroupColor; origin: TabGroupInfo["origin"] }>;
  createdGroupIds: string[];
  joinedTabIds: string[];
  favorites: R[];
}

export class TabTidy<R> {
  readonly #options: TabTidyOptions<R>;
  readonly #now: () => number;
  readonly #lastRunAt = new Map<string, number>();
  #timer: NodeJS.Timeout | null = null;
  #running = false;
  #undo: UndoRecord<R> | null = null;
  #last: TidySummary | null = null;

  constructor(options: TabTidyOptions<R>) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => void this.sweep(), SWEEP_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  status(): { running: boolean; canUndo: boolean; last: TidySummary | null } {
    return { running: this.#running, canUndo: this.#undo !== null, last: this.#last };
  }

  /** The clock's question, asked every minute and whenever the Mac wakes: is any Space due? */
  async sweep(): Promise<void> {
    const idleMs = this.#idleMs();
    if (idleMs <= 0 || this.#running) return;
    for (const spaceId of this.#options.spaceIds()) {
      const now = this.#now();
      if (now - (this.#lastRunAt.get(spaceId) ?? 0) < TIDY_LIMITS.minIntervalMs) continue;
      const found = this.#options.host.tidyCandidates(spaceId, now, idleMs);
      const due = found.tabs.some((tab) => tab.eligible) || found.idleAutoGroupIds.length > 0 || found.staleHomeTabIds.length > 0;
      if (due) {
        const summary = await this.run(spaceId, "auto");
        if (summary.archivedTabs + summary.newGroups + summary.joinedTabs > 0) this.#options.announce(summary);
      } else if (this.#options.settings().resetFavorites) {
        // Nothing to archive, but a favorite left on a deep page all day
        // still goes home — quietly: it is asleep, and Back returns to it.
        const reset = await this.#options.host.resetFavoriteTabs(spaceId, (anchorId) => this.#options.favoriteHome(spaceId, anchorId), now, idleMs);
        if (reset.length > 0) this.#options.host.commitTidy();
      }
    }
  }

  async run(spaceId: string, trigger: TidyTrigger): Promise<TidySummary> {
    const runId = randomUUID();
    const summary: TidySummary = {
      runId,
      spaceId,
      trigger,
      archivedTabs: 0,
      newGroups: 0,
      joinedTabs: 0,
      favoritesReset: 0,
      usedModel: false,
      firstRun: false,
    };
    if (this.#running) return summary;
    this.#running = true;
    try {
      const { host, archive } = this.#options;
      const settings = this.#options.settings();
      const idleMs = this.#idleMs();
      const before = host.tidyCandidates(spaceId, this.#now(), idleMs);
      const worthAsking = before.tabs.length >= 2 || (before.tabs.length === 1 && before.groups.length > 0);
      const answer = settings.groupRelated && worthAsking ? await this.#options.judge({ now: this.#now(), tabs: before.tabs, groups: before.groups }) : null;
      summary.usedModel = answer !== null;

      // The model took its time; the person did not wait for it. The plan is
      // made against the tabs as they are NOW, so a tab that was clicked, a
      // group that was closed, simply fall out of it.
      const now = this.#now();
      const found = host.tidyCandidates(spaceId, now, idleMs);
      const plan = tidyPlan({ now, tabs: found.tabs, groups: found.groups }, answer);

      const undo: UndoRecord<R> = { runId, spaceId, order: host.tabOrderOf(spaceId), archived: [], groups: [], createdGroupIds: [], joinedTabIds: [], favorites: [] };
      const drafts: ArchiveDraft[] = [];
      const wasEmpty = archive.isEmpty();

      for (const closed of host.archiveTabs(plan.archiveTabs)) {
        undo.archived.push({ tabId: closed.tabId, tab: closed.tab, group: null });
        drafts.push({ kind: "tab", spaceId, reason: "idle", runId, tab: closed.tab });
      }
      const fileTogether = (title: string, color: TabGroupColor, origin: TabGroupInfo["origin"], tabIds: readonly string[], regroup: number | null): void => {
        const closed = host.archiveTabs(tabIds);
        for (const tab of closed) undo.archived.push({ tabId: tab.tabId, tab: tab.tab, group: regroup });
        const tabs = closed.map((tab) => tab.tab);
        if (tabs.length === 1) drafts.push({ kind: "tab", spaceId, reason: "idle", runId, tab: tabs[0]! });
        else if (tabs.length > 1) drafts.push({ kind: "group", spaceId, reason: "idle", runId, group: { title, color, origin }, tabs });
      };
      for (const group of plan.archiveGroups) fileTogether(group.title, "gray", "auto", group.tabIds, null);
      const live = new Map(host.tabGroups(spaceId).map((group) => [group.id, group]));
      for (const groupId of found.idleAutoGroupIds) {
        const group = live.get(groupId);
        if (group === undefined) continue;
        undo.groups.push({ title: group.title, color: group.color, origin: group.origin });
        fileTogether(group.title, group.color, group.origin, group.tabIds, undo.groups.length - 1);
      }
      // A blank page nobody came back to is closed, not kept.
      host.archiveTabs(found.staleHomeTabIds);

      for (const wanted of plan.newGroups) {
        const group = host.createTabGroup({ title: wanted.title, tabIds: wanted.tabIds, origin: "auto" });
        if (group !== null) undo.createdGroupIds.push(group.id);
      }
      for (const join of plan.joins) undo.joinedTabIds.push(...host.addToTabGroup(join.groupId, join.tabIds, { byPerson: false }));
      if (settings.resetFavorites) {
        undo.favorites = await host.resetFavoriteTabs(
          spaceId,
          (anchorId) => this.#options.favoriteHome(spaceId, anchorId),
          now,
          trigger === "manual" ? 0 : FAVORITE_SETTLE_MS,
        );
      }

      host.commitTidy();
      archive.add(drafts);

      summary.archivedTabs = undo.archived.length;
      summary.newGroups = undo.createdGroupIds.length;
      summary.joinedTabs = undo.joinedTabIds.length;
      summary.favoritesReset = undo.favorites.length;
      summary.firstRun = wasEmpty && summary.archivedTabs > 0;
      const didSomething = summary.archivedTabs + summary.newGroups + summary.joinedTabs + summary.favoritesReset > 0;
      if (didSomething) this.#undo = undo;
      this.#lastRunAt.set(spaceId, now);
      this.#last = summary;
      return summary;
    } finally {
      this.#running = false;
    }
  }

  /**
   * Take the last run back: reopen what it archived, unmake its groups,
   * return its favorites — and put the row back in the order it was in.
   *
   * Only what is STILL in the archive is reopened. Between the run and its
   * Undo the person may have restored a tab from the archive page (it is a
   * tab again: a second copy would be a duplicate) or removed one for good
   * (it is not Undo's to bring back).
   */
  undo(): boolean {
    const undo = this.#undo;
    if (undo === null || this.#running) return false;
    this.#undo = null;
    const { host, archive } = this.#options;

    // What the run filed and nobody has taken out since, as a multiset: two
    // tabs of one run can be the same page.
    const remaining = new Map<string, number>();
    for (const entry of archive.takeRun(undo.runId)) {
      for (const tab of entry.kind === "tab" ? [entry.tab] : entry.tabs) remaining.set(archivedTabKey(tab), (remaining.get(archivedTabKey(tab)) ?? 0) + 1);
    }

    // Groups first, so nothing gathers the row again while it is being put back.
    host.dissolveTabGroups(undo.createdGroupIds);
    host.removeFromTabGroups(undo.joinedTabIds);

    const reopenedAs = new Map<string, string>();
    const regrouped = new Map<number, string[]>();
    for (const closed of undo.archived) {
      const key = archivedTabKey(closed.tab);
      const left = remaining.get(key) ?? 0;
      if (left === 0) continue;
      remaining.set(key, left - 1);
      const [tabId] = host.restoreArchivedTabs(undo.spaceId, [closed.tab]);
      if (tabId === undefined) continue;
      reopenedAs.set(closed.tabId, tabId);
      if (closed.group !== null) regrouped.set(closed.group, [...(regrouped.get(closed.group) ?? []), tabId]);
    }
    // A reopened tab has a new id; it takes the place its old one had.
    host.restoreTabOrder(undo.spaceId, undo.order.map((tabId) => reopenedAs.get(tabId) ?? tabId));
    for (const [index, tabIds] of regrouped) {
      const group = undo.groups[index];
      // A group of which one tab is left is not a group to make again.
      if (group !== undefined && tabIds.length >= 2) host.createTabGroup({ ...group, tabIds });
    }
    host.restoreFavoriteTabs(undo.favorites);
    host.commitTidy();
    return true;
  }

  #idleMs(): number {
    return Math.max(0, this.#options.settings().archiveAfterHours) * 60 * 60 * 1000;
  }
}

/** An archived tab's identity across the archive file and the undo record, which hold separate copies of it. */
function archivedTabKey(tab: ArchivedTab): string {
  return `${tab.url}\n${tab.title}\n${String(tab.lastActiveAt)}`;
}

/* ------------------------------ scripted judge ------------------------------ */

interface TidyScript {
  groups?: Array<{ title: string; titles: string[] }>;
  joins?: Array<{ group: string; titles: string[] }>;
  archive?: string[];
  /** What the model "names" any group made by hand; `null` plays a model that failed. */
  name?: string | null;
  /** How long the judge "thinks" before answering, so a spec can see a run in flight. */
  delayMs?: number;
}

/**
 * A spec's stand-in for the group namer: the script's `name`, after a beat —
 * long enough for the row's "naming" state to be seen. Null (not scripted)
 * leaves naming to the account's model, which a spec run does not have.
 */
export function scriptedGroupNamer(env: NodeJS.ProcessEnv = process.env): (() => Promise<string | null>) | null {
  if (env["PISTACHIO_E2E"] !== "1") return null;
  try {
    const script = JSON.parse(env["PISTACHIO_TIDY_SCRIPT"]?.trim() || "{}") as TidyScript;
    if (script.name === undefined) return null;
    const name = script.name;
    return () => new Promise((done) => setTimeout(() => done(name), 400));
  } catch {
    return null;
  }
}

/**
 * A spec's stand-in for the model (`PISTACHIO_TIDY_SCRIPT`, under
 * `PISTACHIO_E2E=1` only): tabs are named by a fragment of their TITLE and
 * existing groups by their title, since a spec knows neither's id.
 */
export function scriptedTidyJudge(env: NodeJS.ProcessEnv = process.env): ((input: TidyInput) => Promise<TidyAnswer | null>) | null {
  if (env["PISTACHIO_E2E"] !== "1") return null;
  const raw = env["PISTACHIO_TIDY_SCRIPT"]?.trim() ?? "";
  if (raw === "") return null;
  let script: TidyScript;
  try {
    script = JSON.parse(raw) as TidyScript;
  } catch {
    return null;
  }
  return (input) => {
    const named = (titles: readonly string[] | undefined): string[] =>
      input.tabs.filter((tab) => (titles ?? []).some((title) => tab.title.includes(title) || tab.url.includes(title))).map((tab) => tab.id);
    const answer = {
      groups: (script.groups ?? []).map((group) => ({ title: group.title, tabIds: named(group.titles) })),
      joins: (script.joins ?? []).flatMap((join) => {
        const group = input.groups.find((candidate) => candidate.title === join.group);
        return group === undefined ? [] : [{ groupId: group.id, tabIds: named(join.titles) }];
      }),
      archive: named(script.archive),
    };
    const delay = script.delayMs ?? 0;
    return delay > 0 ? new Promise((done) => setTimeout(() => done(answer), delay)) : Promise.resolve(answer);
  };
}
