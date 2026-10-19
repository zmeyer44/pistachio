/**
 * Live share's control plane (docs/live-share.md §5): the host's share, the
 * guests' lobby, the LiveKit tokens control signs, and the three server API
 * calls it makes — recorded by a fake room service, while tokens are signed
 * for real and decoded here exactly as LiveKit would read them.
 */

import { PGlite, type QueryOptions, type Transaction } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import {
  ParticipantInfo,
  Room,
  ServerError,
  TokenVerifier,
  type ClaimGrants,
  type CreateOptions,
  type DataPacket_Kind,
  type SendDataOptions,
} from "livekit-server-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anonymousAllowed } from "../src/anonymous.js";
import type { Db } from "../src/db/client.js";
import { ensureSchema } from "../src/db/migrate.js";
import * as schema from "../src/db/schema.js";
import { DEFAULT_LIVE_MAX_GUESTS, livekitFromEnv, liveMaxGuests, type LiveKitConfig } from "../src/live/config.js";
import { createLiveKitApi, type LiveRoomService } from "../src/live/livekit.js";
import { LIVE_COLORS, hashSecret, liveName, nextGuestColor } from "../src/live/lobby.js";
import {
  anonymousAccount,
  authed,
  desktopAccount,
  deviceLogin,
  enableCloud,
  enrollDesktop,
  fakeRunner,
  json,
  jsonInit,
  makeHarness,
  signup,
  type FakeRunner,
  type Harness,
} from "./helpers.js";

const LIVEKIT: LiveKitConfig = {
  url: "wss://live.example",
  apiUrl: "https://live.example",
  apiKey: "lk-test-key",
  apiSecret: "lk-test-secret-0123456789abcdef0123456789",
};
const WEB = "https://www.pistachio.example";

/** The LiveKit server API, recorded; who is in each room is the test's to say. */
class FakeRooms implements LiveRoomService {
  readonly sent: Array<{ room: string; body: unknown; kind: DataPacket_Kind; options: SendDataOptions }> = [];
  readonly removed: Array<{ room: string; identity: string }> = [];
  /** Every room LiveKit was asked to create, with what was asked of it. */
  readonly opened: CreateOptions[] = [];
  /** Every room LiveKit was asked to delete, as often as it was asked. */
  readonly deleted: string[] = [];
  /** Each room's participants by identity; a room not set holds nobody. */
  readonly inRoom = new Map<string, string[]>();
  sendError: Error | null = null;
  removeError: Error | null = null;
  listError: Error | null = null;
  deleteError: Error | null = null;
  createError: Error | null = null;
  /** Runs as a room is created, before LiveKit answers: a test's way to land a request in between. */
  whileOpening: (() => Promise<void>) | null = null;
  /** Runs as a room is deleted, before LiveKit answers (as `deleteError` stands after it). */
  whileDeleting: (() => Promise<void>) | null = null;

  sendData(room: string, data: Uint8Array, kind: DataPacket_Kind, options: SendDataOptions): Promise<void> {
    if (this.sendError !== null) return Promise.reject(this.sendError);
    this.sent.push({ room, body: JSON.parse(new TextDecoder().decode(data)), kind, options });
    return Promise.resolve();
  }

  listParticipants(room: string): Promise<ParticipantInfo[]> {
    if (this.listError !== null) return Promise.reject(this.listError);
    return Promise.resolve((this.inRoom.get(room) ?? []).map((identity) => new ParticipantInfo({ identity })));
  }

  removeParticipant(room: string, identity: string): Promise<void> {
    this.removed.push({ room, identity });
    return this.removeError === null ? Promise.resolve() : Promise.reject(this.removeError);
  }

  async createRoom(options: CreateOptions): Promise<Room> {
    this.opened.push(options);
    await this.whileOpening?.();
    if (this.createError !== null) throw this.createError;
    return new Room({ name: options.name });
  }

  /** How many times LiveKit was asked to create `room`. */
  opens(room: string): number {
    return this.opened.filter((options) => options.name === room).length;
  }

  async deleteRoom(room: string): Promise<void> {
    this.deleted.push(room);
    await this.whileDeleting?.();
    if (this.deleteError !== null) throw this.deleteError;
  }

  /** How many times LiveKit was asked to delete `room`. */
  closes(room: string): number {
    return this.deleted.filter((deleted) => deleted === room).length;
  }
}

interface Stack {
  h: Harness;
  rooms: FakeRooms;
  clock: { at: number };
}

async function liveStack(options: { env?: Record<string, string>; runner?: FakeRunner; db?: Db } = {}): Promise<Stack> {
  const rooms = new FakeRooms();
  const clock = { at: Date.parse("2026-10-17T12:00:00Z") };
  const h = await makeHarness({
    now: () => clock.at,
    env: { PISTACHIO_WEB_URL: WEB, ...options.env },
    livekit: createLiveKitApi(LIVEKIT, rooms),
    ...(options.runner === undefined ? {} : { runner: options.runner.client }),
    ...(options.db === undefined ? {} : { db: options.db }),
  });
  return { h, rooms, clock };
}

/**
 * PGlite runs one statement at a time, so two requests never interleave on it
 * by themselves. This one lands a statement between two of a transaction's —
 * as another connection committing it then would — right after the
 * transaction's first read of `live_requests`.
 */
class InterleavingPGlite extends PGlite {
  between: { sql: string; params: unknown[] } | null = null;

  override async transaction<T>(callback: (tx: Transaction) => Promise<T>): Promise<T> {
    return super.transaction((tx) =>
      callback(
        new Proxy(tx, {
          get: (target, key) => {
            if (key !== "query") return Reflect.get(target, key) as unknown;
            return async (query: string, params?: unknown[], options?: QueryOptions) => {
              const result = await target.query(query, params, options);
              const between = this.between;
              if (between !== null && /^select\b.*\bfrom "live_requests"/isu.test(query)) {
                this.between = null;
                await target.query(between.sql, between.params);
              }
              return result;
            };
          },
        }),
      ),
    );
  }
}

const verifier = new TokenVerifier(LIVEKIT.apiKey, LIVEKIT.apiSecret);
const decode = (token: string): Promise<ClaimGrants> => verifier.verify(token);

let addresses = 0;
/** Every knock comes from its own address unless a test says otherwise. */
function nextAddress(): string {
  addresses += 1;
  return `10.${String((addresses >> 16) & 255)}.${String((addresses >> 8) & 255)}.${String(addresses & 255)}`;
}

interface Created {
  share: { id: string; title: string; hostName: string | null; admission: string; status: string; room: string };
  link: string;
  livekit: { url: string; token: string; room: string; identity: string };
}

async function startShare(h: Harness, token: string, input: Record<string, unknown> = { title: "Launch plan", hostName: "Zach" }): Promise<Created> {
  const res = await h.request("/v1/live/shares", jsonInit("POST", input, token));
  expect(res.status).toBe(201);
  return json<Created>(res);
}

function linkToken(link: string): string {
  expect(link.startsWith(`${WEB}/live/`)).toBe(true);
  return link.slice(`${WEB}/live/`.length);
}

interface Knocked {
  requestId: string;
  secret: string;
  status: string;
  livekit?: { url: string; token: string; identity: string; color: string };
}

function knockRequest(h: Harness, link: string, name: string, address = nextAddress()): Promise<Response> {
  const init = jsonInit("POST", { name });
  return h.request(`/v1/live/join/${link}/requests`, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), "x-forwarded-for": address },
  });
}

async function knock(h: Harness, link: string, name = "Ada"): Promise<Knocked> {
  const res = await knockRequest(h, link, name);
  expect(res.status).toBe(201);
  return json<Knocked>(res);
}

async function poll(h: Harness, link: string, request: Knocked): Promise<Record<string, unknown>> {
  const res = await h.request(`/v1/live/join/${link}/requests/${request.requestId}`, authed(request.secret));
  expect(res.status).toBe(200);
  return json(res);
}

function decide(h: Harness, token: string, shareId: string, requestId: string, decision: "admit" | "deny"): Promise<Response> {
  return h.request(`/v1/live/shares/${shareId}/requests/${requestId}`, jsonInit("POST", { decision }, token));
}

/* ------------------------------------------------------------------ */

describe("live share configuration", () => {
  it("is off with nothing set, and refuses half a configuration", () => {
    expect(livekitFromEnv({})).toBeNull();
    expect(() => livekitFromEnv({ LIVEKIT_URL: "wss://live.example" })).toThrow(/together/u);
    expect(() => livekitFromEnv({ LIVEKIT_API_KEY: "k", LIVEKIT_API_SECRET: "s" })).toThrow(/together/u);
    expect(() =>
      livekitFromEnv({ LIVEKIT_URL: "https://live.example", LIVEKIT_API_KEY: "k", LIVEKIT_API_SECRET: "s" }),
    ).toThrow(/ws or wss/u);
  });

  it("derives the server API from the client URL unless told", () => {
    expect(livekitFromEnv({ LIVEKIT_URL: "ws://127.0.0.1:7880", LIVEKIT_API_KEY: "devkey", LIVEKIT_API_SECRET: "secret" })).toEqual({
      url: "ws://127.0.0.1:7880",
      apiUrl: "http://127.0.0.1:7880",
      apiKey: "devkey",
      apiSecret: "secret",
    });
    expect(livekitFromEnv({ LIVEKIT_URL: "wss://live.example/", LIVEKIT_API_KEY: "k", LIVEKIT_API_SECRET: "s" })?.apiUrl).toBe(
      "https://live.example",
    );
    expect(
      livekitFromEnv({
        LIVEKIT_URL: "wss://live.example",
        LIVEKIT_API_URL: "http://livekit.internal:7880",
        LIVEKIT_API_KEY: "k",
        LIVEKIT_API_SECRET: "s",
      })?.apiUrl,
    ).toBe("http://livekit.internal:7880");
  });

  it("reads LIVE_MAX_GUESTS, falling back to eight", () => {
    expect(liveMaxGuests({})).toBe(DEFAULT_LIVE_MAX_GUESTS);
    expect(liveMaxGuests({ LIVE_MAX_GUESTS: "3" })).toBe(3);
    for (const bad of ["0", "-1", "2.5", "many", "1000"]) expect(liveMaxGuests({ LIVE_MAX_GUESTS: bad })).toBe(8);
  });

  it("answers live_unavailable on every route when unconfigured", async () => {
    const h = await makeHarness();
    const host = await desktopAccount(h);
    for (const [path, init] of [
      ["/v1/live/shares", jsonInit("POST", { title: "x" }, host.token)],
      [`/v1/live/shares/${crypto.randomUUID()}`, authed(host.token)],
      [`/v1/live/join/${"a".repeat(43)}`, { method: "GET" }],
      [`/v1/live/join/${"a".repeat(43)}/requests`, jsonInit("POST", { name: "Ada" })],
    ] as const) {
      const res = await h.request(path, init);
      expect(res.status, path).toBe(503);
      expect((await json(res))["error"], path).toBe("live_unavailable");
    }
  });
});

describe("live share rules", () => {
  it("cleans names: unprintables out, trimmed, 1–40 characters", () => {
    expect(liveName("  A\u0000da\u202E\n ")).toBe("Ada");
    expect(liveName(" Ada \u200F  Lovelace\t")).toBe("Ada Lovelace");
    expect(liveName("\u0007\u0008")).toBeNull();
    expect(liveName("x".repeat(41))).toBeNull();
    expect(liveName("😀".repeat(40))).toBe("😀".repeat(40));
  });

  it("gives guests the first free colour, then spreads the repeats", () => {
    expect(nextGuestColor([])).toBe(LIVE_COLORS[1]);
    expect(nextGuestColor([LIVE_COLORS[1] ?? ""])).toBe(LIVE_COLORS[2]);
    expect(nextGuestColor([LIVE_COLORS[1] ?? "", LIVE_COLORS[3] ?? ""])).toBe(LIVE_COLORS[2]);
    const all = LIVE_COLORS.slice(1);
    expect(nextGuestColor(all)).toBe(LIVE_COLORS[1]);
    expect(nextGuestColor([...all, LIVE_COLORS[1] ?? ""])).toBe(LIVE_COLORS[2]);
  });

  it("opens the host routes, and only those, to an anonymous account", () => {
    expect(anonymousAllowed("POST", "/v1/live/shares")).toBe(true);
    expect(anonymousAllowed("DELETE", "/v1/live/shares/abc")).toBe(true);
    expect(anonymousAllowed("POST", "/v1/live/shares/abc/heartbeat")).toBe(true);
    expect(anonymousAllowed("GET", "/v1/live/sharesx")).toBe(false);
  });
});

describe("live share", () => {
  let s: Stack;
  let runner: FakeRunner;

  beforeAll(async () => {
    runner = await fakeRunner((path, init) => s.h.request(path, init));
    s = await liveStack({ runner });
  });

  afterAll(async () => {
    await runner.close();
  });

  /* ---------------------------------------------------------------- *
   * Hosting
   * ---------------------------------------------------------------- */

  it("creates a share: a link, a room, and a host token with the host's grants", async () => {
    const host = await desktopAccount(s.h);
    const created = await startShare(s.h, host.token);
    const token = linkToken(created.link);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(created.share).toMatchObject({ title: "Launch plan", hostName: "Zach", admission: "ask", status: "live" });
    expect(created.share.room).toBe(`live_${created.share.id}`);
    expect(created.livekit).toMatchObject({ url: LIVEKIT.url, room: created.share.room, identity: "host" });

    const claims = await decode(created.livekit.token);
    expect(claims.sub).toBe("host");
    expect(claims.name).toBe("Zach");
    expect(JSON.parse(claims.metadata ?? "")).toEqual({ role: "host", color: LIVE_COLORS[0] });
    expect(claims.video).toEqual({
      room: created.share.room,
      roomJoin: true,
      canPublish: true,
      canPublishData: true,
      canSubscribe: true,
      canUpdateOwnMetadata: false,
    });
    expect((claims.exp ?? 0) - (claims.nbf ?? 0)).toBe(6 * 60 * 60);

    // Only the link's hash is kept.
    const [row] = await s.h.db.select().from(schema.liveShares).where(eq(schema.liveShares.id, created.share.id));
    expect(row?.tokenHash).toBe(hashSecret(token));
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("ends this Mac's previous share when it starts another, and closes its room", async () => {
    const host = await desktopAccount(s.h);
    const first = await startShare(s.h, host.token);
    const second = await startShare(s.h, host.token, { title: "Second", hostName: "  " });
    expect(second.share.hostName).toBeNull();
    await s.h.control.idle();
    expect(s.rooms.deleted).toContain(first.share.room);
    const res = await s.h.request(`/v1/live/shares/${first.share.id}`, authed(host.token));
    expect((await json<{ share: { status: string } }>(res)).share.status).toBe("ended");
    const info = await s.h.request(`/v1/live/join/${linkToken(first.link)}`);
    expect((await json(info))["status"]).toBe("ended");
    const live = await s.h.request(`/v1/live/shares/${second.share.id}`, authed(host.token));
    expect((await json<{ share: { status: string } }>(live)).share.status).toBe("live");
  });

  it("holds an account to two live shares across its Macs", async () => {
    const account = await signup(s.h);
    const [a, b, c] = [
      await enrollDesktop(s.h, account.bootstrapToken),
      await enrollDesktop(s.h, account.bootstrapToken),
      await enrollDesktop(s.h, account.bootstrapToken),
    ];
    const first = await startShare(s.h, a.token);
    await startShare(s.h, b.token);
    const opened = s.rooms.opened.length;
    const third = await s.h.request("/v1/live/shares", jsonInit("POST", { title: "Third" }, c.token));
    expect(third.status).toBe(409);
    expect((await json(third))["error"]).toBe("live_too_many_shares");
    // The room opened for it is closed again.
    const [refused] = s.rooms.opened.slice(opened);
    await s.h.control.idle();
    expect(s.rooms.closes(refused?.name ?? "")).toBe(1);
    // A Mac replacing its own share is not a third.
    await startShare(s.h, b.token, { title: "Replaced" });
    await s.h.request(`/v1/live/shares/${first.share.id}`, authed(a.token, "DELETE"));
    await startShare(s.h, c.token, { title: "Third" });
  });

  it("opens the share's room as it starts: room for the guests and the host, closed by LiveKit when long empty", async () => {
    const host = await desktopAccount(s.h);
    const { share } = await startShare(s.h, host.token);
    expect(s.rooms.opened).toContainEqual({
      name: share.room,
      maxParticipants: DEFAULT_LIVE_MAX_GUESTS + 1,
      emptyTimeout: 10 * 60,
      departureTimeout: 10 * 60,
    });
    const few = await liveStack({ env: { LIVE_MAX_GUESTS: "3" } });
    const other = await desktopAccount(few.h);
    const small = await startShare(few.h, other.token);
    expect(few.rooms.opened.find((options) => options.name === small.share.room)?.maxParticipants).toBe(4);
  });

  it("a room that cannot be opened fails the start, and makes nothing", async () => {
    const host = await desktopAccount(s.h);
    const first = await startShare(s.h, host.token);
    s.rooms.createError = new ServerError("unavailable", "twirp error unknown: unavailable", 503, "unavailable");
    try {
      const res = await s.h.request("/v1/live/shares", jsonInit("POST", { title: "Second" }, host.token));
      expect(res.status).toBe(502);
      expect(await json(res)).toEqual({ error: "live_unavailable", reason: "room_failed" });
    } finally {
      s.rooms.createError = null;
    }
    expect(s.h.logs.some((line) => line.includes("opening live_") && line.includes("failed"))).toBe(true);
    // The Mac's share goes on as it was, and no second one was made.
    const rows = await s.h.db.select().from(schema.liveShares).where(eq(schema.liveShares.userId, host.userId));
    expect(rows.map((row) => [row.id, row.status])).toEqual([[first.share.id, "live"]]);
    await s.h.control.idle();
    expect(s.rooms.closes(first.share.room)).toBe(0);
  });

  it("lets a signed-out Mac host", async () => {
    const anon = await anonymousAccount(s.h);
    const created = await startShare(s.h, anon.token);
    const res = await s.h.request(`/v1/live/shares/${created.share.id}`, authed(anon.token));
    expect(res.status).toBe(200);
  });

  it("refuses a bootstrap token and a cloud device", async () => {
    const account = await desktopAccount(s.h);
    const boot = await s.h.request("/v1/live/shares", jsonInit("POST", { title: "x" }, account.bootstrapToken));
    expect(boot.status).toBe(403);
    expect((await json(boot))["error"]).toBe("device_required");

    await enableCloud(s.h, account.token);
    const identity = runner.identities.get(account.userId);
    if (identity === undefined) throw new Error("no cloud device");
    const { token: cloudToken } = await deviceLogin(s.h, identity);
    const cloud = await s.h.request("/v1/live/shares", jsonInit("POST", { title: "x" }, cloudToken));
    expect(cloud.status).toBe(403);
    expect((await json(cloud))["error"]).toBe("cloud_device_forbidden");
  });

  it("answers live_not_found for another account's share, never 403", async () => {
    const owner = await desktopAccount(s.h);
    const other = await desktopAccount(s.h);
    const { share, link } = await startShare(s.h, owner.token);
    const ada = await knock(s.h, linkToken(link));
    const base = `/v1/live/shares/${share.id}`;
    for (const [path, init] of [
      [base, authed(other.token)],
      [base, jsonInit("PATCH", { admission: "open" }, other.token)],
      [base, authed(other.token, "DELETE")],
      [`${base}/heartbeat`, authed(other.token, "POST")],
      [`${base}/requests/${ada.requestId}`, jsonInit("POST", { decision: "admit" }, other.token)],
      [`${base}/participants/g_${ada.requestId}/remove`, authed(other.token, "POST")],
      ["/v1/live/shares/not-a-uuid", authed(owner.token)],
    ] as const) {
      const res = await s.h.request(path, init);
      expect(res.status, `${init.method ?? "GET"} ${path}`).toBe(404);
      expect((await json(res))["error"]).toBe("live_not_found");
    }
    const mine = await s.h.request(base, authed(owner.token));
    expect((await json<{ share: { status: string } }>(mine)).share.status).toBe("live");
  });

  it("renames a share and changes who can join", async () => {
    const host = await desktopAccount(s.h);
    const { share, link } = await startShare(s.h, host.token);
    const res = await s.h.request(`/v1/live/shares/${share.id}`, jsonInit("PATCH", { title: "  Plan B ", admission: "open" }, host.token));
    expect(res.status).toBe(200);
    expect((await json<{ share: Created["share"] }>(res)).share).toMatchObject({ title: "Plan B", admission: "open" });
    const info = await s.h.request(`/v1/live/join/${linkToken(link)}`);
    expect(await json(info)).toEqual({ title: "Plan B", hostName: "Zach", admission: "open", status: "live" });
    const empty = await s.h.request(`/v1/live/shares/${share.id}`, jsonInit("PATCH", {}, host.token));
    expect(empty.status).toBe(400);
  });

  /* ---------------------------------------------------------------- *
   * The lobby
   * ---------------------------------------------------------------- */

  it("tells a guest whose share it is, and that a link it does not know is not one", async () => {
    const host = await desktopAccount(s.h);
    const { link } = await startShare(s.h, host.token);
    const res = await s.h.request(`/v1/live/join/${linkToken(link)}`);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ title: "Launch plan", hostName: "Zach", admission: "ask", status: "live" });
    for (const token of ["b".repeat(43), "too-short", "a".repeat(44)]) {
      const unknown = await s.h.request(`/v1/live/join/${token}`);
      expect(unknown.status, token).toBe(404);
      expect((await json(unknown))["error"]).toBe("live_not_found");
    }
  });

  it("asking: a knock waits, reaches the host, and an admit lets the guest in", async () => {
    const host = await desktopAccount(s.h);
    const { share, link } = await startShare(s.h, host.token);
    const token = linkToken(link);
    const ada = await knock(s.h, token, "Ada");
    expect(ada.status).toBe("pending");
    expect(ada.requestId).toMatch(/^[A-Za-z0-9_-]{12}$/u);
    expect(ada.secret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(ada.livekit).toBeUndefined();

    await s.h.control.idle();
    const knocks = s.rooms.sent.filter((sent) => sent.room === share.room);
    expect(knocks).toEqual([
      {
        room: share.room,
        body: { requestId: ada.requestId, name: "Ada" },
        kind: 0, // DataPacket_Kind.RELIABLE
        options: { topic: "lv.knock", destinationIdentities: ["host"] },
      },
    ]);

    const listed = await json<{ knocks: Array<Record<string, unknown>>; admitted: unknown[] }>(
      await s.h.request(`/v1/live/shares/${share.id}`, authed(host.token)),
    );
    expect(listed.knocks).toEqual([
      expect.objectContaining({ requestId: ada.requestId, identity: `g_${ada.requestId}`, name: "Ada", color: LIVE_COLORS[1], status: "pending" }),
    ]);
    expect(listed.admitted).toEqual([]);

    expect(await poll(s.h, token, ada)).toEqual({ status: "pending" });
    const noSecret = await s.h.request(`/v1/live/join/${token}/requests/${ada.requestId}`);
    expect(noSecret.status).toBe(401);
    const wrongSecret = await s.h.request(`/v1/live/join/${token}/requests/${ada.requestId}`, authed("x".repeat(43)));
    expect(wrongSecret.status).toBe(404);

    const admitted = await decide(s.h, host.token, share.id, ada.requestId, "admit");
    expect(admitted.status).toBe(200);
    expect((await json<{ request: { status: string } }>(admitted)).request.status).toBe("admitted");

    // Let in, they are who the host's room may hold.
    const inRoom = await json<{ knocks: unknown[]; admitted: Array<Record<string, unknown>> }>(
      await s.h.request(`/v1/live/shares/${share.id}`, authed(host.token)),
    );
    expect(inRoom.knocks).toEqual([]);
    expect(inRoom.admitted).toEqual([expect.objectContaining({ requestId: ada.requestId, identity: `g_${ada.requestId}`, name: "Ada", status: "admitted" })]);

    const answer = await poll(s.h, token, ada);
    const lk = answer["livekit"] as NonNullable<Knocked["livekit"]>;
    expect(answer["status"]).toBe("admitted");
    expect(lk).toMatchObject({ url: LIVEKIT.url, identity: `g_${ada.requestId}`, color: LIVE_COLORS[1] });
    const claims = await decode(lk.token);
    expect(claims.sub).toBe(`g_${ada.requestId}`);
    expect(claims.name).toBe("Ada");
    expect(JSON.parse(claims.metadata ?? "")).toEqual({ role: "guest", color: LIVE_COLORS[1] });
    expect(claims.video).toEqual({
      room: share.room,
      roomJoin: true,
      canPublish: true,
      canPublishSources: ["camera", "microphone"],
      canPublishData: true,
      canSubscribe: true,
      canUpdateOwnMetadata: false,
    });
    expect((claims.exp ?? 0) - (claims.nbf ?? 0)).toBe(10 * 60);

    // A reload asks again and gets a token minted now, not one kept.
    const again = await poll(s.h, token, ada);
    const fresh = await decode((again["livekit"] as { token: string }).token);
    expect(Math.abs((fresh.nbf ?? 0) - Date.now() / 1000)).toBeLessThan(5);

    const twice = await decide(s.h, host.token, share.id, ada.requestId, "deny");
    expect(twice.status).toBe(409);
    expect(await json(twice)).toEqual({ error: "live_not_pending", status: "admitted" });
  });

  it("a denied guest hears so and gets no token", async () => {
    const host = await desktopAccount(s.h);
    const { share, link } = await startShare(s.h, host.token);
    const bob = await knock(s.h, linkToken(link), "Bob");
    expect((await decide(s.h, host.token, share.id, bob.requestId, "deny")).status).toBe(200);
    expect(await poll(s.h, linkToken(link), bob)).toEqual({ status: "denied" });
    const listed = await json<{ knocks: unknown[] }>(await s.h.request(`/v1/live/shares/${share.id}`, authed(host.token)));
    expect(listed.knocks).toEqual([]);
  });

  it("anyone with the link: in at once, and the host is not knocked", async () => {
    const host = await desktopAccount(s.h);
    const { share, link } = await startShare(s.h, host.token);
    await s.h.request(`/v1/live/shares/${share.id}`, jsonInit("PATCH", { admission: "open" }, host.token));
    const cy = await knock(s.h, linkToken(link), "Cy");
    expect(cy.status).toBe("admitted");
    expect(cy.livekit?.identity).toBe(`g_${cy.requestId}`);
    expect((await decode(cy.livekit?.token ?? "")).sub).toBe(`g_${cy.requestId}`);
    await s.h.control.idle();
    expect(s.rooms.sent.filter((sent) => sent.room === share.room)).toEqual([]);
  });

  it("holds the room to eight guests", async () => {
    const host = await desktopAccount(s.h);
    const { share, link } = await startShare(s.h, host.token);
    await s.h.request(`/v1/live/shares/${share.id}`, jsonInit("PATCH", { admission: "open" }, host.token));
    for (let i = 0; i < 8; i += 1) expect((await knock(s.h, linkToken(link), `Guest ${String(i)}`)).status).toBe("admitted");
    const ninth = await knockRequest(s.h, linkToken(link), "Ninth");
    expect(ninth.status).toBe(409);
    expect(await json(ninth)).toEqual({ error: "live_full", reason: "guests" });

    // Asking, the ninth can wait but not be let in.
    await s.h.request(`/v1/live/shares/${share.id}`, jsonInit("PATCH", { admission: "ask" }, host.token));
    const waiting = await knock(s.h, linkToken(link), "Waiting");
    const admit = await decide(s.h, host.token, share.id, waiting.requestId, "admit");
    expect(admit.status).toBe(409);
    expect((await json(admit))["error"]).toBe("live_full");
  });

  it("holds the lobby to thirty knocks", async () => {
    const host = await desktopAccount(s.h);
    const { link } = await startShare(s.h, host.token);
    for (let i = 0; i < 30; i += 1) await knock(s.h, linkToken(link), `Knock ${String(i)}`);
    const full = await knockRequest(s.h, linkToken(link), "One more");
    expect(full.status).toBe(409);
    expect(await json(full)).toEqual({ error: "live_full", reason: "lobby" });
  });

  it("gives each guest a colour no one waiting or in holds", async () => {
    const host = await desktopAccount(s.h);
    const { share, link } = await startShare(s.h, host.token);
    const a = await knock(s.h, linkToken(link), "A");
    const b = await knock(s.h, linkToken(link), "B");
    await knock(s.h, linkToken(link), "C");
    await decide(s.h, host.token, share.id, b.requestId, "deny");
    const d = await knock(s.h, linkToken(link), "D");
    await decide(s.h, host.token, share.id, a.requestId, "admit");
    const listed = await json<{ knocks: Array<{ name: string; color: string }> }>(
      await s.h.request(`/v1/live/shares/${share.id}`, authed(host.token)),
    );
    expect(listed.knocks.map((k) => [k.name, k.color])).toEqual([
      ["C", LIVE_COLORS[3]],
      ["D", LIVE_COLORS[2]], // B's, freed by the denial
    ]);
    expect(d.status).toBe("pending");
  });

  it("cleans names and refuses ones that are empty or too long", async () => {
    const host = await desktopAccount(s.h);
    const { share, link } = await startShare(s.h, host.token);
    await knock(s.h, linkToken(link), "  Dee\u0000\u202E\n");
    const listed = await json<{ knocks: Array<{ name: string }> }>(
      await s.h.request(`/v1/live/shares/${share.id}`, authed(host.token)),
    );
    expect(listed.knocks.map((k) => k.name)).toEqual(["Dee"]);
    for (const name of ["", "   ", "\u0000\u0001", "x".repeat(41)]) {
      const res = await knockRequest(s.h, linkToken(link), name);
      expect(res.status, JSON.stringify(name)).toBe(400);
    }
    const longTitle = await s.h.request("/v1/live/shares", jsonInit("POST", { title: "t".repeat(201) }, host.token));
    expect(longTitle.status).toBe(400);
  });

  it("still takes a knock when it cannot reach the host, and logs why", async () => {
    const host = await desktopAccount(s.h);
    const { share, link } = await startShare(s.h, host.token);
    s.rooms.sendError = new Error("connect ECONNREFUSED");
    try {
      const eve = await knock(s.h, linkToken(link), "Eve");
      expect(eve.status).toBe("pending");
      await s.h.control.idle();
    } finally {
      s.rooms.sendError = null;
    }
    expect(s.h.logs.some((line) => line.includes(`knock on ${share.room} not delivered`))).toBe(true);
  });

  /* ---------------------------------------------------------------- *
   * Leaving the room
   * ---------------------------------------------------------------- */

  it("removes a guest: out of the room, and no token ever again", async () => {
    const host = await desktopAccount(s.h);
    const { share, link } = await startShare(s.h, host.token);
    const token = linkToken(link);
    const ada = await knock(s.h, token, "Ada");
    await decide(s.h, host.token, share.id, ada.requestId, "admit");
    const removed = await s.h.request(`/v1/live/shares/${share.id}/participants/g_${ada.requestId}/remove`, authed(host.token, "POST"));
    expect(removed.status).toBe(200);
    expect((await json<{ request: { status: string } }>(removed)).request.status).toBe("removed");
    expect(s.rooms.removed).toContainEqual({ room: share.room, identity: `g_${ada.requestId}` });
    expect(await poll(s.h, token, ada)).toEqual({ status: "removed" });
    // No longer one the host's room may hold: back with a token LiveKit refreshed, the host shows them out again.
    const listed = await json<{ admitted: unknown[] }>(await s.h.request(`/v1/live/shares/${share.id}`, authed(host.token)));
    expect(listed.admitted).toEqual([]);

    for (const identity of ["host", "g_unknown12345", "nobody"]) {
      const res = await s.h.request(`/v1/live/shares/${share.id}/participants/${identity}/remove`, authed(host.token, "POST"));
      expect(res.status, identity).toBe(404);
    }
  });

  it("removing someone already gone from the room is fine; a removal that fails says so", async () => {
    const host = await desktopAccount(s.h);
    const { share, link } = await startShare(s.h, host.token);
    const token = linkToken(link);
    const gone = await knock(s.h, token, "Gone");
    const stuck = await knock(s.h, token, "Stuck");
    const remove = (request: Knocked) =>
      s.h.request(`/v1/live/shares/${share.id}/participants/g_${request.requestId}/remove`, authed(host.token, "POST"));
    try {
      s.rooms.removeError = new ServerError("not_found", "participant not found", 404, "not_found");
      expect((await remove(gone)).status).toBe(200);
      s.rooms.removeError = new Error("livekit unreachable");
      const failed = await remove(stuck);
      expect(failed.status).toBe(502);
      expect((await json(failed))["error"]).toBe("live_unavailable");
    } finally {
      s.rooms.removeError = null;
    }
    // Whatever LiveKit said, the request can no longer mint; asking again retries the removal.
    expect(await poll(s.h, token, stuck)).toEqual({ status: "removed" });
    expect((await remove(stuck)).status).toBe(200);
  });

  it("a guest can cancel a knock or leave the room", async () => {
    const host = await desktopAccount(s.h);
    const { share, link } = await startShare(s.h, host.token);
    const token = linkToken(link);
    const waiting = await knock(s.h, token, "Waiting");
    const inside = await knock(s.h, token, "Inside");
    await decide(s.h, host.token, share.id, inside.requestId, "admit");

    const leave = (request: Knocked) =>
      s.h.request(`/v1/live/join/${token}/requests/${request.requestId}`, authed(request.secret, "DELETE"));
    expect(await json(await leave(waiting))).toEqual({ status: "left" });
    expect(await json(await leave(inside))).toEqual({ status: "left" });
    await s.h.control.idle();
    const out = s.rooms.removed.filter((r) => r.room === share.room).map((r) => r.identity);
    expect(out).toEqual([`g_${inside.requestId}`]);
    expect(await poll(s.h, token, inside)).toEqual({ status: "left" });
    const listed = await json<{ knocks: unknown[]; admitted: unknown[] }>(await s.h.request(`/v1/live/shares/${share.id}`, authed(host.token)));
    expect(listed.knocks).toEqual([]);
    expect(listed.admitted).toEqual([]);
    const wrong = await s.h.request(`/v1/live/join/${token}/requests/${inside.requestId}`, authed(waiting.secret, "DELETE"));
    expect(wrong.status).toBe(404);
  });

  it("ending: the room closes, every request reads ended, and the link is dead", async () => {
    const host = await desktopAccount(s.h);
    const { share, link } = await startShare(s.h, host.token);
    const token = linkToken(link);
    const inside = await knock(s.h, token, "Inside");
    await decide(s.h, host.token, share.id, inside.requestId, "admit");
    const waiting = await knock(s.h, token, "Waiting");

    const ended = await s.h.request(`/v1/live/shares/${share.id}`, authed(host.token, "DELETE"));
    expect(ended.status).toBe(200);
    expect((await json<{ share: { status: string; endedAt: string | null } }>(ended)).share).toMatchObject({ status: "ended" });
    expect(s.rooms.deleted).toContain(share.room);

    expect(await poll(s.h, token, inside)).toEqual({ status: "ended" });
    expect(await poll(s.h, token, waiting)).toEqual({ status: "ended" });
    expect((await json(await s.h.request(`/v1/live/join/${token}`)))["status"]).toBe("ended");
    const late = await knockRequest(s.h, token, "Late");
    expect(late.status).toBe(409);
    expect((await json(late))["error"]).toBe("live_ended");

    for (const [path, init] of [
      [`/v1/live/shares/${share.id}/heartbeat`, authed(host.token, "POST")],
      [`/v1/live/shares/${share.id}`, jsonInit("PATCH", { admission: "open" }, host.token)],
      [`/v1/live/shares/${share.id}/requests/${waiting.requestId}`, jsonInit("POST", { decision: "admit" }, host.token)],
      [`/v1/live/shares/${share.id}/participants/g_${inside.requestId}/remove`, authed(host.token, "POST")],
    ] as const) {
      const res = await s.h.request(path, init);
      expect(res.status, path).toBe(409);
      expect((await json(res))["error"]).toBe("live_ended");
    }
    const listed = await json<{ share: { status: string }; knocks: unknown[] }>(
      await s.h.request(`/v1/live/shares/${share.id}`, authed(host.token)),
    );
    expect(listed).toMatchObject({ share: { status: "ended" }, knocks: [], admitted: [] });
    // Ending again is harmless, and asks nothing of a room already closed.
    expect((await s.h.request(`/v1/live/shares/${share.id}`, authed(host.token, "DELETE"))).status).toBe(200);
    expect(s.rooms.closes(share.room)).toBe(1);
  });

  it("a signed-out Mac signing in to an existing account keeps its share, and its room still closes", async () => {
    const anon = await anonymousAccount(s.h);
    const { share, link } = await startShare(s.h, anon.token);
    const real = await signup(s.h);
    const linked = await s.h.request("/v1/account/link", jsonInit("POST", { anonymousToken: anon.token }, real.bootstrapToken));
    expect(linked.status).toBe(200);
    const { token } = await json<{ token: string }>(linked);

    // Still the Mac's, under its new token, and still live for guests.
    expect((await s.h.request(`/v1/live/shares/${share.id}/heartbeat`, authed(token, "POST"))).status).toBe(200);
    expect((await json(await s.h.request(`/v1/live/join/${linkToken(link)}`)))["status"]).toBe("live");
    expect((await s.h.request(`/v1/live/shares/${share.id}`, authed(token, "DELETE"))).status).toBe(200);
    expect(s.rooms.closes(share.room)).toBe(1);
  });

  it("never logs a link token", async () => {
    const host = await desktopAccount(s.h);
    const { link } = await startShare(s.h, host.token);
    const token = linkToken(link);
    const ada = await knock(s.h, token, "Ada");
    await poll(s.h, token, ada);
    await s.h.request(`/v1/live/join/${token}`);
    await s.h.request(`/v1/live/join/${token}x`);
    const lines = s.h.logs.filter((line) => line.includes("/v1/live/join/"));
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const line of lines) {
      expect(line).not.toContain(token);
      expect(line).not.toContain(ada.secret);
      expect(line).toContain("/v1/live/join/:token");
    }
  });
});

describe("live share, concurrently", () => {
  it("an admit never brings back a knock the guest cancelled while the host decided", async () => {
    const pg = new InterleavingPGlite();
    const db = drizzle(pg, { schema });
    await ensureSchema(db);
    const s = await liveStack({ db });
    const host = await desktopAccount(s.h);
    const { share, link } = await startShare(s.h, host.token);
    const token = linkToken(link);
    const ada = await knock(s.h, token, "Ada");
    // The admit reads the knock pending; Ada's cancel (as `release` writes it, with no lock on the share) lands next.
    pg.between = {
      sql: "update live_requests set status = 'left', decided_at = now() where id = $1 and status in ('pending', 'admitted')",
      params: [ada.requestId],
    };
    const admit = await decide(s.h, host.token, share.id, ada.requestId, "admit");
    expect(pg.between).toBeNull();
    expect(admit.status).toBe(409);
    expect(await json(admit)).toEqual({ error: "live_not_pending", status: "left" });
    // Still cancelled: no token for her, and no place taken.
    expect(await poll(s.h, token, ada)).toEqual({ status: "left" });
    const listed = await json<{ knocks: unknown[]; admitted: unknown[] }>(await s.h.request(`/v1/live/shares/${share.id}`, authed(host.token)));
    expect(listed).toMatchObject({ knocks: [], admitted: [] });
  });

  it("a close answering after the room opened again leaves that room to be closed", async () => {
    const s = await liveStack();
    const host = await desktopAccount(s.h);
    const { share } = await startShare(s.h, host.token);
    const beat = () => s.h.request(`/v1/live/shares/${share.id}/heartbeat`, authed(host.token, "POST"));
    // A heartbeat's open is on its way as the host stops sharing. The stop's
    // close reaches LiveKit first and is still to answer when the open lands,
    // opening the room again; the heartbeat's close of that one fails, and
    // only then does the stop's close answer that it closed the room.
    let stopped: Promise<Response | null> = Promise.resolve(null);
    s.rooms.whileOpening = async () => {
      s.rooms.whileOpening = null;
      const reached = new Promise<void>((resolve) => {
        s.rooms.whileDeleting = async () => {
          s.rooms.whileDeleting = null;
          s.rooms.deleteError = new Error("livekit unreachable");
          resolve();
          await s.h.control.idle();
          s.rooms.deleteError = null;
        };
      });
      stopped = s.h.request(`/v1/live/shares/${share.id}`, authed(host.token, "DELETE"));
      await reached;
    };
    s.clock.at += 60_000;
    expect((await beat()).status).toBe(200);
    await s.h.control.idle();
    expect((await stopped)?.status).toBe(200);
    expect(s.rooms.opens(share.room)).toBe(2);
    expect(s.rooms.closes(share.room)).toBe(2);
    expect(s.h.logs.some((line) => line.includes(`closing ${share.room} failed (try 2)`))).toBe(true);

    // The room the heartbeat opened is still to close: the sweep closes it in its turn, two minutes on, and asks no more.
    for (let minute = 0; minute < 60; minute += 1) {
      s.clock.at += 60_000;
      await s.h.control.sweepLiveShares();
      if (minute === 0) expect(s.rooms.closes(share.room)).toBe(2);
    }
    expect(s.rooms.closes(share.room)).toBe(3);
  });
});

describe("live share over time", () => {
  it("rate limits knocks per address and per share", async () => {
    const s = await liveStack();
    const host = await desktopAccount(s.h);
    const { link } = await startShare(s.h, host.token);
    const token = linkToken(link);
    for (let i = 0; i < 10; i += 1) expect((await knockRequest(s.h, token, "Same", "203.0.113.7")).status).toBe(201);
    const limited = await knockRequest(s.h, token, "Same", "203.0.113.7");
    expect(limited.status).toBe(429);
    expect((await json(limited))["error"]).toBe("live_rate_limited");

    // Sixty a minute for the share, whatever came of them (ten above, the lobby filling at thirty).
    for (let i = 10; i < 60; i += 1) expect((await knockRequest(s.h, token, "Many")).status).not.toBe(429);
    expect((await knockRequest(s.h, token, "Many")).status).toBe(429);

    s.clock.at += 60_000;
    expect((await knockRequest(s.h, token, "Same", "203.0.113.7")).status).not.toBe(429);
  });

  it("hands the host a fresh token when theirs is within an hour of running out", async () => {
    const s = await liveStack();
    const host = await desktopAccount(s.h);
    const { share } = await startShare(s.h, host.token);
    const beat = async () => {
      // Hours pass here, and a device token lasts minutes: sign in again as the Mac would.
      const { token } = await deviceLogin(s.h, host.keys);
      const res = await s.h.request(`/v1/live/shares/${share.id}/heartbeat`, authed(token, "POST"));
      expect(res.status).toBe(200);
      return json<{ share: { status: string }; livekit?: Created["livekit"] }>(res);
    };
    s.clock.at += 60_000;
    expect((await beat()).livekit).toBeUndefined();
    s.clock.at += 5 * 60 * 60 * 1000;
    const refreshed = await beat();
    expect(refreshed.livekit).toMatchObject({ url: LIVEKIT.url, room: share.room, identity: "host" });
    expect((await decode(refreshed.livekit?.token ?? "")).sub).toBe("host");
    s.clock.at += 60_000;
    expect((await beat()).livekit).toBeUndefined();
  });

  it("hands the host a fresh token whenever it asks, though control's record says the one it holds is new — at most ten a share in ten minutes", async () => {
    const s = await liveStack();
    const host = await desktopAccount(s.h);
    const { share } = await startShare(s.h, host.token);
    let token = host.token;
    // Hours pass here, and a device token lasts minutes: the Mac signs in again after each wait.
    const wait = async (ms: number) => {
      s.clock.at += ms;
      ({ token } = await deviceLogin(s.h, host.keys));
    };
    const beat = async (ask?: unknown) => {
      const init = ask === undefined ? authed(token, "POST") : jsonInit("POST", ask, token);
      const res = await s.h.request(`/v1/live/shares/${share.id}/heartbeat`, init);
      expect(res.status).toBe(200);
      return json<{ share: { status: string }; livekit?: Created["livekit"] }>(res);
    };
    await wait(5 * 60 * 60 * 1000);
    // The answer bringing the next token never reaches the Mac: control holds that one new, the Mac the old one.
    expect((await beat()).livekit).toBeDefined();
    await wait(60 * 60 * 1000);
    expect((await beat()).livekit).toBeUndefined();
    // Its room must join again, and the token it holds has run out: asked for, a fresh one comes.
    const asked = await beat({ refresh: true });
    expect(asked.livekit).toMatchObject({ url: LIVEKIT.url, room: share.room, identity: "host" });
    const claims = await decode(asked.livekit?.token ?? "");
    expect(claims.sub).toBe("host");
    expect(claims.video?.room).toBe(share.room);
    // Asking is bounded: past ten in ten minutes the heartbeat answers as if not asked, and still keeps the share.
    for (let i = 1; i < 10; i += 1) expect((await beat({ refresh: true })).livekit).toBeDefined();
    const limited = await beat({ refresh: true });
    expect(limited.livekit).toBeUndefined();
    expect(limited.share.status).toBe("live");
    await wait(10 * 60 * 1000);
    expect((await beat({ refresh: true })).livekit).toBeDefined();
    // Not asking is a plain heartbeat; an ask control cannot read is refused.
    expect((await beat({ refresh: false })).livekit).toBeUndefined();
    expect((await beat({})).livekit).toBeUndefined();
    const garbled = await s.h.request(`/v1/live/shares/${share.id}/heartbeat`, jsonInit("POST", { refresh: "yes" }, token));
    expect(garbled.status).toBe(400);
  });

  it("frees the places of guests gone without leaving: missing from the room at two looks 2 min apart, no token taken between", async () => {
    const s = await liveStack();
    const host = await desktopAccount(s.h);
    const { share, link } = await startShare(s.h, host.token);
    const token = linkToken(link);
    await s.h.request(`/v1/live/shares/${share.id}`, jsonInit("PATCH", { admission: "open" }, host.token));
    const guests: Knocked[] = [];
    for (let i = 0; i < 8; i += 1) guests.push(await knock(s.h, token, `Guest ${String(i)}`));
    const [stays, reloads, ...closed] = guests as [Knocked, Knocked, ...Knocked[]];
    const identity = (guest: Knocked): string => `g_${guest.requestId}`;
    const admitted = async (): Promise<string[]> =>
      (await json<{ admitted: Array<{ identity: string }> }>(await s.h.request(`/v1/live/shares/${share.id}`, authed(host.token)))).admitted.map((guest) => guest.identity);
    const released: number[] = [];
    const minute = async (): Promise<void> => {
      s.clock.at += 60_000;
      released.push((await s.h.control.sweepLiveShares()).releasedLiveGuests);
    };

    // Six closed their tabs without Leave and one is reloading: all eight still hold their places.
    s.rooms.inRoom.set(share.room, ["host", identity(stays)]);
    await minute();
    expect((await knockRequest(s.h, token, "Ninth")).status).toBe(409);
    // A minute on, the reload takes its token (and is still connecting at the next look).
    expect(await poll(s.h, token, reloads)).toMatchObject({ status: "admitted", livekit: { identity: identity(reloads) } });
    await minute();
    expect(await admitted()).toHaveLength(8);
    // Two minutes after they were first missed, the six are gone; the reload, missed once since its token, is not.
    await minute();
    for (const guest of closed) expect(await poll(s.h, token, guest)).toEqual({ status: "left" });
    expect(await admitted()).toEqual([identity(stays), identity(reloads)]);
    const ninth = await knock(s.h, token, "Ninth");
    expect(ninth.status).toBe("admitted");
    expect(released).toEqual([0, 0, 6]);
    // Back in the room, the reload is about again; the ninth, joining, is not yet missed long enough.
    s.rooms.inRoom.set(share.room, ["host", identity(stays), identity(reloads)]);
    await minute();
    await minute();
    expect(await admitted()).toEqual([identity(stays), identity(reloads), identity(ninth)]);

    // A room LiveKit cannot be asked about keeps everyone it has.
    s.rooms.inRoom.set(share.room, ["host"]);
    s.rooms.listError = new ServerError("unavailable", "twirp error unknown: unavailable", 503, "unavailable");
    await minute();
    await minute();
    await minute();
    expect(await admitted()).toHaveLength(3);
    expect(released.slice(3)).toEqual([0, 0, 0, 0, 0]);
    expect(s.h.logs.some((line) => line.includes(`asking who is in ${share.room} failed`))).toBe(true);
  });

  it("opens the room again at each heartbeat, in case LiveKit lost it, and closes one opened as the share ended", async () => {
    const s = await liveStack();
    const host = await desktopAccount(s.h);
    const { share } = await startShare(s.h, host.token);
    const beat = () => s.h.request(`/v1/live/shares/${share.id}/heartbeat`, authed(host.token, "POST"));
    expect(s.rooms.opens(share.room)).toBe(1);
    s.clock.at += 60_000;
    expect((await beat()).status).toBe(200);
    await s.h.control.idle();
    expect(s.rooms.opens(share.room)).toBe(2);

    // LiveKit out of reach: the heartbeat still answers, and the log says why.
    s.rooms.createError = new Error("livekit unreachable");
    s.clock.at += 60_000;
    expect((await beat()).status).toBe(200);
    await s.h.control.idle();
    expect(s.h.logs.some((line) => line.includes(`opening ${share.room} failed`))).toBe(true);
    s.rooms.createError = null;

    // The host stops sharing while a heartbeat's open is on its way: the room it opens after the stop closed it is closed again.
    s.rooms.whileOpening = async () => {
      s.rooms.whileOpening = null;
      expect((await s.h.request(`/v1/live/shares/${share.id}`, authed(host.token, "DELETE"))).status).toBe(200);
      expect(s.rooms.closes(share.room)).toBe(1);
    };
    s.clock.at += 60_000;
    expect((await beat()).status).toBe(200);
    await s.h.control.idle();
    expect(s.rooms.whileOpening).toBeNull();
    expect(s.rooms.closes(share.room)).toBe(2);
    s.clock.at += 60 * 60 * 1000;
    await s.h.control.sweepLiveShares();
    expect(s.rooms.closes(share.room)).toBe(2);
    expect(s.rooms.opens(share.room)).toBe(4);
  });

  it("closes a room that would not close at the next sweep, and asks no more once it has", async () => {
    const s = await liveStack();
    const host = await desktopAccount(s.h);
    const other = await desktopAccount(s.h);
    const stopped = await startShare(s.h, host.token);
    const replaced = await startShare(s.h, other.token);
    s.rooms.deleteError = new ServerError("unavailable", "twirp error unknown: unavailable", 503, "unavailable");

    // The host stops sharing, and the other Mac starts sharing something else: both shares end, though neither room closes.
    const res = await s.h.request(`/v1/live/shares/${stopped.share.id}`, authed(host.token, "DELETE"));
    expect(res.status).toBe(200);
    expect((await json<{ share: { status: string } }>(res)).share.status).toBe("ended");
    const next = await startShare(s.h, other.token, { title: "Next" });
    await s.h.control.idle();
    for (const room of [stopped.share.room, replaced.share.room]) {
      expect(s.rooms.closes(room)).toBe(1);
      expect(s.h.logs.some((line) => line.includes(`closing ${room} failed`))).toBe(true);
    }

    // A minute on LiveKit answers again: the sweep closes both rooms, and no sweep after asks about them.
    s.rooms.deleteError = null;
    for (let minute = 0; minute < 5; minute += 1) {
      s.clock.at += 60_000;
      await s.h.control.sweepLiveShares();
    }
    s.clock.at += 2 * 60 * 60 * 1000;
    expect(await s.h.control.sweepLiveShares()).toMatchObject({ endedLiveShares: 1 });
    expect(s.rooms.closes(stopped.share.room)).toBe(2);
    expect(s.rooms.closes(replaced.share.room)).toBe(2);
    // (The other Mac went quiet meanwhile: its share ended, and its room closed at the first try.)
    expect(s.rooms.closes(next.share.room)).toBe(1);

    // Stopping again asks nothing of a room already closed. (Hours on: the Mac signs in again.)
    const { token: later } = await deviceLogin(s.h, host.keys);
    expect((await s.h.request(`/v1/live/shares/${stopped.share.id}`, authed(later, "DELETE"))).status).toBe(200);
    expect(s.rooms.closes(stopped.share.room)).toBe(2);
  });

  it("asks again ever further apart while a room will not close, until it does or its share is forgotten", async () => {
    const s = await liveStack();
    const start = s.clock.at;
    const host = await desktopAccount(s.h);
    const silent = await startShare(s.h, host.token);
    s.rooms.deleteError = new Error("livekit unreachable");

    // Silent past ten minutes, the share ends; its room is asked about at once, then 1, 2, 4… minutes on, an hour apart at most.
    const asked: number[] = [];
    for (let minute = 11; minute <= 11 + 130; minute += 1) {
      s.clock.at = start + minute * 60_000;
      const before = s.rooms.closes(silent.share.room);
      await s.h.control.sweepLiveShares();
      if (s.rooms.closes(silent.share.room) > before) asked.push(minute - 11);
    }
    expect(asked).toEqual([0, 1, 3, 7, 15, 31, 63, 123]);

    // Its next try finds LiveKit back: closed, and never asked about again.
    s.rooms.deleteError = null;
    s.clock.at = start + (11 + 183) * 60_000;
    await s.h.control.sweepLiveShares();
    expect(s.rooms.closes(silent.share.room)).toBe(asked.length + 1);
    s.clock.at += 6 * 60 * 60 * 1000;
    await s.h.control.sweepLiveShares();
    expect(s.rooms.closes(silent.share.room)).toBe(asked.length + 1);

    // A room that never closes is given up a week after its share ended, with the share. (Hours on: the Mac signs in again.)
    const { token: later } = await deviceLogin(s.h, host.keys);
    const stuck = await startShare(s.h, later, { title: "Stuck" });
    s.rooms.deleteError = new Error("livekit unreachable");
    expect((await s.h.request(`/v1/live/shares/${stuck.share.id}`, authed(later, "DELETE"))).status).toBe(200);
    s.clock.at += 7 * 24 * 60 * 60 * 1000 + 60_000;
    expect(await s.h.control.sweepLiveShares()).toMatchObject({ prunedLiveShares: 2 });
    expect(s.h.logs.some((line) => line.includes(`giving up on closing ${stuck.share.room}`))).toBe(true);
    expect(s.h.logs.some((line) => line.includes(`giving up on closing ${silent.share.room}`))).toBe(false);
    const tries = s.rooms.closes(stuck.share.room);
    s.clock.at += 60 * 60 * 1000;
    await s.h.control.sweepLiveShares();
    expect(s.rooms.closes(stuck.share.room)).toBe(tries);
  });

  it("counts a room LiveKit says it no longer has as closed", async () => {
    const s = await liveStack();
    const host = await desktopAccount(s.h);
    const { share } = await startShare(s.h, host.token);
    // The first try's answer is lost (LiveKit may have closed it anyway); the next is told there is no such room.
    s.rooms.deleteError = new Error("socket hang up");
    expect((await s.h.request(`/v1/live/shares/${share.id}`, authed(host.token, "DELETE"))).status).toBe(200);
    s.rooms.deleteError = new ServerError("not_found", "twirp error not_found: requested room does not exist", 404, "not_found");
    for (let minute = 0; minute < 10; minute += 1) {
      s.clock.at += 60_000;
      await s.h.control.sweepLiveShares();
    }
    expect(s.rooms.closes(share.room)).toBe(2);
    expect(s.h.logs.filter((line) => line.includes(`closing ${share.room} failed`))).toHaveLength(1);
  });

  it("ends shares whose host went silent, and forgets ended ones after a week", async () => {
    const s = await liveStack();
    const host = await desktopAccount(s.h);
    const other = await desktopAccount(s.h);
    const silent = await startShare(s.h, host.token);
    const heard = await startShare(s.h, other.token);
    await knock(s.h, linkToken(silent.link), "Ada");

    s.clock.at += 5 * 60 * 1000;
    expect((await s.h.request(`/v1/live/shares/${heard.share.id}/heartbeat`, authed(other.token, "POST"))).status).toBe(200);
    s.clock.at += 6 * 60 * 1000;
    expect(await s.h.control.sweepLiveShares()).toEqual({ endedLiveShares: 1, releasedLiveGuests: 0, prunedLiveShares: 0 });
    expect(s.rooms.deleted).toEqual([silent.share.room]);
    expect((await json(await s.h.request(`/v1/live/join/${linkToken(silent.link)}`)))["status"]).toBe("ended");
    expect((await json(await s.h.request(`/v1/live/join/${linkToken(heard.link)}`)))["status"]).toBe("live");

    const { token: later } = await deviceLogin(s.h, other.keys);
    expect((await s.h.request(`/v1/live/shares/${heard.share.id}`, authed(later, "DELETE"))).status).toBe(200);
    s.clock.at += 7 * 24 * 60 * 60 * 1000 - 60_000;
    expect(await s.h.control.runMaintenance()).toMatchObject({ endedLiveShares: 0, prunedLiveShares: 0 });
    s.clock.at += 60 * 60 * 1000;
    expect(await s.h.control.runMaintenance()).toMatchObject({ endedLiveShares: 0, prunedLiveShares: 2 });
    expect((await s.h.request(`/v1/live/join/${linkToken(silent.link)}`)).status).toBe(404);
    expect(await s.h.db.select().from(schema.liveShares)).toEqual([]);
    expect(await s.h.db.select().from(schema.liveRequests)).toEqual([]);
  });
});
