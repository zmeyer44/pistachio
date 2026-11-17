/**
 * A declared trigger against the clock (docs/primitives.md §3): whether a
 * window of the week holds at an instant and when that next changes, which
 * recurring instant came due last and which comes next, which mark of an
 * interval, whether a signal holds by what main last read of it
 * (./signals), and the changes of the days ahead for the status file. Pure:
 * the instant, the zone and the readings are handed in, so the same math
 * answers main's tick, `pistachio.triggers.get`, the extensions page and a
 * test set at any Sunday.
 *
 * The wall clock is the reminders' (`@pistachio/agent-runtime/reminders`
 * wallClock, zonedTimeToUtc): a window is said in a zone's hours, and the
 * instants it names move with daylight saving as a person's Sunday does.
 */

import { wallClock, zonedTimeToUtc } from "@pistachio/agent-runtime/reminders";
import type { ExtTriggerState } from "@pistachio/extension-api";
import { TRIGGER_DAYS, triggerDays, triggerInWords, triggerMinutes, type TriggerDecl, type TriggerInstant, type TriggerWindow } from "@pistachio/extension-api/triggers";
import { NO_READINGS, signalHolds, signalLookAt, signalNeeds, type SignalReadings } from "./signals";

const DAY_MS = 24 * 60 * 60_000;
/** How far back a window that holds now may have started (a day, and a day's slack for the hour the clocks give back). */
const DAYS_BACK = 2;
/** How far ahead the next change is looked for: a week and its slack. Past it, the answer never changes. */
const DAYS_AHEAD = 9;

/** The zone a trigger is said in: its own, else the Mac's. (An interval and a signal name none.) */
export function triggerZone(trigger: TriggerDecl, system: string): string {
  return ("during" in trigger ? trigger.during.zone : "at" in trigger ? trigger.at.zone : undefined) ?? system;
}

/**
 * What a trigger is read against besides the clock: the triggers declared beside it (an interval's `while` names
 * one) and what main last read of the signals. Left out, an interval's `while` holds nothing and no signal is known.
 */
export interface TriggerWorld {
  triggers?: readonly TriggerDecl[];
  readings?: SignalReadings;
}

interface WallDay {
  year: number;
  month: number;
  day: number;
  /** 0 = Sunday. */
  weekday: number;
}

/** The calendar day `offset` days from the one `now` reads as in `zone`. */
function wallDay(now: number, zone: string, offset: number): WallDay {
  const today = wallClock(new Date(now), zone);
  const shifted = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(), weekday: shifted.getUTCDay() };
}

/** The instant a day's clock time names in `zone`; `minutes` may run past the day's end (1440 is the next midnight). */
function instantOn(day: WallDay, minutes: number, zone: string): number {
  const over = Math.floor(minutes / (24 * 60));
  const rest = minutes - over * 24 * 60;
  const date = new Date(Date.UTC(day.year, day.month - 1, day.day + over));
  return zonedTimeToUtc({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: Math.floor(rest / 60), minute: rest % 60 }, zone).getTime();
}

function onDay(days: readonly string[], day: WallDay): boolean {
  return days.includes(TRIGGER_DAYS[day.weekday] as string);
}

/**
 * The stretches a window is on around `now`, in order, those that touch joined into one — so every day from
 * midnight to midnight is one stretch with no end in sight, and a window that ends at 24:00 one day and starts at
 * 00:00 the next does not blink at midnight.
 */
export function windowStretches(window: TriggerWindow, now: number, zone: string): { start: number; end: number }[] {
  const days = triggerDays(window.days);
  const from = triggerMinutes(window.from);
  const to = triggerMinutes(window.to);
  const until = to > from ? to : to + 24 * 60;
  const stretches: { start: number; end: number }[] = [];
  for (let offset = -DAYS_BACK; offset <= DAYS_AHEAD; offset += 1) {
    const day = wallDay(now, zone, offset);
    if (!onDay(days, day)) continue;
    const start = instantOn(day, from, zone);
    const end = instantOn(day, until, zone);
    if (end > start) stretches.push({ start, end });
  }
  stretches.sort((a, b) => a.start - b.start);
  const joined: { start: number; end: number }[] = [];
  for (const stretch of stretches) {
    const last = joined[joined.length - 1];
    if (last !== undefined && stretch.start <= last.end) last.end = Math.max(last.end, stretch.end);
    else joined.push({ ...stretch });
  }
  return joined;
}

/** A recurring instant's occurrences around `now`, in order. */
export function instantOccurrences(instant: TriggerInstant, now: number, zone: string): number[] {
  const days = triggerDays(instant.days);
  const minutes = triggerMinutes(instant.time);
  const occurrences: number[] = [];
  for (let offset = -DAYS_AHEAD; offset <= DAYS_AHEAD; offset += 1) {
    const day = wallDay(now, zone, offset);
    if (onDay(days, day)) occurrences.push(instantOn(day, minutes, zone));
  }
  return [...new Set(occurrences)].sort((a, b) => a - b);
}

/**
 * An interval's marks around `now`: the one that came due last, and the one to come. Marks are the **wall clock's** —
 * counted from the day's own midnight in `zone`, so every hour is on the hour in Kolkata as in New York, every two
 * hours is on the even hours, and every day is midnight. A rhythm that does not divide the day (every 90 minutes,
 * every 7) starts over at midnight: its last stretch of the day is the short one.
 *
 * Counted in time passed since that midnight, so on the two days a year the clocks change no mark is skipped and
 * none comes twice — at the price that a rhythm longer than an hour is an hour off its usual hours from the change
 * until the next midnight.
 */
export function intervalMarks(minutes: number, now: number, zone: string): { at: number; next: number } {
  const period = minutes * 60_000;
  const midnight = instantOn(wallDay(now, zone, 0), 0, zone);
  const tomorrow = instantOn(wallDay(now, zone, 1), 0, zone);
  // A day has the marks an ordinary day has — and, on the day the clocks give an hour back, one more only where a
  // whole stretch still fits before midnight: every hour hears its twenty-fifth, every day does not fire twice.
  const isMark = (index: number): boolean => index * minutes < 24 * 60 || tomorrow - (midnight + index * period) >= period;
  let index = Math.floor(Math.max(0, now - midnight) / period);
  while (index > 0 && !isMark(index)) index -= 1;
  const following = midnight + (index + 1) * period;
  return { at: midnight + index * period, next: following < tomorrow && isMark(index + 1) ? following : tomorrow };
}

/** A trigger as the clock has it at `now` (ExtTriggerState): what `pistachio.triggers.get` answers and a handler is handed. */
export function triggerState(trigger: TriggerDecl, now: number, system: string, world: TriggerWorld = {}): ExtTriggerState {
  const zone = triggerZone(trigger, system);
  // (An event has no state the clock can read: what happened is handed to its handler as it happens — ./trigger-events.)
  if ("on" in trigger) return { id: trigger.id, kind: "on", events: [] };
  if ("when" in trigger) {
    const holds = signalHolds(trigger.when, world.readings ?? NO_READINGS, now);
    return { id: trigger.id, kind: "when", holds: holds === true, known: holds !== null };
  }
  if ("every" in trigger) {
    // (An interval names no zone: its marks are the Mac's own clock's.)
    const { at: mark, next: coming } = intervalMarks(trigger.every.minutes, now, system);
    if (trigger.every.while === undefined) return { id: trigger.id, kind: "every", at: mark, next: coming };
    const named = (world.triggers ?? []).find((candidate) => candidate.id === trigger.every.while);
    const level = named === undefined || "every" in named || "on" in named ? null : triggerState(named, now, system, world);
    if (level?.kind === "during") {
      if (!level.holds) {
        // Off: the first mark it will hear is the one after the window opens — if the window is still open by then.
        // (A window shorter than the rhythm may hold no mark at all: nothing is promised that will not come.)
        if (level.changesAt === null) return { id: trigger.id, kind: "every", at: null, next: null };
        const first = intervalMarks(trigger.every.minutes, level.changesAt, system).next;
        const then = triggerState(named as TriggerDecl, first, system, world);
        return { id: trigger.id, kind: "every", at: null, next: then.kind === "during" && then.holds ? first : null };
      }
      // On: none at or past the window's end.
      return { id: trigger.id, kind: "every", at: mark, next: level.changesAt !== null && coming >= level.changesAt ? null : coming };
    }
    if (level?.kind === "when" && level.holds) return { id: trigger.id, kind: "every", at: mark, next: coming };
    return { id: trigger.id, kind: "every", at: null, next: null };
  }
  if ("during" in trigger) {
    const stretches = windowStretches(trigger.during, now, zone);
    const within = stretches.find((stretch) => stretch.start <= now && now < stretch.end);
    if (within !== undefined) {
      // (A stretch that runs to the edge of what was looked at never ends: every day, all day.)
      const endless = within.end >= now + (DAYS_AHEAD - 1) * DAY_MS;
      return { id: trigger.id, kind: "during", holds: true, changesAt: endless ? null : within.end };
    }
    const next = stretches.find((stretch) => stretch.start > now);
    return { id: trigger.id, kind: "during", holds: false, changesAt: next?.start ?? null };
  }
  const occurrences = instantOccurrences(trigger.at, now, zone);
  const due = occurrences.filter((at) => at <= now);
  return { id: trigger.id, kind: "at", at: due[due.length - 1] ?? null, next: occurrences.find((at) => at > now) ?? null };
}

/** The answer of a signal main cannot read: never delivered, and never what was heard. */
export const ANSWER_UNKNOWN = "unknown";
/** The answer of an instant with none due yet, and of an interval whose `while` does not hold. */
export const ANSWER_NONE = "none";

/**
 * The answer a delivery is compared by: a window or a signal is on or off; an instant or an interval is the one
 * that came due last. The worker hears a trigger when this is not what it last heard — however long the lid was
 * closed, and never twice the same.
 */
export function triggerAnswer(state: ExtTriggerState): string {
  if (state.kind === "during") return state.holds ? "on" : "off";
  if (state.kind === "when") return state.known ? (state.holds ? "on" : "off") : ANSWER_UNKNOWN;
  // (An event is never an answer of the clock's: the runner does not deliver it, ./trigger-events does.)
  if (state.kind === "on") return ANSWER_NONE;
  if (state.at === null) return ANSWER_NONE;
  return state.kind === "every" ? `every:${String(state.at)}` : `at:${String(state.at)}`;
}

/**
 * A trigger read whole: its state, and the answer a delivery is compared by. They differ from `triggerAnswer` of the
 * state in one case — an interval whose `while` names a signal main cannot read is **not known**, as that signal is,
 * rather than stopped: a calendar unread for a moment at launch is not the meeting ending, and the mark the worker
 * last heard stands until main can tell again.
 */
export function readTrigger(trigger: TriggerDecl, now: number, system: string, world: TriggerWorld = {}): { state: ExtTriggerState; answer: string } {
  const state = triggerState(trigger, now, system, world);
  if ("every" in trigger && trigger.every.while !== undefined) {
    const named = (world.triggers ?? []).find((candidate) => candidate.id === trigger.every.while);
    if (named !== undefined && "when" in named && signalHolds(named.when, world.readings ?? NO_READINGS, now) === null) return { state, answer: ANSWER_UNKNOWN };
  }
  return { state, answer: triggerAnswer(state) };
}

/** When a trigger next changes by the clock alone: a window's next edge, the next instant, the next mark. Null: never, or not the clock's to say (a signal). */
export function triggerNext(state: ExtTriggerState): number | null {
  if (state.kind === "when" || state.kind === "on") return null;
  return state.kind === "during" ? state.changesAt : state.next;
}

/**
 * When the clock should look at a trigger again, if sooner than its tick: `triggerNext`, and for a signal the
 * instant main can already see coming (an event's start, the Mac idle long enough). A signal with nothing to
 * foresee is looked at on every tick (`tickMs` on).
 */
export function triggerLookAt(trigger: TriggerDecl, state: ExtTriggerState, now: number, tickMs: number, world: TriggerWorld = {}): number | null {
  if ("when" in trigger) return Math.min(signalLookAt(trigger.when, world.readings ?? NO_READINGS, now) ?? Number.POSITIVE_INFINITY, now + tickMs);
  return triggerNext(state);
}

/** One change ahead: when, and for a window what it changes to. */
export interface TriggerChange {
  at: number;
  holds?: boolean;
}

/** A trigger's changes after `from` up to `to`, in order (at most `limit`): what the days ahead will deliver. */
export function projectTrigger(trigger: TriggerDecl, from: number, to: number, system: string, limit = 40, world: TriggerWorld = {}): TriggerChange[] {
  const changes: TriggerChange[] = [];
  let at = from;
  while (changes.length < limit) {
    const state = triggerState(trigger, at, system, world);
    const next = triggerNext(state);
    if (next === null || next > to || next <= at) break;
    changes.push(state.kind === "during" ? { at: next, holds: !state.holds } : { at: next });
    at = next;
  }
  return changes;
}

/** A trigger as the status file says it (`.pistachio/status.json` → triggers): for whoever wrote the extension to check the schedule against the wish. */
export interface TriggerStatus {
  id: string;
  /** The shell's words for it — what the approval sheet will say. */
  says: string;
  zone: string;
  /** A window, or a signal main can read: whether it is on now. */
  holds?: boolean;
  /** A signal main cannot read now: what the person would have to do ("Connect Google Calendar in Settings"). Nothing runs for it until then. */
  needs?: string;
  /** An event: it is told as it happens, while Pistachio is up — there is no schedule to list. */
  event?: true;
  /**
   * The changes of the next seven days, each as the zone's wall clock reads and as an instant. An interval lists
   * its next few marks; a signal lists none — when it changes is not the clock's to say.
   */
  next: { at: string; iso: string; holds?: boolean }[];
}

const STATUS_DAYS = 7;
/** How many of an interval's marks the status lists: enough to read the rhythm. */
const STATUS_MARKS = 3;

export function triggerStatus(trigger: TriggerDecl, now: number, system: string, world: TriggerWorld = {}): TriggerStatus {
  const zone = triggerZone(trigger, system);
  const state = triggerState(trigger, now, system, world);
  const words = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const needs = "when" in trigger ? signalNeeds(trigger.when, world.readings ?? NO_READINGS, now) : null;
  return {
    id: trigger.id,
    says: triggerInWords(trigger, world.triggers),
    zone,
    ...(state.kind === "during" || (state.kind === "when" && state.known) ? { holds: state.holds } : {}),
    ...(needs === null ? {} : { needs }),
    ...(state.kind === "on" ? { event: true as const } : {}),
    next: projectTrigger(trigger, now, now + STATUS_DAYS * DAY_MS, system, state.kind === "every" ? STATUS_MARKS : undefined, world).map((change) => ({
      at: words.format(new Date(change.at)),
      iso: new Date(change.at).toISOString(),
      ...(change.holds === undefined ? {} : { holds: change.holds }),
    })),
  };
}
