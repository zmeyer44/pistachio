/**
 * `/v1/live` (docs/live-share.md §5): the host's share and the guests' lobby.
 *
 * Host routes ride the device bearer like every other route (the anonymous
 * allow-list includes them: a signed-out Mac can host). Guest routes are
 * public — the link token in the path is the capability to see the share and
 * knock, and a request's secret (a bearer header, never the query) is the
 * capability to learn the answer and fetch a LiveKit token. Neither is ever
 * stored or logged: control keeps their SHA-256 and the request log prints
 * `:token` in the link's place.
 *
 * Host routes answer 404 for a share that is not the caller's, never 403, so
 * an id says nothing about whether it exists.
 */

import type { Context, Hono } from "hono";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { UUID_RE, bearerToken, secretEquals } from "../auth.js";
import { PasswordAttemptLimiter } from "../abuse.js";
import type { Db } from "../db/client.js";
import type { AppEnv } from "../env.js";
import { body, validate } from "../validate.js";
import { liveMaxGuests } from "./config.js";
import { HOST_TOKEN_TTL_SECONDS, type LiveKitApi } from "./livekit.js";
import {
  ENDED_SHARE_RETENTION_MS,
  GUEST_ABSENCE_MS,
  HOST_COLOR,
  HOST_IDENTITY,
  HOST_SILENCE_MS,
  HOST_TOKEN_ASKS,
  HOST_TOKEN_ASK_WINDOW_MS,
  HOST_TOKEN_REFRESH_MS,
  KNOCKS_PER_ADDRESS,
  KNOCKS_PER_SHARE,
  KNOCK_TOPIC,
  KNOCK_WINDOW_MS,
  LINK_TOKEN_RE,
  MAX_LIVE_NAME,
  MAX_LIVE_TITLE,
  REQUEST_ID_RE,
  ROOM_IDLE_SECONDS,
  SHARES_PER_USER,
  SHARE_WINDOW_MS,
  guestIdentity,
  hashSecret,
  liveName,
  liveTitle,
  newRequestId,
  newSecret,
  requestIdOf,
  roomFor,
} from "./lobby.js";
import { LiveStore, type LiveRequestRow, type LiveShareRow, type RoomToClose } from "./store.js";

export interface LiveRouteDeps {
  db: Db;
  /** Null when no LiveKit server is configured: every route answers 503. */
  livekit: LiveKitApi | null;
  env: Record<string, string | undefined>;
  now: () => number;
  log: (line: string) => void;
  /** Keeps work that outlives its response settle-able (`ControlApp.idle`). */
  track: (work: Promise<unknown>) => void;
  /** The caller's address for the per-address knock limit. */
  clientAddress: (c: Context<AppEnv>) => string;
  /** `www`'s origin; links are `<origin>/live/<token>`. */
  webOrigin: string;
}

export interface LiveSweepResult {
  /** Live shares ended because their host went silent. */
  endedLiveShares: number;
  /** Admitted guests long gone from their room without leaving, their places freed. */
  releasedLiveGuests: number;
  /** Ended shares (and their requests) past retention. */
  prunedLiveShares: number;
}

export interface LiveRoutes {
  /**
   * Ends silent shares, closes the rooms of ended shares due a try, frees the
   * places of guests gone without leaving, and prunes old ended shares (the
   * maintenance job).
   */
  sweep(at: number): Promise<LiveSweepResult>;
}

/* ------------------------------------------------------------------ *
 * The guest routes' place in the auth gate and the request log
 * ------------------------------------------------------------------ */

const JOIN_PATH_RE = /^\/v1\/live\/join\/[^/]+$/u;
const JOIN_REQUESTS_PATH_RE = /^\/v1\/live\/join\/[^/]+\/requests$/u;
const JOIN_REQUEST_PATH_RE = /^\/v1\/live\/join\/[^/]+\/requests\/[^/]+$/u;

/**
 * The guest routes the auth gate lets through without a device token. Any
 * segment passes here, so a mangled link reaches the route and reads "not
 * found" rather than "unauthorized".
 */
export function liveGuestRoute(method: string, path: string): boolean {
  if (JOIN_PATH_RE.test(path)) return method === "GET";
  if (JOIN_REQUESTS_PATH_RE.test(path)) return method === "POST";
  if (JOIN_REQUEST_PATH_RE.test(path)) return method === "GET" || method === "DELETE";
  return false;
}

/** A link token in a logged path, whatever its shape, reads `:token`. */
export function scrubLivePath(path: string): string {
  return path.replace(/(\/live\/join\/)[^/]+/u, "$1:token");
}

/* ------------------------------------------------------------------ *
 * Views and schemas
 * ------------------------------------------------------------------ */

export interface LiveShareView {
  id: string;
  title: string;
  hostName: string | null;
  admission: "ask" | "open";
  status: "live" | "ended";
  room: string;
  createdAt: string;
  endedAt: string | null;
}

function shareView(row: LiveShareRow): LiveShareView {
  return {
    id: row.id,
    title: row.title,
    hostName: row.hostName,
    admission: row.admission,
    status: row.status,
    room: row.room,
    createdAt: row.createdAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
  };
}

function requestView(row: LiveRequestRow) {
  return {
    requestId: row.id,
    identity: guestIdentity(row.id),
    name: row.name,
    color: row.color,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A string run through a cleaning rule that answers null for what it refuses. */
function cleanedString(clean: (raw: string) => string | null, max: number, rule: string) {
  // The raw cap only bounds the work; the rule's own limit is what binds.
  return z
    .string()
    .max(max * 8)
    .transform((raw, ctx) => {
      const value = clean(raw);
      if (value === null) {
        ctx.addIssue({ code: "custom", message: rule });
        return z.NEVER;
      }
      return value;
    });
}

const titleSchema = cleanedString(liveTitle, MAX_LIVE_TITLE, `1–${MAX_LIVE_TITLE} printable characters`);
const nameSchema = cleanedString(liveName, MAX_LIVE_NAME, `1–${MAX_LIVE_NAME} printable characters`);
const admissionSchema = z.enum(["ask", "open"]);
/** The host's name is optional, and a blank one is no name rather than a mistake. */
const hostNameSchema = z
  .string()
  .nullish()
  .transform((raw) => (raw === null || raw === undefined || raw.trim() === "" ? null : raw))
  .pipe(nameSchema.nullable());

const createShareSchema = z.object({ title: titleSchema, hostName: hostNameSchema });
const patchShareSchema = z
  .object({ admission: admissionSchema.optional(), title: titleSchema.optional() })
  .refine((patch) => patch.admission !== undefined || patch.title !== undefined, "nothing to change");
/** A plain heartbeat has no body; `refresh` asks for a fresh host token whatever control's record says. */
const heartbeatSchema = z.object({ refresh: z.boolean().optional() }).optional();
const decisionSchema = z.object({ decision: z.enum(["admit", "deny"]) });
const knockSchema = z.object({ name: nameSchema });

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const NOT_FOUND = { error: "live_not_found" } as const;
const ENDED = { error: "live_ended" } as const;
const RATE_LIMITED = { error: "live_rate_limited" } as const;

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

export function registerLiveRoutes(v1: Hono<AppEnv>, deps: LiveRouteDeps): LiveRoutes {
  const { livekit, now, log } = deps;
  const store = new LiveStore(deps.db);

  /** Makes the tries claimed; each that succeeds settles its room, unless a later try was claimed meanwhile. */
  const closeClaimed = async (api: LiveKitApi, claimed: readonly RoomToClose[]): Promise<void> => {
    await Promise.all(
      claimed.map(async ({ shareId, room, attempts }) => {
        try {
          await api.deleteRoom(room);
        } catch (err) {
          log(`live: closing ${room} failed (try ${String(attempts)}), asking again later: ${errorText(err)}`);
          return;
        }
        await store.roomClosed(shareId, attempts);
      }),
    );
  };

  /**
   * Closes the rooms of ended shares that are due a try (of the shares `ids`
   * alone, when given): everyone in one is disconnected, and a guest learns
   * the share ended. A room counts as closed only once LiveKit has deleted it
   * or says it has none; one that fails stays due, and the sweep asks again,
   * each time a while later (`claimRoomCloses`) — the host has forgotten the
   * share by then, and guests in the room never ask control anything.
   */
  const closeRooms = async (at: number, ids?: readonly string[]): Promise<void> => {
    if (livekit === null || ids?.length === 0) return;
    await closeClaimed(livekit, await store.claimRoomCloses(at, ids));
  };

  /**
   * Guests who went without pressing Leave (the tab closed, the machine gone)
   * stay admitted, holding a place the host cannot free — they are in no
   * roster of the host's. So each sweep asks LiveKit who is in every room with
   * guests admitted, and a guest missing from it at two looks 2 min apart, who
   * took no token between (a reload takes one), is `left` (§5). A room that
   * cannot be asked keeps everyone it has.
   */
  const releaseGone = async (at: number): Promise<number> => {
    if (livekit === null) return 0;
    const rooms = await store.roomsWithGuests();
    const released = await Promise.all(
      rooms.map(async ({ shareId, room }) => {
        let identities: Set<string>;
        try {
          identities = await livekit.participants(room);
        } catch (err) {
          log(`live: asking who is in ${room} failed: ${errorText(err)}`);
          return 0;
        }
        const present = new Set([...identities].flatMap((identity) => requestIdOf(identity) ?? []));
        return store.settleGuests(shareId, present, at - GUEST_ABSENCE_MS, at);
      }),
    );
    return released.reduce((sum, count) => sum + count, 0);
  };

  const routes: LiveRoutes = {
    sweep: async (at) => {
      const endedLiveShares = await store.endSilent(at - HOST_SILENCE_MS, at);
      // The rooms of the shares just ended, and of any that would not close before and are due again.
      await closeRooms(at);
      const releasedLiveGuests = await releaseGone(at);
      const pruned = await store.pruneEnded(at - ENDED_SHARE_RETENTION_MS);
      for (const room of pruned.unclosed) log(`live: giving up on closing ${room}: its share is past keeping`);
      return { endedLiveShares, releasedLiveGuests, prunedLiveShares: pruned.pruned };
    },
  };

  if (livekit === null) {
    v1.all("/live/*", (c) => c.json({ error: "live_unavailable" }, 503));
    return routes;
  }

  const maxGuests = liveMaxGuests(deps.env);
  const roomOptions = { maxParticipants: maxGuests + 1, idleSeconds: ROOM_IDLE_SECONDS };
  const sharesByUser = new PasswordAttemptLimiter(SHARES_PER_USER, SHARE_WINDOW_MS, now);
  const knocksByAddress = new PasswordAttemptLimiter(KNOCKS_PER_ADDRESS, KNOCK_WINDOW_MS, now);
  const knocksByShare = new PasswordAttemptLimiter(KNOCKS_PER_SHARE, KNOCK_WINDOW_MS, now);
  const hostTokenAsks = new PasswordAttemptLimiter(HOST_TOKEN_ASKS, HOST_TOKEN_ASK_WINDOW_MS, now);

  const hostLivekit = async (share: LiveShareRow) => ({
    url: livekit.url,
    token: await livekit.token({
      room: share.room,
      identity: HOST_IDENTITY,
      name: share.hostName,
      role: "host",
      color: HOST_COLOR,
    }),
    room: share.room,
    identity: HOST_IDENTITY,
  });

  const guestLivekit = async (share: LiveShareRow, request: LiveRequestRow) => {
    const identity = guestIdentity(request.id);
    return {
      url: livekit.url,
      token: await livekit.token({ room: share.room, identity, name: request.name, role: "guest", color: request.color }),
      identity,
      color: request.color,
    };
  };

  /**
   * Opens a live share's room again in case LiveKit lost it (a restart, or
   * closed it while empty): with `room.auto_create` off (§11) the host could
   * not join it again otherwise. The heartbeat asks only for a share still
   * live, but the host may stop it while the open is on its way, and nothing
   * asked first could rule that out: should the share have ended, the stop's
   * close may have come first, and the room is closed again — a try of its
   * own, so the stop's answering after cannot count for the room this made.
   */
  const keepRoomOpen = async (share: LiveShareRow): Promise<void> => {
    try {
      await livekit.createRoom(share.room, roomOptions);
    } catch (err) {
      log(`live: opening ${share.room} failed: ${errorText(err)}`);
      return;
    }
    await closeClaimed(livekit, await store.roomOpened(share.id, now()));
  };

  /** Disconnects a guest after the response; a failure is logged, the request already says what happened. */
  const showOut = (share: LiveShareRow, requestId: string): void => {
    deps.track(
      livekit.removeParticipant(share.room, guestIdentity(requestId)).catch((err: unknown) => {
        log(`live: removing a guest from ${share.room} failed: ${errorText(err)}`);
      }),
    );
  };

  /**
   * Tells the host someone is at the door (§4 `lv.knock`, sent by the server
   * so no participant can forge one). Best effort: the host also lists
   * pending knocks, so a knock that does not arrive is still seen.
   */
  const knockOnHost = (share: LiveShareRow, request: LiveRequestRow): void => {
    const data = new TextEncoder().encode(JSON.stringify({ requestId: request.id, name: request.name }));
    deps.track(
      livekit
        .sendData(share.room, data, { topic: KNOCK_TOPIC, destinationIdentities: [HOST_IDENTITY] })
        .catch((err: unknown) => {
          log(`live: knock on ${share.room} not delivered: ${errorText(err)}`);
        }),
    );
  };

  /** The caller's share, or null when the id is malformed or names someone else's. */
  const ownedShare = async (c: Context<AppEnv>): Promise<LiveShareRow | null> => {
    const id = c.req.param("id") ?? "";
    return UUID_RE.test(id) ? store.ownedShare(id, c.get("userId")) : null;
  };

  const sharedByLink = async (c: Context<AppEnv>): Promise<LiveShareRow | null> => {
    const token = c.req.param("token") ?? "";
    return LINK_TOKEN_RE.test(token) ? store.shareByToken(hashSecret(token)) : null;
  };

  /**
   * A guest's own request, proven by its secret. Every way of not matching —
   * no such link, no such request on it, the wrong secret — reads the same.
   */
  const guestRequest = async (
    c: Context<AppEnv>,
  ): Promise<{ share: LiveShareRow; request: LiveRequestRow } | Response> => {
    const secret = bearerToken(c.req.header("Authorization"));
    if (secret === null) return c.json({ error: "unauthorized" }, 401);
    const requestId = c.req.param("requestId") ?? "";
    const share = REQUEST_ID_RE.test(requestId) ? await sharedByLink(c) : null;
    const request = share === null ? null : await store.request(share.id, requestId);
    if (share === null || request === null || !secretEquals(hashSecret(secret), request.secretHash)) {
      return c.json(NOT_FOUND, 404);
    }
    return { share, request };
  };

  /* ---------------------------------------------------------------- *
   * Host
   * ---------------------------------------------------------------- */

  v1.post("/live/shares", validate(createShareSchema), async (c) => {
    const userId = c.get("userId");
    const deviceId = c.get("deviceId");
    // The gate already refuses a bootstrap token here; this narrows the type.
    if (deviceId === null) return c.json({ error: "device_required" }, 403);
    if (!sharesByUser.allow(userId)) return c.json(RATE_LIMITED, 429);
    const input = body(c, createShareSchema);
    const id = randomUUID();
    const room = roomFor(id);
    // The room before the share: with `room.auto_create` off (§11) nobody can
    // join a room control did not open, and a start that cannot open one
    // leaves nothing behind — this Mac's previous share goes on.
    try {
      await livekit.createRoom(room, roomOptions);
    } catch (err) {
      log(`live: opening ${room} failed: ${errorText(err)}`);
      return c.json({ error: "live_unavailable", reason: "room_failed" }, 502);
    }
    const token = newSecret();
    const at = now();
    const created = await store.createShare({
      id,
      userId,
      deviceId,
      tokenHash: hashSecret(token),
      title: input.title,
      hostName: input.hostName,
      at,
      hostTokenExpiresAt: at + HOST_TOKEN_TTL_SECONDS * 1000,
    });
    if (created.kind === "too_many") {
      // Nobody holds a token for its room (and LiveKit would close it, idle, anyway).
      deps.track(
        livekit.deleteRoom(room).catch((err: unknown) => {
          log(`live: closing ${room} failed: ${errorText(err)}`);
        }),
      );
      return c.json({ error: "live_too_many_shares" }, 409);
    }
    // The new share does not wait on the old room closing.
    deps.track(closeRooms(at, created.ended));
    const share = created.share;
    return c.json(
      { share: shareView(share), link: `${deps.webOrigin}/live/${token}`, livekit: await hostLivekit(share) },
      201,
    );
  });

  // The lobby, and who is let in: the host checks its room against the latter,
  // so someone holding a token control no longer stands behind (a guest who
  // left, or was removed, back with one LiveKit refreshed) is shown out again.
  v1.get("/live/shares/:id", async (c) => {
    const share = await ownedShare(c);
    if (share === null) return c.json(NOT_FOUND, 404);
    const knocks = share.status === "live" ? await store.pendingKnocks(share.id) : [];
    const admitted = share.status === "live" ? await store.admittedGuests(share.id) : [];
    return c.json({ share: shareView(share), knocks: knocks.map(requestView), admitted: admitted.map(requestView) });
  });

  v1.patch("/live/shares/:id", validate(patchShareSchema), async (c) => {
    const share = await ownedShare(c);
    if (share === null) return c.json(NOT_FOUND, 404);
    const updated = await store.updateShare(share.id, body(c, patchShareSchema), now());
    if (updated === null) return c.json(ENDED, 409);
    return c.json({ share: shareView(updated) });
  });

  v1.post("/live/shares/:id/heartbeat", validate(heartbeatSchema), async (c) => {
    const share = await ownedShare(c);
    if (share === null) return c.json(NOT_FOUND, 404);
    const at = now();
    // A fresh token when the last one minted nears its end, or when the host
    // asks (its room must join again): the answer that brought the last may
    // never have reached it, and control's record cannot tell — it would hold
    // the host's token new for hours while the one the host has runs out.
    // Asking is bounded per share; past that, the record decides.
    const due = share.hostTokenExpiresAt.getTime() - at <= HOST_TOKEN_REFRESH_MS;
    const refresh = due || (body(c, heartbeatSchema)?.refresh === true && hostTokenAsks.allow(share.id));
    const seen = await store.heartbeat(share.id, at, refresh ? at + HOST_TOKEN_TTL_SECONDS * 1000 : null);
    if (seen === null) return c.json(ENDED, 409);
    deps.track(keepRoomOpen(seen));
    return c.json({ share: shareView(seen), ...(refresh ? { livekit: await hostLivekit(seen) } : {}) });
  });

  v1.post("/live/shares/:id/requests/:requestId", validate(decisionSchema), async (c) => {
    const share = await ownedShare(c);
    const requestId = c.req.param("requestId");
    if (share === null || !REQUEST_ID_RE.test(requestId)) return c.json(NOT_FOUND, 404);
    const outcome = await store.decide(share.id, requestId, body(c, decisionSchema).decision, maxGuests, now());
    switch (outcome.kind) {
      case "not_found":
        return c.json(NOT_FOUND, 404);
      case "ended":
        return c.json(ENDED, 409);
      case "full":
        return c.json({ error: "live_full", reason: "guests" }, 409);
      case "not_pending":
        return c.json({ error: "live_not_pending", status: outcome.status }, 409);
      case "decided":
        return c.json({ request: requestView(outcome.request) });
    }
  });

  v1.post("/live/shares/:id/participants/:identity/remove", async (c) => {
    const share = await ownedShare(c);
    const requestId = requestIdOf(c.req.param("identity"));
    if (share === null || requestId === null) return c.json(NOT_FOUND, 404);
    if (share.status !== "live") return c.json(ENDED, 409);
    const request = await store.release(share.id, requestId, "removed", now());
    if (request === null) return c.json(NOT_FOUND, 404);
    // Awaited, unlike a guest leaving: the host asked for this person to be
    // gone, and a removal that did not reach the room must say so. Asking
    // again retries it — the request is already `removed`, so no new token
    // can be minted for them meanwhile.
    try {
      await livekit.removeParticipant(share.room, guestIdentity(requestId));
    } catch (err) {
      log(`live: removing a guest from ${share.room} failed: ${errorText(err)}`);
      return c.json({ error: "live_unavailable", reason: "remove_failed" }, 502);
    }
    return c.json({ request: requestView(request) });
  });

  v1.delete("/live/shares/:id", async (c) => {
    const share = await ownedShare(c);
    if (share === null) return c.json(NOT_FOUND, 404);
    const at = now();
    const ended = (await store.endShare(share.id, at)) ?? share;
    // Awaited, so the host hears back once the room has closed, when it
    // does. One that will not close is still the share's end: the sweep
    // closes it after.
    await closeRooms(at, [ended.id]);
    return c.json({ share: shareView(ended) });
  });

  /* ---------------------------------------------------------------- *
   * Guests
   * ---------------------------------------------------------------- */

  v1.get("/live/join/:token", async (c) => {
    const share = await sharedByLink(c);
    if (share === null) return c.json(NOT_FOUND, 404);
    return c.json({ title: share.title, hostName: share.hostName, admission: share.admission, status: share.status });
  });

  v1.post("/live/join/:token/requests", validate(knockSchema), async (c) => {
    if (!knocksByAddress.allow(deps.clientAddress(c))) return c.json(RATE_LIMITED, 429);
    const share = await sharedByLink(c);
    if (share === null) return c.json(NOT_FOUND, 404);
    if (share.status !== "live") return c.json(ENDED, 409);
    if (!knocksByShare.allow(share.id)) return c.json(RATE_LIMITED, 429);
    const secret = newSecret();
    const outcome = await store.knock({
      shareId: share.id,
      id: newRequestId(),
      name: body(c, knockSchema).name,
      secretHash: hashSecret(secret),
      at: now(),
      maxGuests,
    });
    if (outcome.kind === "ended") return c.json(ENDED, 409);
    if (outcome.kind === "full") return c.json({ error: "live_full", reason: outcome.reason }, 409);
    const request = outcome.request;
    if (request.status === "pending") knockOnHost(share, request);
    return c.json(
      {
        requestId: request.id,
        secret,
        status: request.status,
        ...(request.status === "admitted" ? { livekit: await guestLivekit(share, request) } : {}),
      },
      201,
    );
  });

  // Polled while waiting, and how a reload rejoins: while admitted, every
  // answer carries a fresh token — and taking one keeps the guest's place
  // (the sweep frees the places of guests gone from the room).
  v1.get("/live/join/:token/requests/:requestId", async (c) => {
    const found = await guestRequest(c);
    if (found instanceof Response) return found;
    const { share, request } = found;
    if (share.status !== "live") return c.json({ status: "ended" });
    if (request.status !== "admitted") return c.json({ status: request.status });
    if (!(await store.guestAbout(share.id, request.id))) {
      // Let go by the sweep (or removed) since the read above: no token.
      return c.json({ status: (await store.request(share.id, request.id))?.status ?? "left" });
    }
    return c.json({ status: request.status, livekit: await guestLivekit(share, request) });
  });

  v1.delete("/live/join/:token/requests/:requestId", async (c) => {
    const found = await guestRequest(c);
    if (found instanceof Response) return found;
    const { share, request } = found;
    if (share.status !== "live") return c.json({ status: "ended" });
    const left = (await store.release(share.id, request.id, "left", now())) ?? request;
    if (request.status === "admitted") showOut(share, request.id);
    return c.json({ status: left.status });
  });

  return routes;
}
