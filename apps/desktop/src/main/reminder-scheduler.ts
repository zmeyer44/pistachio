/**
 * The clock behind reminders. One timer, armed for the earliest next fire
 * and never for longer than a tick, so a Mac that slept through the
 * instant catches up within a tick of waking; plus explicit `tick()` calls
 * from power-resume and from the run controller when the console frees
 * up, so nothing waits on the interval when there is news.
 *
 * A fire is claimed before it is acted on: the store advances the
 * reminder, an occurrence is opened, and only then does anything happen —
 * a crash mid-fire leaves a record, never a double delivery. What happens
 * depends on the action and on how late the fire is:
 *
 *  - Past the catch-up window (asleep, closed, hung): recorded as MISSED
 *    and shown as such. A cookie timer that fires four hours late is worse
 *    than one that says it was missed.
 *  - A message: DELIVERED at once — the occurrence carries the text, the
 *    executor shows it (console card, desktop notification).
 *  - An agent task: RUNNING as a console run. The console holds one run
 *    at a time, so a task due while another run is live QUEUES and is
 *    retried on every tick until the console is free, or until it has
 *    waited long enough to count as missed. Queued tasks run one at a
 *    time, in the order they came due — and OFF the clock loop: a task
 *    that runs for an hour must not stop a message due in a minute.
 *
 * A restart finds what the last session left: queued tasks go back in
 * the queue, and a task that was running when Pistachio quit is settled
 * as failed — its run is gone and cannot be resumed.
 */

import type { Reminder, ReminderOccurrence } from "@pistachio/shell-contracts/reminders";
import type { ReminderStore } from "./reminder-store";

export interface ScheduledAgentRequest {
  reminderId: string;
  occurrenceId: string;
  title: string;
  prompt: string;
  scheduledFor: string;
  /** Called once the run exists, with its id — the occurrence shows as running. */
  onStarted(runId: string): void;
}

export type ScheduledAgentOutcome =
  /** The console is holding another run; ask again later. */
  | { status: "busy" }
  | { status: "completed"; output: string; runId: string }
  | { status: "failed"; error: string; runId: string | null };

export interface ReminderExecutor {
  /** Start an agent turn and resolve when it ends — or at once with `busy`. */
  runAgent(request: ScheduledAgentRequest): Promise<ScheduledAgentOutcome>;
  /** An occurrence reached a state the person should see: delivered, completed, failed, missed. */
  notify(occurrence: ReminderOccurrence, reminder: Reminder | null): Promise<void>;
}

export interface ReminderSchedulerOptions {
  now?: () => Date;
  /** Settings → Reminders. Off: nothing fires, nothing is marked missed. */
  enabled?: () => boolean;
  /** The longest the timer sleeps between looks. */
  tickMs?: number;
  /** A fire later than this is missed rather than late. */
  catchUpMs?: number;
  /** A queued agent task older than this is missed rather than run. */
  queueLimitMs?: number;
  /** Test seam: something other than the real timers. */
  timers?: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };
  onError?: (error: unknown) => void;
}

const DEFAULT_TICK_MS = 30_000;
const DEFAULT_CATCH_UP_MS = 15 * 60_000;
const DEFAULT_QUEUE_LIMIT_MS = 3 * 60 * 60_000;

interface Queued {
  reminder: Reminder;
  occurrence: ReminderOccurrence;
}

export class ReminderScheduler {
  readonly #store: ReminderStore;
  readonly #executor: ReminderExecutor;
  readonly #now: () => Date;
  readonly #enabled: () => boolean;
  readonly #tickMs: number;
  readonly #catchUpMs: number;
  readonly #queueLimitMs: number;
  readonly #timers: NonNullable<ReminderSchedulerOptions["timers"]>;
  readonly #onError: (error: unknown) => void;
  readonly #queue: Queued[] = [];
  #timer: unknown = null;
  #running = false;
  #ticking: Promise<void> | null = null;
  #again = false;
  #agentBusy = false;

  constructor(store: ReminderStore, executor: ReminderExecutor, options: ReminderSchedulerOptions = {}) {
    this.#store = store;
    this.#executor = executor;
    this.#now = options.now ?? (() => new Date());
    this.#enabled = options.enabled ?? (() => true);
    this.#tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    this.#catchUpMs = options.catchUpMs ?? DEFAULT_CATCH_UP_MS;
    this.#queueLimitMs = options.queueLimitMs ?? DEFAULT_QUEUE_LIMIT_MS;
    this.#timers = options.timers ?? {
      set: (callback, ms) => {
        const handle = setTimeout(callback, ms);
        handle.unref();
        return handle;
      },
      clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
    };
    this.#onError = options.onError ?? (() => undefined);
  }

  /**
   * Begin watching the clock: pick up what the last session left, then
   * look at once. Resolves after that first look.
   */
  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    this.#store.onChange(() => this.#arm());
    await this.#recover();
    await this.tick();
  }

  /** What a previous session left in flight. */
  async #recover(): Promise<void> {
    const left = this.#store
      .occurrences()
      .filter((occurrence) => occurrence.status === "queued" || occurrence.status === "running")
      .sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor));
    for (const occurrence of left) {
      try {
        const reminder = this.#store.get(occurrence.reminderId);
        if (occurrence.status === "queued" && reminder !== null && reminder.status !== "cancelled") {
          this.#queue.push({ reminder, occurrence });
          continue;
        }
        const settled = this.#store.updateOccurrence(occurrence.id, {
          status: occurrence.status === "running" ? "failed" : "missed",
          finishedAt: this.#now().toISOString(),
          error:
            occurrence.status === "running"
              ? "Pistachio quit while this was running"
              : "The reminder was cancelled before it could run",
        });
        await this.#safely(() => this.#executor.notify(settled, reminder));
      } catch (error: unknown) {
        this.#onError(error);
      }
    }
  }

  stop(): void {
    this.#running = false;
    if (this.#timer !== null) {
      this.#timers.clear(this.#timer);
      this.#timer = null;
    }
  }

  /** How many agent tasks are waiting for the console. */
  queued(): number {
    return this.#queue.length;
  }

  /**
   * Look at the clock now. Safe to call from anywhere, any time: one look
   * runs at a time, and a call during a look schedules one more after it.
   */
  tick(): Promise<void> {
    if (this.#ticking !== null) {
      this.#again = true;
      return this.#ticking;
    }
    this.#ticking = this.#run().finally(() => {
      this.#ticking = null;
      if (this.#again) {
        this.#again = false;
        void this.tick();
      } else {
        this.#arm();
      }
    });
    return this.#ticking;
  }

  async #run(): Promise<void> {
    if (!this.#enabled()) return;
    try {
      const now = this.#now();
      for (const reminder of this.#store.due(now)) {
        const scheduledFor = this.#store.advance(reminder.id, now);
        if (scheduledFor === null) continue;
        const late = now.getTime() - Date.parse(scheduledFor);
        if (late > this.#catchUpMs) {
          const occurrence = this.#store.openOccurrence({
            reminder,
            scheduledFor,
            status: "missed",
            error: `Due ${describeLate(late)} ago while Pistachio was not running`,
          });
          await this.#safely(() => this.#executor.notify(occurrence, this.#store.get(reminder.id)));
          continue;
        }
        if (reminder.action.kind === "message") {
          const occurrence = this.#store.openOccurrence({ reminder, scheduledFor, status: "delivered", startedAt: now.toISOString() });
          const delivered = this.#store.updateOccurrence(occurrence.id, { output: reminder.action.text, finishedAt: now.toISOString() });
          await this.#safely(() => this.#executor.notify(delivered, this.#store.get(reminder.id)));
          continue;
        }
        const occurrence = this.#store.openOccurrence({ reminder, scheduledFor, status: "queued" });
        this.#queue.push({ reminder, occurrence });
      }
      await this.#ageQueue();
      this.#drain();
    } catch (error: unknown) {
      this.#onError(error);
    }
  }

  /**
   * Run the next queued agent task if the console can take one. Not
   * awaited by the tick: the run can last as long as the person lets it,
   * and the clock has to keep going underneath. `#agentBusy` keeps it to
   * one at a time; the tick after it settles picks up whatever is next.
   */
  #drain(): void {
    if (this.#agentBusy) return;
    const next = this.#queue[0];
    if (next === undefined) return;
    this.#agentBusy = true;
    void this.#runQueued(next)
      .catch((error: unknown) => this.#onError(error))
      .then((outcome) => {
        this.#agentBusy = false;
        // Busy means the console will say when it is free (onRunEnded)
        // or the next tick will ask; ticking now would ask at once, forever.
        if (outcome !== "busy") void this.tick();
      });
  }

  /** Age out what has waited too long or lost its reminder. */
  async #ageQueue(): Promise<void> {
    const now = this.#now();
    // Age out what has waited too long: a summary meant for 8am is not
    // wanted at noon, and saying so beats running it late.
    for (let index = this.#queue.length - 1; index >= 0; index -= 1) {
      const item = this.#queue[index]!;
      const stillThere = this.#store.get(item.reminder.id);
      const waited = now.getTime() - Date.parse(item.occurrence.scheduledFor);
      if (stillThere !== null && stillThere.status !== "cancelled" && waited <= this.#queueLimitMs) continue;
      this.#queue.splice(index, 1);
      const missed = this.#store.updateOccurrence(item.occurrence.id, {
        status: "missed",
        finishedAt: now.toISOString(),
        error: stillThere === null || stillThere.status === "cancelled" ? "The reminder was cancelled before it could run" : "The agent was busy with another task the whole time",
      });
      await this.#safely(() => this.#executor.notify(missed, stillThere));
    }
  }

  /** One queued task, start to settled. Resolves with how it went. */
  async #runQueued(next: Queued): Promise<"busy" | "settled"> {
    try {
      const outcome = await this.#executor.runAgent({
        reminderId: next.reminder.id,
        occurrenceId: next.occurrence.id,
        title: next.reminder.title,
        prompt: next.reminder.action.kind === "agent" ? next.reminder.action.prompt : "",
        scheduledFor: next.occurrence.scheduledFor,
        onStarted: (runId) => this.#markRunning(next.occurrence.id, runId),
      });
      if (outcome.status === "busy") return "busy";
      this.#dequeue(next);
      const finishedAt = this.#now().toISOString();
      const settled = this.#store.updateOccurrence(
        next.occurrence.id,
        outcome.status === "completed"
          ? { status: "completed", output: outcome.output, runId: outcome.runId, finishedAt }
          : { status: "failed", error: outcome.error, runId: outcome.runId, finishedAt },
      );
      await this.#safely(() => this.#executor.notify(settled, this.#store.get(next.reminder.id)));
    } catch (error: unknown) {
      this.#dequeue(next);
      const failed = this.#store.updateOccurrence(next.occurrence.id, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        finishedAt: this.#now().toISOString(),
      });
      await this.#safely(() => this.#executor.notify(failed, this.#store.get(next.reminder.id)));
    }
    return "settled";
  }

  #dequeue(item: Queued): void {
    const index = this.#queue.indexOf(item);
    if (index >= 0) this.#queue.splice(index, 1);
  }

  #markRunning(occurrenceId: string, runId: string): void {
    try {
      this.#store.updateOccurrence(occurrenceId, { status: "running", runId, startedAt: this.#now().toISOString() });
    } catch (error: unknown) {
      this.#onError(error);
    }
  }

  #arm(): void {
    if (!this.#running) return;
    if (this.#timer !== null) {
      this.#timers.clear(this.#timer);
      this.#timer = null;
    }
    const next = this.#store.nextFireAt();
    const waitForNext = next === null ? this.#tickMs : Math.max(0, next.getTime() - this.#now().getTime());
    // Queued tasks are retried on every tick; otherwise a quiet store is
    // looked at once a tick in case the clock jumped. While reminders are
    // off an overdue fire is left where it is, so it must not be armed
    // for — that would be a zero-delay loop; the settings change ticks.
    const delay = !this.#enabled() || this.#queue.length > 0 ? this.#tickMs : Math.min(this.#tickMs, waitForNext);
    this.#timer = this.#timers.set(() => {
      this.#timer = null;
      void this.tick();
    }, delay);
  }

  async #safely(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error: unknown) {
      this.#onError(error);
    }
  }
}

function describeLate(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${String(minutes)} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${String(hours)} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `${String(days)} day${days === 1 ? "" : "s"}`;
}
