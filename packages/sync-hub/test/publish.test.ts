import {
  MAX_CLOCK_DRIFT_MS,
  MAX_MUTATIONS_PER_ORIGIN_PER_MINUTE,
  encodeHlc,
} from "@pistachio/sync-protocol";
import { describe, expect, it } from "vitest";
import { HISTORY_PRUNE_BATCH, HubCore, MAX_RECORD_HISTORY } from "../src/hub-core.js";
import {
  CountingHubStorage,
  FakeConnection,
  bind,
  frame,
  hex64,
  makeFixture,
  makeHlc,
  makeRecord,
  sendHello,
} from "./helpers.js";

describe("publish", () => {
  it("accepts a fresh record, acks it, and broadcasts to peers in the same space", async () => {
    const { core } = makeFixture();
    const a = new FakeConnection();
    const b = new FakeConnection();
    const c = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);
    await sendHello(core, b, "dev-b", ["s1"], [a]);
    await sendHello(core, c, "dev-c", ["s2"], [a, b]);

    const record = makeRecord({ spaceId: "s1", hlc: makeHlc(10, "dev-a") });
    await core.handleMessage(a, frame({ t: "publish", records: [record] }), [b, c]);

    const acks = a.ofType("publish.ack");
    expect(acks).toHaveLength(1);
    expect(acks[0]?.accepted).toEqual([record.recordId]);
    expect(acks[0]?.rejected).toEqual([]);

    const fanout = b.ofType("records");
    expect(fanout).toHaveLength(1);
    expect(fanout[0]?.spaceId).toBe("s1");
    expect(fanout[0]?.records).toEqual([record]);
    // deviceSig echoed through untouched
    expect(fanout[0]?.records[0]?.deviceSig).toBe(record.deviceSig);
    expect(c.ofType("records")).toHaveLength(0);
  });

  it("rejects stale writes (stored HLC >= incoming) without broadcasting", async () => {
    const { core } = makeFixture();
    const a = new FakeConnection();
    const b = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);
    await sendHello(core, b, "dev-b", ["s1"], [a]);

    const newer = makeRecord({ spaceId: "s1", hlc: makeHlc(20, "dev-a") });
    await core.handleMessage(a, frame({ t: "publish", records: [newer] }), [b]);
    b.clear();

    const stale = { ...newer, hlc: makeHlc(15, "dev-a") };
    await core.handleMessage(a, frame({ t: "publish", records: [stale] }), [b]);
    const ack = a.ofType("publish.ack")[1];
    expect(ack?.accepted).toEqual([]);
    expect(ack?.rejected).toEqual([{ recordId: newer.recordId, reason: "stale" }]);
    expect(b.ofType("records")).toHaveLength(0);

    const equal = { ...newer };
    await core.handleMessage(a, frame({ t: "publish", records: [equal] }), [b]);
    expect(a.ofType("publish.ack")[2]?.rejected[0]?.reason).toBe("stale");
  });

  it("rejects records for spaces not declared in hello", async () => {
    const { core } = makeFixture();
    const a = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);

    const record = makeRecord({ spaceId: "s2", hlc: makeHlc(10, "dev-a") });
    await core.handleMessage(a, frame({ t: "publish", records: [record] }), []);
    const ack = a.ofType("publish.ack")[0];
    expect(ack?.accepted).toEqual([]);
    expect(ack?.rejected).toEqual([{ recordId: record.recordId, reason: "malformed" }]);
  });

  it("rejects a foreign HLC, and a runaway clock retryably, but keeps a legitimately clamped one", async () => {
    const { core, clock } = makeFixture();
    const a = new FakeConnection();
    const b = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);
    await sendHello(core, b, "dev-b", ["s1"], [a]);

    // Signing is verified by peers against the key `hlc.deviceId` names, so a
    // record stamped with someone else's id could never verify anywhere.
    const foreign = makeRecord({ spaceId: "s1", hlc: makeHlc(clock.nowMs, "dev-b") });
    // `HlcClock.receive` clamps a peer's timestamp to exactly
    // `wall + MAX_CLOCK_DRIFT_MS`, so a device that merged from a fast peer
    // legitimately publishes AT that ceiling — even a hub running slightly
    // behind must still store it.
    const clamped = makeRecord({
      spaceId: "s1",
      hlc: makeHlc(clock.nowMs + MAX_CLOCK_DRIFT_MS, "dev-a"),
    });
    const stillFine = makeRecord({
      spaceId: "s1",
      hlc: makeHlc(clock.nowMs + MAX_CLOCK_DRIFT_MS + 1_000, "dev-a"),
    });
    // Twice the drift window is a clock no merge can explain.
    const runaway = makeRecord({
      spaceId: "s1",
      hlc: makeHlc(clock.nowMs + 2 * MAX_CLOCK_DRIFT_MS + 1, "dev-a"),
    });
    await core.handleMessage(
      a,
      frame({ t: "publish", records: [foreign, clamped, stillFine, runaway] }),
      [b],
    );

    expect(a.ofType("publish.ack")[0]).toMatchObject({
      accepted: [clamped.recordId, stillFine.recordId],
      rejected: [
        { recordId: foreign.recordId, reason: "malformed" },
        // Retryable: the writer is authentic and the record well-formed, so
        // the engine re-queues rather than dropping it (isRetryableRejection).
        { recordId: runaway.recordId, reason: "clock_drift" },
      ],
    });
    expect(b.ofType("records")[0]?.records).toEqual([clamped, stillFine]);
  });

  it("requires hello before publish, even on a bound socket", async () => {
    const { core } = makeFixture();
    const a = bind(new FakeConnection(), "dev-a");
    const record = makeRecord({ spaceId: "s1", hlc: makeHlc(10, "dev-a") });
    await core.handleMessage(a, frame({ t: "publish", records: [record] }), []);
    expect(a.ofType("error")[0]?.code).toBe("hello_required");
    expect(a.ofType("publish.ack")).toHaveLength(0);
    expect(a.closed).toEqual([]);
  });

  it("keeps the socket open on malformed frames and answers with an error frame", async () => {
    const { core } = makeFixture();
    const a = bind(new FakeConnection(), "dev-a");
    await core.handleMessage(a, "not json", []);
    await core.handleMessage(a, JSON.stringify({ t: "publish", records: [] }), []);
    const errors = a.ofType("error");
    expect(errors).toHaveLength(2);
    expect(errors.every((e) => e.code === "malformed")).toBe(true);
    expect(a.closed).toEqual([]);
  });

  it("rate limits per (device, origin) past the per-minute cap, then recovers", async () => {
    const { core, clock } = makeFixture();
    const a = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);

    const originId = hex64(0xbeef);
    const cap = MAX_MUTATIONS_PER_ORIGIN_PER_MINUTE;
    const batch = Array.from({ length: cap }, (_, i) =>
      makeRecord({ spaceId: "s1", originId, hlc: makeHlc(100 + i, "dev-a") }),
    );
    await core.handleMessage(a, frame({ t: "publish", records: batch }), []);
    expect(a.ofType("publish.ack")[0]?.accepted).toHaveLength(cap);
    expect(a.ofType("error")).toHaveLength(0);

    const over = makeRecord({ spaceId: "s1", originId, hlc: makeHlc(1000, "dev-a") });
    await core.handleMessage(a, frame({ t: "publish", records: [over] }), []);
    // `rate_limited`, never `stale`: the hub stored nothing, so the client
    // must re-queue instead of treating the ack as a durability confirmation.
    expect(a.ofType("publish.ack")[1]?.rejected).toEqual([
      { recordId: over.recordId, reason: "rate_limited" },
    ]);
    expect(a.ofType("error")[0]?.code).toBe("rate_limited");

    // A different origin from the same device is unaffected.
    const otherOrigin = makeRecord({
      spaceId: "s1",
      originId: hex64(0xf00d),
      hlc: makeHlc(1001, "dev-a"),
    });
    await core.handleMessage(a, frame({ t: "publish", records: [otherOrigin] }), []);
    expect(a.ofType("publish.ack")[2]?.accepted).toEqual([otherOrigin.recordId]);

    // Window slides: a minute later the origin accepts again.
    clock.nowMs += 61_000;
    const later = makeRecord({ spaceId: "s1", originId, hlc: makeHlc(2000, "dev-a") });
    await core.handleMessage(a, frame({ t: "publish", records: [later] }), []);
    expect(a.ofType("publish.ack")[3]?.accepted).toEqual([later.recordId]);
  });

  it("reads each lease and record once per publish and never lists a whole history", async () => {
    const storage = new CountingHubStorage();
    const clock = { nowMs: 1_000_000 };
    const core = new HubCore(storage, () => clock.nowMs);
    const a = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);
    const originId = hex64(0xbeef);
    // Well under MAX_MUTATIONS_PER_ORIGIN_PER_MINUTE so every record is taken.
    const records = Array.from({ length: 20 }, (_, i) =>
      makeRecord({ spaceId: "s1", originId, hlc: makeHlc(1000 + i, "dev-a") }),
    );
    storage.clearLog();
    await core.handleMessage(a, frame({ t: "publish", records }), []);
    expect(a.ofType("publish.ack")[0]?.accepted).toHaveLength(records.length);

    // One origin, one lease read and one rate-window read for the batch.
    expect(storage.countGets("lease:")).toBe(1);
    expect(storage.countGets("rl:")).toBe(1);
    // Distinct records, so one read each — and no re-read after the write.
    expect(storage.countGets("rec:")).toBe(records.length);
    // Every history listing is capped; none of them walks a full prefix.
    expect(storage.lists.length).toBe(records.length);
    for (const listed of storage.lists) {
      expect(listed.prefix.startsWith("hist:s1:")).toBe(true);
      expect(listed.limit).toBe(MAX_RECORD_HISTORY + HISTORY_PRUNE_BATCH);
      expect(listed.size).toBeLessThanOrEqual(MAX_RECORD_HISTORY + HISTORY_PRUNE_BATCH);
    }
  });

  it("re-reads nothing when one publish carries two versions of the same record", async () => {
    const storage = new CountingHubStorage();
    const core = new HubCore(storage, () => 1_000_000);
    const a = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);
    const first = makeRecord({ spaceId: "s1", hlc: makeHlc(1000, "dev-a") });
    const second = { ...first, hlc: makeHlc(1001, "dev-a") };
    const stale = { ...first, hlc: makeHlc(999, "dev-a") };
    storage.clearLog();
    await core.handleMessage(a, frame({ t: "publish", records: [first, second, stale] }), []);
    const ack = a.ofType("publish.ack")[0];
    expect(ack?.accepted).toEqual([first.recordId, first.recordId]);
    expect(ack?.rejected).toEqual([{ recordId: first.recordId, reason: "stale" }]);
    // The cache carries the version just written, so the third record is
    // judged stale without another read.
    expect(storage.countGets("rec:")).toBe(1);
  });

  it("drains a history backlog wider than one prune batch", async () => {
    const { core, storage } = makeFixture();
    const a = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);
    const record = makeRecord({ spaceId: "s1", hlc: makeHlc(1000, "dev-a") });
    const prefix = `hist:s1:${record.recordId}:`;
    // Far more versions than one capped listing can see at once.
    const backlog = MAX_RECORD_HISTORY + HISTORY_PRUNE_BATCH * 3;
    for (let i = 0; i < backlog; i += 1) {
      const hlc = makeHlc(100 + i, "dev-a");
      await storage.put(`${prefix}${encodeHlc(hlc)}`, { ...record, hlc });
    }
    await core.handleMessage(a, frame({ t: "publish", records: [record] }), []);
    expect(a.ofType("publish.ack")[0]?.accepted).toEqual([record.recordId]);
    const kept = await storage.list({ prefix });
    expect(kept.size).toBe(MAX_RECORD_HISTORY);
    // The newest version — the one just published — survives the drain.
    expect([...kept.keys()].at(-1)).toBe(`${prefix}${encodeHlc(record.hlc)}`);
  });

  it("answers ping with pong", async () => {
    const { core } = makeFixture();
    const a = new FakeConnection();
    await sendHello(core, a, "dev-a", []);
    await core.handleMessage(a, frame({ t: "ping" }), []);
    expect(a.last()).toEqual({ t: "pong" });
  });
});
