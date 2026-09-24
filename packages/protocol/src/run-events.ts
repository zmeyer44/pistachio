/**
 * The run event contract shared by control, the cloud browser, and the
 * desktop (docs/cloud-sync-design.md §7.8).
 *
 * A hosted run is an append-only stream of events. Control stores every
 * event but reads only the control class: status, tools by id, budgets,
 * commands. Everything a person would recognise — messages, page details,
 * questions, activity, results — is content class and travels sealed under
 * the Space key, so control never sees it. The desktop opens the sealed
 * events it has the key for and folds the whole stream into the same
 * `RunSummary` its own runs use; control folds the control class alone into
 * the `ThreadListItem` the thread list shows.
 *
 * Zero dependencies: this file is imported by every side of the wire.
 */

import type {
  AgentAttachment,
  AgentMessage,
  AgentQuestion,
  AgentTakeover,
  AgentToolCall,
  ApprovalEvidence,
  PendingApproval,
  RunSummary,
  TaskStatus,
  ThreadListItem,
} from "./index.js";
import { toolOutputOf } from "./tool-output.js";

/* ------------------------------- pauses --------------------------------- */

export type PauseKind = "approval" | "judgment" | "step_up";

/**
 * A pause a hosted run persists while it waits on a person: an approval,
 * an answer, or a step-up. Lives here rather than in the runtime package
 * because it rides the event stream.
 */
export interface DurablePause {
  id: string;
  kind: PauseKind;
  requestedAt: string;
  expiresAt: string;
  capability: string | null;
  payload: Record<string, unknown>;
}

/* ------------------------------- entries -------------------------------- */

/** One row of a run's activity feed, as `RunSummary.activity` holds it. */
export type RunActivityEntry = RunSummary["activity"][number];

/**
 * The shape of an evidence-chain entry a run event can carry. Structural
 * and minimal, so this package stays free of the evidence package; the
 * desktop's `EvidenceEntry` satisfies it.
 */
export interface EvidenceEntryLike {
  id: string;
  at: string;
  type: string;
  payload: Record<string, unknown>;
}

/* -------------------------------- events -------------------------------- */

/** Control-class events: what control may read and act on. */
export type RunControlEvent =
  | { t: "run.created"; run: RunSummary /* control-class fields only */ }
  | { t: "status"; status: TaskStatus; completedAt: string | null }
  | { t: "title"; title: string }
  | {
      t: "tool.started";
      toolId: string;
      name: AgentToolCall["name"];
      label: string;
      tabId: string | null;
    }
  | { t: "tool.completed"; toolId: string }
  | { t: "tool.failed"; toolId: string }
  | { t: "step"; usage: { inputTokens: number; outputTokens: number }; contextTokens: number }
  | { t: "compacted"; before: number; after: number }
  | { t: "turn"; turns: number }
  /**
   * Who holds the wheel. `generation` is the browser session's control
   * generation the transition produced (web-browser-design.md §4.3, W7);
   * absent on a run with no session and on rows written before sessions
   * existed, so a reader treats it as "no generation fencing here".
   */
  | { t: "control"; control: "agent" | "human"; generation?: number }
  /** The encrypted hosted thread snapshot changed; readers re-fetch it. */
  | { t: "thread.updated" }
  | { t: "pause"; pause: DurablePause }
  | { t: "resume" }
  | { t: "question.asked"; questionId: string }
  | { t: "takeover.requested"; takeoverId: string }
  /** The only plaintext user-facing text (channel replies). */
  | { t: "reply"; text: string }
  | { t: "done"; ok: boolean }
  | { t: "cmd.message"; text: string; attachments: AgentAttachment[] }
  | { t: "cmd.answer"; questionId: string; value: string }
  /** Opaque notice that a one-time encrypted credential payload is ready. */
  | { t: "cmd.credentials"; captureId: string }
  | { t: "cmd.interrupt" }
  | { t: "cmd.release" }
  | { t: "cmd.revoke" };

/** Content-class events: sealed before they reach control, opened only by a device holding the Space key. */
export type RunContentEvent =
  | { t: "message"; message: AgentMessage }
  | { t: "tool.detail"; toolId: string; detail: string; summary: string; data?: unknown }
  | { t: "question"; question: AgentQuestion }
  | { t: "takeover"; takeover: AgentTakeover }
  | { t: "activity"; entry: RunActivityEntry }
  | { t: "result"; result: RunSummary["result"] }
  | { t: "evidence"; entry: EvidenceEntryLike };

export const RUN_CONTENT_EVENT_KINDS = [
  "message",
  "tool.detail",
  "question",
  "takeover",
  "activity",
  "result",
  "evidence",
] as const satisfies readonly RunContentEvent["t"][];

/** A content event as stored: `sealed` is base64 of `seal(sealKey, utf8(JSON.stringify(plain)), runEventSealAad(runId, eventId))`. */
export interface SealedRunEvent {
  t: "sealed";
  spaceId: string;
  sealed: string;
  /**
   * Plaintext hint naming the sealed event's kind so control can select
   * conversation rows without opening them. Absent on rows written before
   * the hint existed; never carries content.
   */
  kind?: RunContentEvent["t"];
}

/** What crosses the wire and lands in `run_events`. */
export type RunEvent = RunControlEvent | SealedRunEvent;

export interface RunEventInput {
  /** Client-generated; the append is idempotent on `(runId, eventId)`. */
  eventId: string;
  at: string;
  event: RunEvent;
}

export interface StoredRunEvent extends RunEventInput {
  /** Allocated by control in the append transaction; the stream order. */
  seq: number;
}

/* --------------------------------- folds -------------------------------- */

/** Statuses a run never leaves on its own; a sponsor message can reopen one. */
export const TERMINAL_STATUSES: readonly TaskStatus[] = ["completed", "rejected", "revoked", "failed"];

export function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

const isTerminal = isTerminalStatus;

/**
 * Longest `RunEventInput.eventId` any service accepts. Control mints sponsor
 * command ids as `${t}:${runId}:${idempotencyKey}:${index}` with client keys
 * of up to 128 characters, so the cap sits well above that.
 */
export const MAX_RUN_EVENT_ID_CHARACTERS = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The approval evidence a pause payload carries, with anything missing filled in so the console can render it. */
function approvalEvidence(payload: Record<string, unknown>): ApprovalEvidence {
  const str = (key: string): string => (typeof payload[key] === "string" ? payload[key] : "");
  const dataLeaving = payload["dataLeaving"];
  return {
    action: str("action"),
    resource: str("resource"),
    summary: str("summary"),
    before: isRecord(payload["before"]) ? payload["before"] : {},
    after: isRecord(payload["after"]) ? payload["after"] : {},
    dataLeaving: Array.isArray(dataLeaving) ? dataLeaving.filter((item): item is string => typeof item === "string") : [],
    reversible: payload["reversible"] === true,
  };
}

/** Replace the entry with `id`, or append it. Never mutates `items`. */
function upsertById<T extends { id: string }>(items: T[], entry: T): T[] {
  const index = items.findIndex((item) => item.id === entry.id);
  if (index === -1) return [...items, entry];
  const next = [...items];
  next[index] = entry;
  return next;
}

function updateTool(run: RunSummary, toolId: string, patch: Partial<AgentToolCall>): RunSummary {
  const index = run.toolCalls.findIndex((tool) => tool.id === toolId);
  if (index === -1) return run;
  const toolCalls = [...run.toolCalls];
  toolCalls[index] = { ...toolCalls[index]!, ...patch };
  return { ...run, toolCalls };
}

/**
 * Fold one event into the run as the console shows it. Pure: the given run
 * is never mutated, and untouched arrays are shared with the result, so a
 * store can fold a long stream without copying the thread on every event.
 *
 * The first event of a stream is `run.created`; folding anything else into
 * a null run is a caller error (a stream read from the wrong `since`).
 */
export function foldRunEvent(
  run: RunSummary | null,
  event: RunControlEvent | RunContentEvent,
  at: string,
): RunSummary {
  if (event.t === "run.created") {
    return { ...structuredClone(event.run), updatedAt: at };
  }
  if (run === null) throw new Error(`run event ${event.t} before run.created`);
  const next = foldInto({ ...run }, event, at);
  return next.updatedAt === at ? next : { ...next, updatedAt: at };
}

function foldInto(
  run: RunSummary,
  event: Exclude<RunControlEvent | RunContentEvent, { t: "run.created" }>,
  at: string,
): RunSummary {
  switch (event.t) {
    case "status": {
      const status = event.status;
      const ended = isTerminal(status);
      return {
        ...run,
        status,
        completedAt: event.completedAt,
        ...(ended ? { pendingApproval: null, pendingQuestion: null, pendingTakeover: null } : {}),
      };
    }
    case "title":
      return { ...run, title: event.title };
    case "tool.started": {
      const tool: AgentToolCall = {
        id: event.toolId,
        name: event.name,
        label: event.label,
        detail: "",
        status: "running",
        startedAt: at,
        completedAt: null,
        tabId: event.tabId,
        turn: run.turns,
      };
      return { ...run, toolCalls: upsertById(run.toolCalls, tool) };
    }
    case "tool.completed":
      return updateTool(run, event.toolId, { status: "completed", completedAt: at });
    case "tool.failed":
      return updateTool(run, event.toolId, { status: "failed", completedAt: at });
    case "step": {
      const context = run.context;
      return {
        ...run,
        context: {
          ...context,
          tokens: event.contextTokens,
          steps: context.steps + 1,
          totalSteps: context.totalSteps + 1,
          usage: {
            inputTokens: context.usage.inputTokens + event.usage.inputTokens,
            outputTokens: context.usage.outputTokens + event.usage.outputTokens,
          },
        },
      };
    }
    case "compacted":
      return {
        ...run,
        context: { ...run.context, tokens: event.after, compactions: run.context.compactions + 1 },
      };
    case "turn":
      // A new model turn: the per-turn step count starts over.
      return { ...run, turns: event.turns, context: { ...run.context, steps: 0 } };
    case "control":
      return { ...run, control: event.control };
    case "thread.updated":
      return run;
    case "pause": {
      if (event.pause.kind !== "approval") return run;
      const pendingApproval: PendingApproval = {
        id: event.pause.id,
        runId: run.runId,
        requestedAt: event.pause.requestedAt,
        expiresAt: event.pause.expiresAt,
        evidence: approvalEvidence(event.pause.payload),
      };
      return { ...run, pendingApproval };
    }
    case "resume":
      return { ...run, pendingApproval: null, pendingQuestion: null, pendingTakeover: null };
    case "question.asked":
    case "takeover.requested":
    case "reply":
    case "done":
    case "cmd.answer":
    case "cmd.credentials":
    case "cmd.interrupt":
    case "cmd.release":
    case "cmd.revoke":
    case "evidence":
      // Bookkeeping the summary has no field for, or a command whose effect
      // arrives as the runner's own events (status, control, resume).
      return run;
    case "cmd.message": {
      const turns = run.turns + 1;
      const message: AgentMessage = {
        id: `cmd.message:${String(turns)}`,
        at,
        role: "user",
        content: event.text,
        turn: turns,
        ...(event.attachments.length > 0 ? { attachments: structuredClone(event.attachments) } : {}),
      };
      return { ...run, turns, messages: [...run.messages, message], result: null };
    }
    case "message":
      return { ...run, messages: upsertById(run.messages, structuredClone(event.message)) };
    case "tool.detail": {
      const name = run.toolCalls.find((tool) => tool.id === event.toolId)?.name;
      const output = name === undefined ? null : toolOutputOf(name, event.data);
      return updateTool(run, event.toolId, {
        detail: event.summary === "" ? event.detail : event.summary,
        ...(output === null ? {} : { output }),
      });
    }
    case "question":
      return { ...run, pendingQuestion: structuredClone(event.question) };
    case "takeover":
      return { ...run, pendingTakeover: structuredClone(event.takeover) };
    case "activity":
      return { ...run, activity: upsertById(run.activity, structuredClone(event.entry)) };
    case "result":
      return { ...run, result: event.result === null ? null : structuredClone(event.result) };
  }
}

/**
 * Fold one event into the thread-list row control keeps for a run. Only
 * control-class events change anything; a sealed event is ignored (control
 * cannot read it), and content events never reach this function. Pure, like
 * `foldRunEvent`.
 */
export function foldControlSummary(
  summary: ThreadListItem | null,
  event: RunEvent,
  at: string,
): ThreadListItem {
  if (event.t === "run.created") {
    const run = event.run;
    return {
      runId: run.runId,
      title: run.title,
      status: run.status,
      startedAt: run.startedAt,
      updatedAt: at,
      turns: run.turns,
      messageCount: run.messages.length,
      ...(run.origin === undefined ? {} : { origin: structuredClone(run.origin) }),
      ...(run.executor === undefined ? {} : { executor: structuredClone(run.executor) }),
    };
  }
  if (summary === null) throw new Error(`run event ${event.t} before run.created`);
  if (event.t === "sealed") return summary;
  switch (event.t) {
    case "status":
      return { ...summary, status: event.status, updatedAt: at };
    case "title":
      return { ...summary, title: event.title, updatedAt: at };
    case "turn":
      return { ...summary, turns: event.turns, updatedAt: at };
    case "cmd.message":
      return { ...summary, turns: summary.turns + 1, messageCount: summary.messageCount + 1, updatedAt: at };
    case "reply":
      // The one message control can see; the sealed ones it counts by
      // proxy through cmd.message.
      return { ...summary, messageCount: summary.messageCount + 1, updatedAt: at };
    default:
      return summary.updatedAt === at ? summary : { ...summary, updatedAt: at };
  }
}
