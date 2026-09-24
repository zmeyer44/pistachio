import { randomUUID } from "node:crypto";
import { foldRunEvent, type RunContentEvent, type RunControlEvent, type RunEventInput, type RunSummary } from "@pistachio/protocol";
import { describe, expect, it } from "vitest";
import { openRunEvent, openThread, RunEventWriter, sealThread } from "../src/runs/events.js";
import { capThread, stripMedia, titleFor } from "../src/runs/executor.js";
import { testSpaceKeys } from "./helpers/keys.js";

function summary(runId: string): RunSummary {
  return {
    runId,
    taskId: randomUUID(),
    status: "running",
    purpose: "Read the page",
    title: "Read the page",
    updatedAt: "2026-09-02T00:00:00.000Z",
    turns: 0,
    notes: "",
    context: { tokens: null, compactAt: 100_000, window: 200_000, compactions: 0, steps: 0, totalSteps: 0, usage: { inputTokens: 0, outputTokens: 0 } },
    humanTabId: null,
    agentTabId: null,
    startedAt: "2026-09-02T00:00:00.000Z",
    completedAt: null,
    control: "agent",
    executor: { kind: "cloud", deviceId: "dev", workerId: "w" },
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

describe("run event writer", () => {
  it("emits run.created first, seals every content event, and the sealed events open with the space keys", async () => {
    const keys = await testSpaceKeys("work");
    const runId = randomUUID();
    const batches: RunEventInput[][] = [];
    const writer = new RunEventWriter({
      runId,
      spaceId: "work",
      sealKey: keys.sealKey,
      append: async (events) => {
        batches.push(events);
      },
      now: () => new Date("2026-09-02T00:00:00.000Z"),
      flushDelayMs: 1,
    });
    writer.emit({ t: "run.created", run: summary(runId) });
    writer.emit({ t: "status", status: "running", completedAt: null });
    const callbacks = writer.callbacks();
    const toolId = callbacks.toolStarted({ name: "page.inspect", tabId: "cloud:1" }, "Read page", "Inspecting visible content");
    callbacks.toolCompleted(toolId, { summary: "Inspected Secret Title", data: { title: "Secret Title", text: "secret body" } });
    callbacks.stepFinished({ usage: { inputTokens: 100, outputTokens: 10 }, contextTokens: 5_000 });
    callbacks.stepFinished({ usage: { inputTokens: 250, outputTokens: 30 }, contextTokens: 6_000 });
    callbacks.questionAsked({ id: "q1", prompt: "Which size?", description: "Pick one", choices: [] });
    callbacks.takeoverRequested({ id: "t1", reason: "Login needed", instructions: "Sign in", resumeLabel: "Done" });
    callbacks.compacted({ before: 9_000, after: 3_000, summary: "compacted summary" });
    await writer.flush();

    const events = batches.flat();
    expect(events[0]?.event.t).toBe("run.created");
    expect(events.map((event) => event.event.t)).toEqual([
      "run.created",
      "status",
      "tool.started",
      "sealed",
      "tool.completed",
      "sealed",
      "step",
      "step",
      "sealed",
      "question.asked",
      "sealed",
      "takeover.requested",
      "compacted",
    ]);
    // Nothing content-class is visible on the wire.
    const wire = JSON.stringify(events);
    for (const secret of ["Secret Title", "secret body", "Inspecting visible", "Which size", "Login needed", "compacted summary"]) {
      expect(wire).not.toContain(secret);
    }
    // Every sealed event opens with the space keys and is bound to (runId, eventId).
    const opened: RunContentEvent[] = [];
    for (const event of events) {
      if (event.event.t !== "sealed") continue;
      expect(event.event.spaceId).toBe("work");
      opened.push(await openRunEvent(keys.sealKey, runId, event));
      await expect(openRunEvent(keys.sealKey, randomUUID(), event)).rejects.toThrow();
      await expect(openRunEvent(keys.sealKey, runId, { ...event, eventId: randomUUID() })).rejects.toThrow();
      await expect(openRunEvent((await testSpaceKeys("work", 0x99)).sealKey, runId, event)).rejects.toThrow();
    }
    expect(opened.map((event) => event.t)).toEqual(["tool.detail", "tool.detail", "question", "takeover"]);
    expect(opened[1]).toMatchObject({ t: "tool.detail", toolId, summary: "Inspected Secret Title", data: { title: "Secret Title" } });
    // Step usage is reported as per-step deltas of the runner's cumulative numbers.
    const steps = events.filter((event) => event.event.t === "step").map((event) => event.event);
    expect(steps).toEqual([
      { t: "step", usage: { inputTokens: 100, outputTokens: 10 }, contextTokens: 5_000 },
      { t: "step", usage: { inputTokens: 150, outputTokens: 20 }, contextTokens: 6_000 },
    ]);
    // The desktop's fold reconstructs the run from the opened stream.
    let run: RunSummary | null = null;
    for (const event of events) {
      const plain: RunControlEvent | RunContentEvent =
        event.event.t === "sealed" ? await openRunEvent(keys.sealKey, runId, event) : event.event;
      run = foldRunEvent(run, plain, event.at);
    }
    expect(run?.toolCalls).toHaveLength(1);
    expect(run?.toolCalls[0]).toMatchObject({ id: toolId, name: "page.inspect", status: "completed", tabId: "cloud:1", detail: "Inspected Secret Title" });
    expect(run?.context.usage).toEqual({ inputTokens: 250, outputTokens: 30 });
    expect(run?.pendingQuestion?.id).toBe("q1");
    expect(run?.pendingTakeover?.id).toBe("t1");
    expect(run?.context.compactions).toBe(1);
  });

  it("appends sequential flushes as separate ordered batches", async () => {
    const keys = await testSpaceKeys("work");
    const runId = randomUUID();
    const batches: RunEventInput[][] = [];
    const writer = new RunEventWriter({
      runId,
      spaceId: "work",
      sealKey: keys.sealKey,
      append: async (events) => {
        batches.push(events);
      },
      flushDelayMs: 1,
    });
    for (let turn = 1; turn <= 3; turn += 1) {
      writer.emit({ t: "turn", turns: turn });
      writer.emitContent({ t: "message", message: { id: `m${String(turn)}`, at: "2026-09-02T00:00:00.000Z", role: "user", content: "hi" } });
      await writer.flush();
      await writer.flush();
    }
    expect(batches.map((batch) => batch.map((event) => event.event.t))).toEqual([
      ["turn", "sealed"],
      ["turn", "sealed"],
      ["turn", "sealed"],
    ]);
    // A flush requested while one is in flight lands afterwards, in order.
    writer.emit({ t: "turn", turns: 4 });
    const first = writer.flush();
    writer.emit({ t: "turn", turns: 5 });
    const second = writer.flush();
    await Promise.all([first, second]);
    expect(batches.slice(3).flat().map((event) => event.event)).toEqual([
      { t: "turn", turns: 4 },
      { t: "turn", turns: 5 },
    ]);
    expect(writer.pending).toBe(0);
  });

  it("hands trailing events to take() in order and records append failures", async () => {
    const keys = await testSpaceKeys("work");
    const runId = randomUUID();
    let fail = false;
    const batches: RunEventInput[][] = [];
    const writer = new RunEventWriter({
      runId,
      spaceId: "work",
      sealKey: keys.sealKey,
      append: async (events) => {
        if (fail) throw new Error("lease lost");
        batches.push(events);
      },
      flushDelayMs: 1,
    });
    writer.emitContent({ t: "message", message: { id: "m1", at: "2026-09-02T00:00:00.000Z", role: "user", content: "hi" } });
    writer.emit({ t: "status", status: "completed", completedAt: "2026-09-02T00:00:01.000Z" });
    const trailing = await writer.take();
    expect(trailing.map((event) => event.event.t)).toEqual(["sealed", "status"]);
    expect(batches).toEqual([]);
    expect(writer.pending).toBe(0);
    fail = true;
    writer.emit({ t: "done", ok: true });
    await expect(writer.flush()).rejects.toThrow("lease lost");
    expect(writer.lastError).toBeInstanceOf(Error);
  });

  it("seals the thread under the run's AAD, strips media, and caps its size", async () => {
    const keys = await testSpaceKeys("work");
    const runId = randomUUID();
    const messages = stripMedia([
      { role: "user", content: [{ type: "text", text: "look" }, { type: "file", data: "data:image/png;base64,AAAA", mediaType: "image/png" }] },
      { role: "assistant", content: "ok" },
    ]);
    expect(messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "look" }] });
    const sealed = await sealThread(keys.sealKey, runId, { version: 1, messages, notes: "n" });
    expect(await openThread(keys.sealKey, runId, sealed)).toEqual({ version: 1, messages, notes: "n" });
    await expect(openThread(keys.sealKey, randomUUID(), sealed)).rejects.toThrow();
    const big = { version: 1, messages: [{ role: "user" as const, content: "first" }, ...Array.from({ length: 40 }, () => ({ role: "assistant" as const, content: "x".repeat(100_000) }))], notes: "" };
    const capped = capThread(big);
    expect(Buffer.byteLength(JSON.stringify(capped))).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(capped.messages[0]).toEqual({ role: "user", content: "first" });
    // A tool call and the results answering it leave together: the resumed
    // thread must never open with orphaned tool results.
    const call = { role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: "c1", toolName: "read", input: {} }, { type: "text" as const, text: "x".repeat(700_000) }] };
    const result = { role: "tool" as const, content: [{ type: "tool-result" as const, toolCallId: "c1", toolName: "read", output: { type: "text" as const, value: "y".repeat(700_000) } }] };
    const paired = capThread({ version: 1, messages: [{ role: "user" as const, content: "first" }, call, result, { ...call }, { ...result }, { role: "assistant" as const, content: "done" }], notes: "" });
    expect(paired.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(titleFor("\n  Buy the blue one, size medium, from the usual shop, and confirm the delivery date please\n")).toHaveLength(60);
  });
});
