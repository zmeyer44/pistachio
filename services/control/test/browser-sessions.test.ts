/**
 * Browser sessions (docs/web-browser-design.md §4): create-or-resume and the
 * partial unique index, shell tickets and their single redemption, the worker
 * lease (claim, heartbeat, release), run attachment and the control
 * generation, placement-aware and atomic run+session claim, the session
 * egress credential, ending a session, and the maintenance transitions.
 *
 * Every route above and every refusal code it can answer has a case here.
 */

import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { getRequestListener } from "@hono/node-server";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateSpaceRootSecret, wrapRootSecretToDevice } from "@pistachio/sync-protocol";
import type { HostedRunRecord } from "@pistachio/runtime";
import type { RunEvent } from "@pistachio/protocol";
import { DEFAULT_BROWSER_URL, DEFAULT_WEB_URL } from "../src/app.js";
import * as schema from "../src/db/schema.js";
import {
  authed,
  desktopAccount,
  enableCloud,
  fakeRunner,
  json,
  jsonInit,
  leasedInit,
  makeHarness,
  serviceInit,
  settle,
  type FakeRunner,
  type Harness,
} from "./helpers.js";

const RUNNER_URL = "https://runner.example";
const DAY_MS = 86_400_000;

/** SHA-256 hex: the digest a ticket is stored under. */
function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** A fixed clock: leases and retention are checked by asking maintenance about a later moment. */
const clock = Date.now();

let h: Harness;
let runner: FakeRunner;

interface Stack {
  h: Harness;
  runner: FakeRunner;
}

/** A harness with its own database, for the cases that need their own clock or environment. */
async function makeStack(env: Record<string, string | undefined>): Promise<Stack> {
  const stack: Partial<Stack> = {};
  const r = await fakeRunner((path, init) => (stack.h as Harness).request(path, init));
  stack.runner = r;
  stack.h = await makeHarness({ runner: r.client, now: () => clock, env });
  return stack as Stack;
}

beforeAll(async () => {
  const stack = await makeStack({ CLOUD_BROWSER_PUBLIC_URL: RUNNER_URL });
  h = stack.h;
  runner = stack.runner;
});

afterAll(async () => {
  await runner.close();
});

interface CloudAccount {
  userId: string;
  token: string;
  deviceId: string;
  cloudId: string;
  keys: Awaited<ReturnType<typeof desktopAccount>>["keys"];
}

/** Wrap the Space's root secret to the account's cloud device: the `space_not_cloud_enabled` gate. */
async function wrapSpace(stack: Stack, a: { userId: string; token: string; deviceId: string; cloudId: string; keys: CloudAccount["keys"] }, spaceId: string): Promise<void> {
  const identity = stack.runner.identities.get(a.userId);
  if (!identity) throw new Error("no cloud identity");
  const wrapper = await wrapRootSecretToDevice(
    generateSpaceRootSecret(),
    spaceId,
    { deviceId: a.cloudId, agreementPublicKeyRaw: identity.agreementPublicKeyRaw },
    { deviceId: a.deviceId, signingKey: a.keys.signing.privateKey },
  );
  const put = await stack.h.request(
    `/v1/spaces/${spaceId}/wrappers`,
    jsonInit(
      "PUT",
      {
        wrappers: [
          {
            kind: wrapper.kind,
            credentialId: wrapper.credentialId,
            salt: wrapper.salt,
            wrapped: wrapper.wrapped,
            senderDeviceId: wrapper.senderDeviceId,
            signature: wrapper.signature,
          },
        ],
      },
      a.token,
    ),
  );
  expect(put.status).toBe(200);
}

async function cloudAccount(stack: Stack = { h, runner }): Promise<CloudAccount> {
  const account = await desktopAccount(stack.h);
  const cloud = await enableCloud(stack.h, account.token);
  const a: CloudAccount = {
    userId: account.userId,
    token: account.token,
    deviceId: account.deviceId,
    cloudId: cloud["id"] as string,
    keys: account.keys,
  };
  await wrapSpace(stack, a, "work");
  return a;
}

/** A second cloud-enabled Space on the same account. */
async function addSpace(a: CloudAccount, spaceId: string, stack: Stack = { h, runner }): Promise<void> {
  const created = await stack.h.request(`/v1/spaces/${spaceId}`, jsonInit("PUT", { name: spaceId }, a.token));
  expect(created.status).toBeLessThan(300);
  const enabled = await stack.h.request("/v1/cloud/enable", jsonInit("POST", { spaceId }, a.token));
  expect(enabled.status).toBe(200);
  await wrapSpace(stack, a, spaceId);
}

interface SessionView {
  id: string;
  spaceId: string;
  state: string;
  control: { holder: string; generation: number };
  activeRunId: string | null;
  worker: { id: string; until: string } | null;
  lastAttachedAt: string | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

async function createSession(a: CloudAccount, spaceId = "work", stack: Stack = { h, runner }): Promise<SessionView> {
  const res = await stack.h.request("/v1/browser-sessions", jsonInit("POST", { spaceId }, a.token));
  expect(res.status).toBe(201);
  return (await json<{ session: SessionView }>(res)).session;
}

async function readSession(a: CloudAccount, id: string, stack: Stack = { h, runner }): Promise<SessionView> {
  const res = await stack.h.request(`/v1/browser-sessions/${id}`, authed(a.token));
  expect(res.status).toBe(200);
  return (await json<{ session: SessionView }>(res)).session;
}

async function createRun(a: CloudAccount, sessionId?: string, spaceId = "work"): Promise<string> {
  const res = await h.request(
    "/v1/runs",
    jsonInit("POST", { spaceId, intent: "Do the thing", ...(sessionId === undefined ? {} : { sessionId }) }, a.token),
  );
  expect(res.status).toBe(201);
  return (await json<{ runId: string }>(res)).runId;
}

interface ClaimedRun {
  run: HostedRunRecord;
  leaseToken: string;
  session?: { id: string; leaseToken: string; generation: number };
}

async function claimAny(workerId = "worker-1", workerUrl?: string): Promise<ClaimedRun | null> {
  const res = await h.request(
    "/v1/internal/runs/claim",
    serviceInit("POST", { workerId, ...(workerUrl === undefined ? {} : { workerUrl }) }),
  );
  if (res.status === 204) return null;
  expect(res.status).toBe(200);
  return json<ClaimedRun>(res);
}

async function claimRun(runId: string, workerId = "worker-1", workerUrl?: string): Promise<ClaimedRun> {
  for (let i = 0; i < 30; i += 1) {
    const claimed = await claimAny(workerId, workerUrl);
    if (claimed === null) break;
    if (claimed.run.id === runId) return claimed;
  }
  throw new Error(`run ${runId} was not claimable by ${workerId}`);
}

async function runEventsOf(runId: string): Promise<RunEvent[]> {
  const rows = await h.db
    .select()
    .from(schema.runEvents)
    .where(eq(schema.runEvents.runId, runId))
    .orderBy(schema.runEvents.seq);
  return rows.map((row) => row.event as RunEvent);
}

async function sessionRow(id: string): Promise<typeof schema.browserSessions.$inferSelect> {
  const [row] = await h.db.select().from(schema.browserSessions).where(eq(schema.browserSessions.id, id));
  if (row === undefined) throw new Error("no session row");
  return row;
}

/* ------------------------------------------------------------------ *
 * Device-bearer routes (§4.3)
 * ------------------------------------------------------------------ */

describe("GET /me", () => {
  it("advertises the browser app so a client can find it (§15)", async () => {
    // The two web apps are separate origins, and neither is compiled into
    // the other. A client that has just signed in on `www` learns where the
    // browser lives the same way it learns where the hub and the cloud
    // browser live: control tells it.
    const stack = await makeStack({ PISTACHIO_BROWSER_URL: "https://app.pistachio.test/" });
    const a = await desktopAccount(stack.h);
    const me = await json<{ browserUrl: string; cloudBrowserUrl: string | null }>(
      await stack.h.request("/v1/me", authed(a.token)),
    );
    // Trailing slash trimmed, so a client can append a path to it.
    expect(me.browserUrl).toBe("https://app.pistachio.test");
  });

  it("falls back to the published browser host when nothing is configured", async () => {
    const a = await desktopAccount(h);
    const me = await json<{ browserUrl: string }>(await h.request("/v1/me", authed(a.token)));
    expect(me.browserUrl).toBe(DEFAULT_BROWSER_URL);
    // It is a different site from `www`, not a path on it.
    expect(new URL(me.browserUrl).origin).not.toBe(new URL(DEFAULT_WEB_URL).origin);
  });
});

describe("POST /browser-sessions", () => {
  it("creates a session and then resumes the same one for the Space", async () => {
    const a = await cloudAccount();
    const created = await h.request("/v1/browser-sessions", jsonInit("POST", { spaceId: "work" }, a.token));
    expect(created.status).toBe(201);
    const first = (await json<{ session: SessionView }>(created)).session;
    expect(first).toMatchObject({
      spaceId: "work",
      state: "ready",
      control: { holder: "human", generation: 0 },
      activeRunId: null,
      worker: null,
      lastAttachedAt: null,
      endedAt: null,
    });

    const again = await h.request("/v1/browser-sessions", jsonInit("POST", { spaceId: "work" }, a.token));
    expect(again.status).toBe(200);
    expect((await json<{ session: SessionView }>(again)).session.id).toBe(first.id);

    const audits = await h.db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.userId, a.userId), eq(schema.auditEvents.kind, "session.created")));
    expect(audits).toHaveLength(1);
  });

  it("never carries the lease token to a device", async () => {
    const a = await cloudAccount();
    const session = await createSession(a);
    const claim = await h.request(
      `/v1/internal/browser-sessions/${session.id}/claim`,
      serviceInit("POST", { workerId: "worker-1", workerUrl: "http://worker-1.internal" }),
    );
    expect(claim.status).toBe(200);
    const read = await h.request(`/v1/browser-sessions/${session.id}`, authed(a.token));
    expect(JSON.stringify(await json(read))).not.toContain("leaseToken");
    expect((await readSession(a, session.id)).worker).toMatchObject({ id: "worker-1" });
  });

  it("holds one non-ended session per Space and reopens after an end", async () => {
    const a = await cloudAccount();
    const first = await createSession(a);

    // The index is the arbiter, so a hand-rolled second row is refused.
    await expect(
      h.db.insert(schema.browserSessions).values({
        id: randomUUID(),
        userId: a.userId,
        spaceId: "work",
        createdAt: new Date(clock),
        updatedAt: new Date(clock),
      }),
    ).rejects.toThrow();

    const ended = await h.request(`/v1/browser-sessions/${first.id}/end`, authed(a.token, "POST"));
    expect(ended.status).toBe(204);
    // With the first ended the index no longer constrains: a new one is made.
    const second = await createSession(a);
    expect(second.id).not.toBe(first.id);
  });

  it("refuses a Space the account does not have, one without the cloud, and a fleet with no address", async () => {
    const a = await cloudAccount();
    const missing = await h.request("/v1/browser-sessions", jsonInit("POST", { spaceId: "nope" }, a.token));
    expect(missing.status).toBe(404);
    expect(await json(missing)).toEqual({ error: "not_found" });

    // A Space the cloud device holds no key for cannot be opened by a worker.
    const plain = await h.request("/v1/spaces/plain", jsonInit("PUT", { name: "Plain" }, a.token));
    expect(plain.status).toBeLessThan(300);
    const notEnabled = await h.request("/v1/browser-sessions", jsonInit("POST", { spaceId: "plain" }, a.token));
    expect(notEnabled.status).toBe(400);
    expect(await json(notEnabled)).toEqual({ error: "space_not_cloud_enabled" });

    const bare = await makeStack({});
    try {
      const b = await cloudAccount(bare);
      const res = await bare.h.request("/v1/browser-sessions", jsonInit("POST", { spaceId: "work" }, b.token));
      expect(res.status).toBe(503);
      expect(await json(res)).toEqual({ error: "no_cloud_browser" });
    } finally {
      await bare.runner.close();
    }
  });
});

describe("GET /browser-sessions", () => {
  it("lists the caller's non-ended sessions, filtered by Space", async () => {
    const a = await cloudAccount();
    await addSpace(a, "other");
    const work = await createSession(a, "work");
    const other = await createSession(a, "other");

    const all = await h.request("/v1/browser-sessions", authed(a.token));
    expect(all.status).toBe(200);
    const listed = (await json<{ sessions: SessionView[] }>(all)).sessions.map((s) => s.id).sort();
    expect(listed).toEqual([work.id, other.id].sort());

    const filtered = await h.request("/v1/browser-sessions?spaceId=other", authed(a.token));
    expect((await json<{ sessions: SessionView[] }>(filtered)).sessions.map((s) => s.id)).toEqual([other.id]);

    expect((await h.request(`/v1/browser-sessions/${work.id}/end`, authed(a.token, "POST"))).status).toBe(204);
    const after = await h.request("/v1/browser-sessions", authed(a.token));
    expect((await json<{ sessions: SessionView[] }>(after)).sessions.map((s) => s.id)).toEqual([other.id]);
  });

  it("answers 404 for another account's session", async () => {
    const a = await cloudAccount();
    const b = await cloudAccount();
    const session = await createSession(a);
    const res = await h.request(`/v1/browser-sessions/${session.id}`, authed(b.token));
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: "not_found" });
    expect((await h.request(`/v1/browser-sessions/${randomUUID()}`, authed(a.token))).status).toBe(404);
  });
});

describe("POST /browser-sessions/:id/ticket", () => {
  it("mints a one-minute ticket whether or not the session is leased", async () => {
    const a = await cloudAccount();
    const session = await createSession(a);
    const res = await h.request(`/v1/browser-sessions/${session.id}/ticket`, authed(a.token, "POST"));
    expect(res.status).toBe(200);
    const out = await json<{ url: string; ticket: string; expiresAt: string }>(res);
    expect(out.url).toBe(RUNNER_URL);
    expect(out.ticket.startsWith("pst_")).toBe(true);
    expect(Date.parse(out.expiresAt) - clock).toBe(60_000);
    // Stored hashed: the secret itself is never at rest.
    const [row] = await h.db.select().from(schema.sessionTickets).where(eq(schema.sessionTickets.sessionId, session.id));
    expect(row?.deviceId).toBe(a.deviceId);
    expect(JSON.stringify(row)).not.toContain(out.ticket);

    const audits = await h.db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.userId, a.userId), eq(schema.auditEvents.kind, "session.ticket")));
    expect(audits).toHaveLength(1);
  });

  it("refuses an unowned session, an ended one, and a fleet with no address", async () => {
    const a = await cloudAccount();
    const b = await cloudAccount();
    const session = await createSession(a);
    expect((await h.request(`/v1/browser-sessions/${session.id}/ticket`, authed(b.token, "POST"))).status).toBe(404);

    expect((await h.request(`/v1/browser-sessions/${session.id}/end`, authed(a.token, "POST"))).status).toBe(204);
    const ended = await h.request(`/v1/browser-sessions/${session.id}/ticket`, authed(a.token, "POST"));
    expect(ended.status).toBe(409);
    expect(await json(ended)).toEqual({ error: "session_ended" });

    const bare = await makeStack({});
    try {
      const c = await cloudAccount(bare);
      // The session itself needs an address to be created, so it is inserted
      // directly: the ticket route must refuse on its own.
      const id = randomUUID();
      await bare.h.db.insert(schema.browserSessions).values({
        id,
        userId: c.userId,
        spaceId: "work",
        createdAt: new Date(clock),
        updatedAt: new Date(clock),
      });
      const res = await bare.h.request(`/v1/browser-sessions/${id}/ticket`, authed(c.token, "POST"));
      expect(res.status).toBe(503);
      expect(await json(res)).toEqual({ error: "no_cloud_browser" });
    } finally {
      await bare.runner.close();
    }
  });
});

describe("POST /browser-sessions/:id/end", () => {
  it("ends the session, revokes its runs and egress, and steers the worker", async () => {
    const a = await cloudAccount();
    const session = await createSession(a);
    const runId = await createRun(a, session.id);
    const claimed = await claimRun(runId, "worker-end");
    expect(claimed.session?.id).toBe(session.id);

    // A credential minted for the session, and one for the run.
    const credential = await h.request(
      `/v1/internal/users/${a.userId}/egress-credential?deviceId=${a.cloudId}&sessionId=${session.id}`,
      serviceInit("GET"),
    );
    expect(credential.status).toBe(200);
    const ticket = await h.request(`/v1/browser-sessions/${session.id}/ticket`, authed(a.token, "POST"));
    expect(ticket.status).toBe(200);

    runner.steers.length = 0;
    const ended = await h.request(`/v1/browser-sessions/${session.id}/end`, authed(a.token, "POST"));
    expect(ended.status).toBe(204);

    const row = await sessionRow(session.id);
    expect(row.state).toBe("ended");
    expect(row.endedAt).not.toBeNull();
    expect(row.leaseWorkerId).toBeNull();
    expect(row.leaseToken).toBeNull();
    expect(row.activeRunId).toBeNull();
    expect(row.controlHolder).toBe("human");

    // The attached run lost its authority in the same unit.
    const run = await h.request(`/v1/runs/${runId}`, authed(a.token));
    expect((await json<{ run: HostedRunRecord }>(run)).run.status).toBe("revoked");

    // The session's egress identity is cut exactly as a run's is.
    const [cred] = await h.db
      .select()
      .from(schema.egressCredentials)
      .where(eq(schema.egressCredentials.sessionId, session.id));
    expect(cred?.revokedAt).not.toBeNull();
    const feed = await h.db
      .select()
      .from(schema.egressRevocations)
      .where(eq(schema.egressRevocations.credentialId, cred?.id ?? ""));
    expect(feed).toHaveLength(1);

    // Unspent tickets go with it, and the worker is told.
    expect(await h.db.select().from(schema.sessionTickets).where(eq(schema.sessionTickets.sessionId, session.id))).toEqual([]);
    await h.control.idle();
    await settle(() => runner.steers.some((s) => s.kind === "session.ended"));
    expect(runner.steers).toContainEqual({ kind: "session.ended", sessionId: session.id });

    const audits = await h.db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.userId, a.userId), eq(schema.auditEvents.kind, "session.ended")));
    expect(audits).toHaveLength(1);
  });

  it("queues the steer for retry when the worker cannot be reached", async () => {
    const a = await cloudAccount();
    const session = await createSession(a);
    runner.steers.length = 0;
    runner.failSteer = true;
    try {
      expect((await h.request(`/v1/browser-sessions/${session.id}/end`, authed(a.token, "POST"))).status).toBe(204);
      await h.control.idle();
      await settle(() => h.control.outbox.pending.some((entry) => entry.body.kind === "session.ended"));
    } finally {
      runner.failSteer = false;
    }
    // The session ended regardless; the worker learns late rather than never.
    expect((await sessionRow(session.id)).state).toBe("ended");
    const flushed = await h.control.outbox.flush();
    expect(flushed.delivered).toBeGreaterThanOrEqual(1);
    expect(runner.steers).toContainEqual({ kind: "session.ended", sessionId: session.id });
  });

  it("is idempotent and 404s an unowned session", async () => {
    const a = await cloudAccount();
    const b = await cloudAccount();
    const session = await createSession(a);
    expect((await h.request(`/v1/browser-sessions/${session.id}/end`, authed(b.token, "POST"))).status).toBe(404);
    expect((await h.request(`/v1/browser-sessions/${session.id}/end`, authed(a.token, "POST"))).status).toBe(204);
    expect((await h.request(`/v1/browser-sessions/${session.id}/end`, authed(a.token, "POST"))).status).toBe(204);
    expect((await h.request(`/v1/browser-sessions/${randomUUID()}/end`, authed(a.token, "POST"))).status).toBe(404);
  });

  it("revokes a run created for the session but never claimed", async () => {
    const a = await cloudAccount();
    const session = await createSession(a);
    const runId = await createRun(a, session.id);
    expect((await h.request(`/v1/browser-sessions/${session.id}/end`, authed(a.token, "POST"))).status).toBe(204);
    const run = await h.request(`/v1/runs/${runId}`, authed(a.token));
    expect((await json<{ run: HostedRunRecord }>(run)).run.status).toBe("revoked");
  });
});

/* ------------------------------------------------------------------ *
 * Worker routes (§4.3)
 * ------------------------------------------------------------------ */

describe("POST /internal/browser-sessions/:id/claim", () => {
  it("claims, renews for the same worker, and refuses another", async () => {
    const a = await cloudAccount();
    const session = await createSession(a);
    const first = await h.request(
      `/v1/internal/browser-sessions/${session.id}/claim`,
      serviceInit("POST", { workerId: "worker-a", workerUrl: "http://worker-a.internal" }),
    );
    expect(first.status).toBe(200);
    const claimed = await json<{ session: SessionView; leaseToken: string }>(first);
    expect(claimed.session.state).toBe("live");
    expect(claimed.session.worker).toMatchObject({ id: "worker-a" });
    expect(claimed.session.lastAttachedAt).not.toBeNull();

    const renewed = await h.request(
      `/v1/internal/browser-sessions/${session.id}/claim`,
      serviceInit("POST", { workerId: "worker-a", workerUrl: "http://worker-a.internal" }),
    );
    expect(renewed.status).toBe(200);
    expect((await json<{ leaseToken: string }>(renewed)).leaseToken).toBe(claimed.leaseToken);

    const other = await h.request(
      `/v1/internal/browser-sessions/${session.id}/claim`,
      serviceInit("POST", { workerId: "worker-b" }),
    );
    expect(other.status).toBe(409);
    expect(await json(other)).toEqual({ error: "held_elsewhere" });
  });

  it("answers 410 for an ended session and 404 for an unknown one", async () => {
    const a = await cloudAccount();
    const session = await createSession(a);
    expect((await h.request(`/v1/browser-sessions/${session.id}/end`, authed(a.token, "POST"))).status).toBe(204);
    const ended = await h.request(
      `/v1/internal/browser-sessions/${session.id}/claim`,
      serviceInit("POST", { workerId: "worker-a" }),
    );
    expect(ended.status).toBe(410);
    expect(await json(ended)).toEqual({ error: "session_ended" });

    const missing = await h.request(
      `/v1/internal/browser-sessions/${randomUUID()}/claim`,
      serviceInit("POST", { workerId: "worker-a" }),
    );
    expect(missing.status).toBe(404);
  });

  it("takes a session whose previous holder's lease has lapsed", async () => {
    const a = await cloudAccount();
    const session = await createSession(a);
    expect(
      (
        await h.request(
          `/v1/internal/browser-sessions/${session.id}/claim`,
          serviceInit("POST", { workerId: "worker-a" }),
        )
      ).status,
    ).toBe(200);
    await h.db
      .update(schema.browserSessions)
      .set({ leaseUntil: new Date(clock - 1) })
      .where(eq(schema.browserSessions.id, session.id));
    const next = await h.request(
      `/v1/internal/browser-sessions/${session.id}/claim`,
      serviceInit("POST", { workerId: "worker-b" }),
    );
    expect(next.status).toBe(200);
    expect((await json<{ session: SessionView }>(next)).session.worker).toMatchObject({ id: "worker-b" });
  });
});

describe("POST /internal/browser-sessions/:id/heartbeat and /release", () => {
  it("renews a live lease and refuses a stale token", async () => {
    const a = await cloudAccount();
    const session = await createSession(a);
    const claim = await h.request(
      `/v1/internal/browser-sessions/${session.id}/claim`,
      serviceInit("POST", { workerId: "worker-a" }),
    );
    const { leaseToken } = await json<{ leaseToken: string }>(claim);

    const beat = await h.request(
      `/v1/internal/browser-sessions/${session.id}/heartbeat`,
      serviceInit("POST", { leaseToken }),
    );
    expect(beat.status).toBe(200);
    expect((await json<{ session: SessionView }>(beat)).session.state).toBe("live");

    const stale = await h.request(
      `/v1/internal/browser-sessions/${session.id}/heartbeat`,
      serviceInit("POST", { leaseToken: "not-the-token" }),
    );
    expect(stale.status).toBe(409);
    expect(await json(stale)).toEqual({ error: "stale_lease" });

    expect(
      (
        await h.request(
          `/v1/internal/browser-sessions/${randomUUID()}/heartbeat`,
          serviceInit("POST", { leaseToken }),
        )
      ).status,
    ).toBe(404);
  });

  it("suspends the session on release and refuses a stale token", async () => {
    const a = await cloudAccount();
    const session = await createSession(a);
    const claim = await h.request(
      `/v1/internal/browser-sessions/${session.id}/claim`,
      serviceInit("POST", { workerId: "worker-a" }),
    );
    const { leaseToken } = await json<{ leaseToken: string }>(claim);

    const wrong = await h.request(
      `/v1/internal/browser-sessions/${session.id}/release`,
      serviceInit("POST", { leaseToken: "not-the-token", state: "suspended" }),
    );
    expect(wrong.status).toBe(409);
    expect(await json(wrong)).toEqual({ error: "stale_lease" });

    const released = await h.request(
      `/v1/internal/browser-sessions/${session.id}/release`,
      serviceInit("POST", { leaseToken, state: "suspended" }),
    );
    expect(released.status).toBe(204);
    const row = await sessionRow(session.id);
    expect(row.state).toBe("suspended");
    expect(row.leaseWorkerId).toBeNull();
    expect(row.leaseToken).toBeNull();
    expect(row.leaseUntil).toBeNull();

    // A worker may only hand a session back, never end it.
    const bad = await h.request(
      `/v1/internal/browser-sessions/${session.id}/release`,
      serviceInit("POST", { leaseToken, state: "ended" }),
    );
    expect(bad.status).toBe(400);
  });

  it("heartbeats an ended session with 410 so the worker tears it down", async () => {
    const a = await cloudAccount();
    const session = await createSession(a);
    const claim = await h.request(
      `/v1/internal/browser-sessions/${session.id}/claim`,
      serviceInit("POST", { workerId: "worker-a" }),
    );
    const { leaseToken } = await json<{ leaseToken: string }>(claim);
    expect((await h.request(`/v1/browser-sessions/${session.id}/end`, authed(a.token, "POST"))).status).toBe(204);
    const beat = await h.request(
      `/v1/internal/browser-sessions/${session.id}/heartbeat`,
      serviceInit("POST", { leaseToken }),
    );
    expect(beat.status).toBe(410);
    expect(await json(beat)).toEqual({ error: "session_ended" });
  });
});

describe("POST /internal/session-tickets/redeem", () => {
  async function mintTicket(a: CloudAccount, sessionId: string): Promise<string> {
    const res = await h.request(`/v1/browser-sessions/${sessionId}/ticket`, authed(a.token, "POST"));
    expect(res.status).toBe(200);
    return (await json<{ ticket: string }>(res)).ticket;
  }

  it("authenticates once and routes to the holding worker", async () => {
    const a = await cloudAccount();
    const session = await createSession(a);
    // Unleased: the redeemer is told nobody holds it and claims it itself.
    const first = await h.request(
      "/v1/internal/session-tickets/redeem",
      serviceInit("POST", { ticket: await mintTicket(a, session.id), sessionId: session.id }),
    );
    expect(first.status).toBe(200);
    expect(await json(first)).toEqual({
      userId: a.userId,
      deviceId: a.deviceId,
      platform: "macos",
      spaceId: "work",
      workerUrl: null,
    });

    await h.request(
      `/v1/internal/browser-sessions/${session.id}/claim`,
      serviceInit("POST", { workerId: "worker-a", workerUrl: "http://worker-a.internal" }),
    );
    const leased = await h.request(
      "/v1/internal/session-tickets/redeem",
      serviceInit("POST", { ticket: await mintTicket(a, session.id), sessionId: session.id }),
    );
    expect((await json<{ workerUrl: string }>(leased)).workerUrl).toBe("http://worker-a.internal");
  });

  it("spends the ticket exactly once", async () => {
    const a = await cloudAccount();
    const session = await createSession(a);
    const ticket = await mintTicket(a, session.id);
    expect(
      (await h.request("/v1/internal/session-tickets/redeem", serviceInit("POST", { ticket, sessionId: session.id })))
        .status,
    ).toBe(200);
    const again = await h.request(
      "/v1/internal/session-tickets/redeem",
      serviceInit("POST", { ticket, sessionId: session.id }),
    );
    expect(again.status).toBe(401);
    expect(await json(again)).toEqual({ error: "unauthorized" });
  });

  it("refuses an expired ticket, another session's, a revoked device's, and a wrong user's", async () => {
    const a = await cloudAccount();
    const session = await createSession(a);

    const expired = await mintTicket(a, session.id);
    await h.db
      .update(schema.sessionTickets)
      .set({ expiresAt: new Date(clock - 1) })
      .where(eq(schema.sessionTickets.secretHash, sha256(expired)));
    expect(
      (
        await h.request(
          "/v1/internal/session-tickets/redeem",
          serviceInit("POST", { ticket: expired, sessionId: session.id }),
        )
      ).status,
    ).toBe(401);

    // A ticket for one session is not a ticket for another.
    const wrongSession = await mintTicket(a, session.id);
    expect(
      (
        await h.request(
          "/v1/internal/session-tickets/redeem",
          serviceInit("POST", { ticket: wrongSession, sessionId: randomUUID() }),
        )
      ).status,
    ).toBe(401);

    // The ticket names a device belonging to someone else.
    const b = await cloudAccount();
    const crossed = await mintTicket(a, session.id);
    await h.db
      .update(schema.sessionTickets)
      .set({ deviceId: b.deviceId })
      .where(eq(schema.sessionTickets.secretHash, sha256(crossed)));
    expect(
      (
        await h.request(
          "/v1/internal/session-tickets/redeem",
          serviceInit("POST", { ticket: crossed, sessionId: session.id }),
        )
      ).status,
    ).toBe(401);

    // A device revoked between issue and redemption does not get a shell.
    const revokedTicket = await mintTicket(a, session.id);
    expect((await h.request(`/v1/devices/${a.deviceId}/revoke`, authed(a.token, "POST"))).status).toBe(200);
    expect(
      (
        await h.request(
          "/v1/internal/session-tickets/redeem",
          serviceInit("POST", { ticket: revokedTicket, sessionId: session.id }),
        )
      ).status,
    ).toBe(401);
  });
});

/* ------------------------------------------------------------------ *
 * Runs in a session (§4.3)
 * ------------------------------------------------------------------ */

describe("POST /runs with a session", () => {
  it("attaches the run and refuses an unknown, ended, or mismatched session", async () => {
    const a = await cloudAccount();
    const b = await cloudAccount();
    await addSpace(a, "second");
    const session = await createSession(a);

    const runId = await createRun(a, session.id);
    const run = await h.request(`/v1/runs/${runId}`, authed(a.token));
    expect((await json<{ run: HostedRunRecord }>(run)).run.sessionId).toBe(session.id);

    const unknown = await h.request(
      "/v1/runs",
      jsonInit("POST", { spaceId: "work", intent: "x", sessionId: randomUUID() }, a.token),
    );
    expect(unknown.status).toBe(404);
    expect(await json(unknown)).toEqual({ error: "session_not_found" });

    // Another account's session is not found, not forbidden.
    const theirs = await h.request(
      "/v1/runs",
      jsonInit("POST", { spaceId: "work", intent: "x", sessionId: session.id }, b.token),
    );
    expect(theirs.status).toBe(404);

    const mismatch = await h.request(
      "/v1/runs",
      jsonInit("POST", { spaceId: "second", intent: "x", sessionId: session.id }, a.token),
    );
    expect(mismatch.status).toBe(409);
    expect(await json(mismatch)).toEqual({ error: "session_space_mismatch" });

    expect((await h.request(`/v1/browser-sessions/${session.id}/end`, authed(a.token, "POST"))).status).toBe(204);
    const ended = await h.request(
      "/v1/runs",
      jsonInit("POST", { spaceId: "work", intent: "x", sessionId: session.id }, a.token),
    );
    expect(ended.status).toBe(404);
    expect(await json(ended)).toEqual({ error: "session_not_found" });
  });
});

describe("control generation (§4.3, W7)", () => {
  it("counts up through start, interrupt, release and completion", async () => {
    const a = await cloudAccount();
    const session = await createSession(a);
    expect((await readSession(a, session.id)).control).toEqual({ holder: "human", generation: 0 });

    const runId = await createRun(a, session.id);
    // A run that has not started yet leaves the session to the person.
    expect((await readSession(a, session.id)).control).toEqual({ holder: "human", generation: 0 });

    const claimed = await claimRun(runId, "worker-gen");
    expect(claimed.session).toEqual({ id: session.id, leaseToken: expect.any(String), generation: 1 });
    let view = await readSession(a, session.id);
    expect(view.control).toEqual({ holder: "agent", generation: 1 });
    expect(view.activeRunId).toBe(runId);
    expect(view.state).toBe("live");

    expect((await h.request(`/v1/runs/${runId}/interrupt`, authed(a.token, "POST"))).status).toBe(202);
    view = await readSession(a, session.id);
    expect(view.control).toEqual({ holder: "human", generation: 2 });
    // The run is still the session's: the person is driving it, not ending it.
    expect(view.activeRunId).toBe(runId);

    expect((await h.request(`/v1/runs/${runId}/release`, authed(a.token, "POST"))).status).toBe(202);
    expect((await readSession(a, session.id)).control).toEqual({ holder: "agent", generation: 3 });

    const complete = await h.request(
      `/v1/internal/runs/${runId}/complete`,
      serviceInit("POST", { leaseToken: claimed.leaseToken }),
    );
    expect(complete.status).toBe(200);
    view = await readSession(a, session.id);
    expect(view.control).toEqual({ holder: "human", generation: 4 });
    expect(view.activeRunId).toBeNull();

    // Every transition is on the run's own stream, carrying its generation.
    const controls = (await runEventsOf(runId)).filter((e) => e.t === "control");
    expect(controls).toEqual([
      { t: "control", control: "agent", generation: 1 },
      { t: "control", control: "human", generation: 2 },
      { t: "control", control: "agent", generation: 3 },
      { t: "control", control: "human", generation: 4 },
    ]);
  });

  it("hands the wheel back when a run is interrupted by its worker, fails, or is revoked", async () => {
    const a = await cloudAccount();
    const session = await createSession(a);

    const first = await createRun(a, session.id);
    const firstClaim = await claimRun(first, "worker-gen2");
    expect((await readSession(a, session.id)).control).toEqual({ holder: "agent", generation: 1 });
    expect(
      (
        await h.request(
          `/v1/internal/runs/${first}/interrupt`,
          serviceInit("POST", { leaseToken: firstClaim.leaseToken }),
        )
      ).status,
    ).toBe(200);
    let view = await readSession(a, session.id);
    expect(view.control).toEqual({ holder: "human", generation: 2 });
    expect(view.activeRunId).toBeNull();

    const second = await createRun(a, session.id);
    const secondClaim = await claimRun(second, "worker-gen2");
    expect((await readSession(a, session.id)).control).toEqual({ holder: "agent", generation: 3 });
    expect(
      (
        await h.request(
          `/v1/internal/runs/${second}/fail`,
          serviceInit("POST", { leaseToken: secondClaim.leaseToken, reason: "model_error" }),
        )
      ).status,
    ).toBe(200);
    expect((await readSession(a, session.id)).control).toEqual({ holder: "human", generation: 4 });

    const third = await createRun(a, session.id);
    await claimRun(third, "worker-gen2");
    expect((await readSession(a, session.id)).control).toEqual({ holder: "agent", generation: 5 });
    expect((await h.request(`/v1/runs/${third}/revoke`, authed(a.token, "POST"))).status).toBe(202);
    view = await readSession(a, session.id);
    expect(view.control).toEqual({ holder: "human", generation: 6 });
    expect(view.activeRunId).toBeNull();
  });

  it("leaves a run with no session alone", async () => {
    const a = await cloudAccount();
    const runId = await createRun(a);
    const claimed = await claimRun(runId, "worker-plain");
    expect(claimed.session).toBeUndefined();
    expect((await runEventsOf(runId)).filter((e) => e.t === "control")).toEqual([]);
    expect((await h.request(`/v1/runs/${runId}/interrupt`, authed(a.token, "POST"))).status).toBe(202);
    // The control event still exists for the run; it simply carries no fence.
    expect((await runEventsOf(runId)).filter((e) => e.t === "control")).toEqual([{ t: "control", control: "human" }]);
  });
});

describe("POST /internal/runs/claim placement (§4.3)", () => {
  it("gives the run and the session to one worker and refuses the other", async () => {
    const a = await cloudAccount();
    const session = await createSession(a);
    // Worker A already holds the session (a viewer attached first).
    const held = await h.request(
      `/v1/internal/browser-sessions/${session.id}/claim`,
      serviceInit("POST", { workerId: "worker-a", workerUrl: "http://worker-a.internal" }),
    );
    expect(held.status).toBe(200);
    const sessionLease = (await json<{ leaseToken: string }>(held)).leaseToken;
    // ... and worker B is refused it outright.
    expect(
      (
        await h.request(
          `/v1/internal/browser-sessions/${session.id}/claim`,
          serviceInit("POST", { workerId: "worker-b" }),
        )
      ).status,
    ).toBe(409);

    const runId = await createRun(a, session.id);

    // Worker B may not take a run whose tabs live in worker A's Chromium.
    for (let i = 0; i < 5; i += 1) {
      const claimed = await claimAny("worker-b");
      if (claimed === null) break;
      expect(claimed.run.id).not.toBe(runId);
    }
    const stillReady = await h.request(`/v1/runs/${runId}`, authed(a.token));
    expect((await json<{ run: HostedRunRecord }>(stillReady)).run.status).toBe("ready");

    // Worker A takes it, and keeps the session lease it already holds.
    const mine = await claimRun(runId, "worker-a", "http://worker-a.internal");
    expect(mine.session).toEqual({ id: session.id, leaseToken: sessionLease, generation: expect.any(Number) });
    expect((await readSession(a, session.id)).control).toEqual({ holder: "agent", generation: 1 });
  });

  it("claims an unleased session atomically with its run", async () => {
    const a = await cloudAccount();
    const session = await createSession(a);
    expect((await readSession(a, session.id)).worker).toBeNull();
    const runId = await createRun(a, session.id);
    const claimed = await claimRun(runId, "worker-atomic", "http://worker-atomic.internal");
    expect(claimed.session?.id).toBe(session.id);
    const row = await sessionRow(session.id);
    expect(row.state).toBe("live");
    expect(row.leaseWorkerId).toBe("worker-atomic");
    expect(row.leaseWorkerUrl).toBe("http://worker-atomic.internal");
    expect(row.leaseToken).toBe(claimed.session?.leaseToken);
    expect(row.activeRunId).toBe(runId);
  });

  it("never claims a run whose session has ended", async () => {
    const a = await cloudAccount();
    const session = await createSession(a);
    const runId = await createRun(a, session.id);
    // End the session out from under the run without touching the run, so
    // the placement filter is what has to refuse it.
    await h.db
      .update(schema.browserSessions)
      .set({ state: "ended", endedAt: new Date(clock) })
      .where(eq(schema.browserSessions.id, session.id));
    for (let i = 0; i < 5; i += 1) {
      const claimed = await claimAny("worker-orphan");
      if (claimed === null) break;
      expect(claimed.run.id).not.toBe(runId);
    }
  });
});

describe("GET /internal/users/:id/egress-credential?sessionId=", () => {
  it("mints a credential recorded against the session", async () => {
    const a = await cloudAccount();
    const session = await createSession(a);
    const res = await h.request(
      `/v1/internal/users/${a.userId}/egress-credential?deviceId=${a.cloudId}&sessionId=${session.id}`,
      serviceInit("GET"),
    );
    expect(res.status).toBe(200);
    const credential = await json<{ username: string; credentialId: string }>(res);
    expect(credential.username).toContain(a.userId);
    const [row] = await h.db
      .select()
      .from(schema.egressCredentials)
      .where(eq(schema.egressCredentials.id, credential.credentialId));
    expect(row?.sessionId).toBe(session.id);
    expect(row?.runId).toBeNull();
  });

  it("refuses an ended session, another account's, and an ambiguous holder", async () => {
    const a = await cloudAccount();
    const b = await cloudAccount();
    const session = await createSession(a);
    const runId = await createRun(a);

    const theirs = await h.request(
      `/v1/internal/users/${b.userId}/egress-credential?deviceId=${b.cloudId}&sessionId=${session.id}`,
      serviceInit("GET"),
    );
    expect(theirs.status).toBe(404);

    // Two holders, or none, is a malformed question.
    expect(
      (
        await h.request(
          `/v1/internal/users/${a.userId}/egress-credential?deviceId=${a.cloudId}&sessionId=${session.id}&runId=${runId}`,
          serviceInit("GET"),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await h.request(
          `/v1/internal/users/${a.userId}/egress-credential?deviceId=${a.cloudId}`,
          serviceInit("GET"),
        )
      ).status,
    ).toBe(400);

    expect((await h.request(`/v1/browser-sessions/${session.id}/end`, authed(a.token, "POST"))).status).toBe(204);
    const ended = await h.request(
      `/v1/internal/users/${a.userId}/egress-credential?deviceId=${a.cloudId}&sessionId=${session.id}`,
      serviceInit("GET"),
    );
    expect(ended.status).toBe(404);
  });
});

/* ------------------------------------------------------------------ *
 * Maintenance (§4.3)
 * ------------------------------------------------------------------ */

describe("runMaintenance", () => {
  it("suspends a lapsed lease, ends a stale suspension, and sweeps spent tickets", async () => {
    const stack = await makeStack({ CLOUD_BROWSER_PUBLIC_URL: RUNNER_URL });
    try {
      const a = await cloudAccount(stack);
      const session = await createSession(a, "work", stack);
      expect(
        (
          await stack.h.request(
            `/v1/internal/browser-sessions/${session.id}/claim`,
            serviceInit("POST", { workerId: "worker-a" }),
          )
        ).status,
      ).toBe(200);
      expect((await stack.h.request(`/v1/browser-sessions/${session.id}/ticket`, authed(a.token, "POST"))).status).toBe(200);

      // Before the lease expires nothing moves.
      let result = await stack.h.control.runMaintenance(clock + 30_000);
      expect(result.suspendedBrowserSessions).toBe(0);
      expect(await stack.h.db.select().from(schema.sessionTickets)).toHaveLength(1);

      // Past it, the worker is gone: the session is suspended and the unspent
      // ticket swept.
      result = await stack.h.control.runMaintenance(clock + 2 * 60_000);
      expect(result.suspendedBrowserSessions).toBe(1);
      expect(result.endedBrowserSessions).toBe(0);
      expect(await stack.h.db.select().from(schema.sessionTickets)).toEqual([]);
      const [suspended] = await stack.h.db
        .select()
        .from(schema.browserSessions)
        .where(eq(schema.browserSessions.id, session.id));
      expect(suspended?.state).toBe("suspended");
      expect(suspended?.leaseWorkerId).toBeNull();

      // A suspension nobody came back to inside the retention window survives.
      expect((await stack.h.control.runMaintenance(clock + 2 * 60_000 + 6 * DAY_MS)).endedBrowserSessions).toBe(0);
      // Past it, the session ends for good.
      const ended = await stack.h.control.runMaintenance(clock + 2 * 60_000 + 8 * DAY_MS);
      expect(ended.endedBrowserSessions).toBe(1);
      const [gone] = await stack.h.db
        .select()
        .from(schema.browserSessions)
        .where(eq(schema.browserSessions.id, session.id));
      expect(gone?.state).toBe("ended");
      expect(gone?.endedAt).not.toBeNull();
    } finally {
      await stack.runner.close();
    }
  });

  it("gives the wheel back when the session's run ended without a control transition", async () => {
    const stack = await makeStack({ CLOUD_BROWSER_PUBLIC_URL: RUNNER_URL });
    try {
      const a = await cloudAccount(stack);
      const session = await createSession(a, "work", stack);
      const created = await stack.h.request(
        "/v1/runs",
        jsonInit("POST", { spaceId: "work", intent: "x", sessionId: session.id }, a.token),
      );
      const runId = (await json<{ runId: string }>(created)).runId;
      const claim = await stack.h.request("/v1/internal/runs/claim", serviceInit("POST", { workerId: "worker-m" }));
      expect((await json<ClaimedRun>(claim)).run.id).toBe(runId);

      // The run's authority ends outside any session-aware path.
      await stack.h.db
        .update(schema.hostedRuns)
        .set({ status: "revoked", authorityEnded: true, completedAt: new Date(clock) })
        .where(eq(schema.hostedRuns.id, runId));
      await stack.h.control.runMaintenance(clock + 1_000);

      const [row] = await stack.h.db
        .select()
        .from(schema.browserSessions)
        .where(eq(schema.browserSessions.id, session.id));
      expect(row?.controlHolder).toBe("human");
      expect(row?.activeRunId).toBeNull();
      expect(row?.controlGeneration).toBe(2);
    } finally {
      await stack.runner.close();
    }
  });

  it("gives the wheel back in the same pass that expires the pause which ended the run", async () => {
    const stack = await makeStack({ CLOUD_BROWSER_PUBLIC_URL: RUNNER_URL });
    try {
      const a = await cloudAccount(stack);
      const session = await createSession(a, "work", stack);
      const created = await stack.h.request(
        "/v1/runs",
        jsonInit("POST", { spaceId: "work", intent: "x", sessionId: session.id }, a.token),
      );
      const runId = (await json<{ runId: string }>(created)).runId;
      const claim = await stack.h.request("/v1/internal/runs/claim", serviceInit("POST", { workerId: "worker-p" }));
      const runLease = (await json<ClaimedRun>(claim)).leaseToken;
      // An approval nobody answered. `expirePauses` is a FIFTH way a run
      // ends — the four route paths call `releaseSessionForRun`, this one has
      // nothing to — and the repair that covers it used to run earlier in the
      // very same maintenance pass, leaving the session claiming the agent
      // held the wheel for up to an hour: input dropped, the agent's veil up,
      // and no idle suspend.
      const approval = {
        id: "pause-late",
        kind: "approval",
        requestedAt: new Date(clock - 10_000).toISOString(),
        expiresAt: new Date(clock - 1_000).toISOString(),
        capability: null,
        payload: {},
      };
      expect(
        (await stack.h.request(`/v1/internal/runs/${runId}/pause`, serviceInit("POST", { leaseToken: runLease, pause: approval }))).status,
      ).toBe(200);

      const result = await stack.h.control.runMaintenance(clock + 1_000);
      expect(result.expiredPauses).toBeGreaterThan(0);
      const [row] = await stack.h.db
        .select()
        .from(schema.browserSessions)
        .where(eq(schema.browserSessions.id, session.id));
      expect(row?.controlHolder).toBe("human");
      expect(row?.activeRunId).toBeNull();
    } finally {
      await stack.runner.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * The session's runs: the worker side (web-browser-design.md §8)
 * ------------------------------------------------------------------ */

/** Claim the session for a worker and answer with the lease the routes below need. */
async function leaseSession(sessionId: string, workerId = "worker-runs"): Promise<string> {
  const res = await h.request(
    `/v1/internal/browser-sessions/${sessionId}/claim`,
    serviceInit("POST", { workerId, workerUrl: "http://worker-runs.internal" }),
  );
  expect(res.status).toBe(200);
  return (await json<{ leaseToken: string }>(res)).leaseToken;
}

interface SessionRunCreated {
  runId: string;
  at: string;
  events: RunEvent[];
}

interface SessionRunTransition {
  ok: true;
  status: string;
  seqs: number[];
  at: string;
  events: RunEvent[];
}

async function startSessionRun(
  sessionId: string,
  leaseToken: string,
  viewerDeviceId: string,
  body: Record<string, unknown> = {},
): Promise<Response> {
  return h.request(
    `/v1/internal/browser-sessions/${sessionId}/runs`,
    serviceInit("POST", { leaseToken, viewerDeviceId, intent: "Type into the fixture", ...body }),
  );
}

async function sessionRunCommand(
  sessionId: string,
  runId: string,
  command: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return h.request(
    `/v1/internal/browser-sessions/${sessionId}/runs/${runId}/${command}`,
    serviceInit("POST", body),
  );
}

describe("POST /internal/browser-sessions/:id/runs", () => {
  it("creates exactly what POST /runs with a sessionId creates, sponsored by the session's user", async () => {
    const a = await cloudAccount();
    const session = await createSession(a);
    const leaseToken = await leaseSession(session.id);

    const res = await startSessionRun(session.id, leaseToken, a.deviceId, { startUrl: "https://fixture.example/" });
    expect(res.status).toBe(201);
    const created = await json<SessionRunCreated>(res);
    expect(created.runId).toBeTypeOf("string");
    // The answer carries `run.created` so the host folds the run at once
    // rather than waiting for a stream a cloud device may not subscribe to.
    expect(created.events).toHaveLength(1);
    const first = created.events[0];
    expect(first?.t).toBe("run.created");

    const [row] = await h.db.select().from(schema.hostedRuns).where(eq(schema.hostedRuns.id, created.runId));
    // `sponsorId === userId` for a hosted run (§7.5): the session's user is
    // the sponsor, never the worker.
    expect(row?.userId).toBe(a.userId);
    expect(row?.spaceId).toBe("work");
    expect(row?.intent).toBe("Type into the fixture");
    expect(row?.sessionId).toBe(session.id);
    expect(row?.startUrl).toBe("https://fixture.example/");
    expect(row?.executor.kind).toBe("cloud");
    // The same stream a device-created run has.
    expect((await runEventsOf(created.runId)).map((event) => event.t)).toEqual(["run.created"]);

    // The audit names the viewer's device, not the worker.
    const [audited] = await h.db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.userId, a.userId), eq(schema.auditEvents.kind, "run.created")));
    expect(audited?.actorDeviceId).toBe(a.deviceId);
  });

  it("acts in the session's tabs when no start page is named", async () => {
    const a = await cloudAccount();
    const session = await createSession(a);
    const leaseToken = await leaseSession(session.id);
    const created = await json<SessionRunCreated>(await startSessionRun(session.id, leaseToken, a.deviceId));
    const [row] = await h.db.select().from(schema.hostedRuns).where(eq(schema.hostedRuns.id, created.runId));
    expect(row?.startUrl).toBeNull();
  });

  it("refuses a stale lease, an unknown session, an ended one, and a Space without the cloud", async () => {
    const a = await cloudAccount();
    const session = await createSession(a);
    const leaseToken = await leaseSession(session.id);

    const stale = await startSessionRun(session.id, "not-the-lease", a.deviceId);
    expect(stale.status).toBe(409);
    expect(await json(stale)).toEqual({ error: "stale_lease" });

    const missing = await startSessionRun(randomUUID(), leaseToken, a.deviceId);
    expect(missing.status).toBe(404);
    expect(await json(missing)).toEqual({ error: "not_found" });

    // A Space whose cloud was disabled: the same gate `POST /runs` uses.
    const b = await cloudAccount();
    const other = await createSession(b);
    const otherLease = await leaseSession(other.id, "worker-runs-b");
    expect((await h.request("/v1/cloud/disable", jsonInit("POST", { spaceId: "work" }, b.token))).status).toBeLessThan(300);
    const uncloudy = await startSessionRun(other.id, otherLease, b.deviceId);
    expect(uncloudy.status).toBe(400);
    expect(await json(uncloudy)).toEqual({ error: "space_not_cloud_enabled" });

    expect((await h.request(`/v1/browser-sessions/${session.id}/end`, authed(a.token, "POST"))).status).toBe(204);
    const ended = await startSessionRun(session.id, leaseToken, a.deviceId);
    expect(ended.status).toBe(410);
    expect(await json(ended)).toEqual({ error: "session_ended" });
  });

  it("refuses a viewer device that is not this account's, or is revoked", async () => {
    const a = await cloudAccount();
    const b = await cloudAccount();
    const session = await createSession(a);
    const leaseToken = await leaseSession(session.id);

    const foreign = await startSessionRun(session.id, leaseToken, b.deviceId);
    expect(foreign.status).toBe(403);
    expect(await json(foreign)).toEqual({ error: "viewer_device" });

    expect((await startSessionRun(session.id, leaseToken, randomUUID())).status).toBe(403);

    // A device revoked while its tab was open cannot start anything more.
    const doomed = await desktopAccount(h);
    await h.db
      .update(schema.devices)
      .set({ userId: a.userId })
      .where(eq(schema.devices.id, doomed.deviceId));
    expect((await startSessionRun(session.id, leaseToken, doomed.deviceId)).status).toBe(201);
    await h.db
      .update(schema.devices)
      .set({ revokedAt: new Date(clock) })
      .where(eq(schema.devices.id, doomed.deviceId));
    const revoked = await startSessionRun(session.id, leaseToken, doomed.deviceId);
    expect(revoked.status).toBe(403);
    expect(await json(revoked)).toEqual({ error: "viewer_device" });
  });
});

describe("POST /internal/browser-sessions/:id/runs/:runId/:command", () => {
  it("preserves command refusals through the production Node HTTP adapter", async () => {
    const a = await cloudAccount();
    const session = await createSession(a);
    const leaseToken = await leaseSession(session.id);
    const { runId } = await json<SessionRunCreated>(await startSessionRun(session.id, leaseToken, a.deviceId));
    const claimed = await claimRun(runId, "worker-runs");
    expect((await h.request(`/v1/internal/runs/${runId}/pause`, serviceInit("POST", {
      leaseToken: claimed.leaseToken,
      pause: {
        id: "credential-handoff",
        kind: "step_up",
        requestedAt: new Date(clock).toISOString(),
        expiresAt: new Date(clock + 600_000).toISOString(),
        capability: null,
        payload: {},
      },
    }))).status).toBe(200);

    // The adapter replaces global Response, but Response.json still returns
    // a native response. app.request alone cannot reproduce this boundary.
    const originalRequest = globalThis.Request;
    const originalResponse = globalThis.Response;
    const server = createServer(getRequestListener(h.control.app.fetch));
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const command = (name: string, extra = {}) => fetch(
        `${base}/v1/internal/browser-sessions/${session.id}/runs/${runId}/${name}`,
        serviceInit("POST", { leaseToken, viewerDeviceId: a.deviceId, ...extra }),
      );
      const paused = await command("message", { text: "continue" });
      expect(paused.status).toBe(409);
      expect(await paused.json()).toEqual({ error: "paused" });
      const interrupted = await command("interrupt");
      expect(interrupted.status).toBe(202);
      expect(await interrupted.json()).toMatchObject({ status: "human_control" });
      const repeated = await command("interrupt");
      expect(repeated.status).toBe(409);
      expect(await repeated.json()).toEqual({ error: "invalid_state" });
      expect((await command("release")).status).toBe(202);
      expect((await command("revoke")).status).toBe(202);
      const ended = await fetch(`${base}/v1/runs/${runId}/answer`, jsonInit("POST", {
        questionId: "gone", value: "yes",
      }, a.token));
      expect(ended.status).toBe(409);
      expect(await ended.json()).toEqual({ error: "run_ended" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      Object.defineProperty(globalThis, "Request", { value: originalRequest });
      Object.defineProperty(globalThis, "Response", { value: originalResponse });
    }
  });

  it("drives the same transitions and the same generation arithmetic as the sponsor routes", async () => {
    const a = await cloudAccount();
    const session = await createSession(a);
    const leaseToken = await leaseSession(session.id);
    const { runId } = await json<SessionRunCreated>(await startSessionRun(session.id, leaseToken, a.deviceId));
    // Claiming the run takes the session with it: the agent has the wheel.
    const claimed = await claimRun(runId, "worker-runs");
    expect(claimed.session).toMatchObject({ id: session.id, leaseToken, generation: 1 });

    const interrupted = await sessionRunCommand(session.id, runId, "interrupt", { leaseToken, viewerDeviceId: a.deviceId });
    expect(interrupted.status).toBe(202);
    const took = await json<SessionRunTransition>(interrupted);
    expect(took.status).toBe("human_control");
    expect(took.events.map((event) => event.t)).toEqual(["cmd.interrupt", "status", "control"]);
    expect(took.events.at(-1)).toEqual({ t: "control", control: "human", generation: 2 });
    expect((await sessionRow(session.id)).controlHolder).toBe("human");

    const released = await json<SessionRunTransition>(
      await sessionRunCommand(session.id, runId, "release", { leaseToken, viewerDeviceId: a.deviceId }),
    );
    expect(released.status).toBe("running");
    expect(released.events.at(-1)).toEqual({ t: "control", control: "agent", generation: 3 });

    const messaged = await json<SessionRunTransition>(
      await sessionRunCommand(session.id, runId, "message", { leaseToken, viewerDeviceId: a.deviceId, text: "keep going" }),
    );
    expect(messaged.events[0]).toMatchObject({ t: "cmd.message", text: "keep going" });

    const revoked = await json<SessionRunTransition>(
      await sessionRunCommand(session.id, runId, "revoke", { leaseToken, viewerDeviceId: a.deviceId }),
    );
    expect(revoked.status).toBe("revoked");
    expect(revoked.events.at(-1)).toEqual({ t: "control", control: "human", generation: 4 });
    const after = await sessionRow(session.id);
    expect(after.controlHolder).toBe("human");
    expect(after.activeRunId).toBeNull();

    // The audit names the viewer's device for every one of them.
    const audits = await h.db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.userId, a.userId), eq(schema.auditEvents.kind, "run.interrupt")));
    expect(audits[0]?.actorDeviceId).toBe(a.deviceId);
  });

  it("answers a question and approves or rejects a pending approval", async () => {
    const a = await cloudAccount();
    const session = await createSession(a);
    const leaseToken = await leaseSession(session.id);
    const { runId } = await json<SessionRunCreated>(await startSessionRun(session.id, leaseToken, a.deviceId));
    const claimed = await claimRun(runId, "worker-runs");
    const runLease = claimed.leaseToken;

    const judgment = {
      id: "pause-q",
      kind: "judgment",
      requestedAt: new Date(clock).toISOString(),
      expiresAt: new Date(clock + 600_000).toISOString(),
      capability: null,
      payload: { questionId: "q1" },
    };
    expect(
      (await h.request(`/v1/internal/runs/${runId}/pause`, serviceInit("POST", { leaseToken: runLease, pause: judgment }))).status,
    ).toBe(200);
    const answered = await json<SessionRunTransition>(
      await sessionRunCommand(session.id, runId, "answer", {
        leaseToken,
        viewerDeviceId: a.deviceId,
        questionId: "q1",
        value: "yes",
      }),
    );
    expect(answered.status).toBe("ready");
    expect(answered.events.map((event) => event.t)).toEqual(["cmd.answer", "resume", "status"]);

    // An approval: the shell's Approve is the sponsor's decision on the
    // run's own pause, because a run in a session has no local half.
    const reclaimed = await claimRun(runId, "worker-runs");
    const approval = {
      id: "pause-a",
      kind: "approval",
      requestedAt: new Date(clock).toISOString(),
      expiresAt: new Date(clock + 600_000).toISOString(),
      capability: null,
      payload: {},
    };
    expect(
      (await h.request(
        `/v1/internal/runs/${runId}/pause`,
        serviceInit("POST", { leaseToken: reclaimed.leaseToken, pause: approval }),
      )).status,
    ).toBe(200);
    const approved = await json<SessionRunTransition>(
      await sessionRunCommand(session.id, runId, "approve", { leaseToken, viewerDeviceId: a.deviceId, approvalId: "pause-a" }),
    );
    expect(approved.status).toBe("ready");
    expect(approved.events.map((event) => event.t)).toEqual(["resume", "status"]);

    // A decision on a pause that is no longer pending is refused, not applied.
    const late = await sessionRunCommand(session.id, runId, "approve", {
      leaseToken,
      viewerDeviceId: a.deviceId,
      approvalId: "pause-a",
    });
    expect(late.status).toBe(409);
    expect(await json(late)).toEqual({ error: "pause_not_pending" });

    // Reject ends the run and hands the session back.
    const third = await claimRun(runId, "worker-runs");
    expect(
      (await h.request(
        `/v1/internal/runs/${runId}/pause`,
        serviceInit("POST", { leaseToken: third.leaseToken, pause: { ...approval, id: "pause-b" } }),
      )).status,
    ).toBe(200);
    const rejected = await json<SessionRunTransition>(
      await sessionRunCommand(session.id, runId, "reject", { leaseToken, viewerDeviceId: a.deviceId, approvalId: "pause-b" }),
    );
    expect(rejected.status).toBe("rejected");
    expect((await sessionRow(session.id)).controlHolder).toBe("human");
  });

  it("refuses a run of another session, a stale lease, a foreign viewer, an ended session, and a malformed command", async () => {
    const a = await cloudAccount();
    const session = await createSession(a);
    const leaseToken = await leaseSession(session.id);
    const { runId } = await json<SessionRunCreated>(await startSessionRun(session.id, leaseToken, a.deviceId));

    // A run of the same account, but not of this session.
    const loose = await createRun(a);
    const wrongRun = await sessionRunCommand(session.id, loose, "interrupt", { leaseToken, viewerDeviceId: a.deviceId });
    expect(wrongRun.status).toBe(404);
    expect(await json(wrongRun)).toEqual({ error: "not_found" });
    expect((await sessionRunCommand(session.id, randomUUID(), "interrupt", { leaseToken, viewerDeviceId: a.deviceId })).status).toBe(404);

    expect((await sessionRunCommand(session.id, runId, "interrupt", { leaseToken: "nope", viewerDeviceId: a.deviceId })).status).toBe(409);
    const b = await cloudAccount();
    expect((await sessionRunCommand(session.id, runId, "interrupt", { leaseToken, viewerDeviceId: b.deviceId })).status).toBe(403);

    const malformed = await sessionRunCommand(session.id, runId, "message", { leaseToken, viewerDeviceId: a.deviceId });
    expect(malformed.status).toBe(400);
    expect(await json(malformed)).toMatchObject({ error: "invalid_body", reason: "text" });
    expect((await sessionRunCommand(session.id, runId, "invented", { leaseToken, viewerDeviceId: a.deviceId })).status).toBe(400);

    expect((await h.request(`/v1/browser-sessions/${session.id}/end`, authed(a.token, "POST"))).status).toBe(204);
    const ended = await sessionRunCommand(session.id, runId, "interrupt", { leaseToken, viewerDeviceId: a.deviceId });
    expect(ended.status).toBe(410);
  });
});

describe("GET /internal/browser-sessions/:id/runs", () => {
  it("lists the Space's threads with their sealed snapshots, and nothing from another Space", async () => {
    const a = await cloudAccount();
    await addSpace(a, "play");
    const session = await createSession(a);
    const leaseToken = await leaseSession(session.id);
    const { runId } = await json<SessionRunCreated>(await startSessionRun(session.id, leaseToken, a.deviceId));
    const elsewhere = await createRun(a, undefined, "play");
    const claimed = await claimRun(runId, "worker-runs");
    const thread = { spaceId: "work", sealed: "AQIDBA==" };
    expect(
      (await h.request(`/v1/internal/runs/${runId}/thread`, serviceInit("PUT", { leaseToken: claimed.leaseToken, thread }))).status,
    ).toBe(204);

    const res = await h.request(`/v1/internal/browser-sessions/${session.id}/runs`, leasedInit("GET", leaseToken));
    expect(res.status).toBe(200);
    const listed = await json<{ runs: Array<{ runId: string }>; threads: Array<{ runId: string; spaceId: string; sealed: string }> }>(res);
    expect(listed.runs.map((item) => item.runId)).toContain(runId);
    expect(listed.runs.map((item) => item.runId)).not.toContain(elsewhere);
    expect(listed.threads).toEqual([{ runId, spaceId: "work", sealed: "AQIDBA==" }]);
  });

  it("takes the lease from a header, and never from the query string", async () => {
    const a = await cloudAccount();
    const session = await createSession(a);
    const leaseToken = await leaseSession(session.id);
    // The lease authorises starting, steering, revoking and reading every run
    // in this person's Space, and control logs `url.search` on every request.
    expect(
      (await h.request(`/v1/internal/browser-sessions/${session.id}/runs?leaseToken=${leaseToken}`, serviceInit("GET"))).status,
    ).toBe(409);
    expect((await h.request(`/v1/internal/browser-sessions/${session.id}/runs`, leasedInit("GET", leaseToken))).status).toBe(200);
    expect(
      (await h.request(
        `/v1/internal/browser-sessions/${session.id}/runs/${randomUUID()}/events?leaseToken=${leaseToken}`,
        serviceInit("GET"),
      )).status,
    ).toBe(409);
  });

  it("refuses a stale lease, an unknown session, and an ended one", async () => {
    const a = await cloudAccount();
    const session = await createSession(a);
    const leaseToken = await leaseSession(session.id);
    expect((await h.request(`/v1/internal/browser-sessions/${session.id}/runs`, leasedInit("GET", "nope"))).status).toBe(409);
    expect((await h.request(`/v1/internal/browser-sessions/${randomUUID()}/runs`, leasedInit("GET", leaseToken))).status).toBe(404);
    expect((await h.request(`/v1/browser-sessions/${session.id}/end`, authed(a.token, "POST"))).status).toBe(204);
    expect((await h.request(`/v1/internal/browser-sessions/${session.id}/runs`, leasedInit("GET", leaseToken))).status).toBe(410);
  });
});

describe("GET /internal/browser-sessions/:id", () => {
  it("tells a worker where the session is, with the holder's address only while its lease is live", async () => {
    const a = await cloudAccount();
    const session = await createSession(a);
    const before = await h.request(`/v1/internal/browser-sessions/${session.id}`, serviceInit("GET"));
    expect(before.status).toBe(200);
    const idle = await json<{ session: SessionView; workerUrl: string | null }>(before);
    expect(idle.session.state).toBe("ready");
    // Nobody holds it, so there is nowhere to relay to.
    expect(idle.workerUrl).toBeNull();

    await leaseSession(session.id, "worker-holder");
    const after = await h.request(`/v1/internal/browser-sessions/${session.id}`, serviceInit("GET"));
    const held = await json<{ session: SessionView; workerUrl: string | null }>(after);
    expect(held.session.state).toBe("live");
    expect(held.session.worker).toMatchObject({ id: "worker-holder" });
    // This is the whole point of the route: a worker that lost the claim race
    // relays here instead of refusing 409 (§6.4).
    expect(held.workerUrl).toBe("http://worker-runs.internal");
  });

  it("answers 404 for a session that is not there", async () => {
    const res = await h.request(`/v1/internal/browser-sessions/${randomUUID()}`, serviceInit("GET"));
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: "not_found" });
  });

  it("is service-only, like the rest of the internal family", async () => {
    const a = await cloudAccount();
    const session = await createSession(a);
    expect((await h.request(`/v1/internal/browser-sessions/${session.id}`, authed(a.token))).status).toBe(401);
  });
});

describe("DELETE /internal/browser-sessions/:id/runs/:runId", () => {
  it("hides a finished conversation from every list and keeps its events", async () => {
    const a = await cloudAccount();
    const session = await createSession(a);
    const leaseToken = await leaseSession(session.id);
    const { runId } = await json<SessionRunCreated>(await startSessionRun(session.id, leaseToken, a.deviceId));
    await claimRun(runId, "worker-runs");
    // A run still acting is not forgotten out from under itself; revoke first.
    expect((await sessionRunCommand(session.id, runId, "revoke", { leaseToken, viewerDeviceId: a.deviceId })).status).toBe(202);

    const before = await json<{ runs: Array<{ runId: string }> }>(
      await h.request(`/v1/internal/browser-sessions/${session.id}/runs`, leasedInit("GET", leaseToken)),
    );
    expect(before.runs.map((item) => item.runId)).toContain(runId);

    const res = await h.request(
      `/v1/internal/browser-sessions/${session.id}/runs/${runId}`,
      serviceInit("DELETE", { leaseToken, viewerDeviceId: a.deviceId }),
    );
    expect(res.status).toBe(204);

    const after = await json<{ runs: Array<{ runId: string }> }>(
      await h.request(`/v1/internal/browser-sessions/${session.id}/runs`, leasedInit("GET", leaseToken)),
    );
    expect(after.runs.map((item) => item.runId)).not.toContain(runId);
    // The device's own list forgets it too — it is one list, not two.
    const listed = await json<{ runs: Array<{ runId: string }> }>(
      await h.request(`/v1/runs?spaceId=work`, authed(a.token)),
    );
    expect(listed.runs.map((item) => item.runId)).not.toContain(runId);
    // A soft delete: the audit trail stays exactly where it was.
    expect((await runEventsOf(runId)).length).toBeGreaterThan(0);
    expect((await h.request(`/v1/internal/browser-sessions/${session.id}/runs/${runId}/events`, leasedInit("GET", leaseToken))).status).toBe(200);
  });

  it("refuses a run that is still acting", async () => {
    const a = await cloudAccount();
    const session = await createSession(a);
    const leaseToken = await leaseSession(session.id);
    const { runId } = await json<SessionRunCreated>(await startSessionRun(session.id, leaseToken, a.deviceId));
    const res = await h.request(
      `/v1/internal/browser-sessions/${session.id}/runs/${runId}`,
      serviceInit("DELETE", { leaseToken, viewerDeviceId: a.deviceId }),
    );
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: "run_active" });
  });

  it("refuses a stale lease, an unknown run, a device that is not this account's, and an ended session", async () => {
    const a = await cloudAccount();
    const b = await cloudAccount();
    const session = await createSession(a);
    const leaseToken = await leaseSession(session.id);
    const { runId } = await json<SessionRunCreated>(await startSessionRun(session.id, leaseToken, a.deviceId));

    const stale = await h.request(
      `/v1/internal/browser-sessions/${session.id}/runs/${runId}`,
      serviceInit("DELETE", { leaseToken: "nope", viewerDeviceId: a.deviceId }),
    );
    expect(stale.status).toBe(409);
    expect(await json(stale)).toEqual({ error: "stale_lease" });

    const unknown = await h.request(
      `/v1/internal/browser-sessions/${session.id}/runs/${randomUUID()}`,
      serviceInit("DELETE", { leaseToken, viewerDeviceId: a.deviceId }),
    );
    expect(unknown.status).toBe(404);

    const wrongDevice = await h.request(
      `/v1/internal/browser-sessions/${session.id}/runs/${runId}`,
      serviceInit("DELETE", { leaseToken, viewerDeviceId: b.deviceId }),
    );
    expect(wrongDevice.status).toBe(403);
    expect(await json(wrongDevice)).toEqual({ error: "viewer_device" });

    expect((await h.request(`/v1/browser-sessions/${session.id}/end`, authed(a.token, "POST"))).status).toBe(204);
    const ended = await h.request(
      `/v1/internal/browser-sessions/${session.id}/runs/${runId}`,
      serviceInit("DELETE", { leaseToken, viewerDeviceId: a.deviceId }),
    );
    expect(ended.status).toBe(410);
  });
});

describe("GET /internal/browser-sessions/:id/runs/:runId/events", () => {
  it("replays a run's stream so a thread can be reopened without SSE", async () => {
    const a = await cloudAccount();
    const session = await createSession(a);
    const leaseToken = await leaseSession(session.id);
    const { runId } = await json<SessionRunCreated>(await startSessionRun(session.id, leaseToken, a.deviceId));
    await claimRun(runId, "worker-runs");
    await sessionRunCommand(session.id, runId, "interrupt", { leaseToken, viewerDeviceId: a.deviceId });

    const res = await h.request(
      `/v1/internal/browser-sessions/${session.id}/runs/${runId}/events`,
      leasedInit("GET", leaseToken),
    );
    expect(res.status).toBe(200);
    const { events } = await json<{ events: Array<{ seq: number; event: RunEvent }> }>(res);
    expect(events.map((stored) => stored.event.t)).toEqual(["run.created", "control", "cmd.interrupt", "status", "control"]);
    expect(events.map((stored) => stored.seq)).toEqual([1, 2, 3, 4, 5]);

    // `since` resumes where a reader left off.
    const tail = await h.request(
      `/v1/internal/browser-sessions/${session.id}/runs/${runId}/events?since=3`,
      leasedInit("GET", leaseToken),
    );
    expect((await json<{ events: Array<{ seq: number }> }>(tail)).events.map((stored) => stored.seq)).toEqual([4, 5]);
  });

  it("refuses a run outside the session's Space, a stale lease, and an unknown session", async () => {
    const a = await cloudAccount();
    await addSpace(a, "other");
    const session = await createSession(a);
    const leaseToken = await leaseSession(session.id);
    const elsewhere = await createRun(a, undefined, "other");
    expect(
      (await h.request(
        `/v1/internal/browser-sessions/${session.id}/runs/${elsewhere}/events`,
        leasedInit("GET", leaseToken),
      )).status,
    ).toBe(404);
    expect(
      (await h.request(
        `/v1/internal/browser-sessions/${session.id}/runs/${randomUUID()}/events`,
        leasedInit("GET", "nope"),
      )).status,
    ).toBe(409);
    expect(
      (await h.request(
        `/v1/internal/browser-sessions/${randomUUID()}/runs/${elsewhere}/events`,
        leasedInit("GET", leaseToken),
      )).status,
    ).toBe(404);
  });
});
