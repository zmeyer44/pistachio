import { describe, expect, it } from "vitest";
import { reportRequestSchema } from "@pistachio/shell-contracts/reports";
import { briefLoadAction, tickChanges, reportLocalOf, briefTimeItems, briefIsForToday, builtWithLine, hueOf, initials, isWebUrl, localDayOf, scheduleMoments, sourcesLine, startsIn } from "../src/lib/reports";

const at = (time: string): number => Date.parse(`2026-09-21T${time}:00.000Z`);
const item = (key: string, start: string | null, end: string | null, allDay = false) => ({
  key,
  startsAt: start === null ? null : `2026-09-21T${start}:00.000Z`,
  endsAt: end === null ? null : `2026-09-21T${end}:00.000Z`,
  allDay,
});

describe("schedule moments", () => {
  const day = [item("offsite", null, null, true), item("standup", "09:00", "09:15"), item("review", "10:00", "11:00"), item("reminder", "12:00", null), item("dinner", "19:00", "21:00")];

  it("places each item against the clock, with exactly one next", () => {
    const moments = scheduleMoments(day, at("10:30"));
    expect(Object.fromEntries(moments)).toEqual({ offsite: "allday", standup: "past", review: "live", reminder: "next", dinner: "later" });
  });

  it("treats a reminder as over the moment it fires", () => {
    expect(scheduleMoments(day, at("12:01")).get("reminder")).toBe("past");
    expect(scheduleMoments(day, at("12:01")).get("dinner")).toBe("next");
  });

  it("has no next once the day is done", () => {
    expect([...scheduleMoments(day, at("22:00")).values()]).not.toContain("next");
  });
});

describe("small things", () => {
  it("says how far off the next thing is, and nothing when it is far", () => {
    expect(startsIn("2026-09-21T10:40:00.000Z", at("10:00"))).toBe("in 40 min");
    expect(startsIn("2026-09-21T12:00:00.000Z", at("10:00"))).toBe("in 2 h");
    expect(startsIn("2026-09-21T12:30:00.000Z", at("10:00"))).toBe("in 2 h 30 min");
    expect(startsIn("2026-09-21T09:00:00.000Z", at("10:00"))).toBe("");
    expect(startsIn("2026-09-22T09:00:00.000Z", at("10:00"))).toBe("");
    expect(startsIn(null, at("10:00"))).toBe("");
  });

  it("draws a sender from their name", () => {
    expect(initials("Dana Whitfield")).toBe("DW");
    expect(initials("GitHub")).toBe("G");
    expect(initials("")).toBe("•");
    expect(hueOf("Dana")).toBe(hueOf("Dana"));
    expect(hueOf("Dana")).toBeLessThan(360);
  });

  it("lets only web links leave a report", () => {
    expect(isWebUrl("https://mail.google.com/mail/u/0/#all/1")).toBe(true);
    expect(isWebUrl("javascript:alert(1)")).toBe(false);
    expect(isWebUrl("pistachio://settings")).toBe(false);
    expect(isWebUrl("file:///etc/passwd")).toBe(false);
    expect(isWebUrl(null)).toBe(false);
  });

  it("accounts for what the brief was made from", () => {
    const source = (name: "calendar" | "gmail" | "todos", state: "ok" | "empty" | "not_connected", count: number) => ({ source: name, state, connectable: false, accountLabel: null, count });
    expect(sourcesLine([source("calendar", "ok", 3), source("gmail", "not_connected", 0), source("todos", "ok", 2)])).toBe("Made from Google Calendar, To-dos.");
    expect(sourcesLine([source("calendar", "empty", 0)])).toBe("No sources had anything for today.");
    expect(builtWithLine({ composer: "jev", composerModel: "typesafe-ai/jev", writer: "anthropic/claude-haiku-4.5", triage: "jev", evaluations: 3, elapsedMs: 1700 })).toBe(
      "Laid out by typesafe-ai/jev, headline by anthropic/claude-haiku-4.5.",
    );
    expect(builtWithLine({ composer: "default", composerModel: null, writer: null, triage: "rules", evaluations: 0, elapsedMs: 4 })).toBe("Built-in layout.");
  });

  it("keys a brief by the viewer's local day", () => {
    expect(localDayOf(new Date(2026, 8, 5, 23, 59))).toBe("2026-09-05");
    expect(briefIsForToday({ date: "2026-09-05" }, "2026-09-05")).toBe(true);
    expect(briefIsForToday({ date: "2026-09-04" }, "2026-09-05")).toBe(false);
  });

  it("offers half hours from four to noon, and keeps a time set some other way", () => {
    const items = briefTimeItems("07:00");
    expect(items[0]?.value).toBe("04:00");
    expect(items.at(-1)?.value).toBe("12:00");
    expect(items).toHaveLength(17);
    expect(briefTimeItems("18:45").map((item) => item.value)).toContain("18:45");
    expect(briefTimeItems("25:99")).toHaveLength(17);
  });

  it("sends the host only what its request accepts, so one long title cannot refuse the whole brief", () => {
    const local = reportLocalOf({
      timezone: "America/New_York",
      locale: "en-US",
      name: "Zach",
      todos: [
        { id: "a", text: "x".repeat(400), done: false, createdAt: 1 },
        { id: "i".repeat(200), text: "an id that does not fit", done: false, createdAt: 2 },
      ],
      recents: [
        { url: "https://example.com/long", title: "t".repeat(240), host: "example.com", atMs: 5 },
        { url: `https://example.com/${"u".repeat(2100)}`, title: "a URL that does not fit", host: "example.com", atMs: 6, visits: 3 },
        { url: "https://example.com/ok", title: "Fine", host: "example.com", atMs: 7, visits: 2 },
      ],
    });
    expect(reportRequestSchema.safeParse({ type: "generate", spaceId: "work", local }).success).toBe(true);
    // Shown text is clipped; what would name something else if clipped is left out.
    expect(local.recents.map((recent) => recent.url)).toEqual(["https://example.com/long", "https://example.com/ok"]);
    expect(local.recents[0]?.title).toHaveLength(200);
    expect(local.recents[0]?.visits).toBe(1);
    expect(local.todos.map((todo) => todo.id)).toEqual(["a"]);
    expect(local.todos[0]?.text).toHaveLength(240);
    // The unfixed shape, for the record: this is what refused the brief.
    expect(reportRequestSchema.safeParse({ type: "generate", spaceId: "work", local: { ...local, recents: [{ url: "https://example.com", title: "t".repeat(240), host: "example.com", atMs: 1, visits: 1 }] } }).success).toBe(false);
  });

  it("joins a generation already under way instead of waiting on a skeleton for news that never comes", () => {
    // A window reloaded while the host is mid-generation: nothing to show, something running.
    expect(briefLoadAction({ report: null, generating: true }, false)).toBe("join");
    // Another window is refreshing a brief this one already shows: join, so the new one lands here too.
    expect(briefLoadAction({ report: {}, generating: true }, false)).toBe("join");
    expect(briefLoadAction({ report: null, generating: false }, false)).toBe("generate");
    expect(briefLoadAction({ report: {}, generating: false }, false)).toBe("show");
    // An archived day is only ever read.
    expect(briefLoadAction({ report: null, generating: true }, true)).toBe("show");
    expect(briefLoadAction({ report: null, generating: false }, true)).toBe("show");
  });

  it("makes the brief's ticks agree with the home page's to-dos in both directions", () => {
    const current = { "todo:a": true, "todo:b": true, "mail:m1": true };
    // a was reopened on the home page, b is still done, c was finished there, d is open and was never ticked.
    expect(tickChanges(current, { "todo:a": false, "todo:b": true, "todo:c": true, "todo:d": false })).toEqual([
      { key: "todo:a", value: false },
      { key: "todo:c", value: true },
    ]);
    // Ticks the home page has no say over are left alone.
    expect(tickChanges(current, {})).toEqual([]);
  });
});
