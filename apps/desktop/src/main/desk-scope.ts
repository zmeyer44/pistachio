/**
 * The browser a desk turn works in (docs/desk-agent.md §2): the person's
 * browser, cut down to one tab group and the agent's own hidden tabs. It
 * lists only those, and refuses any other tab — so "stay on the desk" is
 * the controller's rule, not only the prompt's. A tab the agent opens is
 * hidden, as everywhere (agent-browser-tools.ts): the desk stays as the
 * person has it while the agent looks things up. Only `tab_show` puts one
 * on the desk — it joins the group and is brought out quietly, beside the
 * window in use.
 */

import type { AgentTabInfo, BrowserBackend, PageInspection } from "@pistachio/agent-runtime";
import type { AgentPressableKey } from "@pistachio/protocol";

/** What the scope needs of the browser controller: the group, its Space, and a way to put a hidden tab in it. */
export interface DeskScopeBrowser {
  tabGroupMembers(groupId: string): readonly string[] | null;
  /** The Space a group lives in, or null when it is gone. */
  tabGroupSpaceId(groupId: string): string | null;
  /** Show the agent's hidden tab in a group: false when the tab is not hidden or the group is gone. */
  showHiddenTabInGroup(groupId: string, tabId: string): boolean;
}

/** The desktop's backend, whose new tabs can be opened in a given Space (DesktopBrowserBackend). */
export interface DeskScopeInner extends BrowserBackend {
  openTab(url?: string, spaceId?: string): Promise<string>;
}

export class DeskScope implements BrowserBackend {
  readonly kind = "desktop" as const;
  readonly #inner: DeskScopeInner;
  readonly #browser: DeskScopeBrowser;
  readonly #groupId: string;
  readonly #cameOut: (tabId: string) => void;

  /** `cameOut` is told of every tab that joined the group here, to bring it out onto the desk. */
  constructor(inner: DeskScopeInner, browser: DeskScopeBrowser, groupId: string, cameOut: (tabId: string) => void) {
    this.#inner = inner;
    this.#browser = browser;
    this.#groupId = groupId;
    this.#cameOut = cameOut;
  }

  listTabs(): AgentTabInfo[] {
    const members = new Set(this.#members());
    return this.#inner.listTabs().filter((tab) => members.has(tab.id) || tab.hidden === true);
  }

  /** Hidden, in the group's Space — its session — whichever Space the person has gone on to since the turn began. */
  async openTab(url?: string): Promise<string> {
    const spaceId = this.#browser.tabGroupSpaceId(this.#groupId);
    if (spaceId === null) throw new Error("this space is gone; the tab was not opened");
    return this.#inner.openTab(url, spaceId);
  }

  /** `tab_show`: a hidden tab joins the group and comes out onto the desk; one of the group's is switched to, as before. */
  async focusTab(tabId: string): Promise<void> {
    if (this.#hidden(tabId)) {
      if (!this.#browser.showHiddenTabInGroup(this.#groupId, tabId)) throw new Error("this space is gone; the page was not shown");
      this.#cameOut(tabId);
      return;
    }
    this.#require(tabId);
    await this.#inner.focusTab(tabId);
  }

  async navigate(tabId: string, url: string): Promise<void> {
    this.#require(tabId);
    await this.#inner.navigate(tabId, url);
  }

  async back(tabId: string): Promise<void> {
    this.#require(tabId);
    await this.#inner.back(tabId);
  }

  async forward(tabId: string): Promise<void> {
    this.#require(tabId);
    await this.#inner.forward(tabId);
  }

  async reload(tabId: string): Promise<void> {
    this.#require(tabId);
    await this.#inner.reload(tabId);
  }

  async inspect(tabId: string): Promise<PageInspection> {
    this.#require(tabId);
    return this.#inner.inspect(tabId);
  }

  /** A page the click opens in a new tab opens hidden (the inner backend's): named in the click's result, on the desk only by tab_show. */
  async click(tabId: string, target: string): Promise<void> {
    this.#require(tabId);
    await this.#inner.click(tabId, target);
  }

  async type(tabId: string, target: string, value: string): Promise<string> {
    this.#require(tabId);
    return this.#inner.type(tabId, target, value);
  }

  async press(tabId: string, key: AgentPressableKey): Promise<void> {
    this.#require(tabId);
    await this.#inner.press(tabId, key);
  }

  async scroll(tabId: string, deltaY: number): Promise<void> {
    this.#require(tabId);
    await this.#inner.scroll(tabId, deltaY);
  }

  async screenshot(tabId: string): Promise<string> {
    this.#require(tabId);
    return this.#inner.screenshot(tabId);
  }

  #members(): readonly string[] {
    return this.#browser.tabGroupMembers(this.#groupId) ?? [];
  }

  #hidden(tabId: string): boolean {
    return this.#inner.listTabs().some((tab) => tab.id === tabId && tab.hidden === true);
  }

  #require(tabId: string): void {
    if (this.#members().includes(tabId) || this.#hidden(tabId)) return;
    throw new Error(
      `tab ${tabId} is not on this desk. Only the desk's tabs and your hidden ones can be used here: to use a page from elsewhere, ask the person, then open its address with tab_open (it opens hidden).`,
    );
  }
}
