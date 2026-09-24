import { EXCLUSIVE_LEASE_TTL_MS, LEASE_RENEW_INTERVAL_MS } from "@pistachio/sync-protocol";
import type { LeaseAcquireOptions, LeaseOutcome, SyncTransport } from "@pistachio/sync-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpaceSession, type SpaceSessionBrowser } from "../src/sync/session.js";
import { attrs, identity, testSigner, testSpaceKeys, USER_A } from "./helpers/keys.js";

interface Acquire {
  originId: string;
  opts: LeaseAcquireOptions | undefined;
}

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

describe("cloud lease renewal", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-acquires every held origin on LEASE_RENEW_INTERVAL_MS while a run is active and releases it when the run ends", async () => {
    const keys = await testSpaceKeys("work");
    const signer = await testSigner();
    const acquires: Acquire[] = [];
    const releases: string[] = [];
    const transport: SyncTransport = {
      publish: vi.fn(),
      acquireLease: async (_spaceId, originId, opts): Promise<LeaseOutcome> => {
        acquires.push({ originId, opts });
        return { granted: true, exclusive: true };
      },
      releaseLease: (_spaceId, originId) => {
        releases.push(originId);
      },
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
    expect(session.hydrating).toBe(true);
    session.hydrated();
    await session.ready;
    expect(session.hasHydratedOnce).toBe(true);

    session.runStarted("run-1");
    expect(session.renewing).toBe(true);
    const wire = await session.engine.localChange(identity("work", "shop.example", "sid"), attrs("one"), false, "explicit");
    expect(wire).not.toBeNull();
    expect(acquires).toHaveLength(1);
    expect(acquires[0]?.opts).toEqual({ exclusive: true, ttlMs: EXCLUSIVE_LEASE_TTL_MS });
    const originId = acquires[0]?.originId ?? "";

    // A three-minute read-only run: the host timer renews past the cached grant window.
    for (let elapsed = 0; elapsed < 180_000; elapsed += LEASE_RENEW_INTERVAL_MS) {
      await vi.advanceTimersByTimeAsync(LEASE_RENEW_INTERVAL_MS);
    }
    expect(acquires.length).toBe(6);
    for (const acquire of acquires) {
      expect(acquire.originId).toBe(originId);
      expect(acquire.opts).toEqual({ exclusive: true, ttlMs: EXCLUSIVE_LEASE_TTL_MS });
    }
    // A deletion observed late in the run still publishes under the renewed grant.
    const deletion = await session.engine.localChange(identity("work", "shop.example", "sid"), null, true, "explicit");
    expect(deletion?.cause).toBe("EXPLICIT_DELETE");
    expect(acquires.length).toBe(6);

    session.runEnded("run-1");
    expect(session.renewing).toBe(false);
    expect(releases).toEqual([originId]);
    await vi.advanceTimersByTimeAsync(LEASE_RENEW_INTERVAL_MS * 3);
    expect(acquires.length).toBe(6);
    await session.close();
  });

  it("stops renewing when the transport goes offline and resumes on reconnect", async () => {
    const keys = await testSpaceKeys("work");
    const signer = await testSigner();
    const acquires: string[] = [];
    const transport: SyncTransport = {
      publish: vi.fn(),
      acquireLease: async (_spaceId, originId): Promise<LeaseOutcome> => {
        acquires.push(originId);
        return { granted: true, exclusive: true };
      },
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
    session.runStarted("run-1");
    expect(session.renewing).toBe(false); // offline: nothing to renew yet
    session.transportState("connected");
    session.hydrated();
    await session.ready;
    expect(session.renewing).toBe(true);
    await session.engine.localChange(identity("work", "a.example", "sid"), attrs("one"), false, "explicit");
    expect(acquires).toHaveLength(1);
    session.transportState("offline");
    expect(session.renewing).toBe(false);
    await vi.advanceTimersByTimeAsync(LEASE_RENEW_INTERVAL_MS * 2);
    expect(acquires).toHaveLength(1);
    session.transportState("connected");
    expect(session.renewing).toBe(true);
    await session.close();
    expect(session.renewing).toBe(false);
  });
});
