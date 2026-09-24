/**
 * Google Calendar's pure half: the times a model writes turned into what
 * the API takes, the window bounds `timeMin`/`timeMax` need as instants,
 * recurrence lines checked, and an Event resource unpacked for the model.
 */

import { describe, expect, it } from "vitest";
import {
  checkEventSpan,
  defaultEnd,
  eventTimeField,
  eventView,
  isOwnCalendar,
  isViewer,
  otherGuests,
  parseEventTime,
  parseRecurrence,
  parseTimeZone,
  windowInstant,
  type CalendarEventResource,
} from "../src/index.js";

describe("event times", () => {
  it("reads the three forms a time can be written in", () => {
    expect(parseEventTime("start", "2026-09-21")).toMatchObject({ kind: "date", date: "2026-09-21" });
    expect(parseEventTime("start", "2026-09-21T15:00")).toMatchObject({ kind: "local", dateTime: "2026-09-21T15:00:00" });
    expect(parseEventTime("start", "2026-09-21T15:00:30.250")).toMatchObject({ kind: "local", dateTime: "2026-09-21T15:00:30" });
    const instant = parseEventTime("start", " 2026-09-21T15:00:00-07:00 ");
    expect(instant).toMatchObject({ kind: "instant", dateTime: "2026-09-21T15:00:00-07:00" });
    expect(instant.kind === "instant" && instant.at.toISOString()).toBe("2026-09-21T22:00:00.000Z");
    expect(parseEventTime("start", "2026-09-21t15:00:00z")).toMatchObject({ kind: "instant", dateTime: "2026-09-21T15:00:00Z" });
  });

  it("refuses what is not a time, naming the field", () => {
    expect(() => parseEventTime("start", "tomorrow at 3")).toThrow(/^start: write a date/u);
    expect(() => parseEventTime("end", "2026-02-30")).toThrow("end: 2026-02-30 is not a real date");
    expect(() => parseEventTime("end", "2026-09-21T25:00:00")).toThrow(/not a real time/u);
    expect(() => parseEventTime("end", "2026-09-31T10:00:00Z")).toThrow(/not a real time/u);
  });

  it("gives an event with no end an hour, or a day when it is all-day", () => {
    expect(defaultEnd(parseEventTime("start", "2026-09-30"))).toMatchObject({ kind: "date", date: "2026-10-01" });
    expect(defaultEnd(parseEventTime("start", "2026-09-21T23:30:00"))).toMatchObject({ kind: "local", dateTime: "2026-09-22T00:30:00" });
    expect(defaultEnd(parseEventTime("start", "2026-09-21T15:00:00-07:00"))).toMatchObject({ kind: "instant", dateTime: "2026-09-21T23:00:00Z" });
  });

  it("refuses mixed forms and an end that is not after its start", () => {
    const at = (value: string) => parseEventTime("t", value);
    expect(() => checkEventSpan(at("2026-09-21"), at("2026-09-21T10:00:00"))).toThrow(/written the same way/u);
    expect(() => checkEventSpan(at("2026-09-21"), at("2026-09-21"))).toThrow(/exclusive/u);
    expect(() => checkEventSpan(at("2026-09-21T10:00:00"), at("2026-09-21T09:00:00"))).toThrow("end must be after start");
    // The same wall clock in two offsets: the instants decide, not the text.
    expect(() => checkEventSpan(at("2026-09-21T10:00:00-07:00"), at("2026-09-21T11:00:00-04:00"))).toThrow("end must be after start");
    expect(() => checkEventSpan(at("2026-09-21T10:00:00-07:00"), at("2026-09-21T14:00:00-04:00"))).not.toThrow();
  });

  it("writes the API's start/end field, with the nulls a timed ↔ all-day patch needs", () => {
    expect(eventTimeField(parseEventTime("s", "2026-09-21"), null)).toEqual({ date: "2026-09-21" });
    expect(eventTimeField(parseEventTime("s", "2026-09-21"), null, true)).toEqual({ date: "2026-09-21", dateTime: null, timeZone: null });
    expect(eventTimeField(parseEventTime("s", "2026-09-21T15:00:00"), "Europe/Paris")).toEqual({ dateTime: "2026-09-21T15:00:00", timeZone: "Europe/Paris" });
    expect(eventTimeField(parseEventTime("s", "2026-09-21T15:00:00Z"), null, true)).toEqual({ dateTime: "2026-09-21T15:00:00Z", date: null });
    expect(() => eventTimeField(parseEventTime("s", "2026-09-21T15:00:00"), null)).toThrow(/needs a time zone/u);
  });

  it("turns a window bound into an instant in the calendar's zone, a closing date taking its whole day", () => {
    const zone = "America/Los_Angeles";
    expect(windowInstant(parseEventTime("from", "2026-09-21"), zone, "from").toISOString()).toBe("2026-09-21T07:00:00.000Z");
    expect(windowInstant(parseEventTime("to", "2026-09-21"), zone, "to").toISOString()).toBe("2026-09-22T07:00:00.000Z");
    expect(windowInstant(parseEventTime("from", "2026-09-21T09:30:00"), zone, "from").toISOString()).toBe("2026-09-21T16:30:00.000Z");
    expect(windowInstant(parseEventTime("from", "2026-09-21T09:30:00+02:00"), zone, "from").toISOString()).toBe("2026-09-21T07:30:00.000Z");
    // The day the clocks go back is 25 hours long; the window still ends at the next local midnight.
    expect(windowInstant(parseEventTime("from", "2026-11-01"), zone, "from").toISOString()).toBe("2026-11-01T07:00:00.000Z");
    expect(windowInstant(parseEventTime("to", "2026-11-01"), zone, "to").toISOString()).toBe("2026-11-02T08:00:00.000Z");
  });

  it("checks zone names and recurrence lines before they reach the wire", () => {
    expect(parseTimeZone(null)).toBeNull();
    expect(parseTimeZone(" ")).toBeNull();
    expect(parseTimeZone("Europe/Paris")).toBe("Europe/Paris");
    expect(() => parseTimeZone("Pacific Time")).toThrow(/IANA/u);
    expect(parseRecurrence([" RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=8 ", "EXDATE;TZID=Europe/Paris:20260929T150000"])).toEqual([
      "RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=8",
      "EXDATE;TZID=Europe/Paris:20260929T150000",
    ]);
    expect(() => parseRecurrence(["every tuesday"])).toThrow(/not an RRULE/u);
    expect(() => parseRecurrence(["RRULE:FREQ=DAILY\r\nATTENDEE:mailto:x@evil.example"])).toThrow(/not an RRULE/u);
    expect(() => parseRecurrence(Array.from({ length: 11 }, () => "RRULE:FREQ=DAILY"))).toThrow(/at most 10/u);
  });
});

describe("who the account is on an event", () => {
  const me = "alex@example.com";

  it("trusts Google's `self` only on the account's own calendar, where it also catches an alias", () => {
    const own = { account: me, calendarId: "primary" };
    expect(isOwnCalendar(own)).toBe(true);
    expect(isOwnCalendar({ account: me, calendarId: "Alex@Example.com" })).toBe(true);
    expect(isViewer({ email: "a.lovelace@example.com", self: true }, own)).toBe(true);
    expect(isViewer({ email: "kim@example.com" }, own)).toBe(false);
    expect(isViewer(undefined, own)).toBe(false);
  });

  it("goes by the address alone on anyone else's calendar, where `self` is that calendar's owner", () => {
    const kims = { account: me, calendarId: "kim@example.com" };
    expect(isOwnCalendar(kims)).toBe(false);
    expect(isViewer({ email: "kim@example.com", self: true }, kims)).toBe(false);
    expect(isViewer({ email: " ALEX@example.com " }, kims)).toBe(true);
    const event = { id: "e", attendees: [{ email: "kim@example.com", self: true }, { email: me }, { email: "room@resource.calendar.google.com", resource: true }] };
    // Kim is another person to the account, even on the copy Google marks as hers.
    expect(otherGuests(event, kims).map((attendee) => attendee.email)).toEqual(["kim@example.com"]);
    expect(otherGuests(event, { account: "kim@example.com", calendarId: "primary" }).map((attendee) => attendee.email)).toEqual([me]);
  });
});

describe("event view", () => {
  const ME = { account: "alex@example.com", calendarId: "primary" };

  const resource: CalendarEventResource = {
    id: "e1",
    status: "confirmed",
    htmlLink: "https://www.google.com/calendar/event?eid=abc",
    summary: "Vendor sync",
    description: "<p>Agenda:</p><ul><li>Pricing</li><li>Timeline</li></ul>",
    location: "Room 4",
    organizer: { email: "sam@vendor.example" },
    start: { dateTime: "2026-09-21T15:00:00-07:00", timeZone: "America/Los_Angeles" },
    end: { dateTime: "2026-09-21T15:30:00-07:00", timeZone: "America/Los_Angeles" },
    recurringEventId: "series-1",
    attendees: [
      { email: "sam@vendor.example", displayName: "Sam", organizer: true, responseStatus: "accepted" },
      { email: "alex@example.com", self: true, responseStatus: "needsAction" },
      { email: "room-4@resource.calendar.google.com", resource: true, responseStatus: "accepted" },
    ],
    hangoutLink: "https://meet.google.com/old-link",
    conferenceData: { entryPoints: [{ entryPointType: "phone", uri: "tel:+1-555-0100" }, { entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }] },
  };

  it("unpacks what the model needs, with the description as text and rooms left out of the guests", () => {
    const view = eventView(resource, ME);
    expect(view).toMatchObject({
      id: "e1",
      calendarId: "primary",
      title: "Vendor sync",
      location: "Room 4",
      start: "2026-09-21T15:00:00-07:00",
      end: "2026-09-21T15:30:00-07:00",
      allDay: false,
      timeZone: "America/Los_Angeles",
      organizer: "sam@vendor.example",
      organizedByMe: false,
      myResponse: "needs_action",
      recurringEventId: "series-1",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      busy: true,
      truncated: false,
    });
    expect(view.description).toContain("Pricing");
    expect(view.description).not.toContain("<li>");
    expect(view.attendees.map((attendee) => attendee.email)).toEqual(["sam@vendor.example", "alex@example.com"]);
    expect(otherGuests(resource, ME).map((attendee) => attendee.email)).toEqual(["sam@vendor.example"]);
  });

  it("caps a long description and reads an all-day, free, guestless event", () => {
    const view = eventView(
      { id: "e2", summary: "Offsite", description: "x".repeat(50), start: { date: "2026-10-01" }, end: { date: "2026-10-03" }, transparency: "transparent", organizer: { email: "alex@example.com", self: true } },
      { account: "alex@example.com", calendarId: "team@group.calendar.google.com" },
      { maxDescriptionChars: 20 },
    );
    expect(view).toMatchObject({ allDay: true, start: "2026-10-01", end: "2026-10-03", busy: false, organizedByMe: true, myResponse: null, truncated: true, meetingUrl: null, attendees: [] });
    expect(view.description).toHaveLength(20);
  });
});
