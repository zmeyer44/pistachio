/**
 * The clock for extensions' triggers (docs/primitives.md §3). Level, not
 * edge: nothing fires AT a time. Every look — at launch, on wake, on unlock,
 * when an extension is approved, turned on or let run again, and at most
 * thirty seconds apart — asks each declared trigger what the clock says now
 * (./triggers triggerState) and hands the worker that answer **when it is
 * not the one it last heard** (./automation). So a Mac asleep across Sunday
 * morning wakes to one delivery, not none and not three; a restart delivers
 * nothing twice; and a pause lifted catches up by itself.
 *
 * Heard means the handler answered without failing. One that failed — the
 * space was in front, the window was closed, the code threw — is tried again
 * later, a minute on and then less often, until it answers or the clock's
 * answer has changed anyway.
 *
 * An instant (`at`) is never delivered for the past of an extension: what
 * came due before it was first seen is where it starts from. An interval
 * (`every`) starts the same way each time it begins to run — at first sight,
 * and when what its `while` names comes to hold: the mark then current is
 * where it starts, and the next is the first it hears.
 *
 * A signal (`when`) main cannot read is not known, which is no answer: it is
 * neither delivered nor forgotten, and what the worker last heard stands.
 *
 * An event (`on`) is not the clock's at all: what happened is handed to its
 * handler as it happens (./trigger-events), and never asked again here.
 *
 * Here, apart from the service, so it can be tested without Electron.
 */

import type { ExtTriggerState } from "@pistachio/extension-api";
import { triggerKey, type TriggerDecl } from "@pistachio/extension-api/triggers";
import { EXT_ATTENDED_KINDS, type ExtInvokeKind } from "@pistachio/extension-api/wire";
import type { AutomationStore } from "./automation";
import { NO_READINGS, type SignalReadings } from "./signals";
import { ANSWER_NONE, ANSWER_UNKNOWN, readTrigger, triggerLookAt, triggerState, type TriggerWorld } from "./triggers";

/** An extension whose triggers may run now: approved, on, loaded, a window to act in. */
export interface TriggerSubject {
  id: string;
  triggers: readonly TriggerDecl[];
}

export interface TriggerTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface TriggerRunnerOptions {
  subjects(): TriggerSubject[];
  /** Wake the worker with the state and wait for its handler; rejects when it failed or timed out. */
  deliver(extensionId: string, state: ExtTriggerState): Promise<void>;
  store: Pick<AutomationStore, "pausedAll" | "paused" | "delivered" | "setDelivered">;
  /** The Mac's zone now (a trigger with none of its own is said in it; it travels with the person). */
  zone(): string;
  /** What main reads of the signals now, for one extension (./signals; the calendars are its Profiles'): asked once a look for each. Left out, no signal is known. */
  readings?(extensionId: string): SignalReadings;
  now?: () => number;
  timers?: TriggerTimers;
  /** The longest sleep between looks. */
  tickMs?: number;
  /** A trigger was heard: what the page says of it (on now, next) has changed. */
  changed?(): void;
  /**
   * A signal's handler has acted on the person's spaces or tabs again and again in a short while (RUNAWAY_COUNT runs
   * that each did something written down, in RUNAWAY_WINDOW_MS): most likely what it does is changing what it is
   * told — it sends away the space whose tab its signal counts — and it would go on for as long as it is let. The
   * service pauses the extension and says what it did.
   */
  runaway?(extensionId: string, triggerId: string): void;
  /**
   * How many things written down the extension has done so far with nobody there (a space sent away, brought back
   * or closed, a tab opened, a theme set): read before and after a handler, to tell a run that acted from one that
   * only looked or told the person something. Left out, no run counts toward a runaway.
   */
  acted?(extensionId: string): number;
  /** The clock the runaway is measured by: the Mac's own, whatever the triggers' says. */
  pace?: () => number;
  log?(extensionId: string, level: "info" | "warn", message: string): void;
}

/** The longest the clock sleeps between looks: a timer set across a night's sleep is not one to trust. */
export const TRIGGER_TICK_MS = 30_000;
/** How many times one signal's handler may act on the person's spaces or tabs within RUNAWAY_WINDOW_MS before it is taken for a loop. */
export const RUNAWAY_COUNT = 8;
export const RUNAWAY_WINDOW_MS = 2 * 60_000;
/** How long after a failed delivery the next is tried: the first a minute on, the fifth and later half an hour. */
export const TRIGGER_RETRY_MS = [60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000] as const;

/**
 * Whether a worker is stopped once no trigger's handler is in hand any more: woken code does not stay
 * (docs/primitives.md §3.3). It is stopped when a trigger started it (`wokenAt`: when) and nothing of the person's
 * has run since. Something of theirs keeps it: a handler of theirs begun since, a page or the panel open, a hold
 * (`keptUp`), a handler of theirs still running (`busy`). A worker the person started is never stopped here — a
 * trigger neither lengthens its life (it does not count as use: WorkerHost.start's `quiet`) nor cuts it short.
 */
export function stopsWhenSettled(worker: { wokenAt: number | null; attendedAt: number; busy: boolean; keptUp: boolean }): boolean {
  if (worker.wokenAt === null || worker.busy || worker.keptUp) return false;
  return worker.attendedAt < worker.wokenAt;
}

/**
 * Whether an invocation is the person's hand on the extension — what makes a worker a trigger woke theirs from then
 * on (`attendedAt`). Their command, menu item, key, click, the agent's turn they asked for (EXT_ATTENDED_KINDS);
 * and a message that follows their press in one of the extension's own views (`afterViewPress`: within the scope's
 * five seconds), since that is how a press in its page reaches the worker. A message by itself is the extension
 * talking to itself — an open page writing to its worker on a timer is nobody — and a trigger never is.
 */
export function attendedInvocation(kind: ExtInvokeKind, afterViewPress: boolean): boolean {
  return EXT_ATTENDED_KINDS.includes(kind) || (kind === "message" && afterViewPress);
}

/**
 * Whether an invocation main has stopped waiting for is still in hand: a trigger's handler that timed out. It has not
 * answered — it is still running in the worker — and what it goes on to call is still a trigger's, with nobody
 * there. Let go of at the timeout, it would call on as nobody's: in a worker the person had started, freely. It is
 * in hand until its answer comes or the worker stops. Nobody else's handler is kept: theirs timed out is theirs
 * done with.
 */
export function staysInHand(kind: ExtInvokeKind, failed: string | null): boolean {
  return kind === "trigger" && failed === "TIMEOUT";
}

/**
 * Whether a worker that is not stopped then is still the trigger's — what it calls from here on asked as with nobody
 * there (ScopeDeps.woken): a trigger started it, nothing of the person's has run in it since, and it is only kept up
 * (a page of the extension's open, a hold). A timer its handler set is still that handler's doing; a page being
 * open is not the person's hand on the worker. It is theirs once they run something of it — or, for five seconds,
 * press something in that page (the scope's own rule).
 */
export function staysWoken(worker: { wokenAt: number | null; attendedAt: number; busy: boolean; keptUp: boolean }): boolean {
  return worker.wokenAt !== null && worker.attendedAt < worker.wokenAt && (worker.busy || worker.keptUp);
}

interface Failure {
  answer: string;
  count: number;
  retryAt: number;
}

export class TriggerRunner {
  readonly #options: TriggerRunnerOptions;
  readonly #now: () => number;
  readonly #timers: TriggerTimers;
  readonly #tickMs: number;
  /** Deliveries that failed, by `<extension>\n<trigger>`: tried again at `retryAt` while the answer is still that one. */
  readonly #failures = new Map<string, Failure>();
  /** The clock's answer for each trigger at the last look: a change is news to the page (on now, next), heard or not. */
  readonly #seen = new Map<string, string>();
  /** When each signal's handler lately ran and did something written down, by the same key (the Mac's clock): RUNAWAY_COUNT inside the window is a loop. */
  readonly #ran = new Map<string, number[]>();
  readonly #pace: () => number;
  #queue: Promise<unknown> = Promise.resolve();
  #timer: unknown = null;
  #started = false;

  constructor(options: TriggerRunnerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#timers = options.timers ?? { setTimeout: (callback, ms) => setTimeout(callback, ms).unref(), clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout) };
    this.#tickMs = options.tickMs ?? TRIGGER_TICK_MS;
    this.#pace = options.pace ?? Date.now;
  }

  start(): Promise<void> {
    this.#started = true;
    return this.tick();
  }

  stop(): void {
    this.#started = false;
    if (this.#timer !== null) this.#timers.clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** A trigger's failed deliveries are forgotten: its extension changed, was let run again, or is gone — the next look tries afresh. */
  forgive(extensionId: string): void {
    for (const key of [...this.#failures.keys()]) if (key.startsWith(`${extensionId}\n`)) this.#failures.delete(key);
    for (const key of [...this.#ran.keys()]) if (key.startsWith(`${extensionId}\n`)) this.#ran.delete(key);
  }

  /** Every trigger's failed deliveries are forgotten: everything was paused, or let run again — as one extension's are with its own pause. */
  forgiveAll(): void {
    this.#failures.clear();
    this.#ran.clear();
  }

  /** Look at the clock: every trigger whose answer is not the one last heard is delivered, one at a time. */
  tick(): Promise<void> {
    const next = this.#queue.then(
      () => this.#look(),
      () => this.#look(),
    );
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #look(): Promise<void> {
    if (!this.#started) return;
    const { store } = this.#options;
    const subjects = this.#options.subjects();
    const worlds = new Map(subjects.map((subject) => [subject.id, { triggers: subject.triggers, readings: this.#readings(subject) }]));
    let moved = false;
    for (const subject of subjects) {
      for (const trigger of subject.triggers) {
        const key = `${subject.id}\n${trigger.id}`;
        const { answer } = readTrigger(trigger, this.#now(), this.#options.zone(), worlds.get(subject.id));
        if (this.#seen.has(key) && this.#seen.get(key) !== answer) moved = true;
        this.#seen.set(key, answer);
      }
    }
    if (moved) this.#options.changed?.();
    if (!store.pausedAll) {
      for (const subject of subjects) {
        if (store.paused(subject.id)) continue;
        // (The readings are this look's: a handler that ran long does not make the next trigger read a later Mac.)
        for (const trigger of subject.triggers) {
          // (Paused meanwhile — by the person, or as a runaway a moment ago: the rest of its triggers wait too.)
          if (store.pausedAll || store.paused(subject.id)) break;
          // (Changed meanwhile — an earlier handler ran while its folder was saved, or it was turned off: a trigger
          // no longer declared, or declared otherwise, is not run as it was. The next look reads what is there.)
          if (!this.#stillDeclared(subject.id, trigger)) continue;
          await this.#consider(subject.id, trigger, worlds.get(subject.id) ?? {});
        }
      }
    }
    this.#arm();
  }

  /** Whether `trigger` is still one the extension may run by itself, as it was read at the start of this look. */
  #stillDeclared(extensionId: string, trigger: TriggerDecl): boolean {
    const now = this.#options.subjects().find((subject) => subject.id === extensionId)?.triggers.find((candidate) => candidate.id === trigger.id);
    return now !== undefined && triggerKey(now) === triggerKey(trigger);
  }

  /** A subject's readings; the Mac is asked nothing for one that declares no signal. */
  #readings(subject: TriggerSubject): SignalReadings {
    if (!subject.triggers.some((trigger) => "when" in trigger)) return NO_READINGS;
    try {
      return this.#options.readings?.(subject.id) ?? NO_READINGS;
    } catch {
      return NO_READINGS;
    }
  }

  async #consider(extensionId: string, trigger: TriggerDecl, world: TriggerWorld): Promise<void> {
    if ("on" in trigger) return;
    const { store } = this.#options;
    const now = this.#now();
    const { state, answer } = readTrigger(trigger, now, this.#options.zone(), world);
    const key = `${extensionId}\n${trigger.id}`;
    const heard = store.delivered(extensionId, trigger.id);
    // Not known is no answer: nothing is delivered, and what was last heard stands until main can tell again.
    if (answer === ANSWER_UNKNOWN) return;
    if (state.kind === "at" && heard === null) {
      // First seen: the instants before now are not this extension's to hear.
      store.setDelivered(extensionId, trigger.id, answer, now, triggerKey(trigger));
      return;
    }
    if (state.kind === "every") {
      // An interval that is not running (what its `while` names does not hold) is noted as stopped, and one that
      // starts — first seen, or running again — starts from the mark it is at: the next mark is the first it hears.
      const stopped = heard === null || heard.answer === ANSWER_NONE;
      if (state.at === null ? !stopped || heard === null : stopped) {
        this.#failures.delete(key);
        store.setDelivered(extensionId, trigger.id, answer, now, triggerKey(trigger));
        return;
      }
    }
    if (heard?.answer === answer || (state.kind === "at" && state.at === null)) {
      this.#failures.delete(key);
      return;
    }
    const failure = this.#failures.get(key);
    if (failure !== undefined && failure.answer === answer && now < failure.retryAt) return;
    const before = this.#options.acted?.(extensionId) ?? 0;
    try {
      await this.#options.deliver(extensionId, state);
    } catch (error) {
      const count = failure !== undefined && failure.answer === answer ? failure.count + 1 : 1;
      const wait = TRIGGER_RETRY_MS[Math.min(count, TRIGGER_RETRY_MS.length) - 1] as number;
      this.#failures.set(key, { answer, count, retryAt: this.#now() + wait });
      this.#options.log?.(extensionId, "warn", `trigger ${trigger.id}: ${error instanceof Error ? error.message : String(error)} — tried again in ${String(Math.round(wait / 60_000))} min`);
      // (A handler that acted and then failed acted all the same: it counts, heard or not.)
      this.#ranIfActed(extensionId, trigger, state, before);
      return;
    }
    this.#failures.delete(key);
    store.setDelivered(extensionId, trigger.id, answer, this.#now(), triggerKey(trigger));
    this.#options.changed?.();
    this.#ranIfActed(extensionId, trigger, state, before);
  }

  /**
   * A signal's handler has just run. If it did something written down — to the person's spaces or tabs — the run is
   * counted, and RUNAWAY_COUNT such runs inside the window is taken for a loop: a signal that keeps running a handler
   * that keeps acting is most likely one whose handler keeps changing it. A handler that only looks, shows rows or
   * tells the person something may run as often as its signal changes: the person's own browsing changes a signal
   * too, and that is not the extension's doing. (A window, an instant and an interval are the clock's, and cannot
   * be changed by a handler.)
   */
  #ranIfActed(extensionId: string, trigger: TriggerDecl, state: ExtTriggerState, before: number): void {
    if (state.kind !== "when" || (this.#options.acted?.(extensionId) ?? 0) <= before) return;
    const key = `${extensionId}\n${trigger.id}`;
    const at = this.#pace();
    const lately = [...(this.#ran.get(key) ?? []), at].filter((ran) => at - ran < RUNAWAY_WINDOW_MS);
    if (lately.length < RUNAWAY_COUNT) {
      this.#ran.set(key, lately);
      return;
    }
    this.#ran.delete(key);
    this.#options.log?.(extensionId, "warn", `trigger ${trigger.id}: its handler changed spaces or tabs ${String(RUNAWAY_COUNT)} times in two minutes; paused`);
    this.#options.runaway?.(extensionId, trigger.id);
  }

  /** Sleep until the next trigger changes or the next retry is due, never longer than a tick; not at all while nothing is declared. */
  #arm(): void {
    if (this.#timer !== null) this.#timers.clearTimeout(this.#timer);
    this.#timer = null;
    if (!this.#started) return;
    const now = this.#now();
    const zone = this.#options.zone();
    const due: number[] = [];
    for (const subject of this.#options.subjects()) {
      const world = { triggers: subject.triggers, readings: this.#readings(subject) };
      for (const trigger of subject.triggers) {
        const next = triggerLookAt(trigger, triggerState(trigger, now, zone, world), now, this.#tickMs, world);
        if (next !== null) due.push(next);
        const failure = this.#failures.get(`${subject.id}\n${trigger.id}`);
        // (A retry already due that this look did not make — its signal is not known just now, everything is paused —
        // is looked at again at the tick, not at once: a past instant here would be a look every quarter second.)
        if (failure !== undefined) due.push(failure.retryAt > now ? failure.retryAt : now + this.#tickMs);
      }
    }
    if (due.length === 0) return;
    const delay = Math.min(this.#tickMs, Math.max(250, Math.min(...due) - now));
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = null;
      void this.tick();
    }, delay);
  }
}
