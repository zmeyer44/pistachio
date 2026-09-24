import { TOMBSTONE_RETENTION_MS } from "@pistachio/sync-protocol";
import { describe, expect, it } from "vitest";
import {
  PRESENCE_RETENTION_MS,
  RATE_WINDOW_RETENTION_MS,
} from "../src/hub-core.js";
import {
  FakeConnection,
  frame,
  hex64,
  makeFixture,
  makeHlc,
  makeRecord,
  sendHello,
} from "./helpers.js";

const DAY = 24 * 60 * 60 * 1000;
/** A realistic epoch so HLC physical times and the clock share a scale. */
const T0 = 1_800_000_000_000;

describe("HubCore.gc", () => {
  it("prunes hist: beyond the newest version older than the retention window", async () => {
    const { core, storage, clock } = makeFixture(T0);
    const a = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);

    const base = makeRecord({ spaceId: "s1", hlc: makeHlc(T0 - 40 * DAY, "dev-a") });
    const ages = [40 * DAY, 35 * DAY, 31 * DAY, 10 * DAY, 1 * DAY];
    for (const age of ages) {
      clock.nowMs = T0 - age;
      await core.handleMessage(
        a,
        frame({ t: "publish", records: [{ ...base, hlc: makeHlc(T0 - age, "dev-a") }] }),
        [],
      );
    }
    clock.nowMs = T0;
    const before = await storage.list({ prefix: "hist:" });
    expect(before.size).toBe(ages.length);

    await core.gc(T0);
    const after = await storage.list<{ hlc: { physicalMs: number } }>({ prefix: "hist:" });
    // The newest retention-old version (31 d) stays as the causal floor; the
    // older 40 d and 35 d versions go; everything inside the window stays.
    expect([...after.values()].map((r) => T0 - r.hlc.physicalMs)).toEqual([
      31 * DAY,
      10 * DAY,
      1 * DAY,
    ]);
    // The tip is untouched.
    expect(await storage.get(`rec:s1:${base.recordId}`)).toEqual({
      ...base,
      hlc: makeHlc(T0 - 1 * DAY, "dev-a"),
    });

    // A record whose every version is stale keeps only its tip.
    const stale = makeRecord({ spaceId: "s1", originId: hex64(0x1234), hlc: makeHlc(T0 - 50 * DAY, "dev-a") });
    for (const age of [50 * DAY, 45 * DAY]) {
      clock.nowMs = T0 - age;
      await core.handleMessage(
        a,
        frame({ t: "publish", records: [{ ...stale, hlc: makeHlc(T0 - age, "dev-a") }] }),
        [],
      );
    }
    clock.nowMs = T0;
    await core.gc(T0);
    const staleHistory = await storage.list<{ hlc: { physicalMs: number } }>({
      prefix: `hist:s1:${stale.recordId}:`,
    });
    expect([...staleHistory.values()].map((r) => T0 - r.hlc.physicalMs)).toEqual([45 * DAY]);

    // Nothing is pruned before the window elapses.
    const fresh = makeRecord({ spaceId: "s1", originId: hex64(0x5678), hlc: makeHlc(T0 - 3, "dev-a") });
    for (const delta of [3, 2, 1]) {
      await core.handleMessage(
        a,
        frame({ t: "publish", records: [{ ...fresh, hlc: makeHlc(T0 - delta, "dev-a") }] }),
        [],
      );
    }
    await core.gc(T0 + TOMBSTONE_RETENTION_MS - 10);
    expect((await storage.list({ prefix: `hist:s1:${fresh.recordId}:` })).size).toBe(3);
  });

  it("drops rl: windows idle for two minutes and keeps active ones", async () => {
    const { core, storage, clock } = makeFixture(T0);
    const a = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);
    const originId = hex64(0xbeef);
    await core.handleMessage(
      a,
      frame({ t: "publish", records: [makeRecord({ spaceId: "s1", originId, hlc: makeHlc(T0, "dev-a") })] }),
      [],
    );
    expect(await storage.get(`rl:dev-a:${originId}`)).toEqual([T0]);

    clock.nowMs = T0 + 60_000;
    const other = hex64(0xf00d);
    await core.handleMessage(
      a,
      frame({
        t: "publish",
        records: [makeRecord({ spaceId: "s1", originId: other, hlc: makeHlc(T0 + 60_000, "dev-a") })],
      }),
      [],
    );

    await core.gc(T0 + RATE_WINDOW_RETENTION_MS - 1);
    expect(await storage.get(`rl:dev-a:${originId}`)).toEqual([T0]);

    await core.gc(T0 + RATE_WINDOW_RETENTION_MS + 1);
    expect(await storage.get(`rl:dev-a:${originId}`)).toBeUndefined();
    expect(await storage.get(`rl:dev-a:${other}`)).toEqual([T0 + 60_000]);
  });

  it("forgets presence of devices unseen for 30 days, never of a connected one", async () => {
    const { core, storage, clock } = makeFixture(T0);
    const a = new FakeConnection();
    const b = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);
    await sendHello(core, b, "dev-b", ["s1"], [a]);
    clock.nowMs = T0 + 1_000;
    await core.handleClose(b, [a]);

    await core.gc(T0 + PRESENCE_RETENTION_MS - 1, [a]);
    expect(await storage.get("presence:dev-b")).toBeDefined();

    await core.gc(T0 + PRESENCE_RETENTION_MS + 2_000, [a]);
    expect(await storage.get("presence:dev-b")).toBeUndefined();
    // dev-a has been connected the whole time: its presence survives even
    // though its lastSeen is just as old.
    expect(await storage.get("presence:dev-a")).toBeDefined();

    // Without the connection hint it is treated like any other stale entry.
    await core.gc(T0 + PRESENCE_RETENTION_MS + 2_000);
    expect(await storage.get("presence:dev-a")).toBeUndefined();

    // Everything else (records, leases, revocations) is untouched by gc.
    await core.handleMessage(
      a,
      frame({ t: "publish", records: [makeRecord({ spaceId: "s1", hlc: makeHlc(clock.nowMs, "dev-a") })] }),
      [],
    );
    await core.revokeDevice("dev-b", [a]);
    const keysBefore = [...(await storage.list({ prefix: "" })).keys()].filter(
      (key) => !key.startsWith("presence:") && !key.startsWith("rl:"),
    );
    await core.gc(T0 + 400 * DAY);
    const keysAfter = [...(await storage.list({ prefix: "" })).keys()].filter(
      (key) => !key.startsWith("presence:") && !key.startsWith("rl:"),
    );
    expect(keysAfter).toEqual(keysBefore);
    expect(keysAfter.some((key) => key.startsWith("rec:"))).toBe(true);
    expect(keysAfter).toContain("revoked:dev-b");
  });
});
