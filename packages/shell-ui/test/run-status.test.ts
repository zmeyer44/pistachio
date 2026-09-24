import { describe, expect, it } from "vitest";
import { TASK_STATUSES, type RunSummary } from "@pistachio/protocol";
import type { AgentToolCall } from "@pistachio/protocol";
import {
  agentIsDriving,
  currentFamily,
  endTaskLabel,
  runFamilies,
  runHeadline,
  statusIndicator,
  statusLabel,
  toolFamily,
  traceLabel,
  workingText,
} from "../src/lib/run";

function runWith(status: RunSummary["status"], control: RunSummary["control"] = "agent"): RunSummary {
  return { status, control, toolCalls: [] } as unknown as RunSummary;
}

function tool(name: AgentToolCall["name"], status: AgentToolCall["status"] = "completed"): AgentToolCall {
  return { id: name, name, label: name, detail: "", status, startedAt: "", completedAt: null, tabId: null };
}

function calls(...tools: AgentToolCall[]): Pick<RunSummary, "toolCalls" | "status"> {
  return { status: "running", toolCalls: tools };
}

describe("what the run is doing", () => {
  it("names the surfaces a run has touched, in order of first use", () => {
    expect(runFamilies(calls())).toEqual([]);
    expect(runFamilies(calls(tool("reminder.create"), tool("tabs.list"), tool("reminder.list")))).toEqual(["reminder", "browser"]);
    expect(currentFamily(calls())).toBeNull();
    expect(currentFamily(calls(tool("tabs.list"), tool("reminder.create")))).toBe("reminder");
    // A running tool wins over a later finished one.
    expect(currentFamily(calls(tool("page.inspect", "running"), tool("memory.add")))).toBe("browser");
  });

  it("words the thread for the task rather than always for the browser", () => {
    expect(runHeadline(calls())).toBe("Working");
    expect(runHeadline({ status: "completed", toolCalls: [] })).toBe("Conversation");
    expect(runHeadline(calls(tool("tabs.list")))).toBe("Working in this browser");
    expect(runHeadline(calls(tool("reminder.create")))).toBe("Scheduling reminders");
    expect(runHeadline(calls(tool("memory.add")))).toBe("Updating memory");
    expect(runHeadline(calls(tool("tabs.list"), tool("reminder.create")))).toBe("Working with browser and reminders");
    expect(runHeadline(calls(tool("tabs.list"), tool("memory.add"), tool("reminder.create")))).toBe("Working with browser, memory, and reminders");
  });

  it("titles the trace and the working line by what is running now", () => {
    expect(traceLabel(calls())).toBe("Activity");
    expect(traceLabel(calls(tool("tabs.list")))).toBe("Browser activity");
    expect(traceLabel(calls(tool("reminder.create")))).toBe("Reminder activity");
    expect(traceLabel(calls(tool("reminder.create", "running")))).toBe("1 reminder change running");
    expect(traceLabel(calls(tool("page.click", "running"), tool("page.type", "running")))).toBe("2 browser actions running");
    expect(traceLabel(calls(tool("page.click", "running"), tool("memory.add", "running")))).toBe("2 actions running");
    expect(workingText(calls())).toBe("Thinking…");
    expect(workingText(calls(tool("tabs.list")))).toBe("Working in your browser…");
    expect(workingText(calls(tool("reminder.list", "running")))).toBe("Scheduling…");
    expect(workingText(calls(tool("memory.search")))).toBe("Updating what I remember…");
    expect(endTaskLabel(calls(tool("reminder.create")))).toBe("End task");
    expect(endTaskLabel(calls(tool("tab.open")))).toBe("End browser task");
    expect(statusIndicator({ ...runWith("running"), toolCalls: [tool("reminder.create")] }).tooltip).toBe("Working on your request");
  });

  it("keeps the person's notes and the agent's scratchpad apart", () => {
    // `note.*` is docs/notes.md; `notes.update` is the run's own working
    // notes. Two prefixes one character apart, so the split is pinned here.
    expect(toolFamily("note.create")).toBe("note");
    expect(toolFamily("notes.update")).toBe("notes");
    expect(runHeadline(calls(tool("note.update")))).toBe("Writing");
    expect(runHeadline(calls(tool("notes.update")))).toBe("Planning");
    expect(traceLabel(calls(tool("note.read")))).toBe("Note activity");
    expect(traceLabel(calls(tool("notes.update")))).toBe("Notes activity");
    expect(workingText(calls(tool("note.update", "running")))).toBe("Writing notes…");
    expect(workingText(calls(tool("notes.update", "running")))).toBe("Updating notes…");
    expect(runHeadline(calls(tool("note.list"), tool("notes.update")))).toBe("Working with notes and its own notes");
  });
});

describe("console status indicator", () => {
  it("reads as connected with no run, and as working once one starts", () => {
    expect(statusIndicator(null)).toEqual({
      tone: "idle",
      tooltip: "Connected to your browser session",
    });
    expect(statusIndicator(runWith("running")).tone).toBe("working");
  });

  it("separates a pause that needs the person from one where they hold the page", () => {
    // The old dot collapsed both into "working" green, so an approval
    // checkpoint looked identical to the agent typing.
    expect(statusIndicator(runWith("waiting_for_approval")).tone).toBe("attention");
    expect(statusIndicator(runWith("waiting_for_judgment")).tone).toBe("attention");
    expect(statusIndicator(runWith("human_control")).tone).toBe("human");
    expect(statusIndicator(runWith("interrupted")).tone).toBe("human");
  });

  it("keeps a finished run calm and marks the ones that ended badly", () => {
    expect(statusIndicator(runWith("completed")).tone).toBe("idle");
    expect(statusIndicator(runWith("failed")).tone).toBe("stopped");
    expect(statusIndicator(runWith("revoked")).tone).toBe("stopped");
  });

  it("gives every status a tone and a non-empty tooltip", () => {
    for (const status of TASK_STATUSES) {
      const indicator = statusIndicator(runWith(status));
      expect(indicator.tooltip.length).toBeGreaterThan(0);
      expect(indicator.tone).toBeTruthy();
    }
  });

  it("still renders the terse label the header shows beside the dot", () => {
    expect(statusLabel("waiting_for_approval")).toBe("Waiting for approval");
  });
});

describe("agent driving the page", () => {
  it("marks only a running, agent-controlled turn", () => {
    expect(agentIsDriving(runWith("running"))).toBe(true);
    expect(agentIsDriving(null)).toBe(false);
    // A run exists but nothing is touching the page yet.
    expect(agentIsDriving(runWith("ready"))).toBe(false);
    expect(agentIsDriving(runWith("capturing"))).toBe(false);
  });

  it("stops the moment the page goes back to the person", () => {
    expect(agentIsDriving(runWith("waiting_for_approval"))).toBe(false);
    expect(agentIsDriving(runWith("interrupted"))).toBe(false);
    expect(agentIsDriving(runWith("human_control"))).toBe(false);
    // Control alone decides it, even when the status still reads running.
    expect(agentIsDriving(runWith("running", "human"))).toBe(false);
  });
});
