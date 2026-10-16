import { describe, expect, it } from "vitest";
import type { AgentSubagent, AgentToolCall, RunSummary } from "@pistachio/protocol";
import { runFailure, thinkingSpan, traceSteps, traceSummary } from "../src/lib/chat-trace";
import type { TraceTurn } from "../src/lib/run";

function tool(id: string, label: string, status: AgentToolCall["status"] = "completed", detail = ""): AgentToolCall {
  return { id, name: "page.inspect", label, detail, status, startedAt: "", completedAt: null, tabId: null };
}

function agent(id: string, name: string, status: AgentSubagent["status"], detail = "", task = ""): AgentSubagent {
  return { id, name, task, detail, status };
}

function turn(toolCalls: AgentToolCall[], subagents: AgentSubagent[] = []): TraceTurn {
  return { turn: 1, toolCalls, subagents, anchor: 0 };
}

function summary(of: TraceTurn, live = false) {
  return traceSummary(of, traceSteps(of), live);
}

describe("a turn's steps as trace lines", () => {
  it("says a failure in the line's words, and keeps the error as its detail", () => {
    const steps = traceSteps(turn([tool("a", "Read page", "completed", "Read 2 headings"), tool("b", "Arranging the desk", "failed", "No window named Atlas")]));
    expect(steps.map((step) => [step.title, step.state, step.detail])).toEqual([
      ["Read page", "done", "Read 2 headings"],
      ["Failed: Arranging the desk", "failed", "No window named Atlas"],
    ]);
  });

  it("puts specialists after the calls, their task standing in for a detail they have not given", () => {
    const steps = traceSteps(turn([tool("a", "Read page")], [agent("s", "Research", "working", "", "Compare the vendors")]));
    expect(steps.map((step) => [step.title, step.tool, step.detail, step.state])).toEqual([
      ["Read page", "page.inspect", "", "done"],
      ["Research", null, "Compare the vendors", "running"],
    ]);
  });

  it("names the step in hand while the turn works, and what the turn was once it is over", () => {
    const working = turn([tool("a", "Read page"), tool("b", "Click page control", "running")]);
    expect(summary(working)).toEqual({ title: "Click page control", description: "2 steps", state: "running" });
    // Between two steps the model thinks: the turn is still at work, its line still the last step taken.
    const between = turn([tool("a", "Read page"), tool("b", "Click page control")]);
    expect(summary(between, true)).toEqual({ title: "Click page control", description: "2 steps", state: "running" });
    expect(summary(between)).toEqual({ title: "Browser activity", description: "2 steps", state: "done" });
    expect(summary(turn([tool("a", "Read page")]))).toMatchObject({ description: "1 step" });
  });

  it("prefers the newest call running over a specialist working through several", () => {
    const of = turn([tool("a", "Read page", "running"), tool("b", "Open tab", "running")], [agent("s", "Research", "working")]);
    expect(summary(of).title).toBe("Open tab");
    expect(summary(turn([tool("a", "Read page")], [agent("s", "Research", "working")])).title).toBe("Research");
  });

  it("waits on the step held for the person", () => {
    expect(summary(turn([tool("a", "Read page"), tool("b", "Submit form", "paused")]), true)).toEqual({ title: "Submit form", description: "Waiting for you", state: "paused" });
  });

  it("fails the turn only when nothing it tried worked, counting the failures on the way", () => {
    expect(summary(turn([tool("a", "Read page"), tool("b", "Open tab", "failed")]))).toEqual({ title: "Browser activity", description: "2 steps, 1 failed", state: "done" });
    expect(summary(turn([tool("a", "Read page", "failed"), tool("b", "Open tab", "failed")]))).toEqual({ title: "Browser activity", description: "2 steps, 2 failed", state: "failed" });
  });
});

describe("how long the model thought", () => {
  it("names seconds and minutes, and nothing under a second", () => {
    expect(thinkingSpan(400)).toBeNull();
    expect(thinkingSpan(4_200)).toBe("4s");
    expect(thinkingSpan(60_000)).toBe("1m");
    expect(thinkingSpan(72_000)).toBe("1m 12s");
  });
});

describe("why a run stopped", () => {
  function failed(content: string, detail: string, status: RunSummary["status"] = "failed"): Pick<RunSummary, "status" | "messages" | "activity"> {
    return {
      status,
      messages: [
        { id: "m1", at: "", role: "user", content: "Pay the invoice" },
        { id: "m2", at: "", role: "assistant", content },
      ],
      activity: [{ id: "a1", at: "", label: "Task failed", detail, tone: "blocked" }],
    };
  }

  it("reads the sentence off the reply and the error off the activity", () => {
    expect(runFailure(failed("I stopped because the read page step failed: Timed out after 60s", "Timed out after 60s"))).toEqual({
      messageId: "m2",
      title: "I stopped because the read page step failed",
      error: "Timed out after 60s",
    });
    // An error of several lines is kept whole, its trailing newline aside.
    expect(runFailure(failed("I stopped because something failed: Error: boom\n    at step (runner.ts:4:2)\n", "Error: boom\n    at step (runner.ts:4:2)\n"))?.error).toBe("Error: boom\n    at step (runner.ts:4:2)");
  });

  it("is nothing for a run that did not fail, or a reply worded otherwise", () => {
    expect(runFailure(failed("I stopped because something failed: boom", "boom", "completed"))).toBeNull();
    expect(runFailure(failed("Something went wrong.", "boom"))).toBeNull();
    expect(runFailure(failed(": boom", "boom"))).toBeNull();
    expect(runFailure({ ...failed("I stopped because something failed: boom", "boom"), activity: [] })).toBeNull();
  });
});
