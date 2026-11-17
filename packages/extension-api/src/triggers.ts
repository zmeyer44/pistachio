/**
 * Triggers (docs/primitives.md §3): when an extension runs by itself, said
 * as data in `pistachio.json` — so main reads it without running a line of
 * the extension, the sheet says it in the shell's words, and a change to it
 * waits on the person. Five kinds:
 *
 * - `during`: a **window** of the week on the wall clock (`{ days, from,
 *   to }`). Main asks whether it holds; the worker hears when the answer is
 *   not the one it last heard. Nothing fires AT 8:00 — a lid closed across
 *   it changes nothing.
 * - `at`: an **instant** that recurs (`{ days, time }`). The worker hears the
 *   latest one that came due, once, however many passed while the Mac slept.
 * - `every`: an **interval** (`{ minutes, while? }`), on the clock's own
 *   marks (every five minutes is :00, :05, …). The worker hears the latest
 *   mark, once; with `while` — the id of a window or a signal declared beside
 *   it — only while that one holds.
 * - `when`: a **signal** — something main can see and the extension cannot:
 *   the Mac on battery, offline, a second display, nobody at it for ten
 *   minutes, a calendar event with a phrase in its name. The extension is
 *   told one thing of it: whether it holds. The sheet's line is the whole of
 *   what it learns. The browser's own are signals too: a page of a site is
 *   open, a space it was given is in front, more than so many tabs are open.
 * - `on`: an **event** — something that happens and cannot be asked again: a
 *   tab opened, a page of a site arrived, a download finished. The worker is
 *   told while Pistachio is up, soon and together; what happened while it was
 *   not is missed, and is never made up for.
 *
 * No expressions: a rule that needs an `if` is the worker's code. Pure — the
 * schema and the words; the clock is main's (apps/desktop/src/main/extensions/triggers.ts).
 */

import { z } from "zod";

export const TRIGGER_DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type TriggerDay = (typeof TRIGGER_DAYS)[number];

/** How many an extension may declare. */
export const MAX_TRIGGERS = 8;

export const TRIGGER_ID_PATTERN = /^[a-z][a-z0-9-]{0,23}$/;
/** `08:00`, `23:30`: twenty-four hours, two digits each. */
export const TRIGGER_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
/** A window may also end at `24:00`, the end of its day. */
export const TRIGGER_END_PATTERN = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

/** An IANA zone this runtime knows (`America/Chicago`). */
export function isTriggerZone(value: string): boolean {
  if (value === "" || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const days = z.array(z.enum(TRIGGER_DAYS)).min(1).max(7);
const zone = z.string().refine(isTriggerZone, { message: "an IANA time zone like America/Chicago (leave it out for the Mac's own)" });
const time = z.string().regex(TRIGGER_TIME_PATTERN, "a time of day like 08:00 or 23:30 (24 hours, two digits each)");
const end = z.string().regex(TRIGGER_END_PATTERN, "a time of day like 23:00, or 24:00 for the end of the day");

/**
 * A window of the week. `days` are the days it STARTS on (every day when left out). `to` at or before `from` ends
 * the next day (`22:00`–`06:00`); `24:00` is the end of the day it started on. On the Mac's own clock unless `zone`.
 */
export const triggerWindowSchema = z.object({ days: days.optional(), from: time, to: end, zone: zone.optional() }).strict();

/** An instant that recurs: `time` on each of `days` (every day when left out). */
export const triggerInstantSchema = z.object({ days: days.optional(), time, zone: zone.optional() }).strict();

const id = z.string().regex(TRIGGER_ID_PATTERN, "lowercase letters, digits and dashes");

/** An interval's bounds, in minutes: a worker is not woken more than once a minute; past a day, `at` says it better. */
export const EVERY_MINUTES_MIN = 1;
export const EVERY_MINUTES_MAX = 24 * 60;

/**
 * An interval: every `minutes`, on the clock's own marks. `while` names a window (`during`) or a signal (`when`)
 * declared beside it: the interval runs only while that one holds.
 */
export const triggerEverySchema = z
  .object({
    minutes: z.number().int().min(EVERY_MINUTES_MIN, "once a minute at most").max(EVERY_MINUTES_MAX, "a day at most: past that, say a time with \"at\""),
    while: id.optional(),
  })
  .strict();

/** How long nobody has used the Mac, at least, for `idle` to hold. */
export const IDLE_MINUTES_MIN = 1;
export const IDLE_MINUTES_MAX = 240;
/** The phrase a calendar event's name must hold: long enough that it is not every event. */
export const CALENDAR_TITLE_MIN = 3;
export const CALENDAR_TITLE_MAX = 40;
/** How long before an event starts its signal may already hold. */
export const CALENDAR_EARLY_MAX = 30;

const phrase = z
  .string()
  .max(CALENDAR_TITLE_MAX)
  // eslint-disable-next-line no-control-regex
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), { message: "one line: no line breaks or control characters" })
  .refine((value) => value.trim().length >= CALENDAR_TITLE_MIN, { message: `a phrase of the event's name, ${String(CALENDAR_TITLE_MIN)} characters at least ("stand-up")` });

/** A page signal's host: a site by name (`meet.google.com`), or `*.google.com` for it and every site under it. Never every site. */
export const PAGE_HOST_PATTERN = /^(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;
export const PAGE_HOST_MAX = 120;
/** A page signal's path: the start of the page's path (`/spreadsheets`). */
export const PAGE_PATH_MAX = 120;
/** How many tabs a `tabs` signal may count past. */
export const TABS_OVER_MAX = 500;

/**
 * The endings a wildcard must not stand on, beyond a bare one (`*.com`): the country ones under which anyone may
 * register a site. The common ones — the whole list is the Public Suffix List's, which this package does not carry.
 */
const SHARED_ENDINGS = new Set(
  "co.uk org.uk ac.uk gov.uk me.uk ltd.uk com.au net.au org.au edu.au gov.au co.nz org.nz co.jp ne.jp or.jp ac.jp co.kr or.kr co.in net.in org.in co.za co.il com.br com.cn com.mx com.ar com.tr com.sg com.hk com.tw com.my com.ph com.vn com.ua com.pl com.co com.eg com.sa com.ng com.pk com.bd co.id co.th".split(" "),
);

const pageHost = z
  .string()
  .max(PAGE_HOST_MAX)
  .regex(PAGE_HOST_PATTERN, 'a site by its name, in lower case: "meet.google.com", or "*.google.com" for every site under it (no scheme, no port, no path)')
  // (`*.com` is most of the web: the sites under a name are that name's, never a whole ending's.)
  .refine((value) => !value.startsWith("*.") || (value.slice(2).includes(".") && !SHARED_ENDINGS.has(value.slice(2))), { message: 'a "*." host names one site and those under it ("*.google.com"), never a whole ending ("*.com", "*.co.uk")' });
const pagePath = z
  .string()
  .max(PAGE_PATH_MAX)
  .regex(/^\/[^\s?#*]*$/, 'the start of the page\'s path: "/spreadsheets" (no query, no #, no *)');

/** The pages a `page` signal or event means: those of `host`, and — with `path` — those whose path starts with it. */
export const triggerPageSchema = z.object({ host: pageHost, path: pagePath.optional() }).strict();
export type TriggerPage = z.infer<typeof triggerPageSchema>;

/** Whether an address is one a page signal means: an http(s) page of its host (any port), under its path. */
export function pageMatches(page: TriggerPage, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const hostname = parsed.hostname.toLowerCase();
  const base = page.host.startsWith("*.") ? page.host.slice(2) : page.host;
  if (hostname !== base && !(page.host.startsWith("*.") && hostname.endsWith(`.${base}`))) return false;
  return page.path === undefined || parsed.pathname.startsWith(page.path);
}

/** The kinds of signal, as a `when` names one. */
export const SIGNAL_KINDS = ["power", "network", "display", "idle", "calendar", "screen", "page", "space", "tabs"] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];
/** The signals read from the browser itself rather than the Mac: looked at again whenever the tabs change. */
export const BROWSER_SIGNAL_KINDS: readonly SignalKind[] = ["page", "space", "tabs"];

/**
 * A signal: one thing main can see, said so that it either holds or does not. Exactly one of:
 *
 * - `power`: the Mac is on `battery`, or `plugged` in;
 * - `network`: it is `offline`, or `online`;
 * - `display`: an `external` display is connected;
 * - `idle`: nobody has used it for `minutes`;
 * - `calendar`: an event with `title` in its name (any case) is on — from `early` minutes before it starts;
 * - `screen`: the Mac's screen is `locked`;
 * - `page`: a page of `host` is open in a tab (with `path`, one whose path starts with it);
 * - `space`: a space the person gave the extension is in `front`;
 * - `tabs`: more than `over` tabs are open.
 */
export type TriggerWhen =
  | { power: "battery" | "plugged" }
  | { network: "offline" | "online" }
  | { display: "external" }
  | { idle: { minutes: number } }
  | { calendar: { title: string; early?: number } }
  | { screen: "locked" }
  | { page: TriggerPage }
  | { space: "front" }
  | { tabs: { over: number } };

/** How many of `keys` a value names: a signal, and a trigger, is exactly one kind. */
const named = (value: Record<string, unknown>, keys: readonly string[]): string[] => keys.filter((key) => value[key] !== undefined);

// (One object with each kind optional and a check that exactly one is there, rather than a union: a union's refusal
// is "invalid input" at the trigger, and whoever wrote the manifest — an agent, reading its status file — needs the
// path and the sentence of the one thing that is wrong.)
export const triggerWhenSchema = z
  .object({
    power: z.enum(["battery", "plugged"]).optional(),
    network: z.enum(["offline", "online"]).optional(),
    display: z.literal("external").optional(),
    idle: z.object({ minutes: z.number().int().min(IDLE_MINUTES_MIN).max(IDLE_MINUTES_MAX) }).strict().optional(),
    calendar: z.object({ title: phrase, early: z.number().int().min(0).max(CALENDAR_EARLY_MAX).optional() }).strict().optional(),
    screen: z.literal("locked").optional(),
    page: triggerPageSchema.optional(),
    space: z.literal("front").optional(),
    tabs: z.object({ over: z.number().int().min(1).max(TABS_OVER_MAX) }).strict().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (named(value, SIGNAL_KINDS).length !== 1) ctx.addIssue({ code: "custom", message: `a signal is exactly one of ${SIGNAL_KINDS.map((kind) => `"${kind}"`).join(", ")}: { "power": "battery" }, { "calendar": { "title": "stand-up" } }, { "page": { "host": "meet.google.com" } }` });
  }) as unknown as z.ZodType<TriggerWhen>;

/** The kinds of event, as an `on` names one. */
export const EVENT_KINDS = ["tab", "page", "download"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/**
 * An event: one thing that happens in the browser. Exactly one of:
 *
 * - `tab`: a tab is `opened`, `closed`, or `shown` (it comes in front);
 * - `page`: a tab arrives at a page of `host` (with `path`, one whose path starts with it);
 * - `download`: a download is `finished`.
 */
export type TriggerOn = { tab: "opened" | "closed" | "shown" } | { page: TriggerPage } | { download: "finished" };

export const triggerOnSchema = z
  .object({ tab: z.enum(["opened", "closed", "shown"]).optional(), page: triggerPageSchema.optional(), download: z.literal("finished").optional() })
  .strict()
  .superRefine((value, ctx) => {
    if (named(value, EVENT_KINDS).length !== 1) ctx.addIssue({ code: "custom", message: `an event is exactly one of ${EVENT_KINDS.map((kind) => `"${kind}"`).join(", ")}: { "tab": "opened" }, { "page": { "host": "github.com" } }, { "download": "finished" }` });
  }) as unknown as z.ZodType<TriggerOn>;

export type TriggerWindow = z.infer<typeof triggerWindowSchema>;
export type TriggerInstant = z.infer<typeof triggerInstantSchema>;
export type TriggerEvery = z.infer<typeof triggerEverySchema>;
export type TriggerDecl =
  | { id: string; during: TriggerWindow }
  | { id: string; at: TriggerInstant }
  | { id: string; every: TriggerEvery }
  | { id: string; when: TriggerWhen }
  | { id: string; on: TriggerOn };

export const TRIGGER_KINDS = ["during", "at", "every", "when", "on"] as const;

export const triggerSchema = z
  .object({
    id,
    during: triggerWindowSchema.optional(),
    at: triggerInstantSchema.optional(),
    every: triggerEverySchema.optional(),
    when: triggerWhenSchema.optional(),
    on: triggerOnSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (named(value, TRIGGER_KINDS).length !== 1) ctx.addIssue({ code: "custom", message: `a trigger is exactly one of "during" (a window of the week), "at" (a time), "every" (an interval), "when" (a signal) or "on" (an event)` });
  }) as unknown as z.ZodType<TriggerDecl>;

export function signalKind(when: TriggerWhen): SignalKind {
  return SIGNAL_KINDS.find((kind) => kind in when) as SignalKind;
}

export function eventKind(on: TriggerOn): EventKind {
  return EVENT_KINDS.find((kind) => kind in on) as EventKind;
}

/** Whether a signal is read from the browser itself (a page open, a space in front, the tabs' count). */
export function isBrowserSignal(when: TriggerWhen): boolean {
  return BROWSER_SIGNAL_KINDS.includes(signalKind(when));
}

/** Whether a trigger is one that holds or does not (a window, a signal): what an interval's `while` may name. */
export function isLevelTrigger(trigger: TriggerDecl): boolean {
  return "during" in trigger || "when" in trigger;
}

/** What `superRefine` adds to a manifest's issues for its triggers: an id twice, a window of no length, an interval's `while` that names nothing that holds. */
export function triggerIssues(triggers: readonly TriggerDecl[]): { index: number; path: string[]; message: string }[] {
  const issues: { index: number; path: string[]; message: string }[] = [];
  const seen = new Set<string>();
  for (const [index, trigger] of triggers.entries()) {
    if (seen.has(trigger.id)) issues.push({ index, path: ["id"], message: `"${trigger.id}" is declared twice` });
    seen.add(trigger.id);
    if ("during" in trigger && trigger.during.from === trigger.during.to) {
      issues.push({ index, path: ["during", "to"], message: `"from" and "to" are the same time: a window has a length (the whole day is "00:00" to "24:00")` });
    }
    if ("every" in trigger && trigger.every.while !== undefined) {
      const named = triggers.find((candidate) => candidate.id === trigger.every.while);
      if (named === undefined) issues.push({ index, path: ["every", "while"], message: `"${trigger.every.while}" is not a trigger declared here: "while" names the id of a "during" or a "when" beside this one` });
      else if (!isLevelTrigger(named)) issues.push({ index, path: ["every", "while"], message: `"${trigger.every.while}" does not hold or not hold: "while" names a "during" or a "when", never an "at", an "on" or another "every"` });
    }
  }
  return issues;
}

/* ------------------------------- minutes ------------------------------- */

/** `08:30` → 510; `24:00` → 1440. */
export function triggerMinutes(clock: string): number {
  const [hour, minute] = clock.split(":");
  return Number(hour) * 60 + Number(minute);
}

/** How long a window lasts, in minutes: `to` at or before `from` is the next day's. */
export function triggerWindowMinutes(window: Pick<TriggerWindow, "from" | "to">): number {
  const from = triggerMinutes(window.from);
  const to = triggerMinutes(window.to);
  return to > from ? to - from : to + 24 * 60 - from;
}

/** The days a trigger names, in the week's order, each once; all seven when it names none. */
export function triggerDays(declared: readonly TriggerDay[] | undefined): TriggerDay[] {
  return declared === undefined ? [...TRIGGER_DAYS] : TRIGGER_DAYS.filter((day) => declared.includes(day));
}

/* -------------------------------- words -------------------------------- */

const DAY_PLURAL: Record<TriggerDay, string> = { sun: "Sundays", mon: "Mondays", tue: "Tuesdays", wed: "Wednesdays", thu: "Thursdays", fri: "Fridays", sat: "Saturdays" };
const DAY_SHORT: Record<TriggerDay, string> = { sun: "Sun", mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat" };

/** "Sundays", "Weekdays", "Weekends", "Every day", "Mon, Wed and Fri". */
export function triggerDaysInWords(declared: readonly TriggerDay[] | undefined): string {
  const named = triggerDays(declared);
  if (named.length === 7) return "Every day";
  const key = named.join(",");
  if (key === "mon,tue,wed,thu,fri") return "Weekdays";
  if (key === "sun,sat") return "Weekends";
  if (named.length === 1) return DAY_PLURAL[named[0] as TriggerDay];
  const short = named.map((day) => DAY_SHORT[day]);
  return `${short.slice(0, -1).join(", ")} and ${short[short.length - 1] as string}`;
}

/** "8:00 AM", "11:30 PM", "noon", "midnight". */
export function triggerTimeInWords(clock: string): string {
  const minutes = triggerMinutes(clock) % (24 * 60);
  if (minutes === 0) return "midnight";
  if (minutes === 12 * 60) return "noon";
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour % 12 === 0 ? 12 : hour % 12)}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

/** "Every minute", "Every 5 minutes", "Every hour", "Every 2 hours", "Every 90 minutes". */
export function everyInWords(minutes: number): string {
  if (minutes === 1) return "Every minute";
  if (minutes === 60) return "Every hour";
  if (minutes % 60 === 0) return `Every ${String(minutes / 60)} hours`;
  return `Every ${String(minutes)} minutes`;
}

/**
 * A signal as a clause, to stand after "While": "this Mac is on battery", "a calendar event with “stand-up” in its
 * name is on". The shell's words for what the extension is told — one thing, and nothing else of it.
 */
export function signalInWords(when: TriggerWhen): string {
  if ("power" in when) return when.power === "battery" ? "this Mac is on battery" : "this Mac is plugged in";
  if ("network" in when) return when.network === "offline" ? "this Mac is offline" : "this Mac is online";
  if ("display" in when) return "a second display is connected";
  if ("idle" in when) return `nobody has used this Mac for ${when.idle.minutes === 1 ? "a minute" : `${String(when.idle.minutes)} minutes`}`;
  if ("screen" in when) return "this Mac's screen is locked";
  if ("page" in when) return `${pageInWords(when.page)} is open`;
  if ("space" in when) return "a space you gave it is in front";
  if ("tabs" in when) return `more than ${String(when.tabs.over)} tabs are open`;
  const early = when.calendar.early ?? 0;
  return `a calendar event with “${when.calendar.title.trim()}” in its name is on${early === 0 ? "" : `, and for ${early === 1 ? "a minute" : `${String(early)} minutes`} before it`}`;
}

/** The pages a `page` names, as a noun: "a page on meet.google.com", "a page under docs.google.com/spreadsheets", "a page on any google.com site". */
export function pageInWords(page: TriggerPage): string {
  const wild = page.host.startsWith("*.");
  const site = wild ? `any ${page.host.slice(2)} site` : page.host;
  if (page.path === undefined || page.path === "/") return `a page on ${site}`;
  return wild ? `a page under ${page.path} on ${site}` : `a page under ${site}${page.path}`;
}

/** An event as a clause, to stand after "When": "a tab opens", "a page on github.com opens", "a download finishes". */
export function eventInWords(on: TriggerOn): string {
  if ("tab" in on) return on.tab === "opened" ? "a tab opens" : on.tab === "closed" ? "a tab closes" : "a tab comes in front";
  if ("page" in on) return `${pageInWords(on.page)} opens`;
  return "a download finishes";
}

/**
 * A trigger in the shell's words — the sheet's line, the extensions page's, the status file's: "Sundays 8:00
 * AM–11:00 PM", "Fridays 10:00 PM–6:00 AM the next day", "Every day, all day", "Weekdays at 9:00 AM", with the zone
 * when it names one; "Every 5 minutes"; "While this Mac is on battery". Never the extension's own.
 *
 * `all` is the manifest's triggers: an interval that runs `while` another holds says that one's words after its own
 * ("Every 5 minutes, Sundays 8:00 AM–11:00 PM"; "Every 5 minutes while this Mac is on battery"), never its id.
 */
export function triggerInWords(trigger: TriggerDecl, all: readonly TriggerDecl[] = []): string {
  if ("when" in trigger) return `While ${signalInWords(trigger.when)}`;
  if ("on" in trigger) return `When ${eventInWords(trigger.on)}`;
  if ("every" in trigger) {
    const every = everyInWords(trigger.every.minutes);
    const named = trigger.every.while === undefined ? undefined : all.find((candidate) => candidate.id === trigger.every.while);
    if (named === undefined) return every;
    if ("when" in named) return `${every} while ${signalInWords(named.when)}`;
    return "during" in named ? `${every}, ${triggerInWords(named)}` : every;
  }
  if ("during" in trigger) {
    const { days: declared, from, to, zone: named } = trigger.during;
    const whole = triggerWindowMinutes({ from, to }) === 24 * 60;
    // (Ending at midnight — "24:00", or "00:00" — is the end of its day in words, not the next one.)
    const overnight = !whole && triggerMinutes(to) % (24 * 60) !== 0 && triggerMinutes(to) <= triggerMinutes(from);
    const span = whole ? ", all day" : ` ${triggerTimeInWords(from)}–${triggerTimeInWords(to)}${overnight ? " the next day" : ""}`;
    return `${triggerDaysInWords(declared)}${span}${zoneInWords(named)}`;
  }
  return `${triggerDaysInWords(trigger.at.days)} at ${triggerTimeInWords(trigger.at.time)}${zoneInWords(trigger.at.zone)}`;
}

function zoneInWords(named: string | undefined): string {
  return named === undefined ? "" : ` (${named.replace(/_/g, " ")} time)`;
}

/**
 * A trigger as an approval names it: its id, its kind and everything that decides WHEN — days in the week's order,
 * so a manifest that only reorders them is the same trigger. Two that differ here are two the person must see.
 */
export function triggerKey(trigger: TriggerDecl): string {
  if ("every" in trigger) return JSON.stringify({ id: trigger.id, every: { minutes: trigger.every.minutes, while: trigger.every.while ?? null } });
  if ("when" in trigger) {
    const when = trigger.when;
    if ("idle" in when) return JSON.stringify({ id: trigger.id, when: { idle: when.idle.minutes } });
    // (A phrase is matched in any case, so one that differs only by case is the same signal.)
    if ("calendar" in when) return JSON.stringify({ id: trigger.id, when: { calendar: when.calendar.title.trim().toLowerCase(), early: when.calendar.early ?? 0 } });
    if ("page" in when) return JSON.stringify({ id: trigger.id, when: { page: when.page.host, path: when.page.path ?? null } });
    if ("tabs" in when) return JSON.stringify({ id: trigger.id, when: { tabs: when.tabs.over } });
    return JSON.stringify({ id: trigger.id, when });
  }
  if ("on" in trigger) {
    const on = trigger.on;
    if ("page" in on) return JSON.stringify({ id: trigger.id, on: { page: on.page.host, path: on.page.path ?? null } });
    return JSON.stringify({ id: trigger.id, on });
  }
  if ("during" in trigger) {
    return JSON.stringify({ id: trigger.id, during: { days: triggerDays(trigger.during.days), from: trigger.during.from, to: trigger.during.to, zone: trigger.during.zone ?? null } });
  }
  return JSON.stringify({ id: trigger.id, at: { days: triggerDays(trigger.at.days), time: trigger.at.time, zone: trigger.at.zone ?? null } });
}

/** A manifest's triggers as an approval names them, sorted. */
export function triggerKeys(triggers: readonly TriggerDecl[] | undefined): string[] {
  return (triggers ?? []).map(triggerKey).sort();
}

/** The triggers of a manifest the grant has not seen: new ones, and ones whose times changed. Empty when none. */
export function widenedTriggers(approved: readonly string[] | undefined, triggers: readonly TriggerDecl[] | undefined): TriggerDecl[] {
  const known = new Set(approved ?? []);
  return (triggers ?? []).filter((trigger) => !known.has(triggerKey(trigger)));
}
