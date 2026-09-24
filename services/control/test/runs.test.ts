/**
 * Hosted runs (§7.3, §7.5, §7.8): creation gate, claim/heartbeat, seq
 * allocation and idempotency, pause/answer-resume, fail, revoke, takeControl
 * and release, SSE framing, the command long-poll, the control-summary fold,
 * and the rule that no plaintext content lands in `run_events`.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateSpaceRootSecret, wrapRootSecretToDevice } from "@pistachio/sync-protocol";
import type { HostedRunRecord } from "@pistachio/runtime";
import type { RunEvent, StoredRunEvent, ThreadListItem } from "@pistachio/protocol";
import * as schema from "../src/db/schema.js";
import { listRunEvents } from "../src/runs/events.js";
import {
  SERVICE_TOKEN,
  authed,
  desktopAccount,
  enableCloud,
  fakeRunner,
  json,
  jsonInit,
  makeHarness,
  readSse,
  serviceInit,
  settle,
  type FakeRunner,
  type Harness,
} from "./helpers.js";

const RUNNER_URL = "https://runner.example";

let h: Harness;
let runner: FakeRunner;

beforeAll(async () => {
  runner = await fakeRunner((path, init) => h.request(path, init));
  h = await makeHarness({
    runner: runner.client,
    sse: { pingMs: 50 },
    env: { CLOUD_BROWSER_PUBLIC_URL: RUNNER_URL },
  });
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

async function cloudAccount(): Promise<CloudAccount> {
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
  return { userId: account.userId, token: account.token, deviceId: account.deviceId, cloudId, keys: account.keys };
}

async function createRun(a: CloudAccount, intent = "Book the table"): Promise<string> {
  const res = await h.request("/v1/runs", jsonInit("POST", { spaceId: "work", intent, startUrl: "https://example.com/" }, a.token));
  expect(res.status).toBe(201);
  return (await json<{ runId: string }>(res)).runId;
}

interface ClaimedRun {
  run: HostedRunRecord;
  leaseToken: string;
  thread: { spaceId: string; sealed: string } | null;
}

async function claim(workerId = "worker-1", workerUrl?: string): Promise<ClaimedRun | null> {
  const res = await h.request(
    "/v1/internal/runs/claim",
    serviceInit("POST", { workerId, ...(workerUrl === undefined ? {} : { workerUrl }) }),
  );
  if (res.status === 204) return null;
  expect(res.status).toBe(200);
  return json(res);
}

async function claimRun(runId: string, workerId = "worker-1", workerUrl?: string): Promise<ClaimedRun> {
  for (let i = 0; i < 20; i += 1) {
    const claimed = await claim(workerId, workerUrl);
    if (claimed === null) break;
    if (claimed.run.id === runId) return claimed;
  }
  throw new Error(`run ${runId} was not claimable`);
}

function event(t: RunEvent, eventId: string = randomUUID()): { eventId: string; at: string; event: RunEvent } {
  return { eventId, at: new Date().toISOString(), event: t };
}

async function appendEvents(runId: string, leaseToken: string, events: ReturnType<typeof event>[]): Promise<Response> {
  return h.request(`/v1/internal/runs/${runId}/events`, serviceInit("POST", { leaseToken, events }));
}

async function storedEvents(runId: string): Promise<StoredRunEvent[]> {
  const rows = await h.db.select().from(schema.runEvents).where(eq(schema.runEvents.runId, runId)).orderBy(schema.runEvents.seq);
  return rows.map((r) => ({ seq: r.seq, eventId: r.eventId, at: r.at.toISOString(), event: r.event as RunEvent }));
}

async function summaryOf(a: CloudAccount, runId: string): Promise<ThreadListItem> {
  const out = await json<{ run: HostedRunRecord; summary: ThreadListItem }>(await h.request(`/v1/runs/${runId}`, authed(a.token)));
  return out.summary;
}

describe("POST /v1/runs", () => {
  it("refuses a space without a cloud wrapper and creates a cloud-executed run otherwise", async () => {
    const account = await desktopAccount(h);
    const notEnabled = await h.request("/v1/runs", jsonInit("POST", { spaceId: "work", intent: "x" }, account.token));
    expect(notEnabled.status).toBe(400);
    expect((await json(notEnabled))["error"]).toBe("space_not_cloud_enabled");
    expect((await h.request("/v1/runs", jsonInit("POST", { spaceId: "nope", intent: "x" }, account.token))).status).toBe(404);

    const a = await cloudAccount();
    const runId = await createRun(a, "Order flowers\nfor Friday");
    const out = await json<{ run: HostedRunRecord; summary: ThreadListItem }>(await h.request(`/v1/runs/${runId}`, authed(a.token)));
    expect(out.run).toMatchObject({
      id: runId,
      userId: a.userId,
      sponsorId: a.userId,
      spaceId: "work",
      status: "ready",
      intent: "Order flowers\nfor Friday",
      executor: { kind: "cloud", deviceId: null, workerId: null },
      startUrl: "https://example.com/",
      capsule: null,
      lease: null,
    });
    expect(out.summary).toMatchObject({ runId, title: "Order flowers", status: "ready", turns: 1, messageCount: 0, executor: { kind: "cloud" } });
    const list = await json<{ runs: ThreadListItem[] }>(await h.request("/v1/runs?spaceId=work", authed(a.token)));
    expect(list.runs.map((r) => r.runId)).toContain(runId);
    const events = await storedEvents(runId);
    expect(events).toHaveLength(1);
    expect(events[0]?.seq).toBe(1);
    expect(events[0]?.event.t).toBe("run.created");
    const other = await desktopAccount(h);
    expect((await h.request(`/v1/runs/${runId}`, authed(other.token))).status).toBe(404);
  });
});

describe("desktop conversation mirrors", () => {
  it("stores an encrypted desktop thread beside cloud runs without making it claimable", async () => {
    const account = await desktopAccount(h);
    const runId = randomUUID();
    const taskId = randomUUID();
    const startedAt = new Date().toISOString();
    const created = await h.request(
      "/v1/runs/desktop",
      jsonInit("POST", { runId, taskId, spaceId: "work", intent: "Inspect this page", startedAt }, account.token),
    );
    expect(created.status).toBe(201);
    const summary: ThreadListItem = {
      runId,
      title: "Inspect this page",
      status: "completed",
      startedAt,
      updatedAt: new Date(Date.now() + 1_000).toISOString(),
      turns: 2,
      messageCount: 3,
      executor: { kind: "desktop" },
    };
    const saved = await h.request(
      `/v1/runs/${runId}/desktop-snapshot`,
      jsonInit("PUT", { summary, completedAt: summary.updatedAt, thread: { spaceId: "work", sealed: "AQIDBA==" } }, account.token),
    );
    expect(saved.status).toBe(200);
    const detail = await json<{ run: HostedRunRecord; summary: ThreadListItem; thread: { spaceId: string; sealed: string } }>(
      await h.request(`/v1/runs/${runId}`, authed(account.token)),
    );
    expect(detail.run.executor).toEqual({ kind: "desktop" });
    expect(detail.summary).toMatchObject({ status: "completed", turns: 2, messageCount: 3, executor: { kind: "desktop" } });
    expect(detail.thread).toEqual({ spaceId: "work", sealed: "AQIDBA==" });
    expect((await storedEvents(runId)).map((entry) => entry.event.t)).toEqual(["run.created", "thread.updated"]);
    const claimable = await new (await import("../src/runs/store.js")).PostgresHostedRunStore(h.db).listClaimable(Date.now(), 1000);
    expect(claimable.some((run) => run.id === runId)).toBe(false);
  });

  it("records desktop messages and answers without steering the cloud runner", async () => {
    const account = await desktopAccount(h);
    const runId = randomUUID();
    const before = runner.steers.length;
    expect(
      (
        await h.request(
          "/v1/runs/desktop",
          jsonInit("POST", {
            runId,
            taskId: randomUUID(),
            spaceId: "work",
            intent: "Inspect this page",
            startedAt: new Date().toISOString(),
          }, account.token),
        )
      ).status,
    ).toBe(201);

    expect(
      (
        await h.request(
          `/v1/runs/${runId}/message`,
          jsonInit("POST", { text: "Use the blue option" }, account.token),
        )
      ).status,
    ).toBe(202);
    expect(
      (
        await h.request(
          `/v1/runs/${runId}/answer`,
          jsonInit("POST", { questionId: "question-1", value: "blue" }, account.token),
        )
      ).status,
    ).toBe(202);
    await h.control.idle();

    expect(runner.steers).toHaveLength(before);
    expect((await storedEvents(runId)).map((entry) => entry.event.t)).toEqual([
      "run.created",
      "cmd.message",
      "cmd.answer",
    ]);
    const answerAudit = (await h.db.select().from(schema.auditEvents)).find(
      (row) => row.kind === "run.answer" && (row.detail as { runId?: string }).runId === runId,
    );
    expect(answerAudit?.detail).toMatchObject({ via: "device" });
  });
});

describe("POST /v1/runs/:id/live-ticket", () => {
  it("mints an opaque one-use ticket, and only for a live cloud run", async () => {
    const a = await cloudAccount();
    const runId = await createRun(a);

    // Nothing is watching a run no worker has picked up: the fallback address
    // names no particular worker, and would 404 at the upgrade.
    const unclaimed = await h.request(`/v1/runs/${runId}/live-ticket`, authed(a.token, "POST"));
    expect(unclaimed.status).toBe(409);
    expect((await json(unclaimed))["error"]).toBe("not_running");

    // Claimed, the ticket points every client at the fleet's ONE public
    // address. Which worker holds the run is answered at redemption, to the
    // runner, over the private network — a client is never told.
    await claimRun(runId, "worker-7", "https://runner-7.example");
    const res = await h.request(`/v1/runs/${runId}/live-ticket`, authed(a.token, "POST"));
    expect(res.status).toBe(200);
    const issued = await json<{ url: string; ticket: string; expiresAt: string }>(res);
    expect(issued.url).toBe(RUNNER_URL);

    // Opaque, not a token: it authorises watching ONE run, once, and is not
    // a bearer for anything else. The generic device auth refuses it, which
    // is the whole reason it is not a short-lived device JWT.
    expect(issued.ticket.startsWith("plt_")).toBe(true);
    expect((await h.request(`/v1/runs/${runId}`, authed(issued.ticket))).status).toBe(401);
    expect((await h.request("/v1/me", authed(issued.ticket))).status).toBe(401);

    // Redeeming it names the viewer and the worker, and spends it.
    const redeem = async (ticket: string, run = runId): Promise<Response> =>
      h.request("/v1/internal/live-tickets/redeem", serviceInit("POST", { ticket, runId: run }));
    const spent = await redeem(issued.ticket);
    expect(spent.status).toBe(200);
    expect(await json(spent)).toMatchObject({
      userId: a.userId,
      deviceId: a.deviceId,
      platform: "macos",
      spaceId: "work",
      workerUrl: "https://runner-7.example",
    });
    expect((await redeem(issued.ticket)).status).toBe(401);

    // And a ticket is bound to its run: it does not open another of theirs.
    const second = await createRun(a, "Second");
    await claimRun(second, "worker-9", "https://runner-9.example");
    const forSecond = await json<{ ticket: string }>(
      await h.request(`/v1/runs/${second}/live-ticket`, authed(a.token, "POST")),
    );
    expect((await redeem(forSecond.ticket, runId)).status).toBe(401);

    // Someone else's run is not theirs to watch.
    const other = await desktopAccount(h);
    expect((await h.request(`/v1/runs/${runId}/live-ticket`, authed(other.token, "POST"))).status).toBe(404);

    // A worker that advertises no private address is simply not relayed to.
    const plain = await createRun(a, "Another");
    await claimRun(plain, "worker-8");
    const fallback = await json<{ ticket: string; url: string }>(
      await h.request(`/v1/runs/${plain}/live-ticket`, authed(a.token, "POST")),
    );
    expect(fallback.url).toBe(RUNNER_URL);
    expect(await json(await redeem(fallback.ticket, plain))).toMatchObject({ workerUrl: null });

    // A conversation the Mac runs has no cloud browser to show.
    const mirrored = randomUUID();
    await h.request(
      "/v1/runs/desktop",
      jsonInit(
        "POST",
        { runId: mirrored, taskId: randomUUID(), spaceId: "work", intent: "Local", startedAt: new Date().toISOString() },
        a.token,
      ),
    );
    const local = await h.request(`/v1/runs/${mirrored}/live-ticket`, authed(a.token, "POST"));
    expect(local.status).toBe(409);
    expect((await json(local))["error"]).toBe("not_a_cloud_run");

    // And the run row a device can read names the leaseholder without
    // handing over its key. (The URL is private, but it is the fleet's own
    // network, not a secret.)
    const detail = await json<{ run: HostedRunRecord }>(await h.request(`/v1/runs/${runId}`, authed(a.token)));
    expect(detail.run.lease?.workerId).toBe("worker-7");
    expect(detail.run.lease?.workerUrl).toBe("https://runner-7.example");
    expect(detail.run.lease?.token).toBe("");

    // Nor does a run that has ended.
    expect((await h.request(`/v1/runs/${runId}/revoke`, authed(a.token, "POST"))).status).toBe(202);
    const ended = await h.request(`/v1/runs/${runId}/live-ticket`, authed(a.token, "POST"));
    expect(ended.status).toBe(409);
    expect((await json(ended))["error"]).toBe("run_ended");
  });
});

describe("runner lifecycle", () => {
  it("claims with a lease naming the cloud device, heartbeats, and rejects a stale lease", async () => {
    const a = await cloudAccount();
    const runId = await createRun(a);
    const claimed = await claimRun(runId);
    expect(claimed.run.status).toBe("running");
    expect(claimed.run.lease?.workerId).toBe("worker-1");
    expect(claimed.run.executor).toEqual({ kind: "cloud", deviceId: a.cloudId, workerId: "worker-1" });
    const beat = await h.request(`/v1/internal/runs/${runId}/heartbeat`, serviceInit("POST", { leaseToken: claimed.leaseToken }));
    expect(beat.status).toBe(200);
    const stale = await h.request(`/v1/internal/runs/${runId}/heartbeat`, serviceInit("POST", { leaseToken: "nope" }));
    expect(stale.status).toBe(409);
    expect((await json(stale))["error"]).toBe("stale_lease");
    expect((await h.request(`/v1/internal/runs/${randomUUID()}/heartbeat`, serviceInit("POST", { leaseToken: "x" }))).status).toBe(404);
    // Nothing else is claimable for this worker right now beyond other tests' runs.
    expect((await appendEvents(runId, "nope", [event({ t: "turn", turns: 1 })])).status).toBe(409);
  });

  it("allocates seqs in the append transaction and is idempotent on eventId", async () => {
    const a = await cloudAccount();
    const runId = await createRun(a);
    const { leaseToken } = await claimRun(runId);
    const batch = [event({ t: "turn", turns: 1 }, "e1"), event({ t: "tool.started", toolId: "t1", name: "page.navigate", label: "Open", tabId: null }, "e2")];
    const first = await appendEvents(runId, leaseToken, batch);
    expect(first.status).toBe(200);
    const seqs = (await json<{ seqs: number[] }>(first)).seqs;
    expect(seqs).toEqual([2, 3]);
    const replay = await appendEvents(runId, leaseToken, [batch[1]!, event({ t: "tool.completed", toolId: "t1" }, "e3")]);
    expect((await json<{ seqs: number[] }>(replay)).seqs).toEqual([3, 5]);
    const stored = await storedEvents(runId);
    expect(stored.map((e) => [e.seq, e.eventId])).toEqual([[1, `run.created:${runId}`], [2, "e1"], [3, "e2"], [5, "e3"]]);
    const [row] = await h.db.select({ nextSeq: schema.hostedRuns.nextSeq }).from(schema.hostedRuns).where(eq(schema.hostedRuns.id, runId));
    expect(row?.nextSeq).toBe(6);
  });

  it("refuses oversized, command, and plaintext content events", async () => {
    const a = await cloudAccount();
    const runId = await createRun(a);
    const { leaseToken } = await claimRun(runId);
    const big = await appendEvents(runId, leaseToken, [event({ t: "reply", text: "x".repeat(70 * 1024) })]);
    expect(big.status).toBe(413);
    const cmd = await appendEvents(runId, leaseToken, [event({ t: "cmd.interrupt" })]);
    expect(cmd.status).toBe(400);
    const plaintext = await h.request(
      `/v1/internal/runs/${runId}/events`,
      serviceInit("POST", { leaseToken, events: [{ eventId: "m1", at: new Date().toISOString(), event: { t: "message", message: { id: "m", at: "", role: "assistant", content: "secret" } } }] }),
    );
    expect(plaintext.status).toBe(400);
    const detail = await h.request(
      `/v1/internal/runs/${runId}/events`,
      serviceInit("POST", { leaseToken, events: [{ eventId: "d1", at: new Date().toISOString(), event: { t: "tool.detail", toolId: "t", detail: "d", summary: "s", data: { url: "x" } } }] }),
    );
    expect(detail.status).toBe(400);
    const sealed = await appendEvents(runId, leaseToken, [event({ t: "sealed", spaceId: "work", sealed: "AQID" })]);
    expect(sealed.status).toBe(200);
    const stored = await storedEvents(runId);
    for (const e of stored) {
      const text = JSON.stringify(e.event);
      expect(text).not.toContain("secret");
      expect(text).not.toMatch(/"dataUrl"|"data"|"summary"/);
      if (e.event.t === "run.created") expect(e.event.run.messages).toEqual([]);
      else expect(text).not.toContain('"messages"');
    }
  });

  it("pauses on a judgment, resumes when the sponsor answers, and the fold tracks status", async () => {
    const a = await cloudAccount();
    const runId = await createRun(a);
    const { leaseToken } = await claimRun(runId);
    const thread = { spaceId: "work", sealed: "AQIDBA==" };
    expect((await h.request(`/v1/internal/runs/${runId}/thread`, serviceInit("PUT", { leaseToken, thread }))).status).toBe(204);
    const pause = { id: "pause-1", kind: "judgment", requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(), capability: null, payload: { questionId: "q1" } };
    const paused = await h.request(`/v1/internal/runs/${runId}/pause`, serviceInit("POST", { leaseToken, pause, events: [event({ t: "question.asked", questionId: "q1" })] }));
    expect(paused.status).toBe(200);
    expect((await json<{ run: HostedRunRecord }>(paused)).run.status).toBe("waiting_for_judgment");
    expect((await summaryOf(a, runId)).status).toBe("waiting_for_judgment");
    expect((await appendEvents(runId, leaseToken, [event({ t: "turn", turns: 2 })])).status).toBe(409);

    const answered = await h.request(`/v1/runs/${runId}/answer`, jsonInit("POST", { questionId: "q1", value: "yes" }, a.token));
    expect(answered.status).toBe(202);
    expect((await json<{ status: string }>(answered)).status).toBe("ready");
    const types = (await storedEvents(runId)).map((e) => e.event.t);
    expect(types).toEqual(expect.arrayContaining(["question.asked", "pause", "status", "cmd.answer", "resume"]));
    const reclaimed = await claimRun(runId);
    expect(reclaimed.run.status).toBe("running");
    expect(reclaimed.run.pause).toBeNull();
    expect(reclaimed.thread).toEqual(thread);
    await settle(() => runner.steers.some((s) => s.kind === "run.command" && s.runId === runId));
  });

  it("refuses a pause payload carrying anything but the runner's correlators", async () => {
    const a = await cloudAccount();
    const runId = await createRun(a);
    const { leaseToken } = await claimRun(runId);
    const base = {
      id: "p1",
      kind: "judgment" as const,
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      capability: null,
    };
    // D25: free text in the payload would land in control's plaintext store.
    const prose = { ...base, payload: { questionId: "q1", prompt: "Should I pay the $420 Acme invoice?" } };
    expect((await h.request(`/v1/internal/runs/${runId}/pause`, serviceInit("POST", { leaseToken, pause: prose }))).status).toBe(400);
    const trailing = await h.request(
      `/v1/internal/runs/${runId}/pause`,
      serviceInit("POST", { leaseToken, pause: { ...base, payload: {} }, events: [event({ t: "pause", pause: prose })] }),
    );
    expect(trailing.status).toBe(400);
    expect((await appendEvents(runId, leaseToken, [event({ t: "pause", pause: prose })])).status).toBe(400);
    expect(JSON.stringify(await storedEvents(runId))).not.toContain("Acme");

    // The shapes `services/cloud-browser/src/runs/executor.ts` actually sends.
    const shapes: Array<Record<string, unknown>> = [{}, { questionId: "q1" }, { takeoverId: "tk-1" }, { questionId: "q2", budget: true }];
    for (const payload of shapes) {
      const id = await createRun(a);
      const claimed = await claimRun(id);
      const kind = "takeoverId" in payload ? ("step_up" as const) : ("judgment" as const);
      const res = await h.request(
        `/v1/internal/runs/${id}/pause`,
        serviceInit("POST", { leaseToken: claimed.leaseToken, pause: { ...base, id: randomUUID(), kind, payload } }),
      );
      expect(res.status).toBe(200);
      expect((await json<{ run: HostedRunRecord }>(res)).run.pause?.payload).toEqual(payload);
    }
  });

  it("stores back-to-back sponsor commands when the transition leaves the revision alone", async () => {
    const a = await cloudAccount();
    const runId = await createRun(a);
    const { leaseToken } = await claimRun(runId);
    const pause = { id: "q9", kind: "judgment", requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(), capability: null, payload: {} };
    expect((await h.request(`/v1/internal/runs/${runId}/pause`, serviceInit("POST", { leaseToken, pause }))).status).toBe(200);

    const first = await h.request(`/v1/runs/${runId}/message`, jsonInit("POST", { text: "use the Visa, not the Amex" }, a.token));
    const second = await h.request(`/v1/runs/${runId}/message`, jsonInit("POST", { text: "and ship to the office" }, a.token));
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const firstSeqs = (await json<{ seqs: number[] }>(first)).seqs;
    const secondSeqs = (await json<{ seqs: number[] }>(second)).seqs;
    expect(secondSeqs[0]).not.toBe(firstSeqs[0]);

    const messages = (await storedEvents(runId)).filter((e) => e.event.t === "cmd.message");
    expect(messages.map((e) => (e.event as { text: string }).text)).toEqual(["use the Visa, not the Amex", "and ship to the office"]);
    expect((await summaryOf(a, runId)).messageCount).toBe(2);
    const polled = await json<{ events: StoredRunEvent[] }>(await h.request(`/v1/internal/runs/${runId}/commands?since=0&wait=0`, authed(SERVICE_TOKEN)));
    expect(polled.events.map((e) => e.event.t)).toEqual(["cmd.message", "cmd.message"]);
    await settle(() => runner.steers.filter((s) => s.kind === "run.command" && s.runId === runId).length === 2);
  });

  it("cuts egress at completion and restores it only after an explicit follow-up", async () => {
    const a = await cloudAccount();
    await h.request("/v1/egress/provision", authed(a.token, "POST"));
    const runId = await createRun(a);
    const { leaseToken } = await claimRun(runId);
    const path = `/v1/internal/users/${a.userId}/egress-credential?deviceId=${a.cloudId}&runId=${runId}`;
    expect((await h.request(path, authed(SERVICE_TOKEN))).status).toBe(200);
    expect((await h.request(`/v1/internal/runs/${runId}/complete`, serviceInit("POST", { leaseToken }))).status).toBe(200);
    // The completion's revoker cut the run's credentials; a credential minted
    // after it would never be cut by that path.
    expect((await h.request(path, authed(SERVICE_TOKEN))).status).toBe(404);
    const rows = await h.db.select().from(schema.egressCredentials).where(eq(schema.egressCredentials.runId, runId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revokedAt).not.toBeNull();

    const continued = await h.request(
      `/v1/runs/${runId}/message`,
      jsonInit("POST", { text: "Now compare the faster delivery option" }, a.token),
    );
    expect(await json<{ status: string }>(continued)).toMatchObject({ status: "ready" });
    const detail = await json<{ run: HostedRunRecord }>(await h.request(`/v1/runs/${runId}`, authed(a.token)));
    expect(detail.run).toMatchObject({ status: "ready", completedAt: null, authorityEnded: false });
    expect((await h.request(path, authed(SERVICE_TOKEN))).status).toBe(200);
  });

  it("stores the message that reopens an interrupted run and the next one after it", async () => {
    const a = await cloudAccount();
    const runId = await createRun(a);
    const { leaseToken } = await claimRun(runId);
    expect((await h.request(`/v1/internal/runs/${runId}/interrupt`, serviceInit("POST", { leaseToken }))).status).toBe(200);
    const reopen = await h.request(`/v1/runs/${runId}/message`, jsonInit("POST", { text: "keep going" }, a.token));
    expect((await json<{ status: string }>(reopen)).status).toBe("ready");
    expect((await h.request(`/v1/runs/${runId}/message`, jsonInit("POST", { text: "and hurry" }, a.token))).status).toBe(202);
    const messages = (await storedEvents(runId)).filter((e) => e.event.t === "cmd.message");
    expect(messages.map((e) => (e.event as { text: string }).text)).toEqual(["keep going", "and hurry"]);
  });

  it("dedupes a sponsor retry that repeats an Idempotency-Key", async () => {
    const a = await cloudAccount();
    const runId = await createRun(a);
    await claimRun(runId);
    const retry = (): Promise<Response> =>
      h.request(`/v1/runs/${runId}/message`, {
        ...jsonInit("POST", { text: "once only" }, a.token),
        headers: { "content-type": "application/json", authorization: `Bearer ${a.token}`, "idempotency-key": "retry-1" },
      });
    const firstSeqs = (await json<{ seqs: number[] }>(await retry())).seqs;
    const secondSeqs = (await json<{ seqs: number[] }>(await retry())).seqs;
    expect(secondSeqs).toEqual(firstSeqs);
    expect((await storedEvents(runId)).filter((e) => e.event.t === "cmd.message")).toHaveLength(1);
    await settle(() => runner.steers.filter((s) => s.kind === "run.command" && s.runId === runId).length === 1);
  });

  it("replays idempotent interrupt and release responses before mutating state", async () => {
    const a = await cloudAccount();
    const runId = await createRun(a);
    await claimRun(runId);
    const command = (operation: "interrupt" | "release", key: string): Promise<Response> =>
      h.request(`/v1/runs/${runId}/${operation}`, {
        method: "POST",
        headers: { authorization: `Bearer ${a.token}`, "idempotency-key": key },
      });

    const firstInterrupt = await command("interrupt", "interrupt-retry");
    const firstInterruptBody = await json(firstInterrupt);
    const retriedInterrupt = await command("interrupt", "interrupt-retry");
    expect(retriedInterrupt.status).toBe(202);
    expect(await json(retriedInterrupt)).toEqual(firstInterruptBody);

    const firstRelease = await command("release", "release-retry");
    const firstReleaseBody = await json(firstRelease);
    const retriedRelease = await command("release", "release-retry");
    expect(retriedRelease.status).toBe(202);
    expect(await json(retriedRelease)).toEqual(firstReleaseBody);

    const commands = (await storedEvents(runId)).filter(
      (event) => event.event.t === "cmd.interrupt" || event.event.t === "cmd.release",
    );
    expect(commands.map((event) => event.event.t)).toEqual(["cmd.interrupt", "cmd.release"]);
    expect(
      await h.db
        .select()
        .from(schema.runSponsorCommands)
        .where(eq(schema.runSponsorCommands.runId, runId)),
    ).toHaveLength(2);

    // The audit commits WITH the transition and its cached response. Written
    // afterwards it could be lost to a crash while the command stayed durable,
    // and the replay path would then skip it forever — leaving a state change
    // with no record of who made it. One row per command, never two.
    const audits = await h.db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.userId, a.userId));
    expect(audits.filter((row) => row.kind === "run.interrupt")).toHaveLength(1);
    expect(audits.filter((row) => row.kind === "run.release")).toHaveLength(1);
    await settle(() => runner.steers.filter((s) => s.kind === "run.command" && s.runId === runId).length === 2);
  });

  it("fails with a reason, revoking the run's egress credentials", async () => {
    const a = await cloudAccount();
    await h.request("/v1/egress/provision", authed(a.token, "POST"));
    const runId = await createRun(a);
    const { leaseToken } = await claimRun(runId);
    const cred = await h.request(`/v1/internal/users/${a.userId}/egress-credential?deviceId=${a.cloudId}&runId=${runId}`, authed(SERVICE_TOKEN));
    expect(cred.status).toBe(200);
    const { credentialId } = await json<{ credentialId: string }>(cred);
    const failed = await h.request(`/v1/internal/runs/${runId}/fail`, serviceInit("POST", { leaseToken, reason: "no_space_key", events: [event({ t: "done", ok: false })] }));
    expect(failed.status).toBe(200);
    const run = (await json<{ run: HostedRunRecord }>(failed)).run;
    expect(run.status).toBe("failed");
    expect(run.authorityEnded).toBe(true);
    expect(run.lease).toBeNull();
    const [row] = await h.db.select().from(schema.egressCredentials).where(eq(schema.egressCredentials.id, credentialId));
    expect(row?.revokedAt).not.toBeNull();
    const feed = await h.db.select().from(schema.egressRevocations).where(eq(schema.egressRevocations.credentialId, credentialId));
    expect(feed).toHaveLength(1);
    expect(h.hub.released.some((r) => r.userId === a.userId && r.deviceId === a.cloudId && r.spaceId === "work")).toBe(true);
    expect((await summaryOf(a, runId)).status).toBe("failed");
    const audits = await h.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.userId, a.userId));
    expect(audits.some((e) => e.kind === "run.failed:no_space_key")).toBe(true);
  });

  it("completes with trailing events in the same append", async () => {
    const a = await cloudAccount();
    const runId = await createRun(a);
    const { leaseToken } = await claimRun(runId);
    const done = await h.request(`/v1/internal/runs/${runId}/complete`, serviceInit("POST", { leaseToken, events: [event({ t: "reply", text: "All set." }), event({ t: "done", ok: true })] }));
    expect(done.status).toBe(200);
    const summary = await summaryOf(a, runId);
    expect(summary.status).toBe("completed");
    expect(summary.messageCount).toBe(1);
    const types = (await storedEvents(runId)).map((e) => e.event.t);
    expect(types.slice(-3)).toEqual(["reply", "done", "status"]);
    const followUp = await h.request(`/v1/runs/${runId}/message`, jsonInit("POST", { text: "more" }, a.token));
    expect(await json<{ status: string }>(followUp)).toMatchObject({ status: "ready" });
  });

  it("revoke ends the run regardless of lease, releases the cloud device's leases, and is idempotent", async () => {
    const a = await cloudAccount();
    const runId = await createRun(a);
    const { leaseToken } = await claimRun(runId);
    const revoked = await h.request(`/v1/runs/${runId}/revoke`, authed(a.token, "POST"));
    expect(revoked.status).toBe(202);
    expect((await json<{ status: string }>(revoked)).status).toBe("revoked");
    expect(h.hub.released.some((r) => r.deviceId === a.cloudId && r.spaceId === "work")).toBe(true);
    expect((await h.request(`/v1/internal/runs/${runId}/heartbeat`, serviceInit("POST", { leaseToken }))).status).toBe(409);
    const again = await h.request(`/v1/runs/${runId}/revoke`, authed(a.token, "POST"));
    expect(again.status).toBe(202);
    const types = (await storedEvents(runId)).map((e) => e.event.t);
    expect(types.filter((t) => t === "cmd.revoke")).toHaveLength(1);
    expect((await summaryOf(a, runId)).status).toBe("revoked");
    expect((await h.request(`/v1/runs/${runId}/revoke`, authed((await desktopAccount(h)).token, "POST"))).status).toBe(404);
  });

  it("treats a message during a judgment pause as the reply and resumes the run", async () => {
    const a = await cloudAccount();
    const runId = await createRun(a);
    const { leaseToken } = await claimRun(runId);
    const pause = { id: "pause-m", kind: "judgment", requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(), capability: null, payload: { questionId: "q9" } };
    expect((await h.request(`/v1/internal/runs/${runId}/pause`, serviceInit("POST", { leaseToken, pause }))).status).toBe(200);

    const replied = await h.request(`/v1/runs/${runId}/message`, jsonInit("POST", { text: "Go with the second one" }, a.token));
    expect(replied.status).toBe(202);
    expect((await json<{ status: string }>(replied)).status).toBe("ready");
    const types = (await storedEvents(runId)).map((e) => e.event.t);
    expect(types).toEqual(expect.arrayContaining(["pause", "cmd.message", "resume", "status"]));
    // Claimable again: the worker reads the message on its next turn instead
    // of the message sitting unread until the pause expired.
    const reclaimed = await claimRun(runId);
    expect(reclaimed.run.status).toBe("running");
    expect(reclaimed.run.pause).toBeNull();
  });

  it("lets the person answer the agent's takeover request, which is the only exit from that pause", async () => {
    const a = await cloudAccount();
    const runId = await createRun(a);
    const { leaseToken } = await claimRun(runId);

    // `request_takeover`: the runner parks the run and drops its lease.
    const pause = {
      id: randomUUID(),
      kind: "step_up" as const,
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      capability: null,
      payload: { takeoverId: "tk-1" },
    };
    const parked = await h.request(`/v1/internal/runs/${runId}/pause`, serviceInit("POST", { leaseToken, pause }));
    expect(parked.status).toBe(200);
    expect((await json<{ run: HostedRunRecord }>(parked)).run.status).toBe("waiting_for_step_up");

    // A message cannot be read while the run waits for the person's hands:
    // refused, rather than accepted and left unread until the pause expires.
    const unread = await h.request(`/v1/runs/${runId}/message`, jsonInit("POST", { text: "hurry up" }, a.token));
    expect(unread.status).toBe(409);
    expect(await json(unread)).toEqual({ error: "paused" });

    // `/answer` only resumes a judgment and `/release` needs human_control, so
    // taking control is the answer. Without it the run has no exit but revoke.
    const taken = await h.request(`/v1/runs/${runId}/interrupt`, authed(a.token, "POST"));
    expect(taken.status).toBe(202);
    expect((await json<{ status: string }>(taken)).status).toBe("human_control");

    // And the wheel goes back: released, a worker can claim it again, and the
    // pause the agent parked on is gone rather than blocking the next claim.
    const released = await h.request(`/v1/runs/${runId}/release`, authed(a.token, "POST"));
    expect(released.status).toBe(202);
    expect((await json<{ status: string }>(released)).status).toBe("running");
    const reclaimed = await claimRun(runId);
    expect(reclaimed.leaseToken).toBeTruthy();
    expect(reclaimed.run.pause).toBeNull();
  });

  it("treats an expiring credential URL as a bearer capability and relays its payload once", async () => {
    const a = await cloudAccount();
    const runId = await createRun(a);
    const { leaseToken } = await claimRun(runId);
    const created = await h.request(
      `/v1/internal/runs/${runId}/credential-captures`,
      serviceInit("POST", {
        leaseToken,
        tabId: "cloud:tab-1",
        siteName: "Example Accounts",
        siteOrigin: "https://accounts.example/login",
        fields: [
          { label: "Email", type: "email", target: "#email", autocomplete: "email" },
          { label: "Password", type: "password", target: "#password", autocomplete: "current-password" },
        ],
      }),
    );
    expect(created.status).toBe(201);
    const { capture } = await json<{
      capture: {
        id: string;
        siteOrigin: string;
        encryptionPublicKey: string;
        status: string;
        fields: Array<{ id: string; label: string; target?: string }>;
      };
    }>(created);
    expect(capture.siteOrigin).toBe("https://accounts.example");
    expect(capture.status).toBe("pending");
    expect(capture.fields).toHaveLength(2);
    expect(capture.fields.every((field) => field.target === undefined)).toBe(true);
    const [cloud] = await h.db.select().from(schema.devices).where(eq(schema.devices.id, a.cloudId));
    expect(capture.encryptionPublicKey).toBe(cloud?.agreementPublicKey);
    expect((await h.request(`/v1/credential-captures/${capture.id}`)).status).toBe(200);
    expect((await h.request(`/v1/credential-captures/${randomUUID()}`)).status).toBe(404);
    expect((await h.request(`/v1/credential-captures/${capture.id}/submit`)).status).toBe(401);
    expect((await h.request(`/v1/credential-captures/${capture.id}`, jsonInit("POST", {}))).status).toBe(401);

    const pause = {
      id: randomUUID(),
      kind: "step_up" as const,
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      capability: null,
      payload: { takeoverId: capture.id },
    };
    expect(
      (
        await h.request(
          `/v1/internal/runs/${runId}/pause`,
          serviceInit("POST", {
            leaseToken,
            pause,
            imessageCredentialCapture: { captureId: randomUUID() },
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await h.request(
          `/v1/internal/runs/${runId}/pause`,
          serviceInit("POST", {
            leaseToken,
            pause,
            imessageCredentialCapture: { captureId: capture.id },
          }),
        )
      ).status,
    ).toBe(200);

    const sealedPayload = "c2VjcmV0LWNpcGhlcnRleHQ=";
    const submit = () =>
      h.request(
        `/v1/credential-captures/${capture.id}/submit`,
        jsonInit("POST", { sealedPayload }),
      );
    expect((await submit()).status).toBe(202);
    expect((await submit()).status).toBe(409);

    // The URL's expiry is the submission deadline, not permission to erase a
    // ciphertext that was already accepted and is waiting for the worker.
    await h.db
      .update(schema.credentialCaptures)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(schema.credentialCaptures.id, capture.id));
    const submittedStatus = await h.request(`/v1/credential-captures/${capture.id}`);
    expect(submittedStatus.status).toBe(200);
    expect((await json<{ capture: { status: string } }>(submittedStatus)).capture.status).toBe("submitted");
    expect((await submit()).status).toBe(409);
    await h.control.runMaintenance(Date.now());
    const [retained] = await h.db
      .select({ sealedPayload: schema.credentialCaptures.sealedPayload })
      .from(schema.credentialCaptures)
      .where(eq(schema.credentialCaptures.id, capture.id));
    expect(retained?.sealedPayload).toBe(sealedPayload);

    const reclaimed = await claimRun(runId, "worker-2");
    const consumed = await h.request(
      `/v1/internal/runs/${runId}/credential-captures/${capture.id}/consume`,
      serviceInit("POST", { leaseToken: reclaimed.leaseToken }),
    );
    expect(consumed.status).toBe(200);
    expect(await json(consumed)).toMatchObject({
      sealedPayload,
      tabId: "cloud:tab-1",
      siteOrigin: "https://accounts.example",
      fields: [
        { id: capture.fields[0]?.id, target: "#email" },
        { id: capture.fields[1]?.id, target: "#password" },
      ],
    });
    expect(
      (
        await h.request(
          `/v1/internal/runs/${runId}/credential-captures/${capture.id}/consume`,
          serviceInit("POST", { leaseToken: reclaimed.leaseToken }),
        )
      ).status,
    ).toBe(409);
    const [stored] = await h.db
      .select()
      .from(schema.credentialCaptures)
      .where(eq(schema.credentialCaptures.id, capture.id));
    expect(stored?.sealedPayload).toBeNull();
    expect(stored?.consumedAt).not.toBeNull();
    const consumedStatus = await h.request(`/v1/credential-captures/${capture.id}`);
    expect(consumedStatus.status).toBe(200);
    expect((await json<{ capture: { status: string } }>(consumedStatus)).capture.status).toBe("consumed");
    expect(JSON.stringify(await storedEvents(runId))).not.toContain(sealedPayload);
    const submitAudit = (await h.db.select().from(schema.auditEvents)).find(
      (row) => row.kind === "credential_capture.submitted" &&
        (row.detail as { captureId?: string }).captureId === capture.id,
    );
    expect(submitAudit?.actorDeviceId).toBeNull();
    const pendingResponse = await h.request(
      `/v1/internal/runs/${runId}/credential-captures`,
      serviceInit("POST", {
        leaseToken: reclaimed.leaseToken,
        tabId: "cloud:tab-2",
        siteName: "Another Account",
        siteOrigin: "https://another.example/login",
        fields: [{ label: "Password", type: "password", target: "#password", autocomplete: "current-password" }],
      }),
    );
    expect(pendingResponse.status).toBe(201);
    const pending = await json<{ capture: { id: string } }>(pendingResponse);
    await h.db
      .update(schema.credentialCaptures)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(schema.credentialCaptures.id, pending.capture.id));
    expect((await h.request(`/v1/credential-captures/${pending.capture.id}`)).status).toBe(410);
    expect(h.logs.some((line) => line.includes("/credential-captures/:captureId"))).toBe(true);
    expect(h.logs.every((line) => !line.includes(capture.id))).toBe(true);
    expect(h.logs.every((line) => !line.includes(pending.capture.id))).toBe(true);
  });

  it("interrupt takes control (lease kept), release hands it back, runner interrupt + message reopens", async () => {
    const a = await cloudAccount();
    const runId = await createRun(a);
    const { leaseToken } = await claimRun(runId);
    const taken = await h.request(`/v1/runs/${runId}/interrupt`, authed(a.token, "POST"));
    expect(taken.status).toBe(202);
    expect((await json<{ status: string }>(taken)).status).toBe("human_control");
    expect((await h.request(`/v1/internal/runs/${runId}/heartbeat`, serviceInit("POST", { leaseToken }))).status).toBe(200);
    expect((await h.request(`/v1/runs/${runId}/interrupt`, authed(a.token, "POST"))).status).toBe(409);
    const released = await h.request(`/v1/runs/${runId}/release`, authed(a.token, "POST"));
    expect((await json<{ status: string }>(released)).status).toBe("running");
    expect((await h.request(`/v1/runs/${runId}/release`, authed(a.token, "POST"))).status).toBe(409);
    const stopped = await h.request(`/v1/internal/runs/${runId}/interrupt`, serviceInit("POST", { leaseToken }));
    expect(stopped.status).toBe(200);
    expect((await json<{ run: HostedRunRecord }>(stopped)).run.status).toBe("interrupted");
    const message = await h.request(`/v1/runs/${runId}/message`, jsonInit("POST", { text: "keep going" }, a.token));
    expect(message.status).toBe(202);
    expect((await json<{ status: string }>(message)).status).toBe("ready");
    const summary = await summaryOf(a, runId);
    expect(summary.status).toBe("ready");
    expect(summary.turns).toBe(2);
    expect(summary.messageCount).toBe(1);
    const reclaimed = await claimRun(runId);
    expect(reclaimed.run.status).toBe("running");
    const types = (await storedEvents(runId)).map((e) => e.event.t);
    expect(types).toEqual(expect.arrayContaining(["cmd.interrupt", "control", "cmd.release", "cmd.message"]));
  });

  it("stores the sealed thread under the lease and caps its size", async () => {
    const a = await cloudAccount();
    const runId = await createRun(a);
    const { leaseToken } = await claimRun(runId);
    const put = await h.request(`/v1/internal/runs/${runId}/thread`, serviceInit("PUT", { leaseToken, thread: { spaceId: "work", sealed: "AQIDBA==" } }));
    expect(put.status).toBe(204);
    const [row] = await h.db.select({ thread: schema.hostedRuns.thread }).from(schema.hostedRuns).where(eq(schema.hostedRuns.id, runId));
    expect(row?.thread).toEqual({ spaceId: "work", sealed: "AQIDBA==" });
    expect((await h.request(`/v1/internal/runs/${runId}/thread`, serviceInit("PUT", { leaseToken: "nope", thread: { spaceId: "work", sealed: "AQ==" } }))).status).toBe(409);
    const huge = await h.request(`/v1/internal/runs/${runId}/thread`, serviceInit("PUT", { leaseToken, thread: { spaceId: "work", sealed: "A".repeat(2 * 1024 * 1024 + 1) } }));
    expect(huge.status).toBe(413);
  });
});

describe("streams", () => {
  it("SSE frames every event with id/event/data, pings, and ends on a terminal status", async () => {
    const a = await cloudAccount();
    const runId = await createRun(a);
    const { leaseToken } = await claimRun(runId);
    await appendEvents(runId, leaseToken, [event({ t: "turn", turns: 1 }, "t1")]);
    const res = await h.request(`/v1/runs/${runId}/events?since=1`, authed(a.token));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const first = await readSse(res, (t) => t.includes("id: 2\n") && t.includes(": ping"));
    expect(first).toMatch(/^id: 2\nevent: run\ndata: \{.*"seq":2.*\}\n\n/);
    expect(first).not.toContain("id: 1\n");
    expect(first).toContain(": ping\n\n");

    const live = await h.request(`/v1/runs/${runId}/events`, { headers: { authorization: `Bearer ${a.token}`, "last-event-id": "2" } });
    const reading = readSse(live, (t) => t.includes("event: end"));
    await h.request(`/v1/internal/runs/${runId}/complete`, serviceInit("POST", { leaseToken, events: [event({ t: "done", ok: true }, "d1")] }));
    const text = await reading;
    expect(text).not.toContain("id: 2\n");
    expect(text).toContain('"eventId":"d1"');
    expect(text).toMatch(/event: end\ndata: \{"status":"completed"\}\n\n$/);
    expect((await h.request(`/v1/runs/${runId}/events`, authed((await desktopAccount(h)).token))).status).toBe(404);
  });

  it("long-polls commands: immediate when pending, empty after wait, woken by a sponsor command", async () => {
    const a = await cloudAccount();
    const runId = await createRun(a);
    await claimRun(runId);
    const empty = await json<{ events: unknown[]; since: number }>(await h.request(`/v1/internal/runs/${runId}/commands?since=0&wait=0`, authed(SERVICE_TOKEN)));
    expect(empty.events).toEqual([]);
    expect(empty.since).toBe((await storedEvents(runId)).at(-1)?.seq);
    const waiting = h.request(`/v1/internal/runs/${runId}/commands?since=0&wait=10`, authed(SERVICE_TOKEN));
    const started = Date.now();
    await new Promise((r) => setTimeout(r, 20));
    await h.request(`/v1/runs/${runId}/message`, jsonInit("POST", { text: "hurry" }, a.token));
    const woken = await json<{ events: StoredRunEvent[]; since: number }>(await waiting);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(woken.events).toHaveLength(1);
    expect(woken.events[0]?.event).toEqual({ t: "cmd.message", text: "hurry", attachments: [] });
    expect(woken.since).toBe(woken.events[0]?.seq);
    const again = await json<{ events: StoredRunEvent[] }>(await h.request(`/v1/internal/runs/${runId}/commands?since=${String(woken.since)}&wait=0`, authed(SERVICE_TOKEN)));
    expect(again.events).toEqual([]);
    const pending = await json<{ events: StoredRunEvent[] }>(await h.request(`/v1/internal/runs/${runId}/commands?since=0&wait=5`, authed(SERVICE_TOKEN)));
    expect(pending.events.map((e) => e.event.t)).toEqual(["cmd.message"]);
    expect((await h.request(`/v1/internal/runs/${randomUUID()}/commands?wait=0`, authed(SERVICE_TOKEN))).status).toBe(404);
  });

  it("advances the command cursor past non-commands and filters commands before the row limit", async () => {
    const a = await cloudAccount();
    const runId = await createRun(a);
    const { leaseToken } = await claimRun(runId);
    await appendEvents(runId, leaseToken, [event({ t: "turn", turns: 2 }), event({ t: "turn", turns: 3 })]);
    const head = (await storedEvents(runId)).at(-1)?.seq;
    const idle = await json<{ events: StoredRunEvent[]; since: number }>(await h.request(`/v1/internal/runs/${runId}/commands?since=0&wait=0`, authed(SERVICE_TOKEN)));
    expect(idle.events).toEqual([]);
    expect(idle.since).toBe(head);

    expect((await h.request(`/v1/runs/${runId}/message`, jsonInit("POST", { text: "hurry" }, a.token))).status).toBe(202);
    const paged = await listRunEvents(h.db, runId, 0, { commandsOnly: true, limit: 1 });
    expect(paged.map((e) => e.event.t)).toEqual(["cmd.message"]);
  });
});

describe("maintenance", () => {
  it("expires sessions and retires run events 30 days after completion", async () => {
    const a = await cloudAccount();
    const runId = await createRun(a);
    const { leaseToken } = await claimRun(runId);
    await h.request(`/v1/internal/runs/${runId}/thread`, serviceInit("PUT", { leaseToken, thread: { spaceId: "work", sealed: "AQ==" } }));
    await h.request(`/v1/internal/runs/${runId}/complete`, serviceInit("POST", { leaseToken }));
    await h.db.insert(schema.authSessions).values({ id: randomUUID(), userId: a.userId, token: randomUUID(), expiresAt: new Date(Date.now() - 1000) });
    const soon = await h.control.runMaintenance(Date.now());
    expect(soon.expiredSessions).toBeGreaterThanOrEqual(1);
    expect((await storedEvents(runId)).length).toBeGreaterThan(0);
    const later = await h.control.runMaintenance(Date.now() + 31 * 86_400_000);
    expect(later.retiredRuns).toBeGreaterThanOrEqual(1);
    expect(await storedEvents(runId)).toEqual([]);
    const [row] = await h.db.select({ thread: schema.hostedRuns.thread, summary: schema.hostedRuns.summary }).from(schema.hostedRuns).where(eq(schema.hostedRuns.id, runId));
    expect(row?.thread).toBeNull();
    expect(row?.summary?.status).toBe("completed");
  });
  it("sweeps a pause whose deadline passed, so an abandoned run cannot sit un-revoked forever", async () => {
    const a = await cloudAccount();
    const runId = await createRun(a);
    const { leaseToken } = await claimRun(runId);
    const pause = {
      id: randomUUID(),
      kind: "judgment" as const,
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      capability: null,
      payload: {},
    };
    expect((await h.request(`/v1/internal/runs/${runId}/pause`, serviceInit("POST", { leaseToken, pause }))).status).toBe(200);

    // Before the deadline the run is left alone.
    expect((await h.control.runMaintenance(Date.now())).expiredPauses).toBe(0);

    // Past it, nothing else in the system would ever move this run: resume
    // throws, no worker can claim it, and its authority is never cut.
    const swept = await h.control.runMaintenance(Date.now() + 120_000);
    expect(swept.expiredPauses).toBe(1);
    const [row] = await h.db
      .select({ status: schema.hostedRuns.status })
      .from(schema.hostedRuns)
      .where(eq(schema.hostedRuns.id, runId));
    expect(row?.status).toBe("revoked");
  });
});

describe("runs attached to a browser session (web-browser-design.md §4.3)", () => {
  async function openSession(a: CloudAccount): Promise<string> {
    const res = await h.request("/v1/browser-sessions", jsonInit("POST", { spaceId: "work" }, a.token));
    expect(res.status).toBe(201);
    return (await json<{ session: { id: string } }>(res)).session.id;
  }

  it("carries `sessionId` on the record, on GET /runs/:id, and on the claim", async () => {
    const a = await cloudAccount();
    const sessionId = await openSession(a);
    const res = await h.request("/v1/runs", jsonInit("POST", { spaceId: "work", intent: "In the session", sessionId }, a.token));
    expect(res.status).toBe(201);
    const runId = (await json<{ runId: string }>(res)).runId;

    const read = await h.request(`/v1/runs/${runId}`, authed(a.token));
    expect((await json<{ run: HostedRunRecord }>(read)).run.sessionId).toBe(sessionId);

    const claimed = await claimRun(runId, "worker-session");
    expect(claimed.run.sessionId).toBe(sessionId);
    // The claim also carries the session lease, so the worker can heartbeat
    // the session it just took with the run.
    expect((claimed as unknown as { session?: { id: string; leaseToken: string; generation: number } }).session).toEqual({
      id: sessionId,
      generation: 1,
      leaseToken: expect.any(String),
    });
  });

  it("leaves `sessionId` null for a run created without one", async () => {
    const a = await cloudAccount();
    const runId = await createRun(a);
    const read = await h.request(`/v1/runs/${runId}`, authed(a.token));
    expect((await json<{ run: HostedRunRecord }>(read)).run.sessionId).toBeNull();
    const claimed = await claimRun(runId, "worker-plain");
    expect(claimed.run.sessionId).toBeNull();
    expect((claimed as unknown as { session?: unknown }).session).toBeUndefined();
  });

  it("refuses an unknown session and a session in another Space", async () => {
    const a = await cloudAccount();
    const sessionId = await openSession(a);
    const unknown = await h.request(
      "/v1/runs",
      jsonInit("POST", { spaceId: "work", intent: "x", sessionId: randomUUID() }, a.token),
    );
    expect(unknown.status).toBe(404);
    expect(await json(unknown)).toEqual({ error: "session_not_found" });

    // A second cloud-enabled Space, so the mismatch is the only refusal left.
    expect((await h.request("/v1/spaces/away", jsonInit("PUT", { name: "Away" }, a.token))).status).toBeLessThan(300);
    expect((await h.request("/v1/cloud/enable", jsonInit("POST", { spaceId: "away" }, a.token))).status).toBe(200);
    const identity = runner.identities.get(a.userId);
    if (!identity) throw new Error("no identity");
    const wrapper = await wrapRootSecretToDevice(
      generateSpaceRootSecret(),
      "away",
      { deviceId: a.cloudId, agreementPublicKeyRaw: identity.agreementPublicKeyRaw },
      { deviceId: a.deviceId, signingKey: a.keys.signing.privateKey },
    );
    expect(
      (
        await h.request(
          "/v1/spaces/away/wrappers",
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
        )
      ).status,
    ).toBe(200);

    const mismatch = await h.request(
      "/v1/runs",
      jsonInit("POST", { spaceId: "away", intent: "x", sessionId }, a.token),
    );
    expect(mismatch.status).toBe(409);
    expect(await json(mismatch)).toEqual({ error: "session_space_mismatch" });
  });
});
