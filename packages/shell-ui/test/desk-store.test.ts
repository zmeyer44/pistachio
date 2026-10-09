/**
 * The desk's own state (src/lib/desk/store.ts): since 2026-10-09 it holds
 * no space of its own — main's current space is the snapshot's — only the
 * arrangements, the Feel, and the boot instance. What it reads back, and
 * the tab a space's desk comes up on when the desk passes to it.
 */

import { describe, expect, it } from "vitest";
import type { BrowserTabInfo, ShellSnapshot } from "@pistachio/shell-contracts/ipc";
import { deskGroups, isDayTab, passedEntry, readPersistedDesk, sanitizeSaved, useDeskStore } from "../src/lib/desk/store";

describe("the desk's store", () => {
  it("names no space: the desk shows main's current one (ShellSnapshot.currentGroupId)", () => {
    const state = useDeskStore.getState() as unknown as Record<string, unknown>;
    for (const gone of ["groupId", "opening", "leaving", "open", "leave", "finishLeave", "switchTo", "sidebarReady"]) expect(state).not.toHaveProperty(gone);
    expect(typeof state["instance"]).toBe("number");
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

  it("drops a page's own desk (`tab:<id>`, saved before 2026-10-09): every listed tab is in a space now", () => {
    const saved = sanitizeSaved({ "tab:page": { windows: [{ tabId: "page", rect }] }, g1: { windows: [{ tabId: "a", rect }] } });
    expect(Object.keys(saved)).toEqual(["g1"]);
    const persisted = readPersistedDesk(JSON.stringify({ version: 2, saved: { "tab:page": { windows: [{ tabId: "page", rect }] } } }));
    expect(persisted.saved).toEqual({});
  });
});

describe("the desks a tab can be on", () => {
  const snapshot = {
    activeSpaceId: "s1",
    tabs: [],
    tabGroups: [{ id: "g1", tabIds: ["grouped"] }],
    looseGroups: [{ id: "g2", tabIds: ["loose"], loose: true }],
  } as unknown as ShellSnapshot;
  const tab = (fields: Partial<BrowserTabInfo>): BrowserTabInfo => ({ kind: "human", unlisted: false, anchorId: null, ...fields }) as BrowserTabInfo;

  it("are the groups drawn and the loose tabs' alike", () => {
    expect(deskGroups(snapshot).map((group) => group.id)).toEqual(["g1", "g2"]);
    expect(deskGroups({ ...snapshot, looseGroups: undefined })).toBe(snapshot.tabGroups);
    expect(deskGroups(null)).toEqual([]);
  });

  it("for a day tab, a group's; not a favorite's or a pinned page's tab (a page's group's), an agent's or an unlisted one", () => {
    expect(isDayTab(tab({}))).toBe(true);
    expect(isDayTab(tab({ anchorId: "fav-1" }))).toBe(false);
    expect(isDayTab(tab({ kind: "agent" }))).toBe(false);
    expect(isDayTab(tab({ unlisted: true }))).toBe(false);
  });
});
