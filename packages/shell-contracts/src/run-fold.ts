/**
 * Folding a run's event stream into a `RunSummary`
 * (docs/cloud-sync-design.md §7.8, docs/web-browser-design.md §8).
 *
 * Control keeps every hosted run as an append-only stream: control-class
 * events in the clear, content-class events sealed under the Space key. A
 * reader that holds the key opens the sealed ones and folds the whole stream
 * into the same `RunSummary` a local run has; a reader without it folds the
 * control-class rows alone and sees the run's shape but none of its content.
 *
 * That fold is the same arithmetic wherever it happens — the desktop over
 * SSE (`main/cloud/cloud-run-service.ts`), the worker's `ShellHost` over the
 * events its own executor emits — so it lives here, with no transport, no
 * crypto and no platform in it: the caller opens the sealed bytes, this
 * decides what the run now is.
 */

import {
  foldRunEvent,
  type RunContentEvent,
  type RunControlEvent,
  type RunEvent,
  type RunSummary,
  type StoredRunEvent,
} from "@pistachio/protocol";

/** The event types whose payload is sealed: everything the person said or saw. */
export const RUN_CONTENT_EVENT_TYPES: ReadonlySet<string> = new Set([
  "message",
  "tool.detail",
  "question",
  "takeover",
  "activity",
  "result",
  "evidence",
]);

/** The event types control stores and reads in the clear (§7.8). */
export const RUN_CONTROL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "run.created",
  "thread.updated",
  "status",
  "title",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "step",
  "compacted",
  "turn",
  "control",
  "pause",
  "resume",
  "question.asked",
  "takeover.requested",
  "reply",
  "done",
  "cmd.message",
  "cmd.answer",
  "cmd.credentials",
  "cmd.interrupt",
  "cmd.release",
  "cmd.revoke",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A stored event as control frames it, or null for anything else. A control
 * event this build does not know is dropped rather than folded: an unknown
 * `t` cannot be folded safely and must never be mistaken for content.
 */
export function parseStoredRunEvent(value: unknown): StoredRunEvent | null {
  if (!isRecord(value)) return null;
  const { seq, eventId, at, event } = value;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) return null;
  if (typeof eventId !== "string" || eventId === "" || typeof at !== "string") return null;
  if (!isRecord(event) || typeof event["t"] !== "string") return null;
  const t = event["t"];
  if (t === "sealed") {
    if (typeof event["spaceId"] !== "string" || typeof event["sealed"] !== "string") return null;
    return { seq, eventId, at, event: { t: "sealed", spaceId: event["spaceId"], sealed: event["sealed"] } };
  }
  if (!RUN_CONTROL_EVENT_TYPES.has(t)) return null;
  return { seq, eventId, at, event: event as unknown as RunEvent };
}

/** An opened sealed value that is a content event, or null. */
export function parseContentEvent(value: unknown): RunContentEvent | null {
  if (!isRecord(value) || typeof value["t"] !== "string" || !RUN_CONTENT_EVENT_TYPES.has(value["t"])) return null;
  return value as unknown as RunContentEvent;
}

/**
 * Fold one event into the run so far. Answers null when the event cannot
 * start a run — a stream joined after `run.created` has no shape to fold
 * onto, and folding onto nothing would invent one.
 *
 * `run.created` is normalized here rather than by each caller: control's
 * projection names the run by the row it created, and a reader that asked
 * for `runId` must get `runId` back whatever the projection says. A cloud
 * run drives its own tabs, so it never names one of the reader's.
 */
export function foldRunInto(
  run: RunSummary | null,
  runId: string,
  event: RunControlEvent | RunContentEvent,
  at: string,
): RunSummary | null {
  if (run === null && event.t !== "run.created") return null;
  const folded = foldRunEvent(run, event, at);
  if (event.t !== "run.created") return folded;
  return {
    ...folded,
    runId,
    executor: folded.executor ?? { kind: "cloud", deviceId: null, workerId: null },
    humanTabId: null,
  };
}

/**
 * The whole-thread snapshot a desktop executor mirrors (§8.4), opened. A
 * cloud run's `thread` is the runner's own execution checkpoint instead, and
 * carries no `run`: that conversation is rebuilt by replaying its events.
 */
export function desktopThreadRun(value: unknown): RunSummary | null {
  if (!isRecord(value)) return null;
  if (value["version"] !== 2) return null;
  const run = value["run"];
  return isRecord(run) ? (run as unknown as RunSummary) : null;
}

/**
 * `startUrl` is only ever a web address; anything else (a chrome page,
 * nothing) means the runner's own default.
 */
export function webStartUrl(url: string | undefined | null): string | undefined {
  if (typeof url !== "string" || url === "") return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}
