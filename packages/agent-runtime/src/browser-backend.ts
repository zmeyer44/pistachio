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
}

export interface BrowserBackend {
  readonly kind: "desktop" | "cloud";
  listTabs(): AgentTabInfo[];
  openTab(url?: string): Promise<string>;
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
      return { summary: "Opened a new tab", data: { tabId } };
    }
    case "tab.focus":
      await backend.focusTab(request.tabId);
      return { summary: "Focused tab", data: { tabId: request.tabId } };
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
    case "page.click":
      await backend.click(request.tabId, request.target);
      return { summary: `Clicked ${request.target}` };
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
