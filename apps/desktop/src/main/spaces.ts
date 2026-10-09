/**
 * Spaces (docs/spaces.md) — the pure parts of main's rule over them, out of
 * BrowserController so vitest pins them under node: no Electron here, only
 * the contracts. What a person calls a space is the code's tab group
 * (TabGroupInfo); what the code calls a Space (`spaceId`) is their Profile.
 * Comments that could be read either way say "space (tab group)" or
 * "Profile (Space)".
 *
 * Each function here answers one question the controller asks as it keeps
 * its spaces true (#reconcileTabGroups and the paths that pick the space in
 * front): a saved split folded into a space, which space is current when
 * nothing says, which of a space's tabs comes up, where an empty space
 * stands in the row, which tabs need a space, and what Tidy may not touch.
 */

import { randomUUID } from "node:crypto";
import {
  DEFAULT_TAB_GROUP_TITLE,
  MAX_LOOSE_TAB_GROUPS_PER_SPACE,
  MAX_TAB_GROUPS_PER_SPACE,
  dayRowUnits,
  isTabGroupId,
  nextTabGroupColor,
  tabGroupOf,
  tabGroupUnitId,
  type DayRowUnit,
  type TabGroupInfo,
} from "@pistachio/shell-contracts/tab-groups";
import type { DurableSpaceSession } from "@pistachio/shell-contracts/tab-session";

/* ------------------------------ saved splits ----------------------------- */

/**
 * A Profile's (Space's) saved session with its split views folded away
 * (docs/spaces.md §1, "Splits are gone on the desktop"): the desktop shows
 * a space as its desk since 2026-10-09, side by side is a tile, and a split
 * saved by an earlier build is read as what it meant. Per split —
 *
 * - its members already in one saved space (an "open as split view"): the
 *   space stays, the split is dropped;
 * - two or more of its members day tabs in no named space (a loose tab's
 *   counts as none): a space of their own, in pane order, `manual` (the
 *   person made the split), reusing the split's id, titled
 *   DEFAULT_TAB_GROUP_TITLE and coloured beside the others — main names it
 *   once restored, as it names any space made by hand; their loose spaces
 *   go, since a tab is in one space — but one that is the person's (`keep`:
 *   a Stack with something in it, a bound conversation — the facts
 *   isPersonsGroup reads) stays, EMPTY and drawn, with its own id, so its
 *   Stack and conversation are still reachable (the reconcile's keep rule
 *   holds it), standing where its tab was: before the new space — while
 *   there is room for another drawn space (keepWithRoom) (until 2026-10-09
 *   its id went, and they were orphaned);
 * - otherwise (a pin and one tab, one survivor, no room for another drawn
 *   space): the split is simply dropped.
 *
 * Nothing is lost but the split itself. Idempotent — what comes out has no
 * splits — so it runs on every read of a session (main's restore at launch,
 * a restore point pulled from another device) with no marker; main writes
 * `splitGroups: []` from then on.
 */
export function foldSplitGroups(
  space: DurableSpaceSession,
  options: { now?: number; newId?: () => string; keep?: (groupId: string) => boolean } = {},
): DurableSpaceSession {
  if (space.splitGroups.length === 0) return space;
  const now = options.now ?? Date.now();
  const present = new Set(space.tabs.map((tab) => tab.id));
  const dayTabs = new Set(space.tabs.filter((tab) => tab.anchorId === null).map((tab) => tab.id));
  let groups: TabGroupInfo[] = (space.tabGroups ?? []).map((group) => ({ ...group, tabIds: [...group.tabIds] }));
  for (const split of space.splitGroups) {
    const members = split.tabIds.filter((tabId) => present.has(tabId));
    const holders = new Set(members.map((tabId) => tabGroupOf(groups, tabId)?.id ?? null));
    if (members.length > 0 && holders.size === 1 && !holders.has(null)) continue;
    const free = members.filter((tabId) => {
      const group = tabGroupOf(groups, tabId);
      return dayTabs.has(tabId) && (group === null || group.loose === true);
    });
    if (free.length < 2) continue;
    const drawn = groups.filter((group) => group.loose !== true && group.anchorId === undefined);
    if (drawn.length >= MAX_TAB_GROUPS_PER_SPACE) continue;
    const id = isTabGroupId(split.id) && !groups.some((group) => group.id === split.id) ? split.id : (options.newId ?? randomUUID)();
    const taken = new Set(free);
    const sources = groups.filter((group) => group.loose === true && group.tabIds.some((tabId) => taken.has(tabId)));
    groups = groups.filter((group) => !sources.includes(group));
    const made: TabGroupInfo = { id, title: DEFAULT_TAB_GROUP_TITLE, color: nextTabGroupColor(drawn), tabIds: free, origin: "manual", open: false, createdAt: now };
    groups.push(made);
    // (Only while there is room for another drawn space: past the bound a save would drop it — keepWithRoom.)
    for (const source of sources) {
      if (options.keep?.(source.id) !== true) continue;
      const others = groups.filter((group) => group.loose !== true && group.anchorId === undefined);
      if (others.length >= MAX_TAB_GROUPS_PER_SPACE) continue;
      const { loose: _loose, beforeUnit: _beforeUnit, ...rest } = source;
      groups.push({ ...rest, tabIds: [], color: nextTabGroupColor(others), beforeUnit: tabGroupUnitId(id) });
    }
  }
  const { tabGroups: _tabGroups, ...rest } = space;
  return { ...rest, splitGroups: [], ...(groups.length > 0 ? { tabGroups: groups } : {}) };
}

/* ---------------------------- the current space -------------------------- */

/**
 * Which space (tab group) is current in a Profile when nothing has made
 * one so (docs/spaces.md §2): `saved` if it is one of `groups` — the
 * session's `currentGroupId`, or the one main held — else the space of
 * `activeTabId` (the tab in use, or the Profile's remembered one), else the
 * space of the tab used last (`recentTabIds`, most recent first), else the
 * space whose tab was used latest. Null when no space holds a tab and none
 * was saved: the caller makes a fresh empty one. `groups` are the
 * Profile's, of every kind (a loose tab's and a page's are spaces too).
 */
export function chooseCurrentGroup(input: {
  groups: readonly TabGroupInfo[];
  saved?: string | null;
  activeTabId?: string | null;
  recentTabIds?: readonly string[];
  lastActiveAt?: (tabId: string) => number;
}): string | null {
  const { groups } = input;
  if (input.saved != null && groups.some((group) => group.id === input.saved)) return input.saved;
  const spaceOf = (tabId: string): string | null => tabGroupOf(groups, tabId)?.id ?? null;
  if (input.activeTabId != null) {
    const held = spaceOf(input.activeTabId);
    if (held !== null) return held;
  }
  for (const tabId of input.recentTabIds ?? []) {
    const held = spaceOf(tabId);
    if (held !== null) return held;
  }
  let latest: string | null = null;
  let latestAt = -Infinity;
  for (const group of groups) {
    for (const tabId of group.tabIds) {
      const at = input.lastActiveAt?.(tabId) ?? 0;
      if (at > latestAt) {
        latest = group.id;
        latestAt = at;
      }
    }
  }
  return latest;
}

/**
 * The current space of a Profile where no space holds a tab and no fresh
 * one may be made (MAX_TAB_GROUPS_PER_SPACE drawn already, every one
 * empty): the empty drawn space made last — never `except` (one being
 * closed). Null only with none. So a Profile with any space always has a
 * current one (docs/spaces.md §2); until 2026-10-09 such a Profile had none,
 * and the desk stood on nothing beside fifty empty spaces.
 */
export function newestEmptySpace(groups: readonly TabGroupInfo[], except?: string): string | null {
  let newest: TabGroupInfo | null = null;
  for (const group of groups) {
    if (group.id === except || group.tabIds.length > 0 || group.loose === true || group.anchorId !== undefined) continue;
    if (newest === null || group.createdAt >= newest.createdAt) newest = group;
  }
  return newest?.id ?? null;
}

/**
 * The one of `candidates` used last: the first of them in `recentTabIds`
 * (most recent first), else the one with the latest `lastActiveAt`, else the
 * first. Undefined with no candidates — a space with no tab, which comes up
 * empty.
 */
export function mostRecentTab(candidates: readonly string[], recentTabIds: readonly string[], lastActiveAt: (tabId: string) => number = () => 0): string | undefined {
  if (candidates.length === 0) return undefined;
  const wanted = new Set(candidates);
  const recent = recentTabIds.find((tabId) => wanted.has(tabId));
  if (recent !== undefined) return recent;
  return [...candidates].sort((a, b) => lastActiveAt(b) - lastActiveAt(a))[0];
}

/* --------------------------- where an empty space stands ------------------ */

/**
 * The `beforeUnit` each EMPTY drawn space must take now (TabGroupInfo
 * .beforeUnit, docs/spaces.md §1 "Where an empty space stands"), given the
 * day's row units as they were at the last settle (`previous`, unit ids in
 * order, and of those the empty spaces' — `previouslyEmpty`) and the units
 * there are now (`present`, empty spaces' among them):
 *
 * - one that names a unit still here keeps it (absent from the result);
 * - one that just emptied (no `beforeUnit`, and its unit had tabs last
 *   time) stands before the unit that was after it, the first of those
 *   still here — where its last tab was, not at the end;
 * - one whose unit went stands before that unit's successor, the first
 *   still here;
 * - with nothing after it it is undefined, and the space stands after every
 *   unit — as one does on purpose (empty last time with none: moved to the
 *   end, or never in the row, New space), which is left so.
 *
 * A space never stands before itself. Spaces with tabs, loose tabs' and
 * pages' are not asked about: they stand where their tabs do.
 */
export function settleBeforeUnits(
  groups: readonly TabGroupInfo[],
  previous: readonly string[],
  previouslyEmpty: ReadonlySet<string>,
  present: ReadonlySet<string>,
): Map<string, string | undefined> {
  const settled = new Map<string, string | undefined>();
  for (const group of groups) {
    if (group.tabIds.length > 0 || group.loose === true || group.anchorId !== undefined) continue;
    const own = tabGroupUnitId(group.id);
    const stands = (unit: string): boolean => unit !== own && present.has(unit);
    if (group.beforeUnit === undefined ? previouslyEmpty.has(own) || !previous.includes(own) : stands(group.beforeUnit)) continue;
    const from = previous.indexOf(group.beforeUnit ?? own);
    settled.set(group.id, from < 0 ? undefined : previous.slice(from + 1).find(stands));
  }
  return settled;
}

/**
 * The day's row units as the sidebar draws them while `moving` is in hand —
 * what a drop among them counts (the shell's dayUnitsInHand, chrome/tabs.ts,
 * which this must match unit for unit): dayRowUnits over EVERY day tab, the
 * moved ones included, so an empty space standing before one of them (its
 * `beforeUnit`) is counted where it is drawn; then the moved tabs are lifted
 * out of their units — a lone tab's unit emptied goes, a space's stays (its
 * header still drawn), every empty space too — and `movingUnit`, a space
 * dragged by its header (`group:<id>`, empty or not), goes whole. (Until
 * 2026-10-09 main counted without the moved tabs from the start: a space
 * standing before one fell to the end of the count, every index past it was
 * one off, and the space jumped.)
 */
export function unitsInHand(
  dayTabIds: readonly string[],
  groups: readonly TabGroupInfo[],
  moving: ReadonlySet<string>,
  movingUnit?: string,
): DayRowUnit[] {
  return dayRowUnits(dayTabIds, [], groups)
    .filter((unit) => unit.id !== movingUnit)
    .map((unit) => ({ ...unit, tabIds: unit.tabIds.filter((tabId) => !moving.has(tabId)) }))
    .filter((unit) => unit.kind === "group" || unit.tabIds.length > 0);
}

/**
 * A unit (`moved` — a lone tab's id, or `group:<id>`) set down at `index`
 * among the day's row units (`units`, as drawn with it in hand —
 * unitsInHand — empty spaces among them; past the last, after everything): the tab its tabs go before
 * in the one tab order (`beforeTabId` — the first tab of the first unit at
 * or after `index` that has one; undefined, after every tab), and the
 * `beforeUnit` every empty space takes so the row reads exactly so
 * (`beforeUnits`, by group id: each empty space stands before the unit
 * after it in the new row, undefined at the end) — an empty space standing
 * before the unit the moved one now precedes would otherwise come after it.
 */
export function placeAmongUnits(
  units: readonly { id: string; kind: string; tabIds: readonly string[] }[],
  index: number,
  moved: string,
): { beforeTabId: string | undefined; beforeUnits: Map<string, string | undefined> } {
  const at = Math.max(0, Math.min(index, units.length));
  const beforeTabId = units.slice(at).find((unit) => unit.tabIds.length > 0)?.tabIds[0];
  const row = units.map((unit) => unit.id);
  row.splice(at, 0, moved);
  const empty = new Set(units.filter((unit) => unit.kind === "group" && unit.tabIds.length === 0).map((unit) => unit.id));
  const beforeUnits = new Map<string, string | undefined>();
  const prefix = tabGroupUnitId("");
  row.forEach((id, position) => {
    // (The moved unit is answered for too when it is a space: the caller keeps the answer for an empty one.)
    if (empty.has(id) || (id === moved && id.startsWith(prefix))) beforeUnits.set(id.slice(prefix.length), row[position + 1]);
  });
  return { beforeTabId, beforeUnits };
}

/* ------------------------------- every tab a space ------------------------ */

/**
 * The tabs of a Profile that need a space made now (docs/spaces.md §1,
 * "Every listed tab is in a space"): each of `tabs` — the Profile's listed
 * tabs a space may hold, in row order — that is in none of `groups`. A day
 * tab gets a loose tab's space; an entry's page (`anchorId`) its page's
 * space, unless that entry has one already (one per entry: a second
 * claimant waits for the first to let go). The loose and pages' spaces are
 * bounded together (MAX_LOOSE_TAB_GROUPS_PER_SPACE); past the bound a tab
 * simply has none, as before 2026-10-09.
 */
export function tabsWithoutSpace(
  tabs: readonly { id: string; anchorId: string | null }[],
  groups: readonly TabGroupInfo[],
  bound: number = MAX_LOOSE_TAB_GROUPS_PER_SPACE,
): Array<{ tabId: string; anchorId: string | null }> {
  const held = new Set(groups.flatMap((group) => group.tabIds));
  const pages = new Set(groups.flatMap((group) => (group.anchorId === undefined ? [] : [group.anchorId])));
  let room = bound - groups.filter((group) => group.loose === true || group.anchorId !== undefined).length;
  const wanting: Array<{ tabId: string; anchorId: string | null }> = [];
  for (const tab of tabs) {
    if (room <= 0) break;
    if (held.has(tab.id)) continue;
    if (tab.anchorId !== null) {
      if (pages.has(tab.anchorId)) continue;
      pages.add(tab.anchorId);
    }
    held.add(tab.id);
    wanting.push({ tabId: tab.id, anchorId: tab.anchorId });
    room -= 1;
  }
  return wanting;
}

/* ---------------------------------- Tidy ---------------------------------- */

/**
 * What Tidy may not touch in a Profile (docs/spaces.md §1, "Tidy";
 * docs/tab-tidy.md): the current space — whatever it is, it is in front of
 * the person — and every space that is the person's (`persons`, the
 * contract's isPersonsGroup with main's facts). `spareGroupIds` are spaces
 * Tidy neither archives whole nor resets; `spareTabIds` are tabs it neither
 * archives nor regroups: the current space's, and a loose tab's whose space
 * holds a Stack or a conversation (a drawn space of the person's keeps its
 * tabs from Tidy already: they are grouped, and Tidy only ever adds to it).
 * A page's space among `spareGroupIds` is neither archived nor brought down
 * (favoriteGroupsDue). `keepAddressTabIds` are favorites' tabs the favorites
 * reset may not send back to their address: every tab of a spared space — a
 * page's space with a Stack included, whose tabs `spareTabIds` leaves out —
 * and every window on the desk (`deskTabIds`, the shell's last report),
 * asleep or not: since 2026-10-09 a covered or minimized window is dormant
 * (`DeskState.live`), and suspendTab's refusal no longer stands in front of
 * it.
 */
export function tidyReach(
  groups: readonly TabGroupInfo[],
  currentGroupId: string | null,
  persons: (group: TabGroupInfo) => boolean,
  deskTabIds: Iterable<string> = [],
): { spareGroupIds: Set<string>; spareTabIds: Set<string>; keepAddressTabIds: Set<string> } {
  const spareGroupIds = new Set<string>();
  const spareTabIds = new Set<string>();
  const keepAddressTabIds = new Set<string>(deskTabIds);
  for (const group of groups) {
    const current = group.id === currentGroupId;
    const theirs = persons(group);
    if (current || theirs) {
      spareGroupIds.add(group.id);
      for (const tabId of group.tabIds) keepAddressTabIds.add(tabId);
    }
    if (current || (group.loose === true && theirs)) for (const tabId of group.tabIds) spareTabIds.add(tabId);
  }
  return { spareGroupIds, spareTabIds, keepAddressTabIds };
}

/* -------------------------------- the bound -------------------------------- */

/** A drawn space (neither a loose tab's nor a page's): what MAX_TAB_GROUPS_PER_SPACE bounds, in memory and on disk. */
function isDrawn(group: TabGroupInfo): boolean {
  return group.loose !== true && group.anchorId === undefined;
}

/** Whether a Profile (`spaceId`) has room among `groups` for one more drawn space. */
export function roomForDrawn(groups: readonly TabGroupInfo[], spaceId: string | null, spaceOf: (groupId: string) => string | null): boolean {
  if (spaceId === null) return false;
  return groups.filter((group) => isDrawn(group) && spaceOf(group.id) === spaceId).length < MAX_TAB_GROUPS_PER_SPACE;
}

/**
 * The `keep` main gives withoutTabs (docs/spaces.md §1, "An empty space"):
 * a space (tab group) losing tabs stays if it is the person's (`persons`,
 * isPersonsGroup with main's facts) — and, when staying would make it a
 * DRAWN space it was not (a loose tab's or a page's, emptied), only while
 * its Profile (`spaceOf`) has room for one more drawn space. A save drops
 * drawn spaces past MAX_TAB_GROUPS_PER_SPACE (sanitizeTabGroups), so one
 * kept past it lived in memory and vanished at the next launch, its Stack
 * and conversation with nothing to open them; with no room it goes now, as
 * any dissolved space does (what it held stays under its id). Counts as it
 * keeps: two emptied at once with room for one keeps the first. The count is
 * of the drawn spaces as they will be after the move: `alsoDrawn` names, by
 * Profile, one entry per drawn space the caller has left out of `groups`
 * and puts back — a destination rebuilt by hand (addToTabGroup), a space
 * being made (createTabGroup) — without which a full Profile read as having
 * room, and the emptied source made it fifty-one. (2026-10-09.)
 */
export function keepWithRoom(
  groups: readonly TabGroupInfo[],
  gone: ReadonlySet<string>,
  persons: (group: TabGroupInfo) => boolean,
  spaceOf: (groupId: string) => string | null,
  alsoDrawn: readonly string[] = [],
): (group: TabGroupInfo) => boolean {
  const drawn = new Map<string, number>();
  for (const group of groups) {
    const spaceId = spaceOf(group.id);
    if (isDrawn(group) && spaceId !== null) drawn.set(spaceId, (drawn.get(spaceId) ?? 0) + 1);
  }
  for (const spaceId of alsoDrawn) drawn.set(spaceId, (drawn.get(spaceId) ?? 0) + 1);
  return (group) => {
    if (!persons(group)) return false;
    // Drawn already, or not emptied (a page's that keeps its page): no new drawn space.
    if (isDrawn(group) || group.tabIds.some((tabId) => !gone.has(tabId))) return true;
    const spaceId = spaceOf(group.id);
    const count = spaceId === null ? MAX_TAB_GROUPS_PER_SPACE : (drawn.get(spaceId) ?? 0);
    if (count >= MAX_TAB_GROUPS_PER_SPACE) return false;
    drawn.set(spaceId!, count + 1);
    return true;
  };
}

/**
 * Belt and braces for the bound (the reconcile's step 6): in each Profile
 * holding more drawn spaces than MAX_TAB_GROUPS_PER_SPACE, the EMPTY ones
 * that may go to bring it back within it, oldest (`createdAt`) first —
 * only those that are nobody's (an emptied auto space, main's fresh one):
 * never one that is the person's (`persons`, isPersonsGroup), never the
 * Profile's current one (`currentOf`), never one with tabs. If what is past
 * the bound is the person's, it is all kept: this never destroys a space of
 * theirs, and the only cut left is a save's (sanitizeTabGroups keeps the
 * first MAX_TAB_GROUPS_PER_SPACE drawn spaces in row order) — which the keep
 * rule's room (keepWithRoom) is there to make unreachable.
 */
export function overCapEmptySpaces(
  groups: readonly TabGroupInfo[],
  spaceOf: (groupId: string) => string | null,
  currentOf: (spaceId: string) => string | null,
  persons: (group: TabGroupInfo) => boolean,
): Set<string> {
  const bySpace = new Map<string, TabGroupInfo[]>();
  for (const group of groups) {
    const spaceId = spaceOf(group.id);
    if (!isDrawn(group) || spaceId === null) continue;
    bySpace.set(spaceId, [...(bySpace.get(spaceId) ?? []), group]);
  }
  const going = new Set<string>();
  for (const [spaceId, drawn] of bySpace) {
    let over = drawn.length - MAX_TAB_GROUPS_PER_SPACE;
    if (over <= 0) continue;
    const current = currentOf(spaceId);
    const empties = drawn.filter((group) => group.tabIds.length === 0 && group.id !== current && !persons(group)).sort((a, b) => a.createdAt - b.createdAt);
    for (const group of empties) {
      if (over <= 0) break;
      going.add(group.id);
      over -= 1;
    }
  }
  return going;
}

/* ------------------------------ what is theirs ---------------------------- */

/**
 * The facts that make a space (tab group) the person's beyond their own
 * hand, as BrowserControllerHooks.groupHolds hands them to the reconcile
 * (docs/spaces.md §2, isPersonsGroup): a Stack with something in it — an
 * entry may stand empty, and is never deleted, so its items are asked —
 * and a conversation bound to it whose thread is still kept: a binding
 * outlives a thread the store pruned past its bound, and is no conversation
 * then. Each store is asked from memory (`hasItems`, `get`, `has`): this runs
 * on every reconcile, before every publish.
 */
export function spaceHolds(stores: {
  contexts: { hasItems(groupId: string): boolean } | null;
  conversations: { get(groupId: string): string | null } | null;
  threads: { has(runId: string): boolean } | null;
}): (groupId: string) => { context: boolean; conversation: boolean } {
  return (groupId) => {
    const runId = stores.conversations?.get(groupId) ?? null;
    return {
      context: stores.contexts?.hasItems(groupId) === true,
      conversation: runId !== null && stores.threads?.has(runId) === true,
    };
  };
}
