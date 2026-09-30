/**
 * The browser a desk turn works in (docs/desk-agent.md §2): the person's
 * browser, cut down to one tab group. It lists only the group's tabs, opens
 * new ones into the group, and refuses a tab outside it — so "stay on the
 * desk" is the controller's rule, not only the prompt's. A tab the agent
 * opens (or a page opens on a click) joins the group and is brought out
 * onto the desk quietly, beside the window in use.
 */

import type { AgentTabInfo, BrowserBackend, PageInspection } from "@pistachio/agent-runtime";
import type { AgentPressableKey } from "@pistachio/protocol";

/** What the scope needs of the browser controller: the group, and a way to open a tab in it. */
export interface DeskScopeBrowser {
  tabGroupMembers(groupId: string): readonly string[] | null;
  openTabInGroup(groupId: string, url?: string): Promise<string | null>;
}

export class DeskScope implements BrowserBackend {
  readonly kind = "desktop" as const;
  readonly #inner: BrowserBackend;
  readonly #browser: DeskScopeBrowser;
  readonly #groupId: string;
  readonly #cameOut: (tabId: string) => void;

  /** `cameOut` is told of every tab that joined the group here, to bring it out onto the desk. */
  constructor(inner: BrowserBackend, browser: DeskScopeBrowser, groupId: string, cameOut: (tabId: string) => void) {
    this.#inner = inner;
    this.#browser = browser;
    this.#groupId = groupId;
    this.#cameOut = cameOut;
  }

  listTabs(): AgentTabInfo[] {
    const members = new Set(this.#members());
    return this.#inner.listTabs().filter((tab) => members.has(tab.id));
  }

  async openTab(url?: string): Promise<string> {
    const tabId = await this.#browser.openTabInGroup(this.#groupId, url);
    if (tabId === null) throw new Error("this desk's tab group is gone; the tab was not opened");
    this.#cameOut(tabId);
    return tabId;
  }

  async focusTab(tabId: string): Promise<void> {
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

  /**
   * A click that opens a page in a new tab opens it on the desk. The
   * browser put it in the group already — a page opened from one of the
   * group's tabs opens beside its opener (BrowserController's window-open
   * handler) — so only a new tab that is the group's comes out. A tab that
   * merely appeared while the click settled (the person's own, say) is
   * never taken in: which tab opened it is the browser's to know, not a
   * guess from what is new.
   */
  async click(tabId: string, target: string): Promise<void> {
    this.#require(tabId);
    const before = new Set(this.#inner.listTabs().map((tab) => tab.id));
    await this.#inner.click(tabId, target);
    const members = this.#members();
    for (const tab of this.#inner.listTabs()) if (!before.has(tab.id) && members.includes(tab.id)) this.#cameOut(tab.id);
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

  #require(tabId: string): void {
    if (this.#members().includes(tabId)) return;
    throw new Error(
      `tab ${tabId} is not on this desk. Only the desk's tabs can be used here: to use a page from elsewhere, ask the person, then open its address with tab_open (it joins the desk).`,
    );
  }
}
