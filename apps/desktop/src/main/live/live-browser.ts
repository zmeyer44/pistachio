import type { BrowserWindow } from "electron";
import { fileItemOf } from "@pistachio/shell-contracts/desk-agent";
import { isShellPageUrl } from "@pistachio/shell-contracts/shell-pages";
import type { ShortcutSettings } from "@pistachio/shell-contracts/shortcuts";
import type { BrowserController } from "../browser-controller";
import type { GroupContextStore } from "../group-context-store";
import { spaceColor } from "./live-desk";
import { isAppShortcut } from "./live-input";
import type { LiveBrowser } from "./live-service";

/**
 * The browser as the live share sees it (docs/live-share.md §6.1): the shared
 * space, the space in front, what each of its windows shows, and the tabs'
 * pages that guests' input goes to. Only the shared space's own windows are
 * ever described: a tab that left the space, or another Profile's, is no
 * window of the share, so it is neither streamed nor controllable.
 */
export function liveBrowser(
  browser: BrowserController,
  window: BrowserWindow,
  options: {
    contexts: () => GroupContextStore | null;
    /** The window is up and the Mac awake and unlocked (live-presence.ts). */
    shown: () => boolean;
    /** The person's shortcuts, as main's key handler reads them. */
    shortcuts: () => ShortcutSettings;
  },
): LiveBrowser {
  return {
    space(groupId) {
      const group = browser.tabGroup(groupId);
      const spaceId = browser.tabGroupSpaceId(groupId);
      if (group === null || spaceId === null) return null;
      // A Home tab's space (a loose one) has no name of its own: it is its tab's.
      const title = group.title.trim() !== "" ? group.title : (browser.tab(group.tabIds[0] ?? "")?.title ?? "");
      return { title, color: spaceColor(group.color), spaceId };
    },
    current: () => ({ spaceId: browser.activeSpaceId(), groupId: browser.currentGroupId() }),
    windowShown: options.shown,
    facts(windowId, groupId) {
      const itemId = fileItemOf(windowId);
      if (itemId !== null) {
        const item = options.contexts()?.items(groupId).find((candidate) => candidate.id === itemId);
        return item?.kind === "file" ? { title: item.name, url: null, favicon: null, page: false } : null;
      }
      const tab = browser.tab(windowId);
      if (tab === null || tab.hiddenFor !== undefined || browser.tabGroupMembers(groupId)?.includes(windowId) !== true) return null;
      const shellPage = isShellPageUrl(tab.url);
      return { title: tab.title, url: shellPage ? null : tab.url, favicon: tab.faviconUrl, page: tab.kind === "human" && !shellPage };
    },
    hold: (groupId, tabs) => browser.holdLiveTabs(groupId, tabs),
    viewSize: (tabId) => browser.liveViewSize(tabId),
    send: (tabId, steps) => browser.sendLiveInput(tabId, steps),
    // As a press of the host's would: the window in use, its page holding the keyboard (one keyboard, shared) — but
    // only while the browser is the app in front: focusing a page on macOS brings its window forward, and a guest's
    // click must not pull the host out of another app.
    activate: (tabId) => void (window.isFocused() ? browser.focusTab(tabId) : browser.selectTab(tabId)),
    isShortcut: (key) => isAppShortcut(options.shortcuts(), process.platform === "darwin" ? "darwin" : "other", key),
  };
}
