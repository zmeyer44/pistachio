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
import { RunController, type DeskAgentHost } from "../src/main/run-controller";
import { scriptedAgentModel } from "../src/main/scripted-agent-model";
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
    await expect(scope.openTab("https://air.example")).rejects.toThrow(/group is gone/);
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

function deskHarness(model: MockLanguageModelV4, events: string[] = []) {
  const dir = scratch();
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
  const requests: DeskRequest[] = [];
  const bridge = {
    request: vi.fn(async (request: DeskRequest): Promise<DeskReply> => {
      requests.push(request);
      return { ok: true, state: state(shown) };
    }),
    cancelAll: vi.fn(),
  };
  const members: Record<string, string[]> = { g1: ["tab-1", "tab-2"], g2: [] };
  const context = new GroupContextStore(dir);
  context.addText("g1", "Lisbon", { kind: "fact", text: "Hotel confirmation QX7F2L" }, "person");
  const bindings = new DeskConversationStore(dir);
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
    },
    context,
  };
  const controller = new RunController({
    browser: browser as unknown as BrowserController,
    notifications: new NotificationRouter([]),
    onChange: () => undefined,
    threads: new ThreadStore(dir),
    model: () => model,
    summarize: async () => "SUMMARY",
    limits: { stepsPerCall: 40, continuations: 5 },
    budget: { window: 200_000, compactAt: 100_000 },
    router: async () => {
      throw new Error("a desk turn is never routed");
    },
    desk,
  });
  return { controller, bridge, requests, bindings, context, desk, browser, show: (groupId: string) => (shown = groupId) };
}

describe("a turn at a desk", () => {
  it("starts the group's conversation, with the desk and its context in the prompt, and arranges it through the shell", async () => {
    const model = scripted([
      calls({ name: "desk_arrange", input: { layout: null, place: [{ tabId: "tab-1", zone: "left", box: null }, { tabId: "tab-2", zone: "right", box: null }], bringOut: null, putAway: null } }),
      calls({ name: "desk_note", input: { tabId: "tab-1", text: "Lands 11:05" } }),
      calls({ name: "context_save", input: { kind: "fact", text: "Flight lands 11:05", url: null, title: null } }),
      answer("Side by side now; the flight lands before check-in."),
    ]);
    const { controller, requests, bindings, context } = deskHarness(model);
    await controller.deskConversation({ type: "enter", groupId: "g1" });
    await controller.message("Put the flight beside the hotel", [], { page: false });

    const run = controller.snapshot()!;
    expect(run.status).toBe("completed");
    expect(run.groupId).toBe("g1");
    expect(bindings.get("g1")).toBe(run.runId);
    const first = userTexts(model.doGenerateCalls[0]!.prompt).join("\n");
    expect(first).toContain("Desk: the tab group “Lisbon”");
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
    const { controller } = deskHarness(model, events);
    await controller.deskConversation({ type: "enter", groupId: "g1" });
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
    const { controller, requests, desk, browser } = deskHarness(model);
    await controller.deskConversation({ type: "enter", groupId: "g1" });
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

  it("goes back to the conversation that was open before the desk, and reopens the group's on the way back", async () => {
    const model = scripted([answer("Elsewhere."), answer("At the desk.")]);
    const { controller } = deskHarness(model);
    await controller.message("A question from the sidebar", [], { page: false });
    const before = controller.snapshot()!.runId;

    await controller.deskConversation({ type: "enter", groupId: "g1" });
    expect(controller.snapshot()).toBeNull();
    await controller.message("And one at the desk", [], { page: false });
    const atDesk = controller.snapshot()!.runId;
    expect(atDesk).not.toBe(before);

    await controller.deskConversation({ type: "leave" });
    expect(controller.snapshot()?.runId).toBe(before);
    await controller.deskConversation({ type: "enter", groupId: "g1" });
    expect(controller.snapshot()?.runId).toBe(atDesk);
    // A conversation from before any desk is no group's.
    expect(controller.threads().find((item) => item.runId === before)?.groupId).toBeUndefined();
    expect(controller.threads().find((item) => item.runId === atDesk)?.groupId).toBe("g1");
  });

  it("continues a conversation another group started, and starts a new one on request", async () => {
    const model = scripted([answer("For Lisbon."), answer("Continued at the groceries.")]);
    const { controller, bindings, show } = deskHarness(model);
    await controller.deskConversation({ type: "enter", groupId: "g1" });
    await controller.message("Plan Lisbon", [], { page: false });
    const lisbon = controller.snapshot()!.runId;

    show("g2");
    await controller.deskConversation({ type: "enter", groupId: "g2" });
    expect(controller.snapshot()).toBeNull();
    await controller.deskConversation({ type: "choose", groupId: "g2", runId: lisbon });
    expect(controller.snapshot()?.runId).toBe(lisbon);
    expect(bindings.get("g2")).toBe(lisbon);
    expect(bindings.get("g1")).toBe(lisbon);
    // Continued here, its turns are this desk's.
    await controller.message("And for the groceries?", [], { page: false });
    expect(userTexts(model.doGenerateCalls.at(-1)!.prompt).join("\n")).toContain("Desk: the tab group “Groceries”");

    await controller.deskConversation({ type: "new", groupId: "g2" });
    expect(controller.snapshot()).toBeNull();
    expect(bindings.get("g2")).toBeNull();
    // The group it came from keeps it.
    expect(bindings.get("g1")).toBe(lisbon);
  });

  it("forgets a deleted conversation's groups", async () => {
    const model = scripted([answer("Planned.")]);
    const { controller, bindings } = deskHarness(model);
    await controller.deskConversation({ type: "enter", groupId: "g1" });
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
