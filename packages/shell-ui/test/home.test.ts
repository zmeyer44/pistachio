import { describe, expect, it } from "vitest";
import type { Reminder, ReminderSnapshot } from "@pistachio/shell-contracts/reminders";
import {
  addTodo,
  browsableRecents,
  eventAgenda,
  greeting,
  greetingFor,
  msUntilNextMinute,
  orderedTodos,
  parseTodos,
  relativeTime,
  removeTodo,
  siteIconSources,
  siteName,
  mergeAgenda,
  showsCalendarPrompt,
  todayAgenda,
  todayWindow,
  toggleTodo,
  topSites,
  type HomeTodo,
} from "../src/lib/home";
import type { RecentSite } from "../src/lib/recents";

const site = (host: string, atMs: number, visits?: number, url = `https://${host}/`): RecentSite => ({
  host,
  url,
  title: host,
  faviconUrl: null,
  atMs,
  ...(visits === undefined ? {} : { visits }),
});

describe("the greeting", () => {
  it("follows the hour of the day", () => {
    expect(greetingFor(5)).toBe("Good morning");
    expect(greetingFor(11)).toBe("Good morning");
    expect(greetingFor(12)).toBe("Good afternoon");
    expect(greetingFor(16)).toBe("Good afternoon");
    expect(greetingFor(17)).toBe("Good evening");
    expect(greetingFor(2)).toBe("Good evening");
  });

  it("uses the first name memory holds, and nothing when it holds none", () => {
    expect(greeting(14, "Ada Lovelace")).toBe("Good afternoon, Ada");
    expect(greeting(14, "  ")).toBe("Good afternoon");
  });
});

describe("time", () => {
  it("says how long ago the way a recent list does", () => {
    const now = new Date(2026, 8, 11, 16, 0).getTime();
    expect(relativeTime(now - 20_000, now)).toBe("Just now");
    expect(relativeTime(now - 2 * 60_000, now)).toBe("2m ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(relativeTime(now - 30 * 3_600_000, now)).toBe("Yesterday");
    expect(relativeTime(now - 4 * 86_400_000, now)).toBe("4d ago");
  });

  it("waits exactly until the next minute turns", () => {
    expect(msUntilNextMinute(new Date(2026, 8, 11, 16, 0, 59, 500))).toBe(500);
    expect(msUntilNextMinute(new Date(2026, 8, 11, 16, 0, 0, 0))).toBe(60_000);
  });
});

describe("sites", () => {
  it("offers only web pages again", () => {
    expect(browsableRecents([site("github.com", 1), site("pistachio://welcome", 2, 1, "pistachio://welcome/")]).map((s) => s.host)).toEqual([
      "github.com",
    ]);
  });

  it("ranks top sites by visits, then by recency, skipping hosts that already have a tile", () => {
    const recents = [site("a.com", 5), site("b.com", 4, 7), site("www.c.com", 3, 3), site("d.com", 2, 7)];
    expect(topSites(recents, new Set(["c.com"]), 3).map((s) => s.host)).toEqual(["b.com", "d.com", "a.com"]);
    expect(topSites(recents, new Set(), 0)).toEqual([]);
  });

  it("draws a tile with the page's own favicon first, then the favicon service's, then a letter", () => {
    // The page's icon is the signed-in one; the service only ever sees the sign-in page.
    expect(siteIconSources("https://mail.google.com/mail/u/0/", "https://mail.google.com/gmail.png")).toEqual([
      "https://mail.google.com/gmail.png",
      "https://www.google.com/s2/favicons?domain=mail.google.com&sz=64",
    ]);
    expect(siteIconSources("https://www.example.com/", null)).toEqual(["https://www.google.com/s2/favicons?domain=example.com&sz=64"]);
    expect(siteIconSources("https://www.example.com/", "")).toEqual(["https://www.google.com/s2/favicons?domain=example.com&sz=64"]);
    expect(siteIconSources("pistachio://welcome/", null)).toEqual([]);
  });

  it("names a site by the part of its title that is its name, else by its host", () => {
    // Not the address in the middle: "com" names no site.
    expect(siteName("Inbox (3) - you@example.com - Gmail", "https://mail.google.com/mail/u/0/")).toBe("Gmail");
    expect(siteName("Inbox - you@example.com", "https://outlook.office.com/mail/")).toBe("Office");
    expect(siteName("Pull requests · GitHub", "https://github.com/pulls")).toBe("GitHub");
    expect(siteName("YouTube", "https://www.youtube.com/")).toBe("YouTube");
    expect(siteName("Hacker News", "https://news.ycombinator.com/")).toBe("Hacker News");
    expect(siteName("A very long page title that names nothing at all", "https://www.bbc.co.uk/news")).toBe("Bbc");
  });
});

describe("to-dos", () => {
  const morning = new Date(2026, 8, 11, 9, 0);

  it("adds, ticks, unticks and removes", () => {
    let list: HomeTodo[] = addTodo([], "  Call Sam  ", 1, "a");
    list = addTodo(list, "", 2, "ignored");
    list = addTodo(list, "Ship it", 3, "b");
    expect(list.map((item) => item.text)).toEqual(["Call Sam", "Ship it"]);
    list = toggleTodo(list, "a", 10);
    expect(list[0]).toMatchObject({ done: true, doneAt: 10 });
    expect(orderedTodos(list).map((item) => item.id)).toEqual(["b", "a"]);
    list = toggleTodo(list, "a", 11);
    expect(list[0]).toMatchObject({ done: false, doneAt: null });
    expect(removeTodo(list, "a").map((item) => item.id)).toEqual(["b"]);
  });

  it("carries open items into a new day and clears what was finished before it", () => {
    const yesterday = new Date(2026, 8, 10, 18, 0).getTime();
    const earlier = new Date(2026, 8, 11, 8, 0).getTime();
    const raw = JSON.stringify([
      { id: "open", text: "Still open", done: false, createdAt: yesterday, doneAt: null },
      { id: "old", text: "Done yesterday", done: true, createdAt: yesterday, doneAt: yesterday },
      { id: "today", text: "Done this morning", done: true, createdAt: yesterday, doneAt: earlier },
      { id: 4, text: "malformed" },
      "junk",
    ]);
    expect(parseTodos(raw, morning).map((item) => item.id)).toEqual(["open", "today"]);
    expect(parseTodos("not json", morning)).toEqual([]);
    expect(parseTodos(null, morning)).toEqual([]);
  });
});

describe("today's schedule", () => {
  const reminder = (patch: Partial<Reminder>): Reminder => ({
    id: "r1",
    title: "Standup",
    schedule: { kind: "daily", time: "10:00" },
    action: { kind: "message", text: "Standup" },
    timezone: "UTC",
    status: "active",
    source: { kind: "user", runId: null },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    nextFireAt: "2026-09-11T10:00:00.000Z",
    lastFiredAt: null,
    until: null,
    maxFires: null,
    fireCount: 0,
    ...patch,
  });

  it("lists what fired and what is still to come today, in order, marking the past", () => {
    const snapshot: ReminderSnapshot = {
      reminders: [reminder({}), reminder({ id: "r2", title: "Gym", schedule: { kind: "once", at: "2026-09-11T16:30:00.000Z" }, nextFireAt: "2026-09-11T16:30:00.000Z" })],
      occurrences: [
        {
          id: "o1",
          reminderId: "r1",
          title: "Standup",
          actionKind: "message",
          scheduledFor: "2026-09-11T10:00:00.000Z",
          startedAt: "2026-09-11T10:00:00.000Z",
          finishedAt: "2026-09-11T10:00:01.000Z",
          status: "completed",
          output: "Standup",
          error: null,
          runId: null,
          acknowledgedAt: null,
        },
      ],
    };
    const agenda = todayAgenda(snapshot, new Date("2026-09-11T12:00:00.000Z"), "UTC");
    expect(agenda.map((item) => [item.title, item.kind, item.past])).toEqual([
      ["Standup", "occurrence", true],
      ["Gym", "upcoming", false],
    ]);
  });
});

describe("a connected calendar on today's schedule", () => {
  const now = new Date("2026-09-21T17:30:00.000Z");
  const event = (id: string, start: string, end: string, extra: Partial<Parameters<typeof eventAgenda>[0][number]> = {}) => ({
    id,
    title: id,
    start,
    end,
    allDay: !start.includes("T"),
    location: "",
    meetingUrl: null,
    webUrl: `https://www.google.com/calendar/event?eid=${id}`,
    ...extra,
  });

  it("marks an event past only once it has ended, and live while it runs", () => {
    const agenda = eventAgenda(
      [
        event("done", "2026-09-21T15:00:00Z", "2026-09-21T16:00:00Z"),
        event("running", "2026-09-21T17:00:00Z", "2026-09-21T18:00:00Z"),
        event("later", "2026-09-21T20:00:00-07:00", "2026-09-21T21:00:00-07:00"),
        event("broken", "soon", "later"),
      ],
      now,
      "UTC",
    );
    expect(agenda.map((item) => [item.id, item.past, item.live])).toEqual([
      ["done", true, false],
      ["running", false, true],
      ["later", false, false],
    ]);
    // Whatever offset the calendar wrote it in, the line carries the instant.
    expect(agenda[2]!.at).toBe("2026-09-22T03:00:00.000Z");
    expect(agenda.every((item) => item.kind === "event")).toBe(true);
  });

  it("keeps an all-day event only when its dates hold today in the viewer's zone", () => {
    const events = [event("yesterday", "2026-09-20", "2026-09-21"), event("today", "2026-09-21", "2026-09-22"), event("trip", "2026-09-19", "2026-09-25"), event("tomorrow", "2026-09-22", "2026-09-23")];
    expect(eventAgenda(events, now, "UTC").map((item) => item.id)).toEqual(["today", "trip"]);
    // 17:30Z on the 21st is already the 22nd in Auckland.
    expect(eventAgenda(events, now, "Pacific/Auckland").map((item) => item.id)).toEqual(["trip", "tomorrow"]);
    expect(eventAgenda(events, now, "UTC")[0]).toMatchObject({ allDay: true, past: false });
  });

  it("follows only https links, and names an untitled event", () => {
    const [item] = eventAgenda([event("x", "2026-09-21T18:00:00Z", "2026-09-21T19:00:00Z", { title: "  ", meetingUrl: "javascript:alert(1)", webUrl: "http://calendar.example/x" })], now, "UTC");
    expect(item).toMatchObject({ title: "(No title)", meetingUrl: null, webUrl: null });
    const [meet] = eventAgenda([event("y", "2026-09-21T18:00:00Z", "2026-09-21T19:00:00Z", { meetingUrl: "https://meet.google.com/abc-defg-hij" })], now, "UTC");
    expect(meet).toMatchObject({ meetingUrl: "https://meet.google.com/abc-defg-hij", webUrl: "https://www.google.com/calendar/event?eid=y" });
  });

  it("merges events with reminders: whole-day first, then by the clock, an event ahead of a reminder at the same minute", () => {
    const reminders = [
      { id: "r-early", at: "2026-09-21T08:00:00.000Z", title: "Standup", kind: "occurrence" as const, past: true },
      { id: "r-tie", at: "2026-09-21T18:00:00.000Z", title: "Call mum", kind: "upcoming" as const, past: false },
    ];
    const events = eventAgenda([event("sync", "2026-09-21T18:00:00Z", "2026-09-21T18:30:00Z"), event("offsite", "2026-09-21", "2026-09-22"), event("breakfast", "2026-09-21T07:00:00Z", "2026-09-21T07:30:00Z")], now, "UTC");
    expect(mergeAgenda(reminders, events).map((item) => item.id)).toEqual(["offsite", "breakfast", "r-early", "sync", "r-tie"]);
    expect(mergeAgenda(reminders, []).map((item) => item.id)).toEqual(["r-early", "r-tie"]);
  });

  it("asks for the viewer's day, midnight to midnight", () => {
    const window = todayWindow(new Date(2026, 8, 21, 14, 5));
    expect(new Date(window.from).getHours()).toBe(0);
    expect(new Date(window.from).getDate()).toBe(21);
    expect(new Date(window.to).getDate()).toBe(22);
    expect(Date.parse(window.to) - Date.parse(window.from)).toBe(86_400_000);
  });
});

describe("the invitation to connect a calendar", () => {
  it("shows only when there is no calendar, connecting would work, and the person has not said no", () => {
    expect(showsCalendarPrompt({ status: "not_connected", connectable: true }, false)).toBe(true);
    expect(showsCalendarPrompt({ status: "not_connected", connectable: true }, true)).toBe(false);
    // No account on this Mac, a server without Google Calendar, a disconnect under way: a button to a refusal.
    expect(showsCalendarPrompt({ status: "not_connected", connectable: false }, false)).toBe(false);
    // Not while the answer is unknown, and never beside a calendar that is there — working, dead, or unreachable.
    expect(showsCalendarPrompt(null, false)).toBe(false);
    for (const status of ["ok", "reconnect_required", "unreachable"] as const) expect(showsCalendarPrompt({ status, connectable: true }, false)).toBe(false);
  });
});
