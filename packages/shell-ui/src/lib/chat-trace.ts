/**
 * How a turn reads as Trace lines (components/ui/trace.tsx) — the desk's
 * answer card draws the agent's reasoning, its steps and what failed that
 * way (components/chat/trace.tsx). Pure: the lines' words and states from
 * the run, so the card only lays them out.
 */

import type { AgentSource, AgentToolCall, RunSummary } from "@pistachio/protocol";
import { traceLabel, type TraceTurn } from "./run";

export type TraceStepState = "running" | "done" | "paused" | "failed";

/** A tool call or a specialist, as one line of a turn's steps. */
export interface TraceStep {
  id: string;
  /** The tool the step called, for its icon; null for a specialist. */
  tool: AgentToolCall["name"] | null;
  /** The line's words, saying so when it failed: the title truncates, so a failure must not hang on colour alone. */
  title: string;
  /** What the step said of itself: its progress, its result, or — failed — the error. */
  detail: string;
  state: TraceStepState;
  /** The page it read, when it read one. */
  source: AgentSource | null;
}

const TOOL_STATE: Record<AgentToolCall["status"], TraceStepState> = {
  running: "running",
  completed: "done",
  paused: "paused",
  failed: "failed",
};

const SUBAGENT_STATE: Record<TraceTurn["subagents"][number]["status"], TraceStepState> = {
  working: "running",
  completed: "done",
  paused: "paused",
  failed: "failed",
};

/**
 * "Failed: Read page", not "Failed to read page": the labels are the
 * runner's and the desk's, imperative ("Open tab") and progressive
 * ("Arranging the desk") both, and only the first takes a "to".
 */
function stepTitle(label: string, state: TraceStepState): string {
  return state === "failed" ? `Failed: ${label}` : label;
}

export function traceSteps(turn: TraceTurn): TraceStep[] {
  return [
    ...turn.toolCalls.map((tool) => ({
      id: tool.id,
      tool: tool.name,
      title: stepTitle(tool.label, TOOL_STATE[tool.status]),
      detail: tool.detail,
      state: TOOL_STATE[tool.status],
      source: tool.source ?? null,
    })),
    ...turn.subagents.map((agent) => ({
      id: agent.id,
      tool: null,
      title: stepTitle(agent.name, SUBAGENT_STATE[agent.status]),
      detail: agent.detail === "" ? agent.task : agent.detail,
      state: SUBAGENT_STATE[agent.status],
      source: null,
    })),
  ];
}

/** The line a turn's steps fold under. */
export interface TraceSummary {
  /** What the line names: the step in hand while the turn works, else what the turn was. */
  title: string;
  /** "3 steps", "3 steps, 1 failed"; "Waiting for you" while a step is held for the person. */
  description: string;
  state: TraceStepState;
}

function lastStep(steps: readonly TraceStep[], state: TraceStepState): TraceStep | undefined {
  for (let index = steps.length - 1; index >= 0; index--) {
    if (steps[index]!.state === state) return steps[index];
  }
  return undefined;
}

/**
 * The turn as one line. `live` is the turn still at work — the run's
 * latest, running, its reply not begun — so the line stays running through
 * the model's thinking between two steps, not only while a step runs. It
 * names the step in hand: the newest call running, over a specialist
 * working in the background through several of them, else the last one
 * taken. A step held for the person (an approval) names that one. Once the
 * turn is over the line is what it was, failed only when nothing it tried
 * worked — a step that failed on the way is the agent's to route around,
 * counted in the description.
 */
export function traceSummary(turn: TraceTurn, steps: readonly TraceStep[], live: boolean): TraceSummary {
  const tools = turn.toolCalls.length;
  const failed = steps.filter((step) => step.state === "failed").length;
  const count = `${String(steps.length)} ${steps.length === 1 ? "step" : "steps"}${failed > 0 ? `, ${String(failed)} failed` : ""}`;
  const paused = lastStep(steps, "paused");
  if (paused !== undefined) return { title: paused.title, description: "Waiting for you", state: "paused" };
  const running = lastStep(steps.slice(0, tools), "running") ?? lastStep(steps.slice(tools), "running");
  if (running !== undefined || live) return { title: (running ?? steps.at(-1))?.title ?? "Working", description: count, state: "running" };
  const allFailed = steps.length > 0 && failed === steps.length;
  return { title: traceLabel(turn), description: count, state: allFailed ? "failed" : "done" };
}

/** "4s", "1m 12s" — how long the model thought; null under a second, which is no time worth naming. */
export function thinkingSpan(ms: number): string | null {
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return null;
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${String(minutes)}m` : `${String(minutes)}m ${String(rest)}s`;
}

/** Why a run stopped, read off the reply that says so. */
export interface RunFailure {
  /** The assistant message that reports it. */
  messageId: string;
  /** What the message says before the error: "I stopped because the read page step failed". */
  title: string;
  /** The error itself, as it was thrown. */
  error: string;
}

/**
 * The failure a failed run ends on, as an error line can draw it: the
 * desktop's controller (run-controller.ts `#failRun`) ends the thread on
 * "I stopped because … failed: <error>" and logs the error as the run's
 * last blocked activity, so the reply is the sentence and the activity the
 * error. A thread that does not end so — a cloud run's, an older one, a
 * reply worded otherwise — is null, and its reply draws as any other.
 */
export function runFailure(run: Pick<RunSummary, "status" | "messages" | "activity">): RunFailure | null {
  if (run.status !== "failed") return null;
  const message = run.messages.at(-1);
  const logged = run.activity.at(-1);
  if (message?.role !== "assistant" || logged?.tone !== "blocked") return null;
  const tail = `: ${logged.detail}`;
  if (logged.detail.trim() === "" || !message.content.endsWith(tail)) return null;
  const title = message.content.slice(0, -tail.length).trim();
  return title === "" ? null : { messageId: message.id, title, error: logged.detail.trim() };
}
