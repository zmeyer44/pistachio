/**
 * Deferred lane (cloud-sync-design §3): a desktop parks writes behind a
 * cloud run's exclusive lease instead of forcing a takeover, and drains them
 * only on `leaseReleased` / `leaseRevoked` for that origin, `setOnline(true)`,
 * or the host's `retryDeferred()`.
 */

import { describe, expect, it } from "vitest";
import { makeVersionToken, ORIGIN_LEASE_TTL_MS } from "@pistachio/sync-protocol";
import { DeviceRegistryVerifier, type LeaseDenial } from "../src/index.js";
import {
  attrsFor,
  CLOUD_HOLDER,
  createEngine,
  makeIdentity,
  ManualClock,
  must,
  settle,
  testKeypair,
} from "./helpers.js";

const rotating = (spaceId: string): ReturnType<typeof makeIdentity> =>
  makeIdentity(spaceId, "cloudflare.com", "session");
const plain = (spaceId: string): ReturnType<typeof makeIdentity> =>
  makeIdentity(spaceId, "github.com", "sid");
const deferToCloud = {
  deferToForeignLease: (denial: LeaseDenial): boolean =>
    denial.holderKind === "cloud",
};

describe("deferred lane", () => {
  it("parks a rotating-auth write behind a cloud holder and drains it on leaseReleased", async () => {
    const spaceId = "space-deferred-release";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock, deferToCloud);
    a.transport.leaseGranted = false;
    a.transport.denial = CLOUD_HOLDER;

    clock.tick(1);
    const w = must(
      await a.engine.localChange(rotating(spaceId), attrsFor("v0"), false, "explicit"),
    );
    expect(a.transport.published).toHaveLength(0);
    expect(a.transport.leaseCalls).toEqual([
      { spaceId, originId: w.originId, force: undefined },
    ]);
    expect(a.engine.deferredDepth).toBe(1);
    expect(a.engine.queueDepth).toBe(0);

    // The default lane's drain never touches the deferred lane.
    await a.engine.flushPending();
    expect(a.engine.deferredDepth).toBe(1);

    // Still held: a retry re-parks without publishing and never forces.
    await a.engine.retryDeferred();
    expect(a.transport.published).toHaveLength(0);
    expect(a.engine.deferredDepth).toBe(1);
    expect(a.transport.leaseCalls.every((call) => call.force === undefined)).toBe(true);

    // The run ends: the hub broadcasts lease.released for the origin.
    a.transport.leaseGranted = true;
    a.engine.leaseReleased(w.originId);
    await a.engine.retryDeferred(); // chained after the release-triggered drain
    expect(a.transport.published.map((r) => r.hlc)).toEqual([w.hlc]);
    expect(a.engine.deferredDepth).toBe(0);
  });

  it("leaseReleased for another origin leaves the lane alone; a release of our own grant makes the next write re-acquire", async () => {
    const spaceId = "space-deferred-other-origin";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock, deferToCloud);
    a.transport.leaseGranted = false;
    a.transport.denial = CLOUD_HOLDER;
    clock.tick(1);
    const w = must(
      await a.engine.localChange(rotating(spaceId), attrsFor("v0"), false, "explicit"),
    );
    a.transport.leaseGranted = true;
    a.engine.leaseReleased("f".repeat(64));
    await a.engine.retryDeferred("f".repeat(64));
    expect(a.transport.published).toHaveLength(0);
    expect(a.engine.deferredDepth).toBe(1);

    // Our own grant: released by the hub (e.g. after a reconnect) → re-acquire.
    const b = await createEngine(spaceId, "dev-b", clock);
    clock.tick(1);
    must(
      await b.engine.localChange(rotating(spaceId), attrsFor("v0"), false, "explicit"),
    );
    expect(b.transport.leaseCalls).toHaveLength(1);
    b.engine.leaseReleased(w.originId);
    clock.tick(1);
    must(
      await b.engine.localChange(rotating(spaceId), attrsFor("v1"), false, "overwrite"),
    );
    expect(b.transport.leaseCalls).toHaveLength(2);
  });

  it("defers after an exclusive_lease ack names a cloud holder, then re-parks a drained record on another ack without re-acquiring", async () => {
    const spaceId = "space-deferred-exclusive-ack";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock, deferToCloud);
    a.transport.denial = CLOUD_HOLDER;

    // github.com needs no lease on a desktop: published directly, then the
    // hub rejects it under the cloud run's exclusive lease.
    clock.tick(1);
    const w = must(
      await a.engine.localChange(plain(spaceId), attrsFor("v0"), false, "explicit"),
    );
    expect(a.transport.published).toHaveLength(1);
    expect(a.transport.leaseCalls).toHaveLength(0);

    a.transport.leaseResults.push(false);
    await a.engine.publishRejected(w.recordId, "exclusive_lease");
    expect(a.transport.leaseCalls).toEqual([
      { spaceId, originId: w.originId, force: undefined },
    ]);
    expect(a.engine.deferredDepth).toBe(1);
    expect(a.engine.queueDepth).toBe(0);
    expect(a.transport.published).toHaveLength(1);

    a.engine.leaseReleased(w.originId);
    await a.engine.retryDeferred();
    expect(a.transport.published).toHaveLength(2);
    expect(a.engine.deferredDepth).toBe(0);

    // The cloud device re-took the origin between our drain and the ack:
    // re-park the record without another acquire round trip.
    await a.engine.publishRejected(w.recordId, "exclusive_lease");
    expect(a.transport.leaseCalls).toHaveLength(1);
    expect(a.engine.deferredDepth).toBe(1);
    expect(a.transport.published).toHaveLength(2);
  });

  it("parks on timeout / offline lease outcomes instead of forcing an unknown holder", async () => {
    const spaceId = "space-deferred-timeout";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);
    a.transport.leaseResults.push(false);
    clock.tick(1);
    const w = must(
      await a.engine.localChange(rotating(spaceId), attrsFor("v0"), false, "explicit"),
    );
    expect(a.transport.published).toHaveLength(1);

    a.transport.leaseResults.push({ granted: false, reason: "timeout" });
    await a.engine.publishRejected(w.recordId, "lease_required");
    expect(a.transport.leaseCalls.map((call) => call.force)).toEqual([
      undefined,
      undefined,
    ]);
    expect(a.engine.deferredDepth).toBe(1);
    expect(a.engine.queueDepth).toBe(0);
    expect(a.transport.published).toHaveLength(1);

    a.engine.leaseReleased(w.originId);
    a.transport.leaseResults.push({ granted: false, reason: "offline" });
    await a.engine.retryDeferred();
    // Dispatch publishes optimistically on an unknown outcome (the hub
    // decides), never with force.
    expect(a.transport.leaseCalls.every((call) => call.force === undefined)).toBe(true);
    a.transport.leaseResults.push({ granted: false, reason: "offline" });
    await a.engine.publishRejected(w.recordId, "lease_required");
    expect(a.engine.deferredDepth).toBe(1);
  });

  it("a desktop holder still goes through the forced-takeover path", async () => {
    const spaceId = "space-deferred-desktop-holder";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock, deferToCloud);
    a.transport.leaseGranted = false; // denied by DESKTOP_HOLDER
    clock.tick(1);
    const w = must(
      await a.engine.localChange(rotating(spaceId), attrsFor("v0"), false, "explicit"),
    );
    expect(a.transport.published).toHaveLength(1);
    a.transport.leaseResults.push(false, true);
    await a.engine.publishRejected(w.recordId, "lease_required");
    expect(a.transport.leaseCalls.map((call) => call.force)).toEqual([
      undefined,
      undefined,
      true,
    ]);
    expect(a.engine.deferredDepth).toBe(0);
    expect(a.transport.published).toHaveLength(2);
  });

  it("drops a drained record whose current winner is a remote version or a deletion", async () => {
    const spaceId = "space-deferred-drop";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock, deferToCloud);
    const b = await createEngine(spaceId, "dev-b", clock);
    a.transport.leaseGranted = false;
    a.transport.denial = CLOUD_HOLDER;

    clock.tick(1);
    const w = must(
      await a.engine.localChange(rotating(spaceId), attrsFor("v0"), false, "explicit"),
    );
    expect(a.engine.deferredDepth).toBe(1);
    clock.tick(1);
    const remote = must(
      await b.engine.localChange(rotating(spaceId), attrsFor("cloud"), false, "explicit"),
    );
    expect(await a.engine.applyRemote([remote])).toEqual(["applied"]);

    a.transport.leaseGranted = true;
    a.engine.leaseReleased(w.originId);
    await a.engine.retryDeferred();
    expect(a.transport.published).toHaveLength(0);
    expect(a.engine.deferredDepth).toBe(0);

    // Deferred write superseded by a local deletion: dropped as well.
    a.transport.leaseGranted = false;
    clock.tick(1);
    const w2 = must(
      await a.engine.localChange(rotating(spaceId), attrsFor("v2"), false, "overwrite"),
    );
    expect(a.engine.deferredDepth).toBe(1);
    clock.tick(1);
    const del = must(
      await a.engine.localChange(rotating(spaceId), null, true, "explicit"),
    );
    expect(del.cause).toBe("EXPIRED"); // passive device: writer-scoped demotion
    a.transport.leaseGranted = true;
    a.engine.leaseReleased(w2.originId);
    await a.engine.retryDeferred();
    expect(a.transport.published).toHaveLength(0);
    expect(a.engine.deferredDepth).toBe(0);
  });

  it("setOnline(true) and leaseRevoked drain the lane", async () => {
    const spaceId = "space-deferred-online";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock, deferToCloud);
    a.transport.leaseGranted = false;
    a.transport.denial = CLOUD_HOLDER;
    clock.tick(1);
    const w = must(
      await a.engine.localChange(rotating(spaceId), attrsFor("v0"), false, "explicit"),
    );
    expect(a.engine.deferredDepth).toBe(1);

    a.engine.setOnline(false);
    a.transport.leaseGranted = true;
    a.engine.setOnline(true);
    await settle(() => a.transport.published.length === 1);
    expect(a.transport.published[0]?.hlc).toEqual(w.hlc);
    expect(a.engine.deferredDepth).toBe(0);

    // Past the cached grant window the cloud device holds the origin again.
    a.transport.leaseGranted = false;
    clock.tick(ORIGIN_LEASE_TTL_MS / 2 + 1);
    const w2 = must(
      await a.engine.localChange(rotating(spaceId), attrsFor("v1"), false, "overwrite"),
    );
    expect(a.engine.deferredDepth).toBe(1);
    a.transport.leaseGranted = true;
    a.engine.leaseRevoked(w2.originId);
    await a.engine.retryDeferred();
    expect(a.transport.published).toHaveLength(2);
    expect(a.transport.published[1]?.hlc).toEqual(w2.hlc);
  });

  it("a version the hub refused never stays a legal wire parent, even when the next version was built before the ack", async () => {
    // The desktop's capture chain and its rejection queue are separate
    // promise chains, so a cookie can rotate inside the publish round trip:
    // v2 is built (and sent) naming v1 while v1's ack is still in flight. If
    // the rejection does not un-publish v1, every later version keeps naming
    // a token the hub never stored and the peer holding the logout fence
    // blocks the whole chain.
    const spaceId = "space-rejected-parent";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock, deferToCloud);
    a.transport.denial = CLOUD_HOLDER;
    const verifier = new DeviceRegistryVerifier("reject");
    verifier.addDevice("dev-a", (await testKeypair()).publicKey);
    const p = await createEngine(spaceId, "dev-p", clock, { verifier });
    const identity = plain(spaceId);

    clock.tick(1);
    const v0 = must(
      await a.engine.localChange(identity, attrsFor("v0"), false, "explicit"),
    );
    expect(await p.engine.applyRemote([v0])).toEqual(["applied"]);
    clock.tick(1);
    const logout = must(await a.engine.localChange(identity, null, true, "explicit"));
    expect(await p.engine.applyRemote([logout])).toEqual(["applied"]);

    // A cloud run holds the origin. The login publishes optimistically and
    // the hub refuses it, but the site rotates the cookie before that ack
    // lands, so v2 is built and sent on top of the refused version.
    clock.tick(1);
    const v1 = must(
      await a.engine.localChange(identity, attrsFor("login"), false, "explicit"),
    );
    clock.tick(1);
    const v2 = must(
      await a.engine.localChange(identity, attrsFor("rotated"), false, "overwrite"),
    );
    expect(v2.causalParent).toBe(makeVersionToken(v1.recordId, v1.hlc));
    expect(a.transport.published).toHaveLength(4); // v0, logout, v1, v2

    // Only now does v1's rejection arrive.
    a.transport.leaseResults.push(false);
    await a.engine.publishRejected(v1.recordId, "exclusive_lease");
    expect(a.engine.deferredDepth).toBe(1);

    a.engine.leaseReleased(v2.originId);
    await a.engine.retryDeferred();
    const drained = must(a.transport.published.at(-1));
    expect(drained.hlc).toEqual(v2.hlc);
    // The refused v1 is skipped; the fence the hub does hold is named.
    expect(drained.causalParent).toBe(makeVersionToken(logout.recordId, logout.hlc));
    expect(await p.engine.applyRemote([drained])).toEqual(["applied"]);
    expect(p.engine.listLiveCookies().map((c) => c.attributes?.value)).toEqual([
      "rotated",
    ]);
  });

  it("a drained deferred wire never names an unpublished ancestor and still verifies", async () => {
    const spaceId = "space-deferred-relink";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock, deferToCloud);
    a.transport.denial = CLOUD_HOLDER;
    const verifier = new DeviceRegistryVerifier("reject");
    verifier.addDevice("dev-a", (await testKeypair()).publicKey);
    const p = await createEngine(spaceId, "dev-p", clock, { verifier });
    const identity = plain(spaceId);

    clock.tick(1);
    const v0 = must(
      await a.engine.localChange(identity, attrsFor("v0"), false, "explicit"),
    );
    expect(await p.engine.applyRemote([v0])).toEqual(["applied"]);
    clock.tick(1);
    const d1 = must(await a.engine.localChange(identity, null, true, "explicit"));
    expect(await p.engine.applyRemote([d1])).toEqual(["applied"]);

    // A cloud run takes the origin. Login + rotation both bounce off the hub
    // and land in the deferred lane (compacted to the newest).
    clock.tick(1);
    const w1 = must(
      await a.engine.localChange(identity, attrsFor("login"), false, "explicit"),
    );
    a.transport.leaseResults.push(false);
    await a.engine.publishRejected(w1.recordId, "exclusive_lease");
    clock.tick(1);
    const w2 = must(
      await a.engine.localChange(identity, attrsFor("rotated"), false, "overwrite"),
    );
    a.transport.leaseResults.push(false);
    await a.engine.publishRejected(w2.recordId, "exclusive_lease");
    expect(a.engine.deferredDepth).toBe(1);

    a.engine.leaseReleased(w2.originId);
    await a.engine.retryDeferred();
    const drained = must(a.transport.published.at(-1));
    expect(drained.hlc).toEqual(w2.hlc);
    expect(drained.causalParent).toBe(makeVersionToken(d1.recordId, d1.hlc));
    expect(must(a.engine.getRecord(w2.recordId)).wire).toEqual(drained);
    expect(await p.engine.applyRemote([drained])).toEqual(["applied"]);
    expect(p.engine.listLiveCookies().map((c) => c.attributes?.value)).toEqual([
      "rotated",
    ]);
  });
});
