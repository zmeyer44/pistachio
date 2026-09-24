/**
 * The tabs as the chrome sees them, shared by the horizontal strip and the
 * vertical list: the snapshot's info plus each tab's role in the window, and
 * the row units the two lay out over.
 */

import { useMemo, useRef } from "react";
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
