import { describe, expect, it } from "vitest";
import { chromeTabs, chromeTabsSharing } from "../src/lib/chrome-tabs";
import type { BrowserTabInfo, ShellSnapshot } from "@pistachio/shell-contracts/ipc";
import { DEFAULT_SIDEBAR_STATE } from "@pistachio/shell-contracts/sidebar";

function tab(id: string, overrides: Partial<BrowserTabInfo> = {}): BrowserTabInfo {
  return {
    id,
    spaceId: "space",
    title: id.toUpperCase(),
    url: `https://${id}.example`,
    faviconUrl: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    kind: "human",
    runId: null,
    lifecycle: "live",
    lastActiveAt: 0,
    unlisted: false,
    anchorId: null,
    ...overrides,
  };
}

function snapshot(tabs: BrowserTabInfo[], overrides: Partial<ShellSnapshot> = {}): ShellSnapshot {
  return {
    spaces: [],
    activeSpaceId: "space",
    tabs,
    activeTabId: tabs[0]?.id ?? null,
    visibleTabIds: tabs[0] === undefined ? [] : [tabs[0].id],
    wakingTabIds: [],
    secondaryTabId: null,
    splitMode: "single",
    splitGroups: [],
    tabGroups: [],
    run: null,
    threads: [],
    sidebar: DEFAULT_SIDEBAR_STATE,
    ...overrides,
  };
}

describe("chromeTabsSharing", () => {
  it("returns the previous rows when nothing changed", () => {
    const a = tab("a");
    const b = tab("b");
    const first = chromeTabs(snapshot([a, b]));
    const second = chromeTabsSharing(snapshot([a, b]), first);
    expect(second).toBe(first);
  });

  it("keeps the row of a tab whose info did not change when another tab changed", () => {
    const a = tab("a");
    const b = tab("b");
    const first = chromeTabs(snapshot([a, b]));
    const second = chromeTabsSharing(snapshot([a, { ...b, title: "Changed" }]), first);
    expect(second).not.toBe(first);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    expect(second[1]?.title).toBe("Changed");
  });

  it("rebuilds a row whose role changed even though its info did not", () => {
    const a = tab("a");
    const b = tab("b");
    const first = chromeTabs(snapshot([a, b]));
    const second = chromeTabsSharing(snapshot([a, b], { activeTabId: "b", visibleTabIds: ["b"] }), first);
    expect(second[0]).not.toBe(first[0]);
    expect(second[0]?.active).toBe(false);
    expect(second[1]?.active).toBe(true);
  });

  it("rebuilds the list when a tab is added, removed, or reordered", () => {
    const a = tab("a");
    const b = tab("b");
    const first = chromeTabs(snapshot([a, b]));
    expect(chromeTabsSharing(snapshot([a]), first)).toHaveLength(1);
    expect(chromeTabsSharing(snapshot([a, b, tab("c")]), first)).toHaveLength(3);
    const reordered = chromeTabsSharing(snapshot([b, a], { activeTabId: "a", visibleTabIds: ["a"] }), first);
    expect(reordered).not.toBe(first);
    expect(reordered.map((row) => row.id)).toEqual(["b", "a"]);
    // The rows themselves are the ones we had; only their order is new.
    expect(reordered[1]).toBe(first[0]);
    expect(reordered[0]).toBe(first[1]);
  });
});
