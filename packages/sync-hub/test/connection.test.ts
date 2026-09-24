import { MAX_DECLARED_SPACES } from "@pistachio/sync-protocol";
import { describe, expect, it } from "vitest";
import {
  CLOSE_MALFORMED,
  CLOSE_UNAUTHENTICATED,
  connectionStorageKey,
} from "../src/hub-core.js";
import {
  FakeConnection,
  bind,
  frame,
  makeFixture,
  makeHlc,
  makeRecord,
  sendHello,
} from "./helpers.js";

describe("hello binding", () => {
  it("closes an unbound connection with 4001 on hello", async () => {
    const { core, storage } = makeFixture();
    const anon = new FakeConnection();
    await core.handleMessage(
      anon,
      frame({ t: "hello", deviceId: "dev-a", kind: "desktop", spaceIds: ["s1"] }),
      [],
    );
    expect(anon.closed).toEqual([
      { code: CLOSE_UNAUTHENTICATED, reason: "unauthenticated" },
    ]);
    expect(anon.sent).toHaveLength(0);
    expect(storage.size).toBe(0);
  });

  it("closes an unbound connection with 4001 on any other frame too", async () => {
    const { core } = makeFixture();
    const anon = new FakeConnection();
    await core.handleMessage(anon, frame({ t: "ping" }), []);
    expect(anon.closed).toEqual([
      { code: CLOSE_UNAUTHENTICATED, reason: "unauthenticated" },
    ]);
    expect(anon.sent).toHaveLength(0);
  });

  it("a hello naming another device is device_mismatch, closes 4400, and changes nothing", async () => {
    const { core, storage } = makeFixture();
    const b = new FakeConnection();
    await sendHello(core, b, "dev-b", ["s1"]);
    b.clear();

    const a = bind(new FakeConnection(), "dev-a");
    await core.handleMessage(
      a,
      frame({ t: "hello", deviceId: "dev-x", kind: "desktop", spaceIds: ["s1"] }),
      [b],
    );
    expect(a.ofType("error")[0]?.code).toBe("device_mismatch");
    expect(a.ofType("hello.ack")).toHaveLength(0);
    expect(a.closed).toEqual([{ code: CLOSE_MALFORMED, reason: "device_mismatch" }]);
    // The binding is untouched and no state was written for either id.
    expect(a.deviceId).toBe("dev-a");
    expect(await storage.get(connectionStorageKey("dev-a", a.connectionId))).toBeUndefined();
    expect(await storage.get(connectionStorageKey("dev-x", a.connectionId))).toBeUndefined();
    expect(await storage.get("presence:dev-a")).toBeUndefined();
    expect(await storage.get("presence:dev-x")).toBeUndefined();
    expect(b.sent).toHaveLength(0);
  });

  it("a desktop token with hello.kind cloud is device_mismatch", async () => {
    const { core, storage } = makeFixture();
    const a = bind(new FakeConnection(), "dev-a", "desktop");
    await core.handleMessage(
      a,
      frame({ t: "hello", deviceId: "dev-a", kind: "cloud", spaceIds: [] }),
      [],
    );
    expect(a.ofType("error")[0]?.code).toBe("device_mismatch");
    expect(a.closed).toEqual([{ code: CLOSE_MALFORMED, reason: "device_mismatch" }]);
    expect(a.kind).toBe("desktop");
    expect(await storage.get("presence:dev-a")).toBeUndefined();

    // And the other way round: a cloud token cannot claim to be a desktop.
    const c = bind(new FakeConnection(), "dev-c", "cloud");
    await core.handleMessage(
      c,
      frame({ t: "hello", deviceId: "dev-c", kind: "desktop", spaceIds: [] }),
      [],
    );
    expect(c.ofType("error")[0]?.code).toBe("device_mismatch");
    expect(c.closed).toEqual([{ code: CLOSE_MALFORMED, reason: "device_mismatch" }]);
  });
});

describe("declared space persistence", () => {
  it("rejects hello with more than 64 spaces but keeps the socket usable", async () => {
    const { core, storage } = makeFixture();
    const a = new FakeConnection();
    const tooMany = Array.from(
      { length: MAX_DECLARED_SPACES + 1 },
      (_, i) => `space-${i}`,
    );
    await sendHello(core, a, "dev-a", tooMany);
    expect(a.ofType("error")[0]?.code).toBe("too_many_spaces");
    expect(a.ofType("hello.ack")).toHaveLength(0);
    expect(a.closed).toEqual([]);
    expect(
      await storage.get(connectionStorageKey("dev-a", a.connectionId)),
    ).toBeUndefined();

    // Socket stays open: a corrected hello persists the full set.
    const atCap = tooMany.slice(0, MAX_DECLARED_SPACES);
    await sendHello(core, a, "dev-a", atCap);
    expect(a.ofType("hello.ack")).toHaveLength(1);
    expect(
      await storage.get(connectionStorageKey("dev-a", a.connectionId)),
    ).toEqual(atCap);
  });

  it("space bindings come from storage, not the connection object", async () => {
    const { core } = makeFixture();
    const a = new FakeConnection();
    const b = new FakeConnection();
    const manySpaces = Array.from(
      { length: MAX_DECLARED_SPACES },
      (_, i) => `space-${i}`,
    );
    await sendHello(core, a, "dev-a", manySpaces);
    await sendHello(core, b, "dev-b", ["space-63"], [a]);

    // Fresh connection objects carry only the bound identity and the same
    // connectionId; the space set must come from storage.
    const a2 = bind(new FakeConnection(), "dev-a");
    a2.connectionId = a.connectionId;
    const b2 = bind(new FakeConnection(), "dev-b");
    b2.connectionId = b.connectionId;

    const record = makeRecord({
      spaceId: "space-63",
      hlc: makeHlc(10, "dev-a"),
    });
    await core.handleMessage(a2, frame({ t: "publish", records: [record] }), [
      b2,
    ]);
    expect(a2.ofType("publish.ack")[0]?.accepted).toEqual([record.recordId]);
    expect(b2.ofType("records")[0]?.records).toEqual([record]);
  });

  it("close deletes the stored space set", async () => {
    const { core, storage } = makeFixture();
    const a = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);
    expect(
      await storage.get(connectionStorageKey("dev-a", a.connectionId)),
    ).toEqual(["s1"]);
    await core.handleClose(a, []);
    expect(
      await storage.get(connectionStorageKey("dev-a", a.connectionId)),
    ).toBeUndefined();
  });
});

describe("spaces.update", () => {
  it("rewrites the declaration, acks it, and never auto-streams hydration", async () => {
    const { core, storage } = makeFixture();
    const a = new FakeConnection();
    const b = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);
    await sendHello(core, b, "dev-b", ["s2"], [a]);
    const existing = makeRecord({ spaceId: "s2", hlc: makeHlc(5, "dev-b") });
    await core.handleMessage(b, frame({ t: "publish", records: [existing] }), [a]);
    expect(a.ofType("records")).toHaveLength(0);

    a.clear();
    await core.handleMessage(a, frame({ t: "spaces.update", spaceIds: ["s1", "s2"] }), [b]);
    expect(a.sent).toEqual([{ t: "spaces.update.ack", spaceIds: ["s1", "s2"] }]);
    expect(await storage.get(connectionStorageKey("dev-a", a.connectionId))).toEqual([
      "s1",
      "s2",
    ]);

    // Publishing into the newly declared space works, and fan-out from a
    // peer now reaches this socket.
    const record = makeRecord({ spaceId: "s2", hlc: makeHlc(10, "dev-a") });
    await core.handleMessage(a, frame({ t: "publish", records: [record] }), [b]);
    expect(a.ofType("publish.ack")[0]?.accepted).toEqual([record.recordId]);
    expect(b.ofType("records")[0]?.records).toEqual([record]);

    a.clear();
    const fromB = makeRecord({ spaceId: "s2", hlc: makeHlc(11, "dev-b") });
    await core.handleMessage(b, frame({ t: "publish", records: [fromB] }), [a]);
    expect(a.ofType("records")[0]?.records).toEqual([fromB]);

    // Dropping a space stops fan-out for it.
    a.clear();
    await core.handleMessage(a, frame({ t: "spaces.update", spaceIds: ["s1"] }), [b]);
    expect(a.ofType("spaces.update.ack")[0]?.spaceIds).toEqual(["s1"]);
    const later = makeRecord({ spaceId: "s2", hlc: makeHlc(12, "dev-b") });
    await core.handleMessage(b, frame({ t: "publish", records: [later] }), [a]);
    expect(a.ofType("records")).toHaveLength(0);
  });

  it("refuses more than 64 spaces and keeps the previous declaration", async () => {
    const { core, storage } = makeFixture();
    const a = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);
    a.clear();
    const tooMany = Array.from({ length: MAX_DECLARED_SPACES + 1 }, (_, i) => `space-${i}`);
    await core.handleMessage(a, frame({ t: "spaces.update", spaceIds: tooMany }), []);
    expect(a.ofType("error")[0]?.code).toBe("too_many_spaces");
    expect(a.ofType("spaces.update.ack")).toHaveLength(0);
    expect(a.closed).toEqual([]);
    expect(await storage.get(connectionStorageKey("dev-a", a.connectionId))).toEqual(["s1"]);

    const atCap = tooMany.slice(0, MAX_DECLARED_SPACES);
    await core.handleMessage(a, frame({ t: "spaces.update", spaceIds: atCap }), []);
    expect(a.ofType("spaces.update.ack")[0]?.spaceIds).toEqual(atCap);
  });

  it("requires hello first", async () => {
    const { core } = makeFixture();
    const a = bind(new FakeConnection(), "dev-a");
    await core.handleMessage(a, frame({ t: "spaces.update", spaceIds: ["s1"] }), []);
    expect(a.ofType("error")[0]?.code).toBe("hello_required");
    expect(a.ofType("spaces.update.ack")).toHaveLength(0);
  });
});
