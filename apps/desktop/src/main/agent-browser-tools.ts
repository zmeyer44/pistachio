import type { AgentTabInfo, BrowserBackend, PageInspection } from "@pistachio/agent-runtime";
import type { AgentPressableKey } from "@pistachio/protocol";
import type { BrowserTabInfo } from "@pistachio/shell-contracts/ipc";
import { BrowserController } from "./browser-controller";

/** page.press keys by the keyCode Chromium's input pipeline knows them as. */
const PRESSABLE_KEY_CODES: Record<AgentPressableKey, string> = {
  Enter: "Return",
  Tab: "Tab",
  Escape: "Escape",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Home: "Home",
  End: "End",
};

/** What the agent learns about a tab: the fields of `BrowserTabInfo` it acts on. */
function agentTabInfo(tab: BrowserTabInfo, activeTabId: string | null): AgentTabInfo {
  return {
    id: tab.id,
    spaceId: tab.spaceId,
    title: tab.title,
    url: tab.url,
    loading: tab.loading,
    canGoBack: tab.canGoBack,
    canGoForward: tab.canGoForward,
    kind: tab.kind,
    active: tab.id === activeTabId,
  };
}

/**
 * The desktop's `BrowserBackend`: every operation targets the person's
 * existing WebContentsView and therefore keeps its cookies, storage,
 * authentication challenges, and live form state. Dispatch of model tool
 * calls is `executeBrowserTool` in the runtime; this class only drives.
 *
 * None of it moves the person. A tab the agent opens opens behind the one
 * they are looking at, and every operation works on a tab off screen
 * (BrowserController wakes a sleeping one without switching to it, and
 * gives a never-drawn page a real viewport first); only `focusTab` — the
 * model's `tab_show`, for "take me to…" — switches tabs.
 */
export class DesktopBrowserBackend implements BrowserBackend {
  readonly kind = "desktop" as const;
  readonly #browser: BrowserController;

  constructor(browser: BrowserController) {
    this.#browser = browser;
  }

  listTabs(): AgentTabInfo[] {
    const activeTabId = this.#browser.activeTab()?.id ?? null;
    return this.#browser.allTabs().map((tab) => agentTabInfo(tab, activeTabId));
  }

  async openTab(url?: string): Promise<string> {
    return this.#browser.createTab(url, { activate: false });
  }

  async focusTab(tabId: string): Promise<void> {
    await this.#browser.selectTab(tabId);
  }

  async navigate(tabId: string, url: string): Promise<void> {
    await this.#browser.navigate(tabId, url);
  }

  async back(tabId: string): Promise<void> {
    await this.#browser.goBack(tabId);
    await this.#settle();
  }

  async forward(tabId: string): Promise<void> {
    await this.#browser.goForward(tabId);
    await this.#settle();
  }

  async reload(tabId: string): Promise<void> {
    await this.#browser.reload(tabId);
    await this.#settle();
  }

  inspect(tabId: string): Promise<PageInspection> {
    return this.#browser.inspectPage(tabId);
  }

  async click(tabId: string, target: string): Promise<void> {
    await this.#browser.clickPage(tabId, target);
    await this.#settle();
  }

  async type(tabId: string, target: string, value: string): Promise<string> {
    const written = await this.#browser.typePage(tabId, target, value);
    await this.#settle(180);
    return written;
  }

  async press(tabId: string, key: AgentPressableKey): Promise<void> {
    const keyCode = PRESSABLE_KEY_CODES[key];
    if (keyCode === undefined)
      throw new Error(`unsupported key: ${key} (one of ${Object.keys(PRESSABLE_KEY_CODES).join(", ")})`);
    // Only keys that produce input send a char event, matching a real press.
    await this.#browser.pressKeyPage(tabId, keyCode, key === "Enter" || key === "Tab");
    await this.#settle();
  }

  async scroll(tabId: string, deltaY: number): Promise<void> {
    await this.#browser.scrollPage(tabId, deltaY);
    await this.#settle(180);
  }

  screenshot(tabId: string): Promise<string> {
    return this.#browser.screenshotPage(tabId);
  }

  async #settle(delay = 550): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay);
      timer.unref();
    });
  }
}
