/**
 * The tabs as the chrome sees them: the snapshot's info plus each tab's role
 * in the window, and the row units the sidebar's list lays out over.
 */

import { useMemo, useRef } from "react";
import { anchorGroupTabIds, dayRowUnits, tabGroupUnitId, type DayRowUnit, type TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import { useAppStore } from "../store";
import { chromeTabsSharing, EMPTY_TABS, type ChromeTab } from "../lib/chrome-tabs";

export { chromeTabs, chromeTabsSharing, type ChromeTab } from "../lib/chrome-tabs";

/**
 * The store's tabs, in snapshot order. Rows keep their identity across
 * publishes that did not change them (chromeTabsSharing), so memoized row
 * components and lists keyed on them stay put through a title tick elsewhere.
 */
export function useChromeTabs(): ChromeTab[] {
  const tabs = useAppStore((s) => s.snapshot?.tabs);
  const activeTabId = useAppStore((s) => s.snapshot?.activeTabId);
  const visibleTabIds = useAppStore((s) => s.snapshot?.visibleTabIds);
  const splitMode = useAppStore((s) => s.snapshot?.splitMode);
  const splitGroups = useAppStore((s) => s.snapshot?.splitGroups);
  const previous = useRef<readonly ChromeTab[]>(EMPTY_TABS);
  return useMemo(() => {
    const snapshot = useAppStore.getState().snapshot;
    const next = chromeTabsSharing(snapshot, previous.current);
    previous.current = next;
    return next;
    // The five slices above are exactly what chromeTabsSharing reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, activeTabId, visibleTabIds, splitMode, splitGroups]);
}

/**
 * One slot in the row (or the list). A split view is ONE slot holding both
 * of its tabs: everything the row does — reorder, drop targets, drag limits,
 * FLIP — is expressed over these units rather than over tabs.
 */
export interface RowItem {
  id: string;
  /** A split's 2–4 panes in stable PANE order, or one lone tab. */
  tabs: ChromeTab[];
  active: boolean;
}

export function rowItems(order: ChromeTab[]): RowItem[] {
  const lone = (t: ChromeTab): RowItem => ({ id: t.id, tabs: [t], active: t.active });
  const byId = new Map(order.map((tab) => [tab.id, tab]));
  const items: RowItem[] = [];
  const placed = new Set<string>();
  for (const tab of order) {
    const group = tab.splitGroup;
    if (group === null) {
      items.push(lone(tab));
      continue;
    }
    if (placed.has(group.id)) continue;
    const members = group.tabIds.flatMap((tabId) => {
      const member = byId.get(tabId);
      return member === undefined ? [] : [member];
    });
    // A filtered shelf section may contain only one member (for example a
    // pinned page paired with a day tab); keep that member usable there.
    if (members.length !== group.tabIds.length) {
      items.push(lone(tab));
      continue;
    }
    placed.add(group.id);
    items.push({
      id: `split:${group.id}`,
      tabs: members,
      active: members.some((member) => member.active),
    });
  }
  return items;
}

/**
 * One slot among the day's rows: a row (a lone tab or a split), or a tab
 * group — a space — holding rows of its own. The ids are
 * @pistachio/shell-contracts/tab-groups `dayRowUnits`' — the same units
 * main and the drag's drop count in.
 */
export type DayUnit =
  | { kind: "row"; id: string; row: RowItem }
  | { kind: "group"; id: string; group: TabGroupInfo; tabs: ChromeTab[]; rows: RowItem[] };

/**
 * The day's units as the sidebar draws them: the day's tabs (not an entry's
 * page, nor a tab of a page's group, which are drawn under their entries) in
 * `dayRowUnits`' order. An EMPTY space is a unit too (since 2026-10-09:
 * dayRowUnits sets it where it stands, its `beforeUnit`), drawn as its row
 * alone; a row whose tabs are all gone is not.
 */
export function dayUnits(
  tabs: readonly ChromeTab[],
  tabGroups: readonly TabGroupInfo[],
  splitGroups: readonly { id: string; tabIds: readonly string[] }[],
  pageGroupTabIds: ReadonlySet<string>,
): DayUnit[] {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const groupByUnit = new Map(tabGroups.map((group) => [tabGroupUnitId(group.id), group]));
  const day = tabs.filter((tab) => tab.anchorId === null && !pageGroupTabIds.has(tab.id)).map((tab) => tab.id);
  return dayRowUnits(day, splitGroups, tabGroups).flatMap((unit): DayUnit[] => {
    const members = unit.tabIds.flatMap((tabId) => byId.get(tabId) ?? []);
    const group = groupByUnit.get(unit.id);
    if (unit.kind === "group" && group !== undefined) return [{ kind: "group", id: unit.id, group, tabs: members, rows: rowItems(members) }];
    if (members.length === 0) return [];
    return [{ kind: "row", id: unit.id, row: { id: unit.id, tabs: members, active: members.some((tab) => tab.active) } }];
  });
}

/**
 * The day's row units as the list draws them while the tabs `moving` are in
 * hand, which is what a drop among them counts (sidebar-tree's listDropAt):
 * `dayRowUnits` over the day's tabs WITH those in hand — so an empty space
 * standing before one of them (its `beforeUnit`) is where it is drawn,
 * before the slot the row left — and then they are lifted out, a space the
 * lift emptied staying where it stood (its header drawn without them).
 */
export function dayUnitsInHand(
  snapshot: { tabs: readonly { id: string; anchorId: string | null }[]; tabGroups: readonly TabGroupInfo[]; splitGroups: readonly { id: string; tabIds: readonly string[] }[]; anchorGroups?: readonly TabGroupInfo[] } | null,
  moving: ReadonlySet<string>,
): DayRowUnit[] {
  if (snapshot === null) return [];
  const underEntries = anchorGroupTabIds(snapshot.anchorGroups ?? []);
  const day = snapshot.tabs.filter((tab) => tab.anchorId === null && !underEntries.has(tab.id)).map((tab) => tab.id);
  return dayRowUnits(day, snapshot.splitGroups, snapshot.tabGroups)
    .map((unit) => ({ ...unit, tabIds: unit.tabIds.filter((tabId) => !moving.has(tabId)) }))
    .filter((unit) => unit.kind === "group" || unit.tabIds.length > 0);
}

/**
 * A drop at `index` among the units as drawn (`drawn`, dayUnitsInHand), as
 * an index among the same units read again once the drop's own changes have
 * landed (`now`: a tab taken out of its space, which may have gone with
 * it): before the first unit at or after the drop that is still there,
 * after every unit when none is.
 */
export function unitIndexAfter(drawn: readonly DayRowUnit[], index: number, now: readonly DayRowUnit[]): number {
  const following = new Set(drawn.slice(Math.max(0, index)).map((unit) => unit.id));
  const at = now.findIndex((unit) => following.has(unit.id));
  return at < 0 ? now.length : at;
}
