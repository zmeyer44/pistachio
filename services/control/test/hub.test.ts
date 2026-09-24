/**
 * Hub attachment (§7.4): the real ws upgrade against control's
 * `authenticateToken` — bootstrap 403, revoked 4003, a device hello round
 * trip, `access_token` scrubbed from every captured log line — and the
 * `hub_kv` collation guarantee.
 */

import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { parseServerMessage, type ClientMessage, type ServerMessage } from "@pistachio/sync-protocol";
import type { HubHost } from "@pistachio/sync-hub";
import { rowsOf } from "../src/db/client.js";
import { authed, desktopAccount, makeHarness, type Harness } from "./helpers.js";

let h: Harness;
let server: Server;
let host: HubHost;
let baseUrl: string;

beforeAll(async () => {
  h = await makeHarness({ hub: null });
  server = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: h.control.app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s as Server)) as Server;
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `ws://127.0.0.1:${String(port)}`;
  host = h.control.hub.attach(server);
});

afterAll(async () => {
  await host.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function upgradeStatus(token: string, via: "header" | "query"): Promise<number> {
  const url = via === "query" ? `${baseUrl}/v1/hub/ws?access_token=${encodeURIComponent(token)}` : `${baseUrl}/v1/hub/ws`;
  const ws = new WebSocket(url, via === "header" ? { headers: { authorization: `Bearer ${token}` } } : {});
  return new Promise((resolve, reject) => {
    ws.once("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
    });
    ws.once("open", () => reject(new Error("upgrade unexpectedly succeeded")));
    ws.once("error", reject);
  });
}

class Client {
  readonly frames: ServerMessage[] = [];
  private readonly waiters: Array<() => void> = [];
  readonly closed: Promise<{ code: number; reason: string }>;

  private constructor(readonly ws: WebSocket) {
    this.closed = new Promise((resolve) => {
      ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    ws.on("message", (data) => {
      this.frames.push(parseServerMessage(data.toString()));
      for (const wake of this.waiters.splice(0)) wake();
    });
  }

  static open(token: string): Promise<Client> {
    const ws = new WebSocket(`${baseUrl}/v1/hub/ws?access_token=${encodeURIComponent(token)}`);
    const client = new Client(ws);
    return new Promise((resolve, reject) => {
      ws.once("open", () => resolve(client));
      ws.once("error", reject);
      ws.once("unexpected-response", (_req, res) => reject(new Error(`upgrade rejected with ${String(res.statusCode)}`)));
    });
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  async next<T extends ServerMessage["t"]>(t: T, timeoutMs = 5_000): Promise<Extract<ServerMessage, { t: T }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.frames.findIndex((f) => f.t === t);
      if (index >= 0) return this.frames.splice(index, 1)[0] as Extract<ServerMessage, { t: T }>;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for ${t}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

describe("hub upgrade", () => {
  it("refuses a bootstrap token with 403 and garbage with 401", async () => {
    const account = await desktopAccount(h);
    expect(await upgradeStatus(account.bootstrapToken, "header")).toBe(403);
    expect(await upgradeStatus(account.bootstrapToken, "query")).toBe(403);
    expect(await upgradeStatus("nope", "query")).toBe(401);
  });

  it("binds a device socket from the token and answers hello with presence", async () => {
    const account = await desktopAccount(h);
    const client = await Client.open(account.token);
    client.send({ t: "hello", deviceId: account.deviceId, kind: "desktop", spaceIds: ["work"] });
    const ack = await client.next("hello.ack");
    expect(ack.presence.some((p) => p.deviceId === account.deviceId && p.kind === "desktop")).toBe(true);
    client.ws.close();
    await client.closed;
  });

  it("closes a revoked device's live socket with 4003 and refuses a new one after the handshake", async () => {
    const account = await desktopAccount(h);
    const client = await Client.open(account.token);
    client.send({ t: "hello", deviceId: account.deviceId, kind: "desktop", spaceIds: ["work"] });
    await client.next("hello.ack");
    const revoke = await h.request(`/v1/devices/${account.deviceId}/revoke`, authed(account.token, "POST"));
    expect(revoke.status).toBe(200);
    const closed = await client.closed;
    expect(closed.code).toBe(4003);
    // The token is still cryptographically valid; the upgrade completes then closes 4003.
    const again = await Client.open(account.token);
    expect((await again.closed).code).toBe(4003);
  });

  it("never lets access_token reach the request log", async () => {
    const account = await desktopAccount(h);
    const client = await Client.open(account.token);
    client.ws.close();
    await client.closed;
    await h.request(`/v1/me?access_token=${encodeURIComponent(account.token)}`, authed(account.token));
    expect(h.logs.length).toBeGreaterThan(0);
    expect(h.logs.some((l) => l.startsWith("UPGRADE /v1/hub/ws"))).toBe(true);
    for (const line of h.logs) {
      expect(line).not.toContain("access_token");
      expect(line).not.toContain(account.token);
    }
  });
});

describe("hub_kv", () => {
  it('declares key with attcollation "C" and byte-orders keys through the hub storage', async () => {
    const result = await h.db.execute(sql`
      SELECT c.collname FROM pg_attribute a
      JOIN pg_collation c ON c.oid = a.attcollation
      WHERE a.attrelid = 'hub_kv'::regclass AND a.attname = 'key'
    `);
    expect(rowsOf(result)).toEqual([{ collname: "C" }]);
    const account = await desktopAccount(h);
    const storage = h.control.hub.storageFor(account.userId);
    const keys = ["rec:a", "rec:a-b", "rec:a:b", "rec:ab", "rec:aÿ", "rec:A", "rec;a", "rec:"];
    for (const key of keys) await storage.put(key, { key });
    const listed = [...(await storage.list({ prefix: "rec:" })).keys()];
    const expected = keys
      .filter((k) => k.startsWith("rec:"))
      .sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
    expect(listed).toEqual(expected);
  });
});
