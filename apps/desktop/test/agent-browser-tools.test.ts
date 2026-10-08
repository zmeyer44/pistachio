/**
 * The desktop's browser backend (src/main/agent-browser-tools.ts): what the
 * agent sees of the person's tabs and its own hidden ones, where a tab it
 * opens goes, how a hidden tab is shown, and that a page its own click
 * opens is held hidden for the conversation.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserTabInfo } from "@pistachio/shell-contracts/ipc";
import { DesktopBrowserBackend } from "../src/main/agent-browser-tools";
import type { BrowserController } from "../src/main/browser-controller";

function tab(id: string, extra: Partial<BrowserTabInfo> = {}): BrowserTabInfo {
  return {
    id,
    spaceId: "work",
    title: id,
    url: `https://${id}.example/`,
    faviconUrl: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    kind: "human",
    runId: null,
    anchorId: null,
    lifecycle: "live",
    lastActiveAt: 1,
    unlisted: false,
    ...extra,
  };
}

function harness(owner: string | null = "run-1") {
  const events: string[] = [];
  const hidden = [tab("research", { unlisted: true, hiddenFor: "run-1" }), tab("elsewhere", { unlisted: true, hiddenFor: "run-2" })];
  const browser = {
    // The person's tabs, in order: their page, and the read-aloud player's working tab.
    allTabs: vi.fn(() => [tab("mine"), tab("player", { unlisted: true })]),
    activeTab: vi.fn(() => tab("mine")),
    hiddenTabs: vi.fn((who?: string) => hidden.filter((item) => who === undefined || item.hiddenFor === who)),
    openHiddenTab: vi.fn(async () => "fresh"),
    selectTab: vi.fn(async () => undefined),
    clickPage: vi.fn(async () => {
      events.push("click");
    }),
    holdPopupsHidden: vi.fn((tabId: string, who: string) => {
      events.push(`hold ${tabId} for ${who}`);
      return () => events.push(`release ${tabId}`);
    }),
  };
  const backend = new DesktopBrowserBackend(browser as unknown as BrowserController, () => owner);
  return { backend, browser, events };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the desktop's browser backend", () => {
  it("lists the person's tabs and this conversation's hidden ones, marked hidden — never a working tab or another conversation's", () => {
    const { backend } = harness();
    expect(backend.listTabs().map((item) => [item.id, item.active, item.hidden])).toEqual([
      ["mine", true, undefined],
      ["research", false, true],
    ]);
  });

  it("opens a tab hidden, for the conversation open now, and refuses with none open", async () => {
    const { backend, browser } = harness();
    await expect(backend.openTab("https://air.example/")).resolves.toBe("fresh");
    expect(browser.openHiddenTab).toHaveBeenCalledWith("run-1", "https://air.example/");
    // A desk's turn names its group's Space (DeskScope).
    await backend.openTab("https://air.example/", "home");
    expect(browser.openHiddenTab).toHaveBeenLastCalledWith("run-1", "https://air.example/", { spaceId: "home" });
    await expect(harness(null).backend.openTab("https://air.example/")).rejects.toThrow(/no conversation/);
  });

  it("shows a tab by selecting it, which makes a hidden one the person's", async () => {
    const { backend, browser } = harness();
    await backend.focusTab("research");
    expect(browser.selectTab).toHaveBeenCalledWith("research");
  });

  it("holds what the agent's own click opens hidden until the click has settled", async () => {
    vi.useFakeTimers();
    const { backend, events } = harness();
    const clicked = backend.click("mine", "Read more");
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(["hold mine for run-1", "click"]);
    await vi.advanceTimersByTimeAsync(600);
    await clicked;
    expect(events).toEqual(["hold mine for run-1", "click", "release mine"]);
  });
});
