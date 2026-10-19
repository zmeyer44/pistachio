/**
 * The guest's side of control's live routes (docs/live-share.md §5 Guest
 * routes), called straight from the browser: no account, no session — the
 * link's token names the share and a request's secret proves it is yours.
 *
 * Every answer is read field by field; anything else is a `LiveControlError`
 * with the code control sent (`live_not_found`, `live_ended`, `live_full`,
 * `live_rate_limited`, `live_unavailable`) or `network` when control could
 * not be reached at all.
 */

import type { LiveGuestRequest, LiveGuestTicket, LiveJoinInfo, LiveRequestAnswer, LiveRequestStatus } from "@pistachio/live-share/react";
import { CONTROL_URL } from "@pistachio/web-account/control";

export class LiveControlError extends Error {
  override name = "LiveControlError";
  constructor(
    readonly status: number,
    readonly code: string,
    /** `live_full`'s `reason`: "guests" or "lobby". */
    readonly reason: string | null = null,
  ) {
    super(`control answered ${String(status)} ${code}`);
  }
}

type Json = Record<string, unknown>;

const REQUEST_STATUSES: readonly LiveRequestStatus[] = ["pending", "admitted", "denied", "removed", "left", "ended"];

const path = (token: string, rest = ""): string => `${CONTROL_URL}/v1/live/join/${encodeURIComponent(token)}${rest}`;

async function call(url: string, init: RequestInit = {}): Promise<Json> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, cache: "no-store", credentials: "omit" });
  } catch {
    throw new LiveControlError(0, "network");
  }
  const body = (await response.json().catch(() => ({}))) as unknown;
  const json: Json = typeof body === "object" && body !== null ? (body as Json) : {};
  if (!response.ok) {
    const code = typeof json["error"] === "string" ? json["error"] : "unknown";
    throw new LiveControlError(response.status, code, typeof json["reason"] === "string" ? json["reason"] : null);
  }
  return json;
}

function malformed(): LiveControlError {
  return new LiveControlError(502, "malformed");
}

function ticketOf(value: unknown): LiveGuestTicket | null {
  if (typeof value !== "object" || value === null) return null;
  const { url, token, identity, color } = value as Json;
  return typeof url === "string" && typeof token === "string" && typeof identity === "string" && typeof color === "string" ? { url, token, identity, color } : null;
}

function answerOf(json: Json): LiveRequestAnswer {
  const status = json["status"];
  if (typeof status !== "string" || !(REQUEST_STATUSES as readonly string[]).includes(status)) throw malformed();
  return { status: status as LiveRequestStatus, ticket: ticketOf(json["livekit"]) };
}

const bearer = (request: LiveGuestRequest): HeadersInit => ({ authorization: `Bearer ${request.secret}` });

/** The share a link names. */
export async function joinInfo(token: string): Promise<LiveJoinInfo> {
  const json = await call(path(token));
  const { title, hostName, admission, status } = json;
  if (typeof title !== "string" || (admission !== "ask" && admission !== "open") || (status !== "live" && status !== "ended")) throw malformed();
  return { title, hostName: typeof hostName === "string" && hostName.trim() !== "" ? hostName : null, admission, status };
}

let early: { token: string; info: Promise<LiveJoinInfo> } | null = null;

/**
 * Ask for the share before the guest app's code has arrived (the page's first
 * chunk calls this), so the two load side by side; `takeJoinInfo` takes it.
 */
export function prefetchJoinInfo(token: string): void {
  if (early?.token === token) return;
  const info = joinInfo(token);
  // Read by whoever takes it; unhandled until then.
  info.catch(() => undefined);
  early = { token, info };
}

/** The share a link names: the answer already asked for, the first time; a fresh one after (a restart). */
export function takeJoinInfo(token: string): Promise<LiveJoinInfo> {
  const prefetched = early?.token === token ? early.info : null;
  early = null;
  return prefetched ?? joinInfo(token);
}

/** Ask to join (or join, with anyone-with-the-link). */
export async function knock(token: string, name: string): Promise<{ request: LiveGuestRequest; answer: LiveRequestAnswer }> {
  const json = await call(path(token, "/requests"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const { requestId, secret } = json;
  if (typeof requestId !== "string" || typeof secret !== "string") throw malformed();
  return { request: { requestId, secret }, answer: answerOf(json) };
}

/** Where a request stands; while admitted, with a fresh token. */
export async function pollRequest(token: string, request: LiveGuestRequest): Promise<LiveRequestAnswer> {
  return answerOf(await call(path(token, `/requests/${encodeURIComponent(request.requestId)}`), { headers: bearer(request) }));
}

/** Cancel a knock, or leave. `keepalive` so it still goes out as the page closes. */
export async function leaveRequest(token: string, request: LiveGuestRequest): Promise<void> {
  await call(path(token, `/requests/${encodeURIComponent(request.requestId)}`), { method: "DELETE", headers: bearer(request), keepalive: true });
}
