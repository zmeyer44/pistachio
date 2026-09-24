import { describe, expect, it } from "vitest";
import {
  foldControlSummary,
  foldRunEvent,
  type RunContentEvent,
  type RunControlEvent,
  type RunEvent,
  type RunSummary,
  type ThreadListItem,
} from "../src/index.js";

const t0 = "2026-09-01T10:00:00.000Z";
const at = (seconds: number): string => new Date(Date.parse(t0) + seconds * 1_000).toISOString();

/** The control-class run control announces: no messages, tools, activity, or result yet. */
function createdRun(): RunSummary {
  return {
    runId: "run-1",
    taskId: "task-1",
    status: "ready",
    purpose: "Book the usual table for Friday",
    title: "Book the usual table for Friday",
    updatedAt: t0,
    turns: 1,
    notes: "",
    context: { tokens: null, compactAt: 160_000, window: 200_000, compactions: 0, steps: 0, totalSteps: 0, usage: { inputTokens: 0, outputTokens: 0 } },
    humanTabId: null,
    agentTabId: null,
    startedAt: t0,
    completedAt: null,
    control: "agent",
    origin: { kind: "channel", linkId: "link-1", deliveryId: "d-1", channelName: "ops" },
    executor: { kind: "cloud", deviceId: null, workerId: null },
    pendingApproval: null,
    pendingQuestion: null,
    pendingTakeover: null,
    messages: [],
    toolCalls: [],
    subagents: [],
    activity: [],
    result: null,
  };
}

/** A whole run, as the runner's callbacks and the person's commands produce it. */
const stream: Array<{ at: string; event: RunControlEvent | RunContentEvent }> = [
  { at: at(0), event: { t: "run.created", run: createdRun() } },
  { at: at(1), event: { t: "message", message: { id: "m-1", at: at(1), role: "user", content: "Book the usual table for Friday", turn: 1 } } },
  { at: at(2), event: { t: "status", status: "running", completedAt: null } },
  { at: at(2), event: { t: "turn", turns: 1 } },
  { at: at(3), event: { t: "activity", entry: { id: "a-1", at: at(3), label: "Agent started", detail: "Connected to the cloud browser", tone: "safe" } } },
  { at: at(4), event: { t: "tool.started", toolId: "tool-1", name: "page.navigate", label: "Open restaurant.example", tabId: "cloud:tab-1" } },
  { at: at(4), event: { t: "tool.detail", toolId: "tool-1", detail: "Navigating to https://restaurant.example/", summary: "" } },
  { at: at(5), event: { t: "tool.completed", toolId: "tool-1" } },
  { at: at(5), event: { t: "tool.detail", toolId: "tool-1", detail: "Navigating to https://restaurant.example/", summary: "Reservations page loaded", data: { url: "https://restaurant.example/reserve" } } },
  { at: at(6), event: { t: "step", usage: { inputTokens: 1_200, outputTokens: 80 }, contextTokens: 1_280 } },
  { at: at(7), event: { t: "tool.started", toolId: "tool-2", name: "page.click", label: "Click Friday", tabId: "cloud:tab-1" } },
  { at: at(8), event: { t: "tool.failed", toolId: "tool-2" } },
  { at: at(9), event: { t: "step", usage: { inputTokens: 1_500, outputTokens: 120 }, contextTokens: 2_900 } },
  { at: at(10), event: { t: "question", question: { id: "q-1", prompt: "Which time?", description: "Two slots are open.", choices: [{ value: "19:00", label: "7 pm", description: "" }, { value: "20:30", label: "8:30 pm", description: "" }] } } },
  { at: at(10), event: { t: "question.asked", questionId: "q-1" } },
  { at: at(10), event: { t: "pause", pause: { id: "q-1", kind: "judgment", requestedAt: at(10), expiresAt: at(3_600), capability: null, payload: {} } } },
  { at: at(10), event: { t: "status", status: "waiting_for_judgment", completedAt: null } },
  { at: at(20), event: { t: "cmd.answer", questionId: "q-1", value: "19:00" } },
  { at: at(21), event: { t: "resume" } },
  { at: at(21), event: { t: "status", status: "running", completedAt: null } },
  { at: at(21), event: { t: "message", message: { id: "m-2", at: at(21), role: "user", content: "7 pm", turn: 1 } } },
  { at: at(22), event: { t: "compacted", before: 2_900, after: 900 } },
  { at: at(23), event: { t: "step", usage: { inputTokens: 900, outputTokens: 60 }, contextTokens: 960 } },
  { at: at(24), event: { t: "title", title: "Friday table" } },
  { at: at(25), event: { t: "message", message: { id: "m-3", at: at(25), role: "assistant", content: "Booked for 7 pm.", turn: 1 } } },
  { at: at(25), event: { t: "reply", text: "Booked for 7 pm." } },
  { at: at(26), event: { t: "result", result: { summary: "Booked for 7 pm.", changes: ["Reservation created"], capsuleRevoked: true, evidenceEntries: 4, rootHash: "abc" } } },
  { at: at(26), event: { t: "evidence", entry: { id: "ev-1", at: at(26), type: "run.completed", payload: { ok: true } } } },
  { at: at(26), event: { t: "status", status: "completed", completedAt: at(26) } },
  { at: at(26), event: { t: "done", ok: true } },
];

function foldAll(events: typeof stream): RunSummary {
  let run: RunSummary | null = null;
  for (const item of events) run = foldRunEvent(run, item.event, item.at);
  if (run === null) throw new Error("empty stream");
  return run;
}

describe("foldRunEvent", () => {
  it("reconstructs the run from a full event stream", () => {
    expect(foldAll(stream)).toEqual<RunSummary>({
      ...createdRun(),
      status: "completed",
      completedAt: at(26),
      updatedAt: at(26),
      title: "Friday table",
      turns: 1,
      context: {
        tokens: 960,
        compactAt: 160_000,
        window: 200_000,
        compactions: 1,
        steps: 3,
        totalSteps: 3,
        usage: { inputTokens: 3_600, outputTokens: 260 },
      },
      messages: [
        { id: "m-1", at: at(1), role: "user", content: "Book the usual table for Friday", turn: 1 },
        { id: "m-2", at: at(21), role: "user", content: "7 pm", turn: 1 },
        { id: "m-3", at: at(25), role: "assistant", content: "Booked for 7 pm.", turn: 1 },
      ],
      toolCalls: [
        {
          id: "tool-1",
          name: "page.navigate",
          label: "Open restaurant.example",
          detail: "Reservations page loaded",
          status: "completed",
          startedAt: at(4),
          completedAt: at(5),
          tabId: "cloud:tab-1",
          turn: 1,
        },
        {
          id: "tool-2",
          name: "page.click",
          label: "Click Friday",
          detail: "",
          status: "failed",
          startedAt: at(7),
          completedAt: at(8),
          tabId: "cloud:tab-1",
          turn: 1,
        },
      ],
      activity: [{ id: "a-1", at: at(3), label: "Agent started", detail: "Connected to the cloud browser", tone: "safe" }],
      result: { summary: "Booked for 7 pm.", changes: ["Reservation created"], capsuleRevoked: true, evidenceEntries: 4, rootHash: "abc" },
    });
  });

  it("shows the pending question while the run waits and clears it on resume", () => {
    const waiting = foldAll(stream.slice(0, 17));
    expect(waiting.status).toBe("waiting_for_judgment");
    expect(waiting.pendingQuestion?.id).toBe("q-1");
    expect(waiting.pendingQuestion?.choices.map((choice) => choice.value)).toEqual(["19:00", "20:30"]);
    const answered = foldRunEvent(waiting, { t: "cmd.answer", questionId: "q-1", value: "19:00" }, at(20));
    expect(answered.pendingQuestion?.id).toBe("q-1");
    expect(foldRunEvent(answered, { t: "resume" }, at(21)).pendingQuestion).toBeNull();
  });

  it("carries a free-text answer descriptor through the encrypted question event", () => {
    const run = foldAll(stream.slice(0, 13));
    const waiting = foldRunEvent(run, {
      t: "question",
      question: {
        id: "q-zip",
        prompt: "What ZIP code should I use?",
        description: "Local prices depend on the destination.",
        choices: [],
        input: { type: "text", placeholder: "ZIP code" },
      },
    }, at(10));
    expect(waiting.pendingQuestion?.input).toEqual({ type: "text", placeholder: "ZIP code" });
  });

  it("carries a takeover and an approval pause into the pending fields", () => {
    const run = foldAll(stream.slice(0, 4));
    const takeover = foldRunEvent(run, { t: "takeover", takeover: { id: "tk-1", reason: "Captcha", instructions: "Solve it", resumeLabel: "Done" } }, at(5));
    expect(takeover.pendingTakeover?.id).toBe("tk-1");
    const approval = foldRunEvent(
      takeover,
      {
        t: "pause",
        pause: {
          id: "ap-1",
          kind: "approval",
          requestedAt: at(6),
          expiresAt: at(600),
          capability: "browser.submit",
          payload: { action: "Submit order", resource: "https://shop.example/checkout", summary: "Pay $20", before: { total: 0 }, after: { total: 20 }, dataLeaving: ["card", 4], reversible: false },
        },
      },
      at(6),
    );
    expect(approval.pendingApproval).toEqual({
      id: "ap-1",
      runId: "run-1",
      requestedAt: at(6),
      expiresAt: at(600),
      evidence: { action: "Submit order", resource: "https://shop.example/checkout", summary: "Pay $20", before: { total: 0 }, after: { total: 20 }, dataLeaving: ["card"], reversible: false },
    });
    const ended = foldRunEvent(approval, { t: "status", status: "revoked", completedAt: at(7) }, at(7));
    expect(ended.pendingApproval).toBeNull();
    expect(ended.pendingTakeover).toBeNull();
  });

  it("treats commands as no-ops except cmd.message, which appends the turn", () => {
    const run = foldAll(stream.slice(0, 5));
    const commands: RunControlEvent[] = [
      { t: "cmd.answer", questionId: "q-9", value: "x" },
      { t: "cmd.interrupt" },
      { t: "cmd.release" },
      { t: "cmd.revoke" },
    ];
    for (const command of commands) {
      expect(foldRunEvent(run, command, at(30))).toEqual({ ...run, updatedAt: at(30) });
    }
    const attachments = [{ id: "att-1", name: "menu.png", mediaType: "image/png", url: "data:image/png;base64,AA==" }];
    const withResult = foldRunEvent(run, {
      t: "result",
      result: { summary: "Booked.", changes: [], capsuleRevoked: true, evidenceEntries: 1, rootHash: "abc" },
    }, at(30));
    const messaged = foldRunEvent(withResult, { t: "cmd.message", text: "Make it 8:30 instead", attachments }, at(31));
    expect(messaged.turns).toBe(2);
    expect(messaged.result).toBeNull();
    expect(messaged.messages).toEqual([
      ...run.messages,
      { id: "cmd.message:2", at: at(31), role: "user", content: "Make it 8:30 instead", turn: 2, attachments },
    ]);
    const plain = foldRunEvent(messaged, { t: "cmd.message", text: "Thanks", attachments: [] }, at(32));
    expect(plain.turns).toBe(3);
    expect(plain.messages.at(-1)).toEqual({ id: "cmd.message:3", at: at(32), role: "user", content: "Thanks", turn: 3 });
    // A later turn resets the per-turn step count and tools join that turn.
    const turned = foldRunEvent(plain, { t: "turn", turns: 3 }, at(33));
    expect(turned.context.steps).toBe(0);
    const tool = foldRunEvent(turned, { t: "tool.started", toolId: "tool-9", name: "tabs.list", label: "List tabs", tabId: null }, at(34));
    expect(tool.toolCalls.at(-1)?.turn).toBe(3);
  });

  it("never mutates the run it is given and shares what it did not touch", () => {
    const run = foldAll(stream.slice(0, 8));
    const frozen = structuredClone(run);
    const next = foldRunEvent(run, { t: "activity", entry: { id: "a-2", at: at(9), label: "x", detail: "y", tone: "neutral" } }, at(9));
    expect(run).toEqual(frozen);
    expect(next.activity).toHaveLength(2);
    expect(next.toolCalls).toBe(run.toolCalls);
    expect(next.messages).toBe(run.messages);
    // Replaying an event with the same id replaces rather than duplicates.
    const replayed = foldRunEvent(next, { t: "activity", entry: { id: "a-2", at: at(9), label: "x", detail: "z", tone: "neutral" } }, at(9));
    expect(replayed.activity).toHaveLength(2);
    expect(replayed.activity[1]?.detail).toBe("z");
    const restarted = foldRunEvent(next, { t: "run.created", run: createdRun() }, at(0));
    expect(restarted).toEqual(createdRun());
  });

  it("refuses a stream that does not start with run.created", () => {
    expect(() => foldRunEvent(null, { t: "status", status: "running", completedAt: null }, at(1))).toThrow("before run.created");
  });
});

describe("foldControlSummary", () => {
  const created: RunEvent = { t: "run.created", run: createdRun() };

  it("builds the thread-list row from run.created and tracks control-class changes", () => {
    let summary = foldControlSummary(null, created, at(0));
    expect(summary).toEqual<ThreadListItem>({
      runId: "run-1",
      title: "Book the usual table for Friday",
      status: "ready",
      startedAt: t0,
      updatedAt: at(0),
      turns: 1,
      messageCount: 0,
      origin: { kind: "channel", linkId: "link-1", deliveryId: "d-1", channelName: "ops" },
      executor: { kind: "cloud", deviceId: null, workerId: null },
    });
    summary = foldControlSummary(summary, { t: "status", status: "running", completedAt: null }, at(2));
    expect(summary.status).toBe("running");
    expect(summary.updatedAt).toBe(at(2));
    summary = foldControlSummary(summary, { t: "title", title: "Friday table" }, at(3));
    expect(summary.title).toBe("Friday table");
    summary = foldControlSummary(summary, { t: "reply", text: "Booked." }, at(4));
    expect(summary.messageCount).toBe(1);
    summary = foldControlSummary(summary, { t: "cmd.message", text: "Make it 8:30", attachments: [] }, at(5));
    expect(summary.turns).toBe(2);
    expect(summary.messageCount).toBe(2);
    summary = foldControlSummary(summary, { t: "turn", turns: 2 }, at(6));
    expect(summary.turns).toBe(2);
    summary = foldControlSummary(summary, { t: "tool.started", toolId: "t", name: "tabs.list", label: "x", tabId: null }, at(7));
    expect(summary.updatedAt).toBe(at(7));
    summary = foldControlSummary(summary, { t: "status", status: "completed", completedAt: at(8) }, at(8));
    expect(summary).toMatchObject({ status: "completed", turns: 2, messageCount: 2, updatedAt: at(8) });
  });

  it("ignores sealed events and never mutates its input", () => {
    const summary = foldControlSummary(null, created, at(0));
    const frozen = structuredClone(summary);
    const sealed: RunEvent = { t: "sealed", spaceId: "work", sealed: "AAAA" };
    expect(foldControlSummary(summary, sealed, at(9))).toBe(summary);
    const next = foldControlSummary(summary, { t: "cmd.message", text: "x", attachments: [] }, at(9));
    expect(summary).toEqual(frozen);
    expect(next).not.toBe(summary);
    expect(() => foldControlSummary(null, sealed, at(9))).toThrow("before run.created");
  });

  it("omits origin and executor when the run has none", () => {
    const run = createdRun();
    delete run.origin;
    delete run.executor;
    const summary = foldControlSummary(null, { t: "run.created", run }, at(0));
    expect("origin" in summary).toBe(false);
    expect("executor" in summary).toBe(false);
  });
});
