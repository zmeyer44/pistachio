/**
 * QueueStorage file schema (cloud-sync-design §3, D16): both lanes plus the
 * HLC clock in one atomically written file; the engine restores the clock
 * before its first send and persists it after every send used for a wire.
 */

import { describe, expect, it } from "vitest";
import { compareHlc, makeVersionToken } from "@pistachio/sync-protocol";
import type { CookieRecordWire } from "@pistachio/sync-protocol";
import {
  MemoryQueueStorage,
  OfflineQueue,
  parseQueueFile,
  type LeaseDenial,
  type QueueFile,
} from "../src/index.js";
import {
  attrsFor,
  CLOUD_HOLDER,
  createEngine,
  makeIdentity,
  ManualClock,
  must,
} from "./helpers.js";

const deferToCloud = {
  deferToForeignLease: (denial: LeaseDenial): boolean =>
    denial.holderKind === "cloud",
};

describe("QueueStorage", () => {
  it("persists the HLC clock so a restarted engine never repeats a timestamp", async () => {
    const spaceId = "space-queue-clock";
    const clock = new ManualClock(); // frozen wall time across the "restart"
    const storage = new MemoryQueueStorage();
    const identity = makeIdentity(spaceId, "github.com", "sid");
    expect(storage.clock).toBeNull();

    const first = await createEngine(spaceId, "dev-a", clock, {
      queueStorage: storage,
    });
    const w1 = must(
      await first.engine.localChange(identity, attrsFor("v1"), false, "explicit"),
    );
    expect(storage.clock).toEqual(w1.hlc);
    expect(storage.toFile().clock).toEqual(w1.hlc);

    const second = await createEngine(spaceId, "dev-a", clock, {
      queueStorage: storage,
    });
    const w2 = must(
      await second.engine.localChange(identity, attrsFor("v2"), false, "explicit"),
    );
    expect(compareHlc(w2.hlc, w1.hlc)).toBeGreaterThan(0);
    expect(w2.hlc).toEqual({
      physicalMs: w1.hlc.physicalMs,
      logical: w1.hlc.logical + 1,
      deviceId: "dev-a",
    });
    expect(storage.clock).toEqual(w2.hlc);

    // Without the persisted clock the restarted engine would reissue w1's HLC.
    const amnesiac = await createEngine(spaceId, "dev-a", clock);
    const w3 = must(
      await amnesiac.engine.localChange(identity, attrsFor("v3"), false, "explicit"),
    );
    expect(w3.hlc).toEqual(w1.hlc);
  });

  it("keeps the lanes apart in the file shape and reports every mutation", async () => {
    const spaceId = "space-queue-file";
    const clock = new ManualClock();
    const changes: QueueFile[] = [];
    const storage = new MemoryQueueStorage(null, (file) => changes.push(file));
    const a = await createEngine(spaceId, "dev-a", clock, {
      queueStorage: storage,
      ...deferToCloud,
    });

    a.engine.setOnline(false);
    clock.tick(1);
    const offline = must(
      await a.engine.localChange(
        makeIdentity(spaceId, "github.com", "sid"),
        attrsFor("offline"),
        false,
        "explicit",
      ),
    );
    expect(storage.toFile()).toEqual({
      version: 1,
      clock: offline.hlc,
      offline: [offline],
      deferred: [],
    });
    a.engine.setOnline(true);
    await a.engine.flushPending();
    expect(a.transport.published).toHaveLength(1);

    a.transport.leaseGranted = false;
    a.transport.denial = CLOUD_HOLDER;
    clock.tick(1);
    const deferred = must(
      await a.engine.localChange(
        makeIdentity(spaceId, "cloudflare.com", "session"),
        attrsFor("deferred"),
        false,
        "explicit",
      ),
    );
    const file = storage.toFile();
    expect(file).toEqual({
      version: 1,
      clock: deferred.hlc,
      offline: [],
      deferred: [deferred],
    });
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.at(-1)).toEqual(file);
    // Snapshots are copies: later mutations do not alter earlier reports.
    // (The very first report is the clock write that precedes the wire.)
    expect(changes[0]).toEqual({ version: 1, clock: offline.hlc, offline: [], deferred: [] });
    expect(changes.find((c) => c.offline.length > 0)?.offline).toEqual([offline]);
  });

  it("restores both lanes from a JSON round trip and drains them when the engine comes online", async () => {
    const spaceId = "space-queue-restore";
    const clock = new ManualClock();
    const storage = new MemoryQueueStorage();
    const a = await createEngine(spaceId, "dev-a", clock, {
      queueStorage: storage,
      ...deferToCloud,
    });
    const github = makeIdentity(spaceId, "github.com", "sid");
    const cloudflare = makeIdentity(spaceId, "cloudflare.com", "session");

    clock.tick(1);
    const v0 = must(
      await a.engine.localChange(github, attrsFor("v0"), false, "explicit"),
    );
    a.transport.leaseGranted = false;
    a.transport.denial = CLOUD_HOLDER;
    clock.tick(1);
    const parked = must(
      await a.engine.localChange(cloudflare, attrsFor("parked"), false, "explicit"),
    );
    a.engine.setOnline(false);
    clock.tick(1);
    must(await a.engine.localChange(github, attrsFor("q1"), false, "explicit"));
    clock.tick(1);
    const q2 = must(
      await a.engine.localChange(github, attrsFor("q2"), false, "overwrite"),
    );
    expect(a.engine.queueDepth).toBe(1);
    expect(a.engine.deferredDepth).toBe(1);

    const restoredFile = must(
      parseQueueFile(JSON.parse(JSON.stringify(storage.toFile()))),
    );
    expect(restoredFile.offline).toHaveLength(2);
    expect(restoredFile.deferred).toHaveLength(1);
    expect(restoredFile.clock).toEqual(q2.hlc);

    // "Restart": fresh engine, empty record map, same file.
    const b = await createEngine(spaceId, "dev-a", clock, {
      queueStorage: MemoryQueueStorage.fromFile(restoredFile),
    });
    expect(b.engine.queueDepth).toBe(1);
    expect(b.engine.deferredDepth).toBe(1);
    b.engine.setOnline(true);
    await b.engine.flushPending();
    await b.engine.retryDeferred();
    expect(b.engine.queueDepth).toBe(0);
    expect(b.engine.deferredDepth).toBe(0);
    const hlcs = b.transport.published.map((r) => r.hlc);
    expect(hlcs).toContainEqual(q2.hlc);
    expect(hlcs).toContainEqual(parked.hlc);
    expect(b.transport.published).toHaveLength(2);
    // The compacted offline wire was relinked when it was parked, so after
    // the restart it names the published v0, not the compacted-away q1.
    const drainedQ2 = must(
      b.transport.published.find((r) => compareHlc(r.hlc, q2.hlc) === 0),
    );
    expect(drainedQ2.causalParent).toBe(makeVersionToken(v0.recordId, v0.hlc));

    // The restarted engine's clock continues past the persisted one.
    const next = must(
      await b.engine.localChange(github, attrsFor("after"), false, "overwrite"),
    );
    expect(compareHlc(next.hlc, q2.hlc)).toBeGreaterThan(0);
  });

  it("parseQueueFile rejects malformed files and OfflineQueue honours its lane", () => {
    expect(parseQueueFile(null)).toBeNull();
    expect(parseQueueFile({ version: 2, offline: [], deferred: [] })).toBeNull();
    expect(parseQueueFile({ version: 1, offline: [], deferred: {} })).toBeNull();
    expect(
      parseQueueFile({ version: 1, clock: { physicalMs: "x" }, offline: [], deferred: [] }),
    ).toBeNull();
    expect(parseQueueFile({ version: 1, offline: [], deferred: [] })).toEqual({
      version: 1,
      clock: null,
      offline: [],
      deferred: [],
    });

    const storage = new MemoryQueueStorage();
    const deferred = new OfflineQueue(storage, "deferred");
    deferred.enqueue({
      spaceId: "s",
      recordId: "ab".repeat(32),
      originId: "cd".repeat(32),
      sealedRecord: "c2VhbGVk",
      hlc: { physicalMs: 1, logical: 0, deviceId: "dev" },
      causalParent: null,
      deviceSig: "c2ln",
      cause: "WRITE",
    });
    expect(storage.size("deferred")).toBe(1);
    expect(storage.size("offline")).toBe(0);
    expect(new OfflineQueue(storage, "offline").depth).toBe(0);
    expect(deferred.drain()).toHaveLength(1);
    expect(storage.size("deferred")).toBe(0);
  });

  it("checkout retires an entry only on settle, and never one appended after it", () => {
    // The non-destructive drain (finding V9a): the wire stays persisted until
    // its dispatch settled, and a wire shelved back mid-drain survives.
    const storage = new MemoryQueueStorage();
    const queue = new OfflineQueue(storage, "offline");
    const at = (hlc: number, value = "v"): CookieRecordWire => ({
      spaceId: "s",
      recordId: "ab".repeat(32),
      originId: "cd".repeat(32),
      sealedRecord: value,
      hlc: { physicalMs: hlc, logical: 0, deviceId: "dev" },
      causalParent: null,
      deviceSig: "c2ln",
      cause: "WRITE",
    });
    const other: CookieRecordWire = { ...at(1), recordId: "ef".repeat(32) };

    queue.enqueue(at(1));
    queue.enqueue(at(2)); // supersedes the first: same cookie, newer HLC
    queue.enqueue(other);

    const checked = queue.checkout();
    expect(checked.map((entry) => entry.record.hlc.physicalMs)).toEqual([1, 2]);
    // Nothing left storage yet — a crash here replays all of them.
    expect(storage.size("offline")).toBe(3);

    // That dispatch shelved its wire back before the entry was retired.
    queue.enqueue(at(2, "reshelved"));
    // Settling retires the compacted-away older version too, never the copy
    // that was appended after the checkout.
    must(checked[1]).settle();
    expect(storage.all("offline")).toEqual([other, at(2, "reshelved")]);

    must(checked[0]).settle();
    expect(storage.all("offline")).toEqual([at(2, "reshelved")]);
    expect(queue.depth).toBe(1);
  });
});
