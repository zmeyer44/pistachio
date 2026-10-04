/**
 * A desk window's page on its frame's menu (⋯, or a right-click on the
 * frame): what the pane toolbar offers over a page off the desk
 * (components/PaneToolbar.tsx) — a desk has no pane toolbar, and its rail no
 * back, forward or reload. By the toolbar's own rules: back and forward dim
 * with no history; reader view, bookmark and pin are a person's web page's;
 * the site's information is the active tab's (the window in use).
 *
 * Read as the menu opens, not as the window renders: the menu says what is
 * true when it comes up, and a window re-renders only when it changes.
 */

import { useCallback } from "react";
import { BookmarkCheck, BookmarkPlus, BookOpen, BookOpenText, ChevronLeft, ChevronRight, Pin, PinOff, RotateCw, SlidersHorizontal } from "lucide-react";
import { bookmarkUrlKey, isBookmarkableUrl } from "@pistachio/shell-contracts/bookmarks";
import type { BrowserTabInfo } from "@pistachio/shell-contracts/ipc";
import { canReadUrl, isReaderUrl } from "@pistachio/shell-contracts/reader";
import { useShell } from "../../chrome/shell-host";
import { useAppStore } from "../../store";
import type { MenuEntry } from "../ContextMenu";

/** The entries for one window's page, ending in a separator from the window's own. */
export function usePageEntries(): (tab: BrowserTabInfo) => MenuEntry[] {
  const { run } = useShell();
  return useCallback(
    (tab: BrowserTabInfo): MenuEntry[] => {
      const store = useAppStore.getState();
      const human = tab.kind === "human";
      const entries: MenuEntry[] = [
        { label: "Back", icon: <ChevronLeft aria-hidden="true" />, testId: "desk-page-back", disabled: !tab.canGoBack, onSelect: () => void store.goBack(tab.id) },
        { label: "Forward", icon: <ChevronRight aria-hidden="true" />, testId: "desk-page-forward", disabled: !tab.canGoForward, onSelect: () => void store.goForward(tab.id) },
        { label: "Reload", icon: <RotateCw aria-hidden="true" />, testId: "desk-page-reload", onSelect: () => void store.reload(tab.id) },
      ];
      const page: MenuEntry[] = [];
      if (human && canReadUrl(tab.url)) {
        const reading = isReaderUrl(tab.url);
        page.push({
          label: reading ? "Hide reader" : "Reader view",
          icon: reading ? <BookOpenText aria-hidden="true" /> : <BookOpen aria-hidden="true" />,
          testId: "desk-page-reader",
          onSelect: () => void store.toggleReaderView(tab.id),
        });
      }
      if (human && isBookmarkableUrl(tab.url)) {
        const key = bookmarkUrlKey(tab.url);
        const bookmark = store.bookmarks.bookmarks.find((candidate) => bookmarkUrlKey(candidate.url) === key) ?? null;
        page.push({
          label: bookmark !== null ? "Remove bookmark" : "Bookmark this page",
          icon: bookmark !== null ? <BookmarkCheck aria-hidden="true" /> : <BookmarkPlus aria-hidden="true" />,
          testId: "desk-page-bookmark",
          onSelect: () => (bookmark !== null ? void store.deleteBookmark(bookmark.id) : run({ type: "bookmarkPage", tabId: tab.id })),
        });
      }
      // (Never a favorite's tab, which is the grid's to keep.)
      const pinned = tab.anchorId !== null && (store.snapshot?.sidebar.entries.some((entry) => entry.kind === "pin" && entry.id === tab.anchorId) ?? false);
      if (human && (tab.anchorId === null || pinned))
        page.push({
          label: pinned ? "Unpin tab" : "Pin tab",
          icon: pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />,
          testId: "desk-page-pin",
          onSelect: () =>
            void (pinned
              ? store.sidebarCommand({ type: "unpin", pinId: tab.anchorId ?? "" })
              : store.sidebarCommand({ type: "pinTab", tabId: tab.id, folderId: null, index: 10_000 })),
        });
      // Hung from the window's ⋯ (DeskWindow's SiteInfoFrom), the window in use's alone: the controls describe the active tab.
      if (store.snapshot?.activeTabId === tab.id)
        page.push({ label: "Site information", icon: <SlidersHorizontal aria-hidden="true" />, testId: "desk-page-site-info", onSelect: () => store.openSiteInfo() });
      return [...entries, ...(page.length > 0 ? [{ separator: true } as const, ...page] : []), { separator: true }];
    },
    [run],
  );
}
