/**
 * Opening and leaving a desk (src/lib/desk/store.ts). In the sidebar layout
 * the sidebar is put away while a desk is up, and the desk waits for it to
 * go (`opening`) before it opens over the whole row; leaving before it has
 * opened cancels it.
 */

import { afterEach, describe, expect, it } from "vitest";
import { passedEntry, sanitizeSaved, useDeskStore } from "../src/lib/desk/store";

afterEach(() => useDeskStore.setState({ groupId: null, opening: null, leaving: false }));

describe("passing a desk to another group", () => {
  it("keeps the same desk: the group changes, the instance does not", () => {
    useDeskStore.getState().open("g1");
    const { instance } = useDeskStore.getState();
    useDeskStore.getState().switchTo("g2");
    expect(useDeskStore.getState()).toMatchObject({ groupId: "g2", instance, leaving: false });
  });

  it("does nothing with no desk up, or one on its way out", () => {
    useDeskStore.getState().switchTo("g2");
    expect(useDeskStore.getState().groupId).toBeNull();
    useDeskStore.getState().open("g1");
    useDeskStore.getState().leave();
    useDeskStore.getState().switchTo("g2");
    expect(useDeskStore.getState().groupId).toBe("g1");
  });

  it("opens a desk afresh as a new instance", () => {
    const before = useDeskStore.getState().instance;
    useDeskStore.getState().open("g1");
    expect(useDeskStore.getState().instance).toBe(before + 1);
  });
});

describe("the tab a desk passed to a group comes up on", () => {
  const tabs = [
    { id: "a", lastActiveAt: 30 },
    { id: "b", lastActiveAt: 10 },
    { id: "c", lastActiveAt: 20 },
  ];
  const at = { x: 0.1, y: 0.1, w: 0.4, h: 0.4 };

  it("is its top window as it was left", () => {
    expect(passedEntry([{ tabId: "b", rect: at }, { tabId: "c", rect: at }], tabs)).toBe("c");
  });

  it("passes over windows whose tabs are no longer the group's", () => {
    expect(passedEntry([{ tabId: "b", rect: at }, { tabId: "gone", rect: at }], tabs)).toBe("b");
  });

  it("with none left, is its tab used last — or, with no tabs, none", () => {
    expect(passedEntry([{ tabId: "gone", rect: at }], tabs)).toBe("a");
    expect(passedEntry([], [])).toBeNull();
  });
});

describe("opening a desk", () => {
  it("opens at once where there is no sidebar to wait for", () => {
    useDeskStore.getState().open("g1");
    expect(useDeskStore.getState()).toMatchObject({ groupId: "g1", opening: null });
  });

  it("waits for the sidebar to go, and opens once it has", () => {
    useDeskStore.getState().open("g1", { afterSidebar: true });
    expect(useDeskStore.getState()).toMatchObject({ groupId: null, opening: "g1" });
    useDeskStore.getState().sidebarGone();
    expect(useDeskStore.getState()).toMatchObject({ groupId: "g1", opening: null, leaving: false });
    // Nothing waiting: the sidebar going again changes nothing.
    useDeskStore.getState().sidebarGone();
    expect(useDeskStore.getState().groupId).toBe("g1");
  });

  it("left while it waits, never opens", () => {
    useDeskStore.getState().open("g1", { afterSidebar: true });
    useDeskStore.getState().leave();
    expect(useDeskStore.getState()).toMatchObject({ groupId: null, opening: null, leaving: false });
    useDeskStore.getState().sidebarGone();
    expect(useDeskStore.getState().groupId).toBeNull();
  });

  it("leaves with its closing motion, or at once", () => {
    useDeskStore.getState().open("g1");
    useDeskStore.getState().leave();
    expect(useDeskStore.getState()).toMatchObject({ groupId: "g1", leaving: true });
    useDeskStore.getState().finishLeave();
    expect(useDeskStore.getState()).toMatchObject({ groupId: null, leaving: false });
    useDeskStore.getState().open("g2");
    useDeskStore.getState().leave({ immediate: true });
    expect(useDeskStore.getState()).toMatchObject({ groupId: null, leaving: false });
  });
});

describe("a saved desk", () => {
  const rect = { x: 0.1, y: 0.1, w: 0.3, h: 0.3 };
  const mask = { x: 10, y: 20, width: 300, height: 200, pageWidth: 900, pageHeight: 700 };

  it("keeps a window's mask, and drops one that does not hold up, the window kept whole", () => {
    const saved = sanitizeSaved({
      g1: {
        windows: [
          { tabId: "a", rect, mask },
          { tabId: "b", rect, mask: { ...mask, width: 5000 } },
          { tabId: "c", rect },
        ],
      },
    });
    expect(saved["g1"]!.windows).toEqual([{ tabId: "a", rect, mask }, { tabId: "b", rect }, { tabId: "c", rect }]);
  });
});
