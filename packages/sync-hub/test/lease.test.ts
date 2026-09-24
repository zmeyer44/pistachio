import {
  EXCLUSIVE_LEASE_TTL_MS,
  MAX_LEASE_TTL_MS,
  ORIGIN_LEASE_TTL_MS,
} from "@pistachio/sync-protocol";
import { describe, expect, it } from "vitest";
import {
  FakeConnection,
  frame,
  hex64,
  makeFixture,
  makeHlc,
  makeRecord,
  sendHello,
} from "./helpers.js";

const originId = hex64(0xcafe);
const otherOrigin = hex64(0xbabe);

describe("origin leases", () => {
  it("grants a free lease, denies another device, grants again after expiry", async () => {
    const { core, clock } = makeFixture();
    const a = new FakeConnection();
    const b = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);
    await sendHello(core, b, "dev-b", ["s1"], [a]);

    await core.handleMessage(
      a,
      frame({ t: "lease.acquire", spaceId: "s1", originId }),
      [b],
    );
    const granted = a.ofType("lease.granted")[0];
    expect(granted?.holderDeviceId).toBe("dev-a");
    expect(granted?.expiresAtMs).toBe(clock.nowMs + ORIGIN_LEASE_TTL_MS);
    expect(granted?.exclusive).toBe(false);

    await core.handleMessage(
      b,
      frame({ t: "lease.acquire", spaceId: "s1", originId }),
      [a],
    );
    const denied = b.ofType("lease.denied")[0];
    expect(denied?.holderDeviceId).toBe("dev-a");
    expect(denied?.holderKind).toBe("desktop");
    expect(denied?.exclusive).toBe(false);
    expect(b.ofType("lease.granted")).toHaveLength(0);

    clock.nowMs += ORIGIN_LEASE_TTL_MS + 1;
    await core.handleMessage(
      b,
      frame({ t: "lease.acquire", spaceId: "s1", originId }),
      [a],
    );
    expect(b.ofType("lease.granted")[0]?.holderDeviceId).toBe("dev-b");
  });

  it("renews for the current holder and caps requested ttl at MAX_LEASE_TTL_MS", async () => {
    const { core, clock } = makeFixture();
    const a = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);

    await core.handleMessage(
      a,
      frame({
        t: "lease.acquire",
        spaceId: "s1",
        originId,
        ttlMs: ORIGIN_LEASE_TTL_MS * 100,
      }),
      [],
    );
    expect(a.ofType("lease.granted")[0]?.expiresAtMs).toBe(
      clock.nowMs + MAX_LEASE_TTL_MS,
    );

    clock.nowMs += 1_000;
    await core.handleMessage(
      a,
      frame({ t: "lease.acquire", spaceId: "s1", originId }),
      [],
    );
    const renewed = a.ofType("lease.granted")[1];
    expect(renewed?.holderDeviceId).toBe("dev-a");
    expect(renewed?.expiresAtMs).toBe(clock.nowMs + ORIGIN_LEASE_TTL_MS);
    expect(a.ofType("lease.denied")).toHaveLength(0);
  });

  it("force takeover transfers the lease and notifies the previous holder", async () => {
    const { core } = makeFixture();
    const a = new FakeConnection();
    const b = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);
    await sendHello(core, b, "dev-b", ["s1"], [a]);

    await core.handleMessage(
      a,
      frame({ t: "lease.acquire", spaceId: "s1", originId }),
      [b],
    );
    await core.handleMessage(
      b,
      frame({
        t: "lease.acquire",
        spaceId: "s1",
        originId,
        force: true,
        recordId: "candidate-record",
        candidateHlc: { physicalMs: 2, logical: 0, deviceId: "dev-b" },
      }),
      [a],
    );
    expect(b.ofType("lease.granted")[0]?.holderDeviceId).toBe("dev-b");
    const revoked = a.ofType("lease.revoked")[0];
    expect(revoked?.newHolderDeviceId).toBe("dev-b");
    expect(revoked?.originId).toBe(originId);
  });

  it("blocks publishes from non-holders while the lease is live, unblocks after release", async () => {
    const { core } = makeFixture();
    const a = new FakeConnection();
    const b = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);
    await sendHello(core, b, "dev-b", ["s1"], [a]);

    await core.handleMessage(
      a,
      frame({ t: "lease.acquire", spaceId: "s1", originId }),
      [b],
    );

    const foreign = makeRecord({
      spaceId: "s1",
      originId,
      hlc: makeHlc(10, "dev-b"),
    });
    await core.handleMessage(b, frame({ t: "publish", records: [foreign] }), [
      a,
    ]);
    expect(b.ofType("publish.ack")[0]?.rejected).toEqual([
      { recordId: foreign.recordId, reason: "lease_required" },
    ]);

    // The holder itself can still publish.
    const own = makeRecord({
      spaceId: "s1",
      originId,
      hlc: makeHlc(11, "dev-a"),
    });
    await core.handleMessage(a, frame({ t: "publish", records: [own] }), [b]);
    expect(a.ofType("publish.ack")[0]?.accepted).toEqual([own.recordId]);

    await core.handleMessage(
      a,
      frame({ t: "lease.release", spaceId: "s1", originId }),
      [b],
    );
    // Every connection of the user learns of the release, holder included.
    expect(a.ofType("lease.released")).toEqual([
      { t: "lease.released", spaceId: "s1", originId },
    ]);
    expect(b.ofType("lease.released")).toEqual([
      { t: "lease.released", spaceId: "s1", originId },
    ]);

    const retry = { ...foreign, hlc: makeHlc(12, "dev-b") };
    await core.handleMessage(b, frame({ t: "publish", records: [retry] }), [a]);
    expect(b.ofType("publish.ack")[1]?.accepted).toEqual([retry.recordId]);
  });

  it("ignores release from a device that does not hold the lease", async () => {
    const { core, clock } = makeFixture();
    const a = new FakeConnection();
    const b = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);
    await sendHello(core, b, "dev-b", ["s1"], [a]);

    await core.handleMessage(
      a,
      frame({ t: "lease.acquire", spaceId: "s1", originId }),
      [b],
    );
    await core.handleMessage(
      b,
      frame({ t: "lease.release", spaceId: "s1", originId }),
      [a],
    );
    expect(a.ofType("lease.released")).toHaveLength(0);
    expect(b.ofType("lease.released")).toHaveLength(0);

    clock.nowMs += 1;
    await core.handleMessage(
      b,
      frame({ t: "lease.acquire", spaceId: "s1", originId }),
      [a],
    );
    expect(b.ofType("lease.denied")[0]?.holderDeviceId).toBe("dev-a");
  });

  it("releases a device's leases when its last socket closes and tells the peers", async () => {
    const { core } = makeFixture();
    const a = new FakeConnection();
    const b = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);
    await sendHello(core, b, "dev-b", ["s1"], [a]);
    await core.handleMessage(
      a,
      frame({ t: "lease.acquire", spaceId: "s1", originId }),
      [b],
    );
    await core.handleMessage(
      a,
      frame({ t: "lease.acquire", spaceId: "s1", originId: otherOrigin }),
      [b],
    );

    b.clear();
    await core.handleClose(a, [b]);
    expect(b.ofType("lease.released").map((m) => m.originId).sort()).toEqual(
      [originId, otherOrigin].sort(),
    );

    await core.handleMessage(
      b,
      frame({ t: "lease.acquire", spaceId: "s1", originId }),
      [],
    );
    expect(b.ofType("lease.granted")[0]?.holderDeviceId).toBe("dev-b");
    expect(b.ofType("lease.denied")).toHaveLength(0);
  });

  it("a duplicate socket closing does not release the device's leases", async () => {
    const { core } = makeFixture();
    const a = new FakeConnection();
    const a2 = new FakeConnection();
    const b = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);
    await sendHello(core, b, "dev-b", ["s1"], [a]);
    await sendHello(core, a2, "dev-a", ["s1"], [a, b]);
    await core.handleMessage(
      a2,
      frame({ t: "lease.acquire", spaceId: "s1", originId }),
      [a, b],
    );

    b.clear();
    await core.handleClose(a, [a2, b]);
    expect(b.ofType("lease.released")).toHaveLength(0);
    await core.handleMessage(
      b,
      frame({ t: "lease.acquire", spaceId: "s1", originId }),
      [a2],
    );
    expect(b.ofType("lease.denied")[0]?.holderDeviceId).toBe("dev-a");
  });
});

describe("exclusive leases", () => {
  it("a desktop's exclusive:true is granted non-exclusive and stays force-takeable", async () => {
    const { core, clock } = makeFixture();
    const a = new FakeConnection();
    const b = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);
    await sendHello(core, b, "dev-b", ["s1"], [a]);

    await core.handleMessage(
      a,
      frame({ t: "lease.acquire", spaceId: "s1", originId, exclusive: true }),
      [b],
    );
    const granted = a.ofType("lease.granted")[0];
    expect(granted?.exclusive).toBe(false);
    expect(granted?.expiresAtMs).toBe(clock.nowMs + ORIGIN_LEASE_TTL_MS);

    await core.handleMessage(
      b,
      frame({ t: "lease.acquire", spaceId: "s1", originId }),
      [a],
    );
    expect(b.ofType("lease.denied")[0]?.exclusive).toBe(false);

    // The holder is connected, yet the lease is ordinary: force wins.
    await core.handleMessage(
      b,
      frame({
        t: "lease.acquire",
        spaceId: "s1",
        originId,
        force: true,
        recordId: hex64(1),
        candidateHlc: makeHlc(2, "dev-b"),
      }),
      [a],
    );
    expect(b.ofType("lease.granted")[0]?.holderDeviceId).toBe("dev-b");
    expect(a.ofType("lease.revoked")[0]?.newHolderDeviceId).toBe("dev-b");
  });

  it("a cloud device gets an exclusive lease with the exclusive TTL and clamp", async () => {
    const { core, clock } = makeFixture();
    const c = new FakeConnection();
    await sendHello(core, c, "dev-c", ["s1"], [], "cloud");

    await core.handleMessage(
      c,
      frame({ t: "lease.acquire", spaceId: "s1", originId, exclusive: true }),
      [],
    );
    const granted = c.ofType("lease.granted")[0];
    expect(granted?.exclusive).toBe(true);
    expect(granted?.expiresAtMs).toBe(clock.nowMs + EXCLUSIVE_LEASE_TTL_MS);

    // Requested TTLs never exceed the exclusive cap.
    clock.nowMs += 1;
    await core.handleMessage(
      c,
      frame({
        t: "lease.acquire",
        spaceId: "s1",
        originId,
        exclusive: true,
        ttlMs: MAX_LEASE_TTL_MS * 10,
      }),
      [],
    );
    expect(c.ofType("lease.granted")[1]?.expiresAtMs).toBe(
      clock.nowMs + EXCLUSIVE_LEASE_TTL_MS,
    );

    // A cloud device that does not ask for exclusivity gets an ordinary lease.
    clock.nowMs += 1;
    await core.handleMessage(
      c,
      frame({ t: "lease.acquire", spaceId: "s1", originId: otherOrigin }),
      [],
    );
    const plain = c.ofType("lease.granted")[2];
    expect(plain?.exclusive).toBe(false);
    expect(plain?.expiresAtMs).toBe(clock.nowMs + ORIGIN_LEASE_TTL_MS);
  });

  it("denials name the cloud holder and forced takeover fails while its socket is open", async () => {
    const { core } = makeFixture();
    const c = new FakeConnection();
    const b = new FakeConnection();
    await sendHello(core, c, "dev-c", ["s1"], [], "cloud");
    await sendHello(core, b, "dev-b", ["s1"], [c]);

    await core.handleMessage(
      c,
      frame({ t: "lease.acquire", spaceId: "s1", originId, exclusive: true }),
      [b],
    );

    await core.handleMessage(
      b,
      frame({ t: "lease.acquire", spaceId: "s1", originId }),
      [c],
    );
    const denied = b.ofType("lease.denied")[0];
    expect(denied?.holderDeviceId).toBe("dev-c");
    expect(denied?.holderKind).toBe("cloud");
    expect(denied?.exclusive).toBe(true);

    const takeover = frame({
      t: "lease.acquire",
      spaceId: "s1",
      originId,
      force: true,
      recordId: hex64(1),
      candidateHlc: makeHlc(2, "dev-b"),
    });
    await core.handleMessage(b, takeover, [c]);
    expect(b.ofType("lease.denied")).toHaveLength(2);
    expect(b.ofType("lease.denied")[1]?.exclusive).toBe(true);
    expect(b.ofType("lease.granted")).toHaveLength(0);
    expect(c.ofType("lease.revoked")).toHaveLength(0);

    // The holder's socket is gone but its lease entry is still live (a crash
    // that skipped close): forced takeover proceeds under the usual rule.
    await core.handleMessage(b, takeover, []);
    expect(b.ofType("lease.granted")[0]?.holderDeviceId).toBe("dev-b");
    expect(b.ofType("lease.granted")[0]?.exclusive).toBe(false);
  });

  it("an exclusive lease expires unrenewed at EXCLUSIVE_LEASE_TTL_MS and a holder re-acquire extends it", async () => {
    const { core, clock } = makeFixture();
    const c = new FakeConnection();
    const b = new FakeConnection();
    await sendHello(core, c, "dev-c", ["s1"], [], "cloud");
    await sendHello(core, b, "dev-b", ["s1"], [c]);

    const start = clock.nowMs;
    await core.handleMessage(
      c,
      frame({ t: "lease.acquire", spaceId: "s1", originId, exclusive: true }),
      [b],
    );

    clock.nowMs = start + EXCLUSIVE_LEASE_TTL_MS - 1;
    await core.handleMessage(
      b,
      frame({ t: "lease.acquire", spaceId: "s1", originId }),
      [c],
    );
    expect(b.ofType("lease.denied")).toHaveLength(1);

    // Renewal from the holder: never denied, expiry moves forward.
    await core.handleMessage(
      c,
      frame({ t: "lease.acquire", spaceId: "s1", originId, exclusive: true }),
      [b],
    );
    const renewed = c.ofType("lease.granted")[1];
    expect(renewed?.exclusive).toBe(true);
    expect(renewed?.expiresAtMs).toBe(clock.nowMs + EXCLUSIVE_LEASE_TTL_MS);
    expect(c.ofType("lease.denied")).toHaveLength(0);

    // Past the original expiry the renewed lease still holds …
    clock.nowMs = start + EXCLUSIVE_LEASE_TTL_MS + 1;
    await core.handleMessage(
      b,
      frame({ t: "lease.acquire", spaceId: "s1", originId }),
      [c],
    );
    expect(b.ofType("lease.denied")).toHaveLength(2);
    expect(b.ofType("lease.granted")).toHaveLength(0);

    // … and lapses once the renewed window passes without another renewal.
    clock.nowMs = renewed?.expiresAtMs === undefined ? 0 : renewed.expiresAtMs + 1;
    await core.handleMessage(
      b,
      frame({ t: "lease.acquire", spaceId: "s1", originId }),
      [c],
    );
    expect(b.ofType("lease.granted")[0]?.holderDeviceId).toBe("dev-b");
  });

  it("rejects a publish under a foreign exclusive lease with exclusive_lease", async () => {
    const { core } = makeFixture();
    const c = new FakeConnection();
    const b = new FakeConnection();
    await sendHello(core, c, "dev-c", ["s1"], [], "cloud");
    await sendHello(core, b, "dev-b", ["s1"], [c]);

    await core.handleMessage(
      c,
      frame({ t: "lease.acquire", spaceId: "s1", originId, exclusive: true }),
      [b],
    );
    const blocked = makeRecord({ spaceId: "s1", originId, hlc: makeHlc(10, "dev-b") });
    const free = makeRecord({ spaceId: "s1", originId: otherOrigin, hlc: makeHlc(11, "dev-b") });
    await core.handleMessage(b, frame({ t: "publish", records: [blocked, free] }), [c]);
    const ack = b.ofType("publish.ack")[0];
    expect(ack?.rejected).toEqual([{ recordId: blocked.recordId, reason: "exclusive_lease" }]);
    expect(ack?.accepted).toEqual([free.recordId]);
    expect(c.ofType("records")[0]?.records).toEqual([free]);

    // The exclusive holder publishes freely.
    const own = makeRecord({ spaceId: "s1", originId, hlc: makeHlc(12, "dev-c") });
    await core.handleMessage(c, frame({ t: "publish", records: [own] }), [b]);
    expect(c.ofType("publish.ack")[0]?.accepted).toEqual([own.recordId]);
  });

  it("releaseLeases narrows by space and origin and broadcasts each release", async () => {
    const { core } = makeFixture();
    const c = new FakeConnection();
    const b = new FakeConnection();
    await sendHello(core, c, "dev-c", ["s1", "s2"], [], "cloud");
    await sendHello(core, b, "dev-b", ["s1", "s2"], [c]);
    for (const [spaceId, origin] of [
      ["s1", originId],
      ["s1", otherOrigin],
      ["s2", originId],
    ] as const) {
      await core.handleMessage(
        c,
        frame({ t: "lease.acquire", spaceId, originId: origin, exclusive: true }),
        [b],
      );
    }

    b.clear();
    c.clear();
    await core.releaseLeases("dev-c", { spaceId: "s1", originIds: [originId] }, [c, b]);
    expect(b.ofType("lease.released")).toEqual([
      { t: "lease.released", spaceId: "s1", originId },
    ]);
    expect(c.ofType("lease.released")).toEqual([
      { t: "lease.released", spaceId: "s1", originId },
    ]);

    b.clear();
    await core.releaseLeases("dev-c", { spaceId: "s1" }, [c, b]);
    expect(b.ofType("lease.released")).toEqual([
      { t: "lease.released", spaceId: "s1", originId: otherOrigin },
    ]);

    // Another device's filter matches nothing held by it.
    b.clear();
    await core.releaseLeases("dev-b", {}, [c, b]);
    expect(b.ofType("lease.released")).toHaveLength(0);

    b.clear();
    await core.releaseLeases("dev-c", {}, [c, b]);
    expect(b.ofType("lease.released")).toEqual([
      { t: "lease.released", spaceId: "s2", originId },
    ]);
    await core.handleMessage(
      b,
      frame({ t: "lease.acquire", spaceId: "s2", originId }),
      [c],
    );
    expect(b.ofType("lease.granted")[0]?.holderDeviceId).toBe("dev-b");
  });
});
