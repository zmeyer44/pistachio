/**
 * What a daily brief is made from. The host gathers these from the person's
 * own sources; everything downstream — triage, candidates, composition — is a
 * pure function of this one value, which is what makes the pipeline testable
 * without a calendar or a mailbox.
 */
import type { ReportSourceStatus } from "../contract.js";

export interface BriefEvent {
  id: string;
  title: string;
  /** `YYYY-MM-DD` for an all-day event (end exclusive), else RFC 3339. */
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  meetingUrl: string | null;
  webUrl: string;
}

export interface BriefMessage {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  snippet: string;
  date: string | null;
  unread: boolean;
  labels: string[];
  webUrl: string;
}

export interface BriefReminder {
  id: string;
  title: string;
  at: string;
  /** `missed`/`unread`: it already fired and nobody has looked. `upcoming`: it fires later today. */
  state: "upcoming" | "missed" | "unread";
}

export interface BriefTodo {
  id: string;
  text: string;
  createdAt: number;
}

export interface BriefPage {
  url: string;
  title: string;
  host: string;
  visitedAt: number;
  snippet: string;
  kind: "article" | "page" | "video";
}

export interface BriefThread {
  id: string;
  title: string;
  updatedAt: string;
  status: string;
}

export interface BriefMaterials {
  now: string;
  timezone: string;
  locale: string;
  name: string;
  events: BriefEvent[];
  messages: BriefMessage[];
  reminders: BriefReminder[];
  todos: BriefTodo[];
  pages: BriefPage[];
  threads: BriefThread[];
  sources: ReportSourceStatus[];
  /**
   * Whether what the person read may be described to a model. Page titles come
   * from the Watchtower archive, whose text reaches a model only when its
   * "agent access" setting is on; with it off the pages still appear in the
   * brief, and the models are told only how many there are.
   */
  pagesShareable: boolean;
}

export function emptyMaterials(now: Date, timezone: string): BriefMaterials {
  return {
    now: now.toISOString(),
    timezone,
    locale: "en-US",
    name: "",
    events: [],
    messages: [],
    reminders: [],
    todos: [],
    pages: [],
    threads: [],
    sources: [],
    pagesShareable: false,
  };
}

// ---------------------------------------------------------------------------
// Time, in the reader's zone

function zoned(locale: string, timezone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: timezone });
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" });
  }
}

/** The reader's local day as `YYYY-MM-DD`. */
export function localDay(at: Date, timezone: string): string {
  const parts = zoned("en-CA", timezone, { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

export function localHour(at: Date, timezone: string): number {
  const hour = zoned("en-US", timezone, { hour: "numeric", hourCycle: "h23" }).formatToParts(at).find((part) => part.type === "hour");
  return Number(hour?.value ?? "0") % 24;
}

export function clockTime(at: Date, materials: Pick<BriefMaterials, "locale" | "timezone">): string {
  return zoned(materials.locale, materials.timezone, { hour: "numeric", minute: "2-digit" }).format(at);
}

export function weekday(at: Date, materials: Pick<BriefMaterials, "locale" | "timezone">): string {
  return zoned(materials.locale, materials.timezone, { weekday: "long" }).format(at);
}

export function longDate(at: Date, materials: Pick<BriefMaterials, "locale" | "timezone">): string {
  return zoned(materials.locale, materials.timezone, { weekday: "long", month: "long", day: "numeric" }).format(at);
}

/** "The Sunday Brief" — the name changes with the day, which is what makes it read as a paper. */
export function briefTitle(at: Date, materials: Pick<BriefMaterials, "locale" | "timezone">): string {
  return `The ${zoned("en-US", materials.timezone, { weekday: "long" }).format(at)} Brief`;
}

/**
 * The day in the order it happens: all-day events first, then by start, then
 * by end. Several calendars are read side by side and each answers in its own
 * order, so nothing downstream may assume the list arrives sorted — "the next
 * meeting" is the first upcoming one only after this.
 */
export function sortEvents<T extends Pick<BriefEvent, "start" | "end" | "allDay">>(events: readonly T[]): T[] {
  const at = (value: string): number => {
    const time = Date.parse(value);
    return Number.isNaN(time) ? 0 : time;
  };
  return [...events].sort((a, b) => Number(b.allDay) - Number(a.allDay) || at(a.start) - at(b.start) || at(a.end) - at(b.end));
}

export type DayPart = "allday" | "morning" | "afternoon" | "evening";

export function dayPart(event: Pick<BriefEvent, "start" | "allDay">, timezone: string): DayPart {
  if (event.allDay) return "allday";
  const hour = localHour(new Date(event.start), timezone);
  return hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
}

/** "Dana Whitfield <dana@example.com>" → "Dana Whitfield"; a bare address keeps its local part's owner readable. */
export function senderName(from: string): string {
  const named = /^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/u.exec(from);
  if (named?.[1] !== undefined && named[1].trim() !== "") return named[1].trim();
  return from.replace(/[<>]/gu, "").trim();
}

export function minutesBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 60_000);
}

/** Meeting minutes still ahead today, all-day events excluded. */
export function meetingMinutes(events: readonly BriefEvent[]): number {
  return events
    .filter((event) => !event.allDay)
    .reduce((total, event) => total + Math.max(0, minutesBetween(new Date(event.start), new Date(event.end))), 0);
}

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
