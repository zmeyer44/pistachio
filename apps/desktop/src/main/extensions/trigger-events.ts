/**
 * Events for extensions' triggers (docs/primitives.md §3.7): the things that
 * **happen** — a tab opened, a page of a site arrived, a download finished —
 * as against the things that hold, which the clock asks (./trigger-runner).
 *
 * What happened cannot be asked again, so the rule is the plain one: an
 * event is **told once, soon, or never**. Told while Pistachio is up with a
 * window, the extension may run and nothing has it paused; what happens
 * otherwise is missed, and nothing makes up for it later. A handler that
 * fails was told: the failure is logged, and the event is not said again.
 *
 * Told **together**: events are gathered for a moment before the worker is
 * woken, a trigger's handler is run at most once in a few seconds, and what
 * piles up meanwhile is handed over in the next run — the newest twenty, so a
 * hundred tabs opened at once are one start of the worker, not a hundred.
 *
 * Here, apart from the service, so it can be tested without Electron.
 */

import type { ExtTriggerEvent, ExtTriggerState } from "@pistachio/extension-api";
import type { TriggerSubject, TriggerTimers } from "./trigger-runner";

/** How many events one run of a handler is handed: the newest. */
export const EVENTS_MAX = 20;
/** How long events are gathered before the worker is woken. */
export const EVENT_GATHER_MS = 300;
/** The least time between two runs of one trigger's handler. */
export const EVENT_SPACING_MS = 3_000;

export interface TriggerEventsOptions {
  /** The extensions whose triggers may be delivered now (the clock's own subjects): an event for any other is missed. */
  subjects(): TriggerSubject[];
  /** Wake the worker with the events and wait for its handler; rejects when it failed or timed out. */
  deliver(extensionId: string, state: ExtTriggerState): Promise<void>;
  store: { readonly pausedAll: boolean; paused(extensionId: string): boolean; setDelivered(extensionId: string, trigger: string, answer: string, at: number): void };
  now?: () => number;
  timers?: TriggerTimers;
  gatherMs?: number;
  spacingMs?: number;
  /** A handler was run: what the page says of the trigger (last heard) has changed. */
  changed?(): void;
  log?(extensionId: string, level: "info" | "warn", message: string): void;
}

/**
 * The downloads that have just finished: complete now, and not complete when last told. `previous` null is the first
 * telling — what had finished by then happened before anyone was listening, and is no event.
 */
export function newlyFinished(previous: ReadonlyMap<string, string> | null, downloads: readonly { id: string; state: string }[]): string[] {
  if (previous === null) return [];
  return downloads.filter((download) => download.state === "completed" && previous.get(download.id) !== "completed").map((download) => download.id);
}

/** What `setDelivered` records for an event trigger: that it was told, and when. Never compared — an event has no answer. */
export const ANSWER_EVENT = "event";

interface Waiting {
  extensionId: string;
  trigger: string;
  events: ExtTriggerEvent[];
  timer: unknown;
  running: boolean;
}

export class TriggerEvents {
  readonly #options: TriggerEventsOptions;
  readonly #now: () => number;
  readonly #timers: TriggerTimers;
  readonly #gatherMs: number;
  readonly #spacingMs: number;
  readonly #waiting = new Map<string, Waiting>();
  /** When each trigger's handler last started, by the same key: kept after its queue has emptied, so the next burst still keeps its distance. */
  readonly #ranAt = new Map<string, number>();
  #stopped = false;

  constructor(options: TriggerEventsOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#timers = options.timers ?? { setTimeout: (callback, ms) => setTimeout(callback, ms).unref(), clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout) };
    this.#gatherMs = options.gatherMs ?? EVENT_GATHER_MS;
    this.#spacingMs = options.spacingMs ?? EVENT_SPACING_MS;
  }

  /**
   * Something happened that `trigger` of `extensionId` names. Kept for its handler's next run — unless nothing of
   * the extension may run by itself now (off, paused, no window, the trigger no longer declared): then it is missed.
   */
  note(extensionId: string, trigger: string, event: ExtTriggerEvent): void {
    if (this.#stopped || !this.#mayHear(extensionId, trigger)) return;
    const key = `${extensionId}\n${trigger}`;
    let waiting = this.#waiting.get(key);
    if (waiting === undefined) {
      waiting = { extensionId, trigger, events: [], timer: null, running: false };
      this.#waiting.set(key, waiting);
    }
    waiting.events.push(event);
    if (waiting.events.length > EVENTS_MAX) waiting.events.splice(0, waiting.events.length - EVENTS_MAX);
    this.#arm(waiting);
  }

  /** What an extension's triggers were waiting to be told is dropped: it was turned off, paused, changed or removed. */
  forget(extensionId: string): void {
    for (const key of [...this.#ranAt.keys()]) if (key.startsWith(`${extensionId}\n`)) this.#ranAt.delete(key);
    for (const [key, waiting] of this.#waiting) {
      if (waiting.extensionId !== extensionId) continue;
      if (waiting.timer !== null) this.#timers.clearTimeout(waiting.timer);
      waiting.timer = null;
      waiting.events = [];
      if (!waiting.running) this.#waiting.delete(key);
    }
  }

  /** Everything was paused: what any extension's triggers were waiting to be told goes with the pause, as one's does with its own. */
  forgetAll(): void {
    for (const extensionId of new Set([...this.#waiting.values()].map((waiting) => waiting.extensionId))) this.forget(extensionId);
    this.#ranAt.clear();
  }

  stop(): void {
    this.#stopped = true;
    for (const waiting of this.#waiting.values()) if (waiting.timer !== null) this.#timers.clearTimeout(waiting.timer);
    this.#waiting.clear();
    this.#ranAt.clear();
  }

  #mayHear(extensionId: string, trigger: string): boolean {
    const { store } = this.#options;
    if (store.pausedAll || store.paused(extensionId)) return false;
    const subject = this.#options.subjects().find((candidate) => candidate.id === extensionId);
    return subject !== undefined && subject.triggers.some((candidate) => candidate.id === trigger && "on" in candidate);
  }

  #arm(waiting: Waiting): void {
    if (waiting.running || waiting.timer !== null || waiting.events.length === 0) return;
    const ranAt = this.#ranAt.get(`${waiting.extensionId}\n${waiting.trigger}`) ?? Number.NEGATIVE_INFINITY;
    const delay = Math.max(this.#gatherMs, ranAt + this.#spacingMs - this.#now());
    waiting.timer = this.#timers.setTimeout(() => {
      waiting.timer = null;
      void this.#run(waiting);
    }, delay);
  }

  async #run(waiting: Waiting): Promise<void> {
    const key = `${waiting.extensionId}\n${waiting.trigger}`;
    // (Paused, turned off or the window closed while they were gathered: missed, as any that happen now are.)
    if (this.#stopped || waiting.events.length === 0 || !this.#mayHear(waiting.extensionId, waiting.trigger)) {
      waiting.events = [];
      this.#waiting.delete(key);
      return;
    }
    const events = waiting.events;
    waiting.events = [];
    waiting.running = true;
    this.#ranAt.set(key, this.#now());
    let heard = true;
    try {
      await this.#options.deliver(waiting.extensionId, { id: waiting.trigger, kind: "on", events });
    } catch (error) {
      // Told once: a handler that failed is not run again for what it was handed.
      heard = false;
      this.#options.log?.(waiting.extensionId, "warn", `trigger ${waiting.trigger}: ${error instanceof Error ? error.message : String(error)} — an event is not told twice`);
    }
    waiting.running = false;
    if (this.#stopped) return;
    // "Last heard" is a handler that ran and answered, of a trigger still declared by an extension still here: one
    // removed or changed while its handler ran leaves nothing behind in the file.
    if (heard && this.#mayHear(waiting.extensionId, waiting.trigger)) {
      this.#options.store.setDelivered(waiting.extensionId, waiting.trigger, ANSWER_EVENT, this.#now());
      this.#options.changed?.();
    }
    if (waiting.events.length > 0) this.#arm(waiting);
    else this.#waiting.delete(key);
  }
}
