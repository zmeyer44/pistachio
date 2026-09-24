import { describe, expect, it } from "vitest";
import { CLOSE_REVOKED, connectionStorageKey } from "../src/hub-core.js";
import {
  FakeConnection,
  bind,
  frame,
  hex64,
  makeFixture,
  makeHlc,
  makeRecord,
  sendHello,
} from "./helpers.js";

const originId = hex64(0xcafe);

describe("HubCore.revokeDevice", () => {
  it("persists the revocation, clears device state, and returns the device's sockets", async () => {
    const { core, storage } = makeFixture();
    const a1 = new FakeConnection();
    const a2 = new FakeConnection();
    const b = new FakeConnection();
    await sendHello(core, a1, "dev-a", ["s1"]);
    await sendHello(core, a2, "dev-a", ["s1"], [a1]);
    await sendHello(core, b, "dev-b", ["s1"], [a1, a2]);

    const toClose = await core.revokeDevice("dev-a", [a1, a2, b]);
    expect(toClose).toHaveLength(2);
    expect(toClose[0]).toBe(a1);
    expect(toClose[1]).toBe(a2);
    expect(await storage.get("revoked:dev-a")).toBe(true);
    expect(
      await storage.get(connectionStorageKey("dev-a", a1.connectionId)),
    ).toBeUndefined();
    expect(
      await storage.get(connectionStorageKey("dev-a", a2.connectionId)),
    ).toBeUndefined();
    expect(await storage.get("presence:dev-a")).toBeUndefined();
    expect(await core.isRevoked("dev-a")).toBe(true);
  });

  it("broadcasts offline to other devices and leaves them untouched", async () => {
    const { core, storage, clock } = makeFixture();
    const a = new FakeConnection();
    const b = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);
    await sendHello(core, b, "dev-b", ["s1"], [a]);

    b.clear();
    const toClose = await core.revokeDevice("dev-a", [a, b]);
    expect(toClose).toEqual([a]);
    expect(b.ofType("presence")[0]?.devices).toEqual([
      { deviceId: "dev-a", kind: "desktop", online: false, lastSeenMs: clock.nowMs },
    ]);
    // The unrelated device keeps its state and can still publish.
    expect(await core.isRevoked("dev-b")).toBe(false);
    expect(
      await storage.get(connectionStorageKey("dev-b", b.connectionId)),
    ).toEqual(["s1"]);
    expect(await storage.get("presence:dev-b")).toBeDefined();
    const record = makeRecord({ spaceId: "s1", hlc: makeHlc(10, "dev-b") });
    await core.handleMessage(b, frame({ t: "publish", records: [record] }), []);
    expect(b.ofType("publish.ack")[0]?.accepted).toEqual([record.recordId]);
  });

  it("releases the revoked device's leases and broadcasts lease.released to everyone", async () => {
    const { core, storage } = makeFixture();
    const c = new FakeConnection();
    const b = new FakeConnection();
    await sendHello(core, c, "dev-c", ["s1"], [], "cloud");
    await sendHello(core, b, "dev-b", ["s1"], [c]);
    await core.handleMessage(
      c,
      frame({ t: "lease.acquire", spaceId: "s1", originId, exclusive: true }),
      [b],
    );
    expect(await storage.get(`lease:s1:${originId}`)).toBeDefined();

    b.clear();
    c.clear();
    await core.revokeDevice("dev-c", [c, b]);
    expect(await storage.get(`lease:s1:${originId}`)).toBeUndefined();
    expect(b.ofType("lease.released")).toEqual([
      { t: "lease.released", spaceId: "s1", originId },
    ]);
    expect(c.ofType("lease.released")).toEqual([
      { t: "lease.released", spaceId: "s1", originId },
    ]);
    expect(b.ofType("presence")[0]?.devices).toEqual([
      { deviceId: "dev-c", kind: "cloud", online: false, lastSeenMs: expect.any(Number) as number },
    ]);

    await core.handleMessage(
      b,
      frame({ t: "lease.acquire", spaceId: "s1", originId }),
      [],
    );
    expect(b.ofType("lease.granted")[0]?.holderDeviceId).toBe("dev-b");
  });

  it("refuses a revoked device's reconnect with 4003", async () => {
    const { core, storage } = makeFixture();
    await core.revokeDevice("dev-a", []);

    const fresh = new FakeConnection();
    await sendHello(core, fresh, "dev-a", ["s1"]);
    expect(fresh.closed).toEqual([{ code: CLOSE_REVOKED, reason: "revoked" }]);
    expect(fresh.ofType("hello.ack")).toHaveLength(0);
    expect(
      await storage.get(connectionStorageKey("dev-a", fresh.connectionId)),
    ).toBeUndefined();

    // The bound identity wins over the hello frame's claim: a revoked device
    // cannot masquerade as another, and is refused for what it is.
    const sneaky = bind(new FakeConnection(), "dev-a");
    await core.handleMessage(
      sneaky,
      frame({ t: "hello", deviceId: "dev-x", kind: "desktop", spaceIds: [] }),
      [],
    );
    expect(sneaky.closed).toEqual([{ code: CLOSE_REVOKED, reason: "revoked" }]);
    expect(await storage.get("presence:dev-x")).toBeUndefined();
  });

  it("kills an already-open socket on its next frame if the close was missed", async () => {
    // A device connected before revocation; imagine the socket-close raced
    // or was dropped, so this exact connection stays open. Its next frame
    // must terminate it, bounding sync to one more message.
    const { core, storage } = makeFixture();
    const live = new FakeConnection();
    await sendHello(core, live, "dev-a", ["s1"]);
    live.clear();

    // Persist revocation WITHOUT going through revokeDevice's socket-close
    // (the missed-close scenario).
    await storage.put("revoked:dev-a", true);

    await core.handleMessage(live, frame({ t: "ping" }), []);
    expect(live.closed).toEqual([{ code: CLOSE_REVOKED, reason: "revoked" }]);
    expect(live.ofType("pong")).toHaveLength(0);

    // A publish from the same socket is likewise refused, not accepted.
    const other = new FakeConnection();
    await sendHello(core, other, "dev-b", ["s1"]);
    const record = makeRecord({ spaceId: "s1", hlc: makeHlc(5, "dev-a") });
    await core.handleMessage(live, frame({ t: "publish", records: [record] }), [
      other,
    ]);
    expect(live.ofType("publish.ack")).toHaveLength(0);
    expect(other.ofType("records")).toHaveLength(0);
  });

  it("closing the revoked socket afterwards does not resurrect presence", async () => {
    const { core, storage } = makeFixture();
    const a = new FakeConnection();
    const b = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);
    await sendHello(core, b, "dev-b", ["s1"], [a]);

    await core.revokeDevice("dev-a", [a, b]);
    b.clear();
    await core.handleClose(a, [b]);
    expect(b.ofType("presence")).toHaveLength(0);
    expect(b.ofType("lease.released")).toHaveLength(0);
    expect(await storage.get("presence:dev-a")).toBeUndefined();
  });

  it("closing a revoked socket still cleans up a lease that outlived the revocation", async () => {
    const { core, storage } = makeFixture();
    const a = new FakeConnection();
    const b = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);
    await sendHello(core, b, "dev-b", ["s1"], [a]);
    await core.handleMessage(
      a,
      frame({ t: "lease.acquire", spaceId: "s1", originId }),
      [b],
    );

    // Revocation persisted out of band (no revokeDevice lease sweep).
    await storage.put("revoked:dev-a", true);
    b.clear();
    await core.handleClose(a, [b]);
    expect(await storage.get(`lease:s1:${originId}`)).toBeUndefined();
    expect(b.ofType("lease.released")).toEqual([
      { t: "lease.released", spaceId: "s1", originId },
    ]);
    // …but presence is not resurrected for the revoked device.
    expect(b.ofType("presence")).toHaveLength(0);
  });
});
