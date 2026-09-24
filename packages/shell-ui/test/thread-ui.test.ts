import { describe, expect, it } from "vitest";
import type { AgentMessage, AgentSubagent, AgentToolCall, RunContext, TaskStatus, ThreadListItem } from "@pistachio/protocol";
import { agentIsActing, agentIsDriving, contextMeter, formatTokenCount, relativeTime, sortThreads, statusIndicator, statusTone, traceTurns, turnOutputs, turnReplyIndex } from "../src/lib/run";

const T0 = Date.parse("2026-08-29T10:00:00.000Z");
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();

function message(role: AgentMessage["role"], seconds: number, turn?: number): AgentMessage {
  return { id: `${role}-${String(seconds)}`, at: at(seconds), role, content: role, ...(turn === undefined ? {} : { turn }) };
}

function tool(seconds: number, turn?: number, status: AgentToolCall["status"] = "completed"): AgentToolCall {
  return {
    id: `tool-${String(seconds)}`,
    name: "page.inspect",
    label: "Inspect",
    detail: "",
    status,
    startedAt: at(seconds),
    completedAt: null,
    tabId: null,
    ...(turn === undefined ? {} : { turn }),
  };
}

const specialist: AgentSubagent = { id: "s1", name: "Checker", task: "verify", detail: "", status: "working" };

describe("traceTurns", () => {
  it("groups tool calls by turn and anchors each under the last message before its first call", () => {
    // Turn 1: request, "I'm on it", tools, answer. Turn 2: follow-up, tools, answer.
    const messages = [
      message("user", 0, 1),
      message("assistant", 1, 1),
      message("assistant", 20, 1),
      message("user", 30, 1),
      message("assistant", 50, 2),
    ];
    const toolCalls = [tool(5, 1), tool(10, 1), tool(35, 2), tool(40, 2)];
    const turns = traceTurns({ messages, toolCalls, subagents: [specialist] });
    expect(turns.map((turn) => turn.turn)).toEqual([1, 2]);
    expect(turns[0]!.anchor).toBe(1);
    expect(turns[0]!.toolCalls.map((call) => call.id)).toEqual(["tool-5", "tool-10"]);
    expect(turns[1]!.anchor).toBe(3);
    expect(turns[1]!.toolCalls.map((call) => call.id)).toEqual(["tool-35", "tool-40"]);
    // Specialists carry no turn: they ride with the latest one only.
    expect(turns[0]!.subagents).toEqual([]);
    expect(turns[1]!.subagents).toEqual([specialist]);
  });

  it("puts calls recorded before turns existed into the first turn", () => {
    const messages = [message("user", 0), message("assistant", 1)];
    const turns = traceTurns({ messages, toolCalls: [tool(5), tool(6, 2)], subagents: [] });
    expect(turns.map((turn) => [turn.turn, turn.toolCalls.length])).toEqual([
      [1, 1],
      [2, 1],
    ]);
  });

  it("never anchors a later turn above an earlier one, and clamps to the first message", () => {
    const messages = [message("user", 10), message("assistant", 11)];
    const turns = traceTurns({ messages, toolCalls: [tool(12, 1), tool(3, 2)], subagents: [] });
    expect(turns.map((turn) => turn.anchor)).toEqual([1, 1]);
    const early = traceTurns({ messages, toolCalls: [tool(2, 1)], subagents: [] });
    expect(early[0]!.anchor).toBe(0);
  });

  it("keeps a specialist-only run on one trace under the first reply", () => {
    const messages = [message("user", 0), message("assistant", 1)];
    const turns = traceTurns({ messages, toolCalls: [], subagents: [specialist] });
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ turn: 1, anchor: 1, subagents: [specialist] });
    expect(traceTurns({ messages, toolCalls: [], subagents: [] })).toEqual([]);
  });
});

describe("context meter", () => {
  const context = (patch: Partial<RunContext>): RunContext => ({
    tokens: null,
    compactAt: 150_000,
    window: 200_000,
    compactions: 0,
    steps: 3,
    totalSteps: 3,
    usage: { inputTokens: 0, outputTokens: 0 },
    ...patch,
  });

  it("rounds token counts to thousands", () => {
    expect(formatTokenCount(48_213)).toBe("48k");
    expect(formatTokenCount(1_500)).toBe("2k");
    expect(formatTokenCount(812)).toBe("812");
  });

  it("reads step, tokens when known, and compactions when any", () => {
    expect(contextMeter(context({}))).toBe("step 3");
    expect(contextMeter(context({ tokens: 48_213 }))).toBe("step 3 · ~48k tokens");
    expect(contextMeter(context({ tokens: 120_400, compactions: 2 }))).toBe("step 3 · ~120k tokens · compacted ×2");
    expect(contextMeter(context({ compactions: 1 }))).toBe("step 3 · compacted ×1");
  });

  it("leaves the step out before a turn has taken one", () => {
    // The start of a follow-up turn: tokens carry over, the step counter has not moved.
    expect(contextMeter(context({ steps: 0, tokens: 48_213 }))).toBe("~48k tokens");
    expect(contextMeter(context({ steps: 0, tokens: 48_213, compactions: 1 }))).toBe("~48k tokens · compacted ×1");
    expect(contextMeter(context({ steps: 0, compactions: 1 }))).toBe("compacted ×1");
    expect(contextMeter(context({ steps: 0 }))).toBe("");
  });
});

describe("relativeTime", () => {
  it("speaks in the nearest unit and never in the future", () => {
    expect(relativeTime(at(0), T0 + 10_000)).toBe("just now");
    expect(relativeTime(at(0), T0 - 60_000)).toBe("just now");
    expect(relativeTime(at(0), T0 + 5 * 60_000)).toBe("5m ago");
    expect(relativeTime(at(0), T0 + 2 * 3_600_000)).toBe("2h ago");
    expect(relativeTime(at(0), T0 + 3 * 86_400_000)).toBe("3d ago");
    expect(relativeTime(at(0), T0 + 30 * 86_400_000)).not.toMatch(/ago|just now/);
    expect(relativeTime("not a date")).toBe("");
  });
});

describe("thread list", () => {
  it("maps every status to the same tone the console dot uses", () => {
    const statuses: TaskStatus[] = ["running", "waiting_for_approval", "interrupted", "completed", "failed"];
    for (const status of statuses) {
      const run = { status, control: "agent", toolCalls: [] } as unknown as Parameters<typeof statusIndicator>[0];
      expect(statusTone(status)).toBe(statusIndicator(run).tone);
    }
  });

  it("orders newest first regardless of how main handed them over", () => {
    const item = (runId: string, seconds: number): ThreadListItem => ({
      runId,
      title: runId,
      status: "completed",
      startedAt: at(0),
      updatedAt: at(seconds),
      turns: 1,
      messageCount: 2,
    });
    const threads = [item("b", 10), item("c", 30), item("a", 20)];
    expect(sortThreads(threads).map((thread) => thread.runId)).toEqual(["c", "a", "b"]);
    // The input is left alone.
    expect(threads.map((thread) => thread.runId)).toEqual(["b", "c", "a"]);
  });

  it("is busy exactly when main would refuse to swap the thread", () => {
    const run = (status: TaskStatus, control: "agent" | "human" = "agent") =>
      ({ status, control, toolCalls: [] }) as unknown as Parameters<typeof agentIsActing>[0];
    expect(agentIsActing(null)).toBe(false);
    for (const status of ["capturing", "ready", "running"] as const) {
      expect(agentIsActing(run(status))).toBe(true);
      expect(agentIsActing(run(status, "human"))).toBe(false);
    }
    for (const status of ["waiting_for_approval", "interrupted", "human_control", "completed", "failed"] as const) {
      expect(agentIsActing(run(status))).toBe(false);
    }
    // Driving is the narrower state: only a running agent turn holds the page.
    expect(agentIsDriving(run("ready"))).toBe(false);
    expect(agentIsDriving(run("running"))).toBe(true);
  });
});

describe("turn outputs", () => {
  const note = (id: string, action: "created" | "updated", title: string) => ({ kind: "note" as const, action, id, title });

  it("keeps one card per thing, created wins, the latest title shows", () => {
    const calls: AgentToolCall[] = [
      { ...tool(1, 1), name: "note.create", output: note("n-1", "created", "Draft") },
      { ...tool(2, 1), name: "note.update", output: note("n-1", "updated", "Final") },
      { ...tool(3, 1), name: "note.update", output: note("n-2", "updated", "Other") },
      { ...tool(4, 1, "running"), name: "note.create", output: note("n-3", "created", "Not yet") },
    ];
    expect(turnOutputs(calls)).toEqual([note("n-1", "created", "Final"), note("n-2", "updated", "Other")]);
  });

  it("sits under the last assistant message of the turn, or nowhere yet", () => {
    const messages = [message("user", 0, 1), message("assistant", 1, 1), message("assistant", 20, 1), message("user", 30, 2)];
    expect(turnReplyIndex(messages, 1)).toBe(2);
    expect(turnReplyIndex(messages, 2)).toBe(-1);
  });
});
