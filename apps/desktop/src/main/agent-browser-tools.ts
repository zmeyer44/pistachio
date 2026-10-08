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
    ...(tab.hiddenFor === undefined ? {} : { hidden: true }),
  };
}

/**
 * The desktop's `BrowserBackend`: every operation targets a WebContentsView
 * in the person's own session and therefore keeps its cookies, storage,
 * authentication challenges, and live form state. Dispatch of model tool
 * calls is `executeBrowserTool` in the runtime; this class only drives.
 *
 * None of it moves the person, or shows them anything they did not ask to
 * see. A tab the agent opens is a hidden tab — out of their tabs, owned by
 * the conversation it was opened for (`owner`: the open run's id), closed
 * when that conversation is set aside — and so is a page the agent's own
 * click or key opens. Every operation works on a tab off screen
 * (BrowserController wakes a sleeping one without switching to it, and
 * gives a never-drawn page a real viewport first); only `focusTab` — the
 * model's `tab_show`, for "open…", "take me to…" — shows one, adding a
 * hidden tab to the person's tabs as it switches them to it.
 */
export class DesktopBrowserBackend implements BrowserBackend {
  readonly kind = "desktop" as const;
  readonly #browser: BrowserController;
  readonly #owner: () => string | null;

  constructor(browser: BrowserController, owner: () => string | null) {
    this.#browser = browser;
    this.#owner = owner;
  }

  /** The person's tabs (a working tab of theirs, like the read-aloud player's, is no page to use), then this conversation's hidden ones. */
  listTabs(): AgentTabInfo[] {
    const activeTabId = this.#browser.activeTab()?.id ?? null;
    const owner = this.#owner();
    return [
      ...this.#browser.allTabs().filter((tab) => !tab.unlisted),
      ...(owner === null ? [] : this.#browser.hiddenTabs(owner)),
    ].map((tab) => agentTabInfo(tab, activeTabId));
  }

  /** Hidden, in `spaceId` (a desk's group's: DeskScope), or else in the Space in view. */
  async openTab(url?: string, spaceId?: string): Promise<string> {
    const owner = this.#requireOwner();
    return spaceId === undefined ? this.#browser.openHiddenTab(owner, url) : this.#browser.openHiddenTab(owner, url, { spaceId });
  }

  /** `tab_show`: a hidden tab joins the person's tabs as they are switched to it (selectTab shows it). */
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
    await this.#popupsHidden(tabId, async () => {
      await this.#browser.clickPage(tabId, target);
      await this.#settle();
    });
  }

  async type(tabId: string, target: string, value: string): Promise<string> {
    return this.#popupsHidden(tabId, async () => {
      const written = await this.#browser.typePage(tabId, target, value);
      await this.#settle(180);
      return written;
    });
  }

  async press(tabId: string, key: AgentPressableKey): Promise<void> {
    const keyCode = PRESSABLE_KEY_CODES[key];
    if (keyCode === undefined)
      throw new Error(`unsupported key: ${key} (one of ${Object.keys(PRESSABLE_KEY_CODES).join(", ")})`);
    await this.#popupsHidden(tabId, async () => {
      // Only keys that produce input send a char event, matching a real press.
      await this.#browser.pressKeyPage(tabId, keyCode, key === "Enter" || key === "Tab");
      await this.#settle();
    });
  }

  async scroll(tabId: string, deltaY: number): Promise<void> {
    await this.#browser.scrollPage(tabId, deltaY);
    await this.#settle(180);
  }

  screenshot(tabId: string): Promise<string> {
    return this.#browser.screenshotPage(tabId);
  }

  /**
   * A page the agent's own input opens in a new tab — a target="_blank"
   * link, a window.open — opens hidden, as the agent's, even from one of
   * the person's tabs: the input and its settle are the agent's, and what
   * they open is its to show or not. The click's result names the new tab.
   */
  async #popupsHidden<T>(tabId: string, work: () => Promise<T>): Promise<T> {
    const owner = this.#owner();
    const release = owner === null ? null : this.#browser.holdPopupsHidden(tabId, owner);
    try {
      return await work();
    } finally {
      release?.();
    }
  }

  #requireOwner(): string {
    const owner = this.#owner();
    if (owner === null) throw new Error("no conversation is open to open a tab for");
    return owner;
  }

  async #settle(delay = 550): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay);
      timer.unref();
    });
  }
}
