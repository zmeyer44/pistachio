/**
 * One owner per session for each `webRequest` event.
 *
 * Electron keeps ONE listener per event per session — registering a second
 * silently replaces the first (and `null` removes whoever was there). The
 * upload policy and Shields both need `onBeforeRequest`, and Shields needs
 * the header events too, so neither registers directly: each adds a named
 * handler here, and the hub registers a single listener per event that runs
 * them in priority order (docs/shields.md §3).
 *
 * Handlers are synchronous on purpose. Every request in the session passes
 * through the main process here; nothing in a handler may wait on disk or
 * the network.
 *
 * A handler is keyed by name, so a second window's controller that meets
 * the same persisted session REPLACES its predecessor's handler (which
 * closes over a dead controller) instead of running beside it.
 */

import type {
  BeforeSendResponse,
  CallbackResponse,
  HeadersReceivedResponse,
  OnBeforeRedirectListenerDetails,
  OnBeforeRequestListenerDetails,
  OnBeforeSendHeadersListenerDetails,
  OnHeadersReceivedListenerDetails,
  Session,
  WebRequestFilter,
} from "electron";

type ResourceType = OnBeforeRequestListenerDetails["resourceType"];
type FilterType = NonNullable<WebRequestFilter["types"]>[number];

/** Cancel, redirect, or nothing (undefined: the next handler decides). */
export type BeforeRequestHandler = (details: OnBeforeRequestListenerDetails) => CallbackResponse | undefined;
/** Edit `headers` in place; "cancel" refuses the request. */
export type SendHeadersHandler = (details: OnBeforeSendHeadersListenerDetails, headers: Record<string, string>) => "cancel" | void;
/** Edit `headers` in place (names keep the server's spelling); "cancel" refuses the response. */
export type HeadersReceivedHandler = (details: OnHeadersReceivedListenerDetails, headers: Record<string, string[]>) => "cancel" | void;
export type BeforeRedirectHandler = (details: OnBeforeRedirectListenerDetails) => void;

interface Entry<H> {
  priority: number;
  /** Only these request types reach the handler; omitted, every type does. */
  types?: readonly FilterType[];
  handler: H;
}

const URLS = ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*", "pistachio://*/*"];

/** Lower runs first. */
export const HUB_PRIORITY = { policy: 0, shields: 10 } as const;

const hubs = new WeakMap<Session, RequestHub>();

export class RequestHub {
  static for(session: Session): RequestHub {
    let hub = hubs.get(session);
    if (hub === undefined) {
      hub = new RequestHub(session);
      hubs.set(session, hub);
    }
    return hub;
  }

  readonly #session: Session;
  readonly #beforeRequest = new Map<string, Entry<BeforeRequestHandler>>();
  readonly #sendHeaders = new Map<string, Entry<SendHeadersHandler>>();
  readonly #headersReceived = new Map<string, Entry<HeadersReceivedHandler>>();
  readonly #beforeRedirect = new Map<string, Entry<BeforeRedirectHandler>>();

  private constructor(session: Session) {
    this.#session = session;
  }

  onBeforeRequest(name: string, entry: Entry<BeforeRequestHandler> | null): void {
    set(this.#beforeRequest, name, entry);
    const entries = sorted(this.#beforeRequest);
    if (entries.length === 0) {
      this.#session.webRequest.onBeforeRequest(null);
      return;
    }
    this.#session.webRequest.onBeforeRequest(filterFor(entries), (details, callback) => {
      for (const { handler, types } of entries) {
        if (!admits(types, details.resourceType)) continue;
        let response: CallbackResponse | undefined;
        try {
          response = handler(details);
        } catch (error) {
          // A handler that throws must not leave the request hanging forever.
          console.error("[request-hub] onBeforeRequest handler failed", error);
          continue;
        }
        if (response !== undefined && (response.cancel === true || response.redirectURL !== undefined)) {
          // A CORS preflight is refused, never redirected: Electron's main
          // process crashes on a redirected preflight (43.4.1, to any
          // address — YouTube's ad pings met uBO's no-op resources), and
          // the Fetch standard fails a preflight that redirects anyway.
          callback(details.method === "OPTIONS" ? { cancel: true } : response);
          return;
        }
      }
      callback({});
    });
  }

  onBeforeSendHeaders(name: string, entry: Entry<SendHeadersHandler> | null): void {
    set(this.#sendHeaders, name, entry);
    const entries = sorted(this.#sendHeaders);
    if (entries.length === 0) {
      this.#session.webRequest.onBeforeSendHeaders(null);
      return;
    }
    this.#session.webRequest.onBeforeSendHeaders(filterFor(entries), (details, callback) => {
      const headers = { ...details.requestHeaders };
      for (const { handler, types } of entries) {
        if (!admits(types, details.resourceType)) continue;
        try {
          if (handler(details, headers) === "cancel") {
            callback({ cancel: true });
            return;
          }
        } catch (error) {
          console.error("[request-hub] onBeforeSendHeaders handler failed", error);
        }
      }
      const response: BeforeSendResponse = changed(details.requestHeaders, headers) ? { requestHeaders: headers } : {};
      callback(response);
    });
  }

  onHeadersReceived(name: string, entry: Entry<HeadersReceivedHandler> | null): void {
    set(this.#headersReceived, name, entry);
    const entries = sorted(this.#headersReceived);
    if (entries.length === 0) {
      this.#session.webRequest.onHeadersReceived(null);
      return;
    }
    this.#session.webRequest.onHeadersReceived(filterFor(entries), (details, callback) => {
      const original = details.responseHeaders ?? {};
      const headers: Record<string, string[]> = {};
      for (const [key, values] of Object.entries(original)) headers[key] = [...values];
      for (const { handler, types } of entries) {
        if (!admits(types, details.resourceType)) continue;
        try {
          if (handler(details, headers) === "cancel") {
            callback({ cancel: true });
            return;
          }
        } catch (error) {
          console.error("[request-hub] onHeadersReceived handler failed", error);
        }
      }
      const response: HeadersReceivedResponse = changedLists(original, headers) ? { responseHeaders: headers } : {};
      callback(response);
    });
  }

  onBeforeRedirect(name: string, entry: Entry<BeforeRedirectHandler> | null): void {
    set(this.#beforeRedirect, name, entry);
    const entries = sorted(this.#beforeRedirect);
    if (entries.length === 0) {
      this.#session.webRequest.onBeforeRedirect(null);
      return;
    }
    this.#session.webRequest.onBeforeRedirect(filterFor(entries), (details) => {
      for (const { handler, types } of entries) {
        if (!admits(types, details.resourceType as ResourceType)) continue;
        try {
          handler(details);
        } catch (error) {
          console.error("[request-hub] onBeforeRedirect handler failed", error);
        }
      }
    });
  }
}

function set<H>(map: Map<string, Entry<H>>, name: string, entry: Entry<H> | null): void {
  if (entry === null) map.delete(name);
  else map.set(name, entry);
}

function sorted<H>(map: Map<string, Entry<H>>): Entry<H>[] {
  return [...map.values()].sort((a, b) => a.priority - b.priority);
}

/** The union of what the handlers want: a type list only when every handler named one. */
function filterFor(entries: readonly Entry<unknown>[]): WebRequestFilter {
  if (entries.some((entry) => entry.types === undefined)) return { urls: URLS };
  const types = new Set<FilterType>();
  for (const entry of entries) for (const type of entry.types ?? []) types.add(type);
  return { urls: URLS, types: [...types] };
}

function admits(types: readonly FilterType[] | undefined, type: ResourceType): boolean {
  return types === undefined || (types as readonly string[]).includes(type);
}

function changed(before: Record<string, string>, after: Record<string, string>): boolean {
  const keys = Object.keys(after);
  if (keys.length !== Object.keys(before).length) return true;
  return keys.some((key) => before[key] !== after[key]);
}

function changedLists(before: Record<string, string[]>, after: Record<string, string[]>): boolean {
  const keys = Object.keys(after);
  if (keys.length !== Object.keys(before).length) return true;
  return keys.some((key) => {
    const a = before[key];
    const b = after[key];
    return a === undefined || b === undefined || a.length !== b.length || a.some((value, index) => value !== b[index]);
  });
}
