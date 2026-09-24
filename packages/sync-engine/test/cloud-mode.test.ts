/**
 * Cloud lease mode (cloud-sync-design §3, D10): a cloud engine takes an
 * exclusive lease for every write and keeps it alive through the host-driven
 * `renewLeases()`, so deletions it observes late in a run still propagate.
 */

import { describe, expect, it } from "vitest";
import {
  EXCLUSIVE_LEASE_TTL_MS,
  LEASE_RENEW_INTERVAL_MS,
} from "@pistachio/sync-protocol";
import {
  attrsFor,
  createEngine,
  makeIdentity,
  ManualClock,
  must,
} from "./helpers.js";

const rotating = (spaceId: string): ReturnType<typeof makeIdentity> =>
  makeIdentity(spaceId, "cloudflare.com", "session");
const plain = (spaceId: string): ReturnType<typeof makeIdentity> =>
  makeIdentity(spaceId, "github.com", "sid");

describe("cloud mode (leaseKind: 'cloud')", () => {
  it("takes an exclusive lease for every write, rotating-auth or not", async () => {
    const spaceId = "space-cloud-every-write";
    const clock = new ManualClock();
    const c = await createEngine(spaceId, "cloud-1", clock, {
      leaseKind: "cloud",
    });

    clock.tick(1);
    const w1 = must(
      await c.engine.localChange(plain(spaceId), attrsFor("v0"), false, "explicit"),
    );
    clock.tick(1);
    const w2 = must(
      await c.engine.localChange(rotating(spaceId), attrsFor("s0"), false, "explicit"),
    );
    expect(c.transport.leaseCalls).toEqual([
      {
        spaceId,
        originId: w1.originId,
        force: undefined,
        exclusive: true,
        ttlMs: EXCLUSIVE_LEASE_TTL_MS,
      },
      {
        spaceId,
        originId: w2.originId,
        force: undefined,
        exclusive: true,
        ttlMs: EXCLUSIVE_LEASE_TTL_MS,
      },
    ]);
    expect(c.transport.published).toHaveLength(2);

    // A deletion on a non-rotating origin is lease-gated too; the cached
    // exclusive grant (half the TTL) covers it without a new acquire.
    clock.tick(1);
    const del = must(
      await c.engine.localChange(plain(spaceId), null, true, "explicit"),
    );
    expect(del.cause).toBe("EXPLICIT_DELETE");
    expect(c.transport.leaseCalls).toHaveLength(2);
    expect(c.transport.published).toHaveLength(3);
  });

  it("caches an exclusive grant for half the exclusive TTL", async () => {
    const spaceId = "space-cloud-cache-window";
    const clock = new ManualClock();
    const c = await createEngine(spaceId, "cloud-1", clock, {
      leaseKind: "cloud",
    });
    clock.tick(1);
    must(
      await c.engine.localChange(plain(spaceId), attrsFor("v0"), false, "explicit"),
    );
    clock.tick(Math.floor(EXCLUSIVE_LEASE_TTL_MS / 2) - 1);
    must(
      await c.engine.localChange(plain(spaceId), attrsFor("v1"), false, "overwrite"),
    );
    expect(c.transport.leaseCalls).toHaveLength(1);
    clock.tick(2);
    must(
      await c.engine.localChange(plain(spaceId), attrsFor("v2"), false, "overwrite"),
    );
    expect(c.transport.leaseCalls).toHaveLength(2);
  });

  it("renewLeases() re-acquires every cached origin without force and refreshes the cache", async () => {
    const spaceId = "space-cloud-renew";
    const clock = new ManualClock();
    const c = await createEngine(spaceId, "cloud-1", clock, {
      leaseKind: "cloud",
    });
    clock.tick(1);
    const w1 = must(
      await c.engine.localChange(plain(spaceId), attrsFor("v0"), false, "explicit"),
    );
    clock.tick(1);
    const w2 = must(
      await c.engine.localChange(rotating(spaceId), attrsFor("s0"), false, "explicit"),
    );
    expect(c.transport.leaseCalls).toHaveLength(2);

    clock.tick(LEASE_RENEW_INTERVAL_MS);
    await c.engine.renewLeases();
    const renewals = c.transport.leaseCalls.slice(2);
    expect(renewals.map((call) => call.originId).sort()).toEqual(
      [w1.originId, w2.originId].sort(),
    );
    for (const call of renewals) {
      expect(call.force).toBeUndefined();
      expect(call.exclusive).toBe(true);
      expect(call.ttlMs).toBe(EXCLUSIVE_LEASE_TTL_MS);
    }

    // The renewed cache covers a write that the original grant would not.
    clock.tick(LEASE_RENEW_INTERVAL_MS);
    must(
      await c.engine.localChange(plain(spaceId), attrsFor("v1"), false, "overwrite"),
    );
    expect(c.transport.leaseCalls).toHaveLength(4);
  });

  it("a deletion observed 100 s after the last write still publishes as EXPLICIT_DELETE when leases were renewed", async () => {
    const spaceId = "space-cloud-late-delete";
    const clock = new ManualClock();
    const renewing = await createEngine(spaceId, "cloud-renewing", clock, {
      leaseKind: "cloud",
    });
    const silent = await createEngine(spaceId, "cloud-silent", clock, {
      leaseKind: "cloud",
    });

    clock.tick(1);
    for (const c of [renewing, silent]) {
      must(
        await c.engine.localChange(
          rotating(spaceId),
          attrsFor("session"),
          false,
          "explicit",
        ),
      );
    }
    // Two renewal ticks (40 s, 80 s) on one engine; the other lets the
    // cached grant lapse at 60 s.
    clock.tick(LEASE_RENEW_INTERVAL_MS);
    await renewing.engine.renewLeases();
    clock.tick(LEASE_RENEW_INTERVAL_MS);
    await renewing.engine.renewLeases();
    clock.tick(100_000 - 2 * LEASE_RENEW_INTERVAL_MS);

    const kept = must(
      await renewing.engine.localChange(rotating(spaceId), null, true, "explicit"),
    );
    expect(kept.cause).toBe("EXPLICIT_DELETE");
    expect(renewing.transport.published.at(-1)?.recordId).toBe(kept.recordId);
    expect(renewing.transport.published.at(-1)?.cause).toBe("EXPLICIT_DELETE");
    expect(renewing.engine.queueDepth).toBe(0);

    const demoted = must(
      await silent.engine.localChange(rotating(spaceId), null, true, "explicit"),
    );
    expect(demoted.cause).toBe("EXPIRED");
    expect(silent.transport.published).toHaveLength(1);
  });

  it("renewLeases() keeps retrying an origin whose renewal timed out, so a late delete still publishes", async () => {
    // A timeout/offline outcome is NOT a denial: the holder is unknown and
    // the hub may well have granted the renewal whose reply was dropped.
    // Dropping the cache entry would take the origin out of the renewal set
    // for the rest of the run, silently ending exclusivity and demoting the
    // run's own logout to EXPIRED.
    const spaceId = "space-cloud-renew-timeout";
    const clock = new ManualClock();
    const c = await createEngine(spaceId, "cloud-1", clock, {
      leaseKind: "cloud",
    });
    clock.tick(1);
    const w = must(
      await c.engine.localChange(
        rotating(spaceId),
        attrsFor("session"),
        false,
        "explicit",
      ),
    );

    clock.tick(LEASE_RENEW_INTERVAL_MS);
    c.transport.leaseResults.push({ granted: false, reason: "timeout" });
    await c.engine.renewLeases();
    clock.tick(LEASE_RENEW_INTERVAL_MS);
    await c.engine.renewLeases();
    expect(
      c.transport.leaseCalls.filter((call) => call.originId === w.originId),
    ).toHaveLength(3);

    clock.tick(LEASE_RENEW_INTERVAL_MS);
    const del = must(
      await c.engine.localChange(rotating(spaceId), null, true, "explicit"),
    );
    expect(del.cause).toBe("EXPLICIT_DELETE");
    expect(c.transport.published.at(-1)?.cause).toBe("EXPLICIT_DELETE");
  });

  it("renewLeases() is a no-op offline and drops a cache entry the hub denies", async () => {
    const spaceId = "space-cloud-renew-denied";
    const clock = new ManualClock();
    const c = await createEngine(spaceId, "cloud-1", clock, {
      leaseKind: "cloud",
    });
    clock.tick(1);
    const w = must(
      await c.engine.localChange(plain(spaceId), attrsFor("v0"), false, "explicit"),
    );
    expect(c.transport.leaseCalls).toHaveLength(1);

    c.engine.setOnline(false);
    expect(c.transport.released).toEqual([w.originId]);
    await c.engine.renewLeases();
    expect(c.transport.leaseCalls).toHaveLength(1);

    c.engine.setOnline(true);
    clock.tick(1);
    must(
      await c.engine.localChange(plain(spaceId), attrsFor("v1"), false, "overwrite"),
    );
    expect(c.transport.leaseCalls).toHaveLength(2);

    // A desktop took the origin meanwhile: the renewal is denied, the cache
    // is dropped, and the next write asks the hub again.
    c.transport.leaseResults.push(false);
    await c.engine.renewLeases();
    expect(c.transport.leaseCalls).toHaveLength(3);
    clock.tick(1);
    must(
      await c.engine.localChange(plain(spaceId), attrsFor("v2"), false, "overwrite"),
    );
    expect(c.transport.leaseCalls).toHaveLength(4);
  });

  it("defaults leaseTtlMs per kind and honours an explicit override", async () => {
    const spaceId = "space-cloud-ttl";
    const clock = new ManualClock();
    const custom = await createEngine(spaceId, "cloud-1", clock, {
      leaseKind: "cloud",
      leaseTtlMs: 10_000,
    });
    clock.tick(1);
    must(
      await custom.engine.localChange(plain(spaceId), attrsFor("v0"), false, "explicit"),
    );
    expect(custom.transport.leaseCalls[0]?.ttlMs).toBe(10_000);
    clock.tick(5_001);
    must(
      await custom.engine.localChange(plain(spaceId), attrsFor("v1"), false, "overwrite"),
    );
    expect(custom.transport.leaseCalls).toHaveLength(2);

    const desktop = await createEngine(spaceId, "dev-1", clock);
    clock.tick(1);
    must(
      await desktop.engine.localChange(rotating(spaceId), attrsFor("s0"), false, "explicit"),
    );
    expect(desktop.transport.leaseCalls[0]?.exclusive).toBeUndefined();
    expect(desktop.transport.leaseCalls[0]?.ttlMs).toBeUndefined();
  });
});

/**
 * W8 (docs/web-browser-design.md): a persistent browser session is a `cloud`
 * engine for identity, but while no run is acting in it the person's Mac and
 * their web tab are two hands on the same account. So the exclusivity is a
 * toggle, separate from the lease kind: non-exclusive while a person is just
 * browsing, exclusive again the moment a run attaches.
 */
describe("non-exclusive leases while no run is active (W8)", () => {
  it("leases like a desktop when exclusivity is off, and like a cloud again when it is on", async () => {
    const spaceId = "space-cloud-session";
    const clock = new ManualClock();
    const c = await createEngine(spaceId, "cloud-session", clock, {
      leaseKind: "cloud",
      exclusiveLeases: false,
    });
    expect(c.engine.exclusiveLeases).toBe(false);

    // A plain origin is not leased at all: that is the desktop rule.
    clock.tick(1);
    await c.engine.localChange(plain(spaceId), attrsFor("v0"), false, "explicit");
    expect(c.transport.leaseCalls).toEqual([]);

    // A rotating-auth write still takes a lease, and a NON-exclusive one, so
    // another device of the same account can take it in turn.
    clock.tick(1);
    const rotated = must(
      await c.engine.localChange(rotating(spaceId), attrsFor("s0"), false, "explicit"),
    );
    expect(c.transport.leaseCalls).toEqual([
      { spaceId, originId: rotated.originId, force: undefined, exclusive: undefined, ttlMs: undefined },
    ]);

    // A run attaches: every write is fenced again.
    c.engine.setExclusiveLeases(true);
    expect(c.engine.exclusiveLeases).toBe(true);
    clock.tick(1);
    const fenced = must(
      await c.engine.localChange(makeIdentity(spaceId, "example.com", "sid"), attrsFor("v1"), false, "explicit"),
    );
    expect(c.transport.leaseCalls.at(-1)).toEqual({
      spaceId,
      originId: fenced.originId,
      force: undefined,
      exclusive: true,
      ttlMs: EXCLUSIVE_LEASE_TTL_MS,
    });
  });

  it("defaults to today's behaviour when the toggle is not given", async () => {
    const clock = new ManualClock();
    const cloud = await createEngine("space-default-cloud", "cloud-2", clock, { leaseKind: "cloud" });
    const desktop = await createEngine("space-default-desktop", "mac-2", clock, { leaseKind: "desktop" });
    expect(cloud.engine.exclusiveLeases).toBe(true);
    expect(desktop.engine.exclusiveLeases).toBe(false);
  });
});
