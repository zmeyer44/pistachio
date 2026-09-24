/**
 * Tidy's contract (docs/tab-tidy.md §4): what a host tells the model about a
 * Space's tabs, what the model may answer, and the PURE POLICY that turns an
 * answer — or no answer — into the plan a host applies.
 *
 * The model proposes; this file disposes. It can only sort tabs the host
 * sent into outcomes the host allows: it cannot archive a tab that is not
 * idle, cannot name a tab or group it was not shown, and cannot leave an
 * idle tab alone — for an idle tab the choice is "group or archive". Tab
 * titles are untrusted page text, so the worst a manipulated answer can do
 * is put tabs in an oddly named group, which one Undo takes back.
 *
 * Imports nothing from the AI SDK, so a page that reads these shapes drags
 * no model code into the renderer (the shell says them as
 * @pistachio/shell-contracts/tidy).
 */

export const TIDY_LIMITS = {
  /** Loose tabs shown to the model per run, most recently used first. */
  maxTabs: 80,
  /** Existing groups shown to the model. */
  maxGroups: 24,
  /** New groups one run may make. */
  maxNewGroups: 8,
  minGroupSize: 2,
  maxTitle: 40,
  timeoutMs: 12_000,
  /** Naming ONE group a person just made: they are looking at it, so it answers fast or not at all. */
  nameTimeoutMs: 6_000,
  /** Tabs of a group shown to the model when it is asked for a name. */
  maxNamedTabs: 24,
  /** Automatic runs for one Space are at least this far apart. */
  minIntervalMs: 30 * 60 * 1000,
} as const;

export const ARCHIVE_AFTER_HOURS = [12, 24, 168, 720] as const;
export type ArchiveAfterHours = (typeof ARCHIVE_AFTER_HOURS)[number];
export const DEFAULT_ARCHIVE_AFTER_HOURS: ArchiveAfterHours = 12;

/** Days an archived tab is kept (the archive itself is @pistachio/shell-contracts/tab-archive). */
export const ARCHIVE_RETENTION_DAYS = [7, 30, 90] as const;
export type ArchiveRetentionDays = (typeof ARCHIVE_RETENTION_DAYS)[number];
export const DEFAULT_ARCHIVE_RETENTION_DAYS: ArchiveRetentionDays = 30;

/** A loose tab: a human day tab in no group, not visible, not audible, not a run's. */
export interface TidyTabCandidate {
  id: string;
  title: string;
  url: string;
  lastActiveAt: number;
  /** Idle past the threshold: it will be archived unless it is grouped with a tab that is not. */
  eligible: boolean;
}

export interface TidyGroupCandidate {
  id: string;
  title: string;
  tabCount: number;
}

export interface TidyInput {
  now: number;
  tabs: TidyTabCandidate[];
  groups: TidyGroupCandidate[];
}

/** What the model answers, already mapped back to the host's own ids. */
export interface TidyAnswer {
  groups: Array<{ title: string; tabIds: string[] }>;
  joins: Array<{ groupId: string; tabIds: string[] }>;
  archive: string[];
}

export interface TidyPlan {
  /** Closed and filed one by one. */
  archiveTabs: string[];
  /** Closed and filed TOGETHER under a title: related tabs that had all gone idle. */
  archiveGroups: Array<{ title: string; tabIds: string[] }>;
  newGroups: Array<{ title: string; tabIds: string[] }>;
  joins: Array<{ groupId: string; tabIds: string[] }>;
}

export const EMPTY_TIDY_PLAN: TidyPlan = { archiveTabs: [], archiveGroups: [], newGroups: [], joins: [] };

export function isEmptyTidyPlan(plan: TidyPlan): boolean {
  return plan.archiveTabs.length === 0 && plan.archiveGroups.length === 0 && plan.newGroups.length === 0 && plan.joins.length === 0;
}

function cleanTitle(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/gu, " ").trim().slice(0, TIDY_LIMITS.maxTitle).trim();
}

/**
 * The plan for an answer. With `answer` null — signed out, a timeout,
 * grouping switched off — it is Arc's rule alone: every idle tab is archived
 * and nothing is grouped.
 */
export function tidyPlan(input: TidyInput, answer: TidyAnswer | null): TidyPlan {
  const tabs = new Map(input.tabs.map((tab) => [tab.id, tab]));
  const groupIds = new Set(input.groups.map((group) => group.id));
  const taken = new Set<string>();
  /** The ids of `ids` that are real, unclaimed tabs — claimed as they are read, so a tab gets ONE outcome. */
  const claim = (ids: unknown): string[] => {
    if (!Array.isArray(ids)) return [];
    const claimed: string[] = [];
    for (const id of ids) {
      if (typeof id !== "string" || !tabs.has(id) || taken.has(id)) continue;
      taken.add(id);
      claimed.push(id);
    }
    return claimed;
  };

  const plan: TidyPlan = { archiveTabs: [], archiveGroups: [], newGroups: [], joins: [] };
  if (answer !== null) {
    // Joins first: a tab that belongs with work a person already gathered goes there.
    const joined = new Map<string, string[]>();
    for (const join of Array.isArray(answer.joins) ? answer.joins : []) {
      if (typeof join !== "object" || join === null || !groupIds.has(join.groupId)) continue;
      const tabIds = claim(join.tabIds);
      if (tabIds.length === 0) continue;
      joined.set(join.groupId, [...(joined.get(join.groupId) ?? []), ...tabIds]);
    }
    for (const [groupId, tabIds] of joined) plan.joins.push({ groupId, tabIds });

    const usedTitles = new Set(input.groups.map((group) => group.title.toLowerCase()));
    for (const group of Array.isArray(answer.groups) ? answer.groups : []) {
      if (typeof group !== "object" || group === null) continue;
      const title = cleanTitle(group.title);
      if (title === "" || usedTitles.has(title.toLowerCase())) continue;
      // Size is judged BEFORE claiming, so a group that is too small does not
      // swallow its one tab's other chances.
      const wanted = Array.isArray(group.tabIds)
        ? [...new Set(group.tabIds.filter((id): id is string => typeof id === "string" && tabs.has(id) && !taken.has(id)))]
        : [];
      if (wanted.length < TIDY_LIMITS.minGroupSize) continue;
      const allIdle = wanted.every((id) => tabs.get(id)?.eligible === true);
      if (!allIdle && plan.newGroups.length >= TIDY_LIMITS.maxNewGroups) continue;
      const tabIds = claim(wanted);
      usedTitles.add(title.toLowerCase());
      // Related tabs that have ALL gone idle leave together, under their
      // title: grouping must not be how stale tabs live forever.
      if (allIdle) plan.archiveGroups.push({ title, tabIds });
      else plan.newGroups.push({ title, tabIds });
    }
  }
  // Every idle tab left over is archived — named by the model or not.
  for (const tab of input.tabs) {
    if (!tab.eligible || taken.has(tab.id)) continue;
    taken.add(tab.id);
    plan.archiveTabs.push(tab.id);
  }
  return plan;
}

/* ---------------------------- what the model sees ---------------------------- */

export interface TidyModelTab {
  id: string;
  title: string;
  site: string;
  path: string;
  idleHours: number;
  idle: boolean;
}

export interface TidyModelState {
  tabs: TidyModelTab[];
  groups: Array<{ id: string; title: string; tabCount: number }>;
}

/**
 * The state sent to the model, with ids anonymised (`t0`, `g0`) and every
 * address cut to host and path: query strings and fragments carry tokens,
 * searches and session ids that grouping has no use for.
 */
export function tidyModelState(input: TidyInput): {
  state: TidyModelState;
  tabIds: Map<string, string>;
  groupIds: Map<string, string>;
} {
  const tabIds = new Map<string, string>();
  const groupIds = new Map<string, string>();
  const tabs = [...input.tabs]
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .slice(0, TIDY_LIMITS.maxTabs)
    .map((tab, index): TidyModelTab => {
      const id = `t${index}`;
      tabIds.set(id, tab.id);
      const { title, site, path } = tidyTabDescription(tab);
      return {
        id,
        title,
        site,
        path,
        idleHours: Math.max(0, Math.round((input.now - tab.lastActiveAt) / 3_600_000)),
        idle: tab.eligible,
      };
    });
  const groups = input.groups.slice(0, TIDY_LIMITS.maxGroups).map((group, index) => {
    const id = `g${index}`;
    groupIds.set(id, group.id);
    return { id, title: group.title.slice(0, TIDY_LIMITS.maxTitle), tabCount: group.tabCount };
  });
  return { state: { tabs, groups }, tabIds, groupIds };
}

/** One tab as the model sees it: its title, and its address cut to host and path. */
export function tidyTabDescription(tab: { title: string; url: string }): { title: string; site: string; path: string } {
  let site = "";
  let path = "";
  try {
    const url = new URL(tab.url);
    site = url.hostname.replace(/^www\./u, "");
    path = url.pathname.slice(0, 120);
  } catch {
    // An address that does not parse tells the model nothing; the title still does.
  }
  return { title: tab.title.slice(0, 160), site, path };
}

/**
 * A name the model gave a group, made fit to show: one line, bounded, no
 * quotes or trailing punctuation — or null when there is nothing left, or
 * when it only said what the placeholder says.
 */
export function tidyGroupName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = cleanTitle(value.replace(/^["'“”‘’\s]+|["'“”‘’\s.,;:!]+$/gu, ""));
  return name === "" || /^(new|untitled|tab) group$/iu.test(name) || /^group$/iu.test(name) ? null : name;
}

/** The model's raw answer (anonymised ids) mapped back to the host's ids; unknown ids fall away. */
export function tidyAnswerFromModel(
  raw: { groups?: unknown; joins?: unknown; archive?: unknown },
  tabIds: ReadonlyMap<string, string>,
  groupIds: ReadonlyMap<string, string>,
): TidyAnswer {
  const mapTabs = (ids: unknown): string[] =>
    Array.isArray(ids) ? ids.flatMap((id) => (typeof id === "string" && tabIds.has(id) ? [tabIds.get(id)!] : [])) : [];
  const record = (value: unknown): Record<string, unknown> | null =>
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  return {
    groups: (Array.isArray(raw.groups) ? raw.groups : []).flatMap((candidate: unknown) => {
      const group = record(candidate);
      return group === null || typeof group["title"] !== "string" ? [] : [{ title: group["title"], tabIds: mapTabs(group["tabIds"]) }];
    }),
    joins: (Array.isArray(raw.joins) ? raw.joins : []).flatMap((candidate: unknown) => {
      const join = record(candidate);
      const groupId = join !== null && typeof join["groupId"] === "string" ? groupIds.get(join["groupId"]) : undefined;
      return join === null || groupId === undefined ? [] : [{ groupId, tabIds: mapTabs(join["tabIds"]) }];
    }),
    archive: mapTabs(raw.archive),
  };
}

/* ------------------------------ the host's word ------------------------------ */

export type TidyTrigger = "auto" | "manual";

/** What a run did, for the one notice that says so. */
export interface TidySummary {
  runId: string;
  spaceId: string;
  trigger: TidyTrigger;
  /** Tabs archived, counting those inside archived groups. */
  archivedTabs: number;
  newGroups: number;
  /** Tabs added to groups that already existed. */
  joinedTabs: number;
  favoritesReset: number;
  /** False when the run fell back to the clock alone. */
  usedModel: boolean;
  /** The first run this profile has seen: the notice explains the feature. */
  firstRun: boolean;
}

export function tidyDidSomething(summary: TidySummary): boolean {
  return summary.archivedTabs + summary.newGroups + summary.joinedTabs + summary.favoritesReset > 0;
}

/** The notice's words (docs/tab-tidy.md §3.1). */
export function tidySummaryText(summary: TidySummary): string {
  const parts: string[] = [];
  const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
  if (summary.archivedTabs > 0) parts.push(`archived ${count(summary.archivedTabs, "tab", "tabs")}`);
  if (summary.newGroups > 0) parts.push(`made ${count(summary.newGroups, "group", "groups")}`);
  if (summary.joinedTabs > 0) parts.push(`grouped ${count(summary.joinedTabs, "tab", "tabs")}`);
  if (summary.favoritesReset > 0 && parts.length === 0) parts.push(`reset ${count(summary.favoritesReset, "favorite", "favorites")}`);
  if (parts.length === 0) return "Tabs are already tidy";
  const said = parts.join(" · ");
  return `${said.charAt(0).toUpperCase()}${said.slice(1)}`;
}

export type TidyRequest =
  /** Run now for a Space (the active one when absent). */
  | { type: "run"; spaceId?: string }
  /** Take back the last run. */
  | { type: "undo" }
  | { type: "status" };

export type TidyResponse =
  | { type: "ran"; summary: TidySummary }
  | { type: "undone"; ok: boolean }
  | { type: "status"; running: boolean; canUndo: boolean; last: TidySummary | null };

export function isTidyRequest(value: unknown): value is TidyRequest {
  if (typeof value !== "object" || value === null) return false;
  const raw = value as Record<string, unknown>;
  if (raw["type"] === "undo" || raw["type"] === "status") return true;
  return raw["type"] === "run" && (raw["spaceId"] === undefined || (typeof raw["spaceId"] === "string" && raw["spaceId"].length <= 128));
}
