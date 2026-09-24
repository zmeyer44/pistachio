import { useMemo } from "react";
import type { BrowserTabInfo } from "@pistachio/shell-contracts/ipc";
import { useAppStore } from "../../store";

/** Where the home page's choices take the person. */
export interface HomeNavigation {
  /** The tab showing the page, or null for a window with no tabs. */
  tab: BrowserTabInfo | null;
  /** Go to an address (or a search): in this tab, or a new one when there is no tab. */
  open(url: string): void;
  selectTab(tabId: string): Promise<void>;
  /** Show a kept page — a favorite, a pin, an organization link — by its anchor. */
  openAnchor(anchorId: string): Promise<void>;
  /**
   * Go somewhere that is not this tab (another tab, a favorite's own tab),
   * then close this one if it was only ever a launcher: nothing behind it,
   * nothing ahead of it, not a pane of a split. A home page opened by ⌘T to
   * reach an open tab would otherwise be left behind in the strip.
   */
  leaveFor(go: () => Promise<void>): void;
}

export function useHomeNavigation(tabId: string | null): HomeNavigation {
  const tab = useAppStore((s) => (tabId === null ? null : (s.snapshot?.tabs.find((candidate) => candidate.id === tabId) ?? null)));
  const navigate = useAppStore((s) => s.navigate);
  const createTab = useAppStore((s) => s.createTab);
  const selectTab = useAppStore((s) => s.selectTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const sidebarCommand = useAppStore((s) => s.sidebarCommand);

  return useMemo<HomeNavigation>(
    () => ({
      tab,
      open: (url) => {
        if (tab === null) void createTab(url);
        else void navigate(tab.id, url);
      },
      selectTab,
      openAnchor: (anchorId) => sidebarCommand({ type: "open", anchorId }),
      leaveFor: (go) => {
        const snapshot = useAppStore.getState().snapshot;
        const current = tabId === null ? undefined : snapshot?.tabs.find((candidate) => candidate.id === tabId);
        const launcher =
          current !== undefined &&
          !current.canGoBack &&
          !current.canGoForward &&
          !(snapshot?.splitGroups ?? []).some((group) => group.tabIds.includes(current.id));
        void go().then(() => {
          if (launcher && useAppStore.getState().snapshot?.activeTabId !== current.id) void closeTab(current.id);
        });
      },
    }),
    [tab, tabId, navigate, createTab, selectTab, closeTab, sidebarCommand],
  );
}
