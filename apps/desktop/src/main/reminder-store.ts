/**
 * The reminders file: `<userData>/reminders.json`, the single source of
 * truth for what is scheduled and what has fired. Read once at startup,
 * rewritten whole on every change, the way settings.json and memory.json
 * are.
 *
 * The store knows the calendar (@pistachio/shell-contracts/reminders) but not the clock:
 * it computes `nextFireAt` from a schedule and hands out what is due; the
 * scheduler (reminder-scheduler.ts) decides WHEN to ask and what to do
 * with the answer. `advance` moves a reminder past a fire the moment the
 * scheduler claims it, so a slow agent turn or a crash mid-fire can never
 * fire the same instant twice.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  isExhausted,
  isRecurring,
  MAX_REMINDER_ERROR,
  MAX_REMINDER_OCCURRENCES,
  MAX_REMINDER_OUTPUT,
  MAX_REMINDERS,
  nextOccurrence,
  sanitizeReminder,
  sanitizeReminderDocument,
  systemTimezone,
  type Reminder,
  type ReminderDocument,
  type ReminderInput,
  type ReminderOccurrence,
  type ReminderOccurrenceStatus,
  type ReminderPatch,
  type ReminderSnapshot,
  type ReminderSource,
} from "@pistachio/shell-contracts/reminders";

export interface OccurrencePatch {
  status?: ReminderOccurrenceStatus;
  startedAt?: string | null;
  finishedAt?: string | null;
  output?: string | null;
  error?: string | null;
  runId?: string | null;
  acknowledgedAt?: string | null;
}

export class ReminderStore {
  readonly #path: string;
  readonly #listeners = new Set<(snapshot: ReminderSnapshot) => void>();
  /** Per-reminder listeners (workspace sync); never told about a remote write. */
  readonly #recordListeners = new Set<(id: string) => void>();
  readonly #now: () => Date;
  readonly #defaultTimezone: () => string;
  #reminders: Reminder[];
  #occurrences: ReminderOccurrence[];

  constructor(userDataDir: string, options: { now?: () => Date; timezone?: () => string } = {}) {
    this.#path = join(userDataDir, "reminders.json");
    this.#now = options.now ?? (() => new Date());
    this.#defaultTimezone = options.timezone ?? systemTimezone;
    const document = this.#read();
    this.#reminders = document.reminders;
    this.#occurrences = document.occurrences;
    // A file from an older build, or one edited by hand, may hold a next
    // fire that no longer follows from its schedule; recompute what is
    // computable and leave the rest to the scheduler's catch-up.
    let repaired = false;
    for (const reminder of this.#reminders) {
      if (reminder.status !== "active") continue;
      if (reminder.nextFireAt === null && isRecurring(reminder.schedule)) {
        const next = nextOccurrence(reminder.schedule, this.#now(), reminder.timezone);
        if (next !== null && !isExhausted(reminder, next)) {
          reminder.nextFireAt = next.toISOString();
          repaired = true;
        } else {
          reminder.status = "done";
          repaired = true;
        }
      }
    }
    if (repaired) this.#write();
  }

  /* ------------------------------ reading ------------------------------ */

  all(): Reminder[] {
    return structuredClone(this.#reminders);
  }

  get(id: string): Reminder | null {
    const reminder = this.#reminders.find((candidate) => candidate.id === id);
    return reminder === undefined ? null : structuredClone(reminder);
  }

  active(): Reminder[] {
    return structuredClone(this.#reminders.filter((reminder) => reminder.status === "active"));
  }

  occurrences(): ReminderOccurrence[] {
    return structuredClone(this.#occurrences);
  }

  occurrence(id: string): ReminderOccurrence | null {
    const occurrence = this.#occurrences.find((candidate) => candidate.id === id);
    return occurrence === undefined ? null : structuredClone(occurrence);
  }

  snapshot(): ReminderSnapshot {
    return { reminders: this.all(), occurrences: this.occurrences() };
  }

  /** Active reminders whose next fire is at or before `now`, earliest first. */
  due(now: Date = this.#now()): Reminder[] {
    return structuredClone(
      this.#reminders
        .filter((reminder) => reminder.status === "active" && reminder.nextFireAt !== null && Date.parse(reminder.nextFireAt) <= now.getTime())
        .sort((a, b) => Date.parse(a.nextFireAt!) - Date.parse(b.nextFireAt!)),
    );
  }

  /** The earliest next fire among active reminders, or null. */
  nextFireAt(): Date | null {
    let earliest: number | null = null;
    for (const reminder of this.#reminders) {
      if (reminder.status !== "active" || reminder.nextFireAt === null) continue;
      const at = Date.parse(reminder.nextFireAt);
      if (Number.isNaN(at)) continue;
      if (earliest === null || at < earliest) earliest = at;
    }
    return earliest === null ? null : new Date(earliest);
  }

  /* ------------------------------ writing ------------------------------ */

  add(input: ReminderInput, source: ReminderSource): Reminder {
    if (this.#reminders.length >= MAX_REMINDERS) {
      throw new Error(`No more than ${String(MAX_REMINDERS)} reminders can be kept. Delete some first.`);
    }
    const now = this.#now();
    const timezone = input.timezone ?? this.#defaultTimezone();
    const next = nextOccurrence(input.schedule, now, timezone);
    if (next === null) {
      throw new Error(input.schedule.kind === "once" ? "That time has already passed." : "That schedule never fires.");
    }
    const skeleton = { until: input.until ?? null, maxFires: input.maxFires ?? null, fireCount: 0 };
    if (isExhausted(skeleton, next)) throw new Error("That schedule ends before it first fires.");
    const reminder: Reminder = {
      id: randomUUID(),
      title: input.title,
      schedule: structuredClone(input.schedule),
      action: structuredClone(input.action),
      timezone,
      status: "active",
      source,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      nextFireAt: next.toISOString(),
      lastFiredAt: null,
      until: skeleton.until,
      maxFires: skeleton.maxFires,
      fireCount: 0,
    };
    this.#reminders.push(reminder);
    this.#commit(reminder.id);
    return structuredClone(reminder);
  }

  /**
   * Change a reminder. A new schedule (or zone, or window) recomputes the
   * next fire from now; a finished reminder given a new schedule comes
   * back to life, which is what "make it 8am instead" means for a
   * reminder that already went off at 7.
   */
  update(id: string, patch: ReminderPatch, source: ReminderSource): Reminder {
    const index = this.#reminders.findIndex((candidate) => candidate.id === id);
    const current = this.#reminders[index];
    if (current === undefined) throw new Error("reminder not found");
    if (current.status === "cancelled" && patch.status === undefined && patch.schedule === undefined) {
      throw new Error("That reminder was cancelled. Create a new one instead.");
    }
    // Built and checked as a copy: a refused schedule leaves the stored
    // reminder exactly as it was, not with a new title beside an old clock.
    const now = this.#now();
    const next = structuredClone(current);
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.action !== undefined) next.action = structuredClone(patch.action);
    if (patch.until !== undefined) next.until = patch.until;
    if (patch.maxFires !== undefined) next.maxFires = patch.maxFires;
    const rescheduled = patch.schedule !== undefined || patch.timezone !== undefined || patch.until !== undefined || patch.maxFires !== undefined;
    if (patch.schedule !== undefined) {
      next.schedule = structuredClone(patch.schedule);
      next.fireCount = 0;
    }
    if (patch.timezone !== undefined) next.timezone = patch.timezone;
    if (patch.status !== undefined) next.status = patch.status;
    else if (rescheduled && (next.status === "done" || next.status === "cancelled")) next.status = "active";
    if (rescheduled || patch.status === "active") {
      const fire = nextOccurrence(next.schedule, now, next.timezone);
      if (fire === null || isExhausted(next, fire)) {
        if (rescheduled) {
          throw new Error(next.schedule.kind === "once" ? "That time has already passed." : "That schedule never fires.");
        }
        next.status = "done";
        next.nextFireAt = null;
      } else {
        next.nextFireAt = fire.toISOString();
      }
    }
    if (next.status === "paused") next.nextFireAt = null;
    next.source = source;
    next.updatedAt = now.toISOString();
    this.#reminders[index] = next;
    this.#commit(next.id);
    return structuredClone(next);
  }

  cancel(id: string, source: ReminderSource): Reminder {
    const reminder = this.#require(id);
    if (reminder.status !== "cancelled") {
      reminder.status = "cancelled";
      reminder.nextFireAt = null;
      reminder.source = source;
      reminder.updatedAt = this.#now().toISOString();
      this.#commit(reminder.id);
    }
    return structuredClone(reminder);
  }

  /** Delete a reminder and its history outright. */
  remove(id: string): boolean {
    return this.#remove(id, false);
  }

  /**
   * Claim a fire: move the reminder past it. Returns the instant it was
   * due, or null when the reminder is not due — someone else claimed it,
   * or it was paused meanwhile. Recurring reminders continue from `now`
   * rather than from the missed instant, so a laptop shut for a week does
   * not wake to seven mornings of the same reminder.
   */
  advance(id: string, now: Date = this.#now()): string | null {
    const reminder = this.#require(id);
    if (reminder.status !== "active" || reminder.nextFireAt === null) return null;
    const scheduledFor = reminder.nextFireAt;
    if (Date.parse(scheduledFor) > now.getTime()) return null;
    reminder.fireCount += 1;
    reminder.lastFiredAt = now.toISOString();
    const next = isRecurring(reminder.schedule) ? nextOccurrence(reminder.schedule, now, reminder.timezone) : null;
    if (next === null || isExhausted(reminder, next)) {
      reminder.status = "done";
      reminder.nextFireAt = null;
    } else {
      reminder.nextFireAt = next.toISOString();
    }
    reminder.updatedAt = now.toISOString();
    this.#commit(reminder.id);
    return scheduledFor;
  }

  /** Bring the next fire forward to now — "run it now" on the page. */
  fireNow(id: string): Reminder {
    const reminder = this.#require(id);
    if (reminder.status === "cancelled") throw new Error("That reminder was cancelled.");
    reminder.status = "active";
    reminder.nextFireAt = this.#now().toISOString();
    reminder.updatedAt = reminder.nextFireAt;
    this.#commit(reminder.id);
    return structuredClone(reminder);
  }

  openOccurrence(input: {
    reminder: Pick<Reminder, "id" | "title" | "action">;
    scheduledFor: string;
    status: ReminderOccurrenceStatus;
    startedAt?: string | null;
    error?: string | null;
  }): ReminderOccurrence {
    const occurrence: ReminderOccurrence = {
      id: randomUUID(),
      reminderId: input.reminder.id,
      title: input.reminder.title,
      actionKind: input.reminder.action.kind,
      scheduledFor: input.scheduledFor,
      startedAt: input.startedAt ?? null,
      finishedAt: null,
      status: input.status,
      output: null,
      error: typeof input.error === "string" ? truncate(input.error, MAX_REMINDER_ERROR) : null,
      runId: null,
      acknowledgedAt: null,
    };
    this.#occurrences.push(occurrence);
    this.#commit();
    return structuredClone(occurrence);
  }

  updateOccurrence(id: string, patch: OccurrencePatch): ReminderOccurrence {
    const occurrence = this.#occurrences.find((candidate) => candidate.id === id);
    if (occurrence === undefined) throw new Error("reminder occurrence not found");
    if (patch.status !== undefined) occurrence.status = patch.status;
    if (patch.startedAt !== undefined) occurrence.startedAt = patch.startedAt;
    if (patch.finishedAt !== undefined) occurrence.finishedAt = patch.finishedAt;
    if (patch.output !== undefined) occurrence.output = patch.output === null ? null : truncate(patch.output, MAX_REMINDER_OUTPUT);
    if (patch.error !== undefined) occurrence.error = patch.error === null ? null : truncate(patch.error, MAX_REMINDER_ERROR);
    if (patch.runId !== undefined) occurrence.runId = patch.runId;
    if (patch.acknowledgedAt !== undefined) occurrence.acknowledgedAt = patch.acknowledgedAt;
    this.#commit();
    return structuredClone(occurrence);
  }

  /** Mark occurrences seen. Resolves with how many changed. */
  acknowledge(ids: string[] | "all"): number {
    const at = this.#now().toISOString();
    const wanted = ids === "all" ? null : new Set(ids);
    let count = 0;
    for (const occurrence of this.#occurrences) {
      if (occurrence.acknowledgedAt !== null) continue;
      if (occurrence.status === "queued" || occurrence.status === "running") continue;
      if (wanted !== null && !wanted.has(occurrence.id)) continue;
      occurrence.acknowledgedAt = at;
      count += 1;
    }
    if (count > 0) this.#commit();
    return count;
  }

  /**
   * Snooze a fired occurrence: dismiss it and schedule the same action
   * once more, `minutes` from now, as a one-off of its own.
   */
  snooze(occurrenceId: string, minutes: number, source: ReminderSource): Reminder {
    const occurrence = this.#occurrences.find((candidate) => candidate.id === occurrenceId);
    if (occurrence === undefined) throw new Error("reminder occurrence not found");
    const original = this.#reminders.find((candidate) => candidate.id === occurrence.reminderId);
    if (original === undefined) throw new Error("That reminder no longer exists.");
    const at = new Date(this.#now().getTime() + Math.max(1, Math.round(minutes)) * 60_000).toISOString();
    const snoozed = this.add(
      { title: original.title, schedule: { kind: "once", at }, action: structuredClone(original.action), timezone: original.timezone },
      source,
    );
    occurrence.acknowledgedAt = this.#now().toISOString();
    this.#commit();
    return snoozed;
  }

  onChange(listener: (snapshot: ReminderSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Hear which reminder changed, for the mirror that publishes it to the
   * account (sync/records.ts). Only LOCAL writes are reported, and only
   * reminders: the occurrence log is this Mac's record of what it ran.
   */
  onRecordChange(listener: (id: string) => void): () => void {
    this.#recordListeners.add(listener);
    return () => this.#recordListeners.delete(listener);
  }

  /* ------------------------- from another device ------------------------ */

  /**
   * A reminder as another device knows it, replacing the local one
   * wholesale or creating it. `nextFireAt` travels with it: the schedule is
   * account-global, and whichever device fires it publishes the advance, so
   * two Macs awake at seven do not both go off. The cap does not apply —
   * this is the person's own schedule arriving, not a new one being made.
   * Returns null when the value is not a reminder.
   */
  applyRemote(value: unknown): Reminder | null {
    const incoming = sanitizeReminder(value);
    if (incoming === null) return null;
    const index = this.#reminders.findIndex((candidate) => candidate.id === incoming.id);
    if (index !== -1 && JSON.stringify(this.#reminders[index]) === JSON.stringify(incoming)) return incoming;
    if (index === -1) this.#reminders.push(incoming);
    else this.#reminders[index] = incoming;
    this.#commit();
    return structuredClone(incoming);
  }

  /** Another device deleted it. */
  removeRemote(id: string): boolean {
    return this.#remove(id, true);
  }

  /* ------------------------------ internals ----------------------------- */

  #require(id: string): Reminder {
    const reminder = this.#reminders.find((candidate) => candidate.id === id);
    if (reminder === undefined) throw new Error("reminder not found");
    return reminder;
  }

  #remove(id: string, remote: boolean): boolean {
    const before = this.#reminders.length;
    this.#reminders = this.#reminders.filter((reminder) => reminder.id !== id);
    if (this.#reminders.length === before) return false;
    this.#occurrences = this.#occurrences.filter((occurrence) => occurrence.reminderId !== id);
    if (remote) this.#commit();
    else this.#commit(id);
    return true;
  }

  /** Write, then tell the renderer; `changed` names what a local write touched. */
  #commit(...changed: string[]): void {
    this.#prune();
    this.#write();
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) listener(structuredClone(snapshot));
    for (const id of changed) {
      for (const listener of this.#recordListeners) {
        try {
          listener(id);
        } catch (error) {
          console.error("[reminders] record listener failed", error);
        }
      }
    }
  }

  /** Keep the log bounded: settled occurrences go oldest-first. */
  #prune(): void {
    if (this.#occurrences.length <= MAX_REMINDER_OCCURRENCES) return;
    const settled = this.#occurrences
      .filter((occurrence) => occurrence.status !== "queued" && occurrence.status !== "running")
      .sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor));
    const drop = new Set(settled.slice(0, this.#occurrences.length - MAX_REMINDER_OCCURRENCES).map((occurrence) => occurrence.id));
    if (drop.size === 0) return;
    this.#occurrences = this.#occurrences.filter((occurrence) => !drop.has(occurrence.id));
  }

  #read(): ReminderDocument {
    try {
      return sanitizeReminderDocument(JSON.parse(readFileSync(this.#path, "utf8")));
    } catch {
      return { version: 1, reminders: [], occurrences: [] };
    }
  }

  #write(): void {
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      const file: ReminderDocument = { version: 1, reminders: this.#reminders, occurrences: this.#occurrences };
      const tmp = `${this.#path}.tmp`;
      writeFileSync(tmp, JSON.stringify(file, null, 2));
      renameSync(tmp, this.#path);
    } catch {
      // The in-memory value still wins for this session.
    }
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
