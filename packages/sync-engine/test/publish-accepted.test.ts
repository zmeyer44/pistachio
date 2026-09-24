/**
 * `publish.ack.accepted` (cloud-sync-design §3): the hub's exact durability
 * signal. Before it existed the engine guessed, un-publishing a bounded
 * window of in-flight wires on every rejection because it could not tell an
 * accepted version from a refused one.
 */

import { describe, expect, it } from "vitest";
import { makeVersionToken } from "@pistachio/sync-protocol";
import { DeviceRegistryVerifier } from "../src/index.js";
import {
  attrsFor,
  createEngine,
  makeIdentity,
  ManualClock,
  must,
  testKeypair,
} from "./helpers.js";

const plain = (spaceId: string): ReturnType<typeof makeIdentity> =>
  makeIdentity(spaceId, "github.com", "sid");

describe("publish acceptance", () => {
  it("keeps an accepted version a legal wire parent when the next publish is refused", async () => {
    // v0 is acknowledged, v1 is not. Without the accept signal the rejection
    // of v1 un-publishes the whole in-flight window — v0 included — and the
    // retry names an ancestor (or null) the peer cannot connect to the chain
    // it already applied.
    const spaceId = "space-accept-parent";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);
    const verifier = new DeviceRegistryVerifier("reject");
    verifier.addDevice("dev-a", (await testKeypair()).publicKey);
    const p = await createEngine(spaceId, "dev-p", clock, { verifier });
    const identity = plain(spaceId);

    clock.tick(1);
    const v0 = must(
      await a.engine.localChange(identity, attrsFor("v0"), false, "explicit"),
    );
    expect(await p.engine.applyRemote([v0])).toEqual(["applied"]);
    a.engine.publishAccepted([v0.recordId]);

    clock.tick(1);
    const v1 = must(
      await a.engine.localChange(identity, attrsFor("v1"), false, "overwrite"),
    );
    expect(v1.causalParent).toBe(makeVersionToken(v0.recordId, v0.hlc));

    // The hub throttled v1: nothing stored, so it is re-queued in the
    // default lane and flushed by the host's retry tick.
    await a.engine.publishRejected(v1.recordId, "rate_limited");
    expect(a.engine.queueDepth).toBe(1);
    await a.engine.flushPending();

    const retried = must(a.transport.published.at(-1));
    expect(retried.hlc).toEqual(v1.hlc);
    expect(retried.causalParent).toBe(makeVersionToken(v0.recordId, v0.hlc));
    expect(await p.engine.applyRemote([retried])).toEqual(["applied"]);
    expect(p.engine.listLiveCookies().map((c) => c.attributes?.value)).toEqual([
      "v1",
    ]);
  });

  it("consumes the in-flight window in ack order, so a burst mixes accepts and rejections exactly", async () => {
    // v0 and v1 are in flight together; the hub accepts v0 and refuses v1.
    // Only v1 may lose its published mark.
    const spaceId = "space-accept-order";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);
    const identity = plain(spaceId);

    clock.tick(1);
    const v0 = must(
      await a.engine.localChange(identity, attrsFor("v0"), false, "explicit"),
    );
    clock.tick(1);
    const v1 = must(
      await a.engine.localChange(identity, attrsFor("v1"), false, "overwrite"),
    );
    a.engine.publishAccepted([v0.recordId]);
    await a.engine.publishRejected(v1.recordId, "rate_limited");
    await a.engine.flushPending();

    const retried = must(a.transport.published.at(-1));
    expect(retried.hlc).toEqual(v1.hlc);
    expect(retried.causalParent).toBe(makeVersionToken(v0.recordId, v0.hlc));
  });

  it("un-publishes every unacknowledged version of a burst deeper than four", async () => {
    // The old window was capped at four wires per record, so the oldest of a
    // deeper burst silently kept a published mark the hub never earned. With
    // acks retiring entries the window needs no cap, and a rejection reaches
    // the whole burst: nothing was acknowledged, so no version of it is a
    // legal parent.
    const spaceId = "space-accept-burst";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);
    const identity = plain(spaceId);

    let last = null as Awaited<ReturnType<typeof a.engine.localChange>>;
    for (let i = 0; i < 6; i += 1) {
      clock.tick(1);
      last = await a.engine.localChange(
        identity,
        attrsFor(`v${i}`),
        false,
        i === 0 ? "explicit" : "overwrite",
      );
    }
    const v5 = must(last);
    expect(a.transport.published).toHaveLength(6);

    await a.engine.publishRejected(v5.recordId, "rate_limited");
    await a.engine.flushPending();

    const retried = must(a.transport.published.at(-1));
    expect(retried.hlc).toEqual(v5.hlc);
    expect(retried.causalParent).toBeNull();
  });

  it("still refuses to un-publish the newest deletion fence a rejection cannot speak for", async () => {
    // `onPublishInterrupted` and a `stale` ack both report records the hub
    // may well hold, so the fence bound stays: the logout keeps its mark and
    // the retry names it.
    const spaceId = "space-accept-fence";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);
    const identity = plain(spaceId);

    clock.tick(1);
    await a.engine.localChange(identity, attrsFor("v0"), false, "explicit");
    clock.tick(1);
    const logout = must(
      await a.engine.localChange(identity, null, true, "explicit"),
    );
    clock.tick(1);
    const login = must(
      await a.engine.localChange(identity, attrsFor("login"), false, "explicit"),
    );

    await a.engine.publishRejected(login.recordId, "rate_limited");
    await a.engine.flushPending();

    const retried = must(a.transport.published.at(-1));
    expect(retried.hlc).toEqual(login.hlc);
    expect(retried.causalParent).toBe(
      makeVersionToken(logout.recordId, logout.hlc),
    );
  });
});
