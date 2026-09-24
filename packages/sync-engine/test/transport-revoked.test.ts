/**
 * WsTransport behaviour that needs a socket: the hello frame carries the
 * device kind (§3), `updateSpaces` waits for the ack before hydrating only the
 * new spaces, lease frames map to `LeaseOutcome`, and close code 4003 is
 * terminal (`off`, `onRevoked`, no reconnect).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_DECLARED_SPACES,
  type CookieRecordWire,
} from "@pistachio/sync-protocol";
import {
  CLOSE_REVOKED,
  WsTransport,
  type TransportEvents,
  type TransportState,
} from "../src/index.js";
import { settle } from "./helpers.js";

type Listener = (event: { data?: unknown; code?: number }) => void;

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 1;
  closed = false;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  emit(type: string, event: { data?: unknown; code?: number } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }

  receive(frame: Record<string, unknown>): void {
    this.emit("message", { data: JSON.stringify(frame) });
  }
}

interface Internals {
  reconnectTimer: unknown;
  stopped: boolean;
}

function internals(transport: WsTransport): Internals {
  return transport as unknown as Internals;
}

function wire(recordId: string): CookieRecordWire {
  return {
    spaceId: "space-1",
    recordId,
    originId: "b".repeat(64),
    sealedRecord: "sealed",
    hlc: { physicalMs: 1, logical: 0, deviceId: "dev-a" },
    causalParent: null,
    deviceSig: "signature",
    cause: "WRITE",
  };
}

/** Start a transport and drive it to `connected` through the fake socket. */
async function connect(
  transport: WsTransport,
  spaceIds: string[],
): Promise<FakeSocket> {
  const before = FakeSocket.instances.length;
  transport.start(spaceIds);
  await settle(() => FakeSocket.instances.length > before);
  const socket = FakeSocket.instances[before];
  if (socket === undefined) throw new Error("no socket dialed");
  socket.emit("open");
  socket.receive({ t: "hello.ack", serverTimeMs: 1, presence: [] });
  expect(transport.state).toBe("connected");
  return socket;
}

describe("WsTransport over a socket", () => {
  const globals = globalThis as Record<string, unknown>;
  let previousWebSocket: unknown;

  beforeEach(() => {
    FakeSocket.instances = [];
    previousWebSocket = globals["WebSocket"];
    globals["WebSocket"] = FakeSocket;
  });

  afterEach(() => {
    if (previousWebSocket === undefined) delete globals["WebSocket"];
    else globals["WebSocket"] = previousWebSocket;
  });

  it("dials with the device token and says hello with its kind and spaces", async () => {
    const transport = new WsTransport("wss://hub.example/v1/hub/ws", "cloud-1", "cloud", {
      getToken: async () => "device-token",
      authRequired: () => true,
    });
    const socket = await connect(transport, ["work", "work"]);
    expect(socket.url).toBe(
      "wss://hub.example/v1/hub/ws?access_token=device-token",
    );
    expect(socket.frames()).toEqual([
      { t: "hello", deviceId: "cloud-1", kind: "cloud", spaceIds: ["work"] },
      { t: "hydrate", spaceId: "work", sinceHlc: null },
      { t: "workspace.hydrate", sinceHlc: null },
    ]);
    expect(transport.presence()).toEqual([
      expect.objectContaining({ deviceId: "cloud-1", kind: "cloud", online: true }),
    ]);
    transport.stop();
  });

  it("updateSpaces waits for the ack, hydrates only the new spaces, and addSpace delegates without reconnecting", async () => {
    const hydrated: string[] = [];
    const transport = new WsTransport("ws://hub", "dev-a", "desktop", {
      onHydrated: (spaceId) => hydrated.push(spaceId),
    });
    const socket = await connect(transport, ["work"]);
    socket.sent.length = 0;

    let settled = false;
    const update = transport.updateSpaces(["work", "personal"]).then(() => {
      settled = true;
    });
    expect(socket.frames()).toEqual([
      { t: "spaces.update", spaceIds: ["work", "personal"] },
    ]);
    await Promise.resolve();
    expect(settled).toBe(false);

    socket.receive({ t: "spaces.update.ack", spaceIds: ["work", "personal"] });
    await update;
    expect(socket.frames().slice(1)).toEqual([
      { t: "hydrate", spaceId: "personal", sinceHlc: null },
    ]);
    socket.receive({ t: "hydrate.done", spaceId: "personal", count: 0, watermark: null });
    expect(hydrated).toEqual(["personal"]);

    socket.sent.length = 0;
    transport.addSpace("agent");
    transport.addSpace("agent");
    await Promise.resolve();
    expect(socket.frames()).toEqual([
      { t: "spaces.update", spaceIds: ["work", "personal", "agent"] },
    ]);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(socket.closed).toBe(false);
    socket.receive({ t: "spaces.update.ack", spaceIds: ["work", "personal", "agent"] });
    expect(socket.frames().at(-1)).toEqual({ t: "hydrate", spaceId: "agent", sinceHlc: null });

    // Updates queue behind an unanswered one; a rejection (cap exceeded)
    // settles its update without hydrating.
    socket.sent.length = 0;
    const queued = transport.updateSpaces(["work", "personal", "agent", "q"]);
    const rejected = transport.updateSpaces(["work", "personal", "agent", "q", "x"]);
    expect(socket.frames()).toEqual([
      { t: "spaces.update", spaceIds: ["work", "personal", "agent", "q"] },
    ]);
    socket.receive({ t: "spaces.update.ack", spaceIds: ["work", "personal", "agent", "q"] });
    await queued;
    expect(socket.frames().slice(1)).toEqual([
      { t: "hydrate", spaceId: "q", sinceHlc: null },
      { t: "spaces.update", spaceIds: ["work", "personal", "agent", "q", "x"] },
    ]);
    socket.receive({ t: "error", code: "too_many_spaces", message: "cap" });
    await rejected;
    expect(socket.frames()).toHaveLength(3);
    transport.stop();
  });

  it("declares spaces added between hello and its ack, and while offline just records them", async () => {
    const transport = new WsTransport("ws://hub", "dev-a", "desktop");
    await transport.updateSpaces(["early"]); // offline: no socket, no frame
    transport.start(["work"]);
    await settle(() => FakeSocket.instances.length === 1);
    const socket = FakeSocket.instances[0];
    if (socket === undefined) throw new Error("no socket");
    socket.emit("open");
    void transport.updateSpaces(["work", "late"]); // connecting: not yet sent
    socket.receive({ t: "hello.ack", serverTimeMs: 1, presence: [] });
    await Promise.resolve();
    expect(socket.frames()).toEqual([
      { t: "hello", deviceId: "dev-a", kind: "desktop", spaceIds: ["work"] },
      { t: "hydrate", spaceId: "work", sinceHlc: null },
      { t: "workspace.hydrate", sinceHlc: null },
      { t: "spaces.update", spaceIds: ["work", "late"] },
    ]);
    transport.stop();
  });

  it("maps lease frames to LeaseOutcome and settles pending leases offline on close", async () => {
    const transport = new WsTransport("ws://hub", "dev-a", "desktop");
    const socket = await connect(transport, ["work"]);
    socket.sent.length = 0;

    const denied = transport.acquireLease("work", "origin-1");
    socket.receive({
      t: "lease.denied",
      spaceId: "work",
      originId: "origin-1",
      holderDeviceId: "cloud-1",
      holderKind: "cloud",
      exclusive: true,
      expiresAtMs: 10,
    });
    await expect(denied).resolves.toEqual({
      granted: false,
      denied: { holderDeviceId: "cloud-1", holderKind: "cloud", exclusive: true },
    });

    const granted = transport.acquireLease("work", "origin-2", {
      exclusive: true,
      ttlMs: 120_000,
      force: true,
      candidate: { recordId: "r", hlc: { physicalMs: 1, logical: 0, deviceId: "dev-a" } },
    });
    expect(socket.frames().at(-1)).toEqual({
      t: "lease.acquire",
      spaceId: "work",
      originId: "origin-2",
      force: true,
      recordId: "r",
      candidateHlc: { physicalMs: 1, logical: 0, deviceId: "dev-a" },
      exclusive: true,
      ttlMs: 120_000,
    });
    socket.receive({
      t: "lease.granted",
      spaceId: "work",
      originId: "origin-2",
      holderDeviceId: "dev-a",
      expiresAtMs: 10,
      exclusive: true,
    });
    await expect(granted).resolves.toEqual({ granted: true, exclusive: true });

    const pending = transport.acquireLease("work", "origin-3");
    socket.emit("close", { code: 1006 });
    await expect(pending).resolves.toEqual({
      granted: false,
      reason: "offline",
    });
    expect(transport.state).toBe("offline");
    await expect(transport.acquireLease("work", "origin-4")).resolves.toEqual({
      granted: false,
      reason: "offline",
    });
    expect(internals(transport).reconnectTimer).not.toBeNull();
    transport.stop();
    expect(internals(transport).reconnectTimer).toBeNull();
  });

  it("times out an unanswered lease request", async () => {
    vi.useFakeTimers();
    try {
      const transport = new WsTransport("ws://hub", "dev-a", "desktop");
      transport.start(["work"]);
      await vi.advanceTimersByTimeAsync(0);
      const socket = FakeSocket.instances[0];
      if (socket === undefined) throw new Error("no socket");
      socket.emit("open");
      socket.receive({ t: "hello.ack", serverTimeMs: 1, presence: [] });
      const pending = transport.acquireLease("work", "origin-1");
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(pending).resolves.toEqual({
        granted: false,
        reason: "timeout",
      });
      transport.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("forwards lease.released and lease.revoked to their events", async () => {
    const events: string[] = [];
    const transport = new WsTransport("ws://hub", "dev-a", "desktop", {
      onLeaseReleased: (spaceId, originId) => events.push(`released:${spaceId}:${originId}`),
      onLeaseRevoked: (spaceId, originId) => events.push(`revoked:${spaceId}:${originId}`),
    });
    const socket = await connect(transport, ["work"]);
    socket.receive({ t: "lease.released", spaceId: "work", originId: "o1" });
    socket.receive({
      t: "lease.revoked",
      spaceId: "work",
      originId: "o2",
      newHolderDeviceId: "dev-b",
    });
    expect(events).toEqual(["released:work:o1", "revoked:work:o2"]);
    transport.stop();
  });

  it("close code 4003 sets state off, emits onRevoked, and never reconnects", async () => {
    const states: TransportState[] = [];
    const interrupted: string[] = [];
    let revoked = 0;
    const events: TransportEvents = {
      onStateChanged: (state) => states.push(state),
      onPublishInterrupted: (ids) => interrupted.push(...ids),
      onRevoked: () => {
        revoked += 1;
      },
    };
    const transport = new WsTransport("ws://hub", "dev-a", "desktop", events);
    const socket = await connect(transport, ["work"]);
    const recordId = "a".repeat(64);
    transport.publish([wire(recordId)]);

    socket.emit("close", { code: CLOSE_REVOKED });
    expect(transport.state).toBe("off");
    expect(revoked).toBe(1);
    expect(interrupted).toEqual([recordId]);
    expect(internals(transport).reconnectTimer).toBeNull();
    expect(internals(transport).stopped).toBe(true);
    expect(states).toEqual(["connecting", "connected", "off"]);

    // Nothing dials again, publishes are dropped, leases resolve offline.
    transport.reconnect();
    await settle(() => true);
    expect(FakeSocket.instances).toHaveLength(1);
    transport.publish([wire(recordId)]);
    await expect(transport.acquireLease("work", "o")).resolves.toEqual({
      granted: false,
      reason: "offline",
    });
    await expect(transport.flushCookiePublishes()).resolves.toBe(false);

    // A later explicit start (after re-enrollment) dials again.
    transport.start(["work"]);
    await settle(() => FakeSocket.instances.length === 2);
    expect(transport.state).toBe("connecting");
    transport.stop();
  });

  it("declares at most MAX_DECLARED_SPACES in hello and in spaces.update", async () => {
    // Finding V8c: the hub answers an over-cap hello with an `error` frame —
    // no ack, no close — and `hello_required` to everything after it, so an
    // uncapped client with 65+ Spaces sat in `connecting` for ever.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const many = Array.from(
      { length: MAX_DECLARED_SPACES + 5 },
      (_unused, i) => `space-${String(i)}`,
    );
    const transport = new WsTransport("ws://hub", "dev-a", "desktop");
    const socket = await connect(transport, many);

    const hello = socket.frames()[0];
    expect(hello?.["spaceIds"]).toEqual(many.slice(0, MAX_DECLARED_SPACES));
    expect(transport.state).toBe("connected");
    // One warning for the connection, not one per declared space.
    expect(warn).toHaveBeenCalledTimes(1);
    // The set did not change, so the hello.ack must not queue an update.
    expect(socket.frames().some((frame) => frame["t"] === "spaces.update")).toBe(
      false,
    );

    socket.sent.length = 0;
    void transport.updateSpaces([...many, "space-extra"]);
    expect(socket.frames()).toEqual([
      { t: "spaces.update", spaceIds: many.slice(0, MAX_DECLARED_SPACES) },
    ]);
    warn.mockRestore();
    transport.stop();
  });

  it("re-dials with fewer spaces when a hub refuses the hello instead of hanging in connecting", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const transport = new WsTransport("ws://hub", "dev-a", "desktop");
    transport.start(["a", "b", "c", "d"]);
    await settle(() => FakeSocket.instances.length === 1);
    const socket = FakeSocket.instances[0];
    if (socket === undefined) throw new Error("no socket");
    socket.emit("open");
    expect(transport.state).toBe("connecting");

    // A stricter hub than this build knows about: no ack, no close.
    socket.receive({ t: "error", code: "too_many_spaces", message: "cap" });
    expect(transport.state).toBe("offline");
    expect(socket.closed).toBe(true);
    expect(internals(transport).reconnectTimer).not.toBeNull();

    // The backoff re-dial declares half as many, so this terminates.
    (
      transport as unknown as { connect(): void }
    ).connect();
    await settle(() => FakeSocket.instances.length === 2);
    const second = FakeSocket.instances[1];
    if (second === undefined) throw new Error("no second socket");
    second.emit("open");
    expect(second.frames()[0]).toEqual({
      t: "hello",
      deviceId: "dev-a",
      kind: "desktop",
      spaceIds: ["a", "b"],
    });
    warn.mockRestore();
    transport.stop();
  });

  it("a normal close schedules a reconnect instead", async () => {
    let revoked = 0;
    const transport = new WsTransport("ws://hub", "dev-a", "desktop", {
      onRevoked: () => {
        revoked += 1;
      },
    });
    const socket = await connect(transport, ["work"]);
    socket.emit("close", { code: 1001 });
    expect(transport.state).toBe("offline");
    expect(revoked).toBe(0);
    expect(internals(transport).stopped).toBe(false);
    expect(internals(transport).reconnectTimer).not.toBeNull();
    transport.stop();
    expect(internals(transport).reconnectTimer).toBeNull();
  });
});
