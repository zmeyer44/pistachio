/**
 * Run event stream over `run_events` (docs/cloud-sync-design.md §7.8).
 *
 * `PostgresRunEventSink.append` runs inside the caller's transaction:
 * `UPDATE hosted_runs SET next_seq = next_seq + $n … RETURNING next_seq`
 * allocates the sequence block, `INSERT … ON CONFLICT (run_id, event_id) DO
 * NOTHING` makes retries idempotent, and `hosted_runs.summary` is refolded
 * with `foldControlSummary` over the newly stored events. Control never opens
 * sealed events; content-class plaintext is refused before it is stored.
 *
 * `RunEventBus` is the in-process wake-up for SSE writers and the runner's
 * command long-poll; callers wake it after the transaction commits.
 */

import { EventEmitter } from "node:events";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  MAX_RUN_EVENT_ID_CHARACTERS,
  RUN_CONTENT_EVENT_KINDS,
  TASK_STATUSES,
  TERMINAL_STATUSES as PROTOCOL_TERMINAL_STATUSES,
  foldControlSummary,
  type RunEvent,
  type RunEventInput,
  type RunSummary,
  type StoredRunEvent,
  type ThreadListItem,
} from "@pistachio/protocol";
import type { RunEventAppender, RunEventSink } from "@pistachio/runtime";
import type { Db } from "../db/client.js";
import { hostedRuns, runEvents } from "../db/schema.js";

export const MAX_EVENT_BYTES = 64 * 1024;

/* ------------------------------------------------------------------ *
 * Wire validation
 * ------------------------------------------------------------------ */

const attachmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  mediaType: z.string(),
  url: z.string(),
});

/**
 * D25: a pause payload carries opaque correlators only. The runner sends
 * `{}`, `{questionId}`, `{takeoverId}`, or `{questionId, budget: true}`
 * (`services/cloud-browser/src/runs/executor.ts`); the model-authored text
 * behind those ids reaches control only inside sealed content events. An
 * open record here would let any writer put plaintext prompts back into
 * control's plaintext store, so the shape is closed and anything else is
 * refused (400) rather than stored.
 */
const pausePayloadSchema = z
  .object({
    questionId: z.string().min(1).max(128).optional(),
    takeoverId: z.string().min(1).max(128).optional(),
    budget: z.literal(true).optional(),
  })
  .strict();

export const durablePauseSchema = z.object({
  id: z.string().min(1).max(128),
  kind: z.enum(["approval", "judgment", "step_up"]),
  requestedAt: z.string(),
  expiresAt: z.string(),
  capability: z.string().nullable(),
  payload: pausePayloadSchema,
});

const originSchema = z.union([
  z.object({
    kind: z.literal("reminder"),
    reminderId: z.string(),
    occurrenceId: z.string(),
    title: z.string(),
    scheduledFor: z.string(),
  }),
  z.object({
    kind: z.literal("channel"),
    linkId: z.string(),
    deliveryId: z.string(),
    channelName: z.string(),
  }),
]);

const executorSchema = z.union([
  z.object({ kind: z.literal("desktop") }),
  z.object({
    kind: z.literal("cloud"),
    deviceId: z.string().nullable(),
    workerId: z.string().nullable(),
  }),
]);

const statusSchema = z.enum(TASK_STATUSES);

/**
 * `run.created` carries the control-class projection of a RunSummary. The
 * content-bearing arrays are accepted only when empty so plaintext
 * messages, tool details, activity, or results never land in `run_events`.
 */
const runCreatedSummarySchema = z.object({
  runId: z.string(),
  taskId: z.string(),
  status: statusSchema,
  purpose: z.string(),
  title: z.string(),
  updatedAt: z.string(),
  turns: z.number().int().nonnegative(),
  notes: z.literal(""),
  context: z.object({
    tokens: z.number().nullable(),
    compactAt: z.number(),
    window: z.number(),
    compactions: z.number(),
    steps: z.number(),
    totalSteps: z.number(),
    usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }),
  }),
  humanTabId: z.string().nullable(),
  agentTabId: z.string().nullable(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  control: z.enum(["agent", "human"]),
  origin: originSchema.optional(),
  executor: executorSchema.optional(),
  pendingApproval: z.null(),
  pendingQuestion: z.null(),
  pendingTakeover: z.null(),
  messages: z.array(z.never()),
  toolCalls: z.array(z.never()),
  subagents: z.array(z.never()),
  activity: z.array(z.never()),
  result: z.null(),
});

export const runEventSchema: z.ZodType<RunEvent> = z.discriminatedUnion("t", [
  z.object({ t: z.literal("run.created"), run: runCreatedSummarySchema }),
  z.object({ t: z.literal("status"), status: statusSchema, completedAt: z.string().nullable() }),
  z.object({ t: z.literal("title"), title: z.string().max(1024) }),
  z.object({
    t: z.literal("tool.started"),
    toolId: z.string(),
    name: z.string(),
    label: z.string(),
    tabId: z.string().nullable(),
  }),
  z.object({ t: z.literal("tool.completed"), toolId: z.string() }),
  z.object({ t: z.literal("tool.failed"), toolId: z.string() }),
  z.object({
    t: z.literal("step"),
    usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }),
    contextTokens: z.number(),
  }),
  z.object({ t: z.literal("compacted"), before: z.number(), after: z.number() }),
  z.object({ t: z.literal("turn"), turns: z.number().int().nonnegative() }),
  z.object({ t: z.literal("control"), control: z.enum(["agent", "human"]), generation: z.number().int().nonnegative().optional() }),
  z.object({ t: z.literal("thread.updated") }),
  z.object({ t: z.literal("pause"), pause: durablePauseSchema }),
  z.object({ t: z.literal("resume") }),
  z.object({ t: z.literal("question.asked"), questionId: z.string() }),
  z.object({ t: z.literal("takeover.requested"), takeoverId: z.string() }),
  z.object({ t: z.literal("reply"), text: z.string() }),
  z.object({ t: z.literal("done"), ok: z.boolean() }),
  z.object({ t: z.literal("cmd.message"), text: z.string(), attachments: z.array(attachmentSchema) }),
  z.object({ t: z.literal("cmd.answer"), questionId: z.string(), value: z.string() }),
  z.object({ t: z.literal("cmd.credentials"), captureId: z.string() }),
  z.object({ t: z.literal("cmd.interrupt") }),
  z.object({ t: z.literal("cmd.release") }),
  z.object({ t: z.literal("cmd.revoke") }),
  z.object({ t: z.literal("sealed"), spaceId: z.string(), sealed: z.string(), kind: z.enum(RUN_CONTENT_EVENT_KINDS).optional() }),
]) as unknown as z.ZodType<RunEvent>;

export const runEventInputSchema = z.object({
  eventId: z.string().min(1).max(MAX_RUN_EVENT_ID_CHARACTERS),
  at: z.string().min(1).max(64),
  event: runEventSchema,
});

export type RunEventInputWire = z.infer<typeof runEventInputSchema>;

export function isCommandEvent(event: RunEvent): boolean {
  return event.t.startsWith("cmd.");
}

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(PROTOCOL_TERMINAL_STATUSES);

/** A control-class `RunSummary` for the `run.created` event of a new run. */
export function controlRunSummary(input: {
  runId: string;
  taskId: string;
  intent: string;
  status: RunSummary["status"];
  startedAt: string;
  origin: RunSummary["origin"] | null;
  executor: RunSummary["executor"];
}): RunSummary {
  const title = input.intent.trim().split("\n")[0]?.slice(0, 120) ?? "";
  return {
    runId: input.runId,
    taskId: input.taskId,
    status: input.status,
    purpose: input.intent,
    title: title.length === 0 ? "Cloud run" : title,
    updatedAt: input.startedAt,
    turns: 1,
    notes: "",
    context: {
      tokens: null,
      compactAt: 0,
      window: 0,
      compactions: 0,
      steps: 0,
      totalSteps: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
    },
    humanTabId: null,
    agentTabId: null,
    startedAt: input.startedAt,
    completedAt: null,
    control: "agent",
    ...(input.origin === null ? {} : { origin: input.origin }),
    ...(input.executor === undefined ? {} : { executor: input.executor }),
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

/* ------------------------------------------------------------------ *
 * Bus
 * ------------------------------------------------------------------ */

export class RunEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  /** Wakes subscribers, handing them the appended rows so a contiguous batch needs no re-query. */
  wake(runId: string, stored: StoredRunEvent[] = []): void {
    this.emitter.emit(runId, stored);
  }

  subscribe(runId: string, listener: (stored: StoredRunEvent[]) => void): () => void {
    this.emitter.on(runId, listener);
    return () => this.emitter.off(runId, listener);
  }

  /** Resolves true when woken before `timeoutMs`, false on timeout. */
  wait(runId: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (woken: boolean): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
        resolve(woken);
      };
      const onAbort = (): void => finish(false);
      const unsubscribe = this.subscribe(runId, () => finish(true));
      const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
      timer.unref();
      if (signal?.aborted) finish(false);
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/* ------------------------------------------------------------------ *
 * Sink
 * ------------------------------------------------------------------ */

export interface AppendedBatch {
  runId: string;
  userId: string;
  spaceId: string;
  origin: ThreadListItem["origin"] | null;
  /** Newly stored events (duplicates excluded), in seq order. */
  stored: StoredRunEvent[];
}

export class RunEventError extends Error {
  constructor(
    readonly code: "unknown_run" | "event_too_large" | "not_initialized",
    message = code,
  ) {
    super(message);
  }
}

/**
 * Transactional sink. Construct one per unit of work over the transaction
 * handle; `onAppended` collects what to do after commit (wake the bus,
 * schedule channel replies).
 */
export class PostgresRunEventSink implements RunEventSink {
  constructor(
    private readonly db: Db,
    private readonly onAppended: (batch: AppendedBatch) => void = () => undefined,
  ) {}

  async append(runId: string, events: RunEventInput[], _by: RunEventAppender): Promise<{ seqs: number[] }> {
    if (events.length === 0) return { seqs: [] };
    for (const input of events) {
      if (Buffer.byteLength(JSON.stringify(input.event), "utf8") > MAX_EVENT_BYTES) {
        throw new RunEventError("event_too_large");
      }
    }
    const [run] = await this.db
      .select({
        userId: hostedRuns.userId,
        spaceId: hostedRuns.spaceId,
        origin: hostedRuns.origin,
        summary: hostedRuns.summary,
      })
      .from(hostedRuns)
      .where(eq(hostedRuns.id, runId))
      .for("update");
    if (run === undefined) throw new RunEventError("unknown_run");

    const [allocated] = await this.db
      .update(hostedRuns)
      .set({ nextSeq: sql`${hostedRuns.nextSeq} + ${events.length}` })
      .where(eq(hostedRuns.id, runId))
      .returning({ nextSeq: hostedRuns.nextSeq });
    if (allocated === undefined) throw new RunEventError("unknown_run");
    const firstSeq = allocated.nextSeq - events.length;

    // One multi-row insert with the pre-allocated seqs; duplicates (a
    // retried batch) fall out of the returned set and are looked up once.
    const inserted = await this.db
      .insert(runEvents)
      .values(events.map((input, index) => ({
        runId,
        seq: firstSeq + index,
        eventId: input.eventId,
        at: new Date(input.at),
        event: input.event,
      })))
      .onConflictDoNothing({ target: [runEvents.runId, runEvents.eventId] })
      .returning({ seq: runEvents.seq, eventId: runEvents.eventId });
    const seqByEventId = new Map(inserted.map((row) => [row.eventId, row.seq]));
    const missing = events.filter((input) => !seqByEventId.has(input.eventId)).map((input) => input.eventId);
    if (missing.length > 0) {
      const existing = await this.db
        .select({ seq: runEvents.seq, eventId: runEvents.eventId })
        .from(runEvents)
        .where(and(eq(runEvents.runId, runId), inArray(runEvents.eventId, missing)));
      for (const row of existing) seqByEventId.set(row.eventId, row.seq);
    }
    const seqs: number[] = [];
    const stored: StoredRunEvent[] = [];
    const insertedIds = new Set(inserted.map((row) => row.eventId));
    for (const input of events) {
      const seq = seqByEventId.get(input.eventId) ?? -1;
      seqs.push(seq);
      if (insertedIds.has(input.eventId)) stored.push({ ...input, seq });
    }

    if (stored.length > 0) {
      let summary: ThreadListItem | null = run.summary ?? null;
      for (const event of stored) {
        if (summary === null && event.event.t !== "run.created") continue;
        summary = foldControlSummary(summary, event.event, event.at);
      }
      await this.db.update(hostedRuns).set({ summary }).where(eq(hostedRuns.id, runId));
      this.onAppended({ runId, userId: run.userId, spaceId: run.spaceId, origin: run.origin ?? null, stored });
    }
    return { seqs };
  }
}

/**
 * Events of a run with `seq > since`, in order. `commandsOnly` filters in
 * SQL, before the row limit: the command long-poll must not lose a `cmd.*`
 * behind a page of the run's other events.
 */
export async function listRunEvents(
  db: Db,
  runId: string,
  since = 0,
  options: { commandsOnly?: boolean; limit?: number } = {},
): Promise<StoredRunEvent[]> {
  const filters = [eq(runEvents.runId, runId), gt(runEvents.seq, since)];
  if (options.commandsOnly === true) filters.push(sql`${runEvents.event}->>'t' like 'cmd.%'`);
  const rows = await db
    .select()
    .from(runEvents)
    .where(and(...filters))
    .orderBy(asc(runEvents.seq))
    .limit(options.limit ?? 10_000);
  return rows.map((row) => ({
    seq: row.seq,
    eventId: row.eventId,
    at: row.at.toISOString(),
    event: row.event as RunEvent,
  }));
}
