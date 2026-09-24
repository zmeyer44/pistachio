/**
 * Run events for hosted runs (docs/cloud-sync-design.md §7.8, §8.4). Every
 * agent callback becomes a `RunEventInput`; content-class events are sealed
 * under the Space seal key with an AAD binding the runner-minted event id,
 * so control stores them without being able to read them (D25). Events are
 * batched and appended through `/internal/runs/:id/events` in order.
 */

import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import type { AiAgentRunCallbacks } from "@pistachio/agent-runtime";
import type {
  AgentQuestion,
  AgentTakeover,
  AgentToolRequest,
  BrowserAgentToolResult,
  RunContentEvent,
  RunControlEvent,
  RunEventInput,
  SealedRunEvent,
} from "@pistachio/protocol";
import { fromBase64, fromUtf8, open, runEventSealAad, runThreadSealAad, seal, toBase64, utf8 } from "@pistachio/sync-protocol";
import { errorMessage, silentLogger, type Logger } from "../logger.js";

/** Seal one content event for the wire. */
export async function sealRunEvent(
  sealKey: CryptoKey,
  runId: string,
  spaceId: string,
  eventId: string,
  plain: RunContentEvent,
): Promise<SealedRunEvent> {
  const sealed = await seal(sealKey, utf8(JSON.stringify(plain)), runEventSealAad(runId, eventId));
  return { t: "sealed", spaceId, sealed: toBase64(sealed), kind: plain.t };
}

/** Open a sealed event back into its content (desktop side; tests). Throws for a control event. */
export async function openRunEvent(sealKey: CryptoKey, runId: string, event: RunEventInput): Promise<RunContentEvent> {
  if (event.event.t !== "sealed") throw new Error(`event ${event.event.t} is not sealed`);
  const plain = await open(sealKey, fromBase64(event.event.sealed), runEventSealAad(runId, event.eventId));
  return JSON.parse(fromUtf8(plain)) as RunContentEvent;
}

/** Seal the thread snapshot control keeps for a run. */
export async function sealThread(sealKey: CryptoKey, runId: string, thread: unknown): Promise<string> {
  return toBase64(await seal(sealKey, utf8(JSON.stringify(thread)), runThreadSealAad(runId)));
}

export async function openThread<T = unknown>(sealKey: CryptoKey, runId: string, sealed: string): Promise<T> {
  return JSON.parse(fromUtf8(await open(sealKey, fromBase64(sealed), runThreadSealAad(runId)))) as T;
}

export interface RunEventWriterOptions {
  runId: string;
  spaceId: string;
  sealKey: CryptoKey;
  /** Appends one ordered batch; a rejection is recorded on `lastError` and re-thrown by `flush`. */
  append: (events: RunEventInput[]) => Promise<void>;
  now?: () => Date;
  /** Coalescing delay before an automatic flush. */
  flushDelayMs?: number;
  log?: Logger;
}

export interface CallbackHooks {
  onHistory?: (messages: ModelMessage[]) => void;
  onQuestion?: (question: AgentQuestion) => void;
  onTakeover?: (takeover: AgentTakeover) => void;
}

/** Whether a tool request names a tab. */
function tabIdOf(request: AgentToolRequest): string | null {
  return "tabId" in request && typeof request.tabId === "string" ? request.tabId : null;
}

export class RunEventWriter {
  readonly runId: string;
  readonly spaceId: string;
  readonly #sealKey: CryptoKey;
  readonly #append: (events: RunEventInput[]) => Promise<void>;
  readonly #now: () => Date;
  readonly #flushDelayMs: number;
  readonly #log: Logger;
  #queue: Array<Promise<RunEventInput>> = [];
  #flushing: Promise<void> | null = null;
  #flushTimer: NodeJS.Timeout | null = null;
  #lastError: unknown = null;
  #usageSeen = { inputTokens: 0, outputTokens: 0 };
  #emitted = 0;
  /**
   * A reader in THIS process that wants the events in the clear
   * (web-browser-design.md §8): the worker's own `ShellHost`, folding the run
   * into the console's snapshot as the callbacks land, rather than waiting to
   * read back a stream it would then have to unseal. Set after construction;
   * a throw from it is the mirror's own problem, never the run's.
   */
  mirror: ((at: string, event: RunControlEvent | RunContentEvent) => void) | null = null;

  constructor(options: RunEventWriterOptions) {
    this.runId = options.runId;
    this.spaceId = options.spaceId;
    this.#sealKey = options.sealKey;
    this.#append = options.append;
    this.#now = options.now ?? ((): Date => new Date());
    this.#flushDelayMs = options.flushDelayMs ?? 25;
    this.#log = options.log ?? silentLogger;
  }

  /** The last append failure, if any (a lost lease shows up here). */
  get lastError(): unknown {
    return this.#lastError;
  }

  /** How many events have been emitted so far. */
  get emitted(): number {
    return this.#emitted;
  }

  get pending(): number {
    return this.#queue.length;
  }

  /** Queue a control-class event as is. */
  emit(event: RunControlEvent): RunEventInput {
    const input: RunEventInput = { eventId: randomUUID(), at: this.#now().toISOString(), event };
    this.#enqueue(Promise.resolve(input));
    this.#mirror(input.at, event);
    return input;
  }

  /** Queue a content-class event, sealed under the Space key. */
  emitContent(event: RunContentEvent): void {
    const eventId = randomUUID();
    const at = this.#now().toISOString();
    this.#enqueue(
      sealRunEvent(this.#sealKey, this.runId, this.spaceId, eventId, event).then((sealed) => ({ eventId, at, event: sealed })),
    );
    this.#mirror(at, event);
  }

  #mirror(at: string, event: RunControlEvent | RunContentEvent): void {
    try {
      this.mirror?.(at, event);
    } catch (error) {
      this.#log.warn("a run event mirror threw", { runId: this.runId, error: errorMessage(error) });
    }
  }

  /**
   * Take every queued event without appending (trailing events on
   * pause/complete/fail/interrupt). The queue is claimed synchronously —
   * before waiting for an in-flight flush — so the auto-flush timer cannot
   * ship a terminal `status` ahead of the transition that carries it.
   */
  async take(): Promise<RunEventInput[]> {
    this.#cancelTimer();
    const queued = this.#queue;
    this.#queue = [];
    if (this.#flushing !== null) await this.#flushing.catch(() => undefined);
    return Promise.all(queued);
  }

  /** Append everything queued so far, in order. Rejects (and records) an append failure. */
  flush(): Promise<void> {
    this.#cancelTimer();
    if (this.#flushing !== null) {
      return this.#flushing.then(() => (this.#queue.length > 0 ? this.flush() : undefined));
    }
    if (this.#queue.length === 0) return Promise.resolve();
    const queued = this.#queue;
    this.#queue = [];
    const run = (async (): Promise<void> => {
      const events = await Promise.all(queued);
      try {
        await this.#append(events);
      } catch (error) {
        this.#lastError = error;
        this.#log.warn("run event append failed", { runId: this.runId, count: events.length, error: errorMessage(error) });
        throw error;
      }
    })();
    const tracked: Promise<void> = run.finally(() => {
      if (this.#flushing === tracked) this.#flushing = null;
    });
    this.#flushing = tracked;
    return tracked;
  }

  /** The agent callbacks, mapped onto run events. */
  callbacks(hooks: CallbackHooks = {}): AiAgentRunCallbacks {
    return {
      toolStarted: (request, label, detail) => {
        const toolId = randomUUID();
        this.emit({ t: "tool.started", toolId, name: request.name, label, tabId: tabIdOf(request) });
        this.emitContent({ t: "tool.detail", toolId, detail, summary: "" });
        return toolId;
      },
      toolCompleted: (toolId, result: BrowserAgentToolResult) => {
        this.emit({ t: "tool.completed", toolId });
        this.emitContent({
          t: "tool.detail",
          toolId,
          detail: "",
          summary: result.summary,
          ...(result.data === undefined ? {} : { data: result.data }),
        });
      },
      toolFailed: (toolId, error) => {
        this.emit({ t: "tool.failed", toolId });
        this.emitContent({ t: "tool.detail", toolId, detail: errorMessage(error), summary: "" });
      },
      questionAsked: (question) => {
        this.emitContent({ t: "question", question });
        this.emit({ t: "question.asked", questionId: question.id });
        hooks.onQuestion?.(question);
      },
      takeoverRequested: (takeover) => {
        this.emitContent({ t: "takeover", takeover });
        this.emit({ t: "takeover.requested", takeoverId: takeover.id });
        hooks.onTakeover?.(takeover);
      },
      historyChanged: (messages) => {
        hooks.onHistory?.(messages);
      },
      stepFinished: (step) => {
        // The runner reports cumulative usage; the fold adds per-step deltas.
        const usage = {
          inputTokens: Math.max(0, step.usage.inputTokens - this.#usageSeen.inputTokens),
          outputTokens: Math.max(0, step.usage.outputTokens - this.#usageSeen.outputTokens),
        };
        this.#usageSeen = { ...step.usage };
        this.emit({ t: "step", usage, contextTokens: step.contextTokens ?? 0 });
      },
      compacted: (info) => {
        this.emit({ t: "compacted", before: info.before, after: info.after });
      },
      changed: () => undefined,
    };
  }

  #enqueue(input: Promise<RunEventInput>): void {
    this.#emitted += 1;
    this.#queue.push(input);
    if (this.#flushTimer !== null) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      void this.flush().catch(() => undefined);
    }, this.#flushDelayMs);
    this.#flushTimer.unref();
  }

  #cancelTimer(): void {
    if (this.#flushTimer === null) return;
    clearTimeout(this.#flushTimer);
    this.#flushTimer = null;
  }
}
