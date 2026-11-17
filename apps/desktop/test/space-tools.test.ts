/**
 * The agent's space tools in main (docs/primitives.md §2), end to end
 * through the real controller and runner with a scripted model and a fake
 * away service: the spaces listed as the model reads them, a space sent
 * away as the agent — `ownTurn` only from a desk turn at work in that very
 * space — one brought back without moving the person, each call in the
 * trace and the evidence chain. And the turns that have none of them.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { NotificationRouter } from "@pistachio/notifications";
import { AWAY_REFUSALS, awayRefused, formatReturn, type AwayHolder, type AwayOutcome, type AwaySpaceInfo } from "@pistachio/shell-contracts/away";
import type { DeskAgentState, DeskReply, DeskRequest } from "@pistachio/shell-contracts/desk-agent";
import type { BrowserTabInfo } from "@pistachio/shell-contracts/ipc";
import type { BrowserController } from "../src/main/browser-controller";
import { DeskConversationStore } from "../src/main/desk-conversations";
import { GroupContextStore } from "../src/main/group-context-store";
import { type DeskAgentHost, type RunSpaces } from "../src/main/run-controller";
import { RunHub } from "../src/main/run-hub";
import { ThreadStore } from "../src/main/thread-store";

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "pistachio-space-tools-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------ the model -------------------------------- */

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
function offered(options: CallOptions): string[] {
  return (options.tools ?? []).map((tool) => tool.name);
}
function systemText(prompt: Prompt): string {
  return prompt.filter((message) => message.role === "system").map((message) => message.content).join("\n");
}
/** What the model was sent back for each call of `toolName`, in order. */
function resultsOf(prompt: Prompt, toolName: string): unknown[] {
  return prompt.flatMap((message) =>
    message.role === "tool"
      ? message.content.flatMap((part) => (part.type === "tool-result" && part.toolName === toolName ? [(part.output as { value?: unknown }).value] : []))
      : [],
  );
}

/* ------------------------------ the harness ------------------------------ */

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

function awayInfo(id: string, title: string, by: AwayHolder, until?: number): AwaySpaceInfo {
  return { id, spaceId: "work", title, color: "green", tabCount: 3, favicons: [], by, since: Date.parse("2026-08-01T12:00:00Z"), ...(until === undefined ? {} : { until }) };
}

const TITLES: Record<string, string> = { g1: "Football", g2: "Work" };

/** Main's away service and the rail, as the controller reaches them: two spaces here (g2 in front), three away. */
function spacesStub() {
  const stub = {
    list: vi.fn((_profileId: string) => [
      { id: "g1", title: "Football", tabCount: 2 },
      { id: "g2", title: "Work", tabCount: 5 },
    ]),
    current: vi.fn((_profileId: string): string | null => "g2"),
    away: vi.fn((_profileId: string) => [
      awayInfo("a1", "Taxes", { kind: "person" }),
      awayInfo("a2", "Trip", { kind: "agent" }, Date.parse("2026-12-01T16:00:00Z")),
      awayInfo("a3", "Scores", { kind: "extension", extensionId: "dev.me.game-day", name: "Game day" }),
    ]),
    send: vi.fn(async (groupId: string, options: { by: AwayHolder; until?: number; ownTurn?: boolean }): Promise<AwayOutcome> => ({
      ok: true,
      space: awayInfo(groupId, TITLES[groupId] ?? groupId, options.by, options.until),
    })),
    bringBack: vi.fn(async (id: string, _options: { select?: boolean }): Promise<AwayOutcome> => ({ ok: true, space: awayInfo(id, "Taxes", { kind: "person" }) })),
    close: vi.fn(async (groupId: string, _options: { by: AwayHolder; ownTurn?: boolean }): Promise<{ ok: true; title: string } | { ok: false; reason: string }> => ({ ok: true, title: TITLES[groupId] ?? groupId })),
  } satisfies RunSpaces;
  return stub;
}

function harness(model: MockLanguageModelV4, options: { spaces?: RunSpaces | null } = {}) {
  const dir = scratch();
  const tabs = [browserTab("tab-1", "Standings"), browserTab("tab-2", "Scores")];
  const browser = {
    allTabs: vi.fn(() => tabs),
    activeTab: vi.fn(() => tabs[0] ?? null),
    createTab: vi.fn(async () => "tab-9"),
    openHiddenTab: vi.fn(async () => "tab-9"),
    hiddenTabs: vi.fn(() => []),
    closeHiddenTabs: vi.fn(),
    holdPopupsHidden: vi.fn(() => () => undefined),
    selectTab: vi.fn(async () => undefined),
    inspectPage: vi.fn(async (tabId: string) => ({ title: tabId, url: "", text: "", controls: [] })),
    tab: vi.fn((id: string) => tabs.find((item) => item.id === id) ?? null),
  };
  const state = (groupId: string): DeskAgentState => ({
    groupId,
    title: TITLES[groupId] ?? groupId,
    windows: [{ tabId: "tab-1", kind: "tab", title: "Standings", url: "https://tab-1.example/", box: { x: 0, y: 0, w: 100, h: 100 }, focused: true, masked: false }],
    docked: [],
  });
  let shown = "g1";
  let current: string | null = null;
  const members: Record<string, string[]> = { g1: ["tab-1", "tab-2"], g2: [] };
  const desk: DeskAgentHost = {
    bridge: { request: vi.fn(async (_request: DeskRequest): Promise<DeskReply> => ({ ok: true, state: state(shown) })), cancelAll: vi.fn() },
    bindings: new DeskConversationStore(dir),
    browser: {
      tabGroupMembers: (groupId) => members[groupId] ?? null,
      tabGroupSpaceId: (groupId) => (members[groupId] === undefined ? null : "work"),
      showHiddenTabInGroup: vi.fn(() => false),
      ungroupTabs: vi.fn((_groupId, tabIds) => [...tabIds]),
      holdGroup: vi.fn(() => () => undefined),
      currentGroupId: () => current,
    },
    context: new GroupContextStore(dir),
  };
  const spaces = options.spaces === undefined ? spacesStub() : options.spaces;
  const controller = new RunHub({
    browser: browser as unknown as BrowserController,
    notifications: new NotificationRouter([]),
    onChange: () => undefined,
    threads: new ThreadStore(dir),
    model: () => model,
    summarize: async () => "SUMMARY",
    limits: { stepsPerCall: 40, continuations: 5 },
    budget: { window: 200_000, compactAt: 100_000 },
    desk,
    ...(spaces === null ? {} : { spaces }),
  });
  /** Main passes the desk to a space, and the session follows (onCurrentGroupChange). */
  const follow = (groupId: string | null): void => {
    current = groupId;
    if (groupId !== null) shown = groupId;
    controller.followGroup(groupId);
  };
  return { controller, spaces: spaces as ReturnType<typeof spacesStub>, follow };
}

const SPACE_TOOLS = ["spaces_list", "space_send_away", "space_bring_back", "space_close"];

/* --------------------------------- tests ---------------------------------- */

describe("the agent's space tools", () => {
  it("list the rail and what is away as the model reads them: the space in front marked, each sender in words", async () => {
    const model = scripted([calls({ name: "spaces_list", input: {} }), answer("Football and Work; three are away.")]);
    const { controller, spaces } = harness(model);
    await controller.start("Which spaces do I have?");

    expect(offered(model.doGenerateCalls[0]!)).toEqual(expect.arrayContaining(SPACE_TOOLS));
    expect(systemText(model.doGenerateCalls[0]!.prompt)).toContain("Space rules:");
    expect(spaces.list).toHaveBeenCalledWith("work");
    expect(resultsOf(model.doGenerateCalls[1]!.prompt, "spaces_list")).toEqual([
      {
        spaces: [
          { id: "g1", title: "Football", tabCount: 2, current: false },
          { id: "g2", title: "Work", tabCount: 5, current: true },
        ],
        away: [
          { id: "a1", title: "Taxes", tabCount: 3, since: "2026-08-01T12:00:00.000Z", until: null, by: "the person" },
          { id: "a2", title: "Trip", tabCount: 3, since: "2026-08-01T12:00:00.000Z", until: "2026-12-01T16:00:00.000Z", by: "you" },
          { id: "a3", title: "Scores", tabCount: 3, since: "2026-08-01T12:00:00.000Z", until: null, by: "Game day" },
        ],
      },
    ]);
    const run = controller.snapshot()!;
    expect(run.toolCalls.map((call) => [call.name, call.label, call.status])).toEqual([["spaces.list", "Looking at the spaces", "completed"]]);
  });

  it("send a space away as the agent, until the time given, and bring one back without moving the person", async () => {
    // Three days on: the sentence names the day, whenever this runs.
    const until = Math.floor(Date.now() / 60_000) * 60_000 + 3 * 86_400_000;
    const model = scripted([
      calls({ name: "space_send_away", input: { spaceId: "g1", at: new Date(until).toISOString(), inMinutes: null } }),
      calls({ name: "space_bring_back", input: { spaceId: "a1" } }),
      answer("Football is away; Taxes is back."),
    ]);
    const { controller, spaces } = harness(model);
    await controller.start("Hide Football for three days and bring Taxes back");

    // By the agent, not from inside the space: no `ownTurn` — a console turn holds no space.
    expect(spaces.send).toHaveBeenCalledTimes(1);
    expect(spaces.send).toHaveBeenCalledWith("g1", { by: { kind: "agent" }, until });
    expect(spaces.bringBack).toHaveBeenCalledWith("a1", { select: false });
    const back = formatReturn(until, Date.now(), { timeZone: controller.timezone() });
    expect(resultsOf(model.doGenerateCalls[1]!.prompt, "space_send_away")).toEqual([{ ok: true, title: "Football", until: new Date(until).toISOString(), back }]);
    expect(resultsOf(model.doGenerateCalls[2]!.prompt, "space_bring_back")).toEqual([{ ok: true, title: "Taxes", until: null, back: "now" }]);

    const run = controller.snapshot()!;
    expect(run.toolCalls.map((call) => [call.name, call.label, call.status])).toEqual([
      ["space.sendAway", "Sending a space away", "completed"],
      ["space.bringBack", "Bringing a space back", "completed"],
    ]);
    // In the evidence chain as a surface of their own, the way reminders and the desk are.
    const evidence = controller.evidence();
    expect(evidence.filter((entry) => entry.type === "space.tool.started")).toHaveLength(2);
    expect(evidence.filter((entry) => entry.type === "space.action")).toHaveLength(2);
    expect(evidence.some((entry) => entry.type === "browser.action")).toBe(false);
  });

  it("send it away until asked when no time is given", async () => {
    const model = scripted([calls({ name: "space_send_away", input: { spaceId: "g1", at: null, inMinutes: null } }), answer("Away until you ask.")]);
    const { controller, spaces } = harness(model);
    await controller.start("Put Football away");
    expect(spaces.send).toHaveBeenCalledWith("g1", { by: { kind: "agent" } });
    expect(resultsOf(model.doGenerateCalls[1]!.prompt, "space_send_away")).toEqual([{ ok: true, title: "Football", until: null, back: "when asked" }]);
  });

  it("pass on the service's sentence when it refuses, as a failed step", async () => {
    const model = scripted([calls({ name: "space_send_away", input: { spaceId: "g1", at: "2020-01-01T08:00:00Z", inMinutes: null } }), answer("That time has passed.")]);
    const { controller, spaces } = harness(model);
    spaces.send.mockResolvedValueOnce(awayRefused("past"));
    await controller.start("Hide Football until New Year 2020");

    expect(spaces.send).toHaveBeenCalledWith("g1", { by: { kind: "agent" }, until: Date.parse("2020-01-01T08:00:00Z") });
    expect(resultsOf(model.doGenerateCalls[1]!.prompt, "space_send_away")).toEqual([{ ok: false, reason: AWAY_REFUSALS.past }]);
    const run = controller.snapshot()!;
    expect(run.status).toBe("completed");
    expect(run.toolCalls.map((call) => [call.name, call.status])).toEqual([["space.sendAway", "failed"]]);
  });

  it("never reach the service for a space the list did not name", async () => {
    const model = scripted([
      calls({ name: "space_send_away", input: { spaceId: "somewhere-else", at: null, inMinutes: null } }),
      calls({ name: "space_bring_back", input: { spaceId: "g1" } }),
      answer("Neither is one I can reach."),
    ]);
    const { controller, spaces } = harness(model);
    await controller.start("Hide that space");
    expect(spaces.send).not.toHaveBeenCalled();
    expect(spaces.bringBack).not.toHaveBeenCalled();
    expect(resultsOf(model.doGenerateCalls[1]!.prompt, "space_send_away")).toEqual([{ ok: false, reason: AWAY_REFUSALS.unknown }]);
    expect(resultsOf(model.doGenerateCalls[2]!.prompt, "space_bring_back")).toEqual([{ ok: false, reason: AWAY_REFUSALS.notAway }]);
  });
});

describe("the agent closing a space", () => {
  it("closes it as the agent, through main's one verb, and says how it comes back", async () => {
    const model = scripted([calls({ name: "space_close", input: { spaceId: "g1" } }), answer("Football is closed; it is in the archive.")]);
    const { controller, spaces } = harness(model);
    await controller.start("I am done with Football, close it");
    expect(spaces.close).toHaveBeenCalledWith("g1", { by: { kind: "agent" } });
    expect(resultsOf(model.doGenerateCalls[1]!.prompt, "space_close")).toEqual([{ ok: true, title: "Football", until: null, back: "from the archive, when the person restores it" }]);
    expect(controller.snapshot()!.toolCalls.map((call) => [call.name, call.label, call.status])).toEqual([["space.close", "Closing a space", "completed"]]);
  });

  it("passes on main's sentence when it may not, and never reaches the verb for a space the list did not name", async () => {
    const model = scripted([
      calls({ name: "space_close", input: { spaceId: "g1" } }),
      calls({ name: "space_close", input: { spaceId: "somewhere-else" } }),
      answer("It is being shared."),
    ]);
    const { controller, spaces } = harness(model);
    spaces.close.mockResolvedValueOnce({ ok: false, reason: "This space is being shared live. End the share, then close it." });
    await controller.start("Close Football");
    expect(spaces.close).toHaveBeenCalledTimes(1);
    expect(resultsOf(model.doGenerateCalls[1]!.prompt, "space_close")).toEqual([{ ok: false, reason: "This space is being shared live. End the share, then close it." }]);
    expect(resultsOf(model.doGenerateCalls[2]!.prompt, "space_close")).toEqual([{ ok: false, reason: "This space is being shared live. End the share, then close it." }, { ok: false, reason: AWAY_REFUSALS.unknown }]);
    expect(controller.snapshot()!.toolCalls.map((call) => call.status)).toEqual(["failed", "failed"]);
  });
});

describe("a desk turn's space tools", () => {
  it("mark the turn's own space as the one in front, and send it away from under itself — `ownTurn` for that space alone", async () => {
    const model = scripted([
      calls({ name: "spaces_list", input: {} }),
      calls({ name: "space_send_away", input: { spaceId: "g2", at: null, inMinutes: 60 } }),
      calls({ name: "space_send_away", input: { spaceId: "g1", at: null, inMinutes: null } }),
      answer("Both are away."),
    ]);
    const { controller, spaces, follow } = harness(model);
    follow("g1");
    await controller.message("Hide this space, and Work for an hour", [], { page: false });

    // The turn works in g1, whatever main says is in front by now.
    const [listed] = resultsOf(model.doGenerateCalls[1]!.prompt, "spaces_list") as Array<{ spaces: Array<{ id: string; current: boolean }> }>;
    expect(listed!.spaces).toEqual([expect.objectContaining({ id: "g1", current: true }), expect.objectContaining({ id: "g2", current: false })]);
    expect(spaces.send).toHaveBeenCalledTimes(2);
    const [other, own] = spaces.send.mock.calls;
    expect(other![0]).toBe("g2");
    expect(other![1]).toMatchObject({ by: { kind: "agent" } });
    expect(other![1]).not.toHaveProperty("ownTurn");
    expect(typeof other![1].until).toBe("number");
    expect(own).toEqual(["g1", { by: { kind: "agent" }, ownTurn: true }]);
    expect(controller.snapshot()!.toolCalls.map((call) => call.name)).toEqual(["spaces.list", "space.sendAway", "space.sendAway"]);
  });
});

describe("turns with no space tools", () => {
  it("has none where the host has no away service", async () => {
    const model = scripted([answer("Hello.")]);
    const { controller } = harness(model, { spaces: null });
    await controller.start("Hello");
    for (const name of SPACE_TOOLS) expect(offered(model.doGenerateCalls[0]!)).not.toContain(name);
    expect(systemText(model.doGenerateCalls[0]!.prompt)).not.toContain("Space rules:");
  });

  it("has none on a turn a reminder started: nobody is there to see a space go", async () => {
    const model = scripted([answer("Digest: nothing new.")]);
    const { controller, spaces } = harness(model);
    const outcome = await controller.startScheduled({
      reminderId: "reminder-1",
      occurrenceId: "occurrence-1",
      title: "Sunday night tidy",
      prompt: "Send the Football space away",
      scheduledFor: "2026-08-30T23:00:00.000Z",
      onStarted: vi.fn(),
    });
    expect(outcome).toMatchObject({ status: "completed" });
    const first = model.doGenerateCalls[0]!;
    for (const name of SPACE_TOOLS) expect(offered(first)).not.toContain(name);
    expect(systemText(first.prompt)).not.toContain("Space rules:");
    expect(offered(first)).toContain("tabs_list");
    expect(spaces.send).not.toHaveBeenCalled();
  });
});
