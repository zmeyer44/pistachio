/**
 * The browser the agent drives, behind one interface for both executors:
 * the desktop's Electron `WebContentsView`s and the cloud browser's
 * Playwright pages. The runner never knows which it has; the model-facing
 * vocabulary (`BrowserAgentToolRequest`) is dispatched by
 * `executeBrowserTool`, which backends do not implement themselves.
 */

import type { AgentPressableKey, BrowserAgentToolRequest, BrowserAgentToolResult } from "@pistachio/protocol";

export interface PageControl {
  role: string;
  name: string;
  selector: string;
  href: string | null;
  type: string | null;
  value: string | null;
  disabled: boolean;
}

/** A compact, semantic view of a live page: what `INSPECT_PAGE_SCRIPT` returns. */
export interface PageInspection {
  title: string;
  url: string;
  text: string;
  controls: PageControl[];
}

/** What the agent learns about a tab from `tabs.list`. */
export interface AgentTabInfo {
  id: string;
  spaceId: string;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  kind: "human" | "agent";
  /**
   * True on the tab the person is looking at, which the agent leaves as it
   * is unless asked. The desktop knows it; the cloud browser leaves it out
   * (a run's pages are watched through a live view that follows the agent,
   * and which tab a person has in front is its session host's to know).
   */
  active?: boolean;
  /**
   * True on a tab the agent opened for itself on the desktop: a hidden tab,
   * out of the person's sight — not among their tabs, not on a desk —
   * until `focusTab` shows it to them. Absent on the person's own tabs and
   * on the cloud browser, whose tabs are all the run's.
   */
  hidden?: boolean;
}

export interface BrowserBackend {
  readonly kind: "desktop" | "cloud";
  listTabs(): AgentTabInfo[];
  /**
   * Open a tab for the agent to work in. The desktop opens a hidden tab —
   * the person never sees it, and every other operation here works on it
   * off screen — so searching and browsing leave the person's browser as
   * it was. The cloud browser makes it the run's front tab, which is what
   * its live view follows.
   */
  openTab(url?: string): Promise<string>;
  /**
   * Bring a tab to the front (`tab_show`). On the desktop that is showing
   * the person a page: a hidden tab joins their tabs, and they are switched
   * to it — or, at a desk, it comes out onto the desk.
   */
  focusTab(tabId: string): Promise<void>;
  navigate(tabId: string, url: string): Promise<void>;
  back(tabId: string): Promise<void>;
  forward(tabId: string): Promise<void>;
  reload(tabId: string): Promise<void>;
  inspect(tabId: string): Promise<PageInspection>;
  /** target = CSS selector or visible label. Rejects with Error("page control not found: <target>"). */
  click(tabId: string, target: string): Promise<void>;
  /** Resolves to the control's contents read back after typing. */
  type(tabId: string, target: string, value: string): Promise<string>;
  press(tabId: string, key: AgentPressableKey): Promise<void>;
  scroll(tabId: string, deltaY: number): Promise<void>;
  /** PNG data URL. */
  screenshot(tabId: string): Promise<string>;
}

/** The single dispatch point for model/runtime browser tool calls. */
export async function executeBrowserTool(backend: BrowserBackend, request: BrowserAgentToolRequest): Promise<BrowserAgentToolResult> {
  switch (request.name) {
    case "tabs.list": {
      const tabs = backend.listTabs();
      return { summary: `${String(tabs.length)} tabs available`, data: { tabs } };
    }
    case "tab.open": {
      const tabId = await backend.openTab(request.url);
      return { summary: backend.kind === "desktop" ? "Opened a hidden tab, out of the person's sight" : "Opened a new tab", data: { tabId } };
    }
    case "tab.show":
      await backend.focusTab(request.tabId);
      return {
        summary: backend.kind === "desktop" ? "Showed the tab to the person; it is one of their tabs now" : "Brought the tab to the front; the person is looking at it now",
        data: { tabId: request.tabId },
      };
    case "page.inspect": {
      const page = await backend.inspect(request.tabId);
      return { summary: `Inspected ${page.title}`, data: page };
    }
    case "page.navigate":
      await backend.navigate(request.tabId, request.url);
      return { summary: `Navigated to ${request.url}` };
    case "page.back":
      await backend.back(request.tabId);
      return { summary: "Went back" };
    case "page.forward":
      await backend.forward(request.tabId);
      return { summary: "Went forward" };
    case "page.reload":
      await backend.reload(request.tabId);
      return { summary: "Reloaded page" };
    case "page.click": {
      // A link or control that opens a page in a new tab leaves the agent
      // on the old one; the result names the new tab so it can carry on
      // there without listing the tabs to find it.
      const before = new Set(backend.listTabs().map((tab) => tab.id));
      await backend.click(request.tabId, request.target);
      const opened = backend.listTabs().filter((tab) => !before.has(tab.id));
      if (opened.length === 0) return { summary: `Clicked ${request.target}` };
      const named = opened.map((tab) => `${tab.id} (${tab.url})`).join(", ");
      return {
        summary: `Clicked ${request.target}; it opened ${opened.length === 1 ? "a new tab" : "new tabs"}: ${named}`,
        data: { openedTabIds: opened.map((tab) => tab.id) },
      };
    }
    case "page.type": {
      const written = await backend.type(request.tabId, request.target, request.value);
      const shown = written.length > 120 ? `${written.slice(0, 120)}…` : written;
      return {
        summary: `Typed into ${request.target}; the control now contains ${JSON.stringify(shown)}`,
        data: { value: written },
      };
    }
    case "page.press":
      await backend.press(request.tabId, request.key);
      return { summary: `Pressed ${request.key}` };
    case "page.scroll":
      await backend.scroll(request.tabId, request.deltaY);
      return { summary: `Scrolled ${String(Math.round(request.deltaY))} pixels` };
    case "page.screenshot": {
      const dataUrl = await backend.screenshot(request.tabId);
      return { summary: "Captured page screenshot", data: { dataUrl } };
    }
  }
}
