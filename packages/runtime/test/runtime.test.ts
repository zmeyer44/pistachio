import { describe, expect, it, vi } from "vitest";
import type { RunEventInput, TaskCapsule } from "@pistachio/protocol";
import {
  HostedRunCoordinator,
  InMemoryHostedRunStore,
  InMemoryRunEventSink,
  type AuthorityRevoker,
  type DurablePause,
  type HostedRunRecord,
} from "../src/index.js";

const now = Date.parse("2026-08-24T12:00:00Z");

const TASK_ID = "7d3a9c52-6b1e-4f0a-9c1d-2e8f5a6b7c8d";

function capsule(): TaskCapsule {
  return {
    version: 1,
    id: "capsule-1",
    taskId: TASK_ID,
    sponsorId: "user-1",
    purpose: "Reconcile invoice",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30 * 60_000).toISOString(),
    policyVersion: "policy-v1",
    keyId: "key-1",
    tabs: [{ id: "tab-1", title: "Invoice", url: "https://finance.example/invoices/1" }],
    grant: {
      origins: ["https://finance.example"],
      methods: ["GET", "POST"],
      allowUploads: false,
      allowDownloads: false,
      allowClipboard: false,
      maxInteractions: 20,
    },
  };
}

function intentInput() {
  return {
    userId: "user-1",
    spaceId: "work",
    intent: "Book the usual table for Friday",
    attachments: [{ id: "att-1", name: "menu.png", mediaType: "image/png", url: "data:image/png;base64,AA==" }],
    origin: { kind: "channel" as const, linkId: "link-1", deliveryId: "d-1", channelName: "ops" },
    startUrl: "https://restaurant.example/",
  };
}

function approvalPause(id = "approval-1", expiresAt = new Date(now + 10 * 60_000).toISOString()): DurablePause {
  return {
    id,
    kind: "approval",
    requestedAt: new Date(now + 2_000).toISOString(),
    expiresAt,
    capability: "browser.submit_reconciliation",
    payload: { action: "Submit reconciliation" },
  };
}

function event(eventId: string, at = new Date(now).toISOString()): RunEventInput {
  return { eventId, at, event: { t: "status", status: "running", completedAt: null } };
}

function harness() {
  const store = new InMemoryHostedRunStore();
  const events = new InMemoryRunEventSink();
  const revoker: AuthorityRevoker = {
    destroyCapsuleKey: vi.fn().mockResolvedValue(undefined),
    cutRuntimeEgress: vi.fn().mockResolvedValue(undefined),
  };
  const coordinator = new HostedRunCoordinator(store, revoker, events);
  return { store, events, revoker, coordinator };
}

/** A run created from an intent and claimed by `worker-a`. */
async function claimedIntentRun(h: ReturnType<typeof harness>) {
  const created = await h.coordinator.create(intentInput(), now);
  const claimed = await h.coordinator.claimNext("worker-a", now + 1_000);
  if (claimed === null) throw new Error("expected a claim");
  return { created, claimed };
}

describe("hosted run coordinator", () => {
  it("persists pauses, fences workers, rechecks approval, and ends authority before completion", async () => {
    const { coordinator, revoker } = harness();
    const created = await coordinator.create({ capsule: capsule() }, now);
    const claimed = await coordinator.claimNext("worker-a", now + 1_000);
    expect(claimed?.run.id).toBe(created.id);
    expect(await coordinator.claimNext("worker-b", now + 1_000)).toBeNull();

    const pause = await coordinator.pause(created.id, claimed!.leaseToken, approvalPause(), now + 2_000);
    expect(pause.status).toBe("waiting_for_approval");
    expect((await coordinator.reattach(created.id, "user-1")).pause?.id).toBe("approval-1");

    await expect(
      coordinator.resume({
        runId: created.id,
        pauseId: "approval-1",
        sponsorId: "user-1",
        now: now + 3_000,
        isCapabilityAllowed: async () => false,
      }),
    ).rejects.toThrow("current policy");

    const resumed = await coordinator.resume({
      runId: created.id,
      pauseId: "approval-1",
      sponsorId: "user-1",
      approver: "device-phone",
      now: now + 4_000,
      isCapabilityAllowed: async () => true,
    });
    expect(resumed.status).toBe("ready");
    expect(resumed.lastApprover).toBe("device-phone");

    const reclaimed = await coordinator.claimNext("worker-b", now + 5_000);
    const completed = await coordinator.complete(created.id, reclaimed!.leaseToken, now + 6_000);
    expect(completed.status).toBe("completed");
    expect(completed.authorityEnded).toBe(true);
    expect(completed.lease).toBeNull();
    expect(revoker.destroyCapsuleKey).toHaveBeenCalledWith("capsule-1", expect.objectContaining({ id: created.id, userId: "user-1" }));
    expect(revoker.cutRuntimeEgress).toHaveBeenCalledWith(created.id, expect.objectContaining({ id: created.id, spaceId: "work" }));
  });

  it("actively revokes authority and transitions expired pauses", async () => {
    const { coordinator, revoker } = harness();
    const created = await coordinator.create({ capsule: capsule() }, now);
    const claimed = await coordinator.claimNext("run-worker", now + 1_000);
    await coordinator.pause(
      created.id,
      claimed!.leaseToken,
      approvalPause("approval-expiring", new Date(now + 3_000).toISOString()),
      now + 2_000,
    );

    expect(await coordinator.expirePauses({ workerId: "expiry-worker", now: now + 3_001 })).toBe(1);
    const expired = await coordinator.reattach(created.id, "user-1");
    expect(expired.status).toBe("revoked");
    expect(expired.pause).toBeNull();
    expect(expired.authorityEnded).toBe(true);
    expect(revoker.destroyCapsuleKey).toHaveBeenCalledWith("capsule-1", expect.objectContaining({ id: created.id }));
    expect(revoker.cutRuntimeEgress).toHaveBeenCalledWith(created.id, expect.objectContaining({ id: created.id }));
    expect(await coordinator.expirePauses({ workerId: "expiry-worker", now: now + 4_000 })).toBe(0);
  });

  describe("create", () => {
    it("fills the record from a capsule", async () => {
      const { coordinator } = harness();
      const run = await coordinator.create({ capsule: capsule(), spaceId: "finance" }, now);
      expect(run).toMatchObject<Partial<HostedRunRecord>>({
        taskId: TASK_ID,
        sponsorId: "user-1",
        userId: "user-1",
        spaceId: "finance",
        capsuleId: "capsule-1",
        purpose: "Reconcile invoice",
        intent: "Reconcile invoice",
        attachments: [],
        origin: null,
        executor: { kind: "cloud", deviceId: null, workerId: null },
        startUrl: "https://finance.example/invoices/1",
        status: "ready",
        revision: 1,
        lease: null,
        pause: null,
        authorityEnded: false,
      });
      expect(run.capsule).toEqual(capsule());
      expect((await coordinator.create({ capsule: capsule() }, now)).spaceId).toBe("work");
    });

    it("rejects an invalid capsule", async () => {
      const { coordinator } = harness();
      const expired = { ...capsule(), expiresAt: new Date(now - 1).toISOString() };
      await expect(coordinator.create({ capsule: expired }, now)).rejects.toThrow("capsule expired");
    });

    it("creates from an intent without a capsule", async () => {
      const { coordinator, store } = harness();
      const input = intentInput();
      const run = await coordinator.create(input, now);
      expect(run.capsule).toBeNull();
      expect(run.capsuleId).toBe(run.id);
      expect(run).toMatchObject<Partial<HostedRunRecord>>({
        sponsorId: "user-1",
        userId: "user-1",
        spaceId: "work",
        purpose: input.intent,
        intent: input.intent,
        attachments: input.attachments,
        origin: input.origin,
        executor: { kind: "cloud", deviceId: null, workerId: null },
        startUrl: input.startUrl,
        status: "ready",
        createdAt: new Date(now).toISOString(),
      });
      expect(run.taskId).not.toBe("");
      // The store holds its own copy: the caller's input is not shared.
      input.attachments[0]!.name = "changed";
      expect((await store.get(run.id))?.attachments[0]?.name).toBe("menu.png");
      await expect(coordinator.create({ ...intentInput(), userId: "" }, now)).rejects.toThrow("needs a user");
      await expect(coordinator.create({ ...intentInput(), spaceId: "" }, now)).rejects.toThrow("needs a space");
    });
  });

  describe("claims", () => {
    it("names the worker on the executor and takes back an expired lease", async () => {
      const h = harness();
      const { created, claimed } = await claimedIntentRun(h);
      expect(claimed.run.executor).toEqual({ kind: "cloud", deviceId: null, workerId: "worker-a" });
      expect(claimed.run.status).toBe("running");
      expect(await h.coordinator.claimNext("worker-b", now + 2_000)).toBeNull();
      await h.coordinator.heartbeat(created.id, claimed.leaseToken, now + 10_000, 30_000);
      expect(await h.coordinator.claimNext("worker-b", now + 35_000)).toBeNull();
      const reclaimed = await h.coordinator.claimNext("worker-b", now + 45_000);
      expect(reclaimed?.run.executor).toEqual({ kind: "cloud", deviceId: null, workerId: "worker-b" });
      await expect(h.coordinator.heartbeat(created.id, claimed.leaseToken, now + 46_000)).rejects.toThrow("stale run lease");
    });

    it("lists human_control runs with no live lease as claimable and keeps their status", async () => {
      const h = harness();
      const { created, claimed } = await claimedIntentRun(h);
      await h.coordinator.interrupt(created.id, claimed.leaseToken, now + 2_000);
      const human = await h.coordinator.takeControl({ runId: created.id, sponsorId: "user-1", now: now + 3_000 });
      expect(human.status).toBe("human_control");
      expect(human.lease).toBeNull();
      expect((await h.store.listClaimable(now + 3_000, 10)).map((run) => run.id)).toEqual([created.id]);
      const reclaimed = await h.coordinator.claimNext("worker-b", now + 4_000);
      expect(reclaimed?.run.status).toBe("human_control");
      expect(reclaimed?.run.lease?.workerId).toBe("worker-b");
      expect(await h.store.listClaimable(now + 4_000, 10)).toEqual([]);
    });
  });

  describe("fail", () => {
    it("revokes authority, then commits failed with the trailing events", async () => {
      const h = harness();
      const { created, claimed } = await claimedIntentRun(h);
      const failed = await h.coordinator.fail(created.id, claimed.leaseToken, "device_revoked", now + 2_000, [
        event("e-1"),
        { eventId: "e-2", at: new Date(now + 2_000).toISOString(), event: { t: "status", status: "failed", completedAt: new Date(now + 2_000).toISOString() } },
      ]);
      expect(failed.status).toBe("failed");
      expect(failed.lease).toBeNull();
      expect(failed.authorityEnded).toBe(true);
      expect(failed.completedAt).toBe(new Date(now + 2_000).toISOString());
      expect(h.revoker.destroyCapsuleKey).toHaveBeenCalledWith(created.id, expect.objectContaining({ id: created.id }));
      expect(h.revoker.cutRuntimeEgress).toHaveBeenCalledWith(created.id, expect.objectContaining({ id: created.id }));
      expect(h.events.list(created.id).map((stored) => [stored.seq, stored.eventId])).toEqual([[1, "e-1"], [2, "e-2"]]);
      expect(await h.store.listClaimable(now + 3_000, 10)).toEqual([]);
    });

    it("requires the lease and a reason", async () => {
      const h = harness();
      const { created, claimed } = await claimedIntentRun(h);
      await expect(h.coordinator.fail(created.id, "wrong-token", "boom", now + 2_000)).rejects.toThrow("stale run lease");
      await expect(h.coordinator.fail(created.id, claimed.leaseToken, "  ", now + 2_000)).rejects.toThrow("needs a reason");
      expect(h.revoker.destroyCapsuleKey).not.toHaveBeenCalled();
    });
  });

  describe("revoke", () => {
    it("ends the run regardless of a live lease and is idempotent", async () => {
      const h = harness();
      const { created, claimed } = await claimedIntentRun(h);
      const revoked = await h.coordinator.revoke({ runId: created.id, sponsorId: "user-1", now: now + 2_000 });
      expect(revoked.status).toBe("revoked");
      expect(revoked.lease).toBeNull();
      expect(revoked.authorityEnded).toBe(true);
      expect(h.revoker.destroyCapsuleKey).toHaveBeenCalledTimes(1);
      // The worker finds out on its next lease-checked call.
      await expect(h.coordinator.heartbeat(created.id, claimed.leaseToken, now + 3_000)).rejects.toThrow("stale run lease");
      const again = await h.coordinator.revoke({ runId: created.id, sponsorId: "user-1", now: now + 4_000 });
      expect(again.revision).toBe(revoked.revision);
      expect(h.revoker.destroyCapsuleKey).toHaveBeenCalledTimes(1);
    });

    it("refuses another sponsor and a run that already ended otherwise", async () => {
      const h = harness();
      const { created, claimed } = await claimedIntentRun(h);
      await expect(h.coordinator.revoke({ runId: created.id, sponsorId: "user-2" })).rejects.toThrow("does not belong");
      await h.coordinator.complete(created.id, claimed.leaseToken, now + 2_000);
      await expect(h.coordinator.revoke({ runId: created.id, sponsorId: "user-1" })).rejects.toThrow("already completed");
    });
  });

  describe("reject", () => {
    it("ends a waiting run as rejected and revokes its authority", async () => {
      const h = harness();
      const { created, claimed } = await claimedIntentRun(h);
      await h.coordinator.pause(created.id, claimed.leaseToken, approvalPause(), now + 2_000, [event("pause-1")]);
      expect(h.events.list(created.id)).toHaveLength(1);
      const rejected = await h.coordinator.reject({ runId: created.id, pauseId: "approval-1", sponsorId: "user-1", now: now + 3_000 });
      expect(rejected.status).toBe("rejected");
      expect(rejected.pause).toBeNull();
      expect(rejected.authorityEnded).toBe(true);
      expect(rejected.lastApprover).toBe("user-1");
      expect(h.revoker.cutRuntimeEgress).toHaveBeenCalledWith(created.id, expect.objectContaining({ id: created.id }));
    });

    it("refuses when the pause is not the pending one or the run is not waiting", async () => {
      const h = harness();
      const { created, claimed } = await claimedIntentRun(h);
      await expect(h.coordinator.reject({ runId: created.id, pauseId: "approval-1", sponsorId: "user-1" })).rejects.toThrow("no longer pending");
      await h.coordinator.pause(created.id, claimed.leaseToken, approvalPause(), now + 2_000);
      await expect(h.coordinator.reject({ runId: created.id, pauseId: "approval-other", sponsorId: "user-1" })).rejects.toThrow("no longer pending");
      await expect(h.coordinator.reject({ runId: created.id, pauseId: "approval-1", sponsorId: "user-2" })).rejects.toThrow("does not belong");
      expect(h.revoker.destroyCapsuleKey).not.toHaveBeenCalled();
    });
  });

  describe("control hand-off", () => {
    it("moves running to human_control with the lease kept, then back to running", async () => {
      const h = harness();
      const { created, claimed } = await claimedIntentRun(h);
      const human = await h.coordinator.takeControl({ runId: created.id, sponsorId: "user-1", now: now + 2_000 });
      expect(human.status).toBe("human_control");
      expect(human.lease?.token).toBe(claimed.leaseToken);
      await expect(h.coordinator.heartbeat(created.id, claimed.leaseToken, now + 3_000)).resolves.toBeUndefined();
      expect(await h.store.listClaimable(now + 3_000, 10)).toEqual([]);
      const back = await h.coordinator.releaseControl({ runId: created.id, sponsorId: "user-1", now: now + 4_000 });
      expect(back.status).toBe("running");
      expect(back.lease?.token).toBe(claimed.leaseToken);
      // Two revisions on from the hand-off: the heartbeat in between counts.
      expect(back.revision).toBe(human.revision + 2);
    });

    it("guards the transitions by status and sponsor", async () => {
      const h = harness();
      const { created, claimed } = await claimedIntentRun(h);
      await expect(h.coordinator.releaseControl({ runId: created.id, sponsorId: "user-1" })).rejects.toThrow("cannot release control of a running run");
      await expect(h.coordinator.takeControl({ runId: created.id, sponsorId: "user-2" })).rejects.toThrow("does not belong");
      await h.coordinator.pause(created.id, claimed.leaseToken, approvalPause(), now + 2_000);
      await expect(h.coordinator.takeControl({ runId: created.id, sponsorId: "user-1" })).rejects.toThrow("cannot take control of a waiting_for_approval run");
    });
  });

  describe("interrupt and reopen", () => {
    it("drops the lease on interrupt and returns to ready on reopen", async () => {
      const h = harness();
      const { created, claimed } = await claimedIntentRun(h);
      const interrupted = await h.coordinator.interrupt(created.id, claimed.leaseToken, now + 2_000);
      expect(interrupted.status).toBe("interrupted");
      expect(interrupted.lease).toBeNull();
      expect(interrupted.authorityEnded).toBe(false);
      // Not claimable while interrupted: the person has to reopen it.
      expect(await h.store.listClaimable(now + 3_000, 10)).toEqual([]);
      await expect(h.coordinator.interrupt(created.id, claimed.leaseToken, now + 3_000)).rejects.toThrow("stale run lease");
      await expect(h.coordinator.reopen({ runId: created.id, sponsorId: "user-2" })).rejects.toThrow("does not belong");
      const reopened = await h.coordinator.reopen({ runId: created.id, sponsorId: "user-1", now: now + 4_000 });
      expect(reopened.status).toBe("ready");
      expect(reopened.lease).toBeNull();
      const reclaimed = await h.coordinator.claimNext("worker-b", now + 5_000);
      expect(reclaimed?.run.id).toBe(created.id);
      expect(reclaimed?.run.status).toBe("running");
      await expect(h.coordinator.reopen({ runId: created.id, sponsorId: "user-1" })).rejects.toThrow("cannot reopen a running run");
    });

    it("restores runtime authority when the sponsor continues an ended run", async () => {
      const h = harness();
      const { created, claimed } = await claimedIntentRun(h);
      const completed = await h.coordinator.complete(created.id, claimed.leaseToken, now + 2_000);
      expect(completed).toMatchObject({ status: "completed", authorityEnded: true });

      const reopened = await h.coordinator.reopen({ runId: created.id, sponsorId: "user-1", now: now + 3_000 });
      expect(reopened).toMatchObject({
        id: created.id,
        status: "ready",
        completedAt: null,
        lease: null,
        pause: null,
        authorityEnded: false,
      });
      expect((await h.coordinator.claimNext("worker-b", now + 4_000))?.run.id).toBe(created.id);
    });

    it("refuses to interrupt an ended run", async () => {
      const h = harness();
      const { created, claimed } = await claimedIntentRun(h);
      await h.coordinator.complete(created.id, claimed.leaseToken, now + 2_000);
      await expect(h.coordinator.interrupt(created.id, claimed.leaseToken, now + 3_000)).rejects.toThrow("stale run lease");
    });
  });

  describe("trailing events", () => {
    it("appends pause and completion events through the sink, idempotently", async () => {
      const h = harness();
      const { created, claimed } = await claimedIntentRun(h);
      await h.coordinator.pause(created.id, claimed.leaseToken, approvalPause(), now + 2_000, [event("e-1"), event("e-2")]);
      const resumed = await h.coordinator.resume({
        runId: created.id,
        pauseId: "approval-1",
        sponsorId: "user-1",
        now: now + 3_000,
        isCapabilityAllowed: async () => true,
      });
      expect(resumed.status).toBe("ready");
      const reclaimed = await h.coordinator.claimNext("worker-b", now + 4_000);
      await h.coordinator.complete(created.id, reclaimed!.leaseToken, now + 5_000, [event("e-2"), event("e-3")]);
      expect(h.events.list(created.id).map((stored) => [stored.seq, stored.eventId])).toEqual([
        [1, "e-1"],
        [2, "e-2"],
        [3, "e-3"],
      ]);
      expect(h.events.list(created.id, 2).map((stored) => stored.eventId)).toEqual(["e-3"]);
      expect(await h.events.append(created.id, [event("e-3"), event("e-4")], { sponsorId: "user-1" })).toEqual({ seqs: [3, 4] });
    });

    it("appends nothing when a transition carries no events", async () => {
      const h = harness();
      const append = vi.spyOn(h.events, "append");
      const { created, claimed } = await claimedIntentRun(h);
      await h.coordinator.complete(created.id, claimed.leaseToken, now + 2_000);
      expect(append).not.toHaveBeenCalled();
      expect(h.events.list(created.id)).toEqual([]);
    });
  });

  describe("browser sessions (web-browser-design.md §4.1)", () => {
    it("carries the session a run was created with through every transition", async () => {
      const h = harness();
      const created = await h.coordinator.create({ ...intentInput(), sessionId: "session-1" }, now);
      expect(created.sessionId).toBe("session-1");

      const claimed = await h.coordinator.claimNext("worker-a", now + 1_000);
      expect(claimed?.run.sessionId).toBe("session-1");

      const human = await h.coordinator.takeControl({ runId: created.id, sponsorId: "user-1", now: now + 2_000 });
      expect(human.sessionId).toBe("session-1");
      const agent = await h.coordinator.releaseControl({ runId: created.id, sponsorId: "user-1", now: now + 3_000 });
      expect(agent.sessionId).toBe("session-1");

      const completed = await h.coordinator.complete(created.id, claimed!.leaseToken, now + 4_000);
      expect(completed.sessionId).toBe("session-1");
      expect((await h.store.get(created.id))?.sessionId).toBe("session-1");
    });

    it("defaults the session to null for capsule, intent and desktop runs", async () => {
      const h = harness();
      expect((await h.coordinator.create({ capsule: capsule() }, now)).sessionId).toBeNull();
      expect((await h.coordinator.create(intentInput(), now)).sessionId).toBeNull();
      const desktop = await h.coordinator.createDesktop({
        runId: "7d3a9c52-6b1e-4f0a-9c1d-2e8f5a6b7c8e",
        taskId: TASK_ID,
        userId: "user-1",
        spaceId: "work",
        intent: "Local",
        attachments: [],
        startUrl: null,
        startedAt: new Date(now).toISOString(),
      });
      expect(desktop.sessionId).toBeNull();
    });

    it("skips a run its placement predicate refuses and takes the next one", async () => {
      const h = harness();
      const held = await h.coordinator.create({ ...intentInput(), sessionId: "session-held" }, now);
      const free = await h.coordinator.create({ ...intentInput(), sessionId: null }, now + 1);

      // The oldest claimable run is the one whose session lives on another
      // worker; this worker takes the next instead of claiming and dropping it.
      const claimed = await h.coordinator.claimNext("worker-b", now + 1_000, 30_000, null, {
        eligible: (run) => run.sessionId !== "session-held",
      });
      expect(claimed?.run.id).toBe(free.id);

      // Nothing was written to the refused run: it is still claimable by the
      // worker that does hold its session.
      const stillReady = await h.store.get(held.id);
      expect(stillReady?.status).toBe("ready");
      expect(stillReady?.lease).toBeNull();
      const byHolder = await h.coordinator.claimNext("worker-a", now + 2_000, 30_000, null, {
        eligible: () => true,
      });
      expect(byHolder?.run.id).toBe(held.id);
    });

    it("answers null when the predicate refuses every claimable run", async () => {
      const h = harness();
      await h.coordinator.create({ ...intentInput(), sessionId: "session-held" }, now);
      expect(
        await h.coordinator.claimNext("worker-b", now + 1_000, 30_000, null, { eligible: () => false }),
      ).toBeNull();
    });
  });
});
