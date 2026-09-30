/**
 * The dock's order (components/desk/DeskDock.tsx): the group's tabs, and the
 * Space's other groups in the order the sidebar lists them — and what a drop
 * in the dock asks of the browser, which holds the one order for both.
 *
 * Pure on purpose, so vitest pins it.
 */

import type { BrowserTabInfo, ShellSnapshot } from "@pistachio/shell-contracts/ipc";
import { dayRowUnits, tabGroupUnitId, type TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";

/** `ids` with the one at `from` moved to `to`, counted without it, as a drop counts. */
export function movedOrder(ids: readonly string[], from: number, to: number): string[] {
  const moved = ids[from];
  if (moved === undefined) return [...ids];
  const rest = ids.filter((_, index) => index !== from);
  rest.splice(Math.max(0, Math.min(to, rest.length)), 0, moved);
  return rest;
}

/**
 * Groups in the order the sidebar lists them: where each one's tabs sit in
 * the tab row (a group's tabs are always together there). A group none of
 * whose tabs is in the row goes last.
 */
export function groupsInRowOrder(groups: readonly TabGroupInfo[], tabs: readonly Pick<BrowserTabInfo, "id">[]): TabGroupInfo[] {
  const position = new Map(tabs.map((tab, index) => [tab.id, index]));
  const place = (group: TabGroupInfo): number => Math.min(...group.tabIds.map((tabId) => position.get(tabId) ?? Number.POSITIVE_INFINITY));
  return groups
    .map((group) => ({ group, at: place(group) }))
    .sort((a, b) => a.at - b.at)
    .map(({ group }) => group);
}

/**
 * Items in the order a drop in the dock left them, until the browser says
 * the same: those `order` names in its order, then any it does not (come
 * since) as they were — and `gone` (a tab let go into another group) left
 * out. With nothing settling, the items themselves.
 */
export function settledOrder<T extends { id: string }>(items: readonly T[], order: readonly string[] | null, gone: string | null): readonly T[] {
  if (order === null && gone === null) return items;
  const rank = new Map((order ?? []).map((id, index) => [id, index]));
  return items
    .filter((item) => item.id !== gone)
    .map((item, index) => ({ item, rank: rank.get(item.id) ?? order!.length + index }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ item }) => item);
}

/**
 * The `move` command's index for `groupId` (@pistachio/shell-contracts/tab-groups:
 * among the day's row units, counted without it) that puts it where `order`
 * — the dock's groups, top to bottom, as they are to be — has it: before
 * the group after it there, or else straight after the one before it. Null
 * when neither is in the row (nothing to place it by).
 */
export function groupMoveIndex(snapshot: Pick<ShellSnapshot, "tabs" | "tabGroups" | "splitGroups">, groupId: string, order: readonly string[]): number | null {
  const group = snapshot.tabGroups.find((candidate) => candidate.id === groupId);
  const at = order.indexOf(groupId);
  if (group === undefined || at < 0) return null;
  const members = new Set(group.tabIds);
  // The day's tabs as main counts them for a move (its #groupable), without the group's own.
  const day = snapshot.tabs.filter((tab) => tab.kind === "human" && !tab.unlisted && tab.anchorId === null && !members.has(tab.id)).map((tab) => tab.id);
  const units = dayRowUnits(
    day,
    snapshot.splitGroups,
    snapshot.tabGroups.filter((candidate) => candidate.id !== groupId),
  );
  const unitOf = (id: string | undefined): number => (id === undefined ? -1 : units.findIndex((unit) => unit.id === tabGroupUnitId(id)));
  const before = unitOf(order[at + 1]);
  if (before >= 0) return before;
  const after = unitOf(order[at - 1]);
  return after >= 0 ? after + 1 : null;
}
