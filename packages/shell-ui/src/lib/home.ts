/**
 * The home page's arithmetic (components/home): the greeting, the "2m ago"
 * beside a recent page, which sites earn a tile, the day's to-dos, and the
 * day's schedule out of the reminders. Pure, so the page renders what these
 * say and the tests read them without a DOM.
 */

import type { CalendarAgenda, CalendarAgendaEvent } from "@pistachio/shell-contracts/ipc";
import { calendarItems, dayKey, type CalendarItem, type ReminderSnapshot } from "@pistachio/shell-contracts/reminders";
import type { RecentSite } from "./recents";

/* -------------------------------- greeting ------------------------------- */

/** "Good morning" until noon, "Good afternoon" until five, "Good evening" after. */
export function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 17) return "Good afternoon";
  return "Good evening";
}

/** The greeting, addressed by first name when memory holds one. */
export function greeting(hour: number, name: string): string {
  const first = name.trim().split(/\s+/u)[0] ?? "";
  return first === "" ? greetingFor(hour) : `${greetingFor(hour)}, ${first}`;
}

/* ---------------------------------- time --------------------------------- */

/** How long ago, the way a list of recent pages says it. */
export function relativeTime(atMs: number, nowMs: number): string {
  const minutes = Math.floor(Math.max(0, nowMs - atMs) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${String(days)}d ago`;
  return new Date(atMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Local midnight of the day holding `date`. */
export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Milliseconds until the clock next shows a new minute. */
export function msUntilNextMinute(now: Date): number {
  return 60_000 - (now.getSeconds() * 1_000 + now.getMilliseconds());
}

/* --------------------------------- sites --------------------------------- */

/** A host as a tile names it: no `www.`, lower case. */
export function siteHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./iu, "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * The images to try, in order, for a site's tile: the page's own favicon
 * when a tab has reported one — it is what the sidebar shows for the same
 * site, and the only icon that knows who is signed in (Gmail's page carries
 * the Gmail mark; the favicon service, which never signs in, is shown the
 * sign-in page's plain Google mark) — then the favicon service's 64px
 * rendering of the host. An empty list means the site's letter.
 */
export function siteIconSources(url: string, faviconUrl: string | null): string[] {
  const list: string[] = [];
  if (faviconUrl !== null && faviconUrl !== "") list.push(faviconUrl);
  const host = siteHost(url);
  if (/^https?:\/\//iu.test(url) && host !== "") list.push(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`);
  return list;
}

/**
 * A short name for a site's tile: the part of the page's title that names
 * the site ("Inbox (3) – you@example.com – Gmail" → "Gmail"), else the
 * host's own name ("news.ycombinator.com" → "Ycombinator").
 */
export function siteName(title: string, url: string): string {
  const host = siteHost(url);
  const labels = host.split(".").filter(Boolean);
  const core = (labels.length > 2 && labels.at(-2)!.length <= 3 ? labels.at(-3) : labels.at(-2)) ?? labels[0] ?? "";
  const squash = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/gu, "");
  // The labels that can name a site: not the TLD, not `www`, not the short
  // second levels of a `co.uk` — "com" is in every email address.
  const names = labels.slice(0, -1).map(squash).filter((label) => label.length >= 3 && label !== "www");
  const segments = title.split(/\s+[-–—|·•:/]\s+|\s*[|·•]\s*/u).map((part) => part.trim()).filter(Boolean);
  const named = segments.find((part) => {
    const squashed = squash(part);
    return squashed.length > 0 && squashed.length <= 24 && names.some((label) => squashed === label || squashed.includes(label));
  });
  if (named !== undefined) return named;
  if (segments.length === 1 && segments[0]!.length <= 16) return segments[0]!;
  return core === "" ? title || url : core.charAt(0).toUpperCase() + core.slice(1);
}

/** Recent pages worth offering again: the web's, not the app's own. */
export function browsableRecents(recents: readonly RecentSite[]): RecentSite[] {
  return recents.filter((site) => /^https?:\/\//iu.test(site.url));
}

/**
 * The sites that earn a tile beside the person's favorites: the most
 * visited first, the most recent breaking ties (the list is newest first),
 * never one whose host already has a tile.
 */
export function topSites(recents: readonly RecentSite[], taken: ReadonlySet<string>, limit: number): RecentSite[] {
  if (limit <= 0) return [];
  return browsableRecents(recents)
    .map((site, order) => ({ site, order }))
    .filter(({ site }) => !taken.has(siteHost(site.url)))
    .sort((a, b) => (b.site.visits ?? 1) - (a.site.visits ?? 1) || a.order - b.order)
    .slice(0, limit)
    .map(({ site }) => site);
}

/* --------------------------------- to-dos -------------------------------- */

export interface HomeTodo {
  id: string;
  text: string;
  done: boolean;
  createdAt: number;
  doneAt: number | null;
}

export const MAX_TODO_TEXT = 200;
const MAX_TODOS = 50;
const TODOS_KEY = "pistachio.home.todos";

/**
 * The to-dos as stored, minus anything malformed and anything finished
 * before today: the list is TODAY's, so yesterday's ticks clear themselves
 * while what is still open carries over.
 */
export function parseTodos(raw: string | null, now: Date): HomeTodo[] {
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const today = startOfDay(now).getTime();
  return parsed
    .flatMap((value): HomeTodo[] => {
      if (typeof value !== "object" || value === null) return [];
      const item = value as Record<string, unknown>;
      const { id, text, done, createdAt, doneAt } = item;
      if (typeof id !== "string" || typeof text !== "string" || text.trim() === "" || typeof createdAt !== "number") return [];
      const finished = done === true;
      const finishedAt = typeof doneAt === "number" ? doneAt : null;
      if (finished && (finishedAt === null || finishedAt < today)) return [];
      return [{ id, text: text.slice(0, MAX_TODO_TEXT), done: finished, createdAt, doneAt: finished ? finishedAt : null }];
    })
    .slice(0, MAX_TODOS);
}

export function addTodo(list: readonly HomeTodo[], text: string, now: number, id: string): HomeTodo[] {
  const trimmed = text.trim().slice(0, MAX_TODO_TEXT);
  if (trimmed === "" || list.length >= MAX_TODOS) return [...list];
  return [...list, { id, text: trimmed, done: false, createdAt: now, doneAt: null }];
}

export function toggleTodo(list: readonly HomeTodo[], id: string, now: number): HomeTodo[] {
  return list.map((item) => (item.id === id ? { ...item, done: !item.done, doneAt: item.done ? null : now } : item));
}

export function removeTodo(list: readonly HomeTodo[], id: string): HomeTodo[] {
  return list.filter((item) => item.id !== id);
}

/** Open to-dos first in the order they were added, finished ones after. */
export function orderedTodos(list: readonly HomeTodo[]): HomeTodo[] {
  return [...list.filter((item) => !item.done), ...list.filter((item) => item.done)];
}

export function loadTodos(now: Date): HomeTodo[] {
  try {
    return parseTodos(localStorage.getItem(TODOS_KEY), now);
  } catch {
    return [];
  }
}

export function saveTodos(list: readonly HomeTodo[]): void {
  try {
    localStorage.setItem(TODOS_KEY, JSON.stringify(list));
  } catch {
    // Storage full or blocked: the list lives for this page only.
  }
}

/* -------------------------------- schedule ------------------------------- */

/** One line of the day's schedule: a reminder, or an event from a connected calendar. */
export interface AgendaItem {
  id: string;
  /** The instant, ISO; for an all-day event, the start of the viewer's day. */
  at: string;
  title: string;
  /** A reminder that fired already (it is in the log) or is still to come, or a calendar's event. */
  kind: CalendarItem["kind"] | "event";
  /** Its time has passed — for an event, it has ended. */
  past: boolean;
  /** An event that takes the whole day: it has no time to show, and leads the list. */
  allDay?: boolean;
  /** An event under way right now. */
  live?: boolean;
  /** An event's video call, and where to open the event itself; https only. */
  meetingUrl?: string | null;
  webUrl?: string | null;
}

/**
 * Today's reminders, in order: what already fired (the log) and what is
 * still to come (the schedule's projection) — the same items the reminders
 * page draws on today's cell, from the same `calendarItems`.
 */
export function todayAgenda(snapshot: ReminderSnapshot, now: Date, timezone: string): AgendaItem[] {
  const from = startOfDay(now);
  const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1, 0, 0, 0, -1);
  const items = calendarItems(snapshot, from, to, timezone).get(dayKey(now.toISOString(), timezone)) ?? [];
  return items.map((item) => ({
    id: item.kind === "occurrence" ? item.occurrence.id : `${item.reminder.id}:${item.at}`,
    at: item.at,
    title: item.kind === "occurrence" ? item.occurrence.title : item.reminder.title,
    kind: item.kind,
    past: Date.parse(item.at) <= now.getTime(),
  }));
}

/** A link the schedule may follow: what a calendar says is an address is opened only when it is an https one. */
function httpsOrNull(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * A connected calendar's events as lines of today's schedule. The host asks
 * for the viewer's day, but an all-day event is a pair of dates with no
 * zone, so the calendar can hand back yesterday's or tomorrow's: only one
 * whose dates hold today is kept. A timed event is past once it has ended,
 * not once it has started.
 */
export function eventAgenda(events: readonly CalendarAgendaEvent[], now: Date, timezone: string): AgendaItem[] {
  const today = dayKey(now.toISOString(), timezone);
  const items: AgendaItem[] = [];
  for (const event of events) {
    const links = { meetingUrl: httpsOrNull(event.meetingUrl), webUrl: httpsOrNull(event.webUrl) };
    const title = event.title.trim() === "" ? "(No title)" : event.title;
    if (event.allDay) {
      if (!(event.start <= today && today < event.end)) continue;
      items.push({ id: event.id, at: startOfDay(now).toISOString(), title, kind: "event", past: false, allDay: true, ...links });
      continue;
    }
    const start = Date.parse(event.start);
    const end = Date.parse(event.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    items.push({ id: event.id, at: new Date(start).toISOString(), title, kind: "event", past: end <= now.getTime(), live: start <= now.getTime() && now.getTime() < end, ...links });
  }
  return items;
}

/** One schedule from the two sources: what takes the whole day first, then by the clock, an event ahead of a reminder set for the same minute. */
export function mergeAgenda(reminders: readonly AgendaItem[], events: readonly AgendaItem[]): AgendaItem[] {
  const rank = (item: AgendaItem): number => (item.allDay === true ? 0 : 1);
  return [...events, ...reminders]
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item) - rank(b.item) || Date.parse(a.item.at) - Date.parse(b.item.at) || a.index - b.index)
    .map(({ item }) => item);
}

/** The window the schedule asks a calendar for: the viewer's day, midnight to midnight. */
export function todayWindow(now: Date): { from: string; to: string } {
  const from = startOfDay(now);
  return { from: from.toISOString(), to: new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1).toISOString() };
}

/* ------------------------- the invitation to connect ---------------------- */

const CALENDAR_PROMPT_KEY = "pistachio.home.calendar-prompt-dismissed";

/** Whether the person waved away the schedule's invitation to connect a calendar. Browser-local, like the to-dos. */
export function loadCalendarPromptDismissed(): boolean {
  try {
    return localStorage.getItem(CALENDAR_PROMPT_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveCalendarPromptDismissed(): void {
  try {
    localStorage.setItem(CALENDAR_PROMPT_KEY, "1");
  } catch {
    // Storage is unavailable: the invitation is dismissed for this window only.
  }
}

/**
 * Whether the schedule invites the person to connect Google Calendar: only
 * when there is none, connecting would work (the host says so), and they
 * have not said no. Never while the answer is still unknown — a card that
 * flashes an invitation at someone already connected is wrong for a moment too long.
 */
export function showsCalendarPrompt(agenda: Pick<CalendarAgenda, "status" | "connectable"> | null, dismissed: boolean): boolean {
  return agenda !== null && agenda.status === "not_connected" && agenda.connectable && !dismissed;
}
