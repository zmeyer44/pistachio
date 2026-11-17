/**
 * The desk's agent in main (docs/desk-agent.md §2–§4): the line to the
 * shell's desk, the browser cut down to one group, which conversation each
 * group opens, and a desk turn end to end through the real controller and
 * runner with a scripted model — the desk block in the prompt, the desk
 * tools answered by the shell, the group's tabs only. And the scripted
 * model the e2e specs drive the agent with.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { NotificationRouter } from "@pistachio/notifications";
import type { AgentTabInfo, BrowserBackend } from "@pistachio/agent-runtime";
import type { DeskAgentState, DeskReply, DeskRequest } from "@pistachio/shell-contracts/desk-agent";
import type { BrowserTabInfo } from "@pistachio/shell-contracts/ipc";
import type { BrowserController } from "../src/main/browser-controller";
import { DeskBridge } from "../src/main/desk-bridge";
import { DeskConversationStore } from "../src/main/desk-conversations";
import { DeskScope } from "../src/main/desk-scope";
import { GroupContextStore } from "../src/main/group-context-store";
import type { RunSummary } from "@pistachio/protocol";
import { type CloudRunCommands, type DeskAgentHost, type RunExtensions } from "../src/main/run-controller";
import { RunHub } from "../src/main/run-hub";
import { scriptedAgentModel } from "../src/main/scripted-agent-model";
import { moveSpaceHoldings } from "../src/main/spaces";
import { ThreadStore } from "../src/main/thread-store";

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "pistachio-desk-agent-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

/* ------------------------------- the bridge ------------------------------- */

describe("the desk bridge", () => {
  it("answers a request with the shell's reply, and only once", async () => {
    const sent: Array<{ id: string; request: DeskRequest }> = [];
    const bridge = new DeskBridge((id, request) => {
      sent.push({ id, request });
      return true;
    });
    const reply = bridge.request({ type: "state", groupId: "g1" });
    const state: DeskAgentState = { groupId: "g1", title: "Lisbon", windows: [], docked: [] };
    bridge.reply(sent[0]!.id, { ok: true, state });
    bridge.reply(sent[0]!.id, { ok: false, error: "late" });
    await expect(reply).resolves.toEqual({ ok: true, state });
  });

  it("fails a request no shell can take, one it never answers, and one answered with nonsense", async () => {
    await expect(new DeskBridge(() => false).request({ type: "state", groupId: "g1" })).resolves.toEqual({ ok: false, error: "no desk is open" });
    const silent = new DeskBridge(() => true, 20);
    await expect(silent.request({ type: "state", groupId: "g1" })).resolves.toEqual({ ok: false, error: "the desk did not answer" });
    let id = "";
    const garbled = new DeskBridge((sent) => {
      id = sent;
      return true;
    });
    const pending = garbled.request({ type: "state", groupId: "g1" });
    garbled.reply(id, { ok: true, state: { nope: 1 } });
    await expect(pending).resolves.toEqual({ ok: false, error: "the desk sent an unreadable reply" });
    const cancelled = new DeskBridge(() => true);
    const waiting = cancelled.request({ type: "state", groupId: "g1" });
    cancelled.cancelAll("the desk reloaded");
    await expect(waiting).resolves.toEqual({ ok: false, error: "the desk reloaded" });
  });
});

/* ------------------------------- the scope -------------------------------- */

function agentTab(id: string, title = id): AgentTabInfo {
  return { id, spaceId: "work", title, url: `https://${id}.example/`, loading: false, canGoBack: false, canGoForward: false, kind: "human" };
}

/** The browser a desk turn is given: three of the person's tabs, `members` of them in group g1, and the agent's hidden tabs as it opens them. */
function scopedBrowser(members: string[]) {
  const all = [agentTab("tab-1"), agentTab("tab-2"), agentTab("mail")];
  const inner = {
    kind: "desktop" as const,
    listTabs: vi.fn(() => all),
    openTab: vi.fn(async () => {
      all.push({ ...agentTab("hidden"), hidden: true });
      return "hidden";
    }),
    focusTab: vi.fn(async () => undefined),
    navigate: vi.fn(async () => undefined),
    back: vi.fn(async () => undefined),
    forward: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    inspect: vi.fn(async (tabId: string) => ({ title: tabId, url: "", text: "", controls: [] })),
    click: vi.fn(async () => undefined),
    type: vi.fn(async () => ""),
    press: vi.fn(async () => undefined),
    scroll: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => "data:image/png;base64,AAAA"),
  } satisfies BrowserBackend;
  const group = {
    tabGroupMembers: vi.fn((groupId: string) => (groupId === "g1" ? members : null)),
    tabGroupSpaceId: vi.fn((groupId: string) => (groupId === "g1" ? "work" : null)),
    showHiddenTabInGroup: vi.fn((groupId: string, tabId: string) => {
      const tab = all.find((candidate) => candidate.id === tabId);
      if (groupId !== "g1" || tab?.hidden !== true) return false;
      delete tab.hidden;
      members.push(tabId);
      return true;
    }),
  };
  const cameOut: string[] = [];
  const scope = new DeskScope(inner, group, "g1", (tabId) => cameOut.push(tabId));
  return { scope, inner, group, cameOut, members };
}

describe("the desk's browser", () => {
  it("lists only the group's tabs and refuses any other", async () => {
    const { scope, inner } = scopedBrowser(["tab-1", "tab-2"]);
    expect(scope.listTabs().map((tab) => tab.id)).toEqual(["tab-1", "tab-2"]);
    await expect(scope.inspect("mail")).rejects.toThrow(/not on this desk/);
    await expect(scope.navigate("mail", "https://x.example")).rejects.toThrow(/tab_open/);
    expect(inner.navigate).not.toHaveBeenCalled();
    await scope.inspect("tab-2");
    expect(inner.inspect).toHaveBeenCalledWith("tab-2");
  });

  it("opens a hidden tab, off the desk, and works in it", async () => {
    const { scope, inner, group, cameOut, members } = scopedBrowser(["tab-1"]);
    await expect(scope.openTab("https://air.example")).resolves.toBe("hidden");
    // In the group's Space — its session — whichever Space the person is in now.
    expect(inner.openTab).toHaveBeenCalledWith("https://air.example", "work");
    expect(members).toEqual(["tab-1"]);
    expect(cameOut).toEqual([]);
    expect(scope.listTabs().find((tab) => tab.id === "hidden")).toMatchObject({ hidden: true });
    await scope.inspect("hidden");
    await scope.click("hidden", "Search");
    expect(inner.click).toHaveBeenCalledWith("hidden", "Search");
    expect(group.showHiddenTabInGroup).not.toHaveBeenCalled();
  });

  it("opens no tab for a group that is gone", async () => {
    const { scope, inner, group } = scopedBrowser(["tab-1"]);
    group.tabGroupSpaceId.mockReturnValue(null);
    await expect(scope.openTab("https://air.example")).rejects.toThrow(/space is gone/);
    expect(inner.openTab).not.toHaveBeenCalled();
  });

  it("puts a hidden tab on the desk only through tab_show: into the group, and out beside the window in use", async () => {
    const { scope, inner, group, cameOut, members } = scopedBrowser(["tab-1"]);
    await scope.openTab("https://air.example");
    await scope.focusTab("hidden");
    expect(group.showHiddenTabInGroup).toHaveBeenCalledWith("g1", "hidden");
    expect(members).toEqual(["tab-1", "hidden"]);
    expect(cameOut).toEqual(["hidden"]);
    expect(inner.focusTab).not.toHaveBeenCalled();
    // One of the group's own is switched to, as before; another's is refused.
    await scope.focusTab("tab-1");
    expect(inner.focusTab).toHaveBeenCalledWith("tab-1");
    await expect(scope.focusTab("mail")).rejects.toThrow(/not on this desk/);
  });
});

/* ---------------------------- the conversations ---------------------------- */

describe("which conversation a group opens", () => {
  it("binds groups to threads, keeps them across launches, and forgets a deleted thread", () => {
    const dir = scratch();
    const store = new DeskConversationStore(dir);
    store.bind("group-a", "run-1");
    store.bind("group-b", "run-1");
    store.bind("group-c", "run-2");
    store.bind("not a group id!", "run-3");
    const reopened = new DeskConversationStore(dir);
    expect(reopened.get("group-a")).toBe("run-1");
    expect(reopened.get("group-c")).toBe("run-2");
    expect(reopened.get("not a group id!")).toBeNull();
    reopened.forgetRun("run-1");
    expect(reopened.get("group-a")).toBeNull();
    expect(reopened.get("group-b")).toBeNull();
    reopened.unbind("group-c");
    expect(JSON.parse(readFileSync(join(dir, "desk-conversations.json"), "utf8"))).toEqual({ version: 1, bindings: [] });
  });
});

/* ------------------------------ a desk turn ------------------------------- */

type CallOptions = Parameters<MockLanguageModelV4["doGenerate"]>[0];
type Prompt = CallOptions["prompt"];
type GenerateResult = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;
type Step = (options: CallOptions) => GenerateResult;

let callId = 0;
const usage = {
  inputTokens: { total: 4_000, noCache: 4_000, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};
function calls(...requests: Array<{ name: string; input: Record<string, unknown> }>): Step {
  return () => ({
    content: requests.map((request) => ({ type: "tool-call" as const, toolCallId: `call-${String(++callId)}`, toolName: request.name, input: JSON.stringify(request.input) })),
    finishReason: { unified: "tool-calls", raw: "tool_use" },
    usage,
    warnings: [],
  });
}
function answer(text: string): Step {
  return () => ({ content: [{ type: "text", text }], finishReason: { unified: "stop", raw: "end_turn" }, usage, warnings: [] });
}
function scripted(steps: Step[]): MockLanguageModelV4 {
  const queue = [...steps];
  const model: MockLanguageModelV4 = new MockLanguageModelV4({
    doGenerate: async (options) => {
      const step = queue.shift();
      if (step === undefined) throw new Error(`model script exhausted after ${String(model.doGenerateCalls.length)} calls`);
      return step(options);
    },
  });
  return model;
}
function userTexts(prompt: Prompt): string[] {
  return prompt.flatMap((message) => (message.role === "user" ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])) : []));
}
function toolResults(prompt: Prompt): Array<{ toolName: string; output: unknown }> {
  return prompt.flatMap((message) => (message.role === "tool" ? message.content.flatMap((part) => (part.type === "tool-result" ? [{ toolName: part.toolName, output: part.output }] : [])) : []));
}

function browserTab(id: string, title: string): BrowserTabInfo {
  return {
    id,
    spaceId: "work",
    title,
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
  };
}

/** A conversation the cloud browser runs, as its thread reaches the store with its first event. */
function cloudRun(runId: string): RunSummary {
  const at = "2026-11-17T09:00:00.000Z";
  return {
    runId,
    taskId: `task-${runId}`,
    status: "running",
    purpose: "Order the usual",
    title: "Order the usual",
    updatedAt: at,
    turns: 1,
    notes: "",
    context: { tokens: 0, compactAt: 100_000, window: 200_000, compactions: 0, steps: 0, totalSteps: 0, usage: { inputTokens: 0, outputTokens: 0 } },
    humanTabId: null,
    agentTabId: null,
    startedAt: at,
    completedAt: null,
    control: "agent",
    pendingApproval: null,
    pendingQuestion: null,
    pendingTakeover: null,
    messages: [{ id: `m-${runId}`, at, role: "user", content: "Order the usual", turn: 1 }],
    toolCalls: [],
    subagents: [],
    activity: [],
    result: null,
    executor: { kind: "cloud", deviceId: "cloud-device-1", workerId: "worker-1" },
  };
}

function deskHarness(model: MockLanguageModelV4, events: string[] = [], dir = scratch(), cloud: CloudRunCommands | null = null, extensions: RunExtensions | null = null) {
  const tabs = [browserTab("tab-1", "Flight TP 1234"), browserTab("tab-2", "Hotel Avenida"), browserTab("mail", "Inbox")];
  /** The agent's hidden tabs, as main keeps them: out of the tab order. */
  const hidden: BrowserTabInfo[] = [];
  const browser = {
    allTabs: vi.fn(() => tabs),
    activeTab: vi.fn(() => tabs[0] ?? null),
    createTab: vi.fn(async () => "tab-9"),
    openHiddenTab: vi.fn(async (owner: string, url?: string) => {
      hidden.push({ ...browserTab("tab-9", "Air"), url: url ?? "", unlisted: true, hiddenFor: owner });
      return "tab-9";
    }),
    hiddenTabs: vi.fn((owner?: string) => hidden.filter((tab) => owner === undefined || tab.hiddenFor === owner)),
    closeHiddenTabs: vi.fn(),
    holdPopupsHidden: vi.fn(() => () => undefined),
    selectTab: vi.fn(async () => undefined),
    inspectPage: vi.fn(async (tabId: string) => ({ title: tabId, url: "", text: "Departs 09:40", controls: [] })),
    tab: vi.fn((id: string) => tabs.find((item) => item.id === id) ?? null),
  };
  const state = (groupId: string): DeskAgentState => ({
    groupId,
    title: groupId === "g1" ? "Lisbon" : "Groceries",
    windows: [{ tabId: "tab-1", kind: "tab", title: "Flight TP 1234", url: "https://tab-1.example/", box: { x: 0, y: 0, w: 50, h: 100 }, focused: true, masked: false }],
    docked: [{ tabId: "tab-2", title: "Hotel Avenida", url: "https://tab-2.example/" }],
  });
  let shown = "g1";
  /** Main's current space (BrowserController.currentGroupId): what followGroup is told, and what choose/new are checked against. */
  let current: string | null = "g1";
  const requests: DeskRequest[] = [];
  const bridge = {
    request: vi.fn(async (request: DeskRequest): Promise<DeskReply> => {
      requests.push(request);
      return { ok: true, state: state(shown) };
    }),
    cancelAll: vi.fn(),
  };
  const members: Record<string, string[]> = { g1: ["tab-1", "tab-2"], g2: [], g3: [] };
  const context = new GroupContextStore(dir);
  context.addText("g1", "Lisbon", { kind: "fact", text: "Hotel confirmation QX7F2L" }, "person");
  const bindings = new DeskConversationStore(dir);
  const threads = new ThreadStore(dir);
  const desk: DeskAgentHost = {
    bridge,
    bindings,
    browser: {
      tabGroupMembers: (groupId) => members[groupId] ?? null,
      tabGroupSpaceId: (groupId) => (members[groupId] === undefined ? null : "work"),
      showHiddenTabInGroup: vi.fn((groupId: string, tabId: string) => {
        const at = hidden.findIndex((tab) => tab.id === tabId);
        const group = members[groupId];
        if (at < 0 || group === undefined) return false;
        const shown = hidden.splice(at, 1)[0]!;
        delete shown.hiddenFor;
        tabs.push({ ...shown, unlisted: false });
        group.push(tabId);
        return true;
      }),
      ungroupTabs: vi.fn((_groupId, tabIds) => [...tabIds]),
      holdGroup: vi.fn((groupId: string) => {
        events.push(`hold ${groupId}`);
        return () => events.push(`release ${groupId}`);
      }),
      currentGroupId: () => current,
      // Main makes the space current (BrowserController.selectGroup), and the session follows it (onCurrentGroupChange).
      selectGroup: vi.fn(async (groupId: string) => {
        follow(groupId);
        await Promise.resolve();
      }),
    },
    context,
  };
  const controller = new RunHub({
    browser: browser as unknown as BrowserController,
    notifications: new NotificationRouter([]),
    onChange: () => undefined,
    threads,
    model: () => model,
    summarize: async () => "SUMMARY",
    limits: { stepsPerCall: 40, continuations: 5 },
    budget: { window: 200_000, compactAt: 100_000 },
    router: async () => {
      throw new Error("a desk turn is never routed");
    },
    desk,
    cloud,
    extensions,
  });
  /** Main passes the desk to a space (or to none): the shell's desk shows it, and the session follows (onCurrentGroupChange). */
  const follow = (groupId: string | null): void => {
    current = groupId;
    if (groupId !== null) shown = groupId;
    controller.followGroup(groupId);
  };
  return { controller, bridge, requests, bindings, threads, context, desk, browser, model, follow, show: (groupId: string) => (shown = groupId) };
}

describe("a turn at a desk", () => {
  it("starts the group's conversation, with the desk and its context in the prompt, and arranges it through the shell", async () => {
    const model = scripted([
      calls({ name: "desk_arrange", input: { layout: null, place: [{ tabId: "tab-1", zone: "left", box: null }, { tabId: "tab-2", zone: "right", box: null }], bringOut: null, putAway: null } }),
      calls({ name: "desk_note", input: { tabId: "tab-1", text: "Lands 11:05" } }),
      calls({ name: "context_save", input: { kind: "fact", text: "Flight lands 11:05", url: null, title: null } }),
      answer("Side by side now; the flight lands before check-in."),
    ]);
    const { controller, requests, bindings, context, follow } = deskHarness(model);
    follow("g1");
    await controller.message("Put the flight beside the hotel", [], { page: false });

    const run = controller.snapshot()!;
    expect(run.status).toBe("completed");
    expect(run.groupId).toBe("g1");
    expect(bindings.get("g1")).toBe(run.runId);
    const first = userTexts(model.doGenerateCalls[0]!.prompt).join("\n");
    expect(first).toContain("Desk: the space “Lisbon”");
    expect(first).toContain("- tab tab-1 “Flight TP 1234” https://tab-1.example/ — 0 0 50 100 — in use");
    expect(first).toContain("fact “Hotel confirmation QX7F2L”");
    // No pointer at the page in view: the desk block takes its place.
    expect(first).not.toContain("The page the person has open");
    const offered = (model.doGenerateCalls[0]!.tools ?? []).map((tool) => tool.name);
    expect(offered).toEqual(expect.arrayContaining(["desk_arrange", "desk_note", "context_read", "context_save"]));
    // Every request names the desk it is for: the shell refuses one for another group's before it moves anything.
    expect(requests).toContainEqual({ type: "arrange", groupId: "g1", plan: { place: [{ tabId: "tab-1", zone: "left" }, { tabId: "tab-2", zone: "right" }] } });
    expect(requests).toContainEqual({ type: "note", groupId: "g1", tabId: "tab-1", text: "Lands 11:05" });
    expect(requests.every((request) => (request as { groupId?: string }).groupId === "g1")).toBe(true);
    expect(context.items("g1").map((item) => (item.kind === "file" ? item.name : `${item.kind}:${item.text}:${item.addedBy}`))).toEqual([
      "fact:Hotel confirmation QX7F2L:person",
      "fact:Flight lands 11:05:agent",
    ]);
    expect(run.toolCalls.map((call) => call.name)).toEqual(["desk.arrange", "desk.note", "context.save"]);
  });

  it("holds its group in the browser for as long as the turn runs, whether or not the desk stays up", async () => {
    const events: string[] = [];
    const model = scripted([
      (options) => {
        events.push("model");
        return calls({ name: "tabs_list", input: {} })(options);
      },
      (options) => {
        events.push("model");
        return answer("Done.")(options);
      },
    ]);
    const { controller, follow } = deskHarness(model, events);
    follow("g1");
    await controller.message("What is on this desk?", [], { page: false });
    // A page its tabs open joins the group all the while (BrowserController's window-open handler).
    expect(events).toEqual(["hold g1", "model", "model", "release g1"]);
  });

  it("works in the group's tabs and its own hidden ones only, and puts a hidden one on the desk only through tab_show", async () => {
    const model = scripted([
      calls({ name: "tabs_list", input: {} }),
      calls({ name: "page_inspect", input: { tabId: "mail" } }),
      calls({ name: "tab_open", input: { url: "https://air.example/" } }),
      calls({ name: "page_inspect", input: { tabId: "tab-9" } }),
      calls({ name: "tabs_list", input: {} }),
      calls({ name: "tab_show", input: { tabId: "tab-9" } }),
      answer("Done."),
    ]);
    const { controller, requests, desk, browser, follow } = deskHarness(model);
    follow("g1");
    const runId = () => controller.snapshot()!.runId;
    let shownBeforeShow: DeskRequest[] = [];
    browser.inspectPage.mockImplementation(async (tabId: string) => {
      if (tabId === "tab-9") shownBeforeShow = [...requests];
      return { title: tabId, url: "", text: "Departs 09:40", controls: [] };
    });
    await controller.message("What is on this desk?", [], { page: false });

    const results = toolResults(model.doGenerateCalls.at(-1)!.prompt);
    const lists = results.filter((result) => result.toolName === "tabs_list").map((result) => JSON.stringify(result.output));
    expect(lists[0]).toContain("tab-1");
    expect(lists[0]).not.toContain("Inbox");
    // (The refused read's result is elided from the prompt by the later one; the run keeps why.)
    expect(controller.snapshot()!.toolCalls.find((tool) => tool.name === "page.inspect" && tool.tabId === "mail")).toMatchObject({ status: "failed", detail: expect.stringContaining("not on this desk") });
    // The tab it opened is hidden, the conversation's own, in the group's Space: listed as hidden, worked in, nowhere on the desk.
    expect(browser.openHiddenTab).toHaveBeenCalledWith(runId(), "https://air.example/", { spaceId: "work" });
    expect(browser.createTab).not.toHaveBeenCalled();
    expect(lists[1]).toMatch(/"id":"tab-9"[^}]*"hidden":true/);
    expect(shownBeforeShow.some((request) => request.type === "bringOut")).toBe(false);
    // Shown, it joins the group and comes out.
    expect(desk.browser.showHiddenTabInGroup).toHaveBeenCalledWith("g1", "tab-9");
    expect(requests).toContainEqual({ type: "bringOut", groupId: "g1", tabId: "tab-9" });
  });

  it("shows the space in front its own conversation: each space has one, and there is no off-the-desk to go back to", async () => {
    const model = scripted([answer("For Lisbon."), answer("For the groceries.")]);
    const { controller, follow, show } = deskHarness(model);
    follow("g1");
    await controller.message("Plan Lisbon", [], { page: false });
    const lisbon = controller.snapshot()!.runId;
    expect(controller.snapshot()?.groupId).toBe("g1");

    // Main passes the desk on: the space with no conversation opens an empty console.
    follow("g2");
    expect(controller.snapshot()).toBeNull();
    await controller.message("Groceries", [], { page: false });
    const groceries = controller.snapshot()!.runId;
    expect(controller.snapshot()?.groupId).toBe("g2");

    // And back: the first space's conversation is there again.
    show("g1");
    follow("g1");
    expect(controller.snapshot()?.runId).toBe(lisbon);
    follow("g2");
    expect(controller.snapshot()?.runId).toBe(groceries);
    // The shell's enter and leave are an older shell's, and change nothing.
    await controller.deskConversation({ type: "enter", groupId: "g1" });
    await controller.deskConversation({ type: "leave" });
    expect(controller.snapshot()?.runId).toBe(groceries);
    // No space named: nothing more is the desk's, and the open thread stays.
    follow(null);
    expect(controller.snapshot()?.runId).toBe(groceries);
  });

  it("keeps a turn in the space it was asked in: the person moves on, the space they go to shows its own conversation, and the turn runs on where it was", async () => {
    let moveOn: (() => void) | null = null;
    const events: string[] = [];
    const seen: Array<{ run: string | null; agents: Record<string, string> }> = [];
    const model = scripted([
      (options) => {
        // The person passes to another space mid-turn.
        moveOn?.();
        return calls({ name: "tabs_list", input: {} })(options);
      },
      (options) => {
        seen.push({ run: controller.snapshot()?.runId ?? null, agents: controller.spaceAgents() });
        return answer("Done in Lisbon.")(options);
      },
    ]);
    const { controller, follow, bindings, browser } = deskHarness(model, events);
    follow("g1");
    moveOn = () => follow("g2");
    await controller.message("What is on this desk?", [], { page: false });
    const lisbon = bindings.get("g1")!;
    // The turn held its own space to the end, its conversation g1's ...
    expect(events).toEqual(["hold g1", "release g1"]);
    expect(controller.threads().find((item) => item.runId === lisbon)?.groupId).toBe("g1");
    // ... while the space the person went to showed its own — none yet — and g1's tile said the agent was at work there.
    expect(seen).toEqual([{ run: null, agents: { g1: "working" } }]);
    // Ended with nobody looking, it is saved and set aside, and its tile says there is something to read ...
    expect(controller.snapshot()).toBeNull();
    await vi.waitFor(() => expect(controller.spaceAgents()).toEqual({ g1: "answered" }));
    expect(controller.threads().find((item) => item.runId === lisbon)?.status).toBe("completed");
    expect(browser.closeHiddenTabs).toHaveBeenCalledWith(lisbon);
    // ... until they come back to it: the conversation, with its answer.
    follow("g1");
    expect(controller.snapshot()?.runId).toBe(lisbon);
    expect(controller.snapshot()?.status).toBe("completed");
    expect(controller.snapshot()?.messages.at(-1)?.content).toBe("Done in Lisbon.");
    expect(controller.spaceAgents()).toEqual({});
  });

  it("runs two spaces' turns side by side, each in its own conversation, and Stop is the space in front's", async () => {
    let release: (() => void) | null = null;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const model = scripted([calls({ name: "page_inspect", input: { tabId: "tab-1" } }), answer("For the groceries."), answer("Done in Lisbon.")]);
    const { controller, follow, bindings, browser } = deskHarness(model);
    browser.inspectPage.mockImplementationOnce(async (tabId: string) => {
      await blocked;
      return { title: tabId, url: "", text: "Departs 09:40", controls: [] };
    });
    follow("g1");
    const lisbonTurn = controller.message("Read the flight", [], { page: false });
    await vi.waitFor(() => expect(browser.inspectPage).toHaveBeenCalled());
    const lisbon = bindings.get("g1")!;
    expect(controller.snapshot()?.status).toBe("running");

    // The person goes to another space and asks there: its own conversation, start to finish, while Lisbon's still runs.
    follow("g2");
    expect(controller.snapshot()).toBeNull();
    await controller.message("Groceries", [], { page: false });
    const groceries = controller.snapshot()!;
    expect(groceries.runId).not.toBe(lisbon);
    expect(groceries.groupId).toBe("g2");
    expect(groceries.status).toBe("completed");
    expect(groceries.messages.at(-1)?.content).toBe("For the groceries.");
    expect(controller.threads().find((item) => item.runId === lisbon)?.status).toBe("running");
    expect(controller.spaceAgents()).toEqual({ g1: "working" });
    // Stop, here, is this space's: Lisbon's turn is not touched by it.
    controller.interrupt();
    expect(controller.threads().find((item) => item.runId === lisbon)?.status).toBe("running");

    release!();
    await lisbonTurn;
    follow("g1");
    expect(controller.snapshot()?.runId).toBe(lisbon);
    expect(controller.snapshot()?.status).toBe("completed");
    expect(controller.snapshot()?.messages.at(-1)?.content).toBe("Done in Lisbon.");
    // And the groceries' is where it was left.
    follow("g2");
    expect(controller.snapshot()?.runId).toBe(groceries.runId);
  });

  it("tells a turn whose space is not in front that its desk cannot be arranged, and lets it go on with the rest", async () => {
    let moveOn: (() => void) | null = null;
    const model = scripted([
      (options) => {
        moveOn?.();
        return calls({ name: "desk_state", input: {} })(options);
      },
      answer("I could not look at the desk; the flight page is ready for you."),
    ]);
    const { controller, follow, bindings } = deskHarness(model);
    follow("g1");
    moveOn = () => follow("g2");
    await controller.message("Tidy this desk", [], { page: false });
    const lisbon = bindings.get("g1")!;
    // (The shell draws the desk in front: its reply was for g2's, so nothing was read or moved in g1's.)
    const refused = toolResults(model.doGenerateCalls[1]!.prompt).find((result) => result.toolName === "desk_state");
    expect(JSON.stringify(refused?.output)).toContain("looking at another space");
    expect(controller.threads().find((item) => item.runId === lisbon)?.status).toBe("completed");
  });

  it("leaves a turn that ended asking the person waiting in its space: nothing is cancelled, and it is answered there", async () => {
    let moveOn: (() => void) | null = null;
    const model = scripted([
      (options) => {
        // The person passes to another space mid-turn, and the model asks.
        moveOn?.();
        return calls({ name: "ask_user", input: { prompt: "Which hotel?", description: "Two match the dates", choices: [{ label: "Avenida", value: "avenida", description: "By the station" }, { label: "Baixa", value: "baixa", description: "In the old town" }] } })(options);
      },
      answer("Avenida it is."),
    ]);
    const { controller, follow, bindings, browser } = deskHarness(model);
    follow("g1");
    moveOn = () => follow("g2");
    await controller.message("Book the hotel", [], { page: false });
    const lisbon = bindings.get("g1")!;
    // The space the person is in shows its own (none yet); Lisbon's question waits in Lisbon, and its tile says so.
    expect(controller.snapshot()).toBeNull();
    expect(controller.threads().find((item) => item.runId === lisbon)?.status).toBe("waiting_for_judgment");
    expect(controller.spaceAgents()).toEqual({ g1: "asking" });
    expect(browser.closeHiddenTabs).not.toHaveBeenCalled();

    // Back there: the question, still pending; answered, the turn it starts runs to its end, in front.
    follow("g1");
    const waiting = controller.snapshot()!;
    expect(waiting.runId).toBe(lisbon);
    expect(waiting.pendingQuestion?.prompt).toBe("Which hotel?");
    await controller.answerQuestion(waiting.pendingQuestion!.id, "avenida");
    expect(controller.snapshot()?.runId).toBe(lisbon);
    expect(controller.snapshot()?.status).toBe("completed");
    expect(controller.spaceAgents()).toEqual({});
  });

  it("keeps a conversation waiting on the person as it stands while they look at other spaces, and shows it again in its own", async () => {
    const model = scripted([
      calls({ name: "ask_user", input: { prompt: "Which hotel?", description: "Two match the dates", choices: [{ label: "Avenida", value: "avenida", description: "By the station" }, { label: "Baixa", value: "baixa", description: "In the old town" }] } }),
      answer("Avenida it is."),
    ]);
    const { controller, follow, bindings, browser } = deskHarness(model);
    follow("g1");
    await controller.message("Book the hotel", [], { page: false });
    const lisbon = bindings.get("g1")!;
    const question = controller.snapshot()!.pendingQuestion!;
    expect(question.prompt).toBe("Which hotel?");

    // The person looks at another space, then a third: each shows its own conversation (none yet), and Lisbon's
    // question waits where it was asked — not cancelled, its research tabs kept, still g1's.
    follow("g2");
    expect(controller.snapshot()).toBeNull();
    follow("g3");
    expect(controller.snapshot()).toBeNull();
    expect(controller.threads().find((item) => item.runId === lisbon)?.status).toBe("waiting_for_judgment");
    expect(controller.spaceAgents()).toEqual({ g1: "asking" });
    expect(browser.closeHiddenTabs).not.toHaveBeenCalled();
    expect(bindings.get("g1")).toBe(lisbon);

    // Back in Lisbon: its conversation, the question still pending, answered there and run to its end.
    follow("g1");
    const back = controller.snapshot()!;
    expect(back.runId).toBe(lisbon);
    expect(back.status).toBe("waiting_for_judgment");
    expect(back.pendingQuestion?.id).toBe(question.id);
    await controller.answerQuestion(question.id, "avenida");
    expect(controller.snapshot()?.runId).toBe(lisbon);
    expect(controller.snapshot()?.status).toBe("completed");
  });

  it("takes an iMessage answer where the question waits: the turn runs in its own space, and the person is not moved", async () => {
    const model = scripted([
      calls({ name: "ask_user", input: { prompt: "Which hotel?", description: "Two match the dates", choices: [{ label: "Avenida", value: "avenida", description: "By the station" }, { label: "Baixa", value: "baixa", description: "In the old town" }] } }),
      answer("Avenida it is."),
    ]);
    const { controller, follow, bindings, browser, desk } = deskHarness(model);
    follow("g1");
    await controller.message("Book the hotel", [], { page: false });
    const lisbon = bindings.get("g1")!;
    const question = controller.snapshot()!.pendingQuestion!;
    follow("g2");
    expect(controller.snapshot()).toBeNull();

    // The answer arrives from the phone (CloudRunService has already moved past it: it must not be dropped).
    await controller.answerIMessageQuestion(lisbon, question.id, "avenida");
    // Nobody was taken anywhere: the space in front keeps its own conversation (none) ...
    expect(desk.browser.selectGroup).not.toHaveBeenCalled();
    expect(controller.snapshot()).toBeNull();
    // ... and Lisbon's ran on in Lisbon, as a turn of that space's.
    const record = controller.threads().find((item) => item.runId === lisbon);
    expect(record?.status).toBe("completed");
    await vi.waitFor(() => expect(controller.spaceAgents()).toEqual({ g1: "answered" }));
    expect(userTexts(model.doGenerateCalls.at(-1)!.prompt).join("\n")).toContain("looking at another space");
    follow("g1");
    const run = controller.snapshot()!;
    expect(run.runId).toBe(lisbon);
    expect(run.pendingQuestion).toBeNull();
    expect(run.messages.some((message) => message.role === "user" && message.content === "Avenida")).toBe(true);
    expect(run.messages.at(-1)?.content).toBe("Avenida it is.");
    // An answer to a question no longer asked is dropped.
    await expect(controller.answerIMessageQuestion(lisbon, question.id, "baixa")).resolves.toBeUndefined();
    expect(controller.snapshot()?.messages.at(-1)?.content).toBe("Avenida it is.");
    expect(browser.selectTab).not.toHaveBeenCalled();
  });

  it("takes an iMessage answer while another space's conversation is acting, at once: neither waits for the other", async () => {
    let answerFromAfar: (() => Promise<void>) | null = null;
    let afar: Promise<void> | null = null;
    const model = scripted([
      calls({ name: "ask_user", input: { prompt: "Which hotel?", description: "Two match the dates", choices: [{ label: "Avenida", value: "avenida", description: "By the station" }, { label: "Baixa", value: "baixa", description: "In the old town" }] } }),
      (options) => {
        // Mid-turn in g2, the phone answers Lisbon's question.
        afar = answerFromAfar?.() ?? null;
        return calls({ name: "tabs_list", input: {} })(options);
      },
      answer("Avenida it is."),
      answer("For the groceries."),
    ]);
    const { controller, follow, bindings } = deskHarness(model);
    follow("g1");
    await controller.message("Book the hotel", [], { page: false });
    const lisbon = bindings.get("g1")!;
    const question = controller.snapshot()!.pendingQuestion!;
    follow("g2");
    answerFromAfar = () => controller.answerIMessageQuestion(lisbon, question.id, "avenida");
    await controller.message("Groceries", [], { page: false });
    await afar;
    const groceries = bindings.get("g2")!;
    // Both ran to their ends, each in its own conversation; the one in front is still the groceries'.
    expect(controller.snapshot()?.runId).toBe(groceries);
    expect(controller.snapshot()?.messages.at(-1)?.content).toBe("For the groceries.");
    expect(controller.threads().find((item) => item.runId === lisbon)?.status).toBe("completed");
    follow("g1");
    expect(controller.snapshot()?.messages.at(-1)?.content).toBe("Avenida it is.");
  });

  it("takes an iMessage answer after a restart, from the store, and drops one whose conversation is gone", async () => {
    const dir = scratch();
    const ask = (prompt: string): Step =>
      calls({ name: "ask_user", input: { prompt, description: "Pick one", choices: [{ label: "Yes", value: "yes", description: "Go ahead" }, { label: "No", value: "no", description: "Hold off" }] } });
    const first = deskHarness(scripted([ask("Book Lisbon?"), ask("Order the groceries?")]), [], dir);
    first.follow("g1");
    await first.controller.message("Plan Lisbon", [], { page: false });
    const lisbon = first.bindings.get("g1")!;
    const lisbonQuestion = first.controller.snapshot()!.pendingQuestion!;
    first.follow("g2");
    await first.controller.message("Groceries", [], { page: false });
    const groceries = first.bindings.get("g2")!;
    const groceriesQuestion = first.controller.snapshot()!.pendingQuestion!;
    first.controller.shutdown();

    // The next launch, in a third space: both questions are in the store, no console holding either.
    const second = deskHarness(scripted([answer("Groceries ordered.")]), [], dir);
    second.follow("g3");
    second.controller.deleteThread(lisbon);
    await second.controller.answerIMessageQuestion(lisbon, lisbonQuestion.id, "yes");
    await second.controller.answerIMessageQuestion(groceries, groceriesQuestion.id, "yes");
    // Lisbon's answer has nothing left to answer; the groceries' ran, in its own space.
    expect(second.controller.snapshot()).toBeNull();
    expect(second.controller.threads().map((item) => [item.runId, item.status])).toEqual([[groceries, "completed"]]);
    second.follow("g2");
    expect(second.controller.snapshot()?.messages.at(-1)?.content).toBe("Groceries ordered.");
  });

  it("brings the conversation open at the quit back at home in its own space: left waiting behind another space, an answer from afar runs it there", async () => {
    const dir = scratch();
    const ask = calls({ name: "ask_user", input: { prompt: "Order the groceries?", description: "Pick one", choices: [{ label: "Yes", value: "yes", description: "Go ahead" }, { label: "No", value: "no", description: "Hold off" }] } });
    const first = deskHarness(scripted([ask]), [], dir);
    first.follow("g2");
    await first.controller.message("Groceries", [], { page: false });
    const groceries = first.bindings.get("g2")!;
    const question = first.controller.snapshot()!.pendingQuestion!;
    first.controller.shutdown();

    // The next launch: the conversation that was open comes back (restore), and then main names the space in front —
    // another one. The question waits behind it, in its own space, as its tile says.
    const events: string[] = [];
    const second = deskHarness(scripted([calls({ name: "tabs_list", input: {} }), answer("Groceries ordered.")]), events, dir);
    second.controller.restore();
    second.follow("g3");
    expect(second.controller.snapshot()).toBeNull();
    expect(second.controller.spaceAgents()).toEqual({ g2: "asking" });
    await second.controller.answerIMessageQuestion(groceries, question.id, "yes");
    // The answer's turn was its space's: the space held for it, its tabs the only ones listed (g2 has none) — not
    // the whole browser's, as a console with no home would have had.
    expect(events).toEqual(["hold g2", "release g2"]);
    const listed = toolResults(second.model.doGenerateCalls.at(-1)!.prompt).find((result) => result.toolName === "tabs_list");
    expect(JSON.stringify(listed?.output)).not.toContain("tab-1");
    second.follow("g2");
    expect(second.controller.snapshot()?.messages.at(-1)?.content).toBe("Groceries ordered.");
  });

  it("runs a late message as a turn of the space it was sent from, though the conversation is the space in front's too", async () => {
    const events: string[] = [];
    const { controller, follow, bindings, requests } = deskHarness(scripted([answer("Planned."), answer("And more."), answer("From here.")]), events);
    follow("g1");
    await controller.message("Plan Lisbon", [], { page: false });
    const lisbon = bindings.get("g1")!;
    // Continued in g2 as well: both spaces' from then on, and its console at home where the person is — g2.
    follow("g2");
    await controller.deskConversation({ type: "choose", groupId: "g2", runId: lisbon });
    expect(bindings.get("g2")).toBe(lisbon);
    events.length = 0;
    requests.length = 0;
    // A message from g1's Bar that main hears only now (a file it mentions was being read): a turn at g1's desk —
    // g1 held, g1's desk asked for — not at the desk of the space the console is shown in.
    await controller.message("And then?", [], { page: false, groupId: "g1" });
    expect(events).toEqual(["hold g1", "release g1"]);
    expect(requests.map((request) => request.groupId)).toEqual(["g1"]);
    expect(controller.snapshot()?.messages.at(-1)?.content).toBe("And more.");
    // One from g2's own Bar, in the same conversation, is g2's.
    events.length = 0;
    await controller.message("And here?", [], { page: false, groupId: "g2" });
    expect(events).toEqual(["hold g2", "release g2"]);
  });

  it("makes a cloud conversation started from a space's Bar that space's: bound as control makes it, shown as its first word comes, continued there", async () => {
    const message = vi.fn(async () => undefined);
    const cloud: CloudRunCommands = { message, answer: async () => undefined, interrupt: async () => undefined, release: async () => undefined, revoke: async () => undefined, forget: () => undefined };
    const { controller, follow, bindings, threads } = deskHarness(scripted([]), [], scratch(), cloud);
    follow("g1");
    // Control has made the run; nothing of it is in the store yet (its first event is still to be folded).
    controller.cloudStarted("cloud-1", "g1");
    expect(bindings.get("g1")).toBe("cloud-1");
    expect(controller.snapshot()).toBeNull();
    // The person looks at another space and back meanwhile: it is on its way, not a deleted thread to unbind.
    follow("g2");
    follow("g1");
    expect(bindings.get("g1")).toBe("cloud-1");
    // Its first event is folded — the thread is in the store, and the hub hears of it: shown where it was asked.
    const first = cloudRun("cloud-1");
    threads.saveNow({ version: 1, spaceId: "work", run: first, model: [] });
    controller.refreshRemote(first);
    expect(controller.snapshot()?.runId).toBe("cloud-1");
    // The next message from this space's Bar continues it, through control — not a second conversation.
    await controller.message("And the totals?", [], { page: false, groupId: "g1" });
    expect(message).toHaveBeenCalledWith("cloud-1", "And the totals?", []);
    expect(bindings.get("g1")).toBe("cloud-1");

    // One asked from g2's Bar, the person in g3 by the time control answers: g2's all the same, there when they are back.
    follow("g3");
    controller.cloudStarted("cloud-2", "g2");
    const second = cloudRun("cloud-2");
    threads.saveNow({ version: 1, spaceId: "work", run: second, model: [] });
    controller.refreshRemote(second);
    expect(controller.snapshot()).toBeNull();
    expect(bindings.get("g3")).toBeNull();
    // Their tiles say what the cloud browser is doing there, though no console here holds either (the one g1's was in
    // was let go of as the person left: a cloud conversation has nothing going on this Mac).
    expect(controller.spaceAgents()).toEqual({ g1: "working", g2: "working" });
    const asking = { ...second, status: "waiting_for_judgment", control: "human", pendingQuestion: { id: "q1", prompt: "Which size?", description: "Pick one", choices: [] } } as RunSummary;
    controller.refreshRemote(asking);
    expect(controller.spaceAgents()).toEqual({ g1: "working", g2: "asking" });
    // Done, with the person elsewhere: something to read there, until they look.
    controller.refreshRemote({ ...second, status: "completed", completedAt: "2026-11-17T09:05:00.000Z" });
    expect(controller.spaceAgents()).toEqual({ g1: "working", g2: "answered" });
    follow("g2");
    expect(controller.spaceAgents()).toEqual({ g1: "working" });
    expect(controller.snapshot()?.runId).toBe("cloud-2");
    // A space that took up a conversation of its own while control was answering keeps that one.
    controller.cloudStarted("cloud-3", "g1");
    expect(bindings.get("g1")).toBe("cloud-1");
    // And a space that is gone is bound to nothing.
    controller.cloudStarted("cloud-4", "gone");
    expect(bindings.get("gone")).toBeNull();

    // A start whose first event never comes: the Bar gives up waiting and lets the person send again, and the second
    // start is the space's conversation — not shut out by a binding to a run there is nothing of.
    follow("g3");
    controller.cloudStarted("cloud-5", "g3");
    expect(bindings.get("g3")).toBe("cloud-5");
    controller.cloudStarted("cloud-6", "g3");
    expect(bindings.get("g3")).toBe("cloud-6");
    const sixth = cloudRun("cloud-6");
    threads.saveNow({ version: 1, spaceId: "work", run: sixth, model: [] });
    controller.refreshRemote(sixth);
    expect(controller.snapshot()?.runId).toBe("cloud-6");
    // (The first, should it turn up after all, is in the past chats: the space keeps the one it shows.)
    const fifth = cloudRun("cloud-5");
    threads.saveNow({ version: 1, spaceId: "work", run: fifth, model: [] });
    controller.refreshRemote(fifth);
    expect(bindings.get("g3")).toBe("cloud-6");
    expect(controller.snapshot()?.runId).toBe("cloud-6");
  });

  it("leaves a conversation that waits on the person, and is another space's too, as it stands when one of its spaces starts a new one", async () => {
    const events: string[] = [];
    const ask = calls({ name: "ask_user", input: { prompt: "Book Lisbon?", description: "Pick one", choices: [{ label: "Yes", value: "yes", description: "Go ahead" }, { label: "No", value: "no", description: "Hold off" }] } });
    const { controller, follow, bindings, browser } = deskHarness(scripted([ask, answer("Booked.")]), events);
    follow("g1");
    await controller.message("Plan Lisbon", [], { page: false });
    const lisbon = bindings.get("g1")!;
    const question = controller.snapshot()!.pendingQuestion!;
    // Continued in g2 as well — both spaces' — and then g2 starts a conversation of its own.
    follow("g2");
    await controller.deskConversation({ type: "choose", groupId: "g2", runId: lisbon });
    expect(controller.snapshot()?.pendingQuestion?.id).toBe(question.id);
    await controller.deskConversation({ type: "new", groupId: "g2" });
    expect(bindings.get("g2")).toBeNull();
    expect(controller.snapshot()).toBeNull();
    // g1's is as it stood: its question still asked (not cancelled for g2's sake), its research not closed, and its
    // tile saying it waits there.
    expect(bindings.get("g1")).toBe(lisbon);
    expect(controller.spaceAgents()).toEqual({ g1: "asking" });
    expect(browser.closeHiddenTabs).not.toHaveBeenCalledWith(lisbon);
    follow("g1");
    expect(controller.snapshot()?.runId).toBe(lisbon);
    expect(controller.snapshot()?.pendingQuestion?.id).toBe(question.id);
    // Answered there, it goes on as g1's turn — at home in g1 again, not in the space that let go of it.
    events.length = 0;
    await controller.answerQuestion(question.id, "yes");
    expect(events).toEqual(["hold g1", "release g1"]);
    expect(controller.snapshot()?.messages.at(-1)?.content).toBe("Booked.");
  });

  it("runs a conversation's last turn again after it ended behind the person: the retry is the conversation's, not its console's of the moment", async () => {
    let moveOn: (() => void) | null = null;
    const model = scripted([
      (options) => {
        moveOn?.();
        return answer("First go.")(options);
      },
      answer("Second go."),
    ]);
    const { controller, follow, bindings } = deskHarness(model);
    follow("g1");
    moveOn = () => follow("g2");
    await controller.message("Plan Lisbon", [], { page: false });
    const lisbon = bindings.get("g1")!;
    // It ended with the person in g2: its console was let go of, the conversation set aside.
    await vi.waitFor(() => expect(controller.spaceAgents()).toEqual({ g1: "answered" }));
    moveOn = null;
    follow("g1");
    expect(controller.snapshot()?.messages.at(-1)?.content).toBe("First go.");
    // Retry, on the reply that is still there to press it on: the turn runs again, from where it began.
    await controller.retry();
    const again = controller.snapshot()!;
    expect(again.runId).toBe(lisbon);
    expect(again.activity.map((entry) => entry.label)).toContain("Retrying");
    expect(again.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual(["Plan Lisbon"]);
    expect(again.messages.at(-1)?.content).toBe("Second go.");
    expect(again.status).toBe("completed");
  });

  it("retries the conversation that is open, never from the checkpoint of the one its console held before", async () => {
    const model = scripted([answer("Lisbon planned."), answer("Groceries listed."), answer("Lisbon planned again.")]);
    const { controller, follow, bindings } = deskHarness(model);
    follow("g1");
    await controller.message("Plan Lisbon", [], { page: false });
    const lisbon = bindings.get("g1")!;
    // A second conversation in the same space, in the same console; then the first is chosen again, from the store.
    await controller.deskConversation({ type: "new", groupId: "g1" });
    await controller.message("List the groceries", [], { page: false });
    expect(bindings.get("g1")).not.toBe(lisbon);
    await controller.deskConversation({ type: "choose", groupId: "g1", runId: lisbon });
    expect(controller.snapshot()?.messages.at(-1)?.content).toBe("Lisbon planned.");
    await controller.retry();
    // Lisbon's own turn ran again, from Lisbon's history: not the groceries' words under Lisbon's name.
    const again = controller.snapshot()!;
    expect(again.runId).toBe(lisbon);
    expect(again.messages.map((message) => message.content)).toEqual(["Plan Lisbon", "Lisbon planned again."]);
    const asked = userTexts(model.doGenerateCalls.at(-1)!.prompt).join("\n");
    expect(asked).toContain("Plan Lisbon");
    expect(asked).not.toContain("groceries");
  });

  it("starts an author turn as the conversation of the space whose Bar asked, though that space's conversation is shown in another by then", async () => {
    const TOKEN = "0123456789abcdef0123456789abcdef";
    let claimed = false;
    const extensions: RunExtensions = {
      tools: () => [],
      call: async () => null,
      claimDraft: (slug, token) => {
        if (claimed || slug !== "word-counter" || token !== TOKEN) return null;
        claimed = true;
        return { slug, folder: "/Users/z/Pistachio/Extensions/word-counter" };
      },
      authorHost: {
        write: async (_slug, path, content) => ({ path, bytes: content.length }),
        read: async () => ({ path: null, files: [] }),
        status: async () => JSON.stringify({ state: "needs-approval", manifestErrors: [], runtimeErrors: [] }),
      },
      authorGuide: () => "# Writing a Pistachio extension",
    };
    const { controller, follow, bindings } = deskHarness(scripted([answer("Planned."), answer("It counts words.")]), [], scratch(), null, extensions);
    follow("g1");
    await controller.message("Plan Lisbon", [], { page: false });
    const lisbon = bindings.get("g1")!;
    // Lisbon is continued in g2 as well: one console, at home where the person is — g2.
    follow("g2");
    await controller.deskConversation({ type: "choose", groupId: "g2", runId: lisbon });
    // `/extension`, sent from g1's Bar before they left (its draft folder was being made), reaches main now: the
    // author's thread is g1's new conversation — and g2 keeps Lisbon, which was never g1's Bar's to replace there.
    await controller.message(`[pistachio:extension-author slug=word-counter token=${TOKEN}]\nBuild an extension that counts words.`, [], { page: false, groupId: "g1" });
    const authoring = bindings.get("g1")!;
    expect(authoring).not.toBe(lisbon);
    expect(bindings.get("g2")).toBe(lisbon);
    expect(controller.threads().find((item) => item.runId === authoring)?.groupId).toBe("g1");
    // (Shown, too: the space the person is in still has Lisbon in front of them — the author's thread ran in a
    // console of its own, g1's — and g1 shows the extension being written when they are back.)
    expect(controller.snapshot()?.runId).toBe(lisbon);
    follow("g1");
    expect(controller.snapshot()?.runId).toBe(authoring);
    expect(controller.snapshot()?.messages.at(-1)?.content).toBe("It counts words.");
  });

  it("begins an author's thread in the space in front without cancelling what the conversation it replaces there asks of another space", async () => {
    const TOKEN = "0123456789abcdef0123456789abcdef";
    let claimed = false;
    const extensions: RunExtensions = {
      tools: () => [],
      call: async () => null,
      claimDraft: (slug, token) => {
        if (claimed || slug !== "word-counter" || token !== TOKEN) return null;
        claimed = true;
        return { slug, folder: "/Users/z/Pistachio/Extensions/word-counter" };
      },
      authorHost: {
        write: async (_slug, path, content) => ({ path, bytes: content.length }),
        read: async () => ({ path: null, files: [] }),
        status: async () => JSON.stringify({ state: "needs-approval", manifestErrors: [], runtimeErrors: [] }),
      },
      authorGuide: () => "# Writing a Pistachio extension",
    };
    const ask = calls({ name: "ask_user", input: { prompt: "Book Lisbon?", description: "Pick one", choices: [{ label: "Yes", value: "yes", description: "Go ahead" }, { label: "No", value: "no", description: "Hold off" }] } });
    const { controller, follow, bindings } = deskHarness(scripted([ask, answer("It counts words.")]), [], scratch(), null, extensions);
    follow("g1");
    await controller.message("Plan Lisbon", [], { page: false });
    const lisbon = bindings.get("g1")!;
    const question = controller.snapshot()!.pendingQuestion!;
    follow("g2");
    await controller.deskConversation({ type: "choose", groupId: "g2", runId: lisbon });
    // `/extension` in g2's Bar: g2's new conversation — and Lisbon, still g1's, keeps its question.
    await controller.message(`[pistachio:extension-author slug=word-counter token=${TOKEN}]\nBuild an extension that counts words.`, [], { page: false, groupId: "g2" });
    expect(bindings.get("g2")).not.toBe(lisbon);
    expect(controller.snapshot()?.messages.at(-1)?.content).toBe("It counts words.");
    expect(bindings.get("g1")).toBe(lisbon);
    expect(controller.spaceAgents()).toEqual({ g1: "asking" });
    follow("g1");
    expect(controller.snapshot()?.pendingQuestion?.id).toBe(question.id);
  });

  it("resumes a paused author turn as an author turn, though its thread was opened again in another console", async () => {
    const TOKEN = "0123456789abcdef0123456789abcdef";
    let claimed = false;
    const extensions: RunExtensions = {
      tools: () => [],
      call: async () => null,
      claimDraft: (slug, token) => {
        if (claimed || slug !== "word-counter" || token !== TOKEN) return null;
        claimed = true;
        return { slug, folder: "/Users/z/Pistachio/Extensions/word-counter" };
      },
      authorHost: {
        write: async (_slug, path, content) => ({ path, bytes: content.length }),
        read: async () => ({ path: null, files: [] }),
        status: async () => JSON.stringify({ state: "needs-approval", manifestErrors: [], runtimeErrors: [] }),
      },
      authorGuide: () => "# Writing a Pistachio extension",
    };
    let stop: (() => void) | null = null;
    const model = scripted([
      (options) => {
        // The person stops it mid-step (Stop): paused, to be resumed.
        stop?.();
        return answer("(cut short)")(options);
      },
      calls({ name: "ask_user", input: { prompt: "Order the groceries?", description: "Pick one", choices: [{ label: "Yes", value: "yes", description: "Go ahead" }, { label: "No", value: "no", description: "Hold off" }] } }),
      answer("It counts words; approve it in Pistachio."),
    ]);
    const { controller, follow, bindings } = deskHarness(model, [], scratch(), null, extensions);
    follow("g1");
    stop = () => controller.interrupt();
    await controller.message(`[pistachio:extension-author slug=word-counter token=${TOKEN}]\nBuild an extension that counts words.`, [], { page: false, groupId: "g1" });
    stop = null;
    const authoring = bindings.get("g1")!;
    expect(controller.snapshot()?.status).toBe("interrupted");
    // The person goes to g2 and asks there — its conversation waits on them, so its console is kept — and comes
    // back: g1's thread is opened from the store, in a console of its own this time.
    follow("g2");
    await controller.message("Groceries", [], { page: false });
    expect(controller.snapshot()?.pendingQuestion).not.toBeNull();
    follow("g1");
    expect(controller.snapshot()?.runId).toBe(authoring);
    // Resume: an author turn still — the draft tools and nothing else, no desk, no pages.
    await controller.releaseControl();
    const tools = (model.doGenerateCalls.at(-1)!.tools ?? []).map((tool) => tool.name).sort();
    expect(tools).toEqual(["ask_user", "ask_user_text", "extension_draft_read", "extension_draft_write", "extension_status"]);
    expect(controller.snapshot()?.messages.at(-1)?.content).toBe("It counts words; approve it in Pistachio.");
  });

  it("says a space has something to read only while that conversation is still its own: deleted from elsewhere, its tile says nothing", async () => {
    let moveOn: (() => void) | null = null;
    const model = scripted([
      (options) => {
        moveOn?.();
        return answer("Done in Lisbon.")(options);
      },
      answer("Done again."),
    ]);
    const { controller, follow, bindings } = deskHarness(model);
    follow("g1");
    moveOn = () => follow("g2");
    await controller.message("Plan Lisbon", [], { page: false });
    const lisbon = bindings.get("g1")!;
    await vi.waitFor(() => expect(controller.spaceAgents()).toEqual({ g1: "answered" }));
    // Deleted from the past chats of the space the person is in: nothing is left in g1 to read, and its tile says so.
    controller.deleteThread(lisbon);
    expect(bindings.get("g1")).toBeNull();
    expect(controller.spaceAgents()).toEqual({});
    // (And a new conversation there that ends behind them is marked afresh, as its own.)
    await controller.message("Plan Lisbon again", [], { page: false, groupId: "g1" });
    await vi.waitFor(() => expect(controller.spaceAgents()).toEqual({ g1: "answered" }));
    follow("g1");
    expect(controller.spaceAgents()).toEqual({});
  });

  it("runs a message in the space whose Bar sent it, though the person has gone on while it was on its way", async () => {
    const events: string[] = [];
    const { controller, follow, bindings, threads } = deskHarness(scripted([answer("Lisbon is planned."), answer("Still Lisbon.")]), events);
    follow("g1");
    // Sent from g1's Bar (a file it mentions was still being read); the person is in g2 by the time main hears it.
    follow("g2");
    await controller.message("Plan Lisbon", [], { page: false, groupId: "g1" });
    const lisbon = bindings.get("g1")!;
    // It is g1's conversation, run as g1's turn, with no tab of the space in view named as its own ...
    expect(events).toEqual(["hold g1", "release g1"]);
    expect(threads.get(lisbon)?.run).toMatchObject({ groupId: "g1", status: "completed", humanTabId: null });
    // ... and the space the person is in was handed nothing: no conversation of its own, none shown.
    expect(bindings.get("g2")).toBeNull();
    expect(controller.snapshot()).toBeNull();
    await vi.waitFor(() => expect(controller.spaceAgents()).toEqual({ g1: "answered" }));
    // A second one sent the same way goes on in that conversation, opened from where it was set aside.
    await controller.message("And then?", [], { page: false, groupId: "g1" });
    expect(bindings.get("g1")).toBe(lisbon);
    expect(controller.snapshot()).toBeNull();
    follow("g1");
    expect(controller.snapshot()?.runId).toBe(lisbon);
    expect(controller.snapshot()?.messages.at(-1)?.content).toBe("Still Lisbon.");
    // One for the space in front is that space's as ever, named or not; one for a space that is gone is refused.
    follow("g2");
    await expect(controller.message("Hello", [], { page: false, groupId: "gone" })).rejects.toThrow(/no longer open/u);
    expect(bindings.get("g2")).toBeNull();
    expect(controller.snapshot()).toBeNull();
  });

  it("shows a conversation at work in another space when it is chosen here: the same one, live, and both spaces' from then on", async () => {
    let release: (() => void) | null = null;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const model = scripted([calls({ name: "page_inspect", input: { tabId: "tab-1" } }), answer("Done in Lisbon.")]);
    const { controller, follow, bindings, browser } = deskHarness(model);
    browser.inspectPage.mockImplementationOnce(async (tabId: string) => {
      await blocked;
      return { title: tabId, url: "", text: "Departs 09:40", controls: [] };
    });
    follow("g1");
    const turn = controller.message("Read the flight", [], { page: false });
    await vi.waitFor(() => expect(browser.inspectPage).toHaveBeenCalled());
    const lisbon = bindings.get("g1")!;
    follow("g2");
    expect(controller.snapshot()).toBeNull();

    await controller.deskConversation({ type: "choose", groupId: "g2", runId: lisbon });
    expect(controller.snapshot()?.runId).toBe(lisbon);
    expect(controller.snapshot()?.status).toBe("running");
    expect(bindings.get("g1")).toBe(lisbon);
    expect(bindings.get("g2")).toBe(lisbon);
    expect(controller.spaceAgents()).toEqual({ g1: "working", g2: "working" });
    // While it acts, the space it is shown in cannot be handed another.
    await controller.message("Something else of g2's", [], { page: false }).catch(() => undefined);
    expect(controller.snapshot()?.runId).toBe(lisbon);

    release!();
    await turn;
    await vi.waitFor(() => expect(controller.snapshot()?.status).toBe("completed"));
    follow("g1");
    expect(controller.snapshot()?.runId).toBe(lisbon);
  });

  it("goes to a conversation in another space when asked to (a notification pressed), and brings a reminder's task into the space in front", async () => {
    const model = scripted([
      calls({ name: "ask_user", input: { prompt: "Which hotel?", description: "Two match the dates", choices: [{ label: "Avenida", value: "avenida", description: "By the station" }, { label: "Baixa", value: "baixa", description: "In the old town" }] } }),
      answer("Digest: nothing overdue."),
    ]);
    const { controller, follow, bindings, desk } = deskHarness(model);
    follow("g1");
    await controller.message("Book the hotel", [], { page: false });
    const lisbon = bindings.get("g1")!;
    follow("g2");

    // Its space comes to the front, and with it the conversation, its question still asked.
    await expect(controller.reveal(lisbon)).resolves.toBe(true);
    expect(desk.browser.selectGroup).toHaveBeenCalledWith("g1");
    expect(controller.snapshot()?.runId).toBe(lisbon);
    expect(controller.snapshot()?.pendingQuestion?.prompt).toBe("Which hotel?");

    // A reminder's task is no space's: it ran out of sight, and is shown in the space the person is in.
    follow("g2");
    const onStarted = vi.fn();
    await controller.startScheduled({ reminderId: "r1", occurrenceId: "o1", title: "Morning check", prompt: "Check the invoices", scheduledFor: "2026-08-29T09:00:00.000Z", onStarted });
    const task = onStarted.mock.calls[0]![0] as string;
    expect(controller.snapshot()).toBeNull();
    expect(bindings.groupsOf(task)).toEqual([]);
    await expect(controller.reveal(task)).resolves.toBe(true);
    expect(controller.snapshot()?.runId).toBe(task);
    expect(bindings.get("g2")).toBe(task);
    // One that is gone cannot be gone to.
    await expect(controller.reveal("no-such-run")).resolves.toBe(false);
    // And Lisbon's question waited through all of it.
    expect(controller.spaceAgents()).toEqual({ g1: "asking" });
  });

  it("brings a turn that was cut short by a crash back paused, whenever its space is next looked at", async () => {
    const dir = scratch();
    let release: (() => void) | null = null;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const first = deskHarness(scripted([calls({ name: "page_inspect", input: { tabId: "tab-1" } }), answer("Too late.")]), [], dir);
    first.browser.inspectPage.mockImplementationOnce(async (tabId: string) => {
      await blocked;
      return { title: tabId, url: "", text: "", controls: [] };
    });
    first.follow("g1");
    const turn = first.controller.message("Read the flight", [], { page: false });
    await vi.waitFor(() => expect(first.browser.inspectPage).toHaveBeenCalled());
    const lisbon = first.bindings.get("g1")!;
    // The app dies here: the store has the turn as it was, running, and nothing marked it paused (no shutdown).
    first.controller.flush();
    expect(first.threads.get(lisbon)?.run.status).toBe("running");

    const second = deskHarness(scripted([]), [], dir);
    second.follow("g2");
    expect(second.controller.snapshot()).toBeNull();
    second.follow("g1");
    const back = second.controller.snapshot()!;
    expect(back.runId).toBe(lisbon);
    expect(back.status).toBe("interrupted");
    expect(back.control).toBe("human");
    expect(back.messages.at(-1)?.content).toContain("restarted");
    expect(second.controller.spaceAgents()).toEqual({});

    release!();
    await turn.catch(() => undefined);
  });

  it("starts a conversation from an empty space's Bar, with no tab in use, bound to the space in front", async () => {
    const model = scripted([answer("Nothing open here yet.")]);
    const { controller, follow, browser, bindings } = deskHarness(model);
    follow("g2");
    browser.activeTab.mockReturnValue(null as unknown as BrowserTabInfo);
    await controller.message("What can I do here?", [], { page: false });
    const run = controller.snapshot()!;
    expect(run.humanTabId).toBeNull();
    expect(run.groupId).toBe("g2");
    expect(bindings.get("g2")).toBe(run.runId);
  });

  it("continues a conversation another group started, and starts a new one on request", async () => {
    const model = scripted([answer("For Lisbon."), answer("Continued at the groceries.")]);
    const { controller, bindings, follow } = deskHarness(model);
    follow("g1");
    await controller.message("Plan Lisbon", [], { page: false });
    const lisbon = controller.snapshot()!.runId;

    follow("g2");
    expect(controller.snapshot()).toBeNull();
    // Only the space in front may be chosen for.
    await expect(controller.deskConversation({ type: "choose", groupId: "g1", runId: lisbon })).rejects.toThrow("that desk is not open");
    await controller.deskConversation({ type: "choose", groupId: "g2", runId: lisbon });
    expect(controller.snapshot()?.runId).toBe(lisbon);
    expect(bindings.get("g2")).toBe(lisbon);
    expect(bindings.get("g1")).toBe(lisbon);
    // Continued here, its turns are this desk's.
    await controller.message("And for the groceries?", [], { page: false });
    expect(userTexts(model.doGenerateCalls.at(-1)!.prompt).join("\n")).toContain("Desk: the space “Groceries”");

    await controller.deskConversation({ type: "new", groupId: "g2" });
    expect(controller.snapshot()).toBeNull();
    expect(bindings.get("g2")).toBeNull();
    // The group it came from keeps it.
    expect(bindings.get("g1")).toBe(lisbon);
  });

  it("opens the conversation a space merged into the one in front brings, and goes on in it (moveSpaceHoldings, groupConversationChanged)", async () => {
    const model = scripted([answer("For Lisbon."), answer("Still Lisbon, at the groceries.")]);
    const { controller, bindings, threads, context, follow } = deskHarness(model);
    follow("g1");
    await controller.message("Plan Lisbon", [], { page: false });
    const lisbon = controller.snapshot()!.runId;

    // The groceries in front, with no conversation of its own: an empty console.
    follow("g2");
    expect(controller.snapshot()).toBeNull();
    // Lisbon merged into the groceries: its conversation is the groceries' now, and main says so (index.ts's
    // moveGroupHoldings) — the space in front is the same, so following it would tell the session nothing.
    expect(moveSpaceHoldings({ contexts: context, conversations: bindings, threads }, "g1", "g2", "Groceries")).toBe(true);
    follow("g2");
    expect(controller.snapshot()).toBeNull();
    controller.groupConversationChanged("g2");
    expect(controller.snapshot()?.runId).toBe(lisbon);

    // The next message goes on in it — never a fresh thread bound over the one moved in.
    await controller.message("And for the groceries?", [], { page: false });
    expect(controller.snapshot()?.runId).toBe(lisbon);
    expect(bindings.get("g2")).toBe(lisbon);
    expect(bindings.get("g1")).toBeNull();
    expect(userTexts(model.doGenerateCalls.at(-1)!.prompt).join("\n")).toContain("Desk: the space “Groceries”");

    // A space with no conversation merged in changes none: there is nothing to tell the session.
    expect(moveSpaceHoldings({ contexts: context, conversations: bindings, threads }, "g3", "g2", "Groceries")).toBe(false);
  });

  it("forgets a deleted conversation's groups", async () => {
    const model = scripted([answer("Planned.")]);
    const { controller, bindings, follow } = deskHarness(model);
    follow("g1");
    await controller.message("Plan Lisbon", [], { page: false });
    const runId = controller.snapshot()!.runId;
    controller.deleteThread(runId);
    expect(bindings.get("g1")).toBeNull();
  });
});

/* --------------------------- the scripted model --------------------------- */

describe("the scripted agent model", () => {
  it("is only there under E2E with a script", () => {
    expect(scriptedAgentModel({})).toBeNull();
    expect(scriptedAgentModel({ PISTACHIO_E2E: "1" })).toBeNull();
    expect(scriptedAgentModel({ PISTACHIO_E2E: "1", PISTACHIO_AGENT_SCRIPT: "{nope" })).toBeNull();
    expect(scriptedAgentModel({ PISTACHIO_E2E: "1", PISTACHIO_AGENT_SCRIPT: JSON.stringify({ steps: [] }) })).not.toBeNull();
  });

  it("names tabs and items by what the prompt shows", async () => {
    const factory = scriptedAgentModel({
      PISTACHIO_E2E: "1",
      PISTACHIO_AGENT_SCRIPT: JSON.stringify({
        steps: [{ tools: [{ name: "desk_arrange", input: { place: [{ tabId: "{{tab:Hotel}}", zone: "right" }] } }, { name: "context_read", input: { id: "{{item:boarding}}" } }] }, { text: "Done." }],
      }),
    })!;
    const model = factory() as unknown as { doGenerate(options: { prompt: unknown }): Promise<{ content: Array<{ type: string; toolName?: string; input?: string; text?: string }> }> };
    const prompt = [
      {
        role: "user",
        content: [{ type: "text", text: "Desk: …\n- tab 7f3a “Flight” https://air.example/ — 0 0 50 100\n- tab 9c1d “Hotel Avenida” https://hotel.example/\n- 0123456789ab file “boarding-pass.pdf” (application/pdf, 90 KB)" }],
      },
    ];
    const first = await model.doGenerate({ prompt });
    expect(first.content.map((part) => [part.toolName, JSON.parse(part.input ?? "{}")])).toEqual([
      ["desk_arrange", { place: [{ tabId: "9c1d", zone: "right" }] }],
      ["context_read", { id: "0123456789ab" }],
    ]);
    const second = await model.doGenerate({ prompt });
    expect(second.content).toEqual([{ type: "text", text: "Done." }]);
  });
});
