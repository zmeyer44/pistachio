/**
 * The browser as an extension's scope reaches it (./scope.ts
 * ExtensionBrowserHost), over the window's BrowserController: the person's
 * listed tabs (never an agent's hidden one), each Profile's spaces, the
 * desk main knows of, the agent's own page reader and screenshot — and, for
 * capture and input (./capture.ts, ./input.ts), a tab's page view, its
 * holds, its stills and the OS pointer.
 */

import type { BrowserWindow, WebContents } from "electron";
import type { CursorPoint, PaneStill } from "@pistachio/shell-contracts/ipc";
import type { BrowserController } from "../browser-controller";
import type { ExtensionBrowserHost } from "./scope";

export interface ServiceBrowser extends ExtensionBrowserHost {
  /** Every Profile (code: Space) there is. */
  /** A listed tab's page while it has one (not asleep). */
  tabContents(tabId: string): WebContents | null;
  /** A tab's view in the window's content box (DIP), and whether it is shown; null without one. */
  tabView(tabId: string): { bounds: { x: number; y: number; width: number; height: number }; visible: boolean } | null;
  /** The tabs extensions hold now (BrowserController.holdExtensionTabs). */
  holdTabs(tabIds: readonly string[]): void;
  /** A tab's page woken and laid out for a capture; whether it has one. */
  wakeTab(tabId: string): Promise<boolean>;
  /** The size a tab's page is laid out at (DIP), for the capture's size. */
  captureSize(tabId: string): { width: number; height: number } | null;
  /** Stills of the desk's windows (the desk's own capture of them), at most `width` device px wide. */
  stills(tabIds: readonly string[], width: number): Promise<PaneStill[]>;
  /** The OS pointer in the window's content box (DIP), or null when it cannot be read (under Playwright, a hidden window). */
  pointer(): CursorPoint | null;
  /** Make a space of the Profile in front current (agent.ask fills that space's Bar). */
  selectSpace(spaceId: string): Promise<void>;
}

export function extensionBrowserHost(browser: BrowserController, window: BrowserWindow, profileIds: () => string[], pointer: () => CursorPoint | null): ServiceBrowser {
  return {
    activeProfileId: () => browser.activeSpaceId(),
    profileIds,
    tabs: () => browser.allTabs().filter((tab) => !tab.unlisted && tab.hiddenFor === undefined),
    tab: (tabId) => {
      const tab = browser.tab(tabId);
      return tab === null || tab.hiddenFor !== undefined || tab.unlisted ? null : tab;
    },
    activeTabId: () => browser.activeTab()?.id ?? null,
    spaces: (profileId) => [...browser.tabGroups(profileId), ...browser.looseTabGroups(profileId), ...browser.anchorTabGroups(profileId)],
    currentSpaceId: (profileId) => browser.currentGroupId(profileId),
    createTab: async (url, options) => {
      if (options.space === "new") {
        // A space of its own: a Home tab, grown into a space (ownSpace) — as Make it a space of its own does.
        const tabId = await browser.createTab(url, { spaceId: options.profileId, group: "loose", activate: options.activate });
        const group = browser.looseTabGroups(options.profileId).find((candidate) => candidate.tabIds.includes(tabId));
        if (group !== undefined) browser.ownSpace(group.id);
        return tabId;
      }
      return browser.createTab(url, { spaceId: options.profileId, group: options.space, activate: options.activate });
    },
    navigate: (tabId, url) => browser.navigate(tabId, url),
    showTab: (tabId) => browser.selectTab(tabId),
    closeTab: (tabId) => browser.closeTab(tabId),
    inspect: (tabId) => browser.inspectPage(tabId),
    screenshot: async (tabId) => {
      const dataUrl = await browser.screenshotPage(tabId);
      const comma = dataUrl.indexOf(",");
      return new Uint8Array(Buffer.from(comma < 0 ? "" : dataUrl.slice(comma + 1), "base64"));
    },
    desk: (profileId, spaceId) => browser.extensionDeskState(profileId, spaceId),
    tabContents: (tabId) => browser.extensionTabView(tabId)?.webContents ?? null,
    tabView: (tabId) => {
      const view = browser.extensionTabView(tabId);
      if (view === null) return null;
      const { x, y, width, height } = view.getBounds();
      return { bounds: { x, y, width, height }, visible: view.getVisible() && !window.isDestroyed() && window.isVisible() && !window.isMinimized() };
    },
    holdTabs: (tabIds) => browser.holdExtensionTabs(tabIds),
    wakeTab: (tabId) => browser.wakeExtensionTab(tabId),
    captureSize: (tabId) => browser.extensionCaptureSize(tabId),
    stills: (tabIds, width) => browser.captureTabStills(tabIds, width),
    pointer,
    selectSpace: (spaceId) => browser.selectGroup(spaceId),
  };
}
