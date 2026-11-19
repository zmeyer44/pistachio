/**
 * An extension that runs by itself, as the shell says it (docs/primitives.md
 * §3): where the clock has each declared trigger, and what the extension did
 * with nobody there — main's record (`ExtensionJournalEntry`), in the shell's
 * words, never the extension's. Apart from the store and the page, so a test
 * reads it without either.
 *
 * The lines themselves ("Sundays 8:00 AM–11:00 PM") are main's, made from
 * the declared data (`ExtensionTriggerInfo.text`, `ExtensionSheet.runs`).
 */

import { formatReturn } from "@pistachio/shell-contracts/away";
import type { ExtensionInfo, ExtensionJournalEntry, ExtensionTriggerInfo } from "@pistachio/shell-contracts/extensions";
import { themeJournalLine } from "./shown";

export interface TimeWords {
  timeZone?: string;
  locale?: string;
}

/** The sheet's and the page's heading for an extension's triggers. */
export const RUNS_HEADING = "Runs by itself";
/**
 * What the sheet says under the lines when main sent no sentence of its own (`ExtensionSheet.runsLimit`, made from
 * what the extension asks for): what code may do with nobody there, and that it is undone at a press.
 */
export const RUNS_LIMIT = "With nobody there it can only do what can be undone. What it does to your spaces and tabs is listed, and can be undone.";
/** An extension's triggers paused by the person. */
export const TRIGGERS_PAUSED_LINE = "Paused: it runs only when you run it";
/** Every extension's paused (*Pause all*). */
export const ALL_PAUSED_LINE = "Nothing runs by itself: paused";
export const JOURNAL_HEADING = "What it did";

const DAY_MS = 86_400_000;

/**
 * A time as a row says it, to come or gone by: "today 8:00 PM", "tomorrow 8:00 AM", "yesterday 11:00 PM", within a
 * week ahead the day ("Sun 8:00 AM") — and within six days behind, so a day's name is never last week's same day —
 * past that the date ("Nov 29, 8:00 AM"): an away space's own wording (formatReturn), which only looks ahead, with
 * the days behind added.
 */
export function formatWhen(at: number, now: number, options: TimeWords = {}): string {
  if (at >= now) return formatReturn(at, now, options);
  const zone = options.timeZone === undefined ? {} : { timeZone: options.timeZone };
  const day = (instant: number): string => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", ...zone }).format(instant);
  // (Today is formatReturn's to say; so is the date, for what is more than a week gone.)
  if (day(at) === day(now) || now - at >= 6 * DAY_MS) return formatReturn(at, now, options);
  const time = new Intl.DateTimeFormat(options.locale, { hour: "numeric", minute: "2-digit", ...zone }).format(at).replace(/[\u202f\u00a0]/gu, " ");
  if (day(at) === day(now - DAY_MS)) return `yesterday ${time}`;
  return `${new Intl.DateTimeFormat(options.locale, { weekday: "short", ...zone }).format(at)} ${time}`;
}

/** A signal main cannot read (docs/primitives.md §3.6): neither on nor off. */
export const SIGNAL_UNKNOWN_LINE = "Not known";
/** An event whose handler has not run yet (docs/primitives.md §3.7). */
export const EVENT_UNHEARD_LINE = "Not heard yet";

/**
 * Where the clock has a trigger, beside its line: a window that is on says so and until when ("On now · until today
 * 11:00 PM"); one that is off, an instant and an interval say when they are next ("Next Sun 8:00 AM"). A signal says
 * "On now" or "Off now" — when it changes is not the clock's to say — and one main cannot read says so, with what
 * would let it ("Not known · Connect Google Calendar in Settings"). Null with nothing to say: an instant that never
 * comes, an interval that is not running. An event says when its handler last ran ("Last heard today 2:14 PM") or
 * that it has not yet.
 */
export function triggerStateLine(
  trigger: Pick<ExtensionTriggerInfo, "holds" | "next"> & Partial<Pick<ExtensionTriggerInfo, "unknown" | "needs" | "event" | "last">>,
  now: number,
  options: TimeWords = {},
): string | null {
  if (trigger.event === true) return trigger.last === null || trigger.last === undefined ? EVENT_UNHEARD_LINE : `Last heard ${formatWhen(trigger.last, now, options)}`;
  if (trigger.unknown === true) return trigger.needs === undefined ? SIGNAL_UNKNOWN_LINE : `${SIGNAL_UNKNOWN_LINE} · ${trigger.needs}`;
  if (trigger.holds === true) return trigger.next === null ? "On now" : `On now · until ${formatWhen(trigger.next, now, options)}`;
  if (trigger.next !== null) return `Next ${formatWhen(trigger.next, now, options)}`;
  return trigger.holds === false ? "Off now" : null;
}

/** What a journal entry says was done: `Sent “Football” away`, `Brought “Football” back`, `Made “Chess time”`, `Set a backdrop on “Football”` (or `… on every space`), `Opened docs.google.com/document`. */
export function journalVerbLine(entry: Pick<ExtensionJournalEntry, "verb" | "title"> & Partial<Pick<ExtensionJournalEntry, "spaceId">>): string {
  if (entry.verb === "setTheme") return themeJournalLine({ spaceId: entry.spaceId ?? "", title: entry.title });
  if (entry.verb === "openTab") return entry.title.trim() === "" ? "Opened a tab" : `Opened ${entry.title}`;
  if (entry.verb === "closeSpace") return entry.title.trim() === "" ? "Closed a space" : `Closed “${entry.title}”`;
  if (entry.verb === "makeSpace") return entry.title.trim() === "" ? "Made a space" : `Made “${entry.title}”`;
  const name = entry.title.trim() === "" ? "a space" : `“${entry.title}”`;
  return entry.verb === "sendAway" ? `Sent ${name} away` : `Brought ${name} back`;
}

/** A journal entry's whole line: what was done, and when: `Sent “Football” away · today 11:00 PM`. */
export function journalLine(entry: Pick<ExtensionJournalEntry, "verb" | "title" | "at"> & Partial<Pick<ExtensionJournalEntry, "spaceId">>, now: number, options: TimeWords = {}): string {
  return `${journalVerbLine(entry)} · ${formatWhen(entry.at, now, options)}`;
}

/** An extension's journal as the page lists it: newest first, whatever order main sent. */
export function journalNewestFirst(journal: readonly ExtensionJournalEntry[] | undefined): ExtensionJournalEntry[] {
  return [...(journal ?? [])].sort((a, b) => b.at - a.at);
}

/** Whether an extension declares triggers: it gets the page's *Runs by itself* block. */
export function hasTriggers(extension: Pick<ExtensionInfo, "triggers">): boolean {
  return (extension.triggers?.length ?? 0) > 0;
}

/**
 * Whether an extension gets the page's block at all: it declares triggers, or it did things with nobody there that
 * are still written down. An update that takes its triggers out leaves the journal, and with it every Undo.
 */
export function hasRunsBlock(extension: Pick<ExtensionInfo, "triggers" | "journal">): boolean {
  return hasTriggers(extension) || (extension.journal?.length ?? 0) > 0;
}

/** Whether anything installed runs by itself: *Pause all* is offered only then. */
export function anyTriggers(extensions: readonly Pick<ExtensionInfo, "triggers">[]): boolean {
  return extensions.some(hasTriggers);
}
