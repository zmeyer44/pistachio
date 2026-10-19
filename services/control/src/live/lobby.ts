/**
 * The lobby's rules (docs/live-share.md §3, §5), kept pure so each is
 * unit-testable: the bounds, names, colours, and the shape of every secret.
 *
 * The palette and the name rule are restated here rather than imported from
 * `@pistachio/live-share` (its `LIVE_COLORS` and `sanitizeName`), as control
 * restates the note caps: control depends on no client package, and what
 * the server accepts must not move because a client package did. Keep the
 * two in step by hand.
 */

import { createHash, randomBytes } from "node:crypto";

/** The participant palette; the host is always the first. */
export const LIVE_COLORS: readonly string[] = [
  "#3E63DD", // indigo — the host
  "#E54D2E", // tomato
  "#46A758", // grass
  "#F76B15", // orange
  "#8E4EC6", // purple
  "#D6409F", // pink
  "#12A594", // teal
  "#AD7F58", // bronze
];
export const HOST_COLOR = LIVE_COLORS[0] ?? "#3E63DD";

export const MAX_LIVE_NAME = 40;
export const MAX_LIVE_TITLE = 200;
/** Live shares one account may hold at once (one per Mac, two Macs). */
export const MAX_LIVE_SHARES_PER_USER = 2;
/** Knocks waiting on one share; past this the lobby is full. */
export const MAX_PENDING_KNOCKS = 30;
export const KNOCKS_PER_ADDRESS = 10;
export const KNOCKS_PER_SHARE = 60;
export const KNOCK_WINDOW_MS = 60_000;
/** Shares one account may start per window; ending and restarting is cheap, rows are not. */
export const SHARES_PER_USER = 30;
export const SHARE_WINDOW_MS = 60 * 60 * 1000;
/** A share whose host has not been heard from in this long is over (§5 heartbeat). */
export const HOST_SILENCE_MS = 10 * 60 * 1000;
/**
 * An admitted guest missing from the room at two of the sweep's looks this far
 * apart, who took no token between, went without leaving (closed the tab):
 * their place is freed. Past a reload (seconds, and its token resets it) and
 * the room's own reconnecting (under a minute).
 */
export const GUEST_ABSENCE_MS = 2 * 60 * 1000;
/**
 * How long LiveKit keeps a share's room with nobody in it — before the host
 * has joined, and after the last person left — before closing it itself: as
 * long as the share outlasts its host's silence, so a Mac back from a short
 * sleep finds its room. One closed anyway, or lost to a LiveKit restart, is
 * opened again at the next heartbeat.
 */
export const ROOM_IDLE_SECONDS = HOST_SILENCE_MS / 1000;
/** A heartbeat this close to the host token's expiry mints the next one. */
export const HOST_TOKEN_REFRESH_MS = 60 * 60 * 1000;
/**
 * A heartbeat asking for a fresh token (`refresh`: the host's room must join
 * again) gets one this many times a share in `HOST_TOKEN_ASK_WINDOW_MS` —
 * more than a bad stretch of rejoining asks, fewer than a runaway loop would.
 */
export const HOST_TOKEN_ASKS = 10;
export const HOST_TOKEN_ASK_WINDOW_MS = 10 * 60 * 1000;
/** How long an ended share and its requests are kept. */
export const ENDED_SHARE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * A room LiveKit did not close when its share ended is asked again this long
 * after, then twice as long after each try that fails, at most
 * `ROOM_CLOSE_RETRY_MAX_MS` apart, until the share is forgotten
 * (`ENDED_SHARE_RETENTION_MS`). Guests in a room nobody closed would stay in
 * it, seeing and hearing each other, without learning the share ended.
 */
export const ROOM_CLOSE_RETRY_MS = 60 * 1000;
export const ROOM_CLOSE_RETRY_MAX_MS = 60 * 60 * 1000;

/** The link token: 32 random bytes, base64url (43 characters). */
export const LINK_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/u;
export const REQUEST_ID_RE = /^[A-Za-z0-9_-]{12}$/u;
const GUEST_IDENTITY_PREFIX = "g_";
export const HOST_IDENTITY = "host";
export const KNOCK_TOPIC = "lv.knock";

/** A 256-bit capability: the link token and a request's secret alike. */
export function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** 72 bits: unguessable is the secret's job; an id only has to be unique (it is the row's key). */
export function newRequestId(): string {
  return randomBytes(9).toString("base64url");
}

/** What is stored in place of a link token or a request secret. */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function roomFor(shareId: string): string {
  return `live_${shareId}`;
}

export function guestIdentity(requestId: string): string {
  return `${GUEST_IDENTITY_PREFIX}${requestId}`;
}

/** The request behind a guest identity, or null for the host or anything malformed. */
export function requestIdOf(identity: string): string | null {
  if (!identity.startsWith(GUEST_IDENTITY_PREFIX)) return null;
  const id = identity.slice(GUEST_IDENTITY_PREFIX.length);
  return REQUEST_ID_RE.test(id) ? id : null;
}

/**
 * Control characters go, and so do the bidi marks, embeddings, overrides and
 * isolates: a name is shown beside other names in the host's Live card,
 * where an override could make it read as something it is not.
 */
const UNPRINTABLE_RE = /[\p{Cc}\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

function cleaned(raw: string, max: number): string | null {
  const text = raw.replace(UNPRINTABLE_RE, "").replace(/\s+/gu, " ").trim();
  const length = [...text].length;
  return length >= 1 && length <= max ? text : null;
}

/** A participant's display name: unprintables stripped, spaces collapsed, trimmed, 1–40 characters; null otherwise. */
export function liveName(raw: string): string | null {
  return cleaned(raw, MAX_LIVE_NAME);
}

/** A share's title (the space's name), by the same rule with more room. */
export function liveTitle(raw: string): string | null {
  return cleaned(raw, MAX_LIVE_TITLE);
}

/**
 * The colour for the next guest: the first of the guest colours nobody
 * waiting or admitted holds, and once all are held, the least held of them,
 * so a wrap spreads the repeats instead of piling onto one.
 */
export function nextGuestColor(held: readonly string[]): string {
  const guestColors = LIVE_COLORS.slice(1);
  const counts = new Map(guestColors.map((color) => [color, 0]));
  for (const color of held) {
    const count = counts.get(color);
    if (count !== undefined) counts.set(color, count + 1);
  }
  let best = guestColors[0] ?? HOST_COLOR;
  let fewest = Number.POSITIVE_INFINITY;
  for (const color of guestColors) {
    const count = counts.get(color) ?? 0;
    if (count < fewest) {
      best = color;
      fewest = count;
    }
  }
  return best;
}
