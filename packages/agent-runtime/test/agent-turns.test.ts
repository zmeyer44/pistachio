/**
 * The long-running agent turn, end to end through the real runner with a
 * scripted model: history that carries across turns, notes in the prompt,
 * checkpoints and budgets, silence, compaction, aborts, and repair of
 * dangling tool calls. The browser is a fake; the model is a queue of
 * scripted replies that also records every prompt it was sent.
 */

import { describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import {
  closeDanglingToolCalls,
  estimateTokens,
  isElided,
  KEEP_FULL_TOOL_RESULTS,
  runAiBrowserAgent,
  SUMMARY_HEADER,
  TURN_CUT_SHORT,
  userMessage,
  USE_BROWSER_TOOL,
  type AgentRunPolicy,
  type AgentTabInfo,
  type AgentTurnMode,
  type AiAgentRunCallbacks,
  type BrowserBackend,
  type CredentialCaptureToolHost,
  type MemoryToolHost,
  type NotesToolHost,
  type NoteToolHost,
} from "../src/index.js";
import { searchNotes, summaryOf, type Note } from "../src/views/notes.js";

/* ------------------------------ the model -------------------------------- */

type CallOptions = Parameters<MockLanguageModelV4["doGenerate"]>[0];
type Prompt = CallOptions["prompt"];
type GenerateResult = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;
type Step = (options: CallOptions) => GenerateResult | Promise<GenerateResult>;

let nextCallId = 0;

/** What a real provider would report: the prompt it read, plus the tool definitions. */
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

/** A step the provider cut off at its output limit: the calls are in the content, but the step did not end on them. */
function cutShort(text: string, ...requests: Array<{ name: string; input: Record<string, unknown> }>): Step {
  return ({ prompt }) => ({
    content: [
      ...(text === "" ? [] : [{ type: "text" as const, text }]),
      ...requests.map((request) => ({
        type: "tool-call" as const,
        toolCallId: `call-${String(++nextCallId)}`,
        toolName: request.name,
        input: JSON.stringify(request.input),
      })),
    ],
    finishReason: { unified: "length", raw: "max_tokens" },
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

/** A model that answers from a queue, then from `fallback`, then fails loudly. */
function scriptedModel(steps: Step[], fallback?: Step): MockLanguageModelV4 {
  const queue = [...steps];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      const step = queue.shift() ?? fallback;
      if (step === undefined) throw new Error(`model script exhausted after ${String(model.doGenerateCalls.length)} calls`);
      return step(options);
    },
  });
  return model;
}

const tabsList = calls({ name: "tabs_list", input: {} });
const inspect = calls({ name: "page_inspect", input: { tabId: "tab-1" } });
const navigate = calls({ name: "page_navigate", input: { tabId: "tab-1", url: "https://example.test/next" } });
const screenshot = calls({ name: "page_screenshot", input: { tabId: "tab-1" } });
const openTab = calls({ name: "tab_open", input: { url: "https://example.test/hang" } });

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

function toolCallsIn(prompt: Prompt): Array<{ toolName: string; toolCallId: string }> {
  const found: Array<{ toolName: string; toolCallId: string }> = [];
  for (const message of prompt) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) if (part.type === "tool-call") found.push({ toolName: part.toolName, toolCallId: part.toolCallId });
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

/* ------------------------------ the history ------------------------------ */

function historyToolCalls(messages: ModelMessage[]): Array<{ toolName: string; toolCallId: string }> {
  const found: Array<{ toolName: string; toolCallId: string }> = [];
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const part of message.content) if (part.type === "tool-call") found.push({ toolName: part.toolName, toolCallId: part.toolCallId });
  }
  return found;
}

function historyToolResults(messages: ModelMessage[]): Array<{ toolName: string; output: { type: string; value?: unknown } }> {
  const found: Array<{ toolName: string; output: { type: string; value?: unknown } }> = [];
  for (const message of messages) {
    if (message.role !== "tool") continue;
    for (const part of message.content) if (part.type === "tool-result") found.push({ toolName: part.toolName, output: part.output });
  }
  return found;
}

function historyUserTexts(messages: ModelMessage[]): string[] {
  const texts: string[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    if (typeof message.content === "string") texts.push(message.content);
    else for (const part of message.content) if (part.type === "text") texts.push(part.text);
  }
  return texts;
}

/* ------------------------------ the browser ------------------------------ */

function tab(id: string, title: string, url: string): AgentTabInfo {
  return {
    id,
    spaceId: "work",
    title,
    url,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    kind: "human",
  };
}

/** A `BrowserBackend` of spies: one tab, a page whose text the test chooses, a canned screenshot. */
function fakeBrowser(options: { pageText?: string; screenshot?: string } = {}) {
  const tabs = [tab("tab-1", "Invoice", "https://finance.example/invoices/1")];
  const fake = {
    kind: "desktop" as const,
    listTabs: vi.fn(() => tabs),
    openTab: vi.fn(async () => "tab-2"),
    focusTab: vi.fn(async () => undefined),
    navigate: vi.fn(async () => undefined),
    back: vi.fn(async () => undefined),
    forward: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    inspect: vi.fn(async () => ({ title: "Invoice", url: "https://finance.example/invoices/1", text: options.pageText ?? "Invoice NS-2048 total $120", controls: [] })),
    click: vi.fn(async () => undefined),
    type: vi.fn(async (_tabId: string, _target: string, value: string) => value),
    press: vi.fn(async () => undefined),
    scroll: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => options.screenshot ?? "data:image/png;base64,AAAA"),
  } satisfies BrowserBackend;
  return { fake, browser: fake as BrowserBackend };
}

/* ------------------------------ the harness ------------------------------ */

function recorder() {
  let nextToolId = 0;
  const callbacks = {
    toolStarted: vi.fn((): string => `tool-${String(++nextToolId)}`),
    toolCompleted: vi.fn(),
    toolFailed: vi.fn(),
    questionAsked: vi.fn(),
    takeoverRequested: vi.fn(),
    historyChanged: vi.fn(),
    stepFinished: vi.fn(),
    compacted: vi.fn(),
    changed: vi.fn(),
  } satisfies AiAgentRunCallbacks;
  return callbacks;
}

function notesHost(initial = ""): NotesToolHost & { content: string; write: ReturnType<typeof vi.fn> } {
  const host = {
    content: initial,
    read: () => host.content,
    write: vi.fn((content: string) => {
      host.content = content;
      return content;
    }),
  };
  return host;
}

/* --------------------------- the person's notes --------------------------- */

const NOW = "2026-08-29T15:00:00.000Z";

function note(id: string, title: string, markdown: string, updatedAt = "2026-08-20T10:00:00.000Z"): Note {
  return {
    id,
    title,
    markdown,
    icon: null,
    blobIds: [],
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt,
    revision: 1,
    source: { kind: "user", runId: null },
  };
}

/** The note store as a Map: the tools' host, and the notes to assert on. */
function userNotesHost(seed: Note[] = []): { host: NoteToolHost; notes: Map<string, Note> } {
  const notes = new Map(seed.map((entry) => [entry.id, entry]));
  let minted = 0;
  const host: NoteToolHost = {
    list: () => [...notes.values()].map(summaryOf),
    search: (query, limit) => searchNotes([...notes.values()], query, { limit }).map(summaryOf),
    get: (id) => notes.get(id) ?? null,
    create: (input) => {
      minted += 1;
      const created = note(`00000000000${String(minted)}`, input.title ?? "", input.markdown ?? "", NOW);
      notes.set(created.id, created);
      return created;
    },
    update: (id, patch) => {
      const current = notes.get(id);
      if (current === undefined) throw new Error(`no note ${id}`);
      const next: Note = { ...current, ...patch, revision: current.revision + 1, updatedAt: NOW, source: { kind: "agent", runId: "run-1" } };
      notes.set(id, next);
      return next;
    },
    remove: (id) => {
      const current = notes.get(id);
      if (current === undefined) throw new Error(`no note ${id}`);
      notes.delete(id);
      return current;
    },
  };
  return { host, notes };
}

const TASK = userMessage("Complete this browser task: check the invoice total");

async function turn(options: {
  model: MockLanguageModelV4;
  messages?: ModelMessage[];
  browser?: BrowserBackend;
  policy?: AgentRunPolicy;
  callbacks?: ReturnType<typeof recorder>;
  notes?: NotesToolHost;
  limits?: { stepsPerCall?: number; continuations?: number };
  budget?: { window: number; compactAt: number };
  summarize?: (prompt: string) => Promise<string>;
  abort?: AbortController;
  credentials?: { host: CredentialCaptureToolHost };
  purchaseApproval?: boolean;
  toolTimeoutMs?: number;
  mode?: AgentTurnMode;
  memory?: { prompt: string; host: MemoryToolHost };
  userNotes?: { host: NoteToolHost };
}) {
  const callbacks = options.callbacks ?? recorder();
  const summarize = options.summarize ?? vi.fn(async () => "SUMMARY: nothing much yet");
  const result = await runAiBrowserAgent({
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.memory === undefined ? {} : { memory: options.memory }),
    ...(options.userNotes === undefined ? {} : { userNotes: options.userNotes }),
    messages: options.messages ?? [TASK],
    browser: options.browser ?? fakeBrowser().browser,
    callbacks,
    abortSignal: (options.abort ?? new AbortController()).signal,
    notes: options.notes ?? notesHost(),
    model: options.model,
    modelName: "scripted-model",
    summarize,
    budget: options.budget ?? { window: 200_000, compactAt: 100_000 },
    limits: options.limits ?? { stepsPerCall: 40, continuations: 5 },
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
    ...(options.purchaseApproval === undefined ? {} : { purchaseApproval: options.purchaseApproval }),
    ...(options.toolTimeoutMs === undefined ? {} : { toolTimeoutMs: options.toolTimeoutMs }),
    now: () => new Date("2026-08-29T15:00:00Z"),
  });
  return { result, callbacks };
}

/* -------------------------------- tests ---------------------------------- */

describe("tool deadlines", () => {
  it("fails a browser call that never settles and lets the turn go on", async () => {
    const { fake, browser } = fakeBrowser();
    // Chromium gone under the CDP socket: `newPage` never resolves.
    fake.openTab.mockImplementation(() => new Promise<string>(() => undefined));
    const callbacks = recorder();
    const model = scriptedModel([openTab, answer("The tab could not be opened; I stopped here.")]);
    const { result } = await turn({ model, browser, callbacks, toolTimeoutMs: 40 });
    expect(result.outcome).toBe("final");
    expect(callbacks.toolFailed).toHaveBeenCalledTimes(1);
    expect(callbacks.toolFailed).toHaveBeenCalledWith(
      "tool-1",
      expect.objectContaining({ message: expect.stringContaining("did not finish within") }),
    );
    // The model saw the failure as the tool's result rather than waiting for ever.
    const second = model.doGenerateCalls[1]!.prompt;
    expect(JSON.stringify(second)).toContain("did not finish within");
  });
});

describe("tool history carries across turns", () => {
  it("keeps tool calls, results, and the person's answer as real messages", async () => {
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
    const first = scriptedModel([tabsList, inspect, question]);
    const { result, callbacks } = await turn({ model: first });

    expect(result.outcome).toBe("paused");
    expect(result.steps).toBe(3);
    expect(callbacks.questionAsked).toHaveBeenCalledTimes(1);
    expect(historyToolCalls(result.messages).map((call) => call.toolName)).toEqual(["tabs_list", "page_inspect", "ask_user"]);
    const results = historyToolResults(result.messages);
    expect(results.map((part) => part.toolName)).toEqual(["tabs_list", "page_inspect", "ask_user"]);
    expect(results[0]?.output).toMatchObject({ type: "json", value: { ok: true, summary: "1 tabs available" } });
    expect(results[1]?.output).toMatchObject({ type: "json", value: { ok: true, data: { title: "Invoice" } } });
    expect(results[2]?.output).toMatchObject({ type: "json", value: { paused: true } });

    const second = scriptedModel([answer("Done: the blue one is $120.")]);
    const { result: continued } = await turn({
      model: second,
      messages: [...result.messages, userMessage("[The person answered your question]\nBlue")],
    });
    expect(continued.outcome).toBe("final");
    expect(continued.text).toBe("Done: the blue one is $120.");

    const prompt = second.doGenerateCalls[0]!.prompt;
    expect(toolCallsIn(prompt).map((call) => call.toolName)).toEqual(["tabs_list", "page_inspect", "ask_user"]);
    expect(toolResultsIn(prompt).map((part) => part.toolName)).toEqual(["tabs_list", "page_inspect", "ask_user"]);
    // Every result answers the call it was made for.
    const ids = toolCallsIn(prompt).map((call) => call.toolCallId);
    expect(toolResultsIn(prompt).map((part) => part.toolCallId)).toEqual(ids);
    expect(userTexts(prompt)).toEqual([TASK.content, "[The person answered your question]\nBlue"]);
    // Nothing was flattened into a transcript string.
    expect(userTexts(prompt).some((text) => text.includes("Conversation so far"))).toBe(false);
    expect(continued.messages).toHaveLength(result.messages.length + 2);
  });

  it("pauses on a dedicated free-text question when the answer must be entered verbatim", async () => {
    const model = scriptedModel([
      calls({
        name: "ask_user_text",
        input: {
          prompt: "What ZIP code should I use?",
          description: "The store needs a destination before showing local prices.",
          placeholder: "ZIP code",
        },
      }),
    ]);
    const { result, callbacks } = await turn({ model });

    expect(result.outcome).toBe("paused");
    expect(callbacks.questionAsked).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "What ZIP code should I use?",
      choices: [],
      input: { type: "text", placeholder: "ZIP code" },
    }));
    expect(historyToolCalls(result.messages).map((call) => call.toolName)).toEqual(["ask_user_text"]);
    expect(historyToolResults(result.messages)[0]?.output).toMatchObject({
      type: "json",
      value: { paused: true, reason: "Waiting for the user's text answer" },
    });
    expect(systemText(model.doGenerateCalls[0]!.prompt)).toContain("Never use multiple choice merely to ask whether they will supply text later");
  });

  it("allows explicitly requested checkout only where the host gates the irreversible step", async () => {
    const model = scriptedModel([answer("Ready to continue checkout.")]);
    await turn({
      model,
      purchaseApproval: true,
      credentials: {
        host: { create: vi.fn(async () => { throw new Error("not called"); }) },
      },
    });
    const system = systemText(model.doGenerateCalls[0]!.prompt);

    expect(system).toContain("follow the person's explicit request through the cart, checkout, and placing the order");
    expect(system).toContain("Do not request takeover merely because a step involves login, MFA, or a consent you can give with a page control");
    expect(system).not.toContain("never begin checkout, place an order, or submit a payment yourself");
    const takeover = (model.doGenerateCalls[0]!.tools ?? []).find((item) => item.name === "request_takeover");
    expect(JSON.stringify(takeover)).toContain("person-bound action the available tools technically cannot perform");
    expect(JSON.stringify(takeover)).toContain("use request_credentials for sensitive editable fields");
    expect(JSON.stringify(takeover)).not.toContain("final, irreversible step of a purchase");
    const credentials = (model.doGenerateCalls[0]!.tools ?? []).find((item) => item.name === "request_credentials");
    expect(JSON.stringify(credentials)).toContain("payment details");
    expect(JSON.stringify(credentials)).toContain("cc-number");
  });

  it("stops short of checkout, and hands the last step over, when no host gate approves it", async () => {
    const model = scriptedModel([answer("The cart is ready for you.")]);
    await turn({
      model,
      credentials: {
        host: { create: vi.fn(async () => { throw new Error("not called"); }) },
      },
    });
    const system = systemText(model.doGenerateCalls[0]!.prompt);

    expect(system).toContain("never begin checkout, place an order, or submit a payment yourself");
    expect(system).toContain("hand them the final step with request_takeover");
    expect(system).not.toContain("follow the person's explicit request through the cart, checkout, and placing the order");
    expect(system).toContain("or when a rule above leaves the last step to them");
    const takeover = (model.doGenerateCalls[0]!.tools ?? []).find((item) => item.name === "request_takeover");
    expect(JSON.stringify(takeover)).toContain("final, irreversible step of a purchase");
  });

  it("describes only the tools a run has: no request_credentials on a desktop run", async () => {
    const model = scriptedModel([answer("Done.")]);
    await turn({ model });
    const system = systemText(model.doGenerateCalls[0]!.prompt);
    const offered = (model.doGenerateCalls[0]!.tools ?? []).map((item) => item.name);

    expect(offered).not.toContain("request_credentials");
    expect(system).not.toContain("request_credentials");
    // A login wall has to go somewhere: with no secure handoff it is a takeover.
    expect(system).toContain("This run cannot receive a password, authentication code, payment detail, or recovery secret");
    expect(system).toContain("use request_takeover, name the fields the person must fill in");
    expect(system).toContain("Never ask the user to paste passwords");
    const takeover = (model.doGenerateCalls[0]!.tools ?? []).find((item) => item.name === "request_takeover");
    expect(JSON.stringify(takeover)).toContain("This run has no secure credential handoff");
    expect(JSON.stringify(takeover)).not.toContain("use request_credentials for sensitive editable fields");
  });

  it("creates an inline credential handoff without exposing the phone link", async () => {
    const model = scriptedModel([
      calls({
        name: "request_credentials",
        input: {
          tabId: "tab-1",
          siteName: "Example",
          fields: [
            { label: "Email", type: "email", target: "#email", autocomplete: "email" },
            { label: "Password", type: "password", target: "#password", autocomplete: "current-password" },
            { label: "Card number", type: "text", target: "#card-number", autocomplete: "cc-number" },
            { label: "Security code", type: "password", target: "#card-csc", autocomplete: "cc-csc" },
          ],
        },
      }),
    ]);
    const create = vi.fn(async () => ({
      kind: "form" as const,
      capture: {
        id: "8fd7902a-c66e-4f23-9560-6e46a39b1517",
        url: "https://app.example/credential-capture/8fd7902a-c66e-4f23-9560-6e46a39b1517",
        siteName: "Example",
        expiresAt: "2026-08-29T15:15:00.000Z",
      },
    }));
    const { result, callbacks } = await turn({ model, credentials: { host: { create } } });

    expect(result.outcome).toBe("paused");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      name: "credentials.request",
      tabId: "tab-1",
      fields: expect.arrayContaining([
        expect.objectContaining({ target: "#password" }),
        expect.objectContaining({ target: "#card-number", autocomplete: "cc-number" }),
      ]),
    }));
    expect(callbacks.takeoverRequested).toHaveBeenCalledWith(expect.objectContaining({
      id: "8fd7902a-c66e-4f23-9560-6e46a39b1517",
      kind: "credentials",
      captureId: "8fd7902a-c66e-4f23-9560-6e46a39b1517",
      instructions: expect.not.stringContaining("http"),
    }));
    expect(JSON.stringify(result.messages)).not.toContain("credentialValue");
    expect(JSON.stringify(result.messages)).not.toContain("credential-capture/");
    expect(JSON.stringify(callbacks.toolCompleted.mock.calls)).not.toContain("credential-capture/");
  });

  it("continues without pausing when the host fills the request from the person's vault", async () => {
    const model = scriptedModel([
      calls({
        name: "request_credentials",
        input: {
          tabId: "tab-1",
          siteName: "Example",
          fields: [
            { label: "Email", type: "email", target: "#email", autocomplete: "email" },
            { label: "Password", type: "password", target: "#password", autocomplete: "current-password" },
          ],
        },
      }),
      ({ prompt }) => {
        expect(toolResultsIn(prompt).at(-1)?.output).toMatchObject({
          type: "json",
          value: { paused: false, filledFromVault: true, status: "complete", fieldCount: 2 },
        });
        return answer("Signed in with the saved details.")({ prompt } as CallOptions);
      },
    ]);
    const create = vi.fn(async () => ({
      kind: "vault" as const,
      fill: { siteName: "Example", fieldCount: 2, status: "complete" as const },
    }));
    const { result, callbacks } = await turn({ model, credentials: { host: { create } } });

    expect(result.outcome).toBe("final");
    expect(create).toHaveBeenCalledTimes(1);
    expect(callbacks.takeoverRequested).not.toHaveBeenCalled();
    expect(callbacks.toolCompleted).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ summary: "Entered saved details for Example from the vault" }),
    );
    expect(JSON.stringify(result.messages)).not.toContain("credentialValue");
  });

  it("returns a failed credential request to the model so it can retry instead of parking the run", async () => {
    const request = {
      name: "request_credentials",
      input: {
        tabId: "tab-1",
        siteName: "Example",
        fields: [
          { label: "Password", type: "password", target: "#password", autocomplete: "current-password" },
        ],
      },
    };
    const model = scriptedModel([
      calls(request),
      ({ prompt }) => {
        expect(toolResultsIn(prompt).at(-1)?.output).toMatchObject({
          type: "json",
          value: { ok: false, error: "tab closed" },
        });
        return calls(request)({ prompt } as CallOptions);
      },
    ]);
    const create = vi.fn()
      .mockRejectedValueOnce(new Error("tab closed"))
      .mockResolvedValueOnce({
        kind: "form",
        capture: {
          id: "8fd7902a-c66e-4f23-9560-6e46a39b1517",
          url: "https://app.example/credential-capture/8fd7902a-c66e-4f23-9560-6e46a39b1517",
          siteName: "Example",
          expiresAt: "2026-08-29T15:15:00.000Z",
        },
      });
    const { result, callbacks } = await turn({ model, credentials: { host: { create } } });

    expect(result.outcome).toBe("paused");
    expect(result.steps).toBe(2);
    expect(create).toHaveBeenCalledTimes(2);
    expect(callbacks.toolFailed).toHaveBeenCalledWith("tool-1", expect.objectContaining({ message: "tab closed" }));
    expect(callbacks.takeoverRequested).toHaveBeenCalledTimes(1);
  });
});

describe("notes", () => {
  it("reach the system prompt on the very next step", async () => {
    const model = scriptedModel([calls({ name: "task_notes", input: { content: "Plan:\n- [ ] step one\n- [ ] step two" } }), answer("Planned.")]);
    const notes = notesHost();
    const { result, callbacks } = await turn({ model, notes });

    expect(result.outcome).toBe("final");
    expect(callbacks.toolStarted).toHaveBeenCalledWith(expect.objectContaining({ name: "notes.update" }), "Update notes", "Plan:");
    expect(notes.write).toHaveBeenCalledWith("Plan:\n- [ ] step one\n- [ ] step two");
    expect(callbacks.toolCompleted).toHaveBeenCalledWith("tool-1", { summary: expect.stringContaining("Notes updated") });

    expect(model.doGenerateCalls).toHaveLength(2);
    const before = systemText(model.doGenerateCalls[0]!.prompt);
    const after = systemText(model.doGenerateCalls[1]!.prompt);
    expect(before).toContain("(none yet");
    expect(before).not.toContain("step one");
    expect(after).toContain("step one");
    expect(after).not.toContain("(none yet");
    expect(after.indexOf("Your notes for this thread")).toBeGreaterThan(after.indexOf("Notes and long tasks"));
  });
});

describe("the person's notes", () => {
  const PIE = note("a1b2c3d4e5f6", "Sunday pie", "## Filling\n\nSour cherries.\n\n## Crust\n\nAll butter.\n", "2026-08-25T09:00:00.000Z");
  const LEASE = note("0f1e2d3c4b5a", "Lease", "Renews in March. Deposit £900.");

  /** What this tool answered, once per call — the same result is in every later prompt. */
  function results(model: MockLanguageModelV4, name: string): unknown[] {
    const seen = new Map<string, unknown>();
    for (const call of model.doGenerateCalls) {
      for (const part of toolResultsIn(call.prompt)) {
        if (part.toolName === name && !seen.has(part.toolCallId)) {
          seen.set(part.toolCallId, (part.output as { value?: unknown }).value ?? part.output);
        }
      }
    }
    return [...seen.values()];
  }

  it("lists, searches, reads, writes and removes them on the browse path", async () => {
    const { host, notes } = userNotesHost([structuredClone(PIE), structuredClone(LEASE)]);
    const model = scriptedModel([
      calls({ name: "note_list", input: {} }),
      calls({ name: "note_search", input: { query: "pie", limit: null } }),
      calls({ name: "note_read", input: { id: PIE.id } }),
      calls({ name: "note_create", input: { title: "Packing list", markdown: "- socks\n- charger" } }),
      calls({ name: "note_delete", input: { id: LEASE.id, reason: "they asked me to delete it" } }),
      answer("Done: written down."),
    ]);
    const { result, callbacks } = await turn({ model, userNotes: { host } });

    expect(result.outcome).toBe("final");
    // A listing carries ids, titles and a snippet — never a whole body.
    expect(results(model, "note_list")[0]).toMatchObject({
      ok: true,
      result: expect.arrayContaining([{ id: PIE.id, title: "Sunday pie", updatedAt: PIE.updatedAt, snippet: "Filling Sour cherries. Crust All butter." }]),
    });
    expect(JSON.stringify(results(model, "note_list")[0])).not.toContain("## Filling");
    expect(results(model, "note_search")[0]).toMatchObject({ ok: true, result: [{ id: PIE.id, title: "Sunday pie" }] });
    // A read is the whole markdown, so the model can quote it faithfully.
    expect(results(model, "note_read")[0]).toEqual({ ok: true, result: { id: PIE.id, title: "Sunday pie", updatedAt: PIE.updatedAt, markdown: PIE.markdown } });

    expect([...notes.values()].map((entry) => entry.title)).toEqual(["Sunday pie", "Packing list"]);
    expect([...notes.values()].find((entry) => entry.title === "Packing list")?.markdown).toBe("- socks\n- charger");
    expect(notes.has(LEASE.id)).toBe(false);

    // Every call is one entry in the trace, with the words the console shows.
    expect(callbacks.toolStarted).toHaveBeenCalledWith({ name: "note.create", title: "Packing list" }, "Write note", "Packing list");
    expect(callbacks.toolStarted).toHaveBeenCalledWith({ name: "note.delete", id: LEASE.id }, "Delete note", `Removing note ${LEASE.id}`);
    expect(callbacks.toolCompleted).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ summary: expect.stringContaining("Deleted: Lease — note, edited") }));
  });

  it("rewrites one section of a note, and reports a heading it cannot find without throwing", async () => {
    const { host, notes } = userNotesHost([structuredClone(PIE)]);
    const model = scriptedModel([
      calls({ name: "note_update", input: { id: PIE.id, title: null, mode: "replace_section", markdown: "Rhubarb, and less sugar.", section: "Filling" } }),
      calls({ name: "note_update", input: { id: PIE.id, title: null, mode: "replace_section", markdown: "nothing", section: "Ingredients" } }),
      calls({ name: "note_update", input: { id: PIE.id, title: "Sunday pie (rhubarb)", mode: "append", markdown: null, section: null } }),
      answer("Done."),
    ]);
    const { result, callbacks } = await turn({ model, userNotes: { host } });

    expect(result.outcome).toBe("final");
    // The rest of the note is untouched: only the body under that heading moved.
    expect(notes.get(PIE.id)?.markdown).toBe("## Filling\n\nRhubarb, and less sugar.\n\n## Crust\n\nAll butter.");
    // A heading that is not there is a result the model can recover from.
    expect(results(model, "note_update")[1]).toEqual({ ok: false, error: 'no section titled "Ingredients" in this note' });
    expect(callbacks.toolFailed).toHaveBeenCalledTimes(1);
    // A title-only change needs no markdown, and leaves the body alone.
    expect(notes.get(PIE.id)).toMatchObject({ title: "Sunday pie (rhubarb)", markdown: "## Filling\n\nRhubarb, and less sugar.\n\n## Crust\n\nAll butter.", revision: 3 });
    expect(callbacks.toolStarted).toHaveBeenCalledWith({ name: "note.update", id: PIE.id, mode: "append" }, "Edit note", `Adding to note ${PIE.id}`);
  });

  it("survives the answer path's filter, where the run's own scratchpad does not", async () => {
    const { host, notes } = userNotesHost([structuredClone(LEASE)]);
    const model = scriptedModel([
      calls({ name: "note_update", input: { id: LEASE.id, title: null, mode: "append", markdown: "Landlord: Bramley & Co.", section: null } }),
      answer("Added it to your Lease note."),
    ]);
    const { result } = await turn({
      model,
      mode: "answer",
      messages: [userMessage("add the landlord's name to my lease note")],
      userNotes: { host },
      policy: { maxSteps: 5, enabledToolGroups: ["notes", "user_notes", "tabs", "read"] },
    });

    expect(result).toMatchObject({ outcome: "final", text: "Added it to your Lease note." });
    const offered = (model.doGenerateCalls[0]!.tools ?? []).map((item) => item.name);
    expect(offered).toEqual([
      "ask_user",
      "ask_user_text",
      "note_list",
      "note_search",
      "note_read",
      "note_create",
      "note_update",
      "note_delete",
      USE_BROWSER_TOOL,
    ]);
    expect(offered).not.toContain("task_notes");
    expect(notes.get(LEASE.id)?.markdown).toBe("Renews in March. Deposit £900.\n\nLandlord: Bramley & Co.");
    expect(systemText(model.doGenerateCalls[0]!.prompt)).toContain("Note rules:");
  });

  it("puts the note rules in the prompt only when the run has a note store", async () => {
    const withoutStore = scriptedModel([answer("Done.")]);
    await turn({ model: withoutStore });
    expect(systemText(withoutStore.doGenerateCalls[0]!.prompt)).not.toContain("Note rules:");

    const withStore = scriptedModel([answer("Done.")]);
    await turn({ model: withStore, userNotes: { host: userNotesHost().host } });
    const system = systemText(withStore.doGenerateCalls[0]!.prompt);
    expect(system).toContain("Note rules:");
    expect(system).toContain("prefer note_update on the note that already exists");
    expect(system).toContain("When the page in view is a note (address pistachio://notes/<id>)");
    // The thread's own scratchpad rules are still their own thing.
    expect(system).toContain("Notes and long tasks");
  });
});

describe("checkpoints and budgets", () => {
  it("continues past a checkpoint with a user message asking for notes", async () => {
    const model = scriptedModel([tabsList, inspect, navigate, inspect, answer("Done: navigated and checked.")]);
    const { result, callbacks } = await turn({ model, limits: { stepsPerCall: 2, continuations: 2 } });

    expect(result.outcome).toBe("final");
    expect(result.text).toBe("Done: navigated and checked.");
    expect(result.steps).toBe(5);
    expect(callbacks.stepFinished).toHaveBeenCalledTimes(5);
    expect(model.doGenerateCalls).toHaveLength(5);

    // The first two steps ran without a checkpoint; the third saw one.
    expect(userTexts(model.doGenerateCalls[1]!.prompt).some((text) => text.startsWith("[Checkpoint]"))).toBe(false);
    const third = userTexts(model.doGenerateCalls[2]!.prompt);
    expect(third.filter((text) => text.startsWith("[Checkpoint]"))).toHaveLength(1);
    expect(third.at(-1)).toContain("You have taken 2 steps this turn");
    expect(third.at(-1)).toContain("task_notes");
    // The checkpoint is a message in the history, after the step's tool result.
    const fifth = model.doGenerateCalls[4]!.prompt;
    const checkpoints = userTexts(fifth).filter((text) => text.startsWith("[Checkpoint]"));
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[1]).toContain("You have taken 4 steps this turn");
    expect(fifth.at(-1)?.role).toBe("user");
    expect(fifth.at(-2)?.role).toBe("tool");
    expect(historyUserTexts(result.messages).filter((text) => text.startsWith("[Checkpoint]"))).toHaveLength(2);
    // The final history still answers every call.
    expect(closeDanglingToolCalls(result.messages, "x")).toEqual(result.messages);
  });

  it("pauses for the person when the model works past its last checkpoint", async () => {
    const model = scriptedModel([], tabsList);
    const { result, callbacks } = await turn({ model, limits: { stepsPerCall: 1, continuations: 1 } });

    expect(result.outcome).toBe("budget");
    expect(result.text).toBe("");
    expect(result.steps).toBe(2);
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(callbacks.stepFinished).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result.messages)).not.toContain("I finished");
    expect(historyUserTexts(result.messages).filter((text) => text.startsWith("[Checkpoint]"))).toHaveLength(1);
    expect(closeDanglingToolCalls(result.messages, "x")).toEqual(result.messages);
  });
});

describe("a silent model", () => {
  it("is nudged until it answers", async () => {
    const model = scriptedModel([silence(), silence(), answer("Answer.")]);
    const { result } = await turn({ model });

    expect(result.outcome).toBe("final");
    expect(result.text).toBe("Answer.");
    expect(model.doGenerateCalls).toHaveLength(3);
    const nudges = userTexts(model.doGenerateCalls[2]!.prompt).filter((text) => text.startsWith("[System] Your last reply contained no answer"));
    expect(nudges).toHaveLength(2);
  });

  it("is never dressed up as an answer once the nudges run out", async () => {
    const model = scriptedModel([silence(), silence(), silence()]);
    const { result } = await turn({ model });

    expect(result.outcome).toBe("final");
    expect(result.text).toBe("");
    expect(model.doGenerateCalls).toHaveLength(3);
    expect(userTexts(model.doGenerateCalls[2]!.prompt).filter((text) => text.startsWith("[System] Your last reply contained no answer"))).toHaveLength(2);
    expect(JSON.stringify(result.messages)).not.toContain("I finished");
  });
});

describe("context management", () => {
  const pageText = "Line item: widget, quantity 3, unit price $12.50, subtotal $37.50. ".repeat(120);

  it("compacts older steps into a summary when the context grows past the threshold", async () => {
    expect(pageText.length).toBeGreaterThan(7_000);
    const { browser } = fakeBrowser({ pageText });
    const model = scriptedModel([inspect, inspect, inspect, inspect, inspect, inspect, answer("Done: six readings taken.")]);
    const summarize = vi.fn<(prompt: string) => Promise<string>>(async () => "SUMMARY: read the invoice page six times; total $37.50.");
    const { result, callbacks } = await turn({ model, browser, summarize, budget: { window: 100_000, compactAt: 400 } });

    expect(result.outcome).toBe("final");
    expect(result.steps).toBe(7);
    expect(summarize).toHaveBeenCalled();
    const prompt = summarize.mock.calls[0]![0];
    expect(prompt).toContain("Transcript to compact");
    expect(prompt).toContain("page_inspect");
    expect(prompt).toContain("Remaining work");

    expect(callbacks.compacted).toHaveBeenCalled();
    for (const [info] of callbacks.compacted.mock.calls as Array<[{ before: number; after: number; summary: string }]>) {
      expect(info.before).toBeGreaterThan(info.after);
      expect(info.summary).toContain("SUMMARY:");
    }

    // The task message now carries the summary; the model read it that way.
    const first = result.messages[0]!;
    expect(first.role).toBe("user");
    const firstText = historyUserTexts([first]);
    expect(firstText[0]).toBe(TASK.content);
    expect(firstText.at(-1)).toContain(SUMMARY_HEADER);
    expect(firstText.at(-1)).toContain("SUMMARY: read the invoice page six times");
    const lastPrompt = model.doGenerateCalls.at(-1)!.prompt;
    expect(userTexts(lastPrompt).some((text) => text.includes(SUMMARY_HEADER))).toBe(true);
    // One summary, not one per compaction.
    expect(firstText.filter((text) => text.includes(SUMMARY_HEADER))).toHaveLength(1);

    // Uncompacted this would be the task, six tool steps, and the answer.
    expect(result.messages.length).toBeLessThan(1 + 6 * 2 + 1);
    // The tail is trimmed to the budget too: at least the latest reading
    // is still the full page, and whatever is whole is really whole.
    const kept = historyToolResults(result.messages).filter((part) => part.toolName === "page_inspect");
    expect(kept.length).toBeGreaterThan(0);
    const whole = kept.filter((part) => !isElided(part.output as never));
    expect(whole.length).toBeGreaterThan(0);
    expect(whole.length).toBeLessThanOrEqual(KEEP_FULL_TOOL_RESULTS);
    expect(isElided(kept.at(-1)!.output as never)).toBe(false);
    for (const part of whole) expect(JSON.stringify(part.output)).toContain("unit price $12.50");
    expect(closeDanglingToolCalls(result.messages, "x")).toEqual(result.messages);
  });

  it("stubs page readings older than the last few and keeps the recent ones whole", async () => {
    const { browser } = fakeBrowser({ pageText });
    const model = scriptedModel([inspect, inspect, inspect, inspect, inspect, answer("Done: five readings taken.")]);
    const summarize = vi.fn<(prompt: string) => Promise<string>>(async () => "SUMMARY");
    const { result, callbacks } = await turn({ model, browser, summarize, budget: { window: 200_000, compactAt: 150_000 } });

    expect(result.outcome).toBe("final");
    expect(summarize).not.toHaveBeenCalled();
    expect(callbacks.compacted).not.toHaveBeenCalled();

    const lastPrompt = model.doGenerateCalls.at(-1)!.prompt;
    const readings = toolResultsIn(lastPrompt).filter((part) => part.toolName === "page_inspect");
    expect(readings).toHaveLength(5);
    const elided = readings.map((part) => isElided(part.output as never));
    expect(elided).toEqual([true, true, false, false, false]);
    for (const part of readings.slice(0, 2)) {
      const value = (part.output as { value: Record<string, unknown> }).value;
      expect(value["title"]).toBe("Invoice");
      expect(value["note"]).toContain("Call page_inspect again");
      expect(JSON.stringify(value)).not.toContain("unit price");
    }
    for (const part of readings.slice(2)) expect(JSON.stringify(part.output)).toContain("unit price $12.50");
    // Every call is still answered — trimming replaces outputs, never removes them.
    expect(toolResultsIn(lastPrompt).map((part) => part.toolCallId)).toEqual(toolCallsIn(lastPrompt).map((call) => call.toolCallId));
    // And the persisted history is what the model saw.
    const persisted = historyToolResults(result.messages).filter((part) => part.toolName === "page_inspect");
    expect(persisted.map((part) => isElided(part.output as never))).toEqual([true, true, false, false, false]);
  });
});

describe("interruption", () => {
  it("leaves every tool call answered when the turn is aborted mid-way", async () => {
    const abort = new AbortController();
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        if (model.doGenerateCalls.length === 1) return tabsList(options);
        abort.abort();
        throw new DOMException("The operation was aborted", "AbortError");
      },
    });
    const callbacks = recorder();
    await expect(turn({ model, callbacks, abort })).rejects.toThrow();

    expect(callbacks.stepFinished).toHaveBeenCalledTimes(1);
    expect(callbacks.historyChanged).toHaveBeenCalled();
    const last = callbacks.historyChanged.mock.calls.at(-1)![0] as ModelMessage[];
    expect(historyToolCalls(last).map((call) => call.toolName)).toEqual(["tabs_list"]);
    expect(historyToolResults(last).map((part) => part.toolName)).toEqual(["tabs_list"]);
    expect(closeDanglingToolCalls(last, "x")).toEqual(last);
    // Every history the controller could have persisted is consistent.
    for (const [messages] of callbacks.historyChanged.mock.calls as Array<[ModelMessage[]]>) {
      expect(closeDanglingToolCalls(messages, "x")).toEqual(messages);
    }
  });

  it("repairs a dangling tool call in the input before the model sees it", async () => {
    const model = scriptedModel([answer("Done: checked again.")]);
    const messages: ModelMessage[] = [
      TASK,
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "orphan", toolName: "page_inspect", input: { tabId: "tab-1" } }] },
      userMessage("[The person asked you to continue. Inspect the live page and carry on from your notes.]"),
    ];
    const { result } = await turn({ model, messages });

    expect(result.outcome).toBe("final");
    const prompt = model.doGenerateCalls[0]!.prompt;
    const repaired = toolResultsIn(prompt).find((part) => part.toolCallId === "orphan");
    expect(repaired).toBeDefined();
    expect(repaired?.toolName).toBe("page_inspect");
    expect(repaired?.output).toEqual({ type: "error-text", value: TURN_CUT_SHORT });
    // The repair sits right after the call, before the person's message.
    expect(prompt.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
    expect(closeDanglingToolCalls(result.messages, "x")).toEqual(result.messages);
  });
});

describe("compaction over a long turn", () => {
  const pageText = "Line item: widget, quantity 3, unit price $12.50, subtotal $37.50. ".repeat(120);

  it("hands each summary the task and the summary before it, so nothing is lost across compactions", async () => {
    const { browser } = fakeBrowser({ pageText });
    const model = scriptedModel([inspect, inspect, inspect, inspect, inspect, answer("Done: five readings taken.")]);
    const summaries = ["SUMMARY ONE: read the invoice twice; total $37.50.", "SUMMARY TWO: read it four times; still $37.50."];
    const summarize = vi.fn<(prompt: string) => Promise<string>>(async () => summaries.shift() ?? "SUMMARY MORE");
    const { result, callbacks } = await turn({ model, browser, summarize, budget: { window: 100_000, compactAt: 400 } });

    expect(result.outcome).toBe("final");
    expect(summarize).toHaveBeenCalledTimes(2);
    expect(callbacks.compacted).toHaveBeenCalledTimes(2);
    const [first, second] = summarize.mock.calls.map((call) => call[0]);
    expect(first).toContain("check the invoice total");
    expect(first).not.toContain(SUMMARY_HEADER);
    // The second transcript opens with the task and what the first summary said.
    expect(second).toContain("check the invoice total");
    expect(second).toContain(SUMMARY_HEADER);
    expect(second).toContain("SUMMARY ONE: read the invoice twice");
    expect(second!.indexOf("SUMMARY ONE")).toBeLessThan(second!.indexOf("page_inspect"));
    expect(second!.indexOf("check the invoice total")).toBeLessThan(second!.indexOf("SUMMARY ONE"));

    // The thread keeps the latest summary alone; it stands in for the first.
    const anchor = historyUserTexts([result.messages[0]!]);
    expect(anchor[0]).toBe(TASK.content);
    expect(anchor.filter((text) => text.includes(SUMMARY_HEADER))).toHaveLength(1);
    expect(anchor.at(-1)).toContain("SUMMARY TWO");
    expect(anchor.at(-1)).not.toContain("SUMMARY ONE");
    const lastPrompt = model.doGenerateCalls.at(-1)!.prompt;
    expect(userTexts(lastPrompt).some((text) => text.includes("SUMMARY TWO"))).toBe(true);
    expect(userTexts(lastPrompt).some((text) => text.includes("SUMMARY ONE"))).toBe(false);
  });
});

describe("a step the provider cut short", () => {
  it("answers the tool call it never ran and tells the model to repeat it", async () => {
    const model = scriptedModel([cutShort("", { name: "page_inspect", input: { tabId: "tab-1" } }), answer("Done: read it on the second try.")]);
    const { fake, browser } = fakeBrowser();
    const { result, callbacks } = await turn({ model, browser });

    expect(result.outcome).toBe("final");
    expect(result.text).toBe("Done: read it on the second try.");
    // The SDK did not run the call, and neither did we.
    expect(fake.inspect).not.toHaveBeenCalled();
    expect(callbacks.toolStarted).not.toHaveBeenCalled();
    expect(model.doGenerateCalls).toHaveLength(2);

    const prompt = model.doGenerateCalls[1]!.prompt;
    const [call] = toolCallsIn(prompt);
    expect(call?.toolName).toBe("page_inspect");
    const closed = toolResultsIn(prompt).find((part) => part.toolCallId === call?.toolCallId);
    expect(closed?.output).toEqual({ type: "error-text", value: expect.stringContaining("ended early") });
    expect(prompt.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
    const note = userTexts(prompt).at(-1) ?? "";
    expect(note.startsWith("[System] Your last step ended early")).toBe(true);
    expect(note).toContain("length");
    expect(closeDanglingToolCalls(result.messages, "x")).toEqual(result.messages);
  });

  it("takes the text it managed to write as the answer", async () => {
    const model = scriptedModel([cutShort("Done: the total is $120, though I ran out of room.")]);
    const { result } = await turn({ model });

    expect(result.outcome).toBe("final");
    expect(result.text).toBe("Done: the total is $120, though I ran out of room.");
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(closeDanglingToolCalls(result.messages, "x")).toEqual(result.messages);
  });
});

describe("a screenshot", () => {
  it("reaches the model as a picture in its own message, never as base64 text", async () => {
    const image = "A".repeat(20_000);
    const { browser } = fakeBrowser({ screenshot: `data:image/png;base64,${image}` });
    const model = scriptedModel([screenshot, answer("Done: the page looks right.")]);
    const { result } = await turn({ model, browser });

    expect(result.outcome).toBe("final");
    const prompt = model.doGenerateCalls[1]!.prompt;
    // The tool result itself is a small stub that points at the picture…
    const shot = toolResultsIn(prompt).find((part) => part.toolName === "page_screenshot");
    expect(shot).toBeDefined();
    expect(JSON.stringify(shot!.output)).toContain("attached as the next message");
    expect(JSON.stringify(shot!.output)).not.toContain(image);
    // …and the picture is the user message right after the tool message.
    const toolIndex = prompt.findIndex((message) => message.role === "tool");
    const picture = prompt[toolIndex + 1]!;
    expect(picture.role).toBe("user");
    const parts = picture.content as Array<{ type: string; mediaType?: string; text?: string }>;
    expect(parts.find((part) => part.type === "file")).toMatchObject({ type: "file", mediaType: "image/png" });
    expect(parts.filter((part) => part.type === "text").map((part) => part.text ?? "").join(" ")).toContain("Screenshot from page_screenshot");
    // No base64 anywhere in the prompt's text.
    expect(JSON.stringify(prompt.filter((message) => message.role !== "user"))).not.toContain(image);

    // The history carries the same message and prices it as a picture, not by the character.
    const attached = result.messages.find((item) => item.role === "user" && typeof item.content !== "string" && item.content.some((part) => part.type === "file"));
    expect(attached).toBeDefined();
    expect(estimateTokens([attached!])).toBeLessThan(3_000);
    expect(estimateTokens([attached!])).toBeGreaterThan(1_000);
    // Attached once: a second turn over the same history adds no copy.
    const again = scriptedModel([answer("Still fine.")]);
    const second = await turn({ model: again, browser, messages: [...result.messages, userMessage("And now?")] });
    expect(second.result.messages.filter((item) => item.role === "user" && typeof item.content !== "string" && item.content.some((part) => part.type === "file"))).toHaveLength(1);
  });
});

describe("several readings in one step", () => {
  const pageText = "Line item: widget, quantity 3, unit price $12.50, subtotal $37.50. ".repeat(120);
  const inspectThrice = calls(
    { name: "page_inspect", input: { tabId: "tab-1" } },
    { name: "page_inspect", input: { tabId: "tab-1" } },
    { name: "page_inspect", input: { tabId: "tab-1" } },
  );

  it("are all kept whole for the next step, however tight the budget", async () => {
    const { browser } = fakeBrowser({ pageText });
    const model = scriptedModel([inspectThrice, answer("Done: three readings.")]);
    const summarize = vi.fn(async () => "SUMMARY");
    const { result } = await turn({ model, browser, summarize, budget: { window: 100_000, compactAt: 400 } });

    expect(result.outcome).toBe("final");
    expect(summarize).not.toHaveBeenCalled();
    const prompt = model.doGenerateCalls[1]!.prompt;
    const readings = toolResultsIn(prompt).filter((part) => part.toolName === "page_inspect");
    expect(readings).toHaveLength(3);
    expect(new Set(readings.map((part) => part.toolCallId)).size).toBe(3);
    for (const part of readings) {
      expect(isElided(part.output as never)).toBe(false);
      expect(JSON.stringify(part.output)).toContain("unit price $12.50");
    }
    expect(toolResultsIn(prompt).map((part) => part.toolCallId)).toEqual(toolCallsIn(prompt).map((call) => call.toolCallId));
  });

  it("are all stubbed once a newer reading arrives, which stays whole", async () => {
    const { browser } = fakeBrowser({ pageText });
    const model = scriptedModel([inspectThrice, inspect, answer("Done: four readings.")]);
    const { result } = await turn({ model, browser, budget: { window: 100_000, compactAt: 400 } });

    expect(result.outcome).toBe("final");
    const prompt = model.doGenerateCalls[2]!.prompt;
    const readings = toolResultsIn(prompt).filter((part) => part.toolName === "page_inspect");
    expect(readings).toHaveLength(4);
    expect(readings.map((part) => isElided(part.output as never))).toEqual([true, true, true, false]);
    expect(JSON.stringify(readings[3]!.output)).toContain("unit price $12.50");
    for (const part of readings.slice(0, 3)) expect(JSON.stringify(part.output)).not.toContain("unit price");
    expect(toolResultsIn(prompt).map((part) => part.toolCallId)).toEqual(toolCallsIn(prompt).map((call) => call.toolCallId));
    // The persisted history is what the model saw.
    const persisted = historyToolResults(result.messages).filter((part) => part.toolName === "page_inspect");
    expect(persisted.map((part) => isElided(part.output as never))).toEqual([true, true, true, false]);
  });
});

describe("a run policy", () => {
  it("offers the model only the enabled tool groups, and always the pausing tools", async () => {
    const model = scriptedModel([answer("Done: looked only.")]);
    const { result } = await turn({ model, policy: { maxSteps: 10, enabledToolGroups: ["tabs", "read"] } });

    expect(result.outcome).toBe("final");
    expect(result.model).toBe("scripted-model");
    const offered = (model.doGenerateCalls[0]!.tools ?? []).map((item) => item.name);
    expect(offered).toEqual(["tabs_list", "tab_open", "tab_focus", "page_inspect", "ask_user", "ask_user_text", "request_takeover"]);
  });

  it("keeps every pausing tool on, including the credential handoff the host offered", async () => {
    const model = scriptedModel([answer("Done: looked only.")]);
    await turn({
      model,
      policy: { maxSteps: 10, enabledToolGroups: ["read"] },
      credentials: { host: { create: vi.fn(async () => { throw new Error("not called"); }) } },
    });
    const offered = (model.doGenerateCalls[0]!.tools ?? []).map((item) => item.name);
    expect(offered).toEqual(["page_inspect", "ask_user", "ask_user_text", "request_takeover", "request_credentials"]);
  });

  it("offers everything without a policy", async () => {
    const model = scriptedModel([answer("Done.")]);
    await turn({ model });
    const offered = (model.doGenerateCalls[0]!.tools ?? []).map((item) => item.name);
    expect(offered).toContain("page_click");
    expect(offered).toContain("page_screenshot");
    expect(offered).toContain("task_notes");
    expect(offered).toContain("ask_user");
    expect(offered).toContain("ask_user_text");
  });

  it("caps the steps of a turn and hands the rest to the person", async () => {
    const model = scriptedModel([], tabsList);
    const { result, callbacks } = await turn({ model, policy: { maxSteps: 3, enabledToolGroups: ["tabs", "read", "notes"] } });

    expect(result.outcome).toBe("budget");
    expect(result.steps).toBe(3);
    expect(model.doGenerateCalls).toHaveLength(3);
    expect(callbacks.stepFinished).toHaveBeenCalledTimes(3);
    expect(historyUserTexts(result.messages).filter((text) => text.startsWith("[Checkpoint]"))).toHaveLength(0);
    expect(closeDanglingToolCalls(result.messages, "x")).toEqual(result.messages);
  });

  it("counts the steps across checkpoints", async () => {
    const model = scriptedModel([], tabsList);
    const { result } = await turn({ model, policy: { maxSteps: 3, enabledToolGroups: ["tabs"] }, limits: { stepsPerCall: 2, continuations: 5 } });

    expect(result.outcome).toBe("budget");
    expect(result.steps).toBe(3);
    expect(model.doGenerateCalls).toHaveLength(3);
    expect(historyUserTexts(result.messages).filter((text) => text.startsWith("[Checkpoint]"))).toHaveLength(1);
    expect(closeDanglingToolCalls(result.messages, "x")).toEqual(result.messages);
  });

  it("lets the model answer within the cap", async () => {
    const model = scriptedModel([tabsList, answer("Done: one look was enough.")]);
    const { result } = await turn({ model, policy: { maxSteps: 2, enabledToolGroups: ["tabs"] } });

    expect(result.outcome).toBe("final");
    expect(result.text).toBe("Done: one look was enough.");
    expect(result.steps).toBe(2);
  });
});

describe("the answer path", () => {
  const REPLY = userMessage("shorten that to two sentences");
  const memory = (): { prompt: string; host: MemoryToolHost } => ({
    prompt: "What you know about the person:\n- Prefers short answers",
    host: {
      search: vi.fn(async () => []),
      add: vi.fn(() => { throw new Error("not called"); }),
      update: vi.fn(() => { throw new Error("not called"); }),
      forget: vi.fn(() => { throw new Error("not called"); }),
    },
  });

  it("offers no browser tools, no takeover, and one way back to the browser", async () => {
    const model = scriptedModel([answer("Returns take 30 days with a receipt.")]);
    const { result } = await turn({ model, mode: "answer", messages: [REPLY], memory: memory(), credentials: { host: { create: vi.fn(async () => { throw new Error("not called"); }) } } });

    expect(result).toMatchObject({ outcome: "final", text: "Returns take 30 days with a receipt.", steps: 1 });
    const offered = (model.doGenerateCalls[0]!.tools ?? []).map((item) => item.name);
    expect(offered).toEqual(["ask_user", "ask_user_text", "memory_search", "memory_add", "memory_update", "memory_forget", USE_BROWSER_TOOL]);
  });

  it("is prompted as a reply, with the memory block and without the browser rules or the notes", async () => {
    const model = scriptedModel([answer("Done.")]);
    const notes = notesHost("- invoice NS-2048 checked");
    await turn({ model, mode: "answer", messages: [REPLY], memory: memory(), notes });

    const system = systemText(model.doGenerateCalls[0]!.prompt);
    expect(system).toContain("This turn is a reply, not a browser task.");
    expect(system).toContain("call use_browser at once");
    expect(system).toContain("Prefers short answers");
    expect(system).toContain("Your notes from earlier in this thread:\n- invoice NS-2048 checked");
    expect(system).not.toContain("begin by listing the tabs");
    expect(system).not.toContain("For shopping");
    expect(system).not.toContain("request_takeover");
    expect(system).not.toContain("Notes and long tasks");
  });

  it("ends as a hand-off, carrying the reason, when the model asks for the browser", async () => {
    const model = scriptedModel([calls({ name: USE_BROWSER_TOOL, input: { reason: "the current price is on the page" } })]);
    const { result, callbacks } = await turn({ model, mode: "answer", messages: [REPLY] });

    expect(result).toMatchObject({ outcome: "handoff", text: "the current price is on the page", steps: 1 });
    expect(model.doGenerateCalls).toHaveLength(1);
    // The hand-off is not a browser action: nothing reaches the tool trace.
    expect(callbacks.toolStarted).not.toHaveBeenCalled();
  });

  it("narrows a policy's groups further, never widens them", async () => {
    const model = scriptedModel([answer("Done.")]);
    await turn({ model, mode: "answer", messages: [REPLY], memory: memory(), policy: { maxSteps: 5, enabledToolGroups: ["tabs", "read", "notes"] } });
    const offered = (model.doGenerateCalls[0]!.tools ?? []).map((item) => item.name);
    expect(offered).toEqual(["ask_user", "ask_user_text", USE_BROWSER_TOOL]);
  });

  it("stops as budget without a checkpoint when a reply keeps calling tools", async () => {
    const model = scriptedModel([], calls({ name: "memory_search", input: { query: "returns" } }));
    const { result } = await turn({ model, mode: "answer", messages: [REPLY], memory: memory(), limits: {} });

    expect(result.outcome).toBe("budget");
    expect(result.steps).toBe(10);
    expect(historyUserTexts(result.messages).filter((text) => text.startsWith("[Checkpoint]"))).toHaveLength(0);
  });

  it("is the browse path by default", async () => {
    const model = scriptedModel([answer("Done.")]);
    await turn({ model, messages: [REPLY] });
    const offered = (model.doGenerateCalls[0]!.tools ?? []).map((item) => item.name);
    expect(offered).toContain("tabs_list");
    expect(offered).not.toContain(USE_BROWSER_TOOL);
    expect(systemText(model.doGenerateCalls[0]!.prompt)).toContain("begin by listing the tabs");
  });
});
