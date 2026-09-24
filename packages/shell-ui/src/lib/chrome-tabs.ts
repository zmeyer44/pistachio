/**
 * The rows the chrome lays out, built from the snapshot: the tab's info plus
 * its role in the window. Pure — no store, no React — so the sharing rule
 * below can be pinned under node (test/chrome-tabs.test.ts); chrome/tabs.ts
 * wraps it in the hook the strip and the list use.
 */

import type { BrowserTabInfo, ShellSnapshot, SplitGroupInfo, SplitMode } from "@pistachio/shell-contracts/ipc";

/** A tab as the chrome sees it: the snapshot's info plus its role in the window. */
export interface ChromeTab extends BrowserTabInfo {
  active: boolean;
  /** Shown in the other, unfocused pane of a live split. */
  split: boolean;
  /** The persistent pair this tab belongs to, visible or inactive. */
  splitGroup: SplitGroupInfo | null;
}

export function chromeTabs(snapshot: ShellSnapshot | null): ChromeTab[] {
  return chromeTabsSharing(snapshot, EMPTY_TABS);
}

export const EMPTY_TABS: readonly ChromeTab[] = [];

/**
 * Like chromeTabs, but a tab whose fields did not change keeps the ChromeTab
 * object it had in `previous`, and a list in which nothing changed IS
 * `previous`. The store already keeps unchanged BrowserTabInfo references
 * across publishes (lib/share.ts), so a row memoized on its tab re-renders
 * only when that tab changed.
 */
export function chromeTabsSharing(snapshot: ShellSnapshot | null, previous: readonly ChromeTab[]): ChromeTab[] {
  if (snapshot === null) return previous.length === 0 ? (previous as ChromeTab[]) : [];
  const splitMode: SplitMode = snapshot.splitMode;
  const groupByTab = new Map<string, SplitGroupInfo>();
  for (const group of snapshot.splitGroups) {
    for (const tabId of group.tabIds) groupByTab.set(tabId, group);
  }
  const visible = new Set(snapshot.visibleTabIds);
  const before = new Map(previous.map((tab) => [tab.id, tab]));
  let same = true;
  // Working tabs (the read-aloud player) are main's to manage and the media
  // card's to drive; the chrome never lists them.
  const next = snapshot.tabs.filter((tab) => !tab.unlisted).map((tab, index) => {
    const active = tab.id === snapshot.activeTabId;
    const split = splitMode !== "single" && visible.has(tab.id) && !active;
    const splitGroup = groupByTab.get(tab.id) ?? null;
    const was = before.get(tab.id);
    if (was !== undefined && was.active === active && was.split === split && was.splitGroup === splitGroup && sameInfo(was, tab)) {
      if (previous[index] !== was) same = false;
      return was;
    }
    same = false;
    return { ...tab, active, split, splitGroup };
  });
  return same && next.length === previous.length ? (previous as ChromeTab[]) : next;
}

function sameInfo(a: ChromeTab, b: BrowserTabInfo): boolean {
  for (const key of Object.keys(b) as Array<keyof BrowserTabInfo>) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}
