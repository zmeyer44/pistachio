/**
 * Google Calendar's wire shapes, read and written: an `Event` resource
 * unpacked into the fields the model needs (times, guests, the meeting
 * link, with the description as plain text and capped), and the times the
 * model writes turned into what the API takes. Pure functions over
 * documented shapes — no network.
 */

import { isValidTimezone, zonedTimeToUtc } from "../../views/reminders.js";
import { htmlToText } from "../gmail/mime.js";

export interface CalendarEventTime {
  /** `YYYY-MM-DD`, for an all-day event. */
  date?: string | null;
  /** RFC 3339, for a timed event. */
  dateTime?: string | null;
  timeZone?: string | null;
}

export interface CalendarAttendee {
  email?: string;
  displayName?: string;
  responseStatus?: "needsAction" | "declined" | "tentative" | "accepted";
  optional?: boolean;
  organizer?: boolean;
  /**
   * This entry is the calendar this copy of the event sits on — NOT the
   * authenticated account. On the account's own calendar the two are the
   * same; on a shared calendar it is that calendar's owner. See `isViewer`.
   */
  self?: boolean;
  /** A room or a piece of equipment, not a person. */
  resource?: boolean;
  comment?: string;
}

export interface CalendarEventResource {
  id: string;
  /** The same on every calendar a meeting appears on, where `id` is per calendar. */
  iCalUID?: string;
  status?: "confirmed" | "tentative" | "cancelled";
  htmlLink?: string;
  summary?: string;
  description?: string;
  location?: string;
  creator?: { email?: string; displayName?: string; self?: boolean };
  organizer?: { email?: string; displayName?: string; self?: boolean };
  start?: CalendarEventTime;
  end?: CalendarEventTime;
  recurrence?: string[];
  recurringEventId?: string;
  attendees?: CalendarAttendee[];
  attendeesOmitted?: boolean;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
  transparency?: "opaque" | "transparent";
  visibility?: "default" | "public" | "private" | "confidential";
  eventType?: string;
  created?: string;
  updated?: string;
}

/** What an insert or a patch sends. A null clears the field on a patch. */
export interface CalendarEventWrite {
  summary?: string;
  description?: string;
  location?: string;
  start?: CalendarEventTime;
  end?: CalendarEventTime;
  recurrence?: string[];
  attendees?: CalendarAttendee[];
  transparency?: "opaque" | "transparent";
  visibility?: "default" | "public" | "private";
  conferenceData?: { createRequest: { requestId: string; conferenceSolutionKey: { type: "hangoutsMeet" } } };
}

export const MAX_EVENT_DESCRIPTION_CHARS = 4_000;
export const MAX_EVENT_ATTENDEES_SHOWN = 50;

export interface CalendarAttendeeView {
  email: string;
  name: string;
  response: "needs_action" | "declined" | "tentative" | "accepted";
  optional: boolean;
  organizer: boolean;
  /** This guest is the connected account. */
  self: boolean;
}

/** What the model sees of one event. */
export interface CalendarEventView {
  id: string;
  calendarId: string;
  title: string;
  /** Plain text, capped; `truncated` says when the cap cut it. */
  description: string;
  truncated: boolean;
  location: string;
  /** `YYYY-MM-DD` for an all-day event (the end date is exclusive), else RFC 3339 with its offset. */
  start: string;
  end: string;
  allDay: boolean;
  timeZone: string | null;
  status: "confirmed" | "tentative" | "cancelled";
  organizer: string;
  organizedByMe: boolean;
  attendees: CalendarAttendeeView[];
  /** Guests beyond the ones listed. */
  attendeesOmitted: number;
  /** The connected account's own answer, or null when it is not a guest. */
  myResponse: CalendarAttendeeView["response"] | null;
  /** The series an instance belongs to; act on this id to change every occurrence. */
  recurringEventId: string | null;
  recurrence: string[];
  meetingUrl: string | null;
  /** Whether the event blocks time on the calendar. */
  busy: boolean;
  visibility: string;
  /** Where to open it in Google Calendar. */
  webUrl: string;
}

function responseOf(status: CalendarAttendee["responseStatus"]): CalendarAttendeeView["response"] {
  return status === "accepted" || status === "declined" || status === "tentative" ? status : "needs_action";
}

function meetingUrl(resource: CalendarEventResource): string | null {
  const video = resource.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === "video" && typeof entry.uri === "string");
  return video?.uri ?? resource.hangoutLink ?? null;
}

/** Who is looking: the connected account, and the calendar the event copy was read from. */
export interface CalendarViewer {
  /** The connected account's address (the connection's `accountLabel`). */
  account: string;
  calendarId: string;
}

export const sameAddress = (a: string | undefined, b: string | undefined): boolean => a !== undefined && b !== undefined && a.trim().toLowerCase() === b.trim().toLowerCase();

/** Whether the copy was read from the account's own calendar, where Google's `self` does mean the account. */
export function isOwnCalendar(viewer: CalendarViewer): boolean {
  return viewer.calendarId === "primary" || sameAddress(viewer.calendarId, viewer.account);
}

/**
 * Whether a person on an event is the connected account. Google's `self`
 * marks the calendar a copy sits on, so it is trusted only on the account's
 * own calendar — where it also catches an invitation sent to an alias,
 * which no address comparison would. Anywhere else only the address counts:
 * on a colleague's shared calendar `self` is the colleague.
 */
export function isViewer(person: { email?: string; self?: boolean } | undefined, viewer: CalendarViewer): boolean {
  if (person === undefined) return false;
  if (sameAddress(person.email, viewer.account)) return true;
  return person.self === true && isOwnCalendar(viewer);
}

/** The people on an event other than the connected account; rooms and equipment are not people. */
export function otherGuests(resource: CalendarEventResource, viewer: CalendarViewer): CalendarAttendee[] {
  return (resource.attendees ?? []).filter((attendee) => !isViewer(attendee, viewer) && attendee.resource !== true);
}

export function eventView(resource: CalendarEventResource, viewer: CalendarViewer, options: { maxDescriptionChars?: number } = {}): CalendarEventView {
  const calendarId = viewer.calendarId;
  const cap = options.maxDescriptionChars ?? MAX_EVENT_DESCRIPTION_CHARS;
  const raw = resource.description ?? "";
  // Google stores what its editor produced, which is HTML as often as not.
  const text = /<[a-z][^>]*>/iu.test(raw) ? htmlToText(raw) : raw.trim();
  const allDay = typeof resource.start?.date === "string";
  const people = (resource.attendees ?? []).filter((attendee) => attendee.resource !== true);
  const shown = people.slice(0, MAX_EVENT_ATTENDEES_SHOWN);
  const self = people.find((attendee) => isViewer(attendee, viewer));
  return {
    id: resource.id,
    calendarId,
    title: resource.summary ?? "",
    description: text.length > cap ? text.slice(0, cap) : text,
    truncated: text.length > cap,
    location: resource.location ?? "",
    start: resource.start?.date ?? resource.start?.dateTime ?? "",
    end: resource.end?.date ?? resource.end?.dateTime ?? "",
    allDay,
    timeZone: resource.start?.timeZone ?? null,
    status: resource.status ?? "confirmed",
    organizer: resource.organizer?.email ?? "",
    organizedByMe: isViewer(resource.organizer, viewer),
    attendees: shown.map((attendee) => ({
      email: attendee.email ?? "",
      name: attendee.displayName ?? "",
      response: responseOf(attendee.responseStatus),
      optional: attendee.optional === true,
      organizer: attendee.organizer === true,
      self: isViewer(attendee, viewer),
    })),
    attendeesOmitted: people.length - shown.length,
    myResponse: self === undefined ? null : responseOf(self.responseStatus),
    recurringEventId: resource.recurringEventId ?? null,
    recurrence: resource.recurrence ?? [],
    meetingUrl: meetingUrl(resource),
    busy: resource.transparency !== "transparent",
    visibility: resource.visibility ?? "default",
    webUrl: resource.htmlLink ?? "",
  };
}

/* --------------------------------- times -------------------------------- */

/**
 * A time as the model writes it: a calendar date (all-day), a wall-clock
 * time with no offset (read in a named zone), or an instant with its offset.
 */
export type EventTimeInput =
  | { kind: "date"; date: string; year: number; month: number; day: number }
  | { kind: "local"; dateTime: string; year: number; month: number; day: number; hour: number; minute: number; second: number }
  | { kind: "instant"; dateTime: string; at: Date };

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?([Zz]|[+-]\d{2}:\d{2})?$/u;

function realDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const two = (value: number): string => String(value).padStart(2, "0");

export function parseEventTime(field: string, value: string): EventTimeInput {
  const text = value.trim();
  const date = DATE.exec(text);
  if (date !== null) {
    const [year, month, day] = [Number(date[1]), Number(date[2]), Number(date[3])];
    if (!realDate(year, month, day)) throw new Error(`${field}: ${text} is not a real date`);
    return { kind: "date", date: text, year, month, day };
  }
  const match = DATE_TIME.exec(text);
  if (match === null) {
    throw new Error(`${field}: write a date (2026-09-21), a local time (2026-09-21T15:00:00), or a time with its offset (2026-09-21T15:00:00-07:00)`);
  }
  const [year, month, day, hour, minute, second] = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6] ?? "0")];
  if (!realDate(year, month, day) || hour > 23 || minute > 59 || second > 59) throw new Error(`${field}: ${text} is not a real time`);
  const local = `${match[1]!}-${match[2]!}-${match[3]!}T${two(hour)}:${two(minute)}:${two(second)}`;
  const offset = match[7];
  if (offset === undefined) return { kind: "local", dateTime: local, year, month, day, hour, minute, second };
  const dateTime = `${local}${offset.toUpperCase()}`;
  const at = new Date(dateTime);
  if (Number.isNaN(at.getTime())) throw new Error(`${field}: ${text} is not a real time`);
  return { kind: "instant", dateTime, at };
}

/** An IANA zone the model named, checked; null and empty mean “not given”. */
export function parseTimeZone(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  const zone = value.trim();
  if (!isValidTimezone(zone)) throw new Error(`${zone} is not an IANA time zone name (e.g. America/Los_Angeles)`);
  return zone;
}

function addDays(time: Extract<EventTimeInput, { kind: "date" }>, days: number): string {
  return new Date(Date.UTC(time.year, time.month - 1, time.day + days)).toISOString().slice(0, 10);
}

export const DEFAULT_EVENT_MINUTES = 60;

/** The end an event gets when the model gave none: the next day for an all-day event, an hour on for a timed one. */
export function defaultEnd(start: EventTimeInput): EventTimeInput {
  switch (start.kind) {
    case "date":
      return parseEventTime("end", addDays(start, 1));
    case "local": {
      // Wall-clock arithmetic: the hour is added on the clock face, which is what “an hour long” means to a person.
      const end = new Date(Date.UTC(start.year, start.month - 1, start.day, start.hour, start.minute + DEFAULT_EVENT_MINUTES, start.second));
      return parseEventTime("end", end.toISOString().slice(0, 19));
    }
    case "instant":
      return parseEventTime("end", new Date(start.at.getTime() + DEFAULT_EVENT_MINUTES * 60_000).toISOString());
  }
}

/** Refuse a pair the API would refuse less clearly: mixed forms, or an end that is not after its start. */
export function checkEventSpan(start: EventTimeInput, end: EventTimeInput): void {
  if (start.kind !== end.kind) {
    throw new Error("start and end must be written the same way: both dates (all-day), both local times, or both times with an offset");
  }
  const after =
    start.kind === "instant" && end.kind === "instant"
      ? end.at.getTime() > start.at.getTime()
      : start.kind === "date" && end.kind === "date"
        ? end.date > start.date
        : start.kind === "local" && end.kind === "local" && end.dateTime > start.dateTime;
  if (!after) throw new Error(start.kind === "date" ? "end must be after start; an all-day event's end date is exclusive, so one day on the 21st ends on the 22nd" : "end must be after start");
}

/**
 * The `start`/`end` field the API takes. `zone` is required for a local
 * time, and wanted with an instant on a recurring event (Google expands a
 * series in the zone it is told). `clearing` writes the nulls a patch needs
 * to turn a timed event into an all-day one or back.
 */
export function eventTimeField(time: EventTimeInput, zone: string | null, clearing = false): CalendarEventTime {
  if (time.kind === "date") return clearing ? { date: time.date, dateTime: null, timeZone: null } : { date: time.date };
  if (time.kind === "local" && zone === null) throw new Error("a local time needs a time zone");
  return {
    dateTime: time.dateTime,
    ...(zone === null ? {} : { timeZone: zone }),
    ...(clearing ? { date: null } : {}),
  };
}

/**
 * The instant a window bound names, for `timeMin`/`timeMax`, which take
 * only instants. A date is that day's midnight in `zone` — or, for the
 * window's end, the midnight after it, so “from the 21st to the 21st” is
 * the whole day.
 */
export function windowInstant(time: EventTimeInput, zone: string, bound: "from" | "to"): Date {
  switch (time.kind) {
    case "instant":
      return time.at;
    case "local":
      return zonedTimeToUtc({ year: time.year, month: time.month, day: time.day, hour: time.hour, minute: time.minute }, zone);
    case "date": {
      const day = bound === "to" ? new Date(Date.UTC(time.year, time.month - 1, time.day + 1)) : new Date(Date.UTC(time.year, time.month - 1, time.day));
      return zonedTimeToUtc({ year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour: 0, minute: 0 }, zone);
    }
  }
}

export const MAX_RECURRENCE_LINES = 10;
const RECURRENCE_LINE = /^(?:RRULE|EXRULE|RDATE|EXDATE)[:;][\x20-\x7E]{1,500}$/u;

/** RFC 5545 recurrence lines as the API takes them, each checked so nothing but a rule goes on the wire. */
export function parseRecurrence(lines: readonly string[]): string[] {
  if (lines.length > MAX_RECURRENCE_LINES) throw new Error(`at most ${String(MAX_RECURRENCE_LINES)} recurrence lines`);
  return lines.map((line) => {
    const text = line.trim();
    if (!RECURRENCE_LINE.test(text)) throw new Error(`recurrence: “${text.slice(0, 80)}” is not an RRULE, RDATE, or EXDATE line (e.g. RRULE:FREQ=WEEKLY;BYDAY=MO,WE)`);
    return text;
  });
}
