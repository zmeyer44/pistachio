import {
  FRAME_BUDGET_BYTES,
  MAX_CLOCK_DRIFT_MS,
  MAX_FRAME_BYTES,
  workspaceRecordBytes,
} from "@pistachio/sync-protocol";
import { describe, expect, it } from "vitest";
import {
  FakeConnection,
  frame,
  makeFixture,
  makeHlc,
  makeWorkspaceDoc,
  sendHello,
} from "./helpers.js";

describe("workspace sync", () => {
  it("applies LWW per key: newer wins, older loses, only winners broadcast", async () => {
    const { core } = makeFixture();
    const a = new FakeConnection();
    const b = new FakeConnection();
    await sendHello(core, a, "dev-a", []);
    await sendHello(core, b, "dev-b", [], [a]);

    const v1 = makeWorkspaceDoc({ key: "space:1", hlc: makeHlc(20, "dev-a") });
    await core.handleMessage(a, frame({ t: "workspace.publish", docs: [v1] }), [b]);
    expect(b.ofType("workspace.records")[0]?.docs).toEqual([v1]);

    // Older write for the same key loses — no broadcast at all.
    b.clear();
    const stale = makeWorkspaceDoc({
      key: "space:1",
      sealedValue: "b2xk",
      hlc: makeHlc(10, "dev-b"),
    });
    await core.handleMessage(b, frame({ t: "workspace.publish", docs: [stale] }), [a]);
    expect(a.ofType("workspace.records")).toHaveLength(0);

    // Newer write wins and is broadcast; a mixed batch broadcasts winners only.
    const v2 = makeWorkspaceDoc({
      key: "space:1",
      sealedValue: "bmV3",
      hlc: makeHlc(30, "dev-b"),
    });
    const loser = makeWorkspaceDoc({
      key: "space:1",
      hlc: makeHlc(25, "dev-b"),
    });
    const fresh = makeWorkspaceDoc({ key: "settings:keyMode", hlc: makeHlc(5, "dev-b") });
    await core.handleMessage(
      b,
      frame({ t: "workspace.publish", docs: [v2, loser, fresh] }),
      [a],
    );
    expect(a.ofType("workspace.records")[0]?.docs).toEqual([v2, fresh]);

    // Hydration returns the winning versions.
    const c = new FakeConnection();
    await sendHello(core, c, "dev-c", [], [a, b]);
    await core.handleMessage(c, frame({ t: "workspace.hydrate", sinceHlc: null }), [a, b]);
    const docs = c.ofType("workspace.records").flatMap((f) => f.docs);
    expect(docs).toEqual([
      makeWorkspaceDoc({ key: "settings:keyMode", hlc: makeHlc(5, "dev-b") }),
      v2,
    ]);
    expect(c.ofType("workspace.hydrate.done")[0]?.count).toBe(2);
  });

  it("splits workspace hydration by bytes so an artifact library fits the frame cap", async () => {
    const { core } = makeFixture();
    const a = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);

    // Ten sealed artifacts at ~2 MB each: one frame by doc count, and over
    // the socket's maxPayload.
    const docs = Array.from({ length: 10 }, (_, i) =>
      makeWorkspaceDoc({
        key: `artifact:${String(i)}`,
        hlc: makeHlc(100 + i, "dev-a"),
        sealedValue: "a".repeat(2_000_000),
      }),
    );
    await core.handleMessage(a, frame({ t: "workspace.publish", docs }), []);

    const b = new FakeConnection();
    await sendHello(core, b, "dev-b", ["s1"], [a]);
    await core.handleMessage(b, frame({ t: "workspace.hydrate", sinceHlc: null }), [a]);

    const frames = b.ofType("workspace.records");
    expect(frames.length).toBeGreaterThan(1);
    for (const f of frames) {
      const bytes = f.docs.reduce((sum, d) => sum + workspaceRecordBytes(d), 0);
      expect(bytes).toBeLessThanOrEqual(FRAME_BUDGET_BYTES);
    }
    expect(frames.flatMap((f) => f.docs.map((d) => d.key))).toEqual(docs.map((d) => d.key));
    expect(b.ofType("workspace.hydrate.done")[0]?.count).toBe(docs.length);
  });

  it("withholds an undeliverable doc instead of closing the hydrating socket", async () => {
    const { core } = makeFixture();
    const a = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);

    // A doc no frame can carry — an unbounded restore point, before the
    // desktop bounded them. Streaming it would close the socket with 1009
    // and strand the whole workspace lane on every reconnect.
    const huge = makeWorkspaceDoc({
      key: "device-workspace:dev-a",
      hlc: makeHlc(10, "dev-a"),
      sealedValue: "a".repeat(MAX_FRAME_BYTES + 1),
    });
    const ordinary = makeWorkspaceDoc({ key: "space:1", hlc: makeHlc(11, "dev-a") });
    await core.handleMessage(a, frame({ t: "workspace.publish", docs: [huge, ordinary] }), []);

    const b = new FakeConnection();
    await sendHello(core, b, "dev-b", ["s1"], [a]);
    await core.handleMessage(b, frame({ t: "workspace.hydrate", sinceHlc: null }), [a]);

    expect(b.ofType("workspace.records").flatMap((f) => f.docs.map((d) => d.key))).toEqual([
      "space:1",
    ]);
    expect(b.ofType("error")[0]?.code).toBe("record_too_large");
    // Counted as what actually arrived, so the client is not left waiting.
    expect(b.ofType("workspace.hydrate.done")[0]?.count).toBe(1);
    expect(b.closed).toEqual([]);
  });

  it("workspace.hydrate honors sinceHlc and tombstoned (null) values survive", async () => {
    const { core } = makeFixture();
    const a = new FakeConnection();
    await sendHello(core, a, "dev-a", []);

    const kept = makeWorkspaceDoc({ key: "space:1", hlc: makeHlc(10, "dev-a") });
    const deleted = makeWorkspaceDoc({
      key: "space:2",
      sealedValue: null,
      hlc: makeHlc(20, "dev-a"),
    });
    await core.handleMessage(a, frame({ t: "workspace.publish", docs: [kept, deleted] }), []);

    a.clear();
    await core.handleMessage(
      a,
      frame({ t: "workspace.hydrate", sinceHlc: makeHlc(10, "dev-a") }),
      [],
    );
    const docs = a.ofType("workspace.records").flatMap((f) => f.docs);
    expect(docs).toEqual([deleted]);
    expect(docs[0]?.sealedValue).toBeNull();
    expect(a.ofType("workspace.hydrate.done")[0]?.count).toBe(1);
  });

  it("refuses a doc attributed to another device, and a runaway clock", async () => {
    const { core, clock } = makeFixture();
    const a = new FakeConnection();
    const b = new FakeConnection();
    await sendHello(core, a, "dev-a", []);
    await sendHello(core, b, "dev-b", [], [a]);

    const own = makeWorkspaceDoc({ key: "space:own", hlc: makeHlc(clock.nowMs, "dev-a") });
    await core.handleMessage(a, frame({ t: "workspace.publish", docs: [own] }), [b]);

    // The hub never opens `deviceSig`, so a doc attributed to a peer would sit
    // as the stored winner while every device rejects it on signature — a key
    // nobody can update until something surpasses that HLC. A device only ever
    // publishes registers it authored (workspace-sync.ts skips merged ones
    // rather than re-signing them under the winner's id), so this is a bug or
    // an attack either way.
    const impersonating = makeWorkspaceDoc({ key: "space:theirs", hlc: makeHlc(clock.nowMs, "dev-b") });
    await core.handleMessage(a, frame({ t: "workspace.publish", docs: [impersonating] }), [b]);

    // `HlcClock.receive` clamps to exactly wall + MAX_CLOCK_DRIFT_MS, so a
    // device that merged from a fast peer legitimately sits at that ceiling.
    const clamped = makeWorkspaceDoc({
      key: "space:clamped",
      hlc: makeHlc(clock.nowMs + MAX_CLOCK_DRIFT_MS, "dev-a"),
    });
    await core.handleMessage(a, frame({ t: "workspace.publish", docs: [clamped] }), [b]);

    const runaway = makeWorkspaceDoc({
      key: "space:runaway",
      hlc: makeHlc(clock.nowMs + 2 * MAX_CLOCK_DRIFT_MS + 1, "dev-a"),
    });
    await core.handleMessage(a, frame({ t: "workspace.publish", docs: [runaway] }), [b]);

    expect(a.ofType("error").map((error) => error.code)).toEqual(["malformed", "malformed"]);
    expect(b.ofType("workspace.records").flatMap((message) => message.docs)).toEqual([own, clamped]);

    const c = new FakeConnection();
    await sendHello(core, c, "dev-c", [], [a, b]);
    await core.handleMessage(c, frame({ t: "workspace.hydrate", sinceHlc: null }), [a, b]);
    expect(c.ofType("workspace.records").flatMap((message) => message.docs)).toEqual([own, clamped]);
  });

  describe("device-scoped key ownership", () => {
    it("accepts device-workspace and device-activity docs for the sender's own id", async () => {
      const { core } = makeFixture();
      const a = new FakeConnection();
      const b = new FakeConnection();
      await sendHello(core, a, "dev-a", []);
      await sendHello(core, b, "dev-b", [], [a]);

      const own = [
        makeWorkspaceDoc({ key: "device-workspace:dev-a", hlc: makeHlc(10, "dev-a") }),
        makeWorkspaceDoc({ key: "device-activity:dev-a", hlc: makeHlc(11, "dev-a") }),
      ];
      await core.handleMessage(a, frame({ t: "workspace.publish", docs: own }), [b]);
      expect(a.ofType("error")).toHaveLength(0);
      expect(b.ofType("workspace.records")[0]?.docs).toEqual(own);
    });

    it("refuses docs naming another device with malformed and applies nothing", async () => {
      const { core } = makeFixture();
      const a = new FakeConnection();
      const b = new FakeConnection();
      await sendHello(core, a, "dev-a", []);
      await sendHello(core, b, "dev-b", [], [a]);

      const foreign = makeWorkspaceDoc({
        key: "device-workspace:dev-b",
        hlc: makeHlc(10, "dev-a"),
      });
      await core.handleMessage(a, frame({ t: "workspace.publish", docs: [foreign] }), [b]);
      expect(a.ofType("error")[0]?.code).toBe("malformed");
      expect(a.closed).toEqual([]);
      expect(b.ofType("workspace.records")).toHaveLength(0);

      const activity = makeWorkspaceDoc({
        key: "device-activity:dev-b",
        hlc: makeHlc(12, "dev-a"),
      });
      await core.handleMessage(a, frame({ t: "workspace.publish", docs: [activity] }), [b]);
      expect(a.ofType("error")).toHaveLength(2);

      // A batch mixing an owned doc with a foreign one is refused as a whole.
      const mixed = [
        makeWorkspaceDoc({ key: "space:1", hlc: makeHlc(13, "dev-a") }),
        makeWorkspaceDoc({ key: "device-workspace:dev-b", hlc: makeHlc(14, "dev-a") }),
      ];
      await core.handleMessage(a, frame({ t: "workspace.publish", docs: mixed }), [b]);
      expect(a.ofType("error")).toHaveLength(3);
      expect(b.ofType("workspace.records")).toHaveLength(0);

      const c = new FakeConnection();
      await sendHello(core, c, "dev-c", [], [a, b]);
      await core.handleMessage(c, frame({ t: "workspace.hydrate", sinceHlc: null }), [a, b]);
      expect(c.ofType("workspace.hydrate.done")[0]?.count).toBe(0);
    });

    it("compares the raw id exactly: a prefix match is not ownership", async () => {
      const { core } = makeFixture();
      const a = new FakeConnection();
      await sendHello(core, a, "dev-a", []);
      for (const key of ["device-workspace:dev-a2", "device-activity:dev-", "device-workspace:"]) {
        await core.handleMessage(
          a,
          frame({ t: "workspace.publish", docs: [makeWorkspaceDoc({ key, hlc: makeHlc(1, "dev-a") })] }),
          [],
        );
      }
      expect(a.ofType("error").map((e) => e.code)).toEqual(["malformed", "malformed", "malformed"]);
    });
  });
});
