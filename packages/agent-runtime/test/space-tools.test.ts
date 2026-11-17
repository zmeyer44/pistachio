/**
 * The agent's space tools (docs/primitives.md §2): listing the spaces,
 * sending one away — for now, or until a time read as a reminder's is — and
 * bringing one back. A group of their own, host-supplied: a turn whose host
 * passes none (the cloud, one a reminder started) has none, and an author
 * turn has none whatever the host passed.
 */

import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import {
  ALL_TOOL_GROUPS,
  BROWSER_TOOL_GROUPS,
  isToolEnabled,
  runAiBrowserAgent,
  SPACE_RULES,
  spaceReturnInstant,
  TOOL_GROUPS,
  toolGroupOf,
  userMessage,
  type AiAgentRunCallbacks,
  type BrowserBackend,
  type ExtensionAuthorHost,
  type SpaceToolHost,
  type SpaceToolOutcome,
} from "../src/index.js";

/* ------------------------------ the model -------------------------------- */

type CallOptions = Parameters<MockLanguageModelV4["doGenerate"]>[0];
type GenerateResult = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;
type Step = (options: CallOptions) => GenerateResult;

const usage: GenerateResult["usage"] = {
  inputTokens: { total: 1000, noCache: 1000, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};
let nextCallId = 0;

function calls(...requests: Array<{ name: string; input: Record<string, unknown> }>): Step {
  return () => ({
    content: requests.map((request) => ({ type: "tool-call" as const, toolCallId: `call-${String(++nextCallId)}`, toolName: request.name, input: JSON.stringify(request.input) })),
    finishReason: { unified: "tool-calls", raw: "tool_use" },
    usage,
    warnings: [],
  });
}

function answer(text: string): Step {
  return () => ({ content: [{ type: "text", text }], finishReason: { unified: "stop", raw: "end_turn" }, usage, warnings: [] });
}

function scriptedModel(steps: Step[]): MockLanguageModelV4 {
  const queue = [...steps];
  return new MockLanguageModelV4({
    doGenerate: async (options) => {
      const step = queue.shift();
      if (step === undefined) throw new Error("model script exhausted");
      return step(options);
    },
  });
}

function systemText(options: CallOptions): string {
  return options.prompt.filter((message) => message.role === "system").map((message) => message.content).join("\n");
}

function offered(options: CallOptions): string[] {
  return (options.tools ?? []).map((item) => item.name).sort();
}

/** The tool results the model was sent on its latest call, as the values it reads. */
function toolResults(options: CallOptions): unknown[] {
  const found: unknown[] = [];
  for (const message of options.prompt) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type !== "tool-result") continue;
      const output = part.output as { type: string; value?: unknown };
      found.push(output.value);
    }
  }
  return found;
}

/* ------------------------------ the harness ------------------------------ */

function recorder() {
  let nextToolId = 0;
  return {
    toolStarted: vi.fn((): string => `tool-${String(++nextToolId)}`),
    toolCompleted: vi.fn(),
    toolFailed: vi.fn(),
    toolProgress: vi.fn(),
    questionAsked: vi.fn(),
    takeoverRequested: vi.fn(),
    historyChanged: vi.fn(),
    stepFinished: vi.fn(),
    compacted: vi.fn(),
    changed: vi.fn(),
  } satisfies AiAgentRunCallbacks;
}

const browser: BrowserBackend = {
  kind: "desktop",
  listTabs: () => [],
  openTab: async () => "tab-2",
  focusTab: async () => undefined,
  navigate: async () => undefined,
  back: async () => undefined,
  forward: async () => undefined,
  reload: async () => undefined,
  inspect: async () => ({ title: "", url: "", text: "", controls: [] }),
  click: async () => undefined,
  type: async (_tabId: string, _target: string, value: string) => value,
  press: async () => undefined,
  scroll: async () => undefined,
  screenshot: async () => "data:image/png;base64,AAAA",
};

/** Saturday 29 August 2026, 9:00 in Denver. */
const NOW = new Date("2026-08-29T15:00:00Z");
const ZONE = "America/Denver";
const PAST = "The time to come back has passed already.";

/** Main's away service as the tools meet it: a rail of two, one away already, and a clock that refuses the past. */
function spaceHost() {
  const host = {
    list: vi.fn(() => ({
      spaces: [
        { id: "space-football", title: "Football", tabCount: 2, current: true },
        { id: "space-work", title: "Work", tabCount: 5, current: false },
      ],
      away: [{ id: "space-taxes", title: "Taxes", tabCount: 3, since: "2026-08-01T12:00:00.000Z", until: null, by: "the person" }],
    })),
    sendAway: vi.fn(async (spaceId: string, until: number | null): Promise<SpaceToolOutcome> => {
      if (spaceId !== "space-football") return { ok: false, reason: "That space is not here." };
      if (until !== null && until <= NOW.getTime()) return { ok: false, reason: PAST };
      return { ok: true, title: "Football", until: until === null ? null : new Date(until).toISOString(), back: until === null ? "when asked" : "Sun 8:00 AM" };
    }),
    bringBack: vi.fn(async (spaceId: string): Promise<SpaceToolOutcome> =>
      spaceId === "space-taxes" ? { ok: true, title: "Taxes", until: null, back: "now" } : { ok: false, reason: "That space is not away." },
    ),
    close: vi.fn(async (spaceId: string): Promise<SpaceToolOutcome> =>
      spaceId === "space-work" ? { ok: true, title: "Work", until: null, back: "from the archive, when the person restores it" } : { ok: false, reason: "This space is being shared live. End the share, then close it." },
    ),
  } satisfies SpaceToolHost;
  return host;
}

function run(model: MockLanguageModelV4, extra: Partial<Parameters<typeof runAiBrowserAgent>[0]> = {}) {
  const callbacks = recorder();
  const promise = runAiBrowserAgent({
    messages: [userMessage("Hide my football space until Sunday morning.")],
    browser,
    callbacks,
    abortSignal: new AbortController().signal,
    notes: { read: () => "", write: (content) => content },
    model,
    modelName: "mock",
    now: () => NOW,
    ...extra,
  });
  return { callbacks, promise };
}

const SPACE_TOOLS = ["space_bring_back", "space_close", "space_send_away", "spaces_list"];

/* --------------------------------- tests ---------------------------------- */

describe("the space tools' group", () => {
  it("is `spaces`: four tools a policy can turn off, and none of the browser's", () => {
    expect([...TOOL_GROUPS.spaces].sort()).toEqual(SPACE_TOOLS);
    expect(ALL_TOOL_GROUPS).toContain("spaces");
    expect(BROWSER_TOOL_GROUPS).not.toContain("spaces");
    for (const name of SPACE_TOOLS) {
      expect(toolGroupOf(name)).toBe("spaces");
      expect(isToolEnabled(name, ["spaces"])).toBe(true);
      expect(isToolEnabled(name, ["tabs", "desk", "reminders"])).toBe(false);
    }
  });

  it("is a turn's only when its host passes one, with the rules that go with it", async () => {
    const without = scriptedModel([answer("Hello.")]);
    await run(without).promise;
    for (const name of SPACE_TOOLS) expect(offered(without.doGenerateCalls[0]!)).not.toContain(name);
    expect(systemText(without.doGenerateCalls[0]!)).not.toContain("Space rules:");

    const withSpaces = scriptedModel([answer("Hello.")]);
    await run(withSpaces, { spaces: { host: spaceHost(), timezone: ZONE } }).promise;
    expect(offered(withSpaces.doGenerateCalls[0]!)).toEqual(expect.arrayContaining(SPACE_TOOLS));
    const system = systemText(withSpaces.doGenerateCalls[0]!);
    expect(system).toContain(SPACE_RULES.trim());
    expect(system).toContain("never pair it with a reminder");
    expect(system).toContain("/extension");
    // The clock the rule points at is the person's, with or without reminders.
    expect(system).toContain("9:00 AM");
  });

  it("stays on the answer path, which has no browser, and goes with a policy that leaves the group out", async () => {
    const reply = scriptedModel([answer("Done.")]);
    await run(reply, { mode: "answer", spaces: { host: spaceHost(), timezone: ZONE } }).promise;
    const names = offered(reply.doGenerateCalls[0]!);
    expect(names).toEqual(expect.arrayContaining(SPACE_TOOLS));
    expect(names).not.toContain("tabs_list");
    expect(systemText(reply.doGenerateCalls[0]!)).toContain("Space rules:");

    const narrowed = scriptedModel([answer("Done.")]);
    await run(narrowed, { spaces: { host: spaceHost(), timezone: ZONE }, policy: { maxSteps: 10, enabledToolGroups: ["tabs", "reminders"] } }).promise;
    for (const name of SPACE_TOOLS) expect(offered(narrowed.doGenerateCalls[0]!)).not.toContain(name);
  });

  it("is never an author turn's, whatever the host passed", async () => {
    const author: ExtensionAuthorHost = {
      write: vi.fn(async (_slug: string, path: string, content: string) => ({ path, bytes: content.length })),
      read: vi.fn(async () => ({ path: null, files: [] })),
      status: vi.fn(async () => "{}"),
    };
    const model = scriptedModel([answer("Drafted.")]);
    await run(model, { author: { host: author, slug: "game-day", guide: "# The guide" }, spaces: { host: spaceHost(), timezone: ZONE } }).promise;
    const first = model.doGenerateCalls[0]!;
    expect(offered(first)).toEqual(["ask_user", "ask_user_text", "extension_draft_read", "extension_draft_write", "extension_status"]);
    expect(systemText(first)).not.toContain("Space rules:");
  });
});

describe("when a space comes back", () => {
  it("is minutes from now, rounded", () => {
    expect(spaceReturnInstant(null, 90, NOW, ZONE)).toBe(NOW.getTime() + 90 * 60_000);
    expect(spaceReturnInstant("2030-01-01T00:00:00Z", 20.4, NOW, ZONE)).toBe(NOW.getTime() + 20 * 60_000);
    expect(() => spaceReturnInstant(null, 0, NOW, ZONE)).toThrow("inMinutes must be at least 1");
  });

  it("is the instant an ISO time with an offset says", () => {
    expect(spaceReturnInstant("2026-08-30T08:00:00-06:00", null, NOW, "Asia/Tokyo")).toBe(Date.parse("2026-08-30T14:00:00Z"));
    expect(spaceReturnInstant("2026-08-30T14:00:00Z", null, NOW, ZONE)).toBe(Date.parse("2026-08-30T14:00:00Z"));
  });

  it("reads a time with no offset in the run's zone, never this machine's", () => {
    // 8:00 on a Denver summer morning is 14:00 UTC; in Tokyo it is 23:00 UTC the day before.
    expect(spaceReturnInstant("2026-08-30T08:00:00", null, NOW, ZONE)).toBe(Date.parse("2026-08-30T14:00:00Z"));
    expect(spaceReturnInstant("2026-08-30T08:00", null, NOW, "Asia/Tokyo")).toBe(Date.parse("2026-08-29T23:00:00Z"));
  });

  it("is never, with neither: away until asked", () => {
    expect(spaceReturnInstant(null, null, NOW, ZONE)).toBeNull();
    expect(spaceReturnInstant("  ", null, NOW, ZONE)).toBeNull();
  });

  it("says what is wrong with a time it cannot read, and leaves a past one to the host", () => {
    expect(() => spaceReturnInstant("Sunday morning", null, NOW, ZONE)).toThrow("at is not an ISO 8601 date-time");
    expect(spaceReturnInstant("2026-08-01T08:00:00-06:00", null, NOW, ZONE)).toBe(Date.parse("2026-08-01T14:00:00Z"));
  });
});

describe("the space tools at work", () => {
  it("lists the rail and what is away, as the host says it", async () => {
    const host = spaceHost();
    const model = scriptedModel([calls({ name: "spaces_list", input: {} }), answer("Football, Work; Taxes is away.")]);
    const { callbacks, promise } = run(model, { spaces: { host, timezone: ZONE } });
    await promise;
    expect(host.list).toHaveBeenCalledTimes(1);
    expect(callbacks.toolStarted).toHaveBeenCalledWith({ name: "spaces.list" }, "Looking at the spaces", "");
    expect(callbacks.toolCompleted).toHaveBeenCalledWith("tool-1", expect.objectContaining({ summary: "2 spaces, 1 away" }));
    expect(toolResults(model.doGenerateCalls[1]!)).toEqual([
      {
        spaces: [
          { id: "space-football", title: "Football", tabCount: 2, current: true },
          { id: "space-work", title: "Work", tabCount: 5, current: false },
        ],
        away: [{ id: "space-taxes", title: "Taxes", tabCount: 3, since: "2026-08-01T12:00:00.000Z", until: null, by: "the person" }],
      },
    ]);
  });

  it("sends a space away until a time read in the person's zone, and says when it is back", async () => {
    const host = spaceHost();
    const model = scriptedModel([calls({ name: "space_send_away", input: { spaceId: "space-football", at: "2026-08-30T08:00:00", inMinutes: null } }), answer("Football is away until Sunday 8:00.")]);
    const { callbacks, promise } = run(model, { spaces: { host, timezone: ZONE } });
    await promise;
    const until = Date.parse("2026-08-30T14:00:00Z");
    expect(host.sendAway).toHaveBeenCalledWith("space-football", until);
    expect(callbacks.toolStarted).toHaveBeenCalledWith(
      { name: "space.sendAway", spaceId: "space-football", until: "2026-08-30T14:00:00.000Z" },
      "Sending a space away",
      "Until 2026-08-30T14:00:00.000Z",
    );
    expect(callbacks.toolCompleted).toHaveBeenCalledWith("tool-1", expect.objectContaining({ summary: "Sent Football away until Sun 8:00 AM" }));
    expect(toolResults(model.doGenerateCalls[1]!)).toEqual([{ ok: true, title: "Football", until: "2026-08-30T14:00:00.000Z", back: "Sun 8:00 AM" }]);
  });

  it("sends it away until asked when neither time is given, and for minutes when that is", async () => {
    const host = spaceHost();
    const model = scriptedModel([
      calls({ name: "space_send_away", input: { spaceId: "space-football", at: null, inMinutes: null } }),
      calls({ name: "space_send_away", input: { spaceId: "space-football", at: null, inMinutes: 45 } }),
      answer("Away."),
    ]);
    const { callbacks, promise } = run(model, { spaces: { host, timezone: ZONE } });
    await promise;
    expect(host.sendAway).toHaveBeenNthCalledWith(1, "space-football", null);
    expect(host.sendAway).toHaveBeenNthCalledWith(2, "space-football", NOW.getTime() + 45 * 60_000);
    expect(callbacks.toolStarted).toHaveBeenNthCalledWith(1, { name: "space.sendAway", spaceId: "space-football", until: null }, "Sending a space away", "Until asked for");
    expect(callbacks.toolCompleted).toHaveBeenNthCalledWith(1, "tool-1", expect.objectContaining({ summary: "Sent Football away" }));
    expect(toolResults(model.doGenerateCalls[1]!)).toEqual([{ ok: true, title: "Football", until: null, back: "when asked" }]);
  });

  it("passes on the host's own sentence when it refuses — a time already past — as a failed step, never an exception", async () => {
    const host = spaceHost();
    const model = scriptedModel([calls({ name: "space_send_away", input: { spaceId: "space-football", at: "2026-08-01T08:00:00-06:00", inMinutes: null } }), answer("That time has passed.")]);
    const { callbacks, promise } = run(model, { spaces: { host, timezone: ZONE } });
    const result = await promise;
    expect(result.outcome).toBe("final");
    expect(host.sendAway).toHaveBeenCalledWith("space-football", Date.parse("2026-08-01T14:00:00Z"));
    expect(callbacks.toolCompleted).not.toHaveBeenCalled();
    expect(callbacks.toolFailed).toHaveBeenCalledTimes(1);
    expect((callbacks.toolFailed.mock.calls[0]![1] as Error).message).toBe(PAST);
    expect(toolResults(model.doGenerateCalls[1]!)).toEqual([{ ok: false, reason: PAST }]);
  });

  it("never asks the host about a time it could not read", async () => {
    const host = spaceHost();
    const model = scriptedModel([calls({ name: "space_send_away", input: { spaceId: "space-football", at: "Sunday at eight", inMinutes: null } }), answer("I need a proper time.")]);
    const { callbacks, promise } = run(model, { spaces: { host, timezone: ZONE } });
    await promise;
    expect(host.sendAway).not.toHaveBeenCalled();
    expect(callbacks.toolFailed).toHaveBeenCalledTimes(1);
    const [sent] = toolResults(model.doGenerateCalls[1]!) as Array<{ ok: boolean; reason: string }>;
    expect(sent).toEqual({ ok: false, reason: expect.stringContaining("at is not an ISO 8601 date-time") });
  });

  it("brings an away space back, and says so", async () => {
    const host = spaceHost();
    const model = scriptedModel([
      calls({ name: "space_bring_back", input: { spaceId: "space-taxes" } }),
      calls({ name: "space_bring_back", input: { spaceId: "space-work" } }),
      answer("Taxes is back."),
    ]);
    const { callbacks, promise } = run(model, { spaces: { host, timezone: ZONE } });
    await promise;
    expect(host.bringBack).toHaveBeenNthCalledWith(1, "space-taxes");
    expect(callbacks.toolStarted).toHaveBeenNthCalledWith(1, { name: "space.bringBack", spaceId: "space-taxes" }, "Bringing a space back", "");
    expect(callbacks.toolCompleted).toHaveBeenCalledWith("tool-1", expect.objectContaining({ summary: "Brought Taxes back" }));
    expect(toolResults(model.doGenerateCalls[1]!)).toEqual([{ ok: true, title: "Taxes", until: null, back: "now" }]);
    // One that is not away is the host's to refuse, in its words.
    expect(toolResults(model.doGenerateCalls[2]!)).toContainEqual({ ok: false, reason: "That space is not away." });
  });

  it("closes a space into the archive, says where it went, and passes on the host's sentence when it may not", async () => {
    const host = spaceHost();
    const model = scriptedModel([
      calls({ name: "space_close", input: { spaceId: "space-work" } }),
      calls({ name: "space_close", input: { spaceId: "space-football" } }),
      answer("Work is closed; it is in the archive."),
    ]);
    const { callbacks, promise } = run(model, { spaces: { host, timezone: ZONE } });
    await promise;
    expect(host.close).toHaveBeenNthCalledWith(1, "space-work");
    expect(callbacks.toolStarted).toHaveBeenNthCalledWith(1, { name: "space.close", spaceId: "space-work" }, "Closing a space", "");
    expect(callbacks.toolCompleted).toHaveBeenCalledWith("tool-1", expect.objectContaining({ summary: "Closed Work" }));
    expect(toolResults(model.doGenerateCalls[1]!)).toEqual([{ ok: true, title: "Work", until: null, back: "from the archive, when the person restores it" }]);
    expect(callbacks.toolFailed).toHaveBeenCalledTimes(1);
    expect(toolResults(model.doGenerateCalls[2]!)).toContainEqual({ ok: false, reason: "This space is being shared live. End the share, then close it." });
    // The rule it is given: closing is for done, sending away for later.
    expect(SPACE_RULES).toContain("space_close is for a space the person is done with");
  });
});
