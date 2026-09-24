/**
 * Egress credentials (§7.6) and the gateway's control routes (§14):
 * credential format, the revocation feed, per-run and per-device revocation.
 */

import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../src/db/schema.js";
import { parseCredentialUsername } from "@pistachio/egress-policy";
import { FlyEgressProvider, gatewaySecretFor, mintCredential } from "../src/egress.js";
import {
  EGRESS_SECRET_HEX,
  GATEWAY_TOKEN,
  SERVICE_TOKEN,
  authed,
  desktopAccount,
  deviceLogin,
  enableCloud,
  fakeRunner,
  json,
  jsonInit,
  makeHarness,
  type FakeRunner,
  type Harness,
} from "./helpers.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A Fly stub speaking both halves of the real surface: the Machines REST API
 * (apps, machines, restart) and GraphQL (secrets, egress and inbound IPs).
 * REST bodies are kept by path suffix; GraphQL calls by the operation named
 * in the query, with the call's `input`/variables as the value.
 */
function recordingFly(overrides: { egressNodes?: Array<{ ip: string; version: number }> } = {}): {
  fetch: typeof fetch;
  bodies: Map<string, unknown>;
} {
  const bodies = new Map<string, unknown>();
  const doFetch: typeof fetch = (input, init) => {
    const url = String(input);
    const reply = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    if (url.endsWith("/graphql")) {
      const { query, variables } = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      if (query.includes("setSecrets")) {
        bodies.set("setSecrets", variables["input"]);
        return reply({ data: { setSecrets: { release: { id: "r1" } } } });
      }
      if (query.includes("allocateEgressIpAddress")) {
        bodies.set("allocateEgressIpAddress", variables["input"]);
        return reply({ data: { allocateEgressIpAddress: { v4: "203.0.113.9", v6: "2a09::1" } } });
      }
      if (query.includes("allocateIpAddress")) {
        const inputs = (bodies.get("allocateIpAddress") as unknown[] | undefined) ?? [];
        bodies.set("allocateIpAddress", [...inputs, variables["input"]]);
        return reply({ data: { allocateIpAddress: { ipAddress: { address: "66.51.0.1" } } } });
      }
      if (query.includes("egressIpAddresses")) {
        return reply({ data: { app: { egressIpAddresses: { nodes: overrides.egressNodes ?? [] } } } });
      }
      if (query.includes("sharedIpAddress")) {
        return reply({ data: { app: { sharedIpAddress: null, ipAddresses: { nodes: [] } } } });
      }
      return reply({ data: {} });
    }
    if (url.endsWith("/restart")) {
      bodies.set("/restart", {});
      return reply({});
    }
    const suffix = url.endsWith("/machines") ? "/machines" : "/apps";
    if (typeof init?.body === "string") bodies.set(suffix, JSON.parse(init.body) as unknown);
    if (suffix === "/machines" && init?.method === "GET") return reply([]);
    if (suffix === "/apps" && init?.method === "GET") {
      // `GET /apps/<name>` — the ensure-app probe; the app never pre-exists.
      return Promise.resolve(new Response("{}", { status: 404 }));
    }
    return reply(suffix === "/machines" ? { id: "m1", region: "iad" } : {});
  };
  return { fetch: doFetch, bodies };
}

/** `setSecrets` input pairs as a record, as the machine environment sees them. */
function sentSecrets(bodies: Map<string, unknown>): Record<string, string> {
  const input = bodies.get("setSecrets") as { secrets: Array<{ key: string; value: string }> };
  return Object.fromEntries(input.secrets.map((s) => [s.key, s.value]));
}

let h: Harness;
let runner: FakeRunner;

beforeAll(async () => {
  runner = await fakeRunner((path, init) => h.request(path, init));
  h = await makeHarness({ runner: runner.client });
});

afterAll(async () => {
  await runner.close();
});

interface Credential {
  username: string;
  password: string;
  expiresAt: string;
  credentialId: string;
}

function expectCredential(cred: Credential, userId: string, deviceId: string): void {
  const fields = cred.username.split(".");
  expect(fields).toHaveLength(5);
  const [prefix, u, d, c, exp] = fields as [string, string, string, string, string];
  expect(prefix).toBe("pe1");
  expect(u).toBe(userId);
  expect(d).toBe(deviceId);
  expect(c).toBe(cred.credentialId);
  expect(UUID_RE.test(c)).toBe(true);
  expect(/^[0-9]+$/.test(exp)).toBe(true);
  expect(Number(exp) * 1000).toBe(Date.parse(cred.expiresAt));
  expect(Number(exp) - Math.floor(Date.now() / 1000)).toBeGreaterThan(24 * 3600 - 60);
  expect(Number(exp) - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(24 * 3600);
  const expected = createHmac("sha256", Buffer.from(EGRESS_SECRET_HEX, "hex")).update(cred.username, "utf8").digest("base64url");
  expect(cred.password).toBe(expected);
  expect(cred.password).toHaveLength(43);
  expect(cred.password).not.toMatch(/=/);
}

describe("GET /v1/egress", () => {
  it("reports no gateway until provisioned, then mints a 24 h credential for the calling device", async () => {
    const account = await desktopAccount(h);
    const before = await json<{ gateway: unknown; credential: unknown; policy: Record<string, unknown> }>(await h.request("/v1/egress", authed(account.token)));
    expect(before.gateway).toBeNull();
    expect(before.credential).toBeNull();
    expect(Array.isArray(before.policy["mediaBypass"])).toBe(true);
    expect(Array.isArray(before.policy["hostileSeed"])).toBe(true);
    expect(Array.isArray(before.policy["checkoutRules"])).toBe(true);

    const provisioned = await h.request("/v1/egress/provision", authed(account.token, "POST"));
    expect(provisioned.status).toBe(201);
    expect((await json<{ gateway: Record<string, unknown> }>(provisioned)).gateway).toMatchObject({ host: "gw.example", port: 8443, egressIp: "203.0.113.5", state: "ready" });
    expect((await h.request("/v1/egress/provision", authed(account.token, "POST"))).status).toBe(200);

    const after = await json<{ gateway: Record<string, unknown>; credential: Credential }>(await h.request("/v1/egress", authed(account.token)));
    expect(after.gateway).toMatchObject({ host: "gw.example", port: 8443 });
    expectCredential(after.credential, account.userId, account.deviceId);
    const me = await json<{ egress: { host: string; port: number } }>(await h.request("/v1/me", authed(account.token)));
    expect(me.egress).toEqual({ host: "gw.example", port: 8443 });
    const rows = await h.db.select().from(schema.egressCredentials).where(eq(schema.egressCredentials.userId, account.userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deviceId).toBe(account.deviceId);
    expect(rows[0]?.runId).toBeNull();
  });

  it("mints nothing without a token secret", async () => {
    const quiet = await makeHarness({ egress: { provider: null, tokenSecretHex: null } });
    const account = await desktopAccount(quiet);
    expect((await quiet.request("/v1/egress/provision", authed(account.token, "POST"))).status).toBe(503);
    const out = await json<{ credential: unknown }>(await quiet.request("/v1/egress", authed(account.token)));
    expect(out.credential).toBeNull();
  });

  it("returns gateway metadata without minting an unscoped cloud credential", async () => {
    const account = await desktopAccount(h);
    await h.request("/v1/egress/provision", authed(account.token, "POST"));
    const cloud = await enableCloud(h, account.token);
    const cloudId = cloud["id"] as string;
    const identity = runner.identities.get(account.userId);
    expect(identity).toBeDefined();
    if (identity === undefined) throw new Error("cloud identity missing");
    const { token } = await deviceLogin(h, identity);

    const out = await json<{ gateway: Record<string, unknown>; credential: unknown }>(
      await h.request("/v1/egress", authed(token)),
    );
    expect(out.gateway).toMatchObject({ host: "gw.example", port: 8443 });
    expect(out.credential).toBeNull();
    const rows = await h.db
      .select()
      .from(schema.egressCredentials)
      .where(eq(schema.egressCredentials.deviceId, cloudId));
    expect(rows).toHaveLength(0);
  });
});

describe("gateway routes", () => {
  it("serves the revocation feed from a cursor and accepts usage samples", async () => {
    const account = await desktopAccount(h);
    await h.request("/v1/egress/provision", authed(account.token, "POST"));
    await h.request("/v1/egress", authed(account.token));
    const initial = await json<{ revocations: Array<{ id: number }>; cursor: number }>(await h.request("/v1/egress/revocations?since=0", authed(GATEWAY_TOKEN)));
    const cursor = initial.cursor;
    await h.request(`/v1/devices/${account.deviceId}/revoke`, authed(account.token, "POST"));
    const feed = await json<{ revocations: Array<{ id: number; deviceId: string; credentialId: string | null; at: string }>; cursor: number }>(
      await h.request(`/v1/egress/revocations?since=${String(cursor)}`, authed(GATEWAY_TOKEN)),
    );
    expect(feed.revocations).toHaveLength(1);
    expect(feed.revocations[0]).toMatchObject({ deviceId: account.deviceId, credentialId: null });
    expect(feed.revocations[0]?.id).toBeGreaterThan(cursor);
    expect(feed.cursor).toBe(feed.revocations[0]?.id);
    const empty = await json<{ revocations: unknown[]; cursor: number }>(await h.request(`/v1/egress/revocations?since=${String(feed.cursor)}`, authed(GATEWAY_TOKEN)));
    expect(empty.revocations).toEqual([]);
    expect(empty.cursor).toBe(feed.cursor);
    const creds = await h.db.select().from(schema.egressCredentials).where(eq(schema.egressCredentials.deviceId, account.deviceId));
    expect(creds.every((c) => c.revokedAt !== null)).toBe(true);

    const usage = await h.request(
      "/v1/usage/egress",
      jsonInit("POST", { userId: account.userId, periodStart: Date.now() - 60_000, periodEnd: Date.now(), proxiedBytes: 1234, bytesToTarget: 1000, bytesToClient: 234, connections: 3, activeMillis: 500 }, GATEWAY_TOKEN),
    );
    expect(usage.status).toBe(202);
    const limits = await json(await h.request(`/v1/egress/limits?userId=${account.userId}`, authed(GATEWAY_TOKEN)));
    expect(limits).toEqual({ userId: account.userId, throttled: false });
    expect((await h.request("/v1/egress/limits", authed(GATEWAY_TOKEN))).status).toBe(400);
  });
});

describe("revocation feed retention", () => {
  it("prunes rows past the horizon and tells a gateway with a pruned cursor to resnapshot", async () => {
    const own = await makeHarness();
    const deviceId = crypto.randomUUID();
    const old = new Date(Date.now() - 31 * 86_400_000);
    const inserted = await own.db
      .insert(schema.egressRevocations)
      .values([
        { deviceId, credentialId: null, at: old },
        { deviceId, credentialId: null, at: old },
        { deviceId, credentialId: null, at: new Date() },
      ])
      .returning({ id: schema.egressRevocations.id });
    const [first, , fresh] = inserted.map((row) => row.id) as [number, number, number];

    const pruned = await own.control.runMaintenance(Date.now());
    expect(pruned.prunedRevocations).toBe(2);
    expect((await own.db.select().from(schema.egressRevocations)).map((row) => row.id)).toEqual([fresh]);
    // The newest row is the feed's floor and survives its own horizon.
    const again = await own.control.runMaintenance(Date.now() + 62 * 86_400_000);
    expect(again.prunedRevocations).toBe(0);
    expect((await own.db.select().from(schema.egressRevocations)).map((row) => row.id)).toEqual([fresh]);

    interface Feed {
      revocations: Array<{ id: number }>;
      cursor: number;
      reset: boolean;
    }
    const stale = await json<Feed>(await own.request(`/v1/egress/revocations?since=${String(first)}`, authed(GATEWAY_TOKEN)));
    expect(stale.reset).toBe(true);
    expect(stale.revocations.map((row) => row.id)).toEqual([fresh]);
    // A cursor sitting on the last pruned row missed nothing: the retained
    // suffix starts right after it, so no rebuild is demanded.
    const boundary = await json<Feed>(await own.request(`/v1/egress/revocations?since=${String(fresh - 1)}`, authed(GATEWAY_TOKEN)));
    expect(boundary.reset).toBe(false);
    expect(boundary.revocations.map((row) => row.id)).toEqual([fresh]);
    // Once the gateway adopts the cursor it is current again, and a gateway
    // with no cursor takes a snapshot anyway.
    const current = await json<Feed>(await own.request(`/v1/egress/revocations?since=${String(stale.cursor)}`, authed(GATEWAY_TOKEN)));
    expect(current.reset).toBe(false);
    expect((await json<Feed>(await own.request("/v1/egress/revocations?since=0", authed(GATEWAY_TOKEN)))).reset).toBe(false);
  });
});

describe("cloud run credentials", () => {
  it("requires a run scope and the live cloud device", async () => {
    const account = await desktopAccount(h);
    await h.request("/v1/egress/provision", authed(account.token, "POST"));
    const cloud = await enableCloud(h, account.token);
    const cloudId = cloud["id"] as string;
    const notCloud = await h.request(
      `/v1/internal/users/${account.userId}/egress-credential?deviceId=${account.deviceId}&runId=${crypto.randomUUID()}`,
      authed(SERVICE_TOKEN),
    );
    expect(notCloud.status).toBe(404);
    const res = await h.request(`/v1/internal/users/${account.userId}/egress-credential?deviceId=${cloudId}`, authed(SERVICE_TOKEN));
    expect(res.status).toBe(400);
    expect((await h.request(`/v1/internal/users/${account.userId}/egress-credential?deviceId=${cloudId}&runId=${crypto.randomUUID()}`, authed(SERVICE_TOKEN))).status).toBe(404);
  });
});

describe("secrets and providers", () => {
  it("derives the fly per-user secret with HKDF and keeps the static secret literal", () => {
    const userId = "11111111-1111-4111-8111-111111111111";
    expect(gatewaySecretFor("static", EGRESS_SECRET_HEX, userId)).toBe(EGRESS_SECRET_HEX);
    const derived = gatewaySecretFor("fly", EGRESS_SECRET_HEX, userId);
    expect(derived).toMatch(/^[0-9a-f]{64}$/);
    expect(derived).not.toBe(EGRESS_SECRET_HEX);
    expect(gatewaySecretFor("fly", EGRESS_SECRET_HEX, userId)).toBe(derived);
    expect(gatewaySecretFor("fly", EGRESS_SECRET_HEX, "22222222-2222-4222-8222-222222222222")).not.toBe(derived);
    const cred = mintCredential({ secretHex: derived, userId, deviceId: userId, credentialId: userId, expiresAtMs: 1_800_000_000_000 });
    expect(cred.username).toBe(`pe1.${userId}.${userId}.${userId}.1800000000`);
    expect(() => mintCredential({ secretHex: "zz", userId, deviceId: userId, credentialId: userId, expiresAtMs: 1 })).toThrow();
  });

  it("FlyEgressProvider refuses to provision until FLY_* are set", async () => {
    const provider = FlyEgressProvider.fromEnv({});
    expect(provider.kind).toBe("fly");
    expect(provider.configured).toBe(false);
    await expect(provider.provision("u", null)).rejects.toMatchObject({ reason: "fly_not_configured" });
    const { fetch: fakeFetch, bodies } = recordingFly();
    const configured = FlyEgressProvider.fromEnv(
      { FLY_API_TOKEN: "t", FLY_ORG_SLUG: "org", FLY_EGRESS_IMAGE: "img", EGRESS_TOKEN_SECRET: EGRESS_SECRET_HEX },
      { fetch: fakeFetch },
    );
    expect(configured.configured).toBe(true);
    const out = await configured.provision("33333333-3333-4333-8333-333333333333", "iad");
    expect(out).toEqual({ host: "pa-eg-33333333-3333-4333-8333-333333333333.fly.dev", port: 443, egressIp: "203.0.113.9", region: "iad" });
    expect(bodies.has("setSecrets")).toBe(true);
  });

  it("allocates the static egress IPv4 in the machine's region and restarts to bind it", async () => {
    const { fetch: fakeFetch, bodies } = recordingFly();
    const userId = "33333333-3333-4333-8333-333333333333";
    const provider = FlyEgressProvider.fromEnv(
      { FLY_API_TOKEN: "t", FLY_ORG_SLUG: "org", FLY_EGRESS_IMAGE: "img", EGRESS_TOKEN_SECRET: EGRESS_SECRET_HEX },
      { fetch: fakeFetch },
    );
    const out = await provider.provision(userId, null);
    // The exit identity comes from the egress allocation, not the inbound
    // anycast list — the inbound addresses only make `<app>.fly.dev` resolve.
    expect(bodies.get("allocateEgressIpAddress")).toEqual({ appId: `pa-eg-${userId}`, region: "iad" });
    expect(out.egressIp).toBe("203.0.113.9");
    expect(bodies.has("/restart")).toBe(true);
    // Inbound: a free shared v4 and a dedicated v6, nothing more.
    expect(bodies.get("allocateIpAddress")).toEqual([
      { appId: `pa-eg-${userId}`, type: "shared_v4" },
      { appId: `pa-eg-${userId}`, type: "v6" },
    ]);
  });

  it("reuses an already-allocated egress IPv4 instead of allocating another", async () => {
    const { fetch: fakeFetch, bodies } = recordingFly({ egressNodes: [{ ip: "198.51.100.7", version: 4 }] });
    const userId = "33333333-3333-4333-8333-333333333333";
    const provider = FlyEgressProvider.fromEnv(
      { FLY_API_TOKEN: "t", FLY_ORG_SLUG: "org", FLY_EGRESS_IMAGE: "img", EGRESS_TOKEN_SECRET: EGRESS_SECRET_HEX },
      { fetch: fakeFetch },
    );
    const out = await provider.provision(userId, "iad");
    expect(out.egressIp).toBe("198.51.100.7");
    // Several egress IPs in one region would be picked between at random per
    // destination — exactly the ambiguity a stable identity cannot have.
    expect(bodies.has("allocateEgressIpAddress")).toBe(false);
    expect(bodies.has("/restart")).toBe(false);
  });

  it("gives the machine Fly edge TLS on 443 and the control-plane credentials", async () => {
    const { fetch: fakeFetch, bodies } = recordingFly();
    const userId = "33333333-3333-4333-8333-333333333333";
    const provider = FlyEgressProvider.fromEnv(
      {
        FLY_API_TOKEN: "t",
        FLY_ORG_SLUG: "org",
        FLY_EGRESS_IMAGE: "img",
        EGRESS_TOKEN_SECRET: EGRESS_SECRET_HEX,
        CONTROL_PUBLIC_URL: "https://control.example",
        EGRESS_GATEWAY_TOKEN: "gw-token",
      },
      { fetch: fakeFetch },
    );
    const out = await provider.provision(userId, "iad");
    // The desktop and the cloud browser both TLS-handshake to the gateway, so
    // the edge must terminate TLS for the app's own hostname on 443.
    expect(out.host).toBe(`pa-eg-${userId}.fly.dev`);
    expect(out.port).toBe(443);
    const machine = bodies.get("/machines") as { config: { services: unknown[] } };
    expect(machine.config.services).toEqual([
      { ports: [{ port: 443, handlers: ["tls"] }], protocol: "tcp", internal_port: 8443 },
    ]);
    // Without these the gateway never polls revocations or reports usage.
    const secrets = sentSecrets(bodies);
    expect(secrets["EGRESS_CONTROL_URL"]).toBe("https://control.example");
    expect(secrets["EGRESS_GATEWAY_TOKEN"]).toBe("gw-token");
    expect(secrets["EGRESS_OWNER_USER_ID"]).toBe(userId);
    expect(secrets["EGRESS_TOKEN_SECRET"]).toBe(gatewaySecretFor("fly", EGRESS_SECRET_HEX, userId));

    // Half a pair would break every machine (the gateway refuses to start
    // with a control URL it has no token for), so neither is sent alone.
    const half = recordingFly();
    await FlyEgressProvider.fromEnv(
      {
        FLY_API_TOKEN: "t",
        FLY_ORG_SLUG: "org",
        FLY_EGRESS_IMAGE: "img",
        EGRESS_TOKEN_SECRET: EGRESS_SECRET_HEX,
        CONTROL_PUBLIC_URL: "https://control.example",
      },
      { fetch: half.fetch },
    ).provision(userId, null);
    expect(Object.keys(sentSecrets(half.bodies)).sort()).toEqual([
      "EGRESS_OWNER_USER_ID",
      "EGRESS_TOKEN_SECRET",
    ]);
  });

  it("mints usernames the gateway's own parser accepts", () => {
    const userId = "33333333-3333-4333-8333-333333333333";
    const deviceId = "44444444-4444-4444-8444-444444444444";
    const credentialId = "55555555-5555-4555-8555-555555555555";
    const cred = mintCredential({ secretHex: EGRESS_SECRET_HEX, userId, deviceId, credentialId, expiresAtMs: 1_800_000_000_000 });
    expect(parseCredentialUsername(cred.username)).toEqual({
      username: cred.username,
      userId,
      deviceId,
      credentialId,
      exp: 1_800_000_000,
    });
  });
});
