/**
 * Signals (docs/primitives.md §3.6): what main can see of the Mac and of the
 * person's day, read so that a declared `when` either holds or does not —
 * the Mac on battery, offline, a second display, nobody at it for ten
 * minutes, its screen locked, a calendar event with a phrase in its name —
 * and of the browser itself: a page of a site open, a space the extension
 * was given in front, more than so many tabs open.
 *
 * An extension is told that one thing — and so, by when it is told, when it
 * starts and ends — and nothing else of it: never the event's name or its
 * guests, never another event, never how long the Mac has been idle. What it
 * may learn is the line its sheet showed.
 *
 * A signal main cannot read is **not known** (null), which is neither on nor
 * off: nothing is delivered for it, so a calendar that is not connected, or
 * a network that dropped for a minute, sends nobody's space away.
 *
 * Pure but for `CalendarKeeper`, which holds what was last read of the
 * calendar and reads it again behind a look. The sources themselves — the
 * power monitor, the screens, the account's calendar — are main's `index.ts`
 * to hand in, so this is tested without Electron.
 */

import { pageMatches, type TriggerWhen } from "@pistachio/extension-api/triggers";

export interface CalendarEvent {
  title: string;
  /** ms since 1970; an all-day event runs from its first midnight to its last, on the Mac's clock. */
  start: number;
  end: number;
}

/** What was last read of the calendar: the events that touch `from`…`to`. Past `to` it says nothing. */
export interface CalendarReading {
  from: number;
  to: number;
  events: CalendarEvent[];
}

/**
 * What one extension may be told of the browser, as its signals read it: the addresses of the tabs it could see (the
 * person's listed tabs in the Profiles it is on in — never an agent's hidden one, never another extension's page),
 * how many such tabs there are, and whether the space in front is one the person gave it.
 */
export interface BrowserReading {
  urls: readonly string[];
  tabs: number;
  frontHeld: boolean;
}

export interface SignalReadings {
  /** Whether the Mac runs on its battery. */
  battery: boolean | null;
  online: boolean | null;
  /** How many displays are connected. */
  displays: number | null;
  /** How long since anyone touched the Mac. */
  idleSeconds: number | null;
  /** Whether the Mac's screen is locked. */
  locked: boolean | null;
  calendar: CalendarReading | null;
  /** Why the calendar is not known, in the shell's words ("Connect Google Calendar in Settings"); null when it is, or was never asked for. */
  calendarNeeds: string | null;
  /** The browser as this extension may be told of it; null while no window is up. */
  browser: BrowserReading | null;
}

export const NO_READINGS: SignalReadings = { battery: null, online: null, displays: null, idleSeconds: null, locked: null, calendar: null, calendarNeeds: null, browser: null };

/** How often a signal that holds while nobody is there is looked at again: the person coming back should not wait a tick. */
export const IDLE_RETURN_LOOK_MS = 5_000;

/** The events a calendar signal means: its phrase in their name, in any case. */
function matching(when: Extract<TriggerWhen, { calendar: unknown }>, reading: CalendarReading): { start: number; end: number }[] {
  const phrase = when.calendar.title.trim().toLowerCase();
  const early = (when.calendar.early ?? 0) * 60_000;
  return reading.events.filter((event) => event.title.toLowerCase().includes(phrase) && event.end > event.start).map((event) => ({ start: event.start - early, end: event.end }));
}

/** Whether a signal holds at `now`; null when main cannot tell. */
export function signalHolds(when: TriggerWhen, readings: SignalReadings, now: number): boolean | null {
  if ("power" in when) return readings.battery === null ? null : readings.battery === (when.power === "battery");
  if ("network" in when) return readings.online === null ? null : readings.online === (when.network === "online");
  if ("display" in when) return readings.displays === null ? null : readings.displays > 1;
  if ("idle" in when) return readings.idleSeconds === null ? null : readings.idleSeconds >= when.idle.minutes * 60;
  if ("screen" in when) return readings.locked;
  if ("page" in when) return readings.browser === null ? null : readings.browser.urls.some((url) => pageMatches(when.page, url));
  if ("space" in when) return readings.browser === null ? null : readings.browser.frontHeld;
  if ("tabs" in when) return readings.browser === null ? null : readings.browser.tabs > when.tabs.over;
  const reading = readings.calendar;
  if (reading === null || now < reading.from || now >= reading.to) return null;
  return matching(when, reading).some((event) => event.start <= now && now < event.end);
}

/**
 * Whether a signal says that nobody is at the Mac (docs/primitives.md §3.6): its screen locked, or nobody having
 * used it for the minutes the signal names — read now, as holding. A handler such a signal started may send away
 * the space in front: there is nobody in front of it.
 */
export function signalSaysNobody(when: TriggerWhen, readings: SignalReadings, now: number): boolean {
  return ("screen" in when || "idle" in when) && signalHolds(when, readings, now) === true;
}

/** What the person would have to do for a signal that is not known to be, in the shell's words; null when it is known or nothing would help. */
export function signalNeeds(when: TriggerWhen, readings: SignalReadings, now: number): string | null {
  if (!("calendar" in when) || signalHolds(when, readings, now) !== null) return null;
  return readings.calendarNeeds;
}

/**
 * When a signal should next be looked at, if that can be said before the clock's own tick: the instant an event
 * starts or ends, the moment the Mac will have been idle long enough — and, once it has, a few seconds on, so the
 * person's return is heard promptly. Null: at the tick.
 */
export function signalLookAt(when: TriggerWhen, readings: SignalReadings, now: number): number | null {
  if ("idle" in when) {
    if (readings.idleSeconds === null) return null;
    const left = when.idle.minutes * 60 - readings.idleSeconds;
    return left <= 0 ? now + IDLE_RETURN_LOOK_MS : now + Math.max(1, left) * 1000;
  }
  if ("calendar" in when) {
    const reading = readings.calendar;
    if (reading === null || now < reading.from || now >= reading.to) return null;
    const edges = matching(when, reading)
      .flatMap((event) => [event.start, event.end])
      .filter((edge) => edge > now);
    return edges.length === 0 ? null : Math.min(...edges);
  }
  return null;
}

/**
 * Where the readings come from: main's own sources (the power monitor, the screens, the account's calendar), or a
 * spec's. Each answers null when it cannot say.
 */
export interface SignalSources {
  battery(): boolean | null;
  online(): boolean | null;
  displays(): number | null;
  idleSeconds(): number | null;
  /** Whether the Mac's screen is locked; left out, not known. */
  locked?(): boolean | null;
  /** The events of one Profile's connected calendar that touch `from`…`to`. */
  calendar(profileId: string, from: number, to: number): Promise<CalendarAnswer>;
  /** How often the calendar is read again (a spec's; CALENDAR_REFRESH_MS when unsaid). */
  calendarRefreshMs?: number;
}

/* ------------------------------ the calendar ------------------------------ */

/**
 * An event as the account's calendar says it (CalendarAgendaEvent's times: an RFC 3339 instant, or `YYYY-MM-DD` for
 * an all-day event, its end date exclusive) as a signal reads it. An all-day event runs midnight to midnight on the
 * Mac's own clock. Null for one whose times cannot be read.
 */
export function calendarEvent(event: { title: string; start: string; end: string; allDay: boolean }): CalendarEvent | null {
  const instant = (value: string): number => {
    if (!event.allDay) return Date.parse(value);
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year ?? Number.NaN, (month ?? Number.NaN) - 1, day ?? Number.NaN).getTime();
  };
  const start = instant(event.start);
  const end = instant(event.end);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { title: event.title, start, end } : null;
}

/** What the person would do to let a calendar signal be read. */
export const CALENDAR_CONNECT = "Connect Google Calendar in Settings";
export const CALENDAR_RECONNECT = "Reconnect Google Calendar in Settings";
export const CALENDAR_UNREACHABLE = "The calendar could not be reached";

/**
 * What reading one Profile's calendar answered: its events — all of them; that no calendar is connected there (and
 * what would connect one); that one is connected and cannot be read until the person does something (`blocked`: its
 * grant died); or that it could not be reached, or only in part, this time.
 */
export type CalendarAnswer = { status: "ok"; events: CalendarEvent[] } | { status: "off"; needs: string } | { status: "blocked"; needs: string } | { status: "unreachable" };

/**
 * One Profile's agenda, as the account answers it (CalendarAgenda; null when the asking itself failed), as a signal's
 * answer. A day read only in part — one calendar's events missing, the list of calendars unread — is not a day a
 * signal may read "no such event" from: it is as unreachable as none of it. A grant that died is a calendar that is
 * there and cannot be read, which is not the same as no calendar.
 */
export function calendarAnswer(
  agenda: { status: "ok" | "not_connected" | "reconnect_required" | "unreachable"; partial?: true; events: readonly { title: string; start: string; end: string; allDay: boolean }[] } | null,
): CalendarAnswer {
  if (agenda === null || agenda.status === "unreachable") return { status: "unreachable" };
  if (agenda.status === "reconnect_required") return { status: "blocked", needs: CALENDAR_RECONNECT };
  if (agenda.status !== "ok") return { status: "off", needs: CALENDAR_CONNECT };
  if (agenda.partial === true) return { status: "unreachable" };
  return { status: "ok", events: agenda.events.flatMap((event) => calendarEvent(event) ?? []) };
}

/** How often the calendar is read again while an extension's signal wants it. */
export const CALENDAR_REFRESH_MS = 5 * 60_000;
/** How soon a read that could not be made is tried again: the network a Mac wakes without is back in seconds, not minutes. */
export const CALENDAR_RETRY_MS = 30_000;
/** How far ahead one reading looks: what it holds stays good that long if the next cannot be made. */
export const CALENDAR_AHEAD_MS = 24 * 60 * 60_000;
/**
 * The most events one Profile's reading may hold: well past what one read can give (eight calendars of fifty events
 * each — integration-service.ts calendarAgenda, which says `partial` of anything more). A reading is kept whole or
 * not at all: one longer than this is not known, never its first part — a meeting cut off the end would read as
 * "not on".
 */
export const CALENDAR_EVENTS_MAX = 1000;

export interface CalendarKeeperOptions {
  /** Read the events of one Profile's calendar that touch `from`…`to`. */
  read(profileId: string, from: number, to: number): Promise<CalendarAnswer>;
  /** The Profiles whose calendar something that may run asks of: no other is read. */
  wanted(): readonly string[];
  /** What is known changed: the clock should be looked at. */
  changed(): void;
  /** The clock a reading is good by: the triggers' (a spec's may stand still, or be set back). */
  now?: () => number;
  /** The clock the reading again is paced by: the Mac's own, whatever the triggers' says. */
  pace?: () => number;
  refreshMs?: number;
  retryMs?: number;
}

/**
 * What is known of one Profile's calendar: a reading; or that none is connected (`off`: what would connect one); or
 * that one is there and cannot be read (`blocked`: why, in the shell's words — its grant died, it could not be
 * reached); or — none of them — nothing yet.
 */
interface Kept {
  reading: CalendarReading | null;
  off: string | null;
  blocked: string | null;
  askedAt: number;
  asking: boolean;
  /** How many reads in a row could not be made: each waits twice as long as the last, up to a refresh. */
  failures: number;
}

/**
 * What main last read of each Profile's calendar, and the reading again. A Profile is the boundary: an extension's
 * signal is read against the calendars of the Profiles it is on in, and no other is asked for on its word.
 *
 * `current` answers at once with what is known — a look at the clock never waits on the network — and starts a read
 * behind it for each wanted Profile whose last is old. A read that could not be made leaves what was known in place
 * until it runs out (`to`); one that says nothing is connected drops it at once.
 */
export class CalendarKeeper {
  readonly #options: CalendarKeeperOptions;
  readonly #now: () => number;
  readonly #pace: () => number;
  readonly #refreshMs: number;
  readonly #retryMs: number;
  readonly #kept = new Map<string, Kept>();
  /** Each `forget` is a new generation: an answer to a read begun before it is dropped. */
  #generation = 0;

  constructor(options: CalendarKeeperOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#pace = options.pace ?? Date.now;
    this.#refreshMs = options.refreshMs ?? CALENDAR_REFRESH_MS;
    this.#retryMs = Math.min(this.#refreshMs, options.retryMs ?? CALENDAR_RETRY_MS);
  }

  /**
   * The calendars of `profiles` as one reading. Known only when every one of them is: one never yet read, one whose
   * grant died, or one unreachable with nothing kept, makes the whole not known — half a day's events would say a
   * meeting is not on when it is. Profiles with no calendar connected are left out; none connected at all is not
   * known, with what would connect one.
   */
  current(profiles: readonly string[]): Pick<SignalReadings, "calendar" | "calendarNeeds"> {
    for (const profileId of new Set(this.#options.wanted())) {
      const kept = this.#of(profileId);
      if (!kept.asking && this.#pace() - kept.askedAt >= this.#refreshMs) void this.#ask(profileId, kept);
    }
    let from = Number.NEGATIVE_INFINITY;
    let to = Number.POSITIVE_INFINITY;
    let off: string | null = null;
    let read = false;
    const events: CalendarEvent[] = [];
    for (const profileId of new Set(profiles)) {
      const kept = this.#kept.get(profileId);
      if (kept !== undefined && kept.reading !== null) {
        read = true;
        from = Math.max(from, kept.reading.from);
        to = Math.min(to, kept.reading.to);
        events.push(...kept.reading.events);
      } else if (kept !== undefined && kept.off !== null) {
        off = kept.off;
      } else {
        return { calendar: null, calendarNeeds: kept?.blocked ?? null };
      }
    }
    if (!read) return { calendar: null, calendarNeeds: off ?? CALENDAR_CONNECT };
    // (Every Profile's reading whole: each is bounded by CALENDAR_EVENTS_MAX, and none is cut to fit beside another.)
    return { calendar: { from, to, events }, calendarNeeds: null };
  }

  /** What was known is no longer the person's (a calendar connected or disconnected, a Profile gone): read afresh at the next look. */
  forget(): void {
    this.#generation += 1;
    this.#kept.clear();
  }

  #of(profileId: string): Kept {
    let kept = this.#kept.get(profileId);
    if (kept === undefined) {
      kept = { reading: null, off: null, blocked: null, askedAt: Number.NEGATIVE_INFINITY, asking: false, failures: 0 };
      this.#kept.set(profileId, kept);
    }
    return kept;
  }

  async #ask(profileId: string, kept: Kept): Promise<void> {
    const generation = this.#generation;
    const now = this.#now();
    kept.asking = true;
    kept.askedAt = this.#pace();
    let answer: CalendarAnswer;
    try {
      answer = await this.#options.read(profileId, now, now + CALENDAR_AHEAD_MS);
    } catch {
      answer = { status: "unreachable" };
    }
    if (generation !== this.#generation) return;
    kept.asking = false;
    const said = (): string => JSON.stringify([kept.reading?.events ?? null, kept.off, kept.blocked]);
    const before = said();
    // A day too long to keep is a day not read whole: as unreachable as one a calendar of which failed.
    if (answer.status === "ok" && answer.events.length > CALENDAR_EVENTS_MAX) answer = { status: "unreachable" };
    if (answer.status === "ok") {
      const events = answer.events
        .filter((event) => typeof event.title === "string" && Number.isFinite(event.start) && Number.isFinite(event.end))
        // (The name whole, as the events are: it is matched against a declared phrase and shown to nobody, and cut
        // at any length it would not hold a phrase past the cut — the meeting would read as not on.)
        .map((event) => ({ title: event.title, start: event.start, end: event.end }));
      Object.assign(kept, { reading: { from: now, to: now + CALENDAR_AHEAD_MS, events }, off: null, blocked: null, failures: 0 });
    } else if (answer.status === "off") {
      Object.assign(kept, { reading: null, off: answer.needs.slice(0, 160), blocked: null, failures: 0 });
    } else if (answer.status === "blocked") {
      // A calendar that is there and cannot be read until the person acts: what was read of it is let go — nothing
      // more will confirm it — and the whole is not known, never "no calendar here".
      Object.assign(kept, { reading: null, off: null, blocked: answer.needs.slice(0, 160), failures: 0 });
    } else {
      // Not reached this time: what was read stands until it runs out, and the next try is soon, not a refresh away
      // (a Mac wakes without its network, and has it back in seconds) — then twice as long each time it fails again,
      // up to a refresh: a calendar that never answers is not asked every half minute for ever.
      kept.failures += 1;
      const wait = Math.min(this.#refreshMs, this.#retryMs * 2 ** (kept.failures - 1));
      kept.askedAt = this.#pace() - this.#refreshMs + wait;
      if (kept.reading === null || this.#now() >= kept.reading.to) Object.assign(kept, { reading: null, off: null, blocked: CALENDAR_UNREACHABLE });
    }
    // (Every answer moves the stretch a reading is good for; only one that says something new is news to the clock.)
    if (said() !== before) this.#options.changed();
  }
}
