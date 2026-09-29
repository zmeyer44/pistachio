/**
 * `executeBrowserTool`'s own words to the model about tabs: that a tab it
 * opens is in the background on the desktop, that `tab.show` is what puts a
 * tab in front of the person, and that a click which opened a tab names it.
 */

import { describe, expect, it, vi } from "vitest";
import { executeBrowserTool, type AgentTabInfo, type BrowserBackend } from "../src/index.js";

function tab(id: string, url: string): AgentTabInfo {
  return { id, spaceId: "work", title: "", url, loading: false, canGoBack: false, canGoForward: false, kind: "human" };
}

function stubBackend(kind: BrowserBackend["kind"], tabs: AgentTabInfo[]): BrowserBackend {
  return {
    kind,
    listTabs: () => [...tabs],
    openTab: vi.fn(async () => "tab-new"),
    focusTab: vi.fn(async () => undefined),
    navigate: vi.fn(async () => undefined),
    back: vi.fn(async () => undefined),
    forward: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    inspect: vi.fn(async () => ({ title: "", url: "", text: "", controls: [] })),
    click: vi.fn(async () => undefined),
    type: vi.fn(async () => ""),
    press: vi.fn(async () => undefined),
    scroll: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => ""),
  };
}

describe("tab dispatch", () => {
  it("tells the model a desktop tab opened in the background, and a cloud one just opened", async () => {
    const desktop = await executeBrowserTool(stubBackend("desktop", []), { name: "tab.open", url: "https://example.test/" });
    expect(desktop).toEqual({ summary: "Opened a new tab in the background", data: { tabId: "tab-new" } });
    const cloud = await executeBrowserTool(stubBackend("cloud", []), { name: "tab.open" });
    expect(cloud.summary).toBe("Opened a new tab");
  });

  it("puts a tab in front of the person only through tab.show", async () => {
    const backend = stubBackend("desktop", [tab("tab-1", "https://example.test/")]);
    const result = await executeBrowserTool(backend, { name: "tab.show", tabId: "tab-1" });
    expect(backend.focusTab).toHaveBeenCalledWith("tab-1");
    expect(result.data).toEqual({ tabId: "tab-1" });
    expect(result.summary).toContain("the person is looking at it now");
  });

  it("names the tab a click opened", async () => {
    const tabs = [tab("tab-1", "https://example.test/")];
    const backend = stubBackend("desktop", tabs);
    vi.mocked(backend.click).mockImplementation(async () => {
      tabs.push(tab("tab-2", "https://example.test/article"));
    });
    const result = await executeBrowserTool(backend, { name: "page.click", tabId: "tab-1", target: "Read more" });
    expect(result.summary).toBe("Clicked Read more; it opened a new tab: tab-2 (https://example.test/article)");
    expect(result.data).toEqual({ openedTabIds: ["tab-2"] });
  });

  it("says only what was clicked when the click opened nothing", async () => {
    const result = await executeBrowserTool(stubBackend("desktop", [tab("tab-1", "https://example.test/")]), {
      name: "page.click",
      tabId: "tab-1",
      target: "#go",
    });
    expect(result).toEqual({ summary: "Clicked #go" });
  });
});
