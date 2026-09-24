/**
 * Claim on demand, the heartbeat, and idle suspend
 * (docs/web-browser-design.md §6.4, §6.5).
 *
 * The browser here is a stub: what is under test is the lease dance with
 * control and the durable record, not Chromium. A session is claimed when a
 * ticket lands, heartbeated while it is held, published and released when the
 * last viewer has been gone long enough — and a fresh claim on what is, as
 * far as the worker is concerned, a different machine rebuilds the same tabs.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentTabInfo } from "@pistachio/agent-runtime";
import type { BrowserSessionRecord } from "@pistachio/sync-protocol";
import { ControlClient, type SessionTicketRedemption } from "../../src/control-client.js";
import {
  SESSION_LEASE_MS,
  SessionRegistry,
  type SessionClosing,
  type SpaceSessions,
} from "../../src/sessions/session-registry.js";
import type { SessionSpace } from "../../src/sessions/shell-host.js";
import type { CloudBrowser } from "../../src/sync/session.js";
import type { WorkspaceToolStore } from "../../src/sync/workspace-tools.js";
import { startFakeControl, type FakeControl } from "../helpers/fake-control.js";
import { settle } from "../helpers/fixture-server.js";
import { testSpaceKeys, USER_A } from "../helpers/keys.js";

const SPACE = "work";
const WORKER_URL = "http://10.0.0.7:8791";

/** A browser with no browser in it: tabs are rows in a map. */
function stubBackend(): CloudBrowser & { pages: Map<string, string> } {
  const pages = new Map<string, string>();
  let next = 0;
  const backend = {
    kind: "cloud" as const,
    pages,
    get activeTabId() {
      return [...pages.keys()][0] ?? null;
    },
    guardFor: () => null,
    listTabs: (): AgentTabInfo[] =>
      [...pages.entries()].map(([id, url]) => ({
        id,
        spaceId: SPACE,
        title: "",
        url,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        kind: "human" as const,
      })),
    openTab: async (url?: string) => {
      next += 1;
      const id = `cloud:${String(next)}`;
      pages.set(id, url ?? "about:blank");
      return id;
    },
    closeTab: async (tabId: string) => {
      pages.delete(tabId);
    },
    focusTab: async () => undefined,
    navigate: async (tabId: string, url: string) => {
      pages.set(tabId, url);
    },
    back: async () => undefined,
    forward: async () => undefined,
    reload: async () => undefined,
    inspect: async () => ({ title: "", url: "", controls: [], text: "" }),
    click: async () => undefined,
    type: async () => "",
    press: async () => undefined,
    scroll: async () => undefined,
    screenshot: async () => "data:image/png;base64,",
  } as unknown as CloudBrowser & { pages: Map<string, string> };
  return backend;
}

/** A workspace store that keeps the sealed record in a plain map. */
function stubWorkspace(records: Map<string, BrowserSessionRecord>): WorkspaceToolStore {
  return {
    browserSession: (spaceId: string) => records.get(spaceId) ?? null,
    putBrowserSession: (session: BrowserSessionRecord) => records.set(session.spaceId, session),
    spaces: () => [],
    settled: async () => undefined,
  } as unknown as WorkspaceToolStore;
}

let fake: FakeControl;
let control: ControlClient;
let records: Map<string, BrowserSessionRecord>;
let spaces: SpaceSessions & { acquired: number; released: number; backend: ReturnType<typeof stubBackend> };
let registry: SessionRegistry;
let sessionId: string;
let deviceId: string;

function redemption(workerUrl: string | null = null): SessionTicketRedemption {
  return { userId: USER_A, deviceId, platform: "web", spaceId: SPACE, workerUrl };
}

function makeRegistry(
  options: { idleMs?: number; heartbeatMs?: number; now?: () => number } = {},
): SessionRegistry {
  return new SessionRegistry({
    control,
    sessions: spaces,
    workerId: "worker-a",
    workerUrl: WORKER_URL,
    keysFor: (_userId, spaceId) => testSpaceKeys(spaceId),
    idleMs: options.idleMs ?? 60_000,
    ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    stateDebounceMs: 5,
  });
}

beforeEach(async () => {
  fake = await startFakeControl();
  control = new ControlClient({ baseUrl: fake.baseUrl, serviceToken: fake.serviceToken });
  records = new Map();
  const backend = stubBackend();
  const listeners = new Set<() => void>();
  const space: SessionSpace = {
    ready: Promise.resolve(),
    workspace: stubWorkspace(records),
    browser: {
      backend,
      onTabsChanged: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
  spaces = {
    acquired: 0,
    released: 0,
    backend,
    acquire: async () => {
      spaces.acquired += 1;
      return space;
    },
    release: () => {
      spaces.released += 1;
    },
  };
  deviceId = fake.addWebDevice(USER_A).id;
  sessionId = fake.addBrowserSession({ userId: USER_A, spaceId: SPACE }).id;
  registry = makeRegistry();
});

afterEach(async () => {
  await registry.close();
  await fake.close();
});

describe("claim on demand (§6.4)", () => {
  it("claims an unheld session, holds the browser, and reports the lease to control", async () => {
    const outcome = await registry.claim(sessionId, redemption());
    expect(outcome.kind).toBe("session");
    expect(spaces.acquired).toBe(1);
    const row = fake.browserSessions.get(sessionId)!;
    expect(row.state).toBe("live");
    expect(row.leaseWorkerId).toBe("worker-a");
    expect(row.leaseWorkerUrl).toBe(WORKER_URL);
  });

  it("is idempotent: a second ticket for a session it already holds reuses it", async () => {
    const first = await registry.claim(sessionId, redemption());
    const second = await registry.claim(sessionId, redemption());
    expect(first.kind === "session" && second.kind === "session" && first.session === second.session).toBe(true);
    expect(spaces.acquired).toBe(1);
  });

  it("relays rather than fighting when control names another worker", async () => {
    const outcome = await registry.claim(sessionId, redemption("http://10.0.0.9:8791"));
    expect(outcome).toEqual({ kind: "relay", workerUrl: "http://10.0.0.9:8791" });
    expect(spaces.acquired).toBe(0);
  });

  it("relays when a sibling took the lease between the redemption and the claim", async () => {
    // S6 gave control a route to re-read a session (§6.4), so a lost race is
    // a relay rather than a `409` the client has to re-dial through.
    fake.holdBrowserSession(sessionId, "worker-b", "http://10.0.0.9:8791");
    const outcome = await registry.claim(sessionId, redemption());
    expect(outcome).toEqual({ kind: "relay", workerUrl: "http://10.0.0.9:8791" });
    expect(spaces.acquired).toBe(0);
  });

  it("still refuses when the sibling that took it has no address to relay to", async () => {
    fake.holdBrowserSession(sessionId, "worker-b", null);
    const outcome = await registry.claim(sessionId, redemption());
    expect(outcome).toEqual({ kind: "refused", reason: "held_elsewhere" });
    expect(spaces.acquired).toBe(0);
  });

  it("refuses an ended session with `ended`, not a retry", async () => {
    const row = fake.browserSessions.get(sessionId)!;
    row.state = "ended";
    const outcome = await registry.claim(sessionId, redemption());
    expect(outcome).toEqual({ kind: "refused", reason: "ended" });
  });
});

describe("the heartbeat", () => {
  it("renews the lease while the session is held", async () => {
    await registry.close();
    registry = makeRegistry({ heartbeatMs: 20 });
    await registry.claim(sessionId, redemption());
    const row = fake.browserSessions.get(sessionId)!;
    const until = row.leaseUntil ?? 0;
    await settle(() => (fake.browserSessions.get(sessionId)?.leaseUntil ?? 0) > until);
    expect(fake.browserSessions.get(sessionId)?.state).toBe("live");
  });

  it("tears the session down and tells the sockets when control refuses the lease", async () => {
    await registry.close();
    registry = makeRegistry({ heartbeatMs: 20 });
    await registry.claim(sessionId, redemption());
    const closings: Array<[string, SessionClosing]> = [];
    registry.onClosing((id, reason) => closings.push([id, reason]));
    // Somebody else took it: our token is no longer the one control holds.
    fake.holdBrowserSession(sessionId, "worker-b", "http://10.0.0.9:8791");
    await settle(() => closings.length > 0, { turns: 100, stepMs: 10 });
    expect(closings[0]).toEqual([sessionId, "lease_lost"]);
    expect(registry.get(sessionId)).toBeNull();
    expect(spaces.released).toBe(1);
  });
});

describe("idle suspend and rebuild (§6.4, §9)", () => {
  it("publishes the record, releases the lease as suspended, and lets the browser go", async () => {
    await registry.close();
    registry = makeRegistry({ idleMs: 30 });
    const outcome = await registry.claim(sessionId, redemption());
    if (outcome.kind !== "session") throw new Error("expected a session");
    await outcome.session.host.createTab("https://example.test/one");
    await outcome.session.host.createTab("https://example.test/two");
    // The claim itself starts the idle clock: nothing ever attached.
    await settle(() => registry.get(sessionId) === null);
    const row = fake.browserSessions.get(sessionId)!;
    expect(row.state).toBe("suspended");
    expect(row.leaseToken).toBeNull();
    expect(spaces.released).toBe(1);
    const record = records.get(SPACE);
    expect(record?.tabs.map((tab) => tab.url)).toEqual(["https://example.test/one", "https://example.test/two"]);
  });

  it("rebuilds the same tabs on the next claim", async () => {
    await registry.close();
    registry = makeRegistry({ idleMs: 30 });
    const first = await registry.claim(sessionId, redemption());
    if (first.kind !== "session") throw new Error("expected a session");
    await first.session.host.createTab("https://example.test/one");
    const before = (await first.session.host.getSnapshot()).tabs.map((tab) => tab.id);
    await settle(() => registry.get(sessionId) === null);

    const second = await registry.claim(sessionId, redemption());
    if (second.kind !== "session") throw new Error("expected a session");
    const after = await second.session.host.getSnapshot();
    expect(after.tabs.map((tab) => tab.id)).toEqual(before);
    expect(after.tabs.map((tab) => tab.url)).toEqual(["https://example.test/one"]);
  });

  it("does not suspend while a viewer is attached", async () => {
    await registry.close();
    registry = makeRegistry({ idleMs: 30 });
    const outcome = await registry.claim(sessionId, redemption());
    if (outcome.kind !== "session") throw new Error("expected a session");
    outcome.session.attachViewer({} as never);
    registry.viewerAttached(sessionId);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(registry.get(sessionId)).not.toBeNull();
  });
});

describe("the session's end", () => {
  it("tells the sockets and lets the browser go without releasing a lease control already cleared", async () => {
    await registry.claim(sessionId, redemption());
    const closings: Array<[string, SessionClosing]> = [];
    registry.onClosing((id, reason) => closings.push([id, reason]));
    await registry.ended(sessionId);
    expect(closings[0]).toEqual([sessionId, "ended"]);
    expect(registry.get(sessionId)).toBeNull();
    expect(spaces.released).toBe(1);
  });
});

/* ------------------------- adversarial review fixes ------------------------ */

describe("a session nobody is watching", () => {
  it("idles when the run it was holding open ends", async () => {
    registry = makeRegistry({ idleMs: 20, heartbeatMs: 10_000 });
    const outcome = await registry.claim(sessionId, redemption());
    expect(outcome.kind).toBe("session");
    if (outcome.kind !== "session") return;
    // A person starts a run and closes the tab. `viewerDetached` returns
    // early while a run is acting, and nothing called it again when the run
    // ended — so the lease, the heartbeat and the Chromium context were held
    // for ever.
    const row = fake.browserSessions.get(sessionId)!;
    row.activeRunId = "run-1";
    await registry.refresh(sessionId);
    expect(outcome.session.activeRunId).toBe("run-1");
    registry.viewerAttached(sessionId);
    registry.viewerDetached(sessionId);
    expect(registry.get(sessionId)).not.toBeNull();

    row.activeRunId = null;
    await registry.refresh(sessionId);
    await settle(() => registry.get(sessionId) === null, { turns: 800, stepMs: 5 });
    expect(fake.browserSessions.get(sessionId)?.state).toBe("suspended");
  });
});

describe("a lease this worker could not renew", () => {
  it("stops serving the session once the confirmed lease has run out", async () => {
    await registry.close();
    let clock = Date.now();
    registry = makeRegistry({ heartbeatMs: 10, now: () => clock });
    const outcome = await registry.claim(sessionId, redemption());
    if (outcome.kind !== "session") throw new Error("expected a session");
    const closings: Array<[string, SessionClosing]> = [];
    registry.onClosing((id, reason) => closings.push([id, reason]));

    // Control is unreachable. Heartbeats fail as a transport error, which is
    // not a refusal of the lease — the worker is told nothing at all, retries,
    // and used to go on serving the session for ever. Meanwhile the lease
    // control last confirmed runs out, and a sibling worker may claim the
    // session while this one is still taking input for it.
    fake.sessionHeartbeatsFail = true;
    await settle(() => fake.browserSessions.get(sessionId)?.leaseUntil !== null);
    clock += SESSION_LEASE_MS + 1_000;

    await settle(() => closings.length > 0);
    expect(closings[0]).toEqual([sessionId, "lease_lost"]);
    expect(registry.get(sessionId)).toBeNull();
    // Closed, so the socket refuses input and every mutating call, exactly as
    // it does for a `stale_lease` (§6.4).
    expect(outcome.session.closed).toBe(true);
    expect(outcome.session.closeReason).toBe("lease_lost");
  });

  it("keeps serving while the lease it last confirmed is still good", async () => {
    await registry.close();
    let clock = Date.now();
    registry = makeRegistry({ heartbeatMs: 10, now: () => clock });
    await registry.claim(sessionId, redemption());
    fake.sessionHeartbeatsFail = true;
    // A blip is not a lost lease: inside the minute the session goes on.
    clock += SESSION_LEASE_MS / 2;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(registry.get(sessionId)).not.toBeNull();
  });
});

describe("a run that ends with nobody watching", () => {
  it("releases the session even though the executor cleared activeRunId first", async () => {
    registry = makeRegistry({ idleMs: 20, heartbeatMs: 10_000 });
    const outcome = await registry.claim(sessionId, redemption());
    if (outcome.kind !== "session") throw new Error("expected a session");
    const row = fake.browserSessions.get(sessionId)!;
    row.activeRunId = "run-1";
    await registry.refresh(sessionId);
    registry.viewerAttached(sessionId);
    registry.viewerDetached(sessionId);
    expect(registry.get(sessionId)).not.toBeNull();

    // The executor's own run-end sequence (`runs/executor.ts`): it clears the
    // session's `activeRunId` and then asks the registry to re-read control.
    // The registry used to start the idle clock only when the refresh itself
    // saw the run go from something to nothing, so this assignment hid the
    // transition and the session outlived its idle deadline with a whole
    // Chromium behind it.
    outcome.session.activeRunId = null;
    row.activeRunId = null;
    await registry.runEnded(sessionId, "run-1");

    await settle(() => registry.get(sessionId) === null, { turns: 800, stepMs: 5 });
    expect(fake.browserSessions.get(sessionId)?.state).toBe("suspended");
  });
});

describe("a session that could not be built", () => {
  it("gives the lease back rather than leaving control pointing at this worker", async () => {
    // The run's claim handed this worker the lease in the same transaction,
    // so the worker holds it whether or not the session comes up. Without the
    // release, viewers are routed here for a whole minute for nothing.
    spaces.acquire = async () => {
      throw new Error("no Chromium today");
    };
    const leaseToken = "lease-from-the-run-claim";
    const row = fake.browserSessions.get(sessionId)!;
    row.leaseToken = leaseToken;
    row.leaseWorkerId = "worker-a";
    row.leaseUntil = Date.now() + 60_000;
    const adopted = await registry.adopt({
      sessionId,
      leaseToken,
      runId: "run-1",
      userId: USER_A,
      spaceId: SPACE,
    });
    expect(adopted).toBeNull();
    expect(fake.browserSessions.get(sessionId)?.leaseToken).toBeNull();
  });
});

describe("retiring and reclaiming the same session", () => {
  it("does not let a fresh claim share the Space holder the retire is still letting go of", async () => {
    const first = await registry.claim(sessionId, redemption());
    expect(first.kind).toBe("session");
    const holders: number[] = [];
    const release = spaces.release;
    spaces.release = (userId, spaceId, holder) => {
      holders.push(spaces.acquired);
      release(userId, spaceId, holder);
    };
    // `#retire` awaits the record flush and the session's close before it
    // lets the Space holder go; a claim landing in that window used to
    // acquire the very holder the retire was about to release.
    const retiring = registry.suspend(sessionId);
    const again = registry.claim(sessionId, redemption());
    await retiring;
    const outcome = await again;
    expect(outcome.kind).toBe("session");
    // The release happened before the second acquire, not after it.
    expect(holders).toEqual([1]);
    expect(spaces.acquired).toBe(2);
  });
});
