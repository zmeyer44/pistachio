import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import {
  EXCLUSIVE_LEASE_TTL_MS,
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
} from "@pistachio/sync-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { CLOSE_MALFORMED, CLOSE_REVOKED, type HubStorage } from "../src/hub-core.js";
import {
  attachSyncHub,
  type HubHost,
  type VerifiedHubToken,
} from "../src/host/node.js";
import { MemoryHubStorage } from "../src/storage/memory.js";
import { hex64, makeHlc, makeRecord } from "./helpers.js";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const PATH = "/v1/hub/ws";

const TOKENS: Record<string, VerifiedHubToken> = {
  "tok-a": { userId: U1, deviceId: "dev-a", platform: "macos", revoked: false },
  "tok-b": { userId: U1, deviceId: "dev-b", platform: "macos", revoked: false },
  "tok-c": { userId: U1, deviceId: "dev-c", platform: "cloud", revoked: false },
  "tok-boot": { userId: U1, deviceId: null, platform: null, revoked: false },
  "tok-revoked": { userId: U1, deviceId: "dev-r", platform: "macos", revoked: true },
  "tok-other": { userId: U2, deviceId: "dev-o", platform: "macos", revoked: false },
};

let server: Server;
let host: HubHost;
let baseUrl: string;
const storages = new Map<string, MemoryHubStorage>();
const clock = { nowMs: 1_000_000 };
const seenUpgradeUrls: string[] = [];
const verifiedTokens: string[] = [];

function storageFor(userId: string): HubStorage {
  let storage = storages.get(userId);
  if (storage === undefined) {
    storage = new MemoryHubStorage();
    storages.set(userId, storage);
  }
  return storage;
}

class Client {
  readonly frames: ServerMessage[] = [];
  private readonly waiters: { resolve: () => void }[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;

  private constructor(readonly ws: WebSocket) {
    this.closed = new Promise((resolve) => {
      ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    ws.on("message", (data) => {
      this.frames.push(parseServerMessage(data.toString()));
      for (const waiter of this.waiters.splice(0)) waiter.resolve();
    });
  }

  static open(token: string, via: "header" | "query" = "header"): Promise<Client> {
    const url = via === "query" ? `${baseUrl}${PATH}?access_token=${token}` : `${baseUrl}${PATH}`;
    const ws = new WebSocket(
      url,
      via === "header" ? { headers: { authorization: `Bearer ${token}` } } : {},
    );
    const client = new Client(ws);
    return new Promise((resolve, reject) => {
      ws.once("open", () => resolve(client));
      ws.once("error", reject);
      ws.once("unexpected-response", (_req, res) =>
        reject(new Error(`upgrade rejected with ${res.statusCode}`)),
      );
    });
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Remove and return the first buffered frame of type `t`, waiting for it. */
  async next<T extends ServerMessage["t"]>(t: T, timeoutMs = 3_000): Promise<Extract<ServerMessage, { t: T }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.frames.findIndex((frame) => frame.t === t);
      if (index >= 0) {
        const [frame] = this.frames.splice(index, 1);
        return frame as Extract<ServerMessage, { t: T }>;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for ${t}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiters.push({
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        });
      });
    }
  }

  close(): Promise<{ code: number; reason: string }> {
    this.ws.close();
    return this.closed;
  }
}

/** Status of a rejected upgrade (the client never opens). */
function upgradeStatus(token: string | null, path = PATH): Promise<number> {
  const ws = new WebSocket(
    `${baseUrl}${path}`,
    token === null ? {} : { headers: { authorization: `Bearer ${token}` } },
  );
  return new Promise((resolve, reject) => {
    ws.once("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
    });
    ws.once("open", () => reject(new Error("upgrade unexpectedly succeeded")));
    ws.once("error", reject);
  });
}

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `ws://127.0.0.1:${port}`;
  host = attachSyncHub(server, {
    path: PATH,
    verifyToken: async (token) => {
      verifiedTokens.push(token);
      // A slow lookup widens the window in which the raw socket has no owner.
      if (token === "tok-slow") {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return TOKENS["tok-a"] ?? null;
      }
      return TOKENS[token] ?? null;
    },
    storageFor,
    now: () => clock.nowMs,
    livenessIntervalMs: 100,
  });
  // Registered after the hub: sees the request URL as the hub left it.
  server.on("upgrade", (req) => {
    seenUpgradeUrls.push(req.url ?? "");
  });
});

afterAll(async () => {
  await host.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("upgrade handling", () => {
  it("survives a client that resets the connection while its token is being verified", async () => {
    const { port } = server.address() as AddressInfo;
    const socket = connect(port, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(
      `GET ${PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n" +
        "Authorization: Bearer tok-slow\r\n\r\n",
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    // RST rather than FIN: the server-side socket emits 'error', which with
    // no listener would be an uncaught exception ending the process.
    socket.resetAndDestroy();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const client = await Client.open("tok-a");
    await client.close();
  });

  it("terminates a socket that stops answering liveness pings", async () => {
    const ws = new WebSocket(`${baseUrl}${PATH}`, {
      headers: { authorization: "Bearer tok-a" },
      autoPong: false,
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const code = await new Promise<number>((resolve) => ws.once("close", (value) => resolve(value)));
    expect(code).toBe(1006);
  });

  it("rejects a missing or unknown token with 401 before the handshake", async () => {
    expect(await upgradeStatus(null)).toBe(401);
    expect(await upgradeStatus("tok-nope")).toBe(401);
  });

  it("rejects a bootstrap token with 403 before the handshake", async () => {
    expect(await upgradeStatus("tok-boot")).toBe(403);
  });

  it("answers other paths with 404", async () => {
    expect(await upgradeStatus("tok-a", "/somewhere/else")).toBe(404);
  });

  it("completes the handshake for a revoked device, then closes 4003", async () => {
    const client = await Client.open("tok-revoked");
    const closed = await client.closed;
    expect(closed).toEqual({ code: CLOSE_REVOKED, reason: "revoked" });
    expect(client.frames).toHaveLength(0);
  });

  it("scrubs ?access_token= from the request URL before any later listener sees it", async () => {
    seenUpgradeUrls.length = 0;
    const client = await Client.open("tok-a", "query");
    expect(seenUpgradeUrls).toEqual([PATH]);
    expect(verifiedTokens).toContain("tok-a");
    await client.close();
  });
});

describe("hello / publish / hydrate round trip", () => {
  it("binds identity from the token and syncs two devices of one user", async () => {
    const a = await Client.open("tok-a");
    a.send({ t: "hello", deviceId: "dev-a", kind: "desktop", spaceIds: ["s1"] });
    const ackA = await a.next("hello.ack");
    expect(ackA.serverTimeMs).toBe(clock.nowMs);
    expect(ackA.presence).toContainEqual({
      deviceId: "dev-a",
      kind: "desktop",
      online: true,
      lastSeenMs: clock.nowMs,
    });

    const b = await Client.open("tok-b", "query");
    b.send({ t: "hello", deviceId: "dev-b", kind: "desktop", spaceIds: ["s1"] });
    const ackB = await b.next("hello.ack");
    expect(ackB.presence.map((p) => p.deviceId).sort()).toEqual(["dev-a", "dev-b"]);
    const presence = await a.next("presence");
    expect(presence.devices[0]).toMatchObject({ deviceId: "dev-b", online: true });

    const record = makeRecord({ spaceId: "s1", hlc: makeHlc(10, "dev-a") });
    a.send({ t: "publish", records: [record] });
    const ack = await a.next("publish.ack");
    expect(ack.accepted).toEqual([record.recordId]);
    const fanout = await b.next("records");
    expect(fanout.records).toEqual([record]);

    b.send({ t: "hydrate", spaceId: "s1", sinceHlc: null });
    const hydrated = await b.next("records");
    expect(hydrated.records).toEqual([record]);
    const done = await b.next("hydrate.done");
    expect(done).toEqual({ t: "hydrate.done", spaceId: "s1", count: 1, watermark: record.hlc });

    // Another user's device sees none of it.
    const o = await Client.open("tok-other");
    o.send({ t: "hello", deviceId: "dev-o", kind: "desktop", spaceIds: ["s1"] });
    const ackO = await o.next("hello.ack");
    expect(ackO.presence.map((p) => p.deviceId)).toEqual(["dev-o"]);
    o.send({ t: "hydrate", spaceId: "s1", sinceHlc: null });
    expect((await o.next("hydrate.done")).count).toBe(0);

    await Promise.all([a.close(), b.close(), o.close()]);
  });

  it("frames before hello get hello_required; a mismatched hello closes 4400", async () => {
    const early = await Client.open("tok-a");
    early.send({ t: "ping" });
    expect((await early.next("error")).code).toBe("hello_required");
    await early.close();

    const liar = await Client.open("tok-a");
    liar.send({ t: "hello", deviceId: "dev-b", kind: "desktop", spaceIds: [] });
    expect((await liar.next("error")).code).toBe("device_mismatch");
    expect(await liar.closed).toEqual({ code: CLOSE_MALFORMED, reason: "device_mismatch" });

    const wrongKind = await Client.open("tok-a");
    wrongKind.send({ t: "hello", deviceId: "dev-a", kind: "cloud", spaceIds: [] });
    expect((await wrongKind.next("error")).code).toBe("device_mismatch");
    expect((await wrongKind.closed).code).toBe(CLOSE_MALFORMED);
  });

  it("binds kind cloud from the platform and grants exclusive leases", async () => {
    const c = await Client.open("tok-c");
    c.send({ t: "hello", deviceId: "dev-c", kind: "cloud", spaceIds: ["s1"] });
    const ack = await c.next("hello.ack");
    expect(ack.presence).toContainEqual(expect.objectContaining({ deviceId: "dev-c", kind: "cloud" }));

    const originId = hex64(0xcafe);
    c.send({ t: "lease.acquire", spaceId: "s1", originId, exclusive: true });
    const granted = await c.next("lease.granted");
    expect(granted.exclusive).toBe(true);
    expect(granted.expiresAtMs).toBe(clock.nowMs + EXCLUSIVE_LEASE_TTL_MS);

    const a = await Client.open("tok-a");
    a.send({ t: "hello", deviceId: "dev-a", kind: "desktop", spaceIds: ["s1"] });
    await a.next("hello.ack");
    a.send({ t: "lease.acquire", spaceId: "s1", originId });
    const denied = await a.next("lease.denied");
    expect(denied).toMatchObject({ holderDeviceId: "dev-c", holderKind: "cloud", exclusive: true });

    // The host releases the run's leases; every socket hears it.
    await host.releaseLeases(U1, { deviceId: "dev-c", spaceId: "s1" });
    expect(await a.next("lease.released")).toEqual({ t: "lease.released", spaceId: "s1", originId });
    expect(await c.next("lease.released")).toEqual({ t: "lease.released", spaceId: "s1", originId });
    a.send({ t: "lease.acquire", spaceId: "s1", originId });
    expect((await a.next("lease.granted")).holderDeviceId).toBe("dev-a");

    await Promise.all([a.close(), c.close()]);
  });
});

describe("HubHost", () => {
  it("broadcast reaches every socket of the user and nobody else", async () => {
    const a = await Client.open("tok-a");
    const b = await Client.open("tok-b");
    const o = await Client.open("tok-other");
    await host.broadcast(U1, { t: "pong" });
    await a.next("pong");
    await b.next("pong");
    await host.broadcast("no-such-user", { t: "pong" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(o.frames).toHaveLength(0);
    await Promise.all([a.close(), b.close(), o.close()]);
  });

  it("revokeDevice closes the device's sockets with 4003, tells peers, and blocks reconnects", async () => {
    const a = await Client.open("tok-a");
    a.send({ t: "hello", deviceId: "dev-a", kind: "desktop", spaceIds: ["s1"] });
    await a.next("hello.ack");
    const b = await Client.open("tok-b");
    b.send({ t: "hello", deviceId: "dev-b", kind: "desktop", spaceIds: ["s1"] });
    await b.next("hello.ack");
    await a.next("presence");
    const originId = hex64(0xbeef);
    b.send({ t: "lease.acquire", spaceId: "s1", originId });
    await b.next("lease.granted");

    await host.revokeDevice(U1, "dev-b");
    expect(await b.closed).toEqual({ code: CLOSE_REVOKED, reason: "revoked" });
    const offline = await a.next("presence");
    expect(offline.devices[0]).toMatchObject({ deviceId: "dev-b", online: false });
    expect(await a.next("lease.released")).toEqual({ t: "lease.released", spaceId: "s1", originId });

    // The token still verifies, but the hub remembers the revocation.
    const again = await Client.open("tok-b");
    again.send({ t: "hello", deviceId: "dev-b", kind: "desktop", spaceIds: [] });
    expect(await again.closed).toEqual({ code: CLOSE_REVOKED, reason: "revoked" });

    await a.close();
  });

  it("gc runs over cached users without disturbing live state", async () => {
    const a = await Client.open("tok-a");
    a.send({ t: "hello", deviceId: "dev-a", kind: "desktop", spaceIds: ["s1"] });
    await a.next("hello.ack");
    await host.gc(clock.nowMs + 400 * 24 * 60 * 60 * 1000);
    expect(await storageFor(U1).get("presence:dev-a")).toBeDefined();
    a.send({ t: "ping" });
    await a.next("pong");
    await a.close();
  });

  it("serializes handlers per user so bursts of frames keep their order", async () => {
    const a = await Client.open("tok-a");
    a.send({ t: "hello", deviceId: "dev-a", kind: "desktop", spaceIds: ["s1"] });
    const records = Array.from({ length: 20 }, (_, i) =>
      makeRecord({ spaceId: "s1", originId: hex64(5_000 + i), hlc: makeHlc(100 + i, "dev-a") }),
    );
    for (const record of records) a.send({ t: "publish", records: [record] });
    a.send({ t: "hydrate", spaceId: "s1", sinceHlc: makeHlc(99, "dev-a") });
    await a.next("hello.ack");
    for (const record of records) {
      expect((await a.next("publish.ack")).accepted).toEqual([record.recordId]);
    }
    const streamed = (await a.next("records")).records;
    expect(streamed.map((r) => r.recordId)).toEqual(records.map((r) => r.recordId));
    await a.close();
  });
});
