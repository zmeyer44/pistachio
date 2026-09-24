/**
 * The thread as the controller keeps it, end to end through the real
 * runner with a scripted model and a fake browser: one conversation that
 * survives completion, questions, budget pauses, restarts, and compaction,
 * persisted to a thread store as it goes.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { verifyEvidenceEntries } from "@pistachio/evidence";
import { NotificationRouter, type NotificationAdapter, type NotificationMessage } from "@pistachio/notifications";
import { PAGE_IN_VIEW_HEADER, TURN_CUT_SHORT, USE_BROWSER_TOOL, type TurnRouteRequest } from "@pistachio/agent-runtime";
import type { RunSummary, TaskStatus } from "@pistachio/protocol";
import { agentDrivenTabId } from "@pistachio/shell-contracts/agent-glow";
import { noteUrl, searchNotes, summaryOf, type Note } from "@pistachio/shell-contracts/notes";
import type { BrowserController } from "../src/main/browser-controller";
import { ArtifactStore } from "../src/main/artifact-store";
import { RunController, type CloudRunCommands, type NoteRecordStore, type TurnRouter } from "../src/main/run-controller";
import { ThreadStore, type ThreadRecord } from "../src/main/thread-store";
import type { BrowserTabInfo } from "@pistachio/shell-contracts/ipc";

/* ------------------------------ the model -------------------------------- */

type CallOptions = Parameters<MockLanguageModelV4["doGenerate"]>[0];
type Prompt = CallOptions["prompt"];
type GenerateResult = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;
type Step = (options: CallOptions) => GenerateResult | Promise<GenerateResult>;

let nextCallId = 0;

function usageFor(prompt: Prompt): GenerateResult["usage"] {
  const tokens = Math.ceil(JSON.stringify(prompt).length / 4) + 4_000;
  return {
    inputTokens: { total: tokens, noCache: tokens, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 20, text: 20, reasoning: undefined },
  };
}

function calls(...requests: Array<{ name: string; input: Record<string, unknown> }>): Step {
  return ({ prompt }) => ({
    content: requests.map((request) => ({
      type: "tool-call" as const,
      toolCallId: `call-${String(++nextCallId)}`,
      toolName: request.name,
      input: JSON.stringify(request.input),
    })),
    finishReason: { unified: "tool-calls", raw: "tool_use" },
    usage: usageFor(prompt),
    warnings: [],
  });
}

function answer(text: string): Step {
  return ({ prompt }) => ({
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "end_turn" },
    usage: usageFor(prompt),
    warnings: [],
  });
}

function silence(): Step {
  return ({ prompt }) => ({
    content: [],
    finishReason: { unified: "stop", raw: "end_turn" },
    usage: usageFor(prompt),
    warnings: [],
  });
}

/** A model that answers from `script` (which tests may extend), then from `fallback`, then fails loudly. */
function scriptedModel(steps: Step[], fallback?: Step): { model: MockLanguageModelV4; script: Step[] } {
  const script = [...steps];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      const step = script.shift() ?? fallback;
      if (step === undefined) throw new Error(`model script exhausted after ${String(model.doGenerateCalls.length)} calls`);
      return step(options);
    },
  });
  return { model, script };
}

const tabsList = calls({ name: "tabs_list", input: {} });
const tabOpen = calls({ name: "tab_open", input: { url: "https://shop.example/" } });
const inspect = calls({ name: "page_inspect", input: { tabId: "tab-1" } });
const question = calls({
  name: "ask_user",
  input: {
    prompt: "Which colour?",
    description: "The listing comes in two colours.",
    choices: [
      { value: "blue", label: "Blue", description: "Navy blue" },
      { value: "red", label: "Red", description: "Brick red" },
    ],
  },
});
const textQuestion = calls({
  name: "ask_user_text",
  input: {
    prompt: "What ZIP code should I use?",
    description: "Local availability depends on the destination.",
    placeholder: "ZIP code",
  },
});
const takeover = calls({ name: "request_takeover", input: { reason: "Please sign in.", instructions: "Log in, then press resume." } });

/* ------------------------------ the prompt ------------------------------- */

function systemText(prompt: Prompt): string {
  return prompt.filter((message) => message.role === "system").map((message) => message.content).join("\n");
}

function userTexts(prompt: Prompt): string[] {
  const texts: string[] = [];
  for (const message of prompt) {
    if (message.role !== "user") continue;
    for (const part of message.content) if (part.type === "text") texts.push(part.text);
  }
  return texts;
}

function toolCallsIn(prompt: Prompt): string[] {
  const found: string[] = [];
  for (const message of prompt) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) if (part.type === "tool-call") found.push(part.toolName);
  }
  return found;
}

function toolResultsIn(prompt: Prompt): Array<{ toolName: string; toolCallId: string; output: unknown }> {
  const found: Array<{ toolName: string; toolCallId: string; output: unknown }> = [];
  for (const message of prompt) {
    if (message.role !== "tool") continue;
    for (const part of message.content) if (part.type === "tool-result") found.push({ toolName: part.toolName, toolCallId: part.toolCallId, output: part.output });
  }
  return found;
}

function historyToolCalls(messages: ModelMessage[]): string[] {
  const found: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const part of message.content) if (part.type === "tool-call") found.push(part.toolName);
  }
  return found;
}

/* ------------------------------ the browser ------------------------------ */

function tab(id: string, title: string, url: string): BrowserTabInfo {
  return {
    id,
    spaceId: "work",
    title,
    url,
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

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Whether `promise` settles within `ms` — for asserting that a waiter is still pending, or no longer is. */
async function settledWithin<T>(promise: Promise<T>, ms = 30): Promise<boolean> {
  const timer = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms));
  return (await Promise.race([promise.then(() => "settled" as const), timer])) === "settled";
}

/** A notification adapter that only remembers what it was handed. */
function recordingAdapter(): NotificationAdapter & { messages: NotificationMessage[] } {
  const messages: NotificationMessage[] = [];
  return {
    id: "recorder",
    messages,
    deliver: async (message) => {
      messages.push(message);
    },
  };
}

type Page = { title: string; url: string; text: string; controls: never[] };

function page(text = "Invoice NS-2048 total $120"): Page {
  return { title: "Invoice", url: "https://finance.example/invoices/1", text, controls: [] };
}

/** The line a browse turn carries about the fake browser's page in view (§5.1). */
const POINTER = "\n\n[The page the person has open: “Invoice” — https://finance.example/invoices/1 (tab tab-1). Unless the request names another page or site, it is about this page.]";

function fakeBrowser() {
  const tabs = [tab("tab-1", "Invoice", "https://finance.example/invoices/1")];
  const fake = {
    allTabs: vi.fn(() => tabs),
    activeTab: vi.fn(() => tabs[0] ?? null),
    createTab: vi.fn(async () => "tab-2"),
    selectTab: vi.fn(async () => undefined),
    navigate: vi.fn(async () => undefined),
    goBack: vi.fn(async () => undefined),
    goForward: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    inspectPage: vi.fn(async (): Promise<Page> => page()),
    clickPage: vi.fn(async () => undefined),
    typePage: vi.fn(async () => undefined),
    scrollPage: vi.fn(async () => undefined),
    screenshotPage: vi.fn(async () => "data:image/png;base64,AAAA"),
    tab: vi.fn((id: string) => tabs.find((item) => item.id === id) ?? null),
    submitAgentAction: vi.fn(async () => "completed"),
    applyAgentDraft: vi.fn(async () => undefined),
  };
  return fake;
}

/* ------------------------------ the harness ------------------------------ */

const scratchDirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "pistachio-threads-"));
  scratchDirs.push(dir);
  return dir;
}

function build(options: {
  model: MockLanguageModelV4;
  browser?: ReturnType<typeof fakeBrowser>;
  threads?: ThreadStore;
  dir?: string;
  limits?: { stepsPerCall?: number; continuations?: number };
  budget?: { window: number; compactAt: number };
  summarize?: (prompt: string) => Promise<string>;
  notifications?: NotificationRouter;
  onRunEnded?: (run: RunSummary) => void;
  cloud?: CloudRunCommands;
  artifacts?: ArtifactStore;
  watchtower?: import("../src/main/watchtower/service").WatchtowerService;
  /** The account's web origin, or null when this Mac has no account. */
  artifactWebUrl?: () => string | null;
  /** The router's opinion of every new request; absent, nothing is asked and every turn is browser work. */
  router?: TurnRouter;
}) {
  const dir = options.dir ?? scratch();
  const threads = options.threads ?? new ThreadStore(dir);
  const browser = options.browser ?? fakeBrowser();
  const statuses: Array<TaskStatus | null> = [];
  const onChange = vi.fn(() => {
    statuses.push(controller.snapshot()?.status ?? null);
  });
  const controller = new RunController({
    browser: browser as unknown as BrowserController,
    notifications: options.notifications ?? new NotificationRouter([]),
    onChange,
    threads,
    ...(options.cloud === undefined ? {} : { cloud: options.cloud }),
    ...(options.watchtower === undefined ? {} : { watchtower: options.watchtower }),
    ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
    ...(options.artifactWebUrl === undefined ? {} : { artifactWebUrl: options.artifactWebUrl }),
    ...(options.onRunEnded === undefined ? {} : { onRunEnded: options.onRunEnded }),
    ...(options.router === undefined ? {} : { router: options.router }),
    model: () => options.model,
    summarize: options.summarize ?? (async () => "SUMMARY: earlier steps"),
    limits: options.limits ?? { stepsPerCall: 40, continuations: 5 },
    budget: options.budget ?? { window: 200_000, compactAt: 100_000 },
  });
  return { controller, threads, browser, dir, statuses, onChange };
}

function iMessageCloud() {
  const events: Array<{ kind: string; questionId?: string }> = [];
  const cloud: CloudRunCommands = {
    message: async () => undefined,
    answer: async () => undefined,
    interrupt: async () => undefined,
    release: async () => undefined,
    revoke: async () => undefined,
    forget: () => undefined,
    notifyIMessage: (_record, event) => {
      events.push(structuredClone(event));
    },
  };
  return { cloud, events };
}

function lastAssistant(run: RunSummary): string {
  return [...run.messages].reverse().find((message) => message.role === "assistant")?.content ?? "";
}

function savedRun(overrides: Partial<RunSummary> = {}): RunSummary {
  const at = "2026-08-29T10:00:00.000Z";
  return {
    runId: "run-restore-1",
    taskId: "task-1",
    status: "running",
    purpose: "Check the invoice",
    title: "Check the invoice",
    updatedAt: at,
    turns: 1,
    notes: "Plan:\n- [x] open the invoice\n- [ ] read the total",
    context: { tokens: 1_200, compactAt: 100_000, window: 200_000, compactions: 0, steps: 1, totalSteps: 1, usage: { inputTokens: 1_200, outputTokens: 20 } },
    humanTabId: "tab-1",
    agentTabId: null,
    startedAt: at,
    completedAt: null,
    control: "agent",
    pendingApproval: null,
    pendingQuestion: null,
    pendingTakeover: null,
    messages: [
      { id: "m1", at, role: "user", content: "Check the invoice", turn: 1 },
      { id: "m2", at, role: "assistant", content: "I’m on it.", turn: 1 },
    ],
    toolCalls: [{ id: "t1", name: "page.inspect", label: "Read page", detail: "Inspecting visible content in tab tab-1", status: "running", startedAt: at, completedAt: null, tabId: "tab-1", turn: 1 }],
    subagents: [],
    activity: [],
    result: null,
    ...overrides,
  };
}

const savedHistory: ModelMessage[] = [
  { role: "user", content: "Complete this browser task: Check the invoice" },
  { role: "assistant", content: [{ type: "tool-call", toolCallId: "dangling", toolName: "page_inspect", input: { tabId: "tab-1" } }] },
];

let liveBefore: string | undefined;

beforeEach(() => {
  liveBefore = process.env["PISTACHIO_AGENT_LIVE"];
  process.env["PISTACHIO_AGENT_LIVE"] = "1";
});

afterEach(() => {
  if (liveBefore === undefined) delete process.env["PISTACHIO_AGENT_LIVE"];
  else process.env["PISTACHIO_AGENT_LIVE"] = liveBefore;
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/* -------------------------------- tests ---------------------------------- */

describe("a thread from the composer", () => {
  it("runs the first turn to completion and lands in the store", async () => {
    const { model } = scriptedModel([tabsList, answer("Done: the total is $120.")]);
    const { controller, threads, dir } = build({ model });

    await controller.start("Check the invoice total");

    const run = controller.snapshot();
    expect(run).not.toBeNull();
    expect(run?.turns).toBe(1);
    expect(run?.title).toBe("Check the invoice total");
    expect(run?.purpose).toBe("Check the invoice total");
    expect(run?.messages[0]).toMatchObject({ role: "user", content: "Check the invoice total", turn: 1 });
    expect(run?.status).toBe("completed");
    expect(run?.control).toBe("human");
    expect(run?.result?.summary).toBe("Done: the total is $120.");
    expect(lastAssistant(run!)).toBe("Done: the total is $120.");
    expect(run?.toolCalls.map((tool) => [tool.name, tool.status, tool.turn])).toEqual([["tabs.list", "completed", 1]]);
    expect(run?.context.steps).toBe(2);
    expect(run?.context.totalSteps).toBe(2);
    expect(userTexts(model.doGenerateCalls[0]!.prompt)).toEqual([`Complete this browser task: Check the invoice total${POINTER}`]);

    controller.flush();
    expect(existsSync(join(dir, "threads", `${run!.runId}.json`))).toBe(true);
    const record = threads.get(run!.runId);
    expect(record?.run.status).toBe("completed");
    expect(historyToolCalls(record?.model ?? [])).toEqual(["tabs_list"]);
    expect(controller.threads().map((item) => [item.runId, item.status, item.turns])).toEqual([[run!.runId, "completed", 1]]);
  });

  it("records the tab a tab.open made, so the agent's light follows it there", async () => {
    // The call names no tab when it starts — the tab does not exist yet —
    // and the browser makes the new tab active as it opens. Until the model
    // touches it, the light would otherwise stay on the tab the run began in.
    const { model, script } = scriptedModel([tabOpen]);
    const { controller, browser } = build({ model });
    let drivenWhileThinking: string | null = null;
    script.push(({ prompt }) => {
      drivenWhileThinking = agentDrivenTabId(controller.snapshot());
      return answer("Opened the shop.")({ prompt });
    });
    await controller.start("Open the shop");

    expect(browser.createTab).toHaveBeenCalledWith("https://shop.example/");
    const opened = controller.snapshot()!.toolCalls.find((tool) => tool.name === "tab.open");
    expect(opened).toMatchObject({ status: "completed", tabId: "tab-2" });
    expect(drivenWhileThinking).toBe("tab-2");
  });

  it("continues a completed thread with the follow-up in the same run", async () => {
    const { model, script } = scriptedModel([tabsList, answer("Done: the total is $120.")]);
    const { controller, statuses } = build({ model });
    await controller.start("Check the invoice total");
    const runId = controller.snapshot()!.runId;
    statuses.length = 0;

    script.push(inspect, answer("Shipping is $8."));
    await controller.message("Now check the shipping line");

    const run = controller.snapshot()!;
    expect(run.runId).toBe(runId);
    expect(run.turns).toBe(2);
    expect(run.status).toBe("completed");
    expect(statuses).toContain("running");
    expect(statuses.at(-1)).toBe("completed");
    expect(run.messages.filter((message) => message.role === "user").map((message) => [message.content, message.turn])).toEqual([
      ["Check the invoice total", 1],
      ["Now check the shipping line", 2],
    ]);
    expect(run.result?.summary).toBe("Shipping is $8.");
    expect(lastAssistant(run)).toBe("Shipping is $8.");
    expect(run.toolCalls.map((tool) => [tool.name, tool.turn])).toEqual([["tabs.list", 1], ["page.inspect", 2]]);

    expect(model.doGenerateCalls).toHaveLength(4);
    const secondTurn = model.doGenerateCalls[2]!.prompt;
    expect(toolCallsIn(secondTurn)).toEqual(["tabs_list"]);
    expect(toolResultsIn(secondTurn).map((part) => part.toolName)).toEqual(["tabs_list"]);
    expect(userTexts(secondTurn)).toEqual([`Complete this browser task: Check the invoice total${POINTER}`, `Now check the shipping line${POINTER}`]);
    // The earlier answer stays in the history as the assistant's own words.
    expect(JSON.stringify(secondTurn)).toContain("Done: the total is $120.");
  });

  it("continues a completed cloud thread through control instead of creating a local run", async () => {
    const dir = scratch();
    const threads = new ThreadStore(dir);
    const cloudRun = savedRun({
      runId: "cloud-run-1",
      status: "completed",
      executor: { kind: "cloud", deviceId: "cloud-device-1", workerId: "worker-1" },
    });
    threads.saveNow({ version: 1, run: cloudRun, model: [] });
    const message = vi.fn(async () => undefined);
    const cloud: CloudRunCommands = {
      message,
      answer: async () => undefined,
      interrupt: async () => undefined,
      release: async () => undefined,
      revoke: async () => undefined,
      forget: () => undefined,
    };
    const { model } = scriptedModel([]);
    const { controller } = build({ model, threads, dir, cloud });
    controller.restore();

    await controller.message("Continue with checkout");

    expect(message).toHaveBeenCalledWith("cloud-run-1", "Continue with checkout", []);
    expect(controller.snapshot()?.runId).toBe("cloud-run-1");
    expect(controller.threads()).toHaveLength(1);
  });

  it("waits on a question and continues from the person's answer", async () => {
    const { model, script } = scriptedModel([tabsList, question]);
    const connector = iMessageCloud();
    const { controller } = build({ model, cloud: connector.cloud });
    await controller.start("Buy the listing in my colour");

    const waiting = controller.snapshot()!;
    expect(waiting.status).toBe("waiting_for_judgment");
    expect(waiting.control).toBe("human");
    expect(waiting.pendingQuestion?.prompt).toBe("Which colour?");
    expect(waiting.pendingQuestion?.choices.map((choice) => choice.label)).toEqual(["Blue", "Red"]);
    expect(lastAssistant(waiting)).toBe("Which colour?");
    expect(controller.busy()).toBe(true);
    expect(connector.events.map((event) => event.kind)).toEqual(["question"]);

    script.push(answer("Blue it is: added to the cart."));
    await controller.answerQuestion(waiting.pendingQuestion!.id, "blue");

    const run = controller.snapshot()!;
    expect(run.status).toBe("completed");
    expect(run.pendingQuestion).toBeNull();
    expect(connector.events.map((event) => event.kind)).toEqual(["question", "resolved", "completion"]);
    expect(connector.events[1]).toMatchObject({ kind: "resolved", questionId: waiting.pendingQuestion!.id });
    expect(run.purpose).toBe("Buy the listing in my colour — Blue");
    expect(run.turns).toBe(2);
    expect(run.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual(["Buy the listing in my colour", "Blue"]);
    expect(model.doGenerateCalls).toHaveLength(3);
    const prompt = model.doGenerateCalls[2]!.prompt;
    expect(userTexts(prompt).at(-1)).toBe("[The person answered your question]\nBlue");
    expect(toolCallsIn(prompt)).toEqual(["tabs_list", "ask_user"]);
    expect(toolResultsIn(prompt).map((part) => part.toolName)).toEqual(["tabs_list", "ask_user"]);
    await expect(controller.answerQuestion(waiting.pendingQuestion!.id, "red")).rejects.toThrow("no longer pending");
  });

  it("waits on free text and sends the entered value back to the model verbatim", async () => {
    const { model, script } = scriptedModel([tabsList, textQuestion]);
    const { controller } = build({ model });
    await controller.start("Find local paper towel prices after I give you my ZIP code");

    const waiting = controller.snapshot()!;
    expect(waiting.status).toBe("waiting_for_judgment");
    expect(waiting.pendingQuestion).toMatchObject({
      prompt: "What ZIP code should I use?",
      choices: [],
      input: { type: "text", placeholder: "ZIP code" },
    });

    script.push(answer("I found the nearby offers."));
    await controller.answerQuestion(waiting.pendingQuestion!.id, " 10001 ");

    const run = controller.snapshot()!;
    expect(run.status).toBe("completed");
    expect(run.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual([
      "Find local paper towel prices after I give you my ZIP code",
      "10001",
    ]);
    const prompt = model.doGenerateCalls[2]!.prompt;
    expect(userTexts(prompt).at(-1)).toBe("[The person answered your question]\n10001");
    expect(toolCallsIn(prompt)).toEqual(["tabs_list", "ask_user_text"]);
  });

  it.each(["interrupt", "revoke", "new-thread"] as const)(
    "withdraws a pending iMessage question when the local run is %s",
    async (action) => {
      const { model } = scriptedModel([tabsList, question]);
      const connector = iMessageCloud();
      const { controller } = build({ model, cloud: connector.cloud });
      await controller.start("Buy the listing in my colour");
      const questionId = controller.snapshot()!.pendingQuestion!.id;

      if (action === "interrupt") controller.interrupt();
      else if (action === "revoke") await controller.revoke();
      else await controller.newThread();

      expect(connector.events).toContainEqual({ kind: "resolved", questionId });
      expect(controller.snapshot()?.pendingQuestion ?? null).toBeNull();
    },
  );
});

describe("a turn that stops short", () => {
  it("pauses at the budget instead of pretending to finish, and resumes on request", async () => {
    const { model, script } = scriptedModel([], tabsList);
    const { controller, threads } = build({ model, limits: { stepsPerCall: 1, continuations: 0 } });
    await controller.start("Reconcile every invoice in the queue");

    const paused = controller.snapshot()!;
    expect(paused.status).toBe("interrupted");
    expect(paused.control).toBe("human");
    expect(paused.result).toBeNull();
    expect(paused.completedAt).toBeNull();
    expect(lastAssistant(paused)).toContain("1 steps this turn");
    expect(lastAssistant(paused)).toContain("Resume");
    expect(paused.messages.some((message) => message.content.includes("I finished"))).toBe(false);
    expect(paused.activity.at(-1)?.label).toBe("Turn checkpoint reached");
    expect(controller.busy()).toBe(false);
    expect(paused.context.steps).toBe(1);
    expect(threads.get(paused.runId)?.run.status).toBe("interrupted");
    expect(model.doGenerateCalls).toHaveLength(1);

    script.length = 0;
    script.push(answer("Resumed: the queue is reconciled."));
    await controller.releaseControl();

    const run = controller.snapshot()!;
    expect(run.status).toBe("completed");
    expect(run.turns).toBe(2);
    expect(run.result?.summary).toBe("Resumed: the queue is reconciled.");
    expect(model.doGenerateCalls).toHaveLength(2);
    const prompt = model.doGenerateCalls[1]!.prompt;
    expect(userTexts(prompt).at(-1)).toContain("[The person asked you to continue");
    expect(toolCallsIn(prompt)).toEqual(["tabs_list"]);
    expect(toolResultsIn(prompt).map((part) => part.toolName)).toEqual(["tabs_list"]);
  });

  it("pauses a silent turn rather than completing it", async () => {
    const { model } = scriptedModel([silence(), silence(), silence()]);
    const { controller } = build({ model });
    await controller.start("Check the invoice total");

    const run = controller.snapshot()!;
    expect(run.status).toBe("interrupted");
    expect(run.result).toBeNull();
    expect(lastAssistant(run)).toContain("stopped without a final answer");
    expect(run.activity.at(-1)?.label).toBe("Turn ended without an answer");
    expect(run.messages.some((message) => message.content.includes("I finished"))).toBe(false);
    expect(controller.busy()).toBe(false);
  });
});

describe("the thread list", () => {
  it("sets a finished thread aside, starts another, and reopens the first with its history and notes", async () => {
    const { model, script } = scriptedModel([calls({ name: "task_notes", input: { content: "Plan:\n- [x] read the total ($120)" } }), answer("Done: the total is $120.")]);
    const { controller } = build({ model });
    await controller.start("Check the invoice total");
    const first = controller.snapshot()!;
    expect(first.notes).toContain("$120");

    await controller.newThread();
    expect(controller.snapshot()).toBeNull();
    expect(controller.threads().map((item) => [item.runId, item.status])).toEqual([[first.runId, "completed"]]);

    script.push(answer("Done: nothing to reconcile."));
    await controller.start("Reconcile the queue");
    const second = controller.snapshot()!;
    expect(second.runId).not.toBe(first.runId);
    expect(second.status).toBe("completed");
    expect(second.notes).toBe("");
    expect(controller.threads().map((item) => item.runId)).toEqual([second.runId, first.runId]);
    // The new thread's model history starts clean.
    expect(toolCallsIn(model.doGenerateCalls[2]!.prompt)).toEqual([]);
    expect(userTexts(model.doGenerateCalls[2]!.prompt)).toEqual([`Complete this browser task: Reconcile the queue${POINTER}`]);

    controller.openThread(first.runId);
    const reopened = controller.snapshot()!;
    expect(reopened.runId).toBe(first.runId);
    expect(reopened.status).toBe("completed");
    expect(reopened.messages.map((message) => message.content)).toEqual(first.messages.map((message) => message.content));
    expect(reopened.notes).toBe(first.notes);
    expect(reopened.toolCalls.map((tool) => tool.name)).toEqual(["notes.update"]);

    script.push(answer("Still $120."));
    await controller.message("Is it still the same?");
    const continued = controller.snapshot()!;
    expect(continued.runId).toBe(first.runId);
    expect(continued.turns).toBe(2);
    expect(continued.status).toBe("completed");
    const prompt = model.doGenerateCalls[3]!.prompt;
    expect(toolCallsIn(prompt)).toEqual(["task_notes"]);
    expect(userTexts(prompt)).toEqual([`Complete this browser task: Check the invoice total${POINTER}`, `Is it still the same?${POINTER}`]);
    expect(systemText(prompt)).toContain("read the total ($120)");
    expect(controller.threads().map((item) => [item.runId, item.turns])).toEqual([[first.runId, 2], [second.runId, 1]]);
    expect(() => controller.openThread("missing")).toThrow("no longer available");
  });

  it("refuses to switch away from an acting thread, and a new thread stops it", async () => {
    const browser = fakeBrowser();
    const blocked = deferred<Page>();
    browser.inspectPage.mockImplementation(() => blocked.promise);
    const { model } = scriptedModel([inspect], answer("Done."));
    const { controller, threads, statuses } = build({ model, browser });

    const started = controller.start("Read the page");
    await expect.poll(() => controller.snapshot()?.toolCalls.some((tool) => tool.name === "page.inspect" && tool.status === "running")).toBe(true);
    const runId = controller.snapshot()!.runId;
    expect(controller.busy()).toBe(true);
    expect(() => controller.openThread("another")).toThrow("pause or end the current task");
    expect(() => controller.deleteThread(runId)).toThrow("end the task");

    await controller.newThread();
    expect(controller.snapshot()).toBeNull();
    expect(statuses).toContain("revoked");
    expect(threads.get(runId)?.run.status).toBe("revoked");
    // Revoking aborts the tool that was still in flight: it fails at once
    // instead of sitting at `running` until the browser answers.
    expect(threads.get(runId)?.run.toolCalls[0]?.status).toBe("failed");

    blocked.resolve(page());
    await expect(started).resolves.toBeUndefined();
    expect(controller.snapshot()).toBeNull();
    expect(threads.get(runId)?.run.status).toBe("revoked");
  });
});

describe("restore after a restart", () => {
  it("marks a turn that was running as interrupted and repairs its history", async () => {
    const dir = scratch();
    const saved = new ThreadStore(dir);
    saved.saveNow({ version: 1, run: savedRun(), model: savedHistory });

    const { model } = scriptedModel([answer("Back on it: the total is $120.")]);
    const { controller } = build({ model, threads: new ThreadStore(dir) });
    controller.restore();

    const run = controller.snapshot()!;
    expect(run.runId).toBe("run-restore-1");
    expect(run.status).toBe("interrupted");
    expect(run.control).toBe("human");
    expect(run.toolCalls[0]?.status).toBe("paused");
    expect(run.messages.at(-1)?.role).toBe("system");
    expect(run.messages.at(-1)?.content).toContain("restarted");
    expect(run.notes).toContain("read the total");
    expect(controller.busy()).toBe(false);
    expect(controller.threads().map((item) => [item.runId, item.status])).toEqual([["run-restore-1", "interrupted"]]);

    await controller.message("carry on");
    expect(controller.snapshot()?.status).toBe("completed");
    expect(controller.snapshot()?.turns).toBe(2);
    const prompt = model.doGenerateCalls[0]!.prompt;
    const repaired = toolResultsIn(prompt).find((part) => part.toolCallId === "dangling");
    expect(repaired?.output).toEqual({ type: "error-text", value: TURN_CUT_SHORT });
    expect(prompt.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
    expect(userTexts(prompt).at(-1)).toBe("[The person paused you and now says]\ncarry on");
    expect(systemText(prompt)).toContain("read the total");
  });

  it("leaves a finished thread finished", () => {
    const dir = scratch();
    const saved = new ThreadStore(dir);
    const record: ThreadRecord = {
      version: 1,
      run: savedRun({
        status: "completed",
        control: "human",
        completedAt: "2026-08-29T10:05:00.000Z",
        toolCalls: [],
        result: { summary: "Done.", changes: [], capsuleRevoked: false, evidenceEntries: 0, rootHash: "" },
      }),
      model: [savedHistory[0]!, { role: "assistant", content: "Done." }],
    };
    saved.saveNow(record);

    const { model } = scriptedModel([]);
    const { controller, onChange } = build({ model, threads: new ThreadStore(dir) });
    controller.restore();

    const run = controller.snapshot()!;
    expect(run.status).toBe("completed");
    expect(run.messages.some((message) => message.content.includes("restarted"))).toBe(false);
    expect(run.result?.summary).toBe("Done.");
    expect(onChange).toHaveBeenCalled();
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("restores nothing from an empty store", () => {
    const { model } = scriptedModel([]);
    const { controller } = build({ model });
    controller.restore();
    expect(controller.snapshot()).toBeNull();
    expect(controller.threads()).toEqual([]);
  });
});

describe("what the thread keeps", () => {
  it("persists the notes and shows them to the next turn", async () => {
    const { model, script } = scriptedModel([calls({ name: "task_notes", input: { content: "Plan:\n- [ ] step one\n- [ ] step two" } }), answer("Planned.")]);
    const { controller, threads } = build({ model });
    await controller.start("Check the invoice total");
    const runId = controller.snapshot()!.runId;

    expect(controller.snapshot()?.notes).toBe("Plan:\n- [ ] step one\n- [ ] step two");
    expect(threads.get(runId)?.run.notes).toContain("step one");
    expect(systemText(model.doGenerateCalls[0]!.prompt)).toContain("(none yet");
    expect(systemText(model.doGenerateCalls[1]!.prompt)).toContain("step one");

    script.push(answer("Done."));
    await controller.message("go on");
    expect(systemText(model.doGenerateCalls[2]!.prompt)).toContain("step one");
    expect(controller.snapshot()?.notes).toContain("step one");
  });

  it("shows compaction in the thread and counts steps across turns", async () => {
    const browser = fakeBrowser();
    browser.inspectPage.mockImplementation(async () => page("Line item: widget, quantity 3, unit price $12.50, subtotal $37.50. ".repeat(120)));
    const { model, script } = scriptedModel([inspect, inspect, inspect, inspect, inspect, inspect, answer("Done: six readings taken.")]);
    const summarize = vi.fn(async () => "SUMMARY: read the invoice six times.");
    const { controller } = build({ model, browser, summarize, budget: { window: 100_000, compactAt: 400 } });
    await controller.start("Read the invoice carefully");

    const run = controller.snapshot()!;
    expect(run.status).toBe("completed");
    expect(summarize).toHaveBeenCalled();
    const compacted = run.messages.filter((message) => message.role === "system" && message.content.startsWith("Context compacted"));
    expect(compacted.length).toBeGreaterThanOrEqual(1);
    expect(compacted[0]?.content).toMatch(/about \d+k? → \d+k? tokens/);
    expect(run.context.compactions).toBeGreaterThanOrEqual(1);
    expect(run.context.compactions).toBe(compacted.length);
    expect(typeof run.context.tokens).toBe("number");
    expect(run.context.compactAt).toBe(400);
    expect(run.context.window).toBe(100_000);
    expect(run.context.steps).toBe(7);
    expect(run.context.totalSteps).toBe(7);
    expect(run.context.usage.inputTokens).toBeGreaterThan(0);
    expect(run.activity.some((entry) => entry.label === "Context compacted")).toBe(true);

    script.push(tabsList, answer("Done: tabs listed."));
    await controller.message("List the tabs now");
    const next = controller.snapshot()!;
    expect(next.status).toBe("completed");
    expect(next.context.steps).toBe(2);
    expect(next.context.totalSteps).toBe(9);
    expect(next.context.usage.inputTokens).toBeGreaterThan(run.context.usage.inputTokens);
  });

  it("persists the turn in progress after every step", async () => {
    const browser = fakeBrowser();
    const blocked = deferred<Page>();
    browser.inspectPage.mockImplementation(() => blocked.promise);
    const { model } = scriptedModel([tabsList, inspect], answer("Done."));
    const { controller, threads } = build({ model, browser });

    const started = controller.start("Read the page");
    await expect.poll(() => controller.snapshot()?.toolCalls.some((tool) => tool.name === "page.inspect" && tool.status === "running")).toBe(true);
    const runId = controller.snapshot()!.runId;
    await expect.poll(() => historyToolCalls(threads.get(runId)?.model ?? []), { timeout: 2_000 }).toContain("tabs_list");
    const pending = threads.get(runId)!;
    expect(pending.run.status).toBe("running");
    expect(pending.run.toolCalls.map((tool) => [tool.name, tool.status])).toEqual([["tabs.list", "completed"], ["page.inspect", "running"]]);
    expect(pending.model.some((message) => message.role === "tool")).toBe(true);

    blocked.resolve(page());
    await started;
    expect(controller.snapshot()?.status).toBe("completed");
    expect(historyToolCalls(threads.get(runId)?.model ?? [])).toEqual(["tabs_list", "page_inspect"]);
  });
});

describe("scheduled runs", () => {
  const request = (onStarted = vi.fn()) => ({
    reminderId: "reminder-1",
    occurrenceId: "occurrence-1",
    title: "Morning invoice check",
    prompt: "Summarize the invoice page",
    scheduledFor: "2026-08-29T09:00:00.000Z",
    onStarted,
  });

  it("runs a reminder's task as a thread and reports its answer", async () => {
    const { model } = scriptedModel([tabsList, answer("Digest: one invoice, $120, nothing overdue.")]);
    const { controller } = build({ model });
    const onStarted = vi.fn();

    const outcome = await controller.startScheduled(request(onStarted));

    const run = controller.snapshot()!;
    expect(onStarted).toHaveBeenCalledWith(run.runId);
    expect(outcome).toEqual({ status: "completed", output: "Digest: one invoice, $120, nothing overdue.", runId: run.runId });
    expect(run.status).toBe("completed");
    expect(run.origin).toMatchObject({ kind: "reminder", reminderId: "reminder-1", title: "Morning invoice check" });
    expect(run.title).toBe("Morning invoice check");
    expect(run.turns).toBe(1);
    const prompt = model.doGenerateCalls[0]!.prompt;
    expect(userTexts(prompt)[0]).toContain("scheduled reminder");
    expect(userTexts(prompt)[0]).toContain("Summarize the invoice page");
    expect(systemText(prompt)).toContain("Scheduled-run rules");
    expect(controller.threads()[0]?.origin?.kind).toBe("reminder");
  });

  it("is turned away while a thread is running", async () => {
    const browser = fakeBrowser();
    const blocked = deferred<Page>();
    browser.inspectPage.mockImplementation(() => blocked.promise);
    const { model } = scriptedModel([inspect], answer("Done."));
    const { controller } = build({ model, browser });

    const started = controller.start("Read the page");
    await expect.poll(() => controller.snapshot()?.status).toBe("running");
    await expect(controller.startScheduled(request())).resolves.toEqual({ status: "busy" });

    blocked.resolve(page());
    await started;
    expect(controller.snapshot()?.status).toBe("completed");
  });

  it("takes the console from a paused thread, which waits in the list", async () => {
    const { model, script } = scriptedModel([], tabsList);
    const { controller } = build({ model, limits: { stepsPerCall: 1, continuations: 0 } });
    await controller.start("Reconcile every invoice in the queue");
    const paused = controller.snapshot()!;
    expect(paused.status).toBe("interrupted");

    script.push(answer("Digest: nothing overdue."));
    const outcome = await controller.startScheduled(request());
    expect(outcome).toMatchObject({ status: "completed", output: "Digest: nothing overdue." });
    const scheduled = controller.snapshot()!;
    expect(scheduled.runId).not.toBe(paused.runId);
    expect(scheduled.origin?.kind).toBe("reminder");
    expect(controller.threads().map((item) => [item.runId, item.status])).toEqual([
      [scheduled.runId, "completed"],
      [paused.runId, "interrupted"],
    ]);

    controller.openThread(paused.runId);
    expect(controller.snapshot()?.status).toBe("interrupted");
    expect(controller.snapshot()?.toolCalls.map((tool) => tool.name)).toEqual(["tabs.list"]);
  });
  it("reports a budget pause as a failure and keeps the thread open in the list", async () => {
    const { model } = scriptedModel([], tabsList);
    const onRunEnded = vi.fn();
    const { controller, threads } = build({ model, limits: { stepsPerCall: 1, continuations: 0 }, onRunEnded });

    const outcome = await controller.startScheduled(request());

    const run = controller.snapshot()!;
    expect(outcome).toEqual({ status: "failed", error: expect.stringMatching(/after 1 steps/), runId: run.runId });
    expect(run.status).toBe("interrupted");
    expect(run.result).toBeNull();
    expect(onRunEnded).toHaveBeenCalledTimes(1);
    expect(onRunEnded.mock.calls[0]![0]).toMatchObject({ runId: run.runId, status: "interrupted" });
    expect(controller.threads().map((item) => [item.runId, item.status])).toEqual([[run.runId, "interrupted"]]);
    expect(threads.get(run.runId)?.run.status).toBe("interrupted");
    expect(controller.busy()).toBe(false);
  });

  it("reports an interruption as a failure the moment the person interrupts", async () => {
    const browser = fakeBrowser();
    const blocked = deferred<Page>();
    browser.inspectPage.mockImplementation(() => blocked.promise);
    const { model } = scriptedModel([inspect], answer("Digest."));
    const onRunEnded = vi.fn();
    const { controller } = build({ model, browser, onRunEnded });

    const started = controller.startScheduled(request());
    await expect.poll(() => controller.snapshot()?.toolCalls.some((tool) => tool.name === "page.inspect" && tool.status === "running")).toBe(true);
    const runId = controller.snapshot()!.runId;

    controller.interrupt();
    expect(controller.snapshot()?.status).toBe("interrupted");
    expect(onRunEnded).toHaveBeenCalledTimes(1);
    expect(onRunEnded.mock.calls[0]![0]).toMatchObject({ runId, status: "interrupted" });

    blocked.resolve(page());
    await expect(started).resolves.toEqual({ status: "failed", error: expect.stringMatching(/Interrupted/), runId });
    expect(controller.snapshot()?.status).toBe("interrupted");
    expect(onRunEnded).toHaveBeenCalledTimes(1);
  });

  it("releases the scheduler when a thread handed to the person is set aside for a new one", async () => {
    const { model } = scriptedModel([takeover]);
    const onRunEnded = vi.fn();
    const { controller, threads } = build({ model, onRunEnded });

    const started = controller.startScheduled(request());
    await expect.poll(() => controller.snapshot()?.status).toBe("human_control");
    const runId = controller.snapshot()!.runId;
    expect(controller.snapshot()?.pendingTakeover?.reason).toBe("Please sign in.");
    // In the person's hands the run is neither over nor paused by them: the scheduler keeps waiting.
    expect(await settledWithin(started)).toBe(false);
    expect(onRunEnded).not.toHaveBeenCalled();

    await controller.newThread();

    await expect(started).resolves.toEqual({ status: "failed", error: expect.stringMatching(/Set aside/), runId });
    expect(onRunEnded).toHaveBeenCalledTimes(1);
    expect(controller.snapshot()).toBeNull();
    expect(threads.get(runId)?.run.status).toBe("human_control");
  });

  it("releases the scheduler when a thread waiting on a question is deleted", async () => {
    const { model } = scriptedModel([question]);
    const onRunEnded = vi.fn();
    const { controller, threads } = build({ model, onRunEnded });

    const started = controller.startScheduled(request());
    await expect.poll(() => controller.snapshot()?.status).toBe("waiting_for_judgment");
    const runId = controller.snapshot()!.runId;
    expect(await settledWithin(started)).toBe(false);

    // Waiting on the person is not acting: the thread may go.
    expect(() => controller.deleteThread(runId)).not.toThrow();

    await expect(started).resolves.toEqual({ status: "failed", error: expect.stringMatching(/Set aside/), runId });
    expect(onRunEnded).toHaveBeenCalledTimes(1);
    expect(controller.snapshot()).toBeNull();
    expect(threads.get(runId)).toBeNull();
    expect(controller.threads()).toEqual([]);
  });

  it("shutdown pauses the running turn, writes it at once, and releases the scheduler", async () => {
    const browser = fakeBrowser();
    const blocked = deferred<Page>();
    browser.inspectPage.mockImplementation(() => blocked.promise);
    const { model } = scriptedModel([inspect], answer("Digest."));
    const onRunEnded = vi.fn();
    const { controller, dir } = build({ model, browser, onRunEnded });

    const started = controller.startScheduled(request());
    await expect.poll(() => controller.snapshot()?.toolCalls.some((tool) => tool.name === "page.inspect" && tool.status === "running")).toBe(true);
    const runId = controller.snapshot()!.runId;

    controller.shutdown();

    const run = controller.snapshot()!;
    expect(run.status).toBe("interrupted");
    expect(run.control).toBe("human");
    expect(run.toolCalls.map((tool) => tool.status)).toEqual(["paused"]);
    expect(run.messages.at(-1)?.role).toBe("system");
    expect(run.messages.at(-1)?.content).toContain("window");
    expect(run.activity.at(-1)?.label).toBe("Paused with the window");
    // Written synchronously: a store opened right now reads the paused thread.
    const written = new ThreadStore(dir).get(runId);
    expect(written?.run.status).toBe("interrupted");
    expect(written?.run.toolCalls[0]?.status).toBe("paused");
    expect(written?.model.at(-1)).toMatchObject({ role: "user" });
    expect(onRunEnded).toHaveBeenCalledTimes(1);

    // The tool that was in flight finishing later changes nothing.
    blocked.resolve(page());
    await expect(started).resolves.toEqual({ status: "failed", error: expect.stringMatching(/window/), runId });
    expect(controller.snapshot()?.status).toBe("interrupted");
    expect(controller.snapshot()?.result).toBeNull();
    expect(onRunEnded).toHaveBeenCalledTimes(1);
  });

  it("treats a follow-up on the reminder's thread as the person's own turn", async () => {
    const { model, script } = scriptedModel([tabsList, answer("Digest: one invoice, nothing overdue.")]);
    const adapter = recordingAdapter();
    const onRunEnded = vi.fn();
    const { controller } = build({ model, notifications: new NotificationRouter([adapter]), onRunEnded });

    const outcome = await controller.startScheduled(request());
    expect(outcome).toMatchObject({ status: "completed" });
    const runId = controller.snapshot()!.runId;
    expect(systemText(model.doGenerateCalls[0]!.prompt)).toContain("Scheduled-run rules");
    // The reminder announces its own run; the controller stays quiet.
    expect(adapter.messages).toEqual([]);
    expect(onRunEnded).toHaveBeenCalledTimes(1);

    script.push(answer("It is still $120."));
    await controller.message("Is the total still the same?");

    const run = controller.snapshot()!;
    expect(run.runId).toBe(runId);
    expect(run.status).toBe("completed");
    expect(run.turns).toBe(2);
    expect(run.origin?.kind).toBe("reminder");
    expect(run.result?.summary).toBe("It is still $120.");
    expect(model.doGenerateCalls).toHaveLength(3);
    const prompt = model.doGenerateCalls[2]!.prompt;
    expect(systemText(prompt)).not.toContain("Scheduled-run rules");
    expect(userTexts(prompt).at(-1)).toBe(`Is the total still the same?${POINTER}`);
    expect(onRunEnded).toHaveBeenCalledTimes(2);
    // This completion is the person's, so it is announced like any other.
    expect(adapter.messages.map((message) => [message.kind, message.runId, message.body])).toEqual([["completion", runId, "It is still $120."]]);
  });
});

describe("what the record carries", () => {
  it("writes the evidence and the learner's position, and a reopened thread reads the evidence back", async () => {
    const { model } = scriptedModel([tabsList, answer("Done: the total is $120.")]);
    const { controller, threads, dir } = build({ model });
    await controller.start("Check the invoice total");
    const runId = controller.snapshot()!.runId;
    const live = controller.evidence();
    expect(live.length).toBeGreaterThan(1);
    expect(live[0]).toMatchObject({ type: "interaction.started", runId });
    expect(live.map((entry) => entry.type)).toContain("run.completed");

    controller.flush();
    const record = threads.get(runId)!;
    // No memory store here, so the learner has read nothing — but the position is recorded.
    expect(record.learnedThrough).toBe(0);
    expect(record.evidence).toHaveLength(live.length);
    expect(record.evidence?.[0]).toMatchObject({ type: "interaction.started", runId });
    expect(record.evidence?.map((entry) => entry.type)).toEqual(live.map((entry) => entry.type));

    const { model: idle } = scriptedModel([]);
    const { controller: reopened } = build({ model: idle, threads: new ThreadStore(dir) });
    reopened.restore();
    expect(reopened.snapshot()?.runId).toBe(runId);
    // Reopened, the chain continues from the stored entries under the stored
    // key: the old entries verbatim, then a signed mark that it was reopened.
    const resumed = reopened.evidence();
    expect(resumed).toHaveLength(live.length + 1);
    expect(resumed.slice(0, live.length).map((entry) => entry.hash)).toEqual(live.map((entry) => entry.hash));
    expect(resumed.at(-1)).toMatchObject({ type: "thread.reopened", runId, sequence: live.length + 1 });
    expect(verifyEvidenceEntries(resumed, { expectedRunId: runId })).toBe(true);
    expect(idle.doGenerateCalls).toHaveLength(0);
  });

  it("counts each step's usage once when the turn is interrupted mid-step", async () => {
    const browser = fakeBrowser();
    const blocked = deferred<Page>();
    browser.inspectPage.mockImplementation(() => blocked.promise);
    const { model } = scriptedModel([tabsList, inspect], answer("Done."));
    const { controller } = build({ model, browser });
    const reported = (index: number): number => Math.ceil(JSON.stringify(model.doGenerateCalls[index]!.prompt).length / 4) + 4_000;

    const started = controller.start("Read the page");
    await expect.poll(() => controller.snapshot()?.toolCalls.some((tool) => tool.name === "page.inspect" && tool.status === "running")).toBe(true);
    expect(controller.snapshot()?.context.usage.inputTokens).toBe(reported(0));

    controller.interrupt();
    blocked.resolve(page());
    await started;

    const run = controller.snapshot()!;
    expect(run.status).toBe("interrupted");
    // The step in flight may still report after the interruption; either
    // way every counted step adds exactly what the model said it read.
    expect(run.context.steps).toBeGreaterThanOrEqual(1);
    expect(run.context.steps).toBeLessThanOrEqual(model.doGenerateCalls.length);
    const counted = model.doGenerateCalls.slice(0, run.context.steps).reduce((sum, _call, index) => sum + reported(index), 0);
    expect(run.context.usage.inputTokens).toBe(counted);
    const everything = model.doGenerateCalls.reduce((sum, _call, index) => sum + reported(index), 0);
    expect(run.context.usage.inputTokens).toBeLessThanOrEqual(everything);
    expect(run.context.usage.outputTokens).toBe(20 * run.context.steps);
  });
});

describe("review follow-ups", () => {
  it("cancels a pending approval when the thread is set aside, and reopens it paused", () => {
    const dir = scratch();
    const saved = new ThreadStore(dir);
    const approval = {
      id: "approval-1",
      runId: "run-restore-1",
      requestedAt: "2026-08-29T10:00:00.000Z",
      expiresAt: "2026-08-29T10:30:00.000Z",
      evidence: { action: "Submit", resource: "Invoice", summary: "Submit it", before: {}, after: {}, dataLeaving: [], reversible: false },
    };
    saved.saveNow({ version: 1, run: savedRun({ status: "waiting_for_approval", pendingApproval: approval }), model: [] });
    const { controller, threads } = build({ model: scriptedModel([answer("unused")]).model, threads: new ThreadStore(dir) });
    controller.openThread("run-restore-1");
    expect(controller.snapshot()?.pendingApproval).not.toBeNull();
    // Not acting, so it can be set aside — but the approval does not survive it.
    void controller.newThread();
    const record = threads.get("run-restore-1");
    expect(record?.run.status).toBe("interrupted");
    expect(record?.run.pendingApproval).toBeNull();
    expect(record?.run.control).toBe("human");
    expect(record?.run.messages.at(-1)?.content).toContain("approval was cancelled");
    controller.openThread("run-restore-1");
    expect(controller.snapshot()?.status).toBe("interrupted");
    expect(controller.snapshot()?.pendingApproval).toBeNull();
  });

  it("keeps signing evidence after a thread is reopened", async () => {
    const dir = scratch();
    const first = build({ model: scriptedModel([tabsList, answer("Done once.")]).model, dir });
    await first.controller.start("Look at my tabs");
    const before = first.controller.evidence();
    expect(before.length).toBeGreaterThan(0);
    first.controller.flush();
    const stored = new ThreadStore(dir).get(first.controller.snapshot()!.runId);
    expect(stored?.signingKey).toContain("PRIVATE KEY");
    expect(stored?.evidence).toHaveLength(before.length);

    const second = build({ model: scriptedModel([inspect, answer("Done twice.")]).model, threads: new ThreadStore(dir) });
    second.controller.restore();
    expect(second.controller.snapshot()?.runId).toBe(first.controller.snapshot()?.runId);
    await second.controller.message("And the page?");
    const run = second.controller.snapshot()!;
    expect(run.status).toBe("completed");
    const after = second.controller.evidence();
    // The chain continued: the old entries, a reopen mark, and the new turn's entries, all one verified run.
    expect(after.length).toBeGreaterThan(before.length + 1);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.some((entry) => entry.type === "thread.reopened")).toBe(true);
    expect(after.some((entry) => entry.type === "browser.action")).toBe(true);
    expect(verifyEvidenceEntries(after, { expectedRunId: run.runId })).toBe(true);
    expect(run.result?.evidenceEntries).toBe(after.length);
    expect(run.result?.rootHash).toBe(after.at(-1)?.hash);
  });
});

/* --------------------------- artifact addresses --------------------------- */

describe("where an artifact link points", () => {
  const listArtifacts = calls({ name: "artifact_list", input: {} });

  it("links this Mac's own copy while signed out, and the account's web origin once enrolled", async () => {
    const store = new ArtifactStore(scratch());
    const created = store.create(
      { title: "Morning news feed", brief: "What I missed", html: "<!doctype html><html><body>hi</body></html>", builtWith: "m" },
      { kind: "agent", runId: "run-1" },
    );
    let web: string | null = null;

    const { model } = scriptedModel([listArtifacts, answer("Here it is.")]);
    const { controller } = build({ model, artifacts: store, artifactWebUrl: () => web });
    await controller.start("What have I built?");
    const signedOut = toolResultsIn(model.doGenerateCalls[1]!.prompt).find((result) => result.toolName === "artifact_list");
    expect(JSON.stringify(signedOut?.output)).toContain(`pistachio://artifact/${created.id}`);

    // The same Mac, now enrolled on a control that is not production.
    web = "http://localhost:3000";
    const second = scriptedModel([listArtifacts, answer("Still there.")]);
    const { controller: enrolled } = build({ model: second.model, artifacts: store, artifactWebUrl: () => web });
    await enrolled.start("And now?");
    const signedIn = toolResultsIn(second.model.doGenerateCalls[1]!.prompt).find((result) => result.toolName === "artifact_list");
    expect(JSON.stringify(signedIn?.output)).toContain(`http://localhost:3000/app/artifacts/${created.id}`);
    expect(JSON.stringify(signedIn?.output)).not.toContain("pistachio.run");
  });
});


describe("Watchtower agent retrieval", () => {
  it("does not register archive tools for a never-enabled empty archive", async () => {
    const watchtower={agentAvailable:()=>false} as unknown as import("../src/main/watchtower/service").WatchtowerService;
    const {model}=scriptedModel([answer("Ready.")]);
    const {controller}=build({model,watchtower});
    await controller.start("Hello");
    expect(JSON.stringify(model.doGenerateCalls[0]?.tools)).not.toContain("watchtower_");
  });

  it("retrieves only explicit, bounded source evidence and respects revocation during a run", async () => {
    let allowed = true;
    const requests: { spaceId: string; request: unknown }[] = [];
    const watchtower = {
      settings: () => ({ agentAccess: allowed }),
      agentAvailable: () => allowed,
      request: async (spaceId: string, request: { type: string }) => {
        requests.push({ spaceId, request });
        if (request.type === "search") return { results: [{ observationId: "saved-one", url: "https://example.com", visitedAt: 1000 }] };
        return { document: { observationId: "saved-one", url: "https://example.com", visitedAt: 1000, markdown: "x".repeat(30000), blocks: ["must-not-leak"], links: [], backlinks: [], history: [] } };
      },
    } as unknown as import("../src/main/watchtower/service").WatchtowerService;
    const { model } = scriptedModel([
      calls({ name: "watchtower_search", input: { query: "lathe" } }),
      calls({ name: "watchtower_read", input: { observationId: "saved-one", offset: 0, maxChars: 1000 } }),
      (options) => { allowed = false; return calls({ name: "watchtower_search", input: { query: "again" } })(options); },
      answer("Here is the saved source."),
    ]);
    const { controller } = build({ model, watchtower });
    await controller.start("Find that lathe page I saw.");
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.spaceId === "work")).toBe(true);
    const read = JSON.stringify(toolResultsIn(model.doGenerateCalls[2]!.prompt));
    expect(read).toContain('"nextOffset":1000');
    expect(read).not.toContain("must-not-leak");
    expect(read).not.toContain("x".repeat(1001));
    expect(controller.snapshot()?.toolCalls.at(-1)?.status).toBe("failed");
    expect(controller.evidence().some((entry) => entry.type === "watchtower.action")).toBe(true);
  });
});

/* --------------------------- the person's notes --------------------------- */

describe("the person's notes", () => {
  function note(id: string, title: string, markdown: string): Note {
    return {
      id, title, markdown, icon: null, blobIds: [],
      createdAt: "2026-08-01T10:00:00.000Z", updatedAt: "2026-08-20T10:00:00.000Z",
      revision: 1, source: { kind: "user", runId: null },
    };
  }

  const LEASE = note("0f1e2d3c4b5a", "Lease", "Renews in March. Deposit £900.");

  /** `main/note-store.ts` as a Map: the surface the controller uses (docs/notes.md §3). */
  function noteStore(seed: Note[] = []): { store: NoteRecordStore; notes: Map<string, Note> } {
    const notes = new Map(seed.map((entry) => [entry.id, structuredClone(entry)]));
    let minted = 0;
    return {
      notes,
      store: {
        list: () => [...notes.values()].map(summaryOf),
        get: (id) => notes.get(id) ?? null,
        search: (query, limit) => searchNotes([...notes.values()], query, { limit }).map(summaryOf),
        create: (input, source) => {
          minted += 1;
          const created: Note = { ...note(`00000000000${String(minted)}`, input.title ?? "", input.markdown ?? ""), source };
          notes.set(created.id, created);
          return created;
        },
        update: (id, patch, source) => {
          const current = notes.get(id);
          if (current === undefined) throw new Error(`no note ${id}`);
          const next: Note = { ...current, ...patch, revision: current.revision + 1, updatedAt: "2026-08-29T15:00:00.000Z", source };
          notes.set(id, next);
          return next;
        },
        remove: (id) => {
          notes.delete(id);
        },
      },
    };
  }

  /** A router that says what it is told and records what it was asked. */
  function routing(answer: number, page = 0) {
    const asked: TurnRouteRequest[] = [];
    const router: TurnRouter = async (request) => {
      asked.push(request);
      return { routes: { answer, page, browse: 1 - answer - page }, confidence: 0.9, latencyMs: 12 };
    };
    return { router, asked };
  }

  it("gives the agent note tools whose every write is sourced to the run", async () => {
    const { model } = scriptedModel([
      calls({ name: "note_update", input: { id: LEASE.id, title: null, mode: "append", markdown: "Landlord: Bramley & Co.", section: null } }),
      answer("Added it to your Lease note."),
    ]);
    const { store, notes } = noteStore([LEASE]);
    const { controller } = build({ model });
    controller.setNoteStore(store);

    await controller.start("add the landlord to my lease note");

    const run = controller.snapshot()!;
    expect(run.status).toBe("completed");
    expect(run.toolCalls.map((tool) => ({ name: tool.name, label: tool.label, status: tool.status }))).toEqual([
      { name: "note.update", label: "Edit note", status: "completed" },
    ]);
    expect(notes.get(LEASE.id)?.markdown).toBe("Renews in March. Deposit £900.\n\nLandlord: Bramley & Co.");
    expect(notes.get(LEASE.id)?.source).toEqual({ kind: "agent", runId: run.runId });
    // The note surface has its own family in the trace, apart from the run's scratchpad.
    expect(controller.evidence().some((entry) => entry.type === "note.action")).toBe(true);
    expect(controller.evidence().some((entry) => entry.type === "notes.action")).toBe(false);
  });

  it("offers no note tools at all until a store is set", async () => {
    const { model } = scriptedModel([answer("Done.")]);
    const { controller } = build({ model });
    await controller.start("Hello");
    expect(JSON.stringify(model.doGenerateCalls[0]?.tools)).not.toContain("note_list");
    expect(systemText(model.doGenerateCalls[0]!.prompt)).not.toContain("Note rules:");
  });

  it("tells the router the quick path can write notes", async () => {
    const { model } = scriptedModel([answer("You wrote that it renews in March.")]);
    const { router, asked } = routing(0.9);
    const { controller } = build({ model, router });
    controller.setNoteStore(noteStore([LEASE]).store);

    await controller.start("what did I write about the lease?");

    expect(controller.snapshot()?.status).toBe("completed");
    expect(asked[0]?.tools).toContain("search, read and write the person's notes");
  });

  it("is the page in view when one is open, read from the store with no inspection", async () => {
    const { model } = scriptedModel([answer("It renews in March.")]);
    const { router, asked } = routing(0.15, 0.75);
    const { controller, browser } = build({ model, router });
    browser.activeTab.mockImplementation(() => tab("tab-9", "Notes", noteUrl(LEASE.id)));
    controller.setNoteStore(noteStore([LEASE]).store);

    await controller.start("when does it renew?");

    const run = controller.snapshot()!;
    expect(run.status).toBe("completed");
    expect(browser.inspectPage).not.toHaveBeenCalled();
    expect(run.toolCalls).toEqual([]);
    const [text] = userTexts(model.doGenerateCalls[0]!.prompt);
    expect(text).toContain(PAGE_IN_VIEW_HEADER);
    expect(text).toContain("Renews in March. Deposit £900.");
    expect(text).toContain(noteUrl(LEASE.id));
    // The router sees the note by its title, and is told what kind of page it is.
    expect(asked[0]?.currentPage).toEqual({ title: "Lease", host: "notes" });
  });

  it("names an open note to the browser path as a note, not a page to read", async () => {
    const { model } = scriptedModel([tabsList, answer("Done.")]);
    const { router } = routing(0.1);
    const { controller, browser } = build({ model, router });
    browser.activeTab.mockImplementation(() => tab("tab-9", "Notes", noteUrl(LEASE.id)));
    controller.setNoteStore(noteStore([LEASE]).store);

    await controller.start("look up the going rate for a flat like this");

    const [text] = userTexts(model.doGenerateCalls[0]!.prompt);
    expect(text).toContain("the person's own note “Lease”");
    expect(text).toContain("read and change it with the note tools");
    expect(text).toContain(noteUrl(LEASE.id));
  });

  it("leaves a note tab alone when the store has no such note", async () => {
    const { model } = scriptedModel([answer("Hello!")]);
    const { router, asked } = routing(0.9);
    const { controller, browser } = build({ model, router });
    browser.activeTab.mockImplementation(() => tab("tab-9", "Notes", noteUrl("aaaaaaaaaaaa")));
    controller.setNoteStore(noteStore([LEASE]).store);

    await controller.start("hi there");

    expect(asked[0]?.currentPage).toBeNull();
    expect(userTexts(model.doGenerateCalls[0]!.prompt)).toEqual(["hi there"]);
  });
});

/* ------------------------------ the router ------------------------------- */

describe("routing a request", () => {
  /** A router that says what it is told and records what it was asked. */
  function routing(answer: number | null, page = 0) {
    const asked: TurnRouteRequest[] = [];
    const router: TurnRouter = async (request) => {
      asked.push(request);
      return answer === null ? null : { routes: { answer, page, browse: 1 - answer - page }, confidence: 0.9, latencyMs: 12 };
    };
    return { router, asked };
  }

  it("answers a reply-shaped request without the browser, from the words as written", async () => {
    const { model } = scriptedModel([answer("Sure — a hash map keys values by hashing them.")]);
    const { router, asked } = routing(0.92);
    const { controller } = build({ model, router });

    await controller.start("what is a hash map?");

    const run = controller.snapshot()!;
    expect(run.status).toBe("completed");
    expect(lastAssistant(run)).toBe("Sure — a hash map keys values by hashing them.");
    // No "I'm on it" — the reply is the first thing the person reads.
    expect(run.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(run.activity.map((entry) => entry.label)).toContain("Answering directly");
    expect(run.activity.map((entry) => entry.label)).not.toContain("Agent started");
    expect(run.toolCalls).toEqual([]);
    // The model gets the person's words, not a task, and no browser tools
    // — with the page in view attached, read by the host (§5.1).
    const [text] = userTexts(model.doGenerateCalls[0]!.prompt);
    expect(text?.startsWith(`what is a hash map?\n\n[${PAGE_IN_VIEW_HEADER}`)).toBe(true);
    expect(run.activity.find((entry) => entry.label === "Answering directly")?.detail).toBe("Replying with “Invoice” in context; the browser is not needed for this");
    const offered = (model.doGenerateCalls[0]!.tools ?? []).map((item) => item.name);
    expect(offered).not.toContain("tabs_list");
    expect(offered).toContain(USE_BROWSER_TOOL);
    expect(systemText(model.doGenerateCalls[0]!.prompt)).toContain("This turn is a reply, not a browser task.");
    // What the router was asked: the words, the tab as title and host, no history yet.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ message: "what is a hash map?", conversation: [], browserUsed: false, attachments: [] });
    expect(asked[0]?.currentPage).toEqual({ title: "Invoice", host: "finance.example" });
    expect(JSON.stringify(asked[0])).not.toContain("https://");
  });

  it("treats a request whose page was dismissed in the composer as one sent from the home page", async () => {
    const { model } = scriptedModel([answer("Sure — a hash map keys values by hashing them.")]);
    const { router, asked } = routing(0.92);
    const { controller, browser } = build({ model, router });

    await controller.start("what is a hash map?", [], { page: false });

    expect(controller.snapshot()?.status).toBe("completed");
    expect(asked[0]?.currentPage).toBeNull();
    expect(browser.inspectPage).not.toHaveBeenCalled();
    expect(userTexts(model.doGenerateCalls[0]!.prompt)).toEqual(["what is a hash map?"]);
  });

  it("tells the browser path the page was dismissed, and attaches it again on the next request", async () => {
    const { model } = scriptedModel([tabsList, answer("Done."), tabsList, answer("Done again.")]);
    const { router } = routing(0.1);
    const { controller } = build({ model, router });

    await controller.start("Check the invoice total", [], { page: false });
    await controller.message("Now check the shipping line");

    const second = model.doGenerateCalls[2]!.prompt;
    expect(userTexts(second)).toEqual([
      "Complete this browser task: Check the invoice total\n\n[The person removed the page in view from this message: do not assume the request is about any open tab.]",
      `Now check the shipping line${POINTER}`,
    ]);
  });

  it("hands a misrouted request to the browser path and finishes there", async () => {
    const { model } = scriptedModel([
      calls({ name: USE_BROWSER_TOOL, input: { reason: "the total is on the page" } }),
      tabsList,
      answer("Done: the total is $120."),
    ]);
    const { router } = routing(0.8);
    const { controller } = build({ model, router });

    await controller.start("Check the invoice total");

    const run = controller.snapshot()!;
    expect(run.status).toBe("completed");
    expect(lastAssistant(run)).toBe("Done: the total is $120.");
    expect(run.activity.map((entry) => entry.label)).toEqual(expect.arrayContaining(["Answering directly", "Switching to the browser"]));
    expect(run.activity.find((entry) => entry.label === "Switching to the browser")?.detail).toBe("the total is on the page");
    expect(run.messages.map((message) => message.role)).toEqual(["user", "assistant", "assistant"]);
    expect(run.toolCalls.map((tool) => tool.name)).toEqual(["tabs.list"]);
    expect(run.context.steps).toBe(3);
    // The browse path starts over from the request as a task, with no trace of the attempt.
    expect(model.doGenerateCalls).toHaveLength(3);
    const browsePrompt = model.doGenerateCalls[1]!.prompt;
    expect(userTexts(browsePrompt)).toEqual([`Complete this browser task: Check the invoice total${POINTER}`]);
    expect(toolCallsIn(browsePrompt)).toEqual([]);
    expect(systemText(browsePrompt)).toContain("begin by listing the tabs");
    controller.flush();
    const record = controller.threads()[0]!;
    expect(record.status).toBe("completed");
  });

  it("reads the page in view itself for a question about it, with no tool step", async () => {
    const { model } = scriptedModel([answer("The invoice total is $120.")]);
    const { router, asked } = routing(0.15, 0.75);
    const { controller, browser } = build({ model, router });
    browser.inspectPage.mockImplementation(async () => page("Invoice NS-2048. Items: widget ×3. Total $120. Due Oct 1."));

    await controller.start("what's the total on this page?");

    const run = controller.snapshot()!;
    expect(run.status).toBe("completed");
    expect(lastAssistant(run)).toBe("The invoice total is $120.");
    // Read once, here — not as a browser action the trace would show.
    expect(browser.inspectPage).toHaveBeenCalledWith("tab-1");
    expect(run.toolCalls).toEqual([]);
    expect(run.activity.find((entry) => entry.label === "Answering from the page")?.detail).toBe("Read “Invoice” without taking any browser action");
    expect(run.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    // The model gets the words and the page, marked as what it is; no browser tools.
    const [text] = userTexts(model.doGenerateCalls[0]!.prompt);
    expect(text).toContain("what's the total on this page?");
    expect(text).toContain(PAGE_IN_VIEW_HEADER);
    expect(text).toContain("Total $120. Due Oct 1.");
    expect(text).toContain("https://finance.example/invoices/1");
    const offered = (model.doGenerateCalls[0]!.tools ?? []).map((item) => item.name);
    expect(offered).not.toContain("page_inspect");
    expect(offered).toContain(USE_BROWSER_TOOL);
    // The router was told a web page is in view.
    expect(asked[0]?.currentPage).toEqual({ title: "Invoice", host: "finance.example" });
  });

  it("goes to the browser path when the page in view cannot be read, and carries no page across a hand-off", async () => {
    const { model } = scriptedModel([tabsList, answer("Done: the total is $120.")]);
    const { router } = routing(0.15, 0.75);
    const { controller, browser } = build({ model, router });
    browser.inspectPage.mockImplementation(async () => { throw new Error("tab went away"); });

    await controller.start("what's the total on this page?");

    const run = controller.snapshot()!;
    expect(run.status).toBe("completed");
    expect(run.activity.map((entry) => entry.label)).toContain("Agent started");
    expect(run.toolCalls.map((tool) => tool.name)).toEqual(["tabs.list"]);
    expect(userTexts(model.doGenerateCalls[0]!.prompt)).toEqual([`Complete this browser task: what's the total on this page?${POINTER}`]);
  });

  it("offers the router no page when the tab in view is not a web page", async () => {
    const { model } = scriptedModel([answer("Hello!")]);
    const { router, asked } = routing(0.9);
    const { controller, browser } = build({ model, router });
    browser.activeTab.mockImplementation(() => tab("tab-1", "Home", "pistachio://home"));

    await controller.start("hi there");
    expect(asked[0]?.currentPage).toBeNull();
    expect(controller.snapshot()?.status).toBe("completed");
  });

  it("takes the browser path below the floor, and when the router has no opinion", async () => {
    for (const opinion of [0.4, null]) {
      const { model } = scriptedModel([tabsList, answer("Done: the total is $120.")]);
      const { router } = routing(opinion);
      const { controller } = build({ model, router });
      await controller.start("Check the invoice total");
      const run = controller.snapshot()!;
      expect(run.status).toBe("completed");
      expect(run.messages[1]?.content).toContain("I’m on it");
      expect(run.activity.map((entry) => entry.label)).toContain("Agent started");
      expect(userTexts(model.doGenerateCalls[0]!.prompt)).toEqual([`Complete this browser task: Check the invoice total${POINTER}`]);
    }
  });

  it("asks for a follow-up on a finished thread, with the exchange so far, but not for an answer to a question", async () => {
    const { model, script } = scriptedModel([tabsList, answer("Done: the total is $120.")]);
    const { router, asked } = routing(0.4);
    const { controller } = build({ model, router });
    await controller.start("Check the invoice total");
    expect(asked).toHaveLength(1);

    script.push(answer("$120, as I said."));
    asked.length = 0;
    await controller.message("what was it again?");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      message: "what was it again?",
      browserUsed: true,
      conversation: [
        { who: "person", said: "Check the invoice total" },
        { who: "assistant", said: "Done: the total is $120." },
      ],
    });

    // A question mid-task, and its answer, never route: the task is under way.
    script.push(calls({ name: "ask_user", input: { prompt: "Which one?", description: "Two invoices", choices: [{ value: "a", label: "A", description: "first" }, { value: "b", label: "B", description: "second" }] } }));
    asked.length = 0;
    await controller.message("check the other invoice too");
    expect(asked).toHaveLength(1);
    expect(controller.snapshot()?.pendingQuestion).not.toBeNull();
    script.push(answer("The other one is $80."));
    await controller.answerQuestion(controller.snapshot()!.pendingQuestion!.id, "b");
    expect(asked).toHaveLength(1);
    expect(controller.snapshot()?.status).toBe("completed");
  });
});

describe("retrying a turn", () => {
  it("runs the last turn again from where it began and replaces its reply", async () => {
    const { model, script } = scriptedModel([tabsList, answer("Done: the total is $120.")]);
    const { controller } = build({ model });
    await controller.start("Check the invoice total");
    const before = controller.snapshot()!;
    expect(before.status).toBe("completed");

    script.push(inspect, answer("Done: on a second look the total is $125."));
    await controller.retry();

    const run = controller.snapshot()!;
    expect(run.runId).toBe(before.runId);
    expect(run.turns).toBe(1);
    expect(run.status).toBe("completed");
    expect(lastAssistant(run)).toBe("Done: on a second look the total is $125.");
    expect(run.messages.filter((message) => message.role === "assistant").map((message) => message.content)).not.toContain("Done: the total is $120.");
    expect(run.messages.filter((message) => message.role === "user")).toHaveLength(1);
    // The first attempt's tool call is gone from the trace; the retry's is there.
    expect(run.toolCalls.map((tool) => tool.name)).toEqual(["page.inspect"]);
    expect(run.activity.map((entry) => entry.label)).toContain("Retrying");
    // The model saw the thread as it was before the first attempt.
    const retryPrompt = model.doGenerateCalls[2]!.prompt;
    expect(userTexts(retryPrompt)).toEqual([`Complete this browser task: Check the invoice total${POINTER}`]);
    expect(toolCallsIn(retryPrompt)).toEqual([]);
    expect(JSON.stringify(retryPrompt)).not.toContain("$120");
  });

  it("retries only the latest turn of a longer thread, and nothing while the agent acts", async () => {
    const { model, script } = scriptedModel([tabsList, answer("Done: the total is $120.")]);
    const { controller } = build({ model });
    await controller.start("Check the invoice total");
    script.push(answer("Shipping is $8."));
    await controller.message("Now the shipping line");
    script.push(answer("Shipping is $8.50, sorry."));
    await controller.retry();

    const run = controller.snapshot()!;
    expect(run.turns).toBe(2);
    expect(run.messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "Check the invoice total"],
      ["assistant", "I’m on it. I’ll show each step here and pause if I need you to step in."],
      ["assistant", "Done: the total is $120."],
      ["user", "Now the shipping line"],
      ["assistant", "Shipping is $8.50, sorry."],
    ]);
    expect(run.toolCalls.map((tool) => [tool.name, tool.turn])).toEqual([["tabs.list", 1]]);

    // Mid-turn there is nothing settled to retry.
    const blocked = deferred<Page>();
    const { model: slow } = scriptedModel([inspect, answer("never")]);
    const second = build({ model: slow });
    second.browser.inspectPage.mockImplementation(() => blocked.promise);
    const started = second.controller.start("Read the page");
    await expect.poll(() => second.browser.inspectPage.mock.calls.length).toBe(1);
    await second.controller.retry();
    expect(second.controller.snapshot()?.status).toBe("running");
    expect(slow.doGenerateCalls).toHaveLength(1);
    second.controller.interrupt();
    blocked.resolve(page());
    await started;
  });
});
