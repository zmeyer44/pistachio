/**
 * Triggers as a manifest declares them (../src/triggers.ts; docs/primitives.md §3): what the schema takes and
 * refuses, the shell's words for each, and what an approval names of one.
 */

import { describe, expect, it } from "vitest";
import { validateManifest } from "../src/manifest.js";
import { runsLimit, sheetFor } from "../src/sheet.js";
import {
  MAX_TRIGGERS,
  eventInWords,
  eventKind,
  everyInWords,
  isBrowserSignal,
  isLevelTrigger,
  isTriggerZone,
  pageInWords,
  pageMatches,
  signalInWords,
  signalKind,
  triggerDays,
  triggerDaysInWords,
  triggerInWords,
  triggerKey,
  triggerKeys,
  triggerMinutes,
  triggerSchema,
  triggerTimeInWords,
  triggerWindowMinutes,
  widenedTriggers,
  type TriggerDecl,
} from "../src/triggers.js";

const BASE = { api: 1, id: "dev.me.game-day", name: "Game day", version: "1.0.0", worker: { type: "web", main: "worker.js" } };
const SUNDAY = { id: "sunday", during: { days: ["sun"], from: "08:00", to: "23:00" } };

function issuesOf(triggers: unknown, base: Record<string, unknown> = BASE): { path: string; message: string }[] {
  const result = validateManifest({ ...base, triggers });
  return result.ok ? [] : result.issues;
}

const pathsOf = (triggers: unknown, base?: Record<string, unknown>): string[] => issuesOf(triggers, base).map((issue) => issue.path);

const decl = (value: unknown): TriggerDecl => triggerSchema.parse(value);

describe("a manifest's triggers", () => {
  it("takes a window of the week and an instant that recurs, with or without days and a zone", () => {
    expect(
      issuesOf([
        SUNDAY,
        { id: "night", during: { days: ["fri", "sat"], from: "22:00", to: "06:00" } },
        { id: "all-day", during: { from: "00:00", to: "24:00" } },
        { id: "market", during: { days: ["mon", "tue", "wed", "thu", "fri"], from: "09:30", to: "16:00", zone: "America/New_York" } },
        { id: "standup", at: { days: ["mon"], time: "09:00" } },
        { id: "daily", at: { time: "07:15", zone: "Europe/Lisbon" } },
      ]),
    ).toEqual([]);
  });

  it("refuses a time that is not one: one digit, an hour past 23, a minute past 59, words", () => {
    for (const from of ["8:00", "24:00", "08:60", "8am", "0800", ""]) expect(pathsOf([{ id: "x", during: { from, to: "23:00" } }]), from).toContain("triggers.0.during.from");
    for (const time of ["9:00", "24:00", "noon"]) expect(pathsOf([{ id: "x", at: { time } }]), time).toContain("triggers.0.at.time");
    expect(issuesOf([{ id: "x", during: { from: "8:00", to: "23:00" } }])[0]?.message).toContain("08:00");
  });

  it("takes 24:00 only as the end of a window", () => {
    expect(issuesOf([{ id: "x", during: { from: "20:00", to: "24:00" } }])).toEqual([]);
    expect(pathsOf([{ id: "x", during: { from: "24:00", to: "08:00" } }])).toContain("triggers.0.during.from");
    expect(pathsOf([{ id: "x", during: { from: "20:00", to: "24:30" } }])).toContain("triggers.0.during.to");
    expect(pathsOf([{ id: "x", during: { from: "20:00", to: "25:00" } }])).toContain("triggers.0.during.to");
  });

  it("refuses a window of no length, and says how the whole day is written", () => {
    const issues = issuesOf([{ id: "x", during: { from: "08:00", to: "08:00" } }]);
    expect(issues).toEqual([{ path: "triggers.0.during.to", message: expect.stringContaining('"00:00" to "24:00"') }]);
  });

  it("refuses an id declared twice, and one that is not a lowercase slug", () => {
    expect(issuesOf([SUNDAY, { id: "sunday", at: { time: "09:00" } }])).toEqual([{ path: "triggers.1.id", message: '"sunday" is declared twice' }]);
    for (const id of ["Sunday", "1st", "", "a b", "x".repeat(25)]) expect(issuesOf([{ ...SUNDAY, id }]).length, id).toBeGreaterThan(0);
  });

  it("refuses a zone this runtime does not know, and says what one looks like", () => {
    const issues = issuesOf([{ id: "x", during: { from: "08:00", to: "23:00", zone: "Mars/Olympus" } }]);
    expect(issues.some((issue) => issue.message.includes("America/Chicago"))).toBe(true);
    expect(isTriggerZone("America/Chicago")).toBe(true);
    expect(isTriggerZone("UTC")).toBe(true);
    expect(isTriggerZone("")).toBe(false);
    expect(isTriggerZone("Mars/Olympus")).toBe(false);
  });

  it("refuses a day that is not one, no days at all, an expression, and a trigger that is both kinds or neither", () => {
    expect(issuesOf([{ id: "x", during: { days: ["sunday"], from: "08:00", to: "23:00" } }]).length).toBeGreaterThan(0);
    expect(issuesOf([{ id: "x", during: { days: [], from: "08:00", to: "23:00" } }]).length).toBeGreaterThan(0);
    expect(issuesOf([{ id: "x", during: { from: "08:00", to: "23:00", if: "weather.rain" } }]).length).toBeGreaterThan(0);
    expect(issuesOf([{ id: "x", during: { from: "08:00", to: "23:00" }, at: { time: "09:00" } }]).length).toBeGreaterThan(0);
    expect(issuesOf([{ id: "x" }]).length).toBeGreaterThan(0);
    expect(issuesOf([{ id: "x", cron: "*/5 * * * *" }]).length).toBeGreaterThan(0);
    expect(issuesOf([{ id: "x" }]).map((issue) => issue.message).join(" ")).toContain('exactly one of "during"');
  });

  it("needs the worker a trigger wakes, and says what to add", () => {
    const { worker: _worker, ...noWorker } = BASE;
    const issues = issuesOf([SUNDAY], noWorker);
    expect(issues).toEqual([{ path: "worker", message: expect.stringContaining("pistachio.triggers.on") }]);
    expect(issuesOf([], noWorker)).toEqual([]);
  });

  it("takes eight and no more", () => {
    const many = (count: number): unknown[] => Array.from({ length: count }, (_, index) => ({ id: `t${String(index)}`, at: { time: "09:00" } }));
    expect(issuesOf(many(MAX_TRIGGERS))).toEqual([]);
    expect(pathsOf(many(MAX_TRIGGERS + 1))).toContain("triggers");
  });
});

describe("a trigger in the shell's words", () => {
  it("names the days: every day, weekdays, weekends, one, several — in the week's order however written", () => {
    expect(triggerDaysInWords(undefined)).toBe("Every day");
    expect(triggerDaysInWords(["sat", "fri", "thu", "wed", "tue", "mon", "sun"])).toBe("Every day");
    expect(triggerDaysInWords(["fri", "mon", "wed", "tue", "thu"])).toBe("Weekdays");
    expect(triggerDaysInWords(["sat", "sun"])).toBe("Weekends");
    expect(triggerDaysInWords(["sun"])).toBe("Sundays");
    expect(triggerDaysInWords(["wed"])).toBe("Wednesdays");
    expect(triggerDaysInWords(["fri", "mon"])).toBe("Mon and Fri");
    expect(triggerDaysInWords(["fri", "mon", "wed", "mon"])).toBe("Mon, Wed and Fri");
    expect(triggerDays(["sat", "sun", "sat"])).toEqual(["sun", "sat"]);
  });

  it("says a time of day the way a clock on the wall does", () => {
    expect(triggerTimeInWords("08:00")).toBe("8:00 AM");
    expect(triggerTimeInWords("23:30")).toBe("11:30 PM");
    expect(triggerTimeInWords("00:05")).toBe("12:05 AM");
    expect(triggerTimeInWords("12:30")).toBe("12:30 PM");
    expect(triggerTimeInWords("12:00")).toBe("noon");
    expect(triggerTimeInWords("00:00")).toBe("midnight");
    expect(triggerTimeInWords("24:00")).toBe("midnight");
  });

  it("says a window: its days and its span, the next day when it runs past midnight, all day when it is one", () => {
    expect(triggerInWords(decl(SUNDAY))).toBe("Sundays 8:00 AM–11:00 PM");
    expect(triggerInWords(decl({ id: "x", during: { from: "08:00", to: "23:00" } }))).toBe("Every day 8:00 AM–11:00 PM");
    expect(triggerInWords(decl({ id: "x", during: { days: ["fri"], from: "22:00", to: "06:00" } }))).toBe("Fridays 10:00 PM–6:00 AM the next day");
    expect(triggerInWords(decl({ id: "x", during: { days: ["sat", "sun"], from: "20:00", to: "24:00" } }))).toBe("Weekends 8:00 PM–midnight");
    expect(triggerInWords(decl({ id: "x", during: { days: ["mon", "tue", "wed", "thu", "fri"], from: "00:00", to: "24:00" } }))).toBe("Weekdays, all day");
    expect(triggerInWords(decl({ id: "x", during: { from: "00:00", to: "24:00" } }))).toBe("Every day, all day");
    // (`to` written "00:00" is the instant "24:00" names, and reads the same: the end of its day, not the next one.)
    expect(triggerInWords(decl({ id: "x", during: { days: ["sun"], from: "12:00", to: "00:00" } }))).toBe("Sundays noon–midnight");
  });

  it("says an instant, and the zone of either when it names one", () => {
    expect(triggerInWords(decl({ id: "x", at: { days: ["mon", "tue", "wed", "thu", "fri"], time: "09:00" } }))).toBe("Weekdays at 9:00 AM");
    expect(triggerInWords(decl({ id: "x", at: { time: "12:00" } }))).toBe("Every day at noon");
    expect(triggerInWords(decl({ id: "x", at: { days: ["mon", "thu"], time: "17:45", zone: "America/New_York" } }))).toBe("Mon and Thu at 5:45 PM (America/New York time)");
    expect(triggerInWords(decl({ id: "x", during: { days: ["sun"], from: "08:00", to: "23:00", zone: "Europe/Lisbon" } }))).toBe("Sundays 8:00 AM–11:00 PM (Europe/Lisbon time)");
  });

  it("measures a window: minutes of the day, and how long it lasts", () => {
    expect(triggerMinutes("08:30")).toBe(510);
    expect(triggerMinutes("24:00")).toBe(1440);
    expect(triggerWindowMinutes({ from: "08:00", to: "23:00" })).toBe(15 * 60);
    expect(triggerWindowMinutes({ from: "22:00", to: "06:00" })).toBe(8 * 60);
    expect(triggerWindowMinutes({ from: "00:00", to: "24:00" })).toBe(24 * 60);
    expect(triggerWindowMinutes({ from: "12:00", to: "00:00" })).toBe(12 * 60);
  });
});

describe("a trigger as an approval names it", () => {
  it("is the same trigger whatever order its days and its keys are written in", () => {
    const one = decl({ id: "x", during: { days: ["sat", "sun"], from: "08:00", to: "23:00" } });
    const two = decl({ during: { to: "23:00", from: "08:00", days: ["sun", "sat", "sun"] }, id: "x" });
    expect(triggerKey(one)).toBe(triggerKey(two));
    // (Every day, said or left unsaid.)
    expect(triggerKey(decl({ id: "x", at: { time: "09:00" } }))).toBe(triggerKey(decl({ id: "x", at: { time: "09:00", days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] } })));
  });

  it("is another trigger when its id, its kind, a day, a time or its zone is", () => {
    const base = triggerKey(decl(SUNDAY));
    const others = [
      { ...SUNDAY, id: "sundays" },
      { id: "sunday", during: { days: ["sun", "sat"], from: "08:00", to: "23:00" } },
      { id: "sunday", during: { days: ["sun"], from: "08:30", to: "23:00" } },
      { id: "sunday", during: { days: ["sun"], from: "08:00", to: "24:00" } },
      { id: "sunday", during: { days: ["sun"], from: "08:00", to: "23:00", zone: "America/Chicago" } },
      { id: "sunday", at: { days: ["sun"], time: "08:00" } },
    ];
    for (const other of others) expect(triggerKey(decl(other)), JSON.stringify(other)).not.toBe(base);
    expect(new Set(others.map((other) => triggerKey(decl(other)))).size).toBe(others.length);
  });

  it("names a manifest's, sorted, and none for a manifest with none", () => {
    const a = decl({ id: "b", at: { time: "09:00" } });
    const b = decl(SUNDAY);
    expect(triggerKeys([a, b])).toEqual(triggerKeys([b, a]));
    expect(triggerKeys([a, b])).toHaveLength(2);
    expect(triggerKeys(undefined)).toEqual([]);
    expect(triggerKeys([])).toEqual([]);
  });

  it("finds what the grant has not seen: a new trigger, and one whose times changed — never one removed or reordered", () => {
    const sunday = decl(SUNDAY);
    const standup = decl({ id: "standup", at: { time: "09:00" } });
    const approved = triggerKeys([sunday, standup]);
    expect(widenedTriggers(approved, [standup, sunday])).toEqual([]);
    expect(widenedTriggers(approved, [sunday])).toEqual([]);
    expect(widenedTriggers(approved, undefined)).toEqual([]);
    const later = decl({ ...SUNDAY, during: { ...SUNDAY.during, to: "23:30" } });
    expect(widenedTriggers(approved, [later, standup])).toEqual([later]);
    const added = decl({ id: "night", during: { from: "22:00", to: "06:00" } });
    expect(widenedTriggers(approved, [sunday, standup, added])).toEqual([added]);
    // (A grant from before there were triggers has seen none.)
    expect(widenedTriggers(undefined, [sunday])).toEqual([sunday]);
    expect(widenedTriggers([], [])).toEqual([]);
  });
});

describe("an interval and a signal, as a manifest declares them", () => {
  const BATTERY = { id: "unplugged", when: { power: "battery" } };

  it("takes an interval, alone or while a window or a signal declared beside it holds", () => {
    expect(issuesOf([SUNDAY, BATTERY, { id: "scores", every: { minutes: 5, while: "sunday" } }, { id: "save", every: { minutes: 1, while: "unplugged" } }, { id: "hourly", every: { minutes: 60 } }])).toEqual([]);
  });

  it("refuses an interval of less than a minute, more than a day, or not whole — and says what to write past a day", () => {
    for (const minutes of [0, 0.5, -5, 1441, "5"]) expect(pathsOf([{ id: "x", every: { minutes } }]), String(minutes)).toContain("triggers.0.every.minutes");
    expect(issuesOf([{ id: "x", every: { minutes: 2000 } }])[0]?.message).toContain('"at"');
    expect(issuesOf([{ id: "x", every: { minutes: 1440 } }])).toEqual([]);
  });

  it("refuses a `while` that names nothing declared, itself, an instant or another interval", () => {
    expect(issuesOf([{ id: "x", every: { minutes: 5, while: "sunday" } }])[0]).toMatchObject({ path: "triggers.0.every.while" });
    expect(issuesOf([{ id: "x", every: { minutes: 5, while: "sunday" } }])[0]?.message).toContain('"during" or a "when"');
    expect(pathsOf([{ id: "x", every: { minutes: 5, while: "x" } }])).toContain("triggers.0.every.while");
    expect(pathsOf([{ id: "nine", at: { time: "09:00" } }, { id: "x", every: { minutes: 5, while: "nine" } }])).toContain("triggers.1.every.while");
    expect(pathsOf([{ id: "a", every: { minutes: 5 } }, { id: "x", every: { minutes: 5, while: "a" } }])).toContain("triggers.1.every.while");
  });

  it("takes each signal: power, network, a display, idle, a calendar event by a phrase of its name", () => {
    expect(
      issuesOf([
        BATTERY,
        { id: "charging", when: { power: "plugged" } },
        { id: "offline", when: { network: "offline" } },
        { id: "docked", when: { display: "external" } },
        { id: "gone", when: { idle: { minutes: 10 } } },
        { id: "standup", when: { calendar: { title: "stand-up", early: 2 } } },
        { id: "focus", when: { calendar: { title: "Focus" } } },
      ]),
    ).toEqual([]);
  });

  it("refuses a signal that is two things, none, or one it does not know — and an expression", () => {
    for (const when of [{}, { power: "battery", network: "offline" }, { power: "low" }, { network: "wifi" }, { display: "internal" }, { volume: "muted" }, { if: "battery && offline" }]) {
      expect(issuesOf([{ id: "x", when }]).length, JSON.stringify(when)).toBeGreaterThan(0);
    }
  });

  it("bounds idle and a calendar's phrase: a phrase too short would be every event", () => {
    for (const minutes of [0, 241, 1.5]) expect(issuesOf([{ id: "x", when: { idle: { minutes } } }]).length, String(minutes)).toBeGreaterThan(0);
    for (const title of ["", "a", "  ab  ", "x".repeat(41), "stand\nup"]) expect(issuesOf([{ id: "x", when: { calendar: { title } } }]).length, JSON.stringify(title)).toBeGreaterThan(0);
    for (const early of [-1, 31, 2.5]) expect(issuesOf([{ id: "x", when: { calendar: { title: "stand-up", early } } }]).length, String(early)).toBeGreaterThan(0);
    // (Nothing of the event beyond a phrase of its name can be asked for.)
    expect(issuesOf([{ id: "x", when: { calendar: { title: "stand-up", attendee: "sam" } } }]).length).toBeGreaterThan(0);
  });

  it("knows which triggers hold or do not, and a signal's kind", () => {
    expect(isLevelTrigger(decl(SUNDAY))).toBe(true);
    expect(isLevelTrigger(decl(BATTERY))).toBe(true);
    expect(isLevelTrigger(decl({ id: "x", at: { time: "09:00" } }))).toBe(false);
    expect(isLevelTrigger(decl({ id: "x", every: { minutes: 5 } }))).toBe(false);
    expect(signalKind({ idle: { minutes: 5 } })).toBe("idle");
    expect(signalKind({ calendar: { title: "stand-up" } })).toBe("calendar");
  });
});

describe("an interval and a signal in the shell's words", () => {
  it("says an interval the way a person would", () => {
    expect([1, 5, 60, 90, 120, 1440].map(everyInWords)).toEqual(["Every minute", "Every 5 minutes", "Every hour", "Every 90 minutes", "Every 2 hours", "Every 24 hours"]);
  });

  it("says what an interval runs while — in that trigger's words, never its id", () => {
    const all = [decl(SUNDAY), decl({ id: "unplugged", when: { power: "battery" } }), decl({ id: "scores", every: { minutes: 5, while: "sunday" } }), decl({ id: "save", every: { minutes: 10, while: "unplugged" } })];
    expect(triggerInWords(all[2] as TriggerDecl, all)).toBe("Every 5 minutes, Sundays 8:00 AM–11:00 PM");
    expect(triggerInWords(all[3] as TriggerDecl, all)).toBe("Every 10 minutes while this Mac is on battery");
    expect(triggerInWords(decl({ id: "hourly", every: { minutes: 60 } }), all)).toBe("Every hour");
    // (Without the manifest beside it, an interval still says its own rhythm.)
    expect(triggerInWords(all[2] as TriggerDecl)).toBe("Every 5 minutes");
  });

  it("says each signal as the one thing the extension is told", () => {
    expect(triggerInWords(decl({ id: "x", when: { power: "battery" } }))).toBe("While this Mac is on battery");
    expect(triggerInWords(decl({ id: "x", when: { power: "plugged" } }))).toBe("While this Mac is plugged in");
    expect(triggerInWords(decl({ id: "x", when: { network: "offline" } }))).toBe("While this Mac is offline");
    expect(triggerInWords(decl({ id: "x", when: { network: "online" } }))).toBe("While this Mac is online");
    expect(triggerInWords(decl({ id: "x", when: { display: "external" } }))).toBe("While a second display is connected");
    expect(triggerInWords(decl({ id: "x", when: { idle: { minutes: 10 } } }))).toBe("While nobody has used this Mac for 10 minutes");
    expect(triggerInWords(decl({ id: "x", when: { idle: { minutes: 1 } } }))).toBe("While nobody has used this Mac for a minute");
    expect(triggerInWords(decl({ id: "x", when: { calendar: { title: " stand-up " } } }))).toBe("While a calendar event with “stand-up” in its name is on");
    expect(signalInWords({ calendar: { title: "stand-up", early: 5 } })).toBe("a calendar event with “stand-up” in its name is on, and for 5 minutes before it");
  });

  it("names them for an approval: a new rhythm, another `while`, another phrase or lead is another trigger; a phrase's case is not", () => {
    const key = (value: unknown): string => triggerKey(decl(value));
    expect(key({ id: "s", every: { minutes: 5 } })).not.toBe(key({ id: "s", every: { minutes: 1 } }));
    expect(key({ id: "s", every: { minutes: 5 } })).not.toBe(key({ id: "s", every: { minutes: 5, while: "sunday" } }));
    expect(key({ id: "s", when: { power: "battery" } })).not.toBe(key({ id: "s", when: { power: "plugged" } }));
    expect(key({ id: "s", when: { idle: { minutes: 5 } } })).not.toBe(key({ id: "s", when: { idle: { minutes: 10 } } }));
    expect(key({ id: "s", when: { calendar: { title: "stand-up" } } })).not.toBe(key({ id: "s", when: { calendar: { title: "review" } } }));
    expect(key({ id: "s", when: { calendar: { title: "stand-up" } } })).not.toBe(key({ id: "s", when: { calendar: { title: "stand-up", early: 5 } } }));
    expect(key({ id: "s", when: { calendar: { title: "Stand-Up" } } })).toBe(key({ id: "s", when: { calendar: { title: "stand-up", early: 0 } } }));
    expect(widenedTriggers([key({ id: "s", when: { power: "battery" } })], [decl({ id: "s", when: { power: "plugged" } })])).toHaveLength(1);
  });
});

describe("the browser's own signals, and the screen", () => {
  it("takes a page of a site, a given space in front, a count of tabs and a locked screen", () => {
    expect(
      issuesOf([
        { id: "meet", when: { page: { host: "meet.google.com" } } },
        { id: "sheets", when: { page: { host: "docs.google.com", path: "/spreadsheets" } } },
        { id: "google", when: { page: { host: "*.google.com" } } },
        { id: "local", when: { page: { host: "localhost" } } },
        { id: "here", when: { space: "front" } },
        { id: "many", when: { tabs: { over: 30 } } },
        { id: "locked", when: { screen: "locked" } },
      ]),
    ).toEqual([]);
  });

  it("refuses a host that is every site, an address, a port or a pattern in the middle — and says what one looks like", () => {
    for (const host of ["*", "*.*", "*.com", "*.co.uk", "*.com.au", "https://meet.google.com", "meet.google.com:443", "meet.google.com/abc", "meet.*.com", "Meet.Google.com", "", "a b.com"]) {
      expect(issuesOf([{ id: "x", when: { page: { host } } }]).length, JSON.stringify(host)).toBeGreaterThan(0);
    }
    expect(issuesOf([{ id: "x", when: { page: { host: "https://meet.google.com" } } }])[0]?.message).toContain('"meet.google.com"');
    for (const path of ["spreadsheets", "/a b", "/a?b=1", "/a#b", "/a*"]) expect(issuesOf([{ id: "x", when: { page: { host: "docs.google.com", path } } }]).length, path).toBeGreaterThan(0);
    // (Nothing of the page beyond where it is can be asked for.)
    expect(issuesOf([{ id: "x", when: { page: { host: "meet.google.com", title: "Stand-up" } } }]).length).toBeGreaterThan(0);
  });

  it("bounds the tabs' count, and takes no other word for a space or a screen", () => {
    for (const over of [0, 501, 2.5]) expect(issuesOf([{ id: "x", when: { tabs: { over } } }]).length, String(over)).toBeGreaterThan(0);
    expect(issuesOf([{ id: "x", when: { space: "work" } }]).length).toBeGreaterThan(0);
    expect(issuesOf([{ id: "x", when: { screen: "on" } }]).length).toBeGreaterThan(0);
  });

  it("matches a page by its host — exactly, or with every site under it — and the start of its path, on any port", () => {
    const meet = { host: "meet.google.com" };
    expect(pageMatches(meet, "https://meet.google.com/abc-defg-hij")).toBe(true);
    expect(pageMatches(meet, "https://MEET.google.com/")).toBe(true);
    expect(pageMatches(meet, "http://meet.google.com:8080/x?y=1#z")).toBe(true);
    expect(pageMatches(meet, "https://calendar.google.com/")).toBe(false);
    expect(pageMatches(meet, "https://evilmeet.google.com.example.org/")).toBe(false);
    expect(pageMatches(meet, "https://notmeet.google.com/")).toBe(false);
    const google = { host: "*.google.com" };
    expect(pageMatches(google, "https://google.com/")).toBe(true);
    expect(pageMatches(google, "https://docs.google.com/document/d/1")).toBe(true);
    expect(pageMatches(google, "https://notgoogle.com/")).toBe(false);
    const sheets = { host: "docs.google.com", path: "/spreadsheets" };
    expect(pageMatches(sheets, "https://docs.google.com/spreadsheets/d/1")).toBe(true);
    expect(pageMatches(sheets, "https://docs.google.com/document/d/1")).toBe(false);
    // (Never one of Pistachio's own addresses, a file, or something that is not an address.)
    for (const url of ["pistachio://home", "file:///Users/me/meet.google.com", "about:blank", "not a url", ""]) expect(pageMatches(meet, url), url).toBe(false);
  });

  it("says each in the shell's words, and names each for an approval", () => {
    expect(triggerInWords(decl({ id: "x", when: { page: { host: "meet.google.com" } } }))).toBe("While a page on meet.google.com is open");
    expect(triggerInWords(decl({ id: "x", when: { page: { host: "docs.google.com", path: "/spreadsheets" } } }))).toBe("While a page under docs.google.com/spreadsheets is open");
    expect(triggerInWords(decl({ id: "x", when: { page: { host: "*.google.com" } } }))).toBe("While a page on any google.com site is open");
    expect(pageInWords({ host: "*.google.com", path: "/maps" })).toBe("a page under /maps on any google.com site");
    expect(triggerInWords(decl({ id: "x", when: { space: "front" } }))).toBe("While a space you gave it is in front");
    expect(triggerInWords(decl({ id: "x", when: { tabs: { over: 30 } } }))).toBe("While more than 30 tabs are open");
    expect(triggerInWords(decl({ id: "x", when: { screen: "locked" } }))).toBe("While this Mac's screen is locked");
    const key = (value: unknown): string => triggerKey(decl(value));
    expect(key({ id: "s", when: { page: { host: "meet.google.com" } } })).not.toBe(key({ id: "s", when: { page: { host: "zoom.us" } } }));
    expect(key({ id: "s", when: { page: { host: "docs.google.com" } } })).not.toBe(key({ id: "s", when: { page: { host: "docs.google.com", path: "/spreadsheets" } } }));
    expect(key({ id: "s", when: { tabs: { over: 30 } } })).not.toBe(key({ id: "s", when: { tabs: { over: 10 } } }));
    expect(key({ id: "s", when: { page: { host: "meet.google.com" } } })).not.toBe(key({ id: "s", on: { page: { host: "meet.google.com" } } }));
  });

  it("knows which signals are the browser's own", () => {
    expect(isBrowserSignal({ page: { host: "meet.google.com" } })).toBe(true);
    expect(isBrowserSignal({ space: "front" })).toBe(true);
    expect(isBrowserSignal({ tabs: { over: 3 } })).toBe(true);
    expect(isBrowserSignal({ screen: "locked" })).toBe(false);
    expect(isBrowserSignal({ power: "battery" })).toBe(false);
  });
});

describe("an event, as a manifest declares it", () => {
  it("takes a tab opened or closed, a page arriving, a download finished", () => {
    expect(
      issuesOf([
        { id: "opened", on: { tab: "opened" } },
        { id: "closed", on: { tab: "closed" } },
        { id: "shown", on: { tab: "shown" } },
        { id: "pr", on: { page: { host: "github.com", path: "/pulls" } } },
        { id: "done", on: { download: "finished" } },
      ]),
    ).toEqual([]);
  });

  it("refuses an event that is two things, none, or one it does not know", () => {
    for (const on of [{}, { tab: "opened", download: "finished" }, { tab: "moved" }, { download: "started" }, { key: "pressed" }, { page: { host: "*" } }]) {
      expect(issuesOf([{ id: "x", on }]).length, JSON.stringify(on)).toBeGreaterThan(0);
    }
    expect(issuesOf([{ id: "x", on: {} }])[0]?.message).toContain('{ "tab": "opened" }');
    // (A trigger is one kind: an event is not also a signal.)
    expect(issuesOf([{ id: "x", on: { tab: "opened" }, when: { power: "battery" } }]).length).toBeGreaterThan(0);
  });

  it("is not something that holds: an interval cannot run while one", () => {
    expect(isLevelTrigger(decl({ id: "x", on: { tab: "opened" } }))).toBe(false);
    const issues = issuesOf([{ id: "opened", on: { tab: "opened" } }, { id: "x", every: { minutes: 5, while: "opened" } }]);
    expect(issues.map((issue) => issue.path)).toContain("triggers.1.every.while");
    expect(issues[0]?.message).toContain('an "on"');
    expect(eventKind({ download: "finished" })).toBe("download");
  });

  it("says each in the shell's words", () => {
    expect(triggerInWords(decl({ id: "x", on: { tab: "opened" } }))).toBe("When a tab opens");
    expect(triggerInWords(decl({ id: "x", on: { tab: "closed" } }))).toBe("When a tab closes");
    expect(triggerInWords(decl({ id: "x", on: { tab: "shown" } }))).toBe("When a tab comes in front");
    expect(triggerInWords(decl({ id: "x", on: { page: { host: "github.com", path: "/pulls" } } }))).toBe("When a page under github.com/pulls opens");
    expect(eventInWords({ download: "finished" })).toBe("a download finishes");
    const key = (value: unknown): string => triggerKey(decl(value));
    expect(key({ id: "s", on: { tab: "opened" } })).not.toBe(key({ id: "s", on: { tab: "closed" } }));
    expect(key({ id: "s", on: { page: { host: "github.com" } } })).not.toBe(key({ id: "s", on: { page: { host: "github.com", path: "/pulls" } } }));
  });
});

describe("what the sheet says an extension may do with nobody there", () => {
  it("says only what it asks for, and that each time can be undone", () => {
    expect(runsLimit({ permissions: ["spaces:write"] })).toBe("With nobody there it can only send away and bring back spaces you gave it. What it does to your spaces and tabs is listed, and can be undone.");
    expect(runsLimit({ permissions: ["tabs:read", "tabs:write"] })).toBe("With nobody there it can only open tabs behind what you are doing. What it does to your spaces and tabs is listed, and can be undone.");
    expect(runsLimit({ permissions: ["spaces:write", "tabs:write", "theme"], band: true })).toBe(
      "With nobody there it can only send away and bring back spaces you gave it, open tabs behind what you are doing, change the backdrop and update what it shows. What it does to your spaces and tabs is listed, and can be undone.",
    );
    // What is not written down is not said to be: rows and marks are removed where they are shown.
    expect(runsLimit({ band: true })).toBe("With nobody there it can only update what it shows.");
  });

  it("says the sites it may talk to and the model it may ask: looking is not all it does with what it sees", () => {
    expect(runsLimit({ permissions: ["tabs:read"], hosts: ["https://api.espn.com/*"] })).toBe("With nobody there it can only talk to api.espn.com.");
    expect(runsLimit({ permissions: ["tabs:read", "ai"] })).toBe("With nobody there it can only ask Pistachio's AI.");
    expect(runsLimit({ permissions: ["spaces:write", "ai"], hosts: ["https://api.espn.com/*", "https://site.api.espn.com/*"] })).toBe(
      "With nobody there it can only send away and bring back spaces you gave it, talk to api.espn.com and site.api.espn.com and ask Pistachio's AI. What it does to your spaces and tabs is listed, and can be undone.",
    );
  });

  it("says so when it can change nothing of the person's", () => {
    expect(runsLimit({ permissions: ["tabs:read", "notifications"] })).toContain("changes nothing of yours");
    expect(runsLimit({})).toContain("changes nothing of yours");
  });

  it("is on the sheet only for an extension that runs by itself", () => {
    const manifest = (extra: Record<string, unknown>) => {
      const result = validateManifest({ ...BASE, permissions: ["spaces:write"], ...extra });
      if (!result.ok) throw new Error(JSON.stringify(result.issues));
      return result.manifest;
    };
    expect(sheetFor(manifest({})).runsLimit).toBeUndefined();
    expect(sheetFor(manifest({ triggers: [{ id: "meet", when: { page: { host: "meet.google.com" } } }] })).runsLimit).toContain("send away and bring back");
    expect(sheetFor(manifest({ triggers: [{ id: "meet", when: { page: { host: "meet.google.com" } } }] })).runs).toEqual(["While a page on meet.google.com is open"]);
  });
});
