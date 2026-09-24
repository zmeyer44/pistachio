/**
 * How a run reads.
 *
 * The wording, grouping and tones every surface that shows a run is built
 * from: what the agent is doing right now, which turn a tool call belongs
 * under, what the status dot means, how far into its context the thread is.
 * Pure functions over `RunSummary` — no React, no store, no platform.
 *
 * It lives in its own package because the desktop console and the web run
 * page are the same conversation seen from two devices, and a thread that
 * says "Working in your browser…" on the Mac must not say something else in
 * the browser. Presentation that reads the run belongs here; presentation
 * that reads the *device* (the desktop's chasing ring, the web's missing
 * key) stays with the app that owns it.
 */

import { integrationOfToolName, isTerminalStatus, type AgentSubagent, type AgentToolCall, type AgentToolOutput, type RunContext, type RunSummary, type ThreadListItem } from "@pistachio/protocol";

/* ------------------------------ what the run does ------------------------ */

/**
 * The surfaces a run's tools act on. The chat's wording follows what the
 * agent is actually doing — a reminder set from the composer never touched
 * a page, so it must not be called "browser activity".
 */
/**
 * `note` is the person's own notes (docs/notes.md); `notes` is the agent's
 * per-run scratchpad. Two families, because "Planning" and "Writing" are not
 * the same thing to watch.
 */
export type ToolFamily = "browser" | "memory" | "reminder" | "bookmark" | "watchtower" | "note" | "notes" | "integration";

export function toolFamily(name: AgentToolCall["name"]): ToolFamily {
  if (name.startsWith("memory.")) return "memory";
  if (name.startsWith("reminder.")) return "reminder";
  if (name.startsWith("watchtower.")) return "watchtower";
  if (name.startsWith("bookmark.")) return "bookmark";
  // `note.` before `notes.`, and neither prefix matches the other's calls.
  if (name.startsWith("note.")) return "note";
  if (name.startsWith("notes.")) return "notes";
  // A dedicated integration's call reaches the service's API, not a page.
  if (integrationOfToolName(name) !== null) return "integration";
  return "browser";
}

/** The families a run has used so far, in order of first use. */
export function runFamilies(run: Pick<RunSummary, "toolCalls">): ToolFamily[] {
  const seen: ToolFamily[] = [];
  for (const tool of run.toolCalls) {
    const family = toolFamily(tool.name);
    if (!seen.includes(family)) seen.push(family);
  }
  return seen;
}

/**
 * What the agent is doing right now: the family of a running tool, else of
 * the most recent one, else nothing — a turn that has not called a tool
 * yet is thinking, not browsing.
 */
export function currentFamily(run: Pick<RunSummary, "toolCalls">): ToolFamily | null {
  const running = [...run.toolCalls].reverse().find((tool) => tool.status === "running");
  const latest = running ?? run.toolCalls.at(-1);
  return latest === undefined ? null : toolFamily(latest.name);
}

const FAMILY_NOUN: Record<ToolFamily, string> = { browser: "browser", memory: "memory", reminder: "reminders", bookmark: "bookmarks", watchtower: "saved pages", note: "notes", notes: "its own notes", integration: "connected apps" };
const FAMILY_ACTION: Record<ToolFamily, string> = { browser: "browser action", memory: "memory update", reminder: "reminder change", bookmark: "bookmark change", watchtower: "archive lookup", note: "note change", notes: "notes update", integration: "connected-app call" };

function list(families: ToolFamily[]): string {
  const nouns = families.map((family) => FAMILY_NOUN[family]);
  if (nouns.length <= 1) return nouns[0] ?? "";
  if (nouns.length === 2) return `${nouns[0]!} and ${nouns[1]!}`;
  return `${nouns.slice(0, -1).join(", ")}, and ${nouns.at(-1)!}`;
}

/** The divider over the thread: what this conversation has been about. */
export function runHeadline(run: Pick<RunSummary, "toolCalls" | "status">): string {
  const families = runFamilies(run);
  if (families.length === 0) return isTerminalStatus(run.status) ? "Conversation" : "Working";
  if (families.length === 1) {
    switch (families[0]!) {
      case "browser": return "Working in this browser";
      case "memory": return "Updating memory";
      case "reminder": return "Scheduling reminders";
      case "watchtower": return "Searching saved pages";
      case "bookmark": return "Working with bookmarks";
      case "note": return "Writing";
      case "notes": return "Planning";
      case "integration": return "Working in your connected apps";
    }
  }
  return `Working with ${list(families)}`;
}

/** The tool trace's summary line: what is running, or what ran. */
export function traceLabel(run: Pick<RunSummary, "toolCalls">): string {
  const running = run.toolCalls.filter((tool) => tool.status === "running");
  if (running.length > 0) {
    const families = runFamilies({ toolCalls: running });
    const noun = families.length === 1 ? FAMILY_ACTION[families[0]!] : "action";
    return `${String(running.length)} ${noun}${running.length === 1 ? "" : "s"} running`;
  }
  const families = runFamilies(run);
  if (families.length === 1) {
    switch (families[0]!) {
      case "browser": return "Browser activity";
      case "memory": return "Memory activity";
      case "reminder": return "Reminder activity";
      case "watchtower": return "Searching saved pages";
      case "bookmark": return "Bookmark activity";
      case "note": return "Note activity";
      case "notes": return "Notes activity";
      case "integration": return "Connected-app activity";
    }
  }
  return "Activity";
}

/** The line under the last message while the agent works. */
export function workingText(run: Pick<RunSummary, "toolCalls">): string {
  switch (currentFamily(run)) {
    case "browser": return "Working in your browser…";
    case "memory": return "Updating what I remember…";
    case "reminder": return "Scheduling…";
    case "watchtower": return "Searching saved pages…";
    case "bookmark": return "Saving…";
    case "note": return "Writing notes…";
    case "notes": return "Updating notes…";
    case "integration": return "Working in your connected apps…";
    case null: return "Thinking…";
  }
}

/** The composer's escape hatch, named for what it ends. */
export function endTaskLabel(run: Pick<RunSummary, "toolCalls">): string {
  return runFamilies(run).includes("browser") ? "End browser task" : "End task";
}

/** Sentence-case status text: "waiting_for_approval" → "Waiting for approval". */
export function statusLabel(status: RunSummary["status"]): string {
  const words = status.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * What the dot on the console's avatar means. Five tones rather than twelve
 * statuses, because the dot answers one question at a glance — who has the
 * browser, and is anything waiting on me:
 *
 *  - idle      connected and at rest
 *  - working   acting in the page right now
 *  - attention stopped until the person answers
 *  - human     the person holds the page
 *  - stopped   the run ended without finishing
 *
 * The tooltip carries what the tone cannot: that the browser session is
 * connected either way. That reassurance used to be a "Session connected"
 * line above the composer, which spent a whole row saying nothing new.
 */
export type StatusTone = "idle" | "working" | "attention" | "human" | "stopped";

export interface StatusIndicator {
  tone: StatusTone;
  /** The dot's meaning in full, revealed on hover. */
  tooltip: string;
}

/** The dot's tone for a status alone — what the thread list can show without a run. */
export function statusTone(status: RunSummary["status"]): StatusTone {
  switch (status) {
    case "capturing":
    case "ready":
    case "running":
      return "working";
    case "waiting_for_approval":
    case "waiting_for_judgment":
    case "waiting_for_step_up":
      return "attention";
    case "interrupted":
    case "human_control":
      return "human";
    case "completed":
      return "idle";
    case "rejected":
    case "revoked":
    case "failed":
      return "stopped";
  }
}

export function statusIndicator(run: RunSummary | null): StatusIndicator {
  if (run === null) return { tone: "idle", tooltip: "Connected to your browser session" };
  const tone = statusTone(run.status);
  switch (run.status) {
    case "capturing":
    case "ready":
    case "running":
      return {
        tone,
        tooltip: runFamilies(run).includes("browser") || run.toolCalls.length === 0 ? "Working in your browser session" : "Working on your request",
      };
    case "waiting_for_approval":
      return { tone, tooltip: "Paused for your approval" };
    case "waiting_for_judgment":
      return { tone, tooltip: "Paused for your decision" };
    case "waiting_for_step_up":
      return { tone, tooltip: "Paused for you to verify it’s you" };
    case "interrupted":
      return { tone, tooltip: "Interrupted — the page is yours" };
    case "human_control":
      return { tone, tooltip: "You have control of the page" };
    case "completed":
      return { tone, tooltip: "Finished — still connected to your session" };
    case "rejected":
    case "revoked":
      return { tone, tooltip: "Ended — the agent took no further actions" };
    case "failed":
      return { tone, tooltip: "Stopped after a browser error" };
  }
}

/**
 * The agent holds the console: a run exists, the agent (not the person) has
 * control, and it has not paused or ended. Wider than `agentIsDriving` —
 * `ready` and `capturing` count — because this mirrors the check main makes
 * before it will swap or delete the open thread, and the thread list should
 * refuse the same clicks rather than surface main's error afterwards.
 */
export function agentIsActing(run: RunSummary | null): boolean {
  return run !== null && run.control === "agent" && ["capturing", "ready", "running"].includes(run.status);
}

/* ------------------------------ turns ------------------------------------ */

/** One model turn's tool calls, and the message its trace renders under. */
export interface TraceTurn {
  turn: number;
  toolCalls: AgentToolCall[];
  /** Specialists carry no turn; they ride with the latest one. */
  subagents: AgentSubagent[];
  /** Index into `run.messages` of the message the trace follows. */
  anchor: number;
}

function timeOf(value: string): number {
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}

/**
 * Tool calls grouped by the turn that made them, oldest first. A trace sits
 * under the last message written before the turn's first tool started —
 * the person's request, or the "I'm on it" that answers it — so each
 * exchange reads request, work, answer. Calls from before turns were
 * recorded belong to the first turn.
 */
export function traceTurns(run: Pick<RunSummary, "messages" | "toolCalls" | "subagents">): TraceTurn[] {
  const groups = new Map<number, AgentToolCall[]>();
  for (const tool of run.toolCalls) {
    const turn = tool.turn ?? 1;
    const group = groups.get(turn);
    if (group === undefined) groups.set(turn, [tool]);
    else group.push(tool);
  }
  const turns = [...groups.keys()].sort((a, b) => a - b);
  if (turns.length === 0 && run.subagents.length > 0) turns.push(Math.max(1, ...run.messages.map((message) => message.turn ?? 1)));
  const latest = turns.at(-1);
  // Each message's time once, not once per turn: this runs on every run
  // publish, and a long thread has many of both.
  const messageTimes = run.messages.map((message) => timeOf(message.at));
  let floor = 0;
  return turns.map((turn) => {
    const toolCalls = groups.get(turn) ?? [];
    const first = toolCalls[0];
    let anchor: number;
    if (first === undefined) {
      anchor = Math.min(1, run.messages.length - 1);
    } else {
      const startedAt = timeOf(first.startedAt);
      anchor = -1;
      for (let index = 0; index < messageTimes.length; index++) {
        if (messageTimes[index]! <= startedAt) anchor = index;
      }
    }
    // Traces never run backwards past an earlier turn's, whatever the clocks say.
    anchor = Math.max(0, anchor, floor);
    floor = anchor;
    return { turn, toolCalls, subagents: turn === latest ? run.subagents : [], anchor };
  });
}

/* ------------------------------ outputs ---------------------------------- */

/**
 * What a turn's calls left for the person to open, once each, in the order
 * first touched. A note written and then edited in the same turn is one
 * card: it keeps "created" and takes the latest title.
 */
export function turnOutputs(toolCalls: readonly AgentToolCall[]): AgentToolOutput[] {
  const byKey = new Map<string, AgentToolOutput>();
  for (const tool of toolCalls) {
    const output = tool.output;
    if (output === undefined || tool.status !== "completed") continue;
    const key = `${output.kind}:${output.id}`;
    const earlier = byKey.get(key);
    byKey.set(key, earlier?.action === "created" ? { ...output, action: "created" } : output);
  }
  return [...byKey.values()];
}

/**
 * The reply a turn's outputs sit under: the last assistant message written
 * in that turn, or -1 while the turn has not answered yet.
 */
export function turnReplyIndex(messages: RunSummary["messages"], turn: number): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "assistant" && (message.turn ?? 1) === turn) return index;
  }
  return -1;
}

/* ------------------------------ context ---------------------------------- */

/** 48_213 → "48k"; below a thousand the number stands as it is. */
export function formatTokenCount(tokens: number): string {
  return tokens >= 1000 ? `${String(Math.round(tokens / 1000))}k` : String(Math.max(0, Math.round(tokens)));
}

/**
 * The muted meter beside the working line: "step 3 · ~48k tokens · compacted ×1".
 * A turn that has not taken a step yet says nothing about steps — "step 0"
 * at the top of every follow-up read as a counter that had reset.
 */
export function contextMeter(context: RunContext): string {
  const parts = context.steps > 0 ? [`step ${String(context.steps)}`] : [];
  if (context.tokens !== null) parts.push(`~${formatTokenCount(context.tokens)} tokens`);
  if (context.compactions > 0) parts.push(`compacted ×${String(context.compactions)}`);
  return parts.join(" · ");
}

/* ------------------------------ threads ---------------------------------- */

/** The saved conversations newest first, whatever order main handed them over in. */
export function sortThreads(threads: ThreadListItem[]): ThreadListItem[] {
  return [...threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/* ------------------------------ time ------------------------------------- */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5m ago", "2h ago", "3d ago", then a short date. */
export function relativeTime(value: string, now: number = Date.now()): string {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return "";
  const elapsed = now - time;
  if (elapsed < 45_000) return "just now";
  if (elapsed < HOUR) return `${String(Math.round(elapsed / MINUTE))}m ago`;
  if (elapsed < DAY) return `${String(Math.round(elapsed / HOUR))}h ago`;
  if (elapsed < 7 * DAY) return `${String(Math.round(elapsed / DAY))}d ago`;
  return SHORT_DATE.format(new Date(time));
}

const SHORT_DATE = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/* ------------------------------ chat text -------------------------------- */

export { linkify, type TextPart } from "./linkify.js";
