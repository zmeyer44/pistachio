/**
 * Reminders: what the agent (or the person) has scheduled for later, and
 * the one place the schedule is kept.
 *
 * A reminder is a SCHEDULE — a single instant, a fixed interval, or a
 * wall-clock rule (daily, weekly, monthly) read in the person's time zone —
 * paired with an ACTION: a fixed message to show them, or a prompt the
 * agent runs as a turn of its own at that time, with every tool it has.
 * Each time a reminder fires it leaves an OCCURRENCE: when it was due,
 * what happened, and what came out, so the calendar can show the past as
 * well as the future.
 *
 * Everything here is the pure half: types, sanitizers, the schedule math,
 * the calendar projection, and the flat shape the agent's tool fills in.
 * main/reminder-store.ts owns the file; main/reminder-scheduler.ts owns
 * the clock; the renderer only ever reads a snapshot and asks main for a
 * change.
 */

/* --------------------------------- types -------------------------------- */

export const REMINDER_SCHEDULE_KINDS = ["once", "interval", "daily", "weekly", "monthly"] as const;
export type ReminderScheduleKind = (typeof REMINDER_SCHEDULE_KINDS)[number];

export type ReminderSchedule =
  /** One instant. */
  | { kind: "once"; at: string }
  /** Every N minutes from an anchor instant. */
  | { kind: "interval"; everyMinutes: number; startAt: string }
  /** Every day at a wall-clock time ("07:00") in the reminder's time zone. */
  | { kind: "daily"; time: string }
  /** On the given weekdays (0 = Sunday … 6 = Saturday) at a wall-clock time. */
  | { kind: "weekly"; days: number[]; time: string }
  /** On a day of the month (clamped to the month's length) at a wall-clock time. */
  | { kind: "monthly"; day: number; time: string };

export const REMINDER_ACTION_KINDS = ["message", "agent"] as const;
export type ReminderActionKind = (typeof REMINDER_ACTION_KINDS)[number];

export type ReminderAction =
  /** Show the person this text. Nothing runs. */
  | { kind: "message"; text: string }
  /** Start an agent turn with this prompt; its final answer is the output. */
  | { kind: "agent"; prompt: string };

export const REMINDER_STATUSES = ["active", "paused", "done", "cancelled"] as const;
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];

export const REMINDER_SOURCE_KINDS = ["user", "agent"] as const;
export type ReminderSourceKind = (typeof REMINDER_SOURCE_KINDS)[number];

/** Who scheduled it: the person on the reminders page, or the agent in a run. */
export interface ReminderSource {
  kind: ReminderSourceKind;
  runId: string | null;
}

export interface Reminder {
  id: string;
  title: string;
  schedule: ReminderSchedule;
  action: ReminderAction;
  /** IANA zone the wall-clock schedules are read in. */
  timezone: string;
  status: ReminderStatus;
  source: ReminderSource;
  createdAt: string;
  updatedAt: string;
  /** The next instant it fires, or null when it never will again. */
  nextFireAt: string | null;
  lastFiredAt: string | null;
  /** A recurring reminder stops after this instant. */
  until: string | null;
  /** Stops after this many fires. */
  maxFires: number | null;
  fireCount: number;
}

export const REMINDER_OCCURRENCE_STATUSES = [
  /** Due, and waiting for the console: an agent task while another run is live. */
  "queued",
  /** The agent turn is in progress. */
  "running",
  /** The message was shown. */
  "delivered",
  /** The agent turn finished; `output` is its answer. */
  "completed",
  /** The agent turn failed; `error` says why. */
  "failed",
  /** Due while the app was closed or asleep for longer than the catch-up window. */
  "missed",
] as const;
export type ReminderOccurrenceStatus = (typeof REMINDER_OCCURRENCE_STATUSES)[number];

export interface ReminderOccurrence {
  id: string;
  reminderId: string;
  /** The reminder's title as it was; the reminder may be gone by the time this is read. */
  title: string;
  actionKind: ReminderActionKind;
  /** When the schedule said. */
  scheduledFor: string;
  /** When it actually began. */
  startedAt: string | null;
  finishedAt: string | null;
  status: ReminderOccurrenceStatus;
  /** The message text, or the agent's final answer. */
  output: string | null;
  error: string | null;
  /** The console run that carried an agent task. */
  runId: string | null;
  /** When the person dismissed it from the console. */
  acknowledgedAt: string | null;
}

export interface ReminderDocument {
  version: 1;
  reminders: Reminder[];
  occurrences: ReminderOccurrence[];
}

/** What the renderer holds. */
export interface ReminderSnapshot {
  reminders: Reminder[];
  occurrences: ReminderOccurrence[];
}

export interface ReminderInput {
  title: string;
  schedule: ReminderSchedule;
  action: ReminderAction;
  timezone?: string;
  until?: string | null;
  maxFires?: number | null;
}

export interface ReminderPatch {
  title?: string;
  schedule?: ReminderSchedule;
  action?: ReminderAction;
  timezone?: string;
  until?: string | null;
  maxFires?: number | null;
  /** Only active ⇄ paused from outside; done and cancelled are the store's. */
  status?: "active" | "paused";
}

export const MAX_REMINDER_TITLE = 120;
export const MAX_REMINDER_MESSAGE = 2_000;
export const MAX_REMINDER_PROMPT = 4_000;
export const MAX_REMINDER_OUTPUT = 20_000;
export const MAX_REMINDER_ERROR = 500;
export const MIN_INTERVAL_MINUTES = 1;
export const MAX_INTERVAL_MINUTES = 60 * 24 * 366;
export const MAX_REMINDER_FIRES = 10_000;
/** Reminders past this are refused, not pruned: a person's schedule is never dropped. */
export const MAX_REMINDERS = 500;
/** Occurrences past this are pruned oldest-first. */
export const MAX_REMINDER_OCCURRENCES = 1_000;

/** The one address the reminders page answers to. */
export const REMINDERS_URL = "pistachio://reminders";

export function isRemindersUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "pistachio:" && url.host === "reminders";
  } catch {
    return false;
  }
}

/* ------------------------------ time zones ------------------------------ */

export interface WallClock {
  year: number;
  /** 1–12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let cached = formatters.get(timezone);
  if (cached === undefined) {
    cached = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timezone, cached);
  }
  return cached;
}

export function systemTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function isValidTimezone(value: unknown): value is string {
  if (typeof value !== "string" || value === "" || value.length > 64) return false;
  try {
    formatter(value);
    return true;
  } catch {
    return false;
  }
}

/** The wall clock an instant reads as in a zone. */
export function wallClock(date: Date, timezone: string): WallClock {
  const parts: Record<string, string> = {};
  for (const part of formatter(timezone).formatToParts(date)) parts[part.type] = part.value;
  return {
    year: Number(parts["year"]),
    month: Number(parts["month"]),
    day: Number(parts["day"]),
    // "24" never appears with hourCycle h23, but guard the one runtime that disagrees.
    hour: Number(parts["hour"]) % 24,
    minute: Number(parts["minute"]),
    second: Number(parts["second"]),
    weekday: WEEKDAY_INDEX[parts["weekday"] ?? "Sun"] ?? 0,
  };
}

/** Zone offset at an instant, as (local − UTC) in milliseconds. */
function zoneOffset(date: Date, timezone: string): number {
  const w = wallClock(date, timezone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * The instant a wall-clock time names in a zone. The offset before and
 * after a DST change give two candidates; the one that reads back as the
 * asked-for time wins. A time that happens twice (the fall-back hour) is
 * its first occurrence. A time that never happens (the spring-forward gap)
 * is the first valid instant after the gap — 02:30 on the day the clocks
 * skip 02:00→03:00 fires at 03:00, not an hour early.
 */
export function zonedTimeToUtc(
  parts: { year: number; month: number; day: number; hour: number; minute: number },
  timezone: string,
): Date {
  const guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const first = zoneOffset(new Date(guess), timezone);
  const second = zoneOffset(new Date(guess - first), timezone);
  const candidates = [...new Set([guess - first, guess - second])].sort((a, b) => a - b);
  const readsBack = (ms: number): boolean => {
    const w = wallClock(new Date(ms), timezone);
    return w.day === parts.day && w.month === parts.month && w.hour === parts.hour && w.minute === parts.minute;
  };
  const valid = candidates.filter(readsBack);
  if (valid.length > 0) return new Date(valid[0]!);
  // Neither reads back: the time is in a gap between the earlier candidate
  // (still on the old offset) and the later (already on the new). The
  // transition is the first instant on the new offset between them.
  const earlier = candidates[0]!;
  const later = candidates.at(-1)!;
  const after = zoneOffset(new Date(later), timezone);
  let low = earlier;
  let high = later;
  while (high - low > 60_000) {
    const middle = low + Math.floor((high - low) / 2 / 60_000) * 60_000;
    if (zoneOffset(new Date(middle), timezone) === after) high = middle;
    else low = middle;
  }
  return new Date(high);
}

/** How many days a month has, in the proleptic Gregorian calendar. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** "07:00" → { hour: 7, minute: 0 }, or null. */
export function parseClockTime(value: unknown): { hour: number; minute: number } | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

export function formatClockTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/* ------------------------------ scheduling ------------------------------ */

/**
 * The first instant the schedule fires strictly after `after`, or null when
 * it never does. Wall-clock kinds are read in `timezone`.
 */
export function nextOccurrence(schedule: ReminderSchedule, after: Date, timezone: string): Date | null {
  const afterMs = after.getTime();
  switch (schedule.kind) {
    case "once": {
      const at = Date.parse(schedule.at);
      return Number.isNaN(at) || at <= afterMs ? null : new Date(at);
    }
    case "interval": {
      const period = schedule.everyMinutes * 60_000;
      const anchor = Date.parse(schedule.startAt);
      if (Number.isNaN(anchor) || period <= 0) return null;
      if (anchor > afterMs) return new Date(anchor);
      const steps = Math.floor((afterMs - anchor) / period) + 1;
      return new Date(anchor + steps * period);
    }
    case "daily":
    case "weekly": {
      const time = parseClockTime(schedule.time);
      if (time === null) return null;
      const days = schedule.kind === "weekly" ? new Set(schedule.days) : null;
      if (days !== null && days.size === 0) return null;
      const today = wallClock(after, timezone);
      // Walk day by day from today; a week covers every weekday rule, and
      // one extra day absorbs a DST shift that pushes today's time past `after`.
      for (let offset = 0; offset <= 8; offset += 1) {
        const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
        const candidate = zonedTimeToUtc(
          { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), ...time },
          timezone,
        );
        if (candidate.getTime() <= afterMs) continue;
        if (days !== null && !days.has(wallClock(candidate, timezone).weekday)) continue;
        return candidate;
      }
      return null;
    }
    case "monthly": {
      const time = parseClockTime(schedule.time);
      if (time === null || schedule.day < 1 || schedule.day > 31) return null;
      const today = wallClock(after, timezone);
      for (let offset = 0; offset <= 13; offset += 1) {
        const monthIndex = today.month - 1 + offset;
        const year = today.year + Math.floor(monthIndex / 12);
        const month = (monthIndex % 12) + 1;
        const day = Math.min(schedule.day, daysInMonth(year, month));
        const candidate = zonedTimeToUtc({ year, month, day, ...time }, timezone);
        if (candidate.getTime() > afterMs) return candidate;
      }
      return null;
    }
  }
}

/** True when a reminder is spent: a limit it was given has been reached. */
export function isExhausted(reminder: Pick<Reminder, "until" | "maxFires" | "fireCount">, next: Date | null): boolean {
  if (next === null) return true;
  if (reminder.maxFires !== null && reminder.fireCount >= reminder.maxFires) return true;
  if (reminder.until !== null) {
    const until = Date.parse(reminder.until);
    if (!Number.isNaN(until) && next.getTime() > until) return true;
  }
  return false;
}

/**
 * Every instant a reminder is expected to fire in [from, to], starting from
 * what the store says is next — the calendar's forward projection. Capped,
 * since an interval of a minute over a month is not a useful drawing.
 */
export function projectOccurrences(reminder: Reminder, from: Date, to: Date, limit = 200): Date[] {
  const out: Date[] = [];
  if (reminder.status !== "active" || reminder.nextFireAt === null) return out;
  let next: Date | null = new Date(reminder.nextFireAt);
  let fires = reminder.fireCount;
  const until = reminder.until === null ? null : Date.parse(reminder.until);
  while (next !== null && out.length < limit) {
    if (until !== null && !Number.isNaN(until) && next.getTime() > until) break;
    if (reminder.maxFires !== null && fires >= reminder.maxFires) break;
    if (next.getTime() > to.getTime()) break;
    if (next.getTime() >= from.getTime()) out.push(next);
    fires += 1;
    next = nextOccurrence(reminder.schedule, next, reminder.timezone);
  }
  return out;
}

/* ------------------------------ describing ------------------------------ */

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function clockLabel(time: string): string {
  const parsed = parseClockTime(time);
  if (parsed === null) return time;
  const hour12 = parsed.hour % 12 === 0 ? 12 : parsed.hour % 12;
  const minute = parsed.minute === 0 ? "" : `:${String(parsed.minute).padStart(2, "0")}`;
  return `${String(hour12)}${minute} ${parsed.hour < 12 ? "AM" : "PM"}`;
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${String(n)}th`;
  switch (n % 10) {
    case 1: return `${String(n)}st`;
    case 2: return `${String(n)}nd`;
    case 3: return `${String(n)}rd`;
    default: return `${String(n)}th`;
  }
}

/** An instant as the person reads it: "Aug 27, 3:40 PM" in their zone. */
export function formatInstant(iso: string, timezone: string, options: { year?: boolean } = {}): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      month: "short",
      day: "numeric",
      ...(options.year ? { year: "numeric" } : {}),
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

/** The schedule in one line: "Every Sunday at 8 AM", "In 20 minutes · 3:40 PM". */
export function describeSchedule(schedule: ReminderSchedule, timezone: string): string {
  switch (schedule.kind) {
    case "once":
      return `Once · ${formatInstant(schedule.at, timezone, { year: true })}`;
    case "interval": {
      const minutes = schedule.everyMinutes;
      if (minutes % 1_440 === 0) {
        const days = minutes / 1_440;
        return days === 1 ? "Every 24 hours" : `Every ${String(days)} days`;
      }
      if (minutes % 60 === 0) {
        const hours = minutes / 60;
        return hours === 1 ? "Every hour" : `Every ${String(hours)} hours`;
      }
      return minutes === 1 ? "Every minute" : `Every ${String(minutes)} minutes`;
    }
    case "daily":
      return `Every day at ${clockLabel(schedule.time)}`;
    case "weekly": {
      const days = [...new Set(schedule.days)].sort((a, b) => a - b);
      const weekdays = [1, 2, 3, 4, 5];
      const label =
        days.length === 7
          ? "Every day"
          : days.length === 5 && weekdays.every((d) => days.includes(d))
            ? "Weekdays"
            : days.length === 2 && days.includes(0) && days.includes(6)
              ? "Weekends"
              : days.length === 1
                ? `Every ${WEEKDAY_NAMES[days[0]!] ?? ""}`
                : days.map((d) => WEEKDAY_SHORT[d] ?? "").join(", ");
      return `${label} at ${clockLabel(schedule.time)}`;
    }
    case "monthly":
      return `Monthly on the ${ordinal(schedule.day)} at ${clockLabel(schedule.time)}`;
  }
}

export function isRecurring(schedule: ReminderSchedule): boolean {
  return schedule.kind !== "once";
}

/* ------------------------------ sanitizing ------------------------------ */

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function line(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function prose(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\n{3,}/g, "\n\n").trim().slice(0, max) : "";
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly unknown[]).includes(value) ? (value as T) : fallback;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function positiveInt(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** A schedule, or null when the value cannot be one. */
export function sanitizeSchedule(value: unknown): ReminderSchedule | null {
  const raw = record(value);
  switch (raw["kind"]) {
    case "once": {
      const at = isoOrNull(raw["at"]);
      return at === null ? null : { kind: "once", at };
    }
    case "interval": {
      const everyMinutes = positiveInt(raw["everyMinutes"], MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES);
      const startAt = isoOrNull(raw["startAt"]);
      return everyMinutes === null || startAt === null ? null : { kind: "interval", everyMinutes, startAt };
    }
    case "daily": {
      const time = parseClockTime(raw["time"]);
      return time === null ? null : { kind: "daily", time: formatClockTime(time.hour, time.minute) };
    }
    case "weekly": {
      const time = parseClockTime(raw["time"]);
      const days = Array.isArray(raw["days"])
        ? [...new Set((raw["days"] as unknown[]).filter((d): d is number => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b)
        : [];
      return time === null || days.length === 0 ? null : { kind: "weekly", days, time: formatClockTime(time.hour, time.minute) };
    }
    case "monthly": {
      const time = parseClockTime(raw["time"]);
      const day = positiveInt(raw["day"], 1, 31);
      return time === null || day === null ? null : { kind: "monthly", day, time: formatClockTime(time.hour, time.minute) };
    }
    default:
      return null;
  }
}

export function sanitizeAction(value: unknown): ReminderAction | null {
  const raw = record(value);
  if (raw["kind"] === "message") {
    const text = prose(raw["text"], MAX_REMINDER_MESSAGE);
    return text === "" ? null : { kind: "message", text };
  }
  if (raw["kind"] === "agent") {
    const prompt = prose(raw["prompt"], MAX_REMINDER_PROMPT);
    return prompt === "" ? null : { kind: "agent", prompt };
  }
  return null;
}

export function sanitizeReminderSource(value: unknown): ReminderSource {
  const raw = record(value);
  const runId = typeof raw["runId"] === "string" && ID.test(raw["runId"]) ? raw["runId"] : null;
  return { kind: oneOf(raw["kind"], REMINDER_SOURCE_KINDS, "user"), runId };
}

/** A creation request from the renderer or the agent, or null when it is not one. */
export function sanitizeReminderInput(value: unknown): ReminderInput | null {
  const raw = record(value);
  const schedule = sanitizeSchedule(raw["schedule"]);
  const action = sanitizeAction(raw["action"]);
  if (schedule === null || action === null) return null;
  const title = line(raw["title"], MAX_REMINDER_TITLE) || defaultTitle(action);
  const input: ReminderInput = { title, schedule, action };
  if (isValidTimezone(raw["timezone"])) input.timezone = raw["timezone"];
  if (raw["until"] !== undefined) input.until = isoOrNull(raw["until"]);
  if (raw["maxFires"] !== undefined) input.maxFires = positiveInt(raw["maxFires"], 1, MAX_REMINDER_FIRES);
  return input;
}

export function sanitizeReminderPatch(value: unknown): ReminderPatch {
  const raw = record(value);
  const patch: ReminderPatch = {};
  if (raw["title"] !== undefined) {
    const title = line(raw["title"], MAX_REMINDER_TITLE);
    if (title !== "") patch.title = title;
  }
  if (raw["schedule"] !== undefined) {
    const schedule = sanitizeSchedule(raw["schedule"]);
    if (schedule !== null) patch.schedule = schedule;
  }
  if (raw["action"] !== undefined) {
    const action = sanitizeAction(raw["action"]);
    if (action !== null) patch.action = action;
  }
  if (isValidTimezone(raw["timezone"])) patch.timezone = raw["timezone"];
  if (raw["until"] !== undefined) patch.until = isoOrNull(raw["until"]);
  if (raw["maxFires"] !== undefined) patch.maxFires = positiveInt(raw["maxFires"], 1, MAX_REMINDER_FIRES);
  if (raw["status"] === "active" || raw["status"] === "paused") patch.status = raw["status"];
  return patch;
}

/** A title when none was given: the message's first line, or the prompt's. */
export function defaultTitle(action: ReminderAction): string {
  const text = action.kind === "message" ? action.text : action.prompt;
  const first = text.split("\n")[0]?.trim() ?? "";
  return (first.length > MAX_REMINDER_TITLE ? `${first.slice(0, MAX_REMINDER_TITLE - 1)}…` : first) || "Reminder";
}

export function sanitizeReminder(value: unknown): Reminder | null {
  const raw = record(value);
  const id = typeof raw["id"] === "string" && ID.test(raw["id"]) ? raw["id"] : null;
  const schedule = sanitizeSchedule(raw["schedule"]);
  const action = sanitizeAction(raw["action"]);
  const createdAt = isoOrNull(raw["createdAt"]);
  if (id === null || schedule === null || action === null || createdAt === null) return null;
  const fireCount = positiveInt(raw["fireCount"], 0, Number.MAX_SAFE_INTEGER) ?? 0;
  return {
    id,
    title: line(raw["title"], MAX_REMINDER_TITLE) || defaultTitle(action),
    schedule,
    action,
    timezone: isValidTimezone(raw["timezone"]) ? raw["timezone"] : systemTimezone(),
    status: oneOf(raw["status"], REMINDER_STATUSES, "active"),
    source: sanitizeReminderSource(raw["source"]),
    createdAt,
    updatedAt: isoOrNull(raw["updatedAt"]) ?? createdAt,
    nextFireAt: isoOrNull(raw["nextFireAt"]),
    lastFiredAt: isoOrNull(raw["lastFiredAt"]),
    until: isoOrNull(raw["until"]),
    maxFires: positiveInt(raw["maxFires"], 1, MAX_REMINDER_FIRES),
    fireCount,
  };
}

export function sanitizeOccurrence(value: unknown): ReminderOccurrence | null {
  const raw = record(value);
  const id = typeof raw["id"] === "string" && ID.test(raw["id"]) ? raw["id"] : null;
  const reminderId = typeof raw["reminderId"] === "string" && ID.test(raw["reminderId"]) ? raw["reminderId"] : null;
  const scheduledFor = isoOrNull(raw["scheduledFor"]);
  if (id === null || reminderId === null || scheduledFor === null) return null;
  const error = line(raw["error"], MAX_REMINDER_ERROR);
  const output = prose(raw["output"], MAX_REMINDER_OUTPUT);
  const runId = typeof raw["runId"] === "string" && ID.test(raw["runId"]) ? raw["runId"] : null;
  return {
    id,
    reminderId,
    title: line(raw["title"], MAX_REMINDER_TITLE) || "Reminder",
    actionKind: oneOf(raw["actionKind"], REMINDER_ACTION_KINDS, "message"),
    scheduledFor,
    startedAt: isoOrNull(raw["startedAt"]),
    finishedAt: isoOrNull(raw["finishedAt"]),
    status: oneOf(raw["status"], REMINDER_OCCURRENCE_STATUSES, "missed"),
    output: output === "" ? null : output,
    error: error === "" ? null : error,
    runId,
    acknowledgedAt: isoOrNull(raw["acknowledgedAt"]),
  };
}

/** The whole file. Every record stands or falls on its own. */
export function sanitizeReminderDocument(value: unknown): ReminderDocument {
  const raw = record(value);
  const reminders = (Array.isArray(raw["reminders"]) ? (raw["reminders"] as unknown[]) : [])
    .map(sanitizeReminder)
    .filter((entry): entry is Reminder => entry !== null);
  const seen = new Set<string>();
  const unique = reminders.filter((entry) => (seen.has(entry.id) ? false : (seen.add(entry.id), true)));
  const occurrences = (Array.isArray(raw["occurrences"]) ? (raw["occurrences"] as unknown[]) : [])
    .map(sanitizeOccurrence)
    .filter((entry): entry is ReminderOccurrence => entry !== null);
  const seenOccurrences = new Set<string>();
  return {
    version: 1,
    reminders: unique,
    occurrences: occurrences.filter((entry) => (seenOccurrences.has(entry.id) ? false : (seenOccurrences.add(entry.id), true))),
  };
}

/* ------------------------------ the tool shape --------------------------- */

/**
 * What the agent's reminder tool fills in: one flat object every provider's
 * structured output can produce, with the fields a kind does not use left
 * null. `toolSchedule` turns it into a schedule or explains what is wrong
 * in words the model can act on.
 */
export interface ReminderToolSchedule {
  scheduleKind: ReminderScheduleKind;
  /** once: an ISO 8601 instant with an offset. */
  at: string | null;
  /** once: minutes from now, instead of `at`. */
  inMinutes: number | null;
  /** daily / weekly / monthly: "HH:MM", 24-hour, in the person's time zone. */
  time: string | null;
  /** weekly: 0 = Sunday … 6 = Saturday. */
  days: number[] | null;
  /** monthly. */
  dayOfMonth: number | null;
  /** interval. */
  everyMinutes: number | null;
}

const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * An ISO 8601 date-time as an instant. With an offset it is what it says;
 * without one it is read in `timezone` — never in this Mac's zone, which
 * is what `Date.parse` would silently do and which is not necessarily
 * where the person is. Null when the string is not a date-time at all.
 */
export function parseInstant(value: string, timezone: string): Date | null {
  const match = ISO_DATE_TIME.exec(value.trim());
  if (match === null) return null;
  const [, year, month, day, hour, minute, second, offset] = match;
  if (offset !== undefined) {
    const parsed = Date.parse(value.trim());
    return Number.isNaN(parsed) ? null : new Date(parsed);
  }
  const parts = { year: Number(year), month: Number(month), day: Number(day), hour: Number(hour), minute: Number(minute) };
  if (parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > daysInMonth(parts.year, parts.month) || parts.hour > 23 || parts.minute > 59) return null;
  const instant = zonedTimeToUtc(parts, timezone);
  return new Date(instant.getTime() + Number(second ?? 0) * 1000);
}

export function toolSchedule(input: ReminderToolSchedule, now: Date, timezone: string): ReminderSchedule {
  switch (input.scheduleKind) {
    case "once": {
      if (input.inMinutes !== null) {
        if (!Number.isFinite(input.inMinutes) || input.inMinutes < 1) throw new Error("inMinutes must be at least 1");
        return { kind: "once", at: new Date(now.getTime() + Math.round(input.inMinutes) * 60_000).toISOString() };
      }
      if (input.at === null) throw new Error("a once reminder needs at (an ISO instant) or inMinutes");
      const at = parseInstant(input.at, timezone);
      if (at === null) throw new Error(`at is not an ISO 8601 date-time like 2026-08-27T16:00:00-06:00: ${input.at}`);
      if (at.getTime() <= now.getTime()) throw new Error("at is in the past; give a future instant or use inMinutes");
      return { kind: "once", at: at.toISOString() };
    }
    case "interval": {
      const every = input.everyMinutes;
      if (every === null || !Number.isInteger(every) || every < MIN_INTERVAL_MINUTES || every > MAX_INTERVAL_MINUTES) {
        throw new Error(`everyMinutes must be a whole number from ${String(MIN_INTERVAL_MINUTES)} to ${String(MAX_INTERVAL_MINUTES)}`);
      }
      return { kind: "interval", everyMinutes: every, startAt: now.toISOString() };
    }
    case "daily": {
      const time = parseClockTime(input.time);
      if (time === null) throw new Error("time must be HH:MM in 24-hour form, for example 07:00");
      return { kind: "daily", time: formatClockTime(time.hour, time.minute) };
    }
    case "weekly": {
      const time = parseClockTime(input.time);
      if (time === null) throw new Error("time must be HH:MM in 24-hour form, for example 08:00");
      const days = [...new Set((input.days ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
      if (days.length === 0) throw new Error("weekly needs days: 0 = Sunday … 6 = Saturday");
      return { kind: "weekly", days, time: formatClockTime(time.hour, time.minute) };
    }
    case "monthly": {
      const time = parseClockTime(input.time);
      if (time === null) throw new Error("time must be HH:MM in 24-hour form, for example 09:00");
      const day = input.dayOfMonth;
      if (day === null || !Number.isInteger(day) || day < 1 || day > 31) throw new Error("monthly needs dayOfMonth from 1 to 31");
      return { kind: "monthly", day, time: formatClockTime(time.hour, time.minute) };
    }
  }
}

/** The reminder as the agent sees it in a tool result: enough to cite and change. */
export interface ReminderToolView {
  id: string;
  title: string;
  schedule: string;
  action: ReminderActionKind;
  status: ReminderStatus;
  /** The zone its clock times are read in. */
  timezone: string;
  nextFireAt: string | null;
  /** The next fire as the person would say it, in their zone. */
  next: string | null;
}

export function reminderToolView(reminder: Reminder): ReminderToolView {
  return {
    id: reminder.id,
    title: reminder.title,
    schedule: describeSchedule(reminder.schedule, reminder.timezone),
    action: reminder.action.kind,
    status: reminder.status,
    timezone: reminder.timezone,
    nextFireAt: reminder.nextFireAt,
    next: reminder.nextFireAt === null ? null : formatInstant(reminder.nextFireAt, reminder.timezone, { year: true }),
  };
}

/* -------------------------------- calendar ------------------------------ */

/** One thing on a calendar day: a fire that happened, or one still to come. */
export type CalendarItem =
  | { kind: "occurrence"; at: string; occurrence: ReminderOccurrence; reminder: Reminder | null }
  | { kind: "upcoming"; at: string; reminder: Reminder };

/** "2026-08-27" for an instant in a zone. */
export function dayKey(iso: string, timezone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const w = wallClock(date, timezone);
  return `${String(w.year)}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
}

/**
 * Everything on the calendar between two instants, keyed by day in the
 * viewer's zone: the log for what happened, the projection for what is
 * next. The scheduler never fires an occurrence twice for one instant, so
 * an upcoming that coincides with a logged one is dropped.
 */
export function calendarItems(
  snapshot: ReminderSnapshot,
  from: Date,
  to: Date,
  timezone: string,
): Map<string, CalendarItem[]> {
  const byId = new Map(snapshot.reminders.map((reminder) => [reminder.id, reminder]));
  const days = new Map<string, CalendarItem[]>();
  const push = (item: CalendarItem): void => {
    const key = dayKey(item.at, timezone);
    if (key === "") return;
    const list = days.get(key) ?? [];
    list.push(item);
    days.set(key, list);
  };
  const logged = new Set<string>();
  for (const occurrence of snapshot.occurrences) {
    const at = Date.parse(occurrence.scheduledFor);
    if (Number.isNaN(at) || at < from.getTime() || at > to.getTime()) continue;
    logged.add(`${occurrence.reminderId}:${occurrence.scheduledFor}`);
    push({ kind: "occurrence", at: occurrence.scheduledFor, occurrence, reminder: byId.get(occurrence.reminderId) ?? null });
  }
  for (const reminder of snapshot.reminders) {
    for (const at of projectOccurrences(reminder, from, to)) {
      const iso = at.toISOString();
      if (logged.has(`${reminder.id}:${iso}`)) continue;
      push({ kind: "upcoming", at: iso, reminder });
    }
  }
  for (const list of days.values()) list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return days;
}

/** Occurrences the person has not dismissed, newest first: the console's inbox. */
export function unacknowledgedOccurrences(snapshot: ReminderSnapshot): ReminderOccurrence[] {
  return snapshot.occurrences
    .filter((occurrence) => occurrence.acknowledgedAt === null && occurrence.status !== "queued" && occurrence.status !== "running")
    .sort((a, b) => Date.parse(b.finishedAt ?? b.scheduledFor) - Date.parse(a.finishedAt ?? a.scheduledFor));
}
