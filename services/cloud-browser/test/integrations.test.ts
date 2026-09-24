/**
 * A cloud run's integration hosts (D29): sealed connections opened with the
 * Space seal key, tokens minted from the grant against a fake provider, a
 * dead grant reported once and never retried, and everything that cannot be
 * used left out rather than failing the run.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { IntegrationConnection } from "@pistachio/protocol";
import { integrationConnectionSealAad, seal, toBase64, utf8 } from "@pistachio/sync-protocol";
import { STATUS_RECHECK_MS } from "@pistachio/agent-runtime/integrations";
import { disconnectedMessage, integrationHostsFor, reconnectMessage } from "../src/runs/integrations.js";
import { testSpaceKeys as spaceKeys } from "./helpers/keys.js";

const providers = [{ id: "gmail" as const, clientId: "client-1", clientSecret: "installed" }];

async function connection(sealKey: CryptoKey, overrides: Partial<IntegrationConnection> = {}): Promise<IntegrationConnection> {
  const id = overrides.id ?? randomUUID();
  const sealed = toBase64(await seal(sealKey, utf8(JSON.stringify({ version: 1, refreshToken: `rt-${id}` })), integrationConnectionSealAad("work", id)));
  return {
    id,
    spaceId: "work",
    provider: "gmail",
    accountLabel: "alex@example.com",
    access: "write",
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    status: "connected",
    sealedPayload: sealed,
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
    lastUsedAt: null,
    ...overrides,
  };
}

function tokenEndpoint(answer: (params: URLSearchParams) => Response, revoke?: (params: URLSearchParams) => Response) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const params = new URLSearchParams(String(init?.body));
    if (url === "https://oauth2.googleapis.com/revoke") {
      if (revoke === undefined) throw new Error("unexpected revoke");
      return revoke(params);
    }
    expect(url).toBe("https://oauth2.googleapis.com/token");
    return answer(params);
  });
}

describe("integrationHostsFor", () => {
  it("opens a sealed connection and mints access tokens from its grant", async () => {
    const keys = await spaceKeys("work");
    const row = await connection(keys.sealKey);
    const fetchImpl = tokenEndpoint((params) => {
      expect(params.get("grant_type")).toBe("refresh_token");
      expect(params.get("refresh_token")).toBe(`rt-${row.id}`);
      expect(params.get("client_id")).toBe("client-1");
      return new Response(JSON.stringify({ access_token: "at-1", expires_in: 3600 }), { status: 200 });
    });
    const used = vi.fn();
    const hosts = await integrationHostsFor({ spaceId: "work", sealKey: keys.sealKey, connections: [row], providers, fetch: fetchImpl, onUsed: used });
    expect(hosts).toHaveLength(1);
    const host = hosts[0]!;
    expect(host).toMatchObject({ provider: "gmail", accountLabel: "alex@example.com", access: "write" });
    expect(await host.accessToken()).toBe("at-1");
    expect(await host.accessToken()).toBe("at-1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    host.used?.();
    expect(used).toHaveBeenCalledWith(row);
  });

  it("reports a revoked grant once and answers every later call with the reconnect message", async () => {
    const keys = await spaceKeys("work");
    const row = await connection(keys.sealKey);
    const fetchImpl = tokenEndpoint(() => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    const dead = vi.fn();
    const [host] = await integrationHostsFor({ spaceId: "work", sealKey: keys.sealKey, connections: [row], providers, fetch: fetchImpl, onReconnectRequired: dead });
    await expect(host!.accessToken()).rejects.toThrow(reconnectMessage(row));
    await expect(host!.accessToken({ fresh: true })).rejects.toThrow(reconnectMessage(row));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(dead).toHaveBeenCalledTimes(1);
    expect(dead.mock.calls[0]?.[0]).toBe(row);
  });

  it("keeps a transient token failure retryable", async () => {
    const keys = await spaceKeys("work");
    const row = await connection(keys.sealKey);
    let calls = 0;
    const fetchImpl = tokenEndpoint(() => {
      calls += 1;
      return calls === 1 ? new Response("gateway down", { status: 502 }) : new Response(JSON.stringify({ access_token: "at-2", expires_in: 3600 }), { status: 200 });
    });
    const dead = vi.fn();
    const [host] = await integrationHostsFor({ spaceId: "work", sealKey: keys.sealKey, connections: [row], providers, fetch: fetchImpl, onReconnectRequired: dead });
    await expect(host!.accessToken()).rejects.toThrow("502");
    expect(await host!.accessToken()).toBe("at-2");
    expect(dead).not.toHaveBeenCalled();
  });

  it("notices a disconnect made elsewhere mid-run, and revokes the tombstone it left", async () => {
    const keys = await spaceKeys("work");
    const row = await connection(keys.sealKey);
    let clock = Date.parse("2026-09-06T12:00:00Z");
    const now = () => new Date(clock);
    const revoked = vi.fn((params: URLSearchParams) => {
      expect(params.get("token")).toBe(`rt-${row.id}`);
      return new Response("", { status: 200 });
    });
    const fetchImpl = tokenEndpoint(() => new Response(JSON.stringify({ access_token: "at-1", expires_in: 3600 }), { status: 200 }), revoked);
    let current: IntegrationConnection | null = row;
    const refetch = vi.fn(async () => current);
    const onRevoked = vi.fn();
    const [host] = await integrationHostsFor({ spaceId: "work", sealKey: keys.sealKey, connections: [row], providers, fetch: fetchImpl, now, refetch, onRevoked });

    // Within the window the row is trusted: no re-read, no refresh beyond the first.
    expect(await host!.accessToken()).toBe("at-1");
    expect(await host!.accessToken()).toBe("at-1");
    expect(refetch).not.toHaveBeenCalled();

    // Past it, the web app has tombstoned the connection: the host stops,
    // revokes the grant it alone can open, and reports the row for deletion.
    clock += STATUS_RECHECK_MS + 1;
    current = { ...row, status: "revoke_pending" };
    await expect(host!.accessToken()).rejects.toThrow(disconnectedMessage(row));
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(revoked).toHaveBeenCalledTimes(1);
    expect(onRevoked).toHaveBeenCalledWith(current);
    // And stays stopped — no further re-reads, no further refreshes.
    clock += STATUS_RECHECK_MS + 1;
    await expect(host!.accessToken({ fresh: true })).rejects.toThrow(disconnectedMessage(row));
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls.filter(([url]) => url === "https://oauth2.googleapis.com/token")).toHaveLength(1);

    // A row that is simply gone (a device revoked and deleted it) ends the host the same way, without a revoke of its own.
    const other = await connection(keys.sealKey);
    let otherCurrent: IntegrationConnection | null = other;
    const gone = vi.fn();
    const [second] = await integrationHostsFor({ spaceId: "work", sealKey: keys.sealKey, connections: [other], providers, fetch: fetchImpl, now, refetch: async () => otherCurrent, onRevoked: gone });
    expect(await second!.accessToken()).toBe("at-1");
    clock += STATUS_RECHECK_MS + 1;
    otherCurrent = null;
    await expect(second!.accessToken()).rejects.toThrow(disconnectedMessage(other));
    expect(gone).not.toHaveBeenCalled();
    expect(revoked).toHaveBeenCalledTimes(1);
  });

  it("finishes tombstones at bind time, and leaves alone what it cannot open or the provider will not take back", async () => {
    const keys = await spaceKeys("work");
    const other = await spaceKeys("personal");
    const mine = await connection(keys.sealKey, { status: "revoke_pending" });
    const foreign = await connection(other.sealKey, { status: "revoke_pending" });
    const stubborn = await connection(keys.sealKey, { status: "revoke_pending", accountLabel: "stubborn@example.com" });
    const live = await connection(keys.sealKey);
    const fetchImpl = tokenEndpoint(
      () => new Response(JSON.stringify({ access_token: "at-1", expires_in: 3600 }), { status: 200 }),
      (params) => new Response("", { status: params.get("token") === `rt-${stubborn.id}` ? 503 : 200 }),
    );
    const onRevoked = vi.fn();
    const skipped = vi.fn();
    const hosts = await integrationHostsFor({ spaceId: "work", sealKey: keys.sealKey, connections: [mine, foreign, stubborn, live], providers, fetch: fetchImpl, onRevoked, onSkipped: skipped });
    expect(hosts.map((host) => host.accountLabel)).toEqual(["alex@example.com"]);
    expect(onRevoked.mock.calls.map((call) => (call[0] as IntegrationConnection).id)).toEqual([mine.id]);
    expect(skipped.mock.calls.map((call) => [(call[0] as IntegrationConnection).id, call[1]])).toEqual([
      [foreign.id, "unreadable"],
      [stubborn.id, "revoke_pending"],
    ]);
  });

  it("leaves out what it cannot use: an unconfigured provider, a foreign ciphertext, a connection awaiting reconnect", async () => {
    const keys = await spaceKeys("work");
    const other = await spaceKeys("personal");
    const fine = await connection(keys.sealKey);
    const awaiting = await connection(keys.sealKey, { status: "reconnect_required" });
    const foreign = await connection(other.sealKey);
    const skipped = vi.fn();
    const hosts = await integrationHostsFor({
      spaceId: "work",
      sealKey: keys.sealKey,
      connections: [fine, awaiting, foreign],
      providers,
      fetch: tokenEndpoint(() => new Response("{}", { status: 500 })),
      onSkipped: skipped,
    });
    expect(hosts.map((host) => host.accountLabel)).toEqual(["alex@example.com"]);
    expect(skipped.mock.calls.map((call) => [(call[0] as IntegrationConnection).id, call[1]])).toEqual([
      [awaiting.id, "reconnect_required"],
      [foreign.id, "unreadable"],
    ]);
    expect(await integrationHostsFor({ spaceId: "work", sealKey: keys.sealKey, connections: [fine], providers: [] })).toEqual([]);
  });
});
