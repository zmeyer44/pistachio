import { describe, expect, it } from "vitest";
import {
  calendarItems,
  dayKey,
  describeSchedule,
  isRemindersUrl,
  nextOccurrence,
  parseInstant,
  projectOccurrences,
  sanitizeReminderDocument,
  sanitizeReminderInput,
  sanitizeReminderPatch,
  toolSchedule,
  unacknowledgedOccurrences,
  wallClock,
  zonedTimeToUtc,
  type Reminder,
  type ReminderOccurrence,
} from "../src/reminders.js";

const DENVER = "America/Denver";
const TOKYO = "Asia/Tokyo";

function reminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: "r1",
    title: "Brush teeth",
    schedule: { kind: "daily", time: "07:00" },
    action: { kind: "message", text: "Brush your teeth" },
    timezone: DENVER,
    status: "active",
    source: { kind: "user", runId: null },
    createdAt: "2026-08-27T12:00:00.000Z",
    updatedAt: "2026-08-27T12:00:00.000Z",
    nextFireAt: "2026-08-28T13:00:00.000Z",
    lastFiredAt: null,
    until: null,
    maxFires: null,
    fireCount: 0,
    ...overrides,
  };
}

function occurrence(overrides: Partial<ReminderOccurrence> = {}): ReminderOccurrence {
  return {
    id: "o1",
    reminderId: "r1",
    title: "Brush teeth",
    actionKind: "message",
    scheduledFor: "2026-08-27T13:00:00.000Z",
    startedAt: "2026-08-27T13:00:00.000Z",
    finishedAt: "2026-08-27T13:00:00.000Z",
    status: "delivered",
    output: "Brush your teeth",
    error: null,
    runId: null,
    acknowledgedAt: null,
    ...overrides,
  };
}

describe("time zones", () => {
  it("reads a wall clock and writes one back, across DST", () => {
    // 2026-08-27 15:40 in Denver is MDT (UTC-6).
    const summer = zonedTimeToUtc({ year: 2026, month: 8, day: 27, hour: 15, minute: 40 }, DENVER);
    expect(summer.toISOString()).toBe("2026-08-27T21:40:00.000Z");
    expect(wallClock(summer, DENVER)).toMatchObject({ year: 2026, month: 8, day: 27, hour: 15, minute: 40, weekday: 4 });
    // 2026-12-01 07:00 in Denver is MST (UTC-7).
    const winter = zonedTimeToUtc({ year: 2026, month: 12, day: 1, hour: 7, minute: 0 }, DENVER);
    expect(winter.toISOString()).toBe("2026-12-01T14:00:00.000Z");
    // Tokyo has no DST and is a day ahead of UTC in the evening.
    expect(wallClock(new Date("2026-08-27T21:40:00.000Z"), TOKYO)).toMatchObject({ day: 28, hour: 6, minute: 40 });
  });

  it("resolves the spring-forward gap to the first instant after it, and the fall-back hour to its first occurrence", () => {
    // Denver skips 02:00→03:00 on 2026-03-08 (09:00Z). 02:30 never happens.
    const gap = zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, DENVER);
    expect(gap.toISOString()).toBe("2026-03-08T09:00:00.000Z");
    expect(wallClock(gap, DENVER)).toMatchObject({ hour: 3, minute: 0 });
    // Either side of the gap is untouched.
    expect(zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 1, minute: 59 }, DENVER).toISOString()).toBe("2026-03-08T08:59:00.000Z");
    expect(zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 3, minute: 0 }, DENVER).toISOString()).toBe("2026-03-08T09:00:00.000Z");
    // Denver repeats 01:00–02:00 on 2026-11-01. 01:30 is the MDT one (07:30Z), not the MST one (08:30Z).
    const twice = zonedTimeToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, DENVER);
    expect(twice.toISOString()).toBe("2026-11-01T07:30:00.000Z");
  });

  it("reads an offsetless date-time in the given zone, never this Mac's", () => {
    expect(parseInstant("2026-08-27T16:00", DENVER)?.toISOString()).toBe("2026-08-27T22:00:00.000Z");
    expect(parseInstant("2026-08-27T16:00:30", TOKYO)?.toISOString()).toBe("2026-08-27T07:00:30.000Z");
    expect(parseInstant("2026-08-27T16:00:00-06:00", TOKYO)?.toISOString()).toBe("2026-08-27T22:00:00.000Z");
    expect(parseInstant("2026-08-27T22:00:00Z", TOKYO)?.toISOString()).toBe("2026-08-27T22:00:00.000Z");
    expect(parseInstant("tomorrow at 4", DENVER)).toBeNull();
    expect(parseInstant("2026-02-30T10:00", DENVER)).toBeNull();
    expect(parseInstant("2026-08-27", DENVER)).toBeNull();
  });
});

describe("nextOccurrence", () => {
  const after = new Date("2026-08-27T21:40:00.000Z"); // Thursday 15:40 Denver

  it("once fires only in the future", () => {
    expect(nextOccurrence({ kind: "once", at: "2026-08-27T22:00:00.000Z" }, after, DENVER)?.toISOString()).toBe("2026-08-27T22:00:00.000Z");
    expect(nextOccurrence({ kind: "once", at: "2026-08-27T21:40:00.000Z" }, after, DENVER)).toBeNull();
  });

  it("interval steps from its anchor, never landing on `after` itself", () => {
    const schedule = { kind: "interval" as const, everyMinutes: 30, startAt: "2026-08-27T20:00:00.000Z" };
    expect(nextOccurrence(schedule, after, DENVER)?.toISOString()).toBe("2026-08-27T22:00:00.000Z");
    expect(nextOccurrence(schedule, new Date("2026-08-27T22:00:00.000Z"), DENVER)?.toISOString()).toBe("2026-08-27T22:30:00.000Z");
    expect(nextOccurrence(schedule, new Date("2026-08-27T10:00:00.000Z"), DENVER)?.toISOString()).toBe("2026-08-27T20:00:00.000Z");
  });

  it("daily picks today's time if it is still ahead, else tomorrow's", () => {
    // 16:00 Denver today is still ahead of 15:40.
    expect(nextOccurrence({ kind: "daily", time: "16:00" }, after, DENVER)?.toISOString()).toBe("2026-08-27T22:00:00.000Z");
    // 07:00 has passed: tomorrow at 07:00 MDT.
    expect(nextOccurrence({ kind: "daily", time: "07:00" }, after, DENVER)?.toISOString()).toBe("2026-08-28T13:00:00.000Z");
  });

  it("daily keeps the wall-clock time across the DST change", () => {
    // Denver falls back on 2026-11-01. 07:00 the day before is 13:00Z; the day after, 14:00Z.
    const before = new Date("2026-10-31T14:00:00.000Z");
    const first = nextOccurrence({ kind: "daily", time: "07:00" }, before, DENVER)!;
    expect(first.toISOString()).toBe("2026-11-01T14:00:00.000Z");
    const second = nextOccurrence({ kind: "daily", time: "07:00" }, first, DENVER)!;
    expect(second.toISOString()).toBe("2026-11-02T14:00:00.000Z");
    expect(wallClock(second, DENVER)).toMatchObject({ hour: 7, minute: 0 });
  });

  it("weekly lands on the next listed weekday", () => {
    // Thursday 15:40 → Sunday 08:00 Denver = 14:00Z.
    expect(nextOccurrence({ kind: "weekly", days: [0], time: "08:00" }, after, DENVER)?.toISOString()).toBe("2026-08-30T14:00:00.000Z");
    // Thursday itself qualifies when the time is still ahead.
    expect(nextOccurrence({ kind: "weekly", days: [4], time: "23:00" }, after, DENVER)?.toISOString()).toBe("2026-08-28T05:00:00.000Z");
    // Thursday at a time that has passed rolls a full week.
    expect(nextOccurrence({ kind: "weekly", days: [4], time: "08:00" }, after, DENVER)?.toISOString()).toBe("2026-09-03T14:00:00.000Z");
    expect(nextOccurrence({ kind: "weekly", days: [], time: "08:00" }, after, DENVER)).toBeNull();
  });

  it("monthly clamps to the month's length", () => {
    // The 31st of September does not exist: the 30th.
    expect(nextOccurrence({ kind: "monthly", day: 31, time: "09:00" }, after, DENVER)?.toISOString()).toBe("2026-08-31T15:00:00.000Z");
    const september = nextOccurrence({ kind: "monthly", day: 31, time: "09:00" }, new Date("2026-08-31T16:00:00.000Z"), DENVER)!;
    expect(wallClock(september, DENVER)).toMatchObject({ month: 9, day: 30, hour: 9 });
    const february = nextOccurrence({ kind: "monthly", day: 30, time: "09:00" }, new Date("2027-02-01T00:00:00.000Z"), DENVER)!;
    expect(wallClock(february, DENVER)).toMatchObject({ month: 2, day: 28 });
  });

  it("reads the same rule differently in another zone", () => {
    expect(nextOccurrence({ kind: "daily", time: "07:00" }, after, TOKYO)?.toISOString()).toBe("2026-08-27T22:00:00.000Z");
  });
});

describe("projectOccurrences and the calendar", () => {
  it("projects a recurring reminder across a window and stops at its limits", () => {
    const daily = reminder();
    const from = new Date("2026-08-27T00:00:00.000Z");
    const to = new Date("2026-09-01T00:00:00.000Z");
    expect(projectOccurrences(daily, from, to).map((d) => d.toISOString())).toEqual([
      "2026-08-28T13:00:00.000Z",
      "2026-08-29T13:00:00.000Z",
      "2026-08-30T13:00:00.000Z",
      "2026-08-31T13:00:00.000Z",
    ]);
    expect(projectOccurrences(reminder({ maxFires: 2 }), from, to)).toHaveLength(2);
    expect(projectOccurrences(reminder({ until: "2026-08-29T23:00:00.000Z" }), from, to)).toHaveLength(2);
    expect(projectOccurrences(reminder({ status: "paused", nextFireAt: null }), from, to)).toHaveLength(0);
    expect(projectOccurrences(reminder({ fireCount: 1, maxFires: 1 }), from, to)).toHaveLength(0);
  });

  it("keys items by the viewer's day and drops a projection the log already covers", () => {
    const fired = occurrence({ scheduledFor: "2026-08-28T13:00:00.000Z" });
    const days = calendarItems(
      { reminders: [reminder()], occurrences: [fired] },
      new Date("2026-08-27T00:00:00.000Z"),
      new Date("2026-08-30T00:00:00.000Z"),
      DENVER,
    );
    expect([...days.keys()].sort()).toEqual(["2026-08-28", "2026-08-29"]);
    expect(days.get("2026-08-28")).toEqual([{ kind: "occurrence", at: fired.scheduledFor, occurrence: fired, reminder: reminder() }]);
    expect(days.get("2026-08-29")?.[0]?.kind).toBe("upcoming");
    // 13:00Z is the 28th in Denver but the 22:00 of the 28th in Tokyo — still the 28th.
    expect(dayKey("2026-08-28T13:00:00.000Z", TOKYO)).toBe("2026-08-28");
    expect(dayKey("2026-08-28T20:00:00.000Z", TOKYO)).toBe("2026-08-29");
  });

  it("lists what the person has not dismissed, newest first, never what is still in flight", () => {
    const list = unacknowledgedOccurrences({
      reminders: [],
      occurrences: [
        occurrence({ id: "old", finishedAt: "2026-08-27T10:00:00.000Z" }),
        occurrence({ id: "new", finishedAt: "2026-08-27T12:00:00.000Z" }),
        occurrence({ id: "seen", acknowledgedAt: "2026-08-27T12:00:00.000Z" }),
        occurrence({ id: "running", status: "running", finishedAt: null }),
      ],
    });
    expect(list.map((item) => item.id)).toEqual(["new", "old"]);
  });
});

describe("describeSchedule", () => {
  it("reads as a person would say it", () => {
    expect(describeSchedule({ kind: "daily", time: "07:00" }, DENVER)).toBe("Every day at 7 AM");
    expect(describeSchedule({ kind: "weekly", days: [0], time: "08:00" }, DENVER)).toBe("Every Sunday at 8 AM");
    expect(describeSchedule({ kind: "weekly", days: [1, 2, 3, 4, 5], time: "09:30" }, DENVER)).toBe("Weekdays at 9:30 AM");
    expect(describeSchedule({ kind: "weekly", days: [0, 6], time: "12:00" }, DENVER)).toBe("Weekends at 12 PM");
    expect(describeSchedule({ kind: "monthly", day: 1, time: "09:00" }, DENVER)).toBe("Monthly on the 1st at 9 AM");
    expect(describeSchedule({ kind: "monthly", day: 22, time: "09:00" }, DENVER)).toBe("Monthly on the 22nd at 9 AM");
    expect(describeSchedule({ kind: "interval", everyMinutes: 20, startAt: "2026-08-27T00:00:00.000Z" }, DENVER)).toBe("Every 20 minutes");
    expect(describeSchedule({ kind: "interval", everyMinutes: 120, startAt: "2026-08-27T00:00:00.000Z" }, DENVER)).toBe("Every 2 hours");
    expect(describeSchedule({ kind: "once", at: "2026-08-27T21:40:00.000Z" }, DENVER)).toBe("Once · Aug 27, 2026, 3:40 PM");
  });
});

describe("toolSchedule", () => {
  const now = new Date("2026-08-27T21:40:00.000Z");
  const blank = { at: null, inMinutes: null, time: null, days: null, dayOfMonth: null, everyMinutes: null };

  it("turns the flat tool shape into a schedule", () => {
    expect(toolSchedule({ ...blank, scheduleKind: "once", inMinutes: 20 }, now, DENVER)).toEqual({ kind: "once", at: "2026-08-27T22:00:00.000Z" });
    expect(toolSchedule({ ...blank, scheduleKind: "once", at: "2026-08-27T16:00:00-06:00" }, now, TOKYO)).toEqual({ kind: "once", at: "2026-08-27T22:00:00.000Z" });
    // No offset: the reminder's zone, whatever this Mac is set to.
    expect(toolSchedule({ ...blank, scheduleKind: "once", at: "2026-08-28T07:00" }, now, TOKYO)).toEqual({ kind: "once", at: "2026-08-27T22:00:00.000Z" });
    expect(toolSchedule({ ...blank, scheduleKind: "daily", time: "7:00" }, now, DENVER)).toEqual({ kind: "daily", time: "07:00" });
    expect(toolSchedule({ ...blank, scheduleKind: "weekly", days: [0, 0, 3], time: "08:00" }, now, DENVER)).toEqual({ kind: "weekly", days: [0, 3], time: "08:00" });
    expect(toolSchedule({ ...blank, scheduleKind: "monthly", dayOfMonth: 1, time: "09:00" }, now, DENVER)).toEqual({ kind: "monthly", day: 1, time: "09:00" });
    expect(toolSchedule({ ...blank, scheduleKind: "interval", everyMinutes: 30 }, now, DENVER)).toEqual({
      kind: "interval",
      everyMinutes: 30,
      startAt: now.toISOString(),
    });
  });

  it("explains what is wrong in words the model can act on", () => {
    expect(() => toolSchedule({ ...blank, scheduleKind: "once" }, now, DENVER)).toThrow(/needs at .* or inMinutes/);
    expect(() => toolSchedule({ ...blank, scheduleKind: "once", at: "2026-08-27T10:00:00Z" }, now, DENVER)).toThrow(/in the past/);
    expect(() => toolSchedule({ ...blank, scheduleKind: "once", at: "tomorrow" }, now, DENVER)).toThrow(/not an ISO 8601 date-time/);
    expect(() => toolSchedule({ ...blank, scheduleKind: "daily", time: "7am" }, now, DENVER)).toThrow(/HH:MM/);
    expect(() => toolSchedule({ ...blank, scheduleKind: "weekly", time: "08:00" }, now, DENVER)).toThrow(/needs days/);
    expect(() => toolSchedule({ ...blank, scheduleKind: "interval", everyMinutes: 0 }, now, DENVER)).toThrow(/everyMinutes/);
  });
});

describe("sanitizing", () => {
  it("accepts a well-formed input and refuses a malformed one", () => {
    const input = sanitizeReminderInput({
      title: "  Cookies  ",
      schedule: { kind: "once", at: "2026-08-27T22:00:00Z" },
      action: { kind: "message", text: "Take them out" },
      timezone: DENVER,
      maxFires: 3,
    });
    expect(input).toEqual({
      title: "Cookies",
      schedule: { kind: "once", at: "2026-08-27T22:00:00.000Z" },
      action: { kind: "message", text: "Take them out" },
      timezone: DENVER,
      maxFires: 3,
    });
    // A missing title falls back to the message's first line.
    expect(sanitizeReminderInput({ schedule: { kind: "daily", time: "07:00" }, action: { kind: "agent", prompt: "Summarize\nthe week" } })?.title).toBe("Summarize");
    expect(sanitizeReminderInput({ schedule: { kind: "daily", time: "25:00" }, action: { kind: "message", text: "x" } })).toBeNull();
    expect(sanitizeReminderInput({ schedule: { kind: "daily", time: "07:00" }, action: { kind: "message", text: "" } })).toBeNull();
    expect(sanitizeReminderInput({ schedule: { kind: "weekly", days: [9], time: "07:00" }, action: { kind: "message", text: "x" } })).toBeNull();
    expect(sanitizeReminderInput({ schedule: { kind: "daily", time: "07:00" }, action: { kind: "message", text: "x" }, timezone: "Mars/Olympus" })?.timezone).toBeUndefined();
  });

  it("takes only the well-formed parts of a patch", () => {
    expect(sanitizeReminderPatch({ title: "", schedule: { kind: "nope" }, status: "cancelled", until: "2026-09-01T00:00:00Z", maxFires: -1 })).toEqual({
      until: "2026-09-01T00:00:00.000Z",
      maxFires: null,
    });
    expect(sanitizeReminderPatch({ status: "paused", action: { kind: "agent", prompt: "Go" } })).toEqual({ status: "paused", action: { kind: "agent", prompt: "Go" } });
  });

  it("reads a file entry by entry, dropping what cannot be a reminder", () => {
    const document = sanitizeReminderDocument({
      reminders: [reminder(), { id: "bad" }, reminder({ id: "r1" })],
      occurrences: [occurrence(), { id: "bad" }, occurrence({ id: "o2", status: "bogus" as never }), occurrence({ id: "o2" })],
    });
    expect(document.reminders.map((entry) => entry.id)).toEqual(["r1"]);
    expect(document.occurrences).toHaveLength(2);
    expect(document.occurrences[1]?.status).toBe("missed");
  });

  it("knows its own address", () => {
    expect(isRemindersUrl("pistachio://reminders")).toBe(true);
    expect(isRemindersUrl("pistachio://reminders/")).toBe(true);
    expect(isRemindersUrl("pistachio://demo/invoices")).toBe(false);
    expect(isRemindersUrl("https://reminders")).toBe(false);
    expect(isRemindersUrl("not a url")).toBe(false);
  });
});
