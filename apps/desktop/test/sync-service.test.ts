/**
 * SyncService (docs/cloud-sync-design.md §10.2): the hub is dialed only once
 * this Mac is enrolled, with the device token; a Space's page loads are gated
 * until its first hydration lands; a write parked behind the cloud browser's
 * exclusive lease refuses Push until the lease is released; live records from
 * other desktops stay staged behind Pull, which installs them and reloads the
 * Space; bulk cookie writers pause capture; a refreshed token re-dials.
 */

import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveSpaceKeys,
  exportPublicKeyRaw,
  generateDeviceKeypair,
  seal,
  toBase64,
  utf8,
  workspaceSealAad,
  workspaceSigningBytes,
  WORKSPACE_PSEUDO_SPACE_ID,
  type CookieAttributes,
  type CookieIdentity,
  type CookieRecordWire,
  type DeviceWorkspaceDoc,
  type WorkspaceRecordWire,
} from "@pistachio/sync-protocol";
import { SpaceSyncEngine, type CookieApplier, type SyncTransport } from "@pistachio/sync-engine";
import type { Session } from "electron";
import {
  connected,
  cookieOf,
  fakeSession,
  sleep,
  SPACE_SECRET,
  syncHarness,
  waitFor,
  WORKSPACE_SECRET,
  type SyncHarness,
} from "./sync-harness";

const harnesses: SyncHarness[] = [];

async function harness(options: Parameters<typeof syncHarness>[0] = {}): Promise<SyncHarness> {
  const h = await syncHarness(options);
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) {
    h.service.stop();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

const CLOUD_HOLDER = { holderDeviceId: "cloud-1", holderKind: "cloud" as const, exclusive: true };

/** Another desktop of the account, with the same Space keys: authors records for the hub to fan out. */
async function peerDevice(deviceId: string): Promise<{
  engine: SpaceSyncEngine;
  signingKey: CryptoKey;
  row: { id: string; platform: "macos"; devicePublicKey: string; revokedAt: null };
}> {
  const keypair = await generateDeviceKeypair();
  const keys = await deriveSpaceKeys("work", SPACE_SECRET);
  const transport: SyncTransport = {
    publish: () => undefined,
    acquireLease: async () => ({ granted: true, exclusive: false }),
    releaseLease: () => undefined,
  };
  const applier: CookieApplier = { apply: async () => undefined };
  const engine = new SpaceSyncEngine("work", keys, { deviceId, privateKey: keypair.privateKey }, transport, applier, {
    deviceId,
    leaseKind: "desktop",
  });
  return {
    engine,
    signingKey: keypair.privateKey,
    row: { id: deviceId, platform: "macos", devicePublicKey: toBase64(await exportPublicKeyRaw(keypair.publicKey)), revokedAt: null },
  };
}

function identity(hostKey: string, name: string): CookieIdentity {
  return { spaceId: "work", hostKey, name, path: "/", partitionKey: "", sourceScheme: "secure" };
}

function attrs(value: string): CookieAttributes {
  return { value, expiresMs: null, persistent: false, secure: true, httpOnly: true, sameSite: "lax", priority: "medium" };
}

/** A peer's restore point, sealed under the account workspace key and signed with its device key (D15). */
async function restorePointWire(deviceId: string, name: string, signingKey: CryptoKey): Promise<WorkspaceRecordWire> {
  const keys = await deriveSpaceKeys(WORKSPACE_PSEUDO_SPACE_ID, WORKSPACE_SECRET);
  const key = `device-workspace:${deviceId}`;
  const doc: DeviceWorkspaceDoc = {
    kind: "deviceWorkspace",
    deviceId,
    deviceKind: "desktop",
    name,
    session: {
      version: 1,
      spaces: {
        work: {
          tabs: [{ id: "remote-tab", spaceId: "work", title: "GitHub", url: "https://github.com/", faviconUrl: null, anchorId: null, lastActiveAt: 1 }],
          activeTabId: "remote-tab",
          recentTabIds: ["remote-tab"],
          splitGroups: [],
        },
      },
    },
    savedAtMs: Date.now(),
  };
  const sealedValue = toBase64(await seal(keys.sealKey, utf8(JSON.stringify(doc)), workspaceSealAad(key)));
  const hlc = { physicalMs: Date.now() + 30_000, logical: 0, deviceId };
  const sig = await crypto.subtle.sign("Ed25519", signingKey, workspaceSigningBytes(key, sealedValue, hlc) as BufferSource);
  return { key, sealedValue, hlc, deviceSig: toBase64(new Uint8Array(sig)) };
}

describe("gating (D22)", () => {
  it("never dials until this Mac is enrolled", async () => {
    const h = await harness({ enrolled: false });
    h.service.start();
    await sleep(30);
    expect(h.transports).toHaveLength(0);
    expect(h.service.started).toBe(false);
    expect(h.service.status().state).toBe("off");
    expect(h.control.policyCalls).toBe(0);
    expect(h.browser.hydrating).toEqual([]);
  });

  it("dials the pinned hub with the device token once enrolled and gates the Space until hydrated", async () => {
    const h = await harness();
    h.service.start();
    await waitFor(() => h.transports.length === 1 && h.transport().started !== null, 4_000, "the dial");
    const transport = h.transport();
    expect(transport.url).toBe("ws://hub.test/v1/hub/ws");
    expect(transport.started).toEqual(["work"]);
    expect(await transport.events.getToken?.()).toBe("device-token");
    expect(transport.events.authRequired?.()).toBe(true);
    expect(h.browser.hydrating).toContain("work");
    expect(h.browser.ready).toEqual([]);
    expect(h.service.status().state).toBe("connecting");
    expect(h.control.policyCalls).toBe(1);

    transport.connect();
    await waitFor(() => h.browser.ready.includes("work"), 4_000, "hydration");
    expect(h.service.status()).toMatchObject({ state: "connected", revoked: false, keyMode: "e2ee", queueDepth: 0 });
    expect(h.service.status().lastConvergedMs).not.toBeNull();
    expect(h.service.workspaceStatus().state).toBe("idle");
    // The restore point and liveness card went out with hydration. The
    // workspace lane seals its docs asynchronously, so it can still be in
    // flight when the cookie lane's gate opens.
    await waitFor(() => transport.workspace.length >= 4, 4_000, "the workspace publish");
    expect(transport.workspace.map((wire) => wire.key)).toEqual(
      expect.arrayContaining(["device-workspace:mac-a", "device-activity:mac-a", "space:work", "settings:keyMode"]),
    );
  });

  it("runs the loopback in development when no hub is known, and re-dials on a refreshed token", async () => {
    const h = await harness({ hubUrl: null });
    await connected(h);
    expect(h.transport().url).toBeNull();
    h.service.refreshAuth();
    expect(h.transport().reconnects).toBe(1);
  });

  it("opens the gate for a Space this Mac holds no root secret for", async () => {
    // Device B made this Space; its root secret never reached this Mac, so
    // nothing will ever hydrate it. Holding its page loads would strand them
    // until the session gate's 15 s safety timeout.
    const h = await harness({ spaceSecret: () => null });
    h.service.start();
    await waitFor(() => h.transports.length === 1 && h.transport().started !== null, 4_000, "the dial");
    h.service.onSessionCreated(fakeSession() as unknown as Session, "work", "persist:pistachio-space-work", "human");
    await waitFor(() => h.browser.ready.includes("work"), 4_000, "the gate");
    expect(h.browser.hydrating).not.toContain("work");
  });

  it("frees the gate when the hub goes away so the person browses their local session", async () => {
    const h = await harness();
    h.service.start();
    await waitFor(() => h.transports.length === 1 && h.transport().started !== null, 4_000, "the dial");
    h.transport().offline();
    await waitFor(() => h.browser.ready.includes("work"), 4_000, "the gate");
    expect(h.service.status().state).toBe("paused");
  });
});

describe("the cloud browser's lease (D10)", () => {
  it("parks a rotating-auth write behind the cloud lease, refuses Push, and drains on release", async () => {
    const h = await harness();
    const transport = await connected(h);
    transport.leaseOutcome = { granted: false, denied: CLOUD_HOLDER };
    h.browser.jar("work").changed(cookieOf("__Secure-1PSIDTS", ".gmail.com"), "overwrite");
    await waitFor(() => transport.leaseCalls.length === 1, 4_000, "the lease request");
    await waitFor(() => h.service.status().queueDepth === 1, 4_000, "the deferred write");
    expect(transport.published).toHaveLength(0);
    expect(transport.leaseCalls[0]?.opts?.force).not.toBe(true);

    await expect(h.service.runWorkspaceSync({ kind: "push" })).rejects.toThrow(/cloud run in progress/);
    const info = await h.service.originInfo("work", "gmail.com");
    expect(info).toMatchObject({ host: "gmail.com", rotatingAuth: true, synced: true, deferred: true, staged: false });

    transport.leaseOutcome = { granted: true, exclusive: false };
    transport.events.onLeaseReleased?.("work", transport.leaseCalls[0]!.originId);
    await waitFor(() => transport.published.length === 1, 4_000, "the drained publish");
    await waitFor(() => h.service.status().queueDepth === 0, 4_000, "an empty queue");
    expect((await h.service.originInfo("work", "gmail.com")).deferred).toBe(false);
    await expect(h.service.runWorkspaceSync({ kind: "push" })).resolves.toMatchObject({ state: "idle" });
  });

  it("retries the deferred lane on the host's cadence", async () => {
    const h = await harness();
    const transport = await connected(h);
    transport.leaseOutcome = { granted: false, denied: CLOUD_HOLDER };
    h.browser.jar("work").changed(cookieOf("__Secure-1PSIDTS", ".gmail.com"), "overwrite");
    await waitFor(() => h.service.status().queueDepth === 1, 4_000, "the deferred write");
    transport.leaseOutcome = { granted: true, exclusive: false };
    // The 50 ms retry timer of the harness re-acquires and publishes.
    await waitFor(() => transport.published.length === 1, 4_000, "the retried publish");
  });
});

describe("hydration", () => {
  it("skips a record Chromium refuses instead of re-dialing the hub forever", async () => {
    const peer = await peerDevice("mac-b");
    const h = await harness({ devices: [peer.row] });
    h.service.start();
    await waitFor(() => h.transports.length === 1 && h.transport().started !== null, 4_000, "the dial");
    const transport = h.transport();
    // A cookie this Chromium permanently refuses (a `__Host-` prefix whose
    // reconstructed attributes do not satisfy the rule), ahead of a good one.
    h.browser.jar("work").refuse.add("__Host-session");
    const bad = await peer.engine.localChange(identity("github.com", "__Host-session"), attrs("nope"), false, "explicit");
    const good = await peer.engine.localChange(identity("github.com", "user_session"), attrs("fine"), false, "explicit");
    const snapshot = [bad as CookieRecordWire, good as CookieRecordWire];

    for (let round = 0; round < 4; round += 1) {
      transport.state = "connected";
      transport.events.onStateChanged?.("connected");
      transport.events.onRecords?.("work", snapshot);
      transport.events.onHydrated?.("work");
      if (round < 3) await waitFor(() => transport.reconnects === round + 1, 4_000, `re-dial ${round + 1}`);
    }

    await waitFor(() => h.browser.ready.includes("work"), 4_000, "the gate");
    expect(transport.reconnects).toBe(3);
    // The rest of the snapshot landed; only the refused cookie is missing.
    expect([...h.browser.jar("work").jar.values()].map((cookie) => cookie.name)).toEqual(["user_session"]);
    expect(h.service.status().state).toBe("connected");
  });
});

describe("sign-out", () => {
  it("stops applying a snapshot that was still hydrating, so the wiped jar stays wiped", async () => {
    const peer = await peerDevice("mac-b");
    const snapshot = async (): Promise<CookieRecordWire[]> => {
      const one = await peer.engine.localChange(identity("github.com", "user_session"), attrs("secret"), false, "explicit");
      const two = await peer.engine.localChange(identity("github.com", "other"), attrs("secret-2"), false, "explicit");
      return [one as CookieRecordWire, two as CookieRecordWire];
    };

    // Control: the same delivery, no sign-out. The records land, which is what
    // makes the assertion below meaningful.
    const kept = await harness({ devices: [peer.row] });
    kept.service.start();
    await waitFor(() => kept.transports.length === 1 && kept.transport().started !== null, 4_000, "the dial");
    kept.transport().state = "connected";
    kept.transport().events.onStateChanged?.("connected");
    kept.transport().events.onRecords?.("work", await snapshot());
    kept.transport().events.onHydrated?.("work");
    await waitFor(() => kept.browser.jar("work").jar.size === 2, 4_000, "the applied snapshot");

    // The person signs out mid-hydration. `index.ts` clears every Space
    // partition right after this, so a snapshot still draining would write the
    // signed-out account's cookies back into a jar that was just wiped.
    const h = await harness({ devices: [peer.row] });
    h.service.start();
    await waitFor(() => h.transports.length === 1 && h.transport().started !== null, 4_000, "the dial");
    h.transport().state = "connected";
    h.transport().events.onStateChanged?.("connected");
    h.transport().events.onRecords?.("work", await snapshot());
    // Sign-out must not return until what is already inside Electron's cookie
    // API has settled: index.ts wipes the partition the moment this resolves.
    await h.service.stop("sign-out");
    expect([...h.browser.jar("work").jar.values()]).toEqual([]);

    // And nothing lands afterwards either.
    await sleep(100);
    expect([...h.browser.jar("work").jar.values()]).toEqual([]);
  });

  it("does not return until a write already inside Electron's cookie API has settled", async () => {
    const peer = await peerDevice("mac-b");
    const record = (await peer.engine.localChange(
      identity("github.com", "user_session"),
      attrs("secret"),
      false,
      "explicit",
    )) as CookieRecordWire;
    const h = await harness({ devices: [peer.row] });
    h.service.start();
    await waitFor(() => h.transports.length === 1 && h.transport().started !== null, 4_000, "the dial");
    h.transport().state = "connected";
    h.transport().events.onStateChanged?.("connected");
    // Park the apply inside the cookie API: the generation bump stops the NEXT
    // record, but this one is already in flight.
    const jar = h.browser.jar("work");
    let release = (): void => undefined;
    jar.holdSet = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.transport().events.onRecords?.("work", [record]);
    await waitFor(() => jar.sets.length === 1, 4_000, "the parked cookie write");

    let stopped = false;
    const stopping = h.service.stop("sign-out").then(() => {
      stopped = true;
    });
    await sleep(60);
    expect(stopped).toBe(false);
    jar.holdSet = null;
    release();
    await stopping;
    expect(stopped).toBe(true);
  });

  it("forgets the signed-out account's origin overrides, so the next account is not told them", async () => {
    const h = await harness();
    await connected(h);
    await h.service.setOriginOverride("work", "github.com", "never");
    await waitFor(() => h.control.overrides.length === 1, 4_000, "the mirrored override");
    await h.service.stop("sign-out");

    // The same SyncService instance serves the next account (index.ts keeps
    // it across sign-out): its #loadPolicy must not push the old hosts.
    h.control.overrides.length = 0;
    h.service.start();
    await waitFor(() => h.control.policyCalls === 2, 4_000, "the next account's policy read");
    await sleep(60);
    expect(h.control.overrides).toEqual([]);
  });
});

describe("publish rejections", () => {
  it("re-publishes a record the hub rate-limited on the retry tick", async () => {
    const h = await harness();
    const transport = await connected(h);
    h.browser.jar("work").changed(cookieOf("user_session", "github.com"));
    await waitFor(() => transport.published.length === 1, 4_000, "the publish");
    const recordId = transport.published[0]!.recordId;
    // Nothing was stored: the engine shelves it in the DEFAULT lane, which
    // only drains when the host flushes it.
    transport.events.onPublishRejected?.([{ recordId, reason: "rate_limited" }]);
    await waitFor(() => transport.published.length === 2, 4_000, "the re-publish");
    expect(transport.published[1]?.recordId).toBe(recordId);
  });

  it("keeps a version the hub accepted as the parent of the record it re-publishes", async () => {
    // `publish.ack` carries the accepted ids; without them the engine has to
    // guess which in-flight versions the hub kept and un-publishes the whole
    // window on a rejection, so the retry names no parent at all.
    const h = await harness();
    const transport = await connected(h);
    h.browser.jar("work").changed(cookieOf("user_session", "github.com"));
    await waitFor(() => transport.published.length === 1, 4_000, "the first publish");
    const first = transport.published[0]!;
    transport.events.onPublishAccepted?.([first.recordId]);

    h.browser.jar("work").changed(cookieOf("user_session", "github.com", "rotated"));
    await waitFor(() => transport.published.length === 2, 4_000, "the second publish");
    const second = transport.published[1]!;
    expect(second.causalParent).not.toBeNull();

    transport.events.onPublishRejected?.([{ recordId: second.recordId, reason: "rate_limited" }]);
    await waitFor(() => transport.published.length === 3, 4_000, "the re-publish");
    expect(transport.published[2]?.causalParent).toBe(second.causalParent);
  });
});

describe("live records from another desktop", () => {
  it("stages a non-rotating record behind Pull, installs it on Pull, and reloads the Space", async () => {
    const peer = await peerDevice("mac-b");
    const h = await harness({ devices: [peer.row] });
    const transport = await connected(h);
    const wire = await peer.engine.localChange(identity("github.com", "user_session"), attrs("from-mac-b"), false, "explicit");
    expect(wire).not.toBeNull();
    transport.events.onRecords?.("work", [wire as CookieRecordWire]);
    await waitFor(() => h.service.status().remoteChanged, 4_000, "the staged record");
    expect(h.browser.jar("work").sets).toHaveLength(0);
    expect((await h.service.originInfo("work", "github.com")).staged).toBe(true);

    // Pull needs the peer's restore point; the record install precedes the tabs.
    transport.events.onWorkspaceRecords?.([await restorePointWire("mac-b", "Mac B", peer.signingKey)]);
    await waitFor(() => h.service.workspaceStatus().remoteRestorePoints.length === 1, 4_000, "the restore point");
    expect(h.service.workspaceStatus().remoteRestorePoints[0]).toMatchObject({ deviceId: "mac-b", name: "Mac B", tabCount: 1, spaceIds: ["work"] });

    await h.service.runWorkspaceSync({ kind: "pull", deviceId: "mac-b", mode: "replace" });
    expect(h.browser.jar("work").sets.map((details) => [details.name, details.value])).toEqual([["user_session", "from-mac-b"]]);
    expect(h.browser.applied).toEqual([{ spaceId: "work", mode: "replace", tabIds: ["remote-tab"] }]);
    expect(h.browser.reloaded).toEqual(["work"]);
    expect(h.service.status().remoteChanged).toBe(false);
  });

  it("drops a record from a device the account does not know", async () => {
    const peer = await peerDevice("mac-unknown");
    const h = await harness();
    const transport = await connected(h);
    const wire = await peer.engine.localChange(identity("github.com", "user_session"), attrs("stranger"), false, "explicit");
    transport.events.onRecords?.("work", [wire as CookieRecordWire]);
    await sleep(60);
    // Staged, because the verifier could not admit it; Pull will judge it again and reject it.
    expect(h.browser.jar("work").sets).toHaveLength(0);
    // The workspace lane refuses the same device: its restore point is signed
    // by a key the account's registry does not hold, so Pull has nothing to offer.
    transport.events.onWorkspaceRecords?.([await restorePointWire("mac-unknown", "Stranger", peer.signingKey)]);
    await sleep(60);
    expect(h.service.workspaceStatus().remoteRestorePoints).toEqual([]);
    await expect(h.service.runWorkspaceSync({ kind: "pull", deviceId: "mac-unknown", mode: "merge" })).rejects.toThrow(
      /no longer available/,
    );
    expect(h.browser.jar("work").sets).toHaveLength(0);
  });
});

describe("capture and bulk writers", () => {
  it("publishes a cookie change once hydrated, and ignores agent partitions", async () => {
    const h = await harness();
    const transport = await connected(h);
    const before = h.browser.hydrating.length;
    h.service.onSessionCreated(fakeSession() as unknown as Session, "work", "pistachio-agent-run-1", "agent");
    expect(h.browser.hydrating).toHaveLength(before);
    h.browser.jar("work").changed(cookieOf("user_session", "github.com"));
    await waitFor(() => transport.published.length === 1, 4_000, "the publish");
    expect(transport.published[0]?.hlc.deviceId).toBe("mac-a");
    expect(transport.published[0]?.spaceId).toBe("work");
  });

  it("pauses capture for a bulk cookie write and seeds what landed after it", async () => {
    const h = await harness();
    const transport = await connected(h);
    h.service.beginBulkCookieWrite("work");
    h.browser.jar("work").changed(cookieOf("user_session", "github.com"));
    h.browser.jar("work").changed(cookieOf("logged_in", "github.com"));
    await sleep(40);
    expect(transport.published).toHaveLength(0);
    h.service.endBulkCookieWrite("work");
    await waitFor(() => transport.published.length === 2, 4_000, "the seeded publishes");
  });

  it("mirrors an origin override to control and seeds the origin when it is opted in", async () => {
    const h = await harness();
    const transport = await connected(h);
    const info = await h.service.setOriginOverride("work", "github.com", "never");
    expect(info).toMatchObject({ host: "github.com", override: "never", synced: false });
    h.browser.jar("work").changed(cookieOf("user_session", "github.com"));
    await sleep(40);
    expect(transport.published).toHaveLength(0);
    await h.service.setOriginOverride("work", "github.com", "sync");
    await waitFor(() => transport.published.length === 1, 4_000, "the seeded publish");
    await h.service.setOriginOverride("work", "github.com", null);
    await waitFor(() => h.control.overrides.length === 3, 4_000, "the mirrored overrides");
    expect(h.control.overrides).toEqual([
      { host: "github.com", mode: "never" },
      { host: "github.com", mode: "sync" },
      { host: "github.com", mode: null },
    ]);
  });
});
