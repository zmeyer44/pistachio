/**
 * Dedicated integrations (D29): a person's device files and reads sealed
 * connections per Space, one per provider; a leased runner reads them for
 * the one Space its run belongs to and stamps use and status; control never
 * sees a token and hands out only the OAuth clients it was configured with.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateSpaceRootSecret, wrapRootSecretToDevice } from "@pistachio/sync-protocol";
import type { IntegrationConnection, IntegrationProviderConfig } from "@pistachio/protocol";
import * as schema from "../src/db/schema.js";
import {
  authed,
  claimRun,
  desktopAccount,
  deviceLogin,
  enableCloud,
  fakeRunner,
  json,
  jsonInit,
  makeHarness,
  serviceInit,
  signup,
  type FakeRunner,
  type Harness,
} from "./helpers.js";

let h: Harness;
let runner: FakeRunner;

beforeAll(async () => {
  runner = await fakeRunner((path, init) => h.request(path, init));
  h = await makeHarness({
    runner: runner.client,
    env: { INTEGRATION_GMAIL_CLIENT_ID: "client-1.apps.googleusercontent.com", INTEGRATION_GMAIL_CLIENT_SECRET: "installed-app-secret" },
  });
});

afterAll(async () => {
  await runner.close();
});

const SEALED = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=";
const READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const MODIFY = "https://www.googleapis.com/auth/gmail.modify";

const gmail = (overrides: Partial<{ accountLabel: string; access: string; scopes: string[]; sealedPayload: string }> = {}) => ({
  provider: "gmail",
  accountLabel: "alex@example.com",
  access: "write",
  scopes: [MODIFY],
  sealedPayload: SEALED,
  ...overrides,
});

async function cloudAccount() {
  const account = await desktopAccount(h);
  const cloud = await enableCloud(h, account.token);
  const cloudId = cloud["id"] as string;
  const identity = runner.identities.get(account.userId);
  if (!identity) throw new Error("no identity");
  const wrapper = await wrapRootSecretToDevice(
    generateSpaceRootSecret(),
    "work",
    { deviceId: cloudId, agreementPublicKeyRaw: identity.agreementPublicKeyRaw },
    { deviceId: account.deviceId, signingKey: account.keys.signing.privateKey },
  );
  const put = await h.request(
    "/v1/spaces/work/wrappers",
    jsonInit("PUT", { wrappers: [{ kind: wrapper.kind, credentialId: wrapper.credentialId, salt: wrapper.salt, wrapped: wrapper.wrapped, senderDeviceId: wrapper.senderDeviceId, signature: wrapper.signature }] }, account.token),
  );
  expect(put.status).toBe(200);
  return { ...account, cloudId, identity };
}

async function createRun(token: string): Promise<string> {
  const res = await h.request("/v1/runs", jsonInit("POST", { spaceId: "work", intent: "Reply to Sam", startUrl: "https://www.example.com/" }, token));
  expect(res.status).toBe(201);
  return (await json<{ runId: string }>(res)).runId;
}

describe("integration providers", () => {
  it("lists the OAuth clients the server was configured with, to devices and to the runner", async () => {
    const account = await desktopAccount(h);
    const expected: IntegrationProviderConfig[] = [{ id: "gmail", clientId: "client-1.apps.googleusercontent.com", clientSecret: "installed-app-secret" }];
    expect(await json(await h.request("/v1/integrations/providers", authed(account.token)))).toEqual({ providers: expected });
    expect(await json(await h.request("/v1/internal/integrations/providers", serviceInit("GET")))).toEqual({ providers: expected });
    // Not for a bootstrap token, which has no device, and not without any bearer.
    const fresh = await signup(h);
    expect((await h.request("/v1/integrations/providers", authed(fresh.bootstrapToken))).status).toBe(403);
    expect((await h.request("/v1/integrations/providers")).status).toBe(401);
  });

  it("offers nothing when no client is configured", async () => {
    const bare = await makeHarness({ runner: runner.client });
    const account = await desktopAccount(bare);
    expect(await json(await bare.request("/v1/integrations/providers", authed(account.token)))).toEqual({ providers: [] });
  });
});

describe("integration connections", () => {
  it("lets a person's device file, list, update, replace, and delete sealed connections per Space", async () => {
    const account = await desktopAccount(h);
    const stranger = await desktopAccount(h);
    const connectionId = randomUUID();

    expect(await json(await h.request("/v1/spaces/work/integrations", authed(account.token)))).toEqual({ connections: [] });
    expect((await h.request("/v1/spaces/personal/integrations", authed(account.token))).status).toBe(404);

    const created = await h.request(`/v1/spaces/work/integrations/${connectionId}`, jsonInit("PUT", gmail(), account.token));
    expect(created.status).toBe(201);
    const { connection, replaced } = await json<{ connection: IntegrationConnection; replaced: number }>(created);
    expect(replaced).toBe(0);
    expect(connection).toMatchObject({
      id: connectionId,
      spaceId: "work",
      provider: "gmail",
      accountLabel: "alex@example.com",
      access: "write",
      scopes: [MODIFY],
      status: "connected",
      sealedPayload: SEALED,
      lastUsedAt: null,
    });

    // The grant must cover the level; a read-only grant cannot be filed as `send`.
    expect((await h.request(`/v1/spaces/work/integrations/${randomUUID()}`, jsonInit("PUT", gmail({ access: "send", scopes: [READONLY] }), account.token))).status).toBe(400);
    expect((await h.request(`/v1/spaces/work/integrations/${randomUUID()}`, jsonInit("PUT", { ...gmail(), provider: "outlook" }, account.token))).status).toBe(400);
    expect((await h.request(`/v1/spaces/work/integrations/${randomUUID()}`, jsonInit("PUT", gmail({ sealedPayload: "not base64!" }), account.token))).status).toBe(400);

    // Moving the level on the same grant keeps the id and the ciphertext.
    const updated = await h.request(`/v1/spaces/work/integrations/${connectionId}`, jsonInit("PUT", gmail({ access: "send" }), account.token));
    expect(updated.status).toBe(200);
    expect((await json<{ connection: IntegrationConnection }>(updated)).connection.access).toBe("send");

    // A desktop run stamps its use; a dead grant found on the Mac is flagged by exact id, never by upsert.
    const used = await h.request(`/v1/spaces/work/integrations/${connectionId}/used`, authed(account.token, "POST"));
    expect(used.status).toBe(200);
    expect((await json<{ connection: IntegrationConnection }>(used)).connection.lastUsedAt).not.toBeNull();
    expect((await h.request(`/v1/spaces/work/integrations/${randomUUID()}/used`, authed(account.token, "POST"))).status).toBe(404);
    expect((await h.request(`/v1/spaces/work/integrations/${randomUUID()}/status`, jsonInit("POST", { status: "reconnect_required" }, account.token))).status).toBe(404);
    expect((await h.request(`/v1/spaces/work/integrations/${connectionId}/status`, jsonInit("POST", { status: "connected" }, account.token))).status).toBe(400);
    expect((await h.request(`/v1/spaces/work/integrations/${connectionId}/status`, jsonInit("POST", { status: "revoke_pending" }, account.token))).status).toBe(400);
    const flagged = await h.request(`/v1/spaces/work/integrations/${connectionId}/status`, jsonInit("POST", { status: "reconnect_required" }, account.token));
    expect(flagged.status).toBe(200);
    expect((await json<{ connection: IntegrationConnection }>(flagged)).connection.status).toBe("reconnect_required");
    // Status is not a field of the grant: a PUT cannot set it, and a fresh
    // grant on the same id is connected again.
    expect((await h.request(`/v1/spaces/work/integrations/${connectionId}`, jsonInit("PUT", { ...gmail(), status: "reconnect_required" }, account.token))).status).toBe(400);
    const refiled = await h.request(`/v1/spaces/work/integrations/${connectionId}`, jsonInit("PUT", gmail({ access: "send" }), account.token));
    expect((await json<{ connection: IntegrationConnection }>(refiled)).connection.status).toBe("connected");

    // A reconnect under a fresh id replaces the provider's one row for the Space.
    const reconnectId = randomUUID();
    const reconnected = await h.request(`/v1/spaces/work/integrations/${reconnectId}`, jsonInit("PUT", gmail({ accountLabel: "alex.work@example.com" }), account.token));
    expect(reconnected.status).toBe(201);
    expect((await json<{ replaced: number }>(reconnected)).replaced).toBe(1);
    const listed = await json<{ connections: IntegrationConnection[] }>(await h.request("/v1/spaces/work/integrations", authed(account.token)));
    expect(listed.connections.map((row) => row.id)).toEqual([reconnectId]);
    expect(listed.connections[0]?.accountLabel).toBe("alex.work@example.com");

    // Another account sees nothing and cannot overwrite the row by guessing its id.
    expect(await json(await h.request("/v1/spaces/work/integrations", authed(stranger.token)))).toEqual({ connections: [] });
    expect((await h.request(`/v1/spaces/work/integrations/${reconnectId}`, jsonInit("PUT", gmail({ accountLabel: "hijack@example.com" }), stranger.token))).status).toBe(404);
    expect((await h.request(`/v1/spaces/work/integrations/${reconnectId}`, authed(stranger.token, "DELETE"))).status).toBe(404);

    // A bootstrap token has no device and therefore no key to open anything.
    const fresh = await signup(h);
    expect((await h.request("/v1/spaces/work/integrations", authed(fresh.bootstrapToken))).status).toBe(403);

    expect((await h.request(`/v1/spaces/work/integrations/${reconnectId}`, authed(account.token, "DELETE"))).status).toBe(200);
    expect((await h.request(`/v1/spaces/work/integrations/${reconnectId}`, authed(account.token, "DELETE"))).status).toBe(404);
    expect(await json(await h.request("/v1/spaces/work/integrations", authed(account.token)))).toEqual({ connections: [] });
    const kinds = (await h.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.userId, account.userId))).map((row) => row.kind);
    expect(kinds).toEqual(expect.arrayContaining(["integration.connected", "integration.updated", "integration.disconnected"]));
  });

  it("turns a keyless disconnect into a tombstone that only a revoking device can clear", async () => {
    const account = await desktopAccount(h);
    const connectionId = randomUUID();
    expect((await h.request(`/v1/spaces/work/integrations/${connectionId}`, jsonInit("PUT", gmail(), account.token))).status).toBe(201);

    // The web app asks; the row stays, marked, ciphertext and all.
    const asked = await h.request(`/v1/spaces/work/integrations/${connectionId}/disconnect`, authed(account.token, "POST"));
    expect(asked.status).toBe(200);
    expect((await json<{ connection: IntegrationConnection }>(asked)).connection).toMatchObject({ status: "revoke_pending", sealedPayload: SEALED });
    expect((await h.request(`/v1/spaces/work/integrations/${connectionId}/disconnect`, authed(account.token, "POST"))).status).toBe(200);
    expect((await h.request(`/v1/spaces/work/integrations/${randomUUID()}/disconnect`, authed(account.token, "POST"))).status).toBe(404);
    const listed = await json<{ connections: IntegrationConnection[] }>(await h.request("/v1/spaces/work/integrations", authed(account.token)));
    expect(listed.connections.map((row) => row.status)).toEqual(["revoke_pending"]);

    // Nothing writes over a tombstone: not a level change, not a fresh
    // grant for the provider, not a reconnect-required flag.
    expect((await h.request(`/v1/spaces/work/integrations/${connectionId}`, jsonInit("PUT", gmail({ access: "send" }), account.token))).status).toBe(409);
    const fresh = await h.request(`/v1/spaces/work/integrations/${randomUUID()}`, jsonInit("PUT", gmail(), account.token));
    expect(fresh.status).toBe(409);
    expect(await json(fresh)).toEqual({ error: "revoke_pending" });
    expect((await h.request(`/v1/spaces/work/integrations/${connectionId}/status`, jsonInit("POST", { status: "reconnect_required" }, account.token))).status).toBe(404);
    expect((await json<{ connections: IntegrationConnection[] }>(await h.request("/v1/spaces/work/integrations", authed(account.token)))).connections).toHaveLength(1);

    // A device that opened and revoked the grant deletes the row, and the slot is free again.
    expect((await h.request(`/v1/spaces/work/integrations/${connectionId}`, authed(account.token, "DELETE"))).status).toBe(200);
    expect((await h.request(`/v1/spaces/work/integrations/${randomUUID()}`, jsonInit("PUT", gmail(), account.token))).status).toBe(201);
    const kinds = (await h.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.userId, account.userId))).map((row) => row.kind);
    expect(kinds).toEqual(expect.arrayContaining(["integration.disconnect_requested", "integration.disconnected"]));
  });

  it("keeps the cloud device out of the account listing", async () => {
    const account = await cloudAccount();
    const cloudToken = (await deviceLogin(h, account.identity)).token;
    const res = await h.request("/v1/spaces/work/integrations", authed(cloudToken));
    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({ error: "cloud_device_forbidden" });
    expect((await h.request("/v1/integrations/providers", authed(cloudToken))).status).toBe(403);
  });

  it("lets a leased runner read its run's Space's connections and stamp use and status", async () => {
    const account = await cloudAccount();
    const connectionId = randomUUID();
    expect((await h.request(`/v1/spaces/work/integrations/${connectionId}`, jsonInit("PUT", gmail(), account.token))).status).toBe(201);
    const runId = await createRun(account.token);
    const { leaseToken } = await claimRun(h, runId);
    const lookup = (token = leaseToken) => h.request(`/v1/internal/runs/${runId}/integrations/lookup`, serviceInit("POST", { leaseToken: token }));

    expect((await lookup("not-the-lease")).status).toBe(409);
    const found = await json<{ connections: IntegrationConnection[] }>(await lookup());
    expect(found.connections).toHaveLength(1);
    expect(found.connections[0]).toMatchObject({ id: connectionId, provider: "gmail", access: "write", sealedPayload: SEALED });

    const used = await h.request(`/v1/internal/runs/${runId}/integrations/${connectionId}/used`, serviceInit("POST", { leaseToken }));
    expect(used.status).toBe(200);
    expect((await json<{ connection: IntegrationConnection }>(used)).connection.lastUsedAt).not.toBeNull();

    const dead = await h.request(`/v1/internal/runs/${runId}/integrations/${connectionId}/status`, serviceInit("POST", { leaseToken, status: "reconnect_required" }));
    expect(dead.status).toBe(200);
    expect((await json<{ connection: IntegrationConnection }>(dead)).connection.status).toBe("reconnect_required");
    const mine = await json<{ connections: IntegrationConnection[] }>(await h.request("/v1/spaces/work/integrations", authed(account.token)));
    expect(mine.connections[0]?.status).toBe("reconnect_required");
    expect((await h.request(`/v1/internal/runs/${runId}/integrations/${connectionId}/status`, serviceInit("POST", { leaseToken, status: "broken" }))).status).toBe(400);
    expect((await h.request(`/v1/internal/runs/${runId}/integrations/${connectionId}/status`, serviceInit("POST", { leaseToken, status: "revoke_pending" }))).status).toBe(400);
    // Already flagged: the exact-id route has nothing to flip.
    expect((await h.request(`/v1/internal/runs/${runId}/integrations/${connectionId}/status`, serviceInit("POST", { leaseToken, status: "reconnect_required" }))).status).toBe(404);

    // A tombstone the web app left is the runner's to finish: it sees the
    // row in its lookup, and once it has revoked the grant, deletes it. (A
    // flagged grant, unlike a tombstone, is replaced by a fresh one.)
    const tombstoneId = randomUUID();
    const replaced = await h.request(`/v1/spaces/work/integrations/${tombstoneId}`, jsonInit("PUT", gmail(), account.token));
    expect(replaced.status).toBe(201);
    expect((await json<{ replaced: number }>(replaced)).replaced).toBe(1);
    expect((await h.request(`/v1/spaces/work/integrations/${tombstoneId}/disconnect`, authed(account.token, "POST"))).status).toBe(200);
    const seen = await json<{ connections: IntegrationConnection[] }>(await lookup());
    expect(seen.connections.map((row) => [row.id, row.status])).toEqual([[tombstoneId, "revoke_pending"]]);
    expect((await h.request(`/v1/internal/runs/${runId}/integrations/${tombstoneId}/revoked`, serviceInit("POST", { leaseToken: "not-the-lease" }))).status).toBe(409);
    expect((await h.request(`/v1/internal/runs/${runId}/integrations/${tombstoneId}/revoked`, serviceInit("POST", { leaseToken }))).status).toBe(200);
    expect((await h.request(`/v1/internal/runs/${runId}/integrations/${tombstoneId}/revoked`, serviceInit("POST", { leaseToken }))).status).toBe(404);
    expect(await json(await h.request("/v1/spaces/work/integrations", authed(account.token)))).toEqual({ connections: [] });

    // Another run's lease reaches neither the listing nor the row — nor a
    // tombstone it did not leave.
    const other = await cloudAccount();
    const otherRun = await createRun(other.token);
    const otherLease = (await claimRun(h, otherRun)).leaseToken;
    const mineAgain = randomUUID();
    expect((await h.request(`/v1/spaces/work/integrations/${mineAgain}`, jsonInit("PUT", gmail(), account.token))).status).toBe(201);
    expect((await h.request(`/v1/spaces/work/integrations/${mineAgain}/disconnect`, authed(account.token, "POST"))).status).toBe(200);
    expect(await json(await h.request(`/v1/internal/runs/${otherRun}/integrations/lookup`, serviceInit("POST", { leaseToken: otherLease })))).toEqual({ connections: [] });
    expect((await h.request(`/v1/internal/runs/${otherRun}/integrations/${mineAgain}/used`, serviceInit("POST", { leaseToken: otherLease }))).status).toBe(404);
    expect((await h.request(`/v1/internal/runs/${otherRun}/integrations/${mineAgain}/revoked`, serviceInit("POST", { leaseToken: otherLease }))).status).toBe(404);

    const kinds = (await h.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.userId, account.userId))).map((row) => row.kind);
    expect(kinds).toEqual(expect.arrayContaining(["integration.connected", "integration.used", "integration.status"]));
  });
});
