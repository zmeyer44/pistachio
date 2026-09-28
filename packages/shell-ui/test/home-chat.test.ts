/**
 * A home tab's chat when the agent takes the tab (docs/home-chat.md §2): a
 * browse turn works in the person's tab and may navigate it off the home
 * page, which unmounts the page drawing the chat. The store opens the
 * sidebar on that step (`homeChatLeftHome`), so the conversation stays in
 * view — and only on that step, so a sidebar closed afterwards stays closed.
 */

import { afterEach, describe, expect, it } from "vitest";
import { HOME_PAGE_URL } from "@pistachio/shell-contracts/home";
import type { ShellSnapshot, ShellTabsSnapshot } from "@pistachio/shell-contracts/ipc";
import type { RunSummary, TaskStatus } from "@pistachio/protocol";
import { setShellApi, type ShellApiBridge } from "../src/api";
import { homeChatLeftHome } from "../src/lib/home";
import { useAppStore } from "../src/store";

const SHOP = "https://shop.example/";

function tabs(...entries: Array<[id: string, url: string]>): Array<{ id: string; url: string }> {
  return entries.map(([id, url]) => ({ id, url }));
}

function run(status: TaskStatus = "running", runId = "run-1"): Pick<RunSummary, "runId" | "status"> {
  return { runId, status };
}

describe("homeChatLeftHome", () => {
  const chats = { "tab-1": { runId: "run-1" } };
  const before = { tabs: tabs(["tab-1", HOME_PAGE_URL]) };

  it("is the step a live chat's tab takes off the home page", () => {
    expect(homeChatLeftHome(before, { tabs: tabs(["tab-1", SHOP]), run: run() }, chats)).toBe(true);
    expect(homeChatLeftHome(before, { tabs: tabs(["tab-1", SHOP]), run: run("waiting_for_approval") }, chats)).toBe(true);
  });

  it("is not a tab already off home, nor one still on it", () => {
    // Every later publish while the agent works: the sidebar the person closed stays closed.
    expect(homeChatLeftHome({ tabs: tabs(["tab-1", SHOP]) }, { tabs: tabs(["tab-1", "https://shop.example/cart"]), run: run() }, chats)).toBe(false);
    expect(homeChatLeftHome(before, { tabs: tabs(["tab-1", HOME_PAGE_URL]), run: run() }, chats)).toBe(false);
    expect(homeChatLeftHome(null, { tabs: tabs(["tab-1", SHOP]), run: run() }, chats)).toBe(false);
  });

  it("is not a finished run, another run, a pending ask, or a tab with no chat", () => {
    const after = { tabs: tabs(["tab-1", SHOP]), run: run() };
    for (const status of ["completed", "rejected", "revoked", "failed"] as const) {
      expect(homeChatLeftHome(before, { ...after, run: run(status) }, chats)).toBe(false);
    }
    expect(homeChatLeftHome(before, { ...after, run: run("running", "run-2") }, chats)).toBe(false);
    expect(homeChatLeftHome(before, { ...after, run: null }, chats)).toBe(false);
    expect(homeChatLeftHome(before, after, { "tab-1": { runId: null } })).toBe(false);
    expect(homeChatLeftHome(before, after, { "tab-2": { runId: "run-1" } })).toBe(false);
  });

  it("is not a closed tab", () => {
    expect(homeChatLeftHome(before, { tabs: [], run: run() }, chats)).toBe(false);
  });
});

/* ------------------------------ in the store ----------------------------- */

const SNAPSHOT = {
  spaces: [{ id: "space-1", name: "Personal", color: "#8fbf6a", parentSpaceId: null, cloudEnabled: true }],
  activeSpaceId: "space-1",
  tabs: [{ id: "tab-1", url: HOME_PAGE_URL, title: "Home" }],
  activeTabId: "tab-1",
  visibleTabIds: ["tab-1"],
  wakingTabIds: [],
  splitGroups: [],
  recentlyClosed: null,
  sidebar: { pinned: [], favorites: [], folders: [], presets: [], collapsed: [] },
  run: { runId: "run-1", status: "running", messages: [], toolCalls: [] },
  threads: [],
} as unknown as ShellSnapshot;

/**
 * A host that answers the snapshot, refuses every other getter (the store
 * has a default for each), and hands back every subscription so the test
 * can publish on the tab channel.
 */
function host(): { publishTabs(tabs: ShellTabsSnapshot): void } {
  const listeners = new Map<string, (value: unknown) => void>();
  const api = new Proxy(
    {},
    {
      get: (_target, member) => {
        if (typeof member !== "string") return undefined;
        if (member === "getSnapshot") return () => Promise.resolve(SNAPSHOT);
        if (member.startsWith("get")) return () => Promise.reject(new Error("not asked"));
        if (member.startsWith("on"))
          return (listener: (value: unknown) => void) => {
            listeners.set(member, listener);
            return () => listeners.delete(member);
          };
        return undefined;
      },
    },
  );
  setShellApi(api as unknown as ShellApiBridge);
  return { publishTabs: (tabs) => listeners.get("onSnapshot")?.(tabs) };
}

function tabsWith(url: string): ShellTabsSnapshot {
  const { run: _run, threads: _threads, ...rest } = SNAPSHOT;
  return { ...rest, tabs: [{ ...SNAPSHOT.tabs[0]!, url }] } as ShellTabsSnapshot;
}

let dispose: (() => void) | null = null;

afterEach(() => {
  dispose?.();
  dispose = null;
  setShellApi({} as unknown as ShellApiBridge);
  useAppStore.setState({ snapshot: null, consoleOpen: false, homeChats: {} });
});

describe("a home tab the agent navigates away", () => {
  it("opens the sidebar on the conversation, with no home page mounted to do it", async () => {
    const shell = host();
    dispose = await useAppStore.getState().initialize();
    useAppStore.setState({ consoleOpen: false, homeChats: { "tab-1": { runId: "run-1", prompt: "Find the cheapest flight" } } });

    shell.publishTabs(tabsWith(SHOP));
    expect(useAppStore.getState().consoleOpen).toBe(true);

    // Closed by the person while the agent is still at it: the next page it opens does not reopen it.
    useAppStore.getState().setConsoleOpen(false);
    shell.publishTabs(tabsWith(`${SHOP}cart`));
    expect(useAppStore.getState().consoleOpen).toBe(false);
  });
});
