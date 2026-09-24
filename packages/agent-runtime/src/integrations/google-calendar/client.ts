/**
 * The slice of the Google Calendar REST API (v3) the agent's tools use, over
 * an injected `fetch` and an access-token provider. Every method maps to
 * one documented endpoint; the client adds the bearer, retries once with a
 * fresh token after a 401, and turns Google's error envelope into an
 * `Error` whose message the model can act on.
 */

import type { FetchLike } from "../oauth.js";
import type { CalendarEventResource, CalendarEventWrite } from "./events.js";

export const GOOGLE_CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

export interface GoogleCalendarClientOptions {
  /** A live access token; `fresh` asks for one minted anew. */
  accessToken: (options?: { fresh?: boolean }) => Promise<string>;
  fetch?: FetchLike;
  baseUrl?: string;
}

export class GoogleCalendarApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GoogleCalendarApiError";
  }
}

/** One entry of the account's calendar list. */
export interface CalendarListEntry {
  id: string;
  summary?: string;
  summaryOverride?: string;
  description?: string;
  timeZone?: string;
  accessRole?: "freeBusyReader" | "reader" | "writer" | "owner";
  primary?: boolean;
  selected?: boolean;
  hidden?: boolean;
}

/** A calendar's own metadata; the primary calendar's id is the account's address. */
export interface CalendarResource {
  id: string;
  summary?: string;
  timeZone?: string;
}

export interface CalendarEventsPage {
  events: CalendarEventResource[];
  nextPageToken: string | null;
  /** The zone the calendar keeps its times in. */
  timeZone: string | null;
}

export interface FreeBusyResult {
  calendars: Record<string, { busy: Array<{ start: string; end: string }>; errors: string[] }>;
}

/** Who is told about a change: every guest, or nobody. */
export type SendUpdates = "all" | "none";

interface GoogleErrorEnvelope {
  error?: { code?: number; message?: string; status?: string };
}

export class GoogleCalendarClient {
  readonly #token: GoogleCalendarClientOptions["accessToken"];
  readonly #fetch: FetchLike;
  readonly #base: string;

  constructor(options: GoogleCalendarClientOptions) {
    this.#token = options.accessToken;
    this.#fetch = options.fetch ?? fetch;
    this.#base = (options.baseUrl ?? GOOGLE_CALENDAR_API_BASE).replace(/\/+$/u, "");
  }

  getCalendar(calendarId: string): Promise<CalendarResource> {
    return this.#call<CalendarResource>("GET", `/calendars/${encodeURIComponent(calendarId)}`);
  }

  listCalendars(): Promise<CalendarListEntry[]> {
    return this.#call<{ items?: CalendarListEntry[] }>("GET", "/users/me/calendarList?maxResults=250").then((page) => page.items ?? []);
  }

  /** Events in a window, recurring ones expanded into their instances, earliest first. */
  listEvents(
    calendarId: string,
    input: { timeMin: string; timeMax: string; query: string; maxResults: number; pageToken?: string | null },
  ): Promise<CalendarEventsPage> {
    const params = new URLSearchParams({
      timeMin: input.timeMin,
      timeMax: input.timeMax,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(input.maxResults),
    });
    if (input.query !== "") params.set("q", input.query);
    if (input.pageToken !== undefined && input.pageToken !== null) params.set("pageToken", input.pageToken);
    return this.#call<{ items?: CalendarEventResource[]; nextPageToken?: string; timeZone?: string }>(
      "GET",
      `/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
    ).then((page) => ({
      events: page.items ?? [],
      nextPageToken: page.nextPageToken ?? null,
      timeZone: page.timeZone ?? null,
    }));
  }

  getEvent(calendarId: string, eventId: string): Promise<CalendarEventResource> {
    return this.#call<CalendarEventResource>("GET", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
  }

  insertEvent(calendarId: string, event: CalendarEventWrite, options: { sendUpdates: SendUpdates }): Promise<CalendarEventResource> {
    const params = new URLSearchParams({ sendUpdates: options.sendUpdates });
    // Without this version Google drops `conferenceData` from the request.
    if (event.conferenceData !== undefined) params.set("conferenceDataVersion", "1");
    return this.#call<CalendarEventResource>("POST", `/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`, event);
  }

  /** A partial update: only the fields given change. An array given replaces the whole array. */
  patchEvent(calendarId: string, eventId: string, patch: CalendarEventWrite, options: { sendUpdates: SendUpdates }): Promise<CalendarEventResource> {
    const params = new URLSearchParams({ sendUpdates: options.sendUpdates });
    if (patch.conferenceData !== undefined) params.set("conferenceDataVersion", "1");
    return this.#call<CalendarEventResource>(
      "PATCH",
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?${params.toString()}`,
      patch,
    );
  }

  deleteEvent(calendarId: string, eventId: string, options: { sendUpdates: SendUpdates }): Promise<void> {
    const params = new URLSearchParams({ sendUpdates: options.sendUpdates });
    return this.#call<void>("DELETE", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?${params.toString()}`);
  }

  freeBusy(input: { timeMin: string; timeMax: string; calendarIds: readonly string[] }): Promise<FreeBusyResult> {
    return this.#call<{ calendars?: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: Array<{ reason?: string }> }> }>("POST", "/freeBusy", {
      timeMin: input.timeMin,
      timeMax: input.timeMax,
      items: input.calendarIds.map((id) => ({ id })),
    }).then((result) => {
      const calendars: FreeBusyResult["calendars"] = {};
      for (const [id, entry] of Object.entries(result.calendars ?? {})) {
        calendars[id] = { busy: entry.busy ?? [], errors: (entry.errors ?? []).map((error) => error.reason ?? "unknown") };
      }
      return { calendars };
    });
  }

  async #call<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const token = await this.#token(retried ? { fresh: true } : undefined);
    const response = await this.#fetch(`${this.#base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 401 && !retried) return this.#call<T>(method, path, body, true);
    if (!response.ok) {
      let detail = `Google Calendar answered ${String(response.status)}`;
      try {
        const envelope = (await response.json()) as GoogleErrorEnvelope;
        const message = envelope.error?.message;
        if (typeof message === "string" && message !== "") detail = message;
      } catch {
        // The status is all there is.
      }
      throw new GoogleCalendarApiError(response.status, detail);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}
