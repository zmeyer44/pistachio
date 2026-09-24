/**
 * The cloud runner's retry tick (docs/cloud-sync-design.md §3, §8.3) and the
 * hub's accept signal. A record the hub rate-limited is shelved in the
 * engine's DEFAULT lane, which only a host flush drains: without a tick of
 * its own the runner would sit on a throttled cookie write for the rest of a
 * run. `publish.ack.accepted` is the other half — it tells the engine which
 * versions the hub really stored.
 */

import { randomUUID } from "node:crypto";
import { LEASE_RENEW_INTERVAL_MS, makeVersionToken, type CookieRecordWire } from "@pistachio/sync-protocol";
import {
  DeviceRegistryVerifier,
  LoopbackTransport,
  type HubTransport,
  type LeaseOutcome,
  type SyncTransport,
  type TransportEvents,
} from "@pistachio/sync-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpaceSession, UserSession, type SpaceSessionBrowser } from "../src/sync/session.js";
import { must, settle } from "./helpers/fixture-server.js";
import { attrs, identity, testSigner, testSpaceKeys, USER_A } from "./helpers/keys.js";

function fakeBrowser(): SpaceSessionBrowser {
  return {
    backend: {
      kind: "cloud",
      activeTabId: null,
      guardFor: () => null,
      listTabs: () => [],
      openTab: async () => "cloud:tab",
      closeTab: async () => undefined,
      focusTab: async () => undefined,
      navigate: async () => undefined,
      back: async () => undefined,
      forward: async () => undefined,
      reload: async () => undefined,
      inspect: async () => ({ title: "", url: "", text: "", controls: [] }),
      click: async () => undefined,
      type: async () => "",
      press: async () => undefined,
      scroll: async () => undefined,
      screenshot: async () => "data:image/png;base64,",
    },
    capture: { attach: () => undefined, seedBaseline: async () => undefined, drain: async () => undefined, detach: () => undefined },
    onTabsChanged: () => () => undefined,
    close: async () => undefined,
  };
}

describe("cloud retry tick", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-publishes a record the hub rate-limited on the renewal tick", async () => {
    const keys = await testSpaceKeys("work");
    const signer = await testSigner();
    const published: CookieRecordWire[] = [];
    const transport: SyncTransport = {
      publish: (records) => published.push(...records),
      acquireLease: async (): Promise<LeaseOutcome> => ({ granted: true, exclusive: true }),
      releaseLease: vi.fn(),
    };
    const session = new SpaceSession({
      userId: USER_A,
      spaceId: "work",
      keys,
      signer: { deviceId: signer.deviceId, privateKey: signer.privateKey },
      transport,
      browser: fakeBrowser(),
      applier: { apply: vi.fn(async () => undefined) },
      now: () => Date.now(),
    });
    session.transportState("connected");
    session.hydrated();
    await session.ready;
    session.runStarted("run-1");
    expect(session.renewing).toBe(true);

    const wire = must(await session.engine.localChange(identity("work", "shop.example", "sid"), attrs("one"), false, "explicit"));
    expect(published).toHaveLength(1);

    // The hub stored nothing: the engine shelves the record in its default
    // lane, where it waits for a host flush.
    await session.publishRejected(wire.recordId, "rate_limited");
    expect(session.engine.queueDepth).toBe(1);
    expect(published).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(LEASE_RENEW_INTERVAL_MS);
    expect(published).toHaveLength(2);
    expect(published[1]?.recordId).toBe(wire.recordId);
    expect(session.engine.queueDepth).toBe(0);

    // The tick stops with the run, like the renewal it rides on.
    session.runEnded("run-1");
    await session.publishRejected(wire.recordId, "rate_limited");
    await vi.advanceTimersByTimeAsync(LEASE_RENEW_INTERVAL_MS * 2);
    expect(published).toHaveLength(2);
    await session.close();
  });
});

describe("cloud publish acknowledgements", () => {
  it("hands the hub's accepted ids to the space engine, so a later rejection cannot retract a stored version", async () => {
    let events: TransportEvents = {};
    const deviceId = randomUUID();
    const signer = await testSigner();
    const user = new UserSession({
      userId: USER_A,
      deviceId,
      signer: { deviceId, privateKey: signer.privateKey },
      gateway: null,
      transportFactory: (handlers): HubTransport => {
        events = handlers;
        return new LoopbackTransport(deviceId, "cloud", handlers);
      },
      getToken: async () => "device-token",
      keysFor: (spaceId) => testSpaceKeys(spaceId),
      verifierFor: async () => new DeviceRegistryVerifier("reject"),
      createSpaceBrowser: async () => ({ browser: fakeBrowser(), applier: { apply: async () => undefined } }),
      onRevoked: () => undefined,
      now: () => Date.now(),
    });

    const session = await user.space("work");
    await session.ready;

    const v0 = must(await session.engine.localChange(identity("work", "shop.example", "sid"), attrs("one"), false, "explicit"));
    events.onPublishAccepted?.([v0.recordId]);
    const v1 = must(await session.engine.localChange(identity("work", "shop.example", "sid"), attrs("two"), false, "explicit"));
    expect(v1.causalParent).toBe(makeVersionToken(v0.recordId, v0.hlc));

    events.onPublishRejected?.([{ recordId: v1.recordId, reason: "rate_limited" }]);
    await settle(() => session.engine.queueDepth === 1, { turns: 200, stepMs: 0 });

    // v0 was acknowledged, so it stays the parent the retry names; only the
    // refused v1 lost its published mark.
    expect(must(session.engine.getRecord(v1.recordId)).wire.causalParent).toBe(makeVersionToken(v0.recordId, v0.hlc));
    await user.close();
  });
});
