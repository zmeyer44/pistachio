/**
 * Regression tests for the adversarial-review findings against PRD §8.3/§9.
 * Each describe block cites the confirmed finding it pins down.
 */

import { describe, expect, it, vi } from "vitest";
import {
  compareHlc,
  computeOriginIdHex,
  computeRecordIdHex,
  encodeCookiePlain,
  generateDeviceKeypair,
  makeVersionToken,
  recordSealAad,
  seal,
  signRecord,
  toBase64,
  type CookieIdentity,
  type CookiePlain,
  type CookieRecordWire,
  type SignableRecordFields,
} from "@pistachio/sync-protocol";
import {
  DeviceRegistryVerifier,
  MemoryQueueStorage,
  SpaceSyncEngine,
  type LeaseOutcome,
  type SyncTransport,
} from "../src/index.js";
import {
  attrsFor,
  CollectingTransport,
  createEngine,
  makeIdentity,
  ManualClock,
  must,
  settle,
  testKeypair,
  testSpaceKeys,
} from "./helpers.js";

describe("finding: late explicit delete vs a chain that descends from it", () => {
  it("an older delete loses to a live write whose ancestry passes through it", async () => {
    const spaceId = "space-late-delete";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);
    const b = await createEngine(spaceId, "dev-b", clock);
    const c = await createEngine(spaceId, "dev-c", clock);
    const identity = makeIdentity(spaceId, "github.com", "sid");

    clock.tick(1);
    const w0 = must(await a.engine.localChange(identity, attrsFor("v0"), false, "explicit"));
    for (const replica of [b, c]) expect(await replica.engine.applyRemote([w0])).toEqual(["applied"]);

    clock.tick(1);
    const d1 = must(await a.engine.localChange(identity, null, true, "explicit"));
    expect(await c.engine.applyRemote([d1])).toEqual(["applied"]);

    // C re-logs-in (chain descends from the delete), then the session rotates.
    clock.tick(1);
    const w1 = must(await c.engine.localChange(identity, attrsFor("relogin"), false, "explicit"));
    expect(w1.causalParent).toBe(makeVersionToken(d1.recordId, d1.hlc));
    clock.tick(1);
    const w2 = must(await c.engine.localChange(identity, attrsFor("rotated"), false, "explicit"));

    // B sees the live chain FIRST, the delete LAST (reordered delivery).
    expect(await b.engine.applyRemote([w1])).toEqual(["applied"]);
    expect(await b.engine.applyRemote([w2])).toEqual(["applied"]);
    expect(await b.engine.applyRemote([d1])).toEqual(["stale"]);
    expect(b.engine.listLiveCookies().map((p) => p.attributes?.value)).toEqual(["rotated"]);

    // A receives the chain in order and converges to the same state.
    expect(await a.engine.applyRemote([w1, w2])).toEqual(["applied", "applied"]);
    expect(a.engine.listLiveCookies().map((p) => p.attributes?.value)).toEqual(["rotated"]);
  });

  it("a blocked write is parked and applied once its ancestry becomes provable", async () => {
    const spaceId = "space-parked";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);
    const d = await createEngine(spaceId, "dev-d", clock);
    const identity = makeIdentity(spaceId, "github.com", "sid");

    clock.tick(1);
    const w0 = must(await a.engine.localChange(identity, attrsFor("v0"), false, "explicit"));
    clock.tick(1);
    const d1 = must(await a.engine.localChange(identity, null, true, "explicit"));
    clock.tick(1);
    const w1 = must(await a.engine.localChange(identity, attrsFor("relogin"), false, "explicit"));
    clock.tick(1);
    const w2 = must(await a.engine.localChange(identity, attrsFor("rotated"), false, "explicit"));

    // Fresh device hydrates the tombstone, then receives ONLY the newest
    // write (a hub that keeps just the latest version per record).
    expect(await d.engine.applyRemote([w0, d1])).toEqual(["applied", "applied"]);
    expect(await d.engine.applyRemote([w2])).toEqual(["resurrection-blocked"]);
    expect(d.engine.getRecord(w2.recordId)?.cause).toBe("EXPLICIT_DELETE");

    // The intermediate link arrives later; the parked write applies with it.
    expect(await d.engine.applyRemote([w1])).toEqual(["applied"]);
    expect(d.engine.getRecord(w2.recordId)?.hlc).toEqual(w2.hlc);
    expect(d.engine.listLiveCookies().map((p) => p.attributes?.value)).toEqual(["rotated"]);
  });

  it("still blocks a write whose history genuinely predates the delete", async () => {
    const spaceId = "space-still-blocked";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);
    const b = await createEngine(spaceId, "dev-b", clock);
    const identity = makeIdentity(spaceId, "github.com", "sid");

    clock.tick(1);
    const w0 = must(await a.engine.localChange(identity, attrsFor("v0"), false, "explicit"));
    expect(await b.engine.applyRemote([w0])).toEqual(["applied"]);
    clock.tick(1);
    const d1 = must(await a.engine.localChange(identity, null, true, "explicit"));

    // B offline since before the delete; its write descends only from w0.
    clock.tick(1);
    const stale = must(await b.engine.localChange(identity, attrsFor("zombie"), false, "explicit"));
    expect(compareHlc(stale.hlc, d1.hlc)).toBeGreaterThan(0);

    expect(await a.engine.applyRemote([stale])).toEqual(["resurrection-blocked"]);
    expect(a.engine.listLiveCookies()).toEqual([]);
  });
});

describe("finding: steady-state echo republish loop", () => {
  it("the cookie-store echo of a remote apply is suppressed, not republished", async () => {
    const spaceId = "space-echo-loop";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);
    const b = await createEngine(spaceId, "dev-b", clock);
    const identity = makeIdentity(spaceId, "github.com", "sid");

    clock.tick(1);
    const w0 = must(await a.engine.localChange(identity, attrsFor("v0"), false, "explicit"));
    expect(await b.engine.applyRemote([w0])).toEqual(["applied"]);

    // Electron fires cookies-'changed' for the applied cookie; capture relays
    // it to localChange. It must be swallowed, not signed and republished.
    const echo = await b.engine.localChange(identity, attrsFor("v0"), false, "explicit");
    expect(echo).toBeNull();
    expect(b.transport.published).toHaveLength(0);
  });

  it("a genuine user mutation right after an apply still publishes", async () => {
    const spaceId = "space-echo-genuine";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);
    const b = await createEngine(spaceId, "dev-b", clock);
    const identity = makeIdentity(spaceId, "github.com", "sid");

    clock.tick(1);
    const w0 = must(await a.engine.localChange(identity, attrsFor("v0"), false, "explicit"));
    expect(await b.engine.applyRemote([w0])).toEqual(["applied"]);

    clock.tick(1);
    const genuine = await b.engine.localChange(identity, attrsFor("different"), false, "explicit");
    expect(genuine).not.toBeNull();
    expect(b.transport.published).toHaveLength(1);
  });
});

describe("finding: phantom echo expectations swallow the next real login", () => {
  it("a hydrated tombstone with no echo event cannot eat a later genuine write", async () => {
    const spaceId = "space-phantom";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);
    const fresh = await createEngine(spaceId, "dev-fresh", clock);
    const identity = makeIdentity(spaceId, "github.com", "sid");

    clock.tick(1);
    must(await a.engine.localChange(identity, attrsFor("old"), false, "explicit"));
    clock.tick(1);
    const tombstone = must(await a.engine.localChange(identity, null, true, "explicit"));

    // Fresh jar: removing an absent cookie emits no 'changed' event, so the
    // registered echo expectation is never consumed.
    await fresh.engine.beginHydration();
    expect(await fresh.engine.applyRemote([tombstone])).toEqual(["applied"]);
    await fresh.engine.endHydration();

    // Days later the user logs in again: different state, must publish.
    clock.tick(1);
    const login = await fresh.engine.localChange(identity, attrsFor("new-session"), false, "explicit");
    expect(login).not.toBeNull();
    expect(fresh.transport.published).toHaveLength(1);
  });

  it("a same-state expectation lapses after the echo TTL", async () => {
    const spaceId = "space-echo-ttl";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);
    const b = await createEngine(spaceId, "dev-b", clock, { echoTtlMs: 1_000 });
    const identity = makeIdentity(spaceId, "github.com", "sid");

    clock.tick(1);
    const w0 = must(await a.engine.localChange(identity, attrsFor("v0"), false, "explicit"));
    expect(await b.engine.applyRemote([w0])).toEqual(["applied"]);

    // The echo never arrives (e.g. the applier's set was a no-op). After the
    // TTL, an identical genuine write is a real mutation again.
    clock.tick(1_001);
    const genuine = await b.engine.localChange(identity, attrsFor("v0"), false, "explicit");
    expect(genuine).not.toBeNull();
  });
});

describe("finding: lease grants cached beyond the server TTL", () => {
  const rotatingIdentity = (spaceId: string): ReturnType<typeof makeIdentity> =>
    makeIdentity(spaceId, "dash.cloudflare.com", "cf_session");

  it("re-acquires the origin lease after the conservative client expiry", async () => {
    const spaceId = "space-lease-ttl";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock, { leaseTtlMs: 10_000 });
    const identity = rotatingIdentity(spaceId);

    clock.tick(1);
    must(await a.engine.localChange(identity, attrsFor("s1"), false, "explicit"));
    expect(a.transport.leaseCalls).toHaveLength(1);

    // Within half the TTL the cached grant is trusted.
    clock.tick(2_000);
    must(await a.engine.localChange(identity, attrsFor("s2"), false, "explicit"));
    expect(a.transport.leaseCalls).toHaveLength(1);

    // Past half the TTL the grant may have lapsed server-side — re-acquire.
    clock.tick(4_000);
    must(await a.engine.localChange(identity, attrsFor("s3"), false, "explicit"));
    expect(a.transport.leaseCalls).toHaveLength(2);
    expect(a.transport.published).toHaveLength(3);
  });
});

describe("finding: sealed identity never re-bound to wire ids", () => {
  it("rejects a record whose sealed identity does not hash to its record id", async () => {
    const spaceId = "space-binding";
    const clock = new ManualClock();
    const receiver = await createEngine(spaceId, "dev-r", clock);
    const keys = await testSpaceKeys(spaceId);
    const keypair = await testKeypair();

    const realIdentity = makeIdentity(spaceId, "github.com", "sid");
    const claimedIdentity = makeIdentity(spaceId, "gitlab.com", "token");
    const claimedRecordId = await computeRecordIdHex(keys.idKey, claimedIdentity);
    const claimedOriginId = await computeOriginIdHex(keys.idKey, spaceId, claimedIdentity.hostKey);

    // Seal a github cookie but claim gitlab's record/origin ids — the AAD is
    // consistent with the claim, so only the re-binding check can catch it.
    const plain: CookiePlain = {
      identity: realIdentity,
      attributes: attrsFor("smuggled"),
      deleted: false,
    };
    const sealed = await seal(
      keys.sealKey,
      encodeCookiePlain(plain),
      recordSealAad(spaceId, claimedRecordId),
    );
    const fields: SignableRecordFields = {
      spaceId,
      recordId: claimedRecordId,
      originId: claimedOriginId,
      sealedRecord: toBase64(sealed),
      hlc: { physicalMs: clock.now() + 5, logical: 0, deviceId: "dev-m" },
      causalParent: null,
      cause: "WRITE",
    };
    const deviceSig = toBase64(await signRecord(keypair.privateKey, fields));

    expect(await receiver.engine.applyRemote([{ ...fields, deviceSig }])).toEqual(["rejected"]);
    expect(receiver.engine.getRecord(claimedRecordId)).toBeUndefined();
  });
});

describe("finding: device signatures never verified on receipt", () => {
  it("rejects unknown-device records under the reject policy and bad signatures always", async () => {
    const spaceId = "space-verify";
    const clock = new ManualClock();
    const sender = await createEngine(spaceId, "dev-s", clock);
    const identity = makeIdentity(spaceId, "github.com", "sid");

    clock.tick(1);
    const wire = must(await sender.engine.localChange(identity, attrsFor("v0"), false, "explicit"));

    const strangerKeys = await generateDeviceKeypair();
    const strict = new DeviceRegistryVerifier("reject");
    strict.addDevice("someone-else", strangerKeys.publicKey);
    const receiverStrict = await createEngine(spaceId, "dev-r1", clock, { verifier: strict });
    expect(await receiverStrict.engine.applyRemote([wire])).toEqual(["rejected"]);

    const trusting = new DeviceRegistryVerifier("reject");
    trusting.addDevice("dev-s", (await testKeypair()).publicKey);
    const receiverTrusting = await createEngine(spaceId, "dev-r2", clock, { verifier: trusting });
    expect(await receiverTrusting.engine.applyRemote([wire])).toEqual(["applied"]);

    // Any mutated field breaks the signature.
    const tampered = { ...wire, cause: "EXPLICIT_DELETE" as const };
    const receiverTampered = await createEngine(spaceId, "dev-r3", clock, { verifier: trusting });
    expect(await receiverTampered.engine.applyRemote([tampered])).toEqual(["rejected"]);
  });
});

describe("finding: a localOnly demoted delete must not orphan the next write", () => {
  const rotatingIdentity = (spaceId: string): ReturnType<typeof makeIdentity> =>
    makeIdentity(spaceId, "cloudflare.com", "session");

  it("the next write is relinked past the unpublished tombstone, re-signed, and resolves against the peer's fence", async () => {
    const spaceId = "space-localonly-orphan";
    const clock = new ManualClock();
    const verifier = new DeviceRegistryVerifier("reject");
    const keypair = await testKeypair();
    verifier.addDevice("dev-a", keypair.publicKey);
    verifier.addDevice("dev-p", keypair.publicKey);
    const p = await createEngine(spaceId, "dev-p", clock, { verifier });
    const a = await createEngine(spaceId, "dev-a", clock, { verifier });
    a.transport.leaseGranted = false; // P is the active writer for this origin
    const identity = rotatingIdentity(spaceId);

    // P: login, logout (the fence), login again, rotate. A follows along.
    const chain = [] as Awaited<ReturnType<typeof p.engine.localChange>>[];
    clock.tick(1);
    chain.push(await p.engine.localChange(identity, attrsFor("v0"), false, "explicit"));
    clock.tick(1);
    const logout = must(await p.engine.localChange(identity, null, true, "explicit"));
    chain.push(logout);
    clock.tick(1);
    chain.push(await p.engine.localChange(identity, attrsFor("v1"), false, "explicit"));
    clock.tick(1);
    const rotated = must(await p.engine.localChange(identity, attrsFor("v2"), false, "overwrite"));
    chain.push(rotated);
    expect(logout.cause).toBe("EXPLICIT_DELETE");
    for (const wire of chain) expect(await a.engine.applyRemote([must(wire)])).toEqual(["applied"]);
    // The cookie-store echoes of those applies never arrive; let them lapse.
    clock.tick(10_001);

    // The server retires A's stale copy of v2: writer-scoped, demoted, never
    // published — but it is the parent of whatever A writes next.
    clock.tick(1);
    const demoted = must(await a.engine.localChange(identity, null, true, "explicit"));
    expect(demoted.cause).toBe("EXPIRED");
    expect(demoted.causalParent).toBe(makeVersionToken(rotated.recordId, rotated.hlc));
    expect(a.transport.published).toHaveLength(0);

    // The user logs in on A. Its parent in local history is the unpublished
    // demoted tombstone; on the wire it must be the version P published.
    clock.tick(1);
    const login = must(await a.engine.localChange(identity, attrsFor("relogin"), false, "explicit"));
    expect(a.transport.published).toHaveLength(1);
    const wire = must(a.transport.published[0]);
    expect(wire.causalParent).toBe(makeVersionToken(rotated.recordId, rotated.hlc));
    expect(login).toEqual(wire);
    expect(must(a.engine.getRecord(login.recordId)).wire).toEqual(wire);
    expect(must(a.engine.getRecord(login.recordId)).causalParent).toBe(wire.causalParent);

    // P holds the logout fence: the relinked, re-signed wire verifies and its
    // chain (v2 → v1 → logout) provably descends from it. An orphaned parent
    // would have parked it forever as resurrection-blocked.
    expect(await p.engine.applyRemote([wire])).toEqual(["applied"]);
    expect(p.engine.listLiveCookies().map((c) => c.attributes?.value)).toEqual(["relogin"]);
  });

  it("a locally stored version keeps its true parent for local descent decisions", async () => {
    const spaceId = "space-localonly-local-descent";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);
    a.transport.leaseGranted = false;
    const identity = rotatingIdentity(spaceId);
    clock.tick(1);
    const v0 = must(await a.engine.localChange(identity, attrsFor("v0"), false, "explicit"));
    clock.tick(1);
    const demoted = must(await a.engine.localChange(identity, null, true, "explicit"));
    expect(demoted.cause).toBe("EXPIRED");
    clock.tick(1);
    const next = must(await a.engine.localChange(identity, attrsFor("v1"), false, "explicit"));
    // The published wire skips the tombstone; nothing else about it changed.
    expect(next.causalParent).toBe(makeVersionToken(v0.recordId, v0.hlc));
    expect(next.hlc).toEqual(must(a.engine.getRecord(next.recordId)).hlc);
    expect(next.sealedRecord).toBe(must(a.engine.getRecord(next.recordId)).wire.sealedRecord);
    expect(a.transport.published.map((r) => r.causalParent)).toEqual([
      null,
      makeVersionToken(v0.recordId, v0.hlc),
    ]);
  });
});

describe("finding: a rate-limited publish must not look like a durable ack", () => {
  it("re-queues the throttled record in the DEFAULT lane and re-sends it on the next flush", async () => {
    const spaceId = "space-rate-limited";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);
    const identity = makeIdentity(spaceId, "github.com", "sid");

    clock.tick(1);
    const w = must(
      await a.engine.localChange(identity, attrsFor("v0"), false, "explicit"),
    );
    expect(a.transport.published).toHaveLength(1);

    // `stale` is the one durable rejection: the hub already holds this
    // record or a newer winner, so nothing is re-queued.
    await a.engine.publishRejected(w.recordId, "stale");
    expect(a.engine.queueDepth).toBe(0);

    // The hub throttled the origin instead: it stored nothing, so the record
    // has to go back into the default lane. Not the deferred lane — its
    // depth means "a cloud run holds this origin" and refuses the very push
    // that got throttled.
    await a.engine.publishRejected(w.recordId, "rate_limited");
    expect(a.engine.queueDepth).toBe(1);
    expect(a.engine.deferredDepth).toBe(0);
    expect(a.transport.published).toHaveLength(1);

    await a.engine.flushPending();
    expect(a.transport.published).toHaveLength(2);
    expect(a.transport.published[1]?.hlc).toEqual(w.hlc);
    expect(a.engine.queueDepth).toBe(0);
  });

  it("retries a throttled deletion, and treats a reason only a newer hub knows as retryable", async () => {
    const spaceId = "space-rate-limited-delete";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);
    const identity = makeIdentity(spaceId, "github.com", "sid");

    clock.tick(1);
    must(await a.engine.localChange(identity, attrsFor("v0"), false, "explicit"));
    clock.tick(1);
    const del = must(await a.engine.localChange(identity, null, true, "explicit"));
    expect(a.transport.published).toHaveLength(2);

    // A dropped deletion is exactly the case that must be retried, so this
    // path must not reuse the lease-recovery guard's deletion skip.
    await a.engine.publishRejected(del.recordId, "rate_limited");
    expect(a.engine.queueDepth).toBe(1);
    await a.engine.flushPending();
    expect(a.transport.published).toHaveLength(3);
    expect(a.transport.published.at(-1)?.cause).toBe("EXPLICIT_DELETE");
    expect(a.transport.published.at(-1)?.hlc).toEqual(del.hlc);

    // An unrecognised reason from a newer hub is retried, never mistaken for
    // a durability confirmation.
    await a.engine.publishRejected(del.recordId, "unknown");
    expect(a.engine.queueDepth).toBe(1);
  });
});

describe("finding: writes lost when the socket dies mid-publish", () => {
  it("re-queues a sign-out deletion the transport could not deliver", async () => {
    const spaceId = "space-interrupted-delete";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);
    const identity = makeIdentity(spaceId, "github.com", "user_session");

    clock.tick(1);
    must(await a.engine.localChange(identity, attrsFor("live"), false, "explicit"));
    clock.tick(1);
    must(await a.engine.localChange(identity, null, true, "explicit"));
    expect(a.transport.published).toHaveLength(2);

    // The socket dropped with the deletion in flight: the host reports it as
    // `lease_required` through `onPublishInterrupted`. Dropping it here would
    // leave every peer holding the session cookie this device just signed out.
    const deleted = a.transport.published[1];
    a.engine.setOnline(false);
    await a.engine.publishRejected(deleted!.recordId, "lease_required");

    expect(a.engine.queueDepth).toBe(1);
    a.transport.published.length = 0;
    a.engine.setOnline(true);
    await a.engine.flushPending();
    expect(a.transport.published.map((wire) => wire.cause)).toEqual(["EXPLICIT_DELETE"]);
  });

  it("queues a write whose lease round trip outlived the connection", async () => {
    const spaceId = "space-lease-then-offline";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock, { leaseTtlMs: 10_000 });
    const identity = makeIdentity(spaceId, "dash.cloudflare.com", "cf_session");

    // The lease answer comes back "offline": the socket went away while the
    // engine waited. Publishing now hands the wire to a transport that drops
    // the frame, and nothing would ever name it again.
    a.transport.leaseResults.push({ granted: false, reason: "offline" });
    clock.tick(1);
    const wire = await a.engine.localChange(identity, attrsFor("s1"), false, "explicit");

    expect(wire).not.toBeNull();
    expect(a.transport.published).toHaveLength(0);
    expect(a.engine.queueDepth).toBe(1);
  });
});

describe("finding: a queue drain that empties the lane before it dispatches", () => {
  /** A transport whose lease answer is held open, so a drain can be inspected
   * exactly where a crash would have lost the lane (V9a). */
  class GatedTransport implements SyncTransport {
    readonly published: CookieRecordWire[] = [];
    readonly leaseCalls: string[] = [];
    /** Resolves the lease acquire that is currently waiting. */
    release: (() => void) | null = null;
    granted = true;
    failPublish = false;

    publish(records: CookieRecordWire[]): void {
      if (this.failPublish) throw new Error("socket write failed");
      this.published.push(...records);
    }

    acquireLease(_spaceId: string, originId: string): Promise<LeaseOutcome> {
      this.leaseCalls.push(originId);
      return new Promise<LeaseOutcome>((resolve) => {
        this.release = (): void => {
          resolve(
            this.granted
              ? { granted: true, exclusive: false }
              : { granted: false, reason: "offline" },
          );
        };
      });
    }

    releaseLease(): void {
      // no cached leases in these tests
    }
  }

  async function engineWith(
    spaceId: string,
    clock: ManualClock,
    transport: SyncTransport,
    storage: MemoryQueueStorage,
  ): Promise<SpaceSyncEngine> {
    const keys = await testSpaceKeys(spaceId);
    const keypair = await testKeypair();
    return new SpaceSyncEngine(
      spaceId,
      keys,
      { deviceId: "dev-a", privateKey: keypair.privateKey },
      transport,
      { apply: (): Promise<void> => Promise.resolve() },
      {
        deviceId: "dev-a",
        now: clock.now,
        leaseKind: "desktop",
        queueStorage: storage,
      },
    );
  }

  /** Two DIFFERENT rotating-auth origins: one lease round trip per wire, so a
   * drain can be inspected between them (a cached grant would skip the second). */
  const rotatingA = (spaceId: string): CookieIdentity =>
    makeIdentity(spaceId, "dash.cloudflare.com", "cf_session");
  const rotatingB = (spaceId: string): CookieIdentity =>
    makeIdentity(spaceId, "slack.com", "d");

  it("leaves every not-yet-dispatched wire in persisted storage while the drain runs", async () => {
    const spaceId = "space-drain-persistence";
    const clock = new ManualClock();
    const storage = new MemoryQueueStorage();
    const transport = new GatedTransport();
    const engine = await engineWith(spaceId, clock, transport, storage);

    engine.setOnline(false);
    clock.tick(1);
    const first = must(
      await engine.localChange(rotatingA(spaceId), attrsFor("a"), false, "explicit"),
    );
    clock.tick(1);
    const second = must(
      await engine.localChange(rotatingB(spaceId), attrsFor("b"), false, "explicit"),
    );
    expect(storage.toFile().offline).toHaveLength(2);

    engine.setOnline(true);
    const drain = engine.flushPending();
    await settle(() => transport.leaseCalls.length === 1);

    // A crash here (the lease round trip takes seconds) used to lose both:
    // `drain()` had already cleared the lane and nothing else persists a wire.
    expect(storage.toFile().offline.map((record) => record.hlc)).toEqual([
      first.hlc,
      second.hlc,
    ]);

    must(transport.release)();
    await settle(() => transport.leaseCalls.length === 2);
    // The first wire is durable on the hub now, so only it leaves the lane.
    expect(storage.toFile().offline.map((record) => record.hlc)).toEqual([
      second.hlc,
    ]);
    must(transport.release)();
    await drain;
    expect(storage.toFile().offline).toEqual([]);
    expect(transport.published.map((record) => record.hlc)).toEqual([
      first.hlc,
      second.hlc,
    ]);
    expect(engine.queueDepth).toBe(0);
  });

  it("does not duplicate a wire shelved back when the socket dies mid-drain", async () => {
    const spaceId = "space-drain-reshelve";
    const clock = new ManualClock();
    const storage = new MemoryQueueStorage();
    const transport = new GatedTransport();
    const engine = await engineWith(spaceId, clock, transport, storage);

    engine.setOnline(false);
    clock.tick(1);
    const first = must(
      await engine.localChange(rotatingA(spaceId), attrsFor("a"), false, "explicit"),
    );
    clock.tick(1);
    const second = must(
      await engine.localChange(rotatingB(spaceId), attrsFor("b"), false, "explicit"),
    );

    engine.setOnline(true);
    const drain = engine.flushPending();
    await settle(() => transport.leaseCalls.length === 1);
    // The socket goes away inside the lease round trip.
    engine.setOnline(false);
    transport.granted = false;
    must(transport.release)();
    await drain;

    expect(transport.published).toEqual([]);
    expect(engine.queueDepth).toBe(2);
    expect(storage.toFile().offline.map((record) => record.hlc)).toEqual([
      second.hlc,
      first.hlc,
    ]);
  });

  it("drops one unsealable wire and keeps draining the rest of the lane", async () => {
    // Finding V9b: `wireNeedsLease` opens the record with no try/catch, so a
    // wire this device cannot unseal rejected the whole drain — after the
    // lane had already been cleared.
    const spaceId = "space-drain-unsealable";
    const clock = new ManualClock();
    const source = new MemoryQueueStorage();
    const a = await createEngine(spaceId, "dev-a", clock, { queueStorage: source });
    a.engine.setOnline(false);
    clock.tick(1);
    const good = must(
      await a.engine.localChange(
        makeIdentity(spaceId, "github.com", "sid"),
        attrsFor("keep-me"),
        false,
        "explicit",
      ),
    );
    const file = source.toFile();
    const unsealable: CookieRecordWire = {
      ...good,
      recordId: "1".repeat(64),
      // Valid base64, wrong key: exactly what a device without the Space
      // secret holds after a restore.
      sealedRecord: toBase64(new Uint8Array(96)),
      hlc: { ...good.hlc, physicalMs: good.hlc.physicalMs - 1 },
    };
    file.offline = [unsealable, ...file.offline];

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const b = await createEngine(spaceId, "dev-b", clock, {
      queueStorage: MemoryQueueStorage.fromFile(file),
    });
    b.engine.setOnline(true);
    await b.engine.flushPending();

    expect(b.transport.published.map((record) => record.recordId)).toEqual([
      good.recordId,
    ]);
    expect(b.engine.queueDepth).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("keeps a wire whose dispatch threw and still dispatches the ones behind it", async () => {
    const spaceId = "space-drain-publish-error";
    const clock = new ManualClock();
    const storage = new MemoryQueueStorage();
    const transport = new GatedTransport();
    const engine = await engineWith(spaceId, clock, transport, storage);

    engine.setOnline(false);
    clock.tick(1);
    const first = must(
      await engine.localChange(rotatingA(spaceId), attrsFor("a"), false, "explicit"),
    );
    clock.tick(1);
    const second = must(
      await engine.localChange(rotatingB(spaceId), attrsFor("b"), false, "explicit"),
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    engine.setOnline(true);
    transport.failPublish = true;
    const drain = engine.flushPending();
    await settle(() => transport.leaseCalls.length === 1);
    must(transport.release)();
    await settle(() => transport.leaseCalls.length === 2);
    transport.failPublish = false;
    must(transport.release)();
    await drain;

    expect(transport.published.map((record) => record.hlc)).toEqual([second.hlc]);
    // The wire whose publish threw is still queued for the next drain.
    expect(storage.toFile().offline.map((record) => record.hlc)).toEqual([first.hlc]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("logs a drain that fails outright instead of leaving an unhandled rejection", async () => {
    // `setOnline(true)` starts both drains without awaiting them.
    class UnreadableStorage extends MemoryQueueStorage {
      override all(): CookieRecordWire[] {
        throw new Error("queue file unreadable");
      }
    }
    const spaceId = "space-drain-unhandled";
    const clock = new ManualClock();
    const engine = await engineWith(
      spaceId,
      clock,
      new GatedTransport(),
      new UnreadableStorage(),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    engine.setOnline(true);
    await settle(() => warn.mock.calls.length >= 2);
    expect(warn.mock.calls.length).toBeGreaterThanOrEqual(2);
    warn.mockRestore();
  });
});

describe("finding: one refused cookie aborts the rest of a remote batch", () => {
  it("reports the refused record and applies the ones behind it", async () => {
    const spaceId = "space-batch-refusal";
    const clock = new ManualClock();
    const source = await createEngine(spaceId, "dev-source", clock);
    const identities = ["sid", "csrf", "theme"].map((name) =>
      makeIdentity(spaceId, "github.com", name),
    );
    const wires: CookieRecordWire[] = [];
    for (const identity of identities) {
      clock.tick(1);
      wires.push(
        must(await source.engine.localChange(identity, attrsFor(identity.name), false, "explicit")),
      );
    }

    const keys = await testSpaceKeys(spaceId);
    const keypair = await testKeypair();
    const refused = must(wires[1]).recordId;
    const applied: string[] = [];
    const target = new SpaceSyncEngine(
      spaceId,
      keys,
      { deviceId: "dev-target", privateKey: keypair.privateKey },
      new CollectingTransport(),
      {
        apply: (plain: CookiePlain): Promise<void> => {
          // Chromium refuses this one for good (prefix / SameSite rules).
          if (plain.identity.name === "csrf") {
            return Promise.reject(new Error("cookie refused by the store"));
          }
          applied.push(plain.identity.name);
          return Promise.resolve();
        },
      },
      { deviceId: "dev-target", now: clock.now, leaseKind: "desktop" },
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await target.applyRemote(wires)).toEqual([
      "applied",
      "unappliable",
      "applied",
    ]);
    warn.mockRestore();
    // The tail of the batch is no longer lost with the refused record.
    expect(applied).toEqual(["sid", "theme"]);
    expect(target.getRecord(refused)).toBeUndefined();
    expect(target.getRecord(must(wires[2]).recordId)).toBeDefined();

    // A batch where nothing at all could be applied still rejects: there is
    // no tail to save, and the hosts that apply one record per call (the
    // desktop's first-hydration path) skip-list the record from that.
    const warnAgain = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(target.applyRemote([must(wires[1])])).rejects.toThrow(
      "cookie refused by the store",
    );
    warnAgain.mockRestore();
  });
});

describe("finding: the persisted clock never advanced on receipt", () => {
  it("survives a restart without re-issuing an HLC below one it accepted", async () => {
    const spaceId = "space-received-clock";
    // The peer's wall clock runs 30 s ahead — inside MAX_CLOCK_DRIFT_MS, so
    // its HLC is accepted as is.
    const local = new ManualClock();
    const ahead = new ManualClock(local.now() + 30_000);
    const peer = await createEngine(spaceId, "dev-peer", ahead);
    const identity = makeIdentity(spaceId, "github.com", "sid");
    const remote = must(
      await peer.engine.localChange(identity, attrsFor("peer-value"), false, "explicit"),
    );

    const storage = new MemoryQueueStorage();
    const a = await createEngine(spaceId, "dev-a", local, { queueStorage: storage });
    expect(await a.engine.applyRemote([remote])).toEqual(["applied"]);
    const persisted = must(storage.clock);
    expect(persisted.physicalMs).toBe(remote.hlc.physicalMs);

    // "Restart": the record map is memory-only, so only the persisted clock
    // can stop the next local write from losing to what we already accepted.
    const restarted = await createEngine(spaceId, "dev-a", local, {
      queueStorage: MemoryQueueStorage.fromFile(storage.toFile()),
    });
    const next = must(
      await restarted.engine.localChange(identity, attrsFor("mine"), false, "explicit"),
    );
    expect(compareHlc(next.hlc, remote.hlc)).toBeGreaterThan(0);

    // Without it the overwrite would resolve as `stale` on every peer.
    const amnesiac = await createEngine(spaceId, "dev-a", local);
    const stale = must(
      await amnesiac.engine.localChange(identity, attrsFor("mine"), false, "explicit"),
    );
    expect(compareHlc(stale.hlc, remote.hlc)).toBeLessThan(0);
  });
});
