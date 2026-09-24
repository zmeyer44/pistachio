/**
 * Report arithmetic the page needs and a test can reach without a DOM.
 */
import type { ReportBuiltWith, ReportRecord, ReportSourceStatus } from "@pistachio/shell-contracts/reports";

export type ScheduleMoment = "past" | "live" | "next" | "later" | "allday";

interface Timed {
  key: string;
  startsAt: string | null;
  endsAt: string | null;
  allDay: boolean;
}

/**
 * Where each schedule item stands against the clock. A brief is written once
 * in the morning and read all day, so this is worked out on the page, not
 * stored: exactly one upcoming item is "next".
 */
export function scheduleMoments(items: readonly Timed[], nowMs: number): Map<string, ScheduleMoment> {
  const moments = new Map<string, ScheduleMoment>();
  let nextKey: string | null = null;
  let nextStart = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const start = item.startsAt === null ? Number.NaN : Date.parse(item.startsAt);
    if (item.allDay || Number.isNaN(start)) {
      moments.set(item.key, "allday");
      continue;
    }
    if (nowMs < start) {
      moments.set(item.key, "later");
      if (start < nextStart) {
        nextStart = start;
        nextKey = item.key;
      }
      continue;
    }
    // A reminder has no end: it is over the minute it has fired.
    const end = item.endsAt === null ? Number.NaN : Date.parse(item.endsAt);
    moments.set(item.key, !Number.isNaN(end) && nowMs < end ? "live" : "past");
  }
  if (nextKey !== null) moments.set(nextKey, "next");
  return moments;
}

/** "in 40 min", "in 2 h" — how far off the next thing is; empty once it is more than a working day away. */
export function startsIn(startsAt: string | null, nowMs: number): string {
  if (startsAt === null) return "";
  const minutes = Math.round((Date.parse(startsAt) - nowMs) / 60_000);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 10 * 60) return "";
  if (minutes < 60) return `in ${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `in ${String(hours)} h` : `in ${String(hours)} h ${String(rest)} min`;
}

export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/u).filter((word) => word !== "");
  const first = words[0]?.charAt(0) ?? "";
  const last = words.length > 1 ? (words.at(-1)?.charAt(0) ?? "") : "";
  return `${first}${last}`.toUpperCase() || "•";
}

/** A stable hue for a sender's avatar, from their name alone. */
export function hueOf(seed: string): number {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360;
  return hash;
}

/** Only web links leave a report. A spec is validated, but a URL is still just a string. */
export function isWebUrl(value: string | null | undefined): value is string {
  return typeof value === "string" && /^https?:\/\/[^\s]+$/iu.test(value);
}

const SOURCE_NAMES: Record<ReportSourceStatus["source"], string> = {
  calendar: "Google Calendar",
  gmail: "Gmail",
  reminders: "Reminders",
  todos: "To-dos",
  watchtower: "Reading",
  threads: "Agent conversations",
};

/** The footer's account of what the brief was made from: only sources that gave it something. */
export function sourcesLine(sources: readonly ReportSourceStatus[]): string {
  const used = sources.filter((source) => source.state === "ok" && source.count > 0).map((source) => SOURCE_NAMES[source.source]);
  return used.length === 0 ? "No sources had anything for today." : `Made from ${used.join(", ")}.`;
}

/** Who laid the page out and who wrote its sentence, said plainly. */
export function builtWithLine(builtWith: ReportBuiltWith): string {
  const layout = builtWith.composer === "jev" ? `Laid out by ${builtWith.composerModel ?? "the evaluation model"}` : "Built-in layout";
  const words = builtWith.writer === null ? "" : `, headline by ${builtWith.writer}`;
  return `${layout}${words}.`;
}

/** A brief is stale once its day is over; the page offers a fresh one rather than silently replacing it. */
export function briefIsForToday(report: Pick<ReportRecord, "date">, today: string): boolean {
  return report.date === today;
}

/** The viewer's local day, `YYYY-MM-DD` — the same key main files a brief under. */
export function localDayOf(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${String(now.getFullYear())}-${month}-${day}`;
}

function timeLabel(time: string): string {
  const [hours, minutes] = time.split(":").map(Number);
  return new Date(2000, 0, 1, hours ?? 0, minutes ?? 0).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * The times Settings offers for the scheduled brief: every half hour from 4 AM
 * to noon. A time set some other way (a synced or hand-edited value) is kept
 * in the list rather than silently replaced.
 */
export function briefTimeItems(current: string): { value: string; label: string }[] {
  const times: string[] = [];
  for (let minutes = 4 * 60; minutes <= 12 * 60; minutes += 30) times.push(`${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`);
  if (/^([01]\d|2[0-3]):[0-5]\d$/u.test(current) && !times.includes(current)) times.push(current);
  return times.sort().map((value) => ({ value, label: timeLabel(value) }));
}

/** The request contract's bounds (`reportLocalSchema`), restated here so what is sent always fits them. */
const LOCAL_LIMITS = { todos: 50, todoId: 80, todoText: 240, recents: 24, url: 2000, title: 200, host: 120, name: 80, timezone: 80, locale: 40 } as const;

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export interface ReportLocalInput {
  timezone: string;
  locale: string;
  name: string;
  todos: readonly { id: string; text: string; done: boolean; createdAt: number }[];
  recents: readonly { url: string; title: string; host: string; atMs: number; visits?: number }[];
}

/**
 * The shell's share of a brief's materials, made to fit the request's limits.
 * The host validates the whole request, so one page with a 240-character
 * title would otherwise refuse the brief outright — calendar, mail and all.
 * Text that is only shown is clipped; a URL or an id that does not fit is left
 * out, because a clipped one names something else.
 */
export interface ReportLocalOutput {
  timezone: string;
  locale: string;
  name: string;
  todos: { id: string; text: string; done: boolean; createdAt: number }[];
  recents: { url: string; title: string; host: string; atMs: number; visits: number }[];
}

export function reportLocalOf(input: ReportLocalInput): ReportLocalOutput {
  return {
    timezone: input.timezone.length <= LOCAL_LIMITS.timezone ? input.timezone : "UTC",
    locale: input.locale.length <= LOCAL_LIMITS.locale ? input.locale : "en-US",
    name: cut(input.name, LOCAL_LIMITS.name),
    todos: input.todos
      .filter((todo) => todo.id.length <= LOCAL_LIMITS.todoId && Number.isFinite(todo.createdAt))
      .slice(0, LOCAL_LIMITS.todos)
      .map((todo) => ({ id: todo.id, text: cut(todo.text, LOCAL_LIMITS.todoText), done: todo.done, createdAt: todo.createdAt })),
    recents: input.recents
      .filter((recent) => recent.url.length <= LOCAL_LIMITS.url && Number.isFinite(recent.atMs))
      .slice(0, LOCAL_LIMITS.recents)
      .map((recent) => ({
        url: recent.url,
        title: cut(recent.title, LOCAL_LIMITS.title),
        host: cut(recent.host, LOCAL_LIMITS.host),
        atMs: recent.atMs,
        visits: typeof recent.visits === "number" && Number.isFinite(recent.visits) ? recent.visits : 1,
      })),
  };
}

/**
 * What the brief page does with the host's answer about a day's brief.
 * - `join`: a generation is already running in the host (another window asked,
 *   or the morning schedule did). Asking to generate joins it — the host runs
 *   one at a time per Space — and its result lands in this window's store. Not
 *   joining is how a page reloaded mid-generation sat on its skeleton for good.
 * - `generate`: today's brief does not exist yet; opening it makes it.
 * - `show`: there is something to show, or an archived day that is only read.
 */
export function briefLoadAction(response: { report: unknown; generating: boolean }, archivedDay: boolean): "join" | "generate" | "show" {
  if (archivedDay) return "show";
  if (response.generating) return "join";
  return response.report === null ? "generate" : "show";
}

/**
 * The home page is the truth about to-dos, in both directions: one finished
 * there is ticked in the brief, and one REOPENED there is unticked, whatever
 * the brief last filed. Returns the state changes that make `current` agree
 * with `truth`; keys the truth does not mention (mail, reminders) are left be.
 */
export function tickChanges(current: Readonly<Record<string, unknown>>, truth: Readonly<Record<string, boolean>>): { key: string; value: boolean }[] {
  return Object.entries(truth).flatMap(([key, value]) => ((current[key] === true) === value ? [] : [{ key, value }]));
}
