import { describe, expect, it, vi } from "vitest";
import { MAX_FRAME_BYTES, type CookieRecordWire } from "@pistachio/sync-protocol";
import { WsTransport, type TransportEvents } from "../src/index.js";

function connectedTransport(
  sent: string[],
  events: TransportEvents = {},
): WsTransport {
  const transport = new WsTransport("ws://127.0.0.1:1", "dev-a", "desktop", events);
  Object.assign(transport, {
    state: "connected",
    socket: {
      readyState: 1,
      send: (value: string) => sent.push(value),
      close: () => undefined,
      addEventListener: () => undefined,
    },
  });
  return transport;
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

/** A record no frame can hold: `chunkFrames` withholds it. */
function oversized(recordId: string): CookieRecordWire {
  return { ...wire(recordId), sealedRecord: "x".repeat(MAX_FRAME_BYTES + 1) };
}

describe("WsTransport publish acknowledgements", () => {
  it("surfaces lease rejections before reporting convergence", () => {
    const events: string[] = [];
    const transport = new WsTransport("ws://127.0.0.1:1", "dev-a", "desktop", {
      onPublishRejected: (rejections) =>
        events.push(`rejected:${rejections[0]?.reason}`),
      onConverged: () => events.push("converged"),
    });

    (
      transport as unknown as {
        handleFrame(raw: string): void;
      }
    ).handleFrame(
      JSON.stringify({
        t: "publish.ack",
        accepted: [],
        rejected: [{ recordId: "record-1", reason: "lease_required" }],
      }),
    );

    expect(events).toEqual(["rejected:lease_required", "converged"]);
  });

  it("reports the accepted ids of an ack before its rejections", () => {
    // The engine consumes its in-flight window in ack order, so the accepted
    // half of a frame must reach it first.
    const seen: string[] = [];
    const transport = new WsTransport("ws://127.0.0.1:1", "dev-a", "desktop", {
      onPublishAccepted: (recordIds) => seen.push(`accepted:${recordIds.join(",")}`),
      onPublishRejected: (rejections) => seen.push(`rejected:${rejections[0]?.recordId}`),
    });

    (transport as unknown as { handleFrame(raw: string): void }).handleFrame(
      JSON.stringify({
        t: "publish.ack",
        accepted: ["record-1", "record-2"],
        rejected: [{ recordId: "record-3", reason: "rate_limited" }],
      }),
    );

    expect(seen).toEqual(["accepted:record-1,record-2", "rejected:record-3"]);
  });

  it("does not report acceptance when the hub accepted nothing", () => {
    const seen: string[] = [];
    const transport = new WsTransport("ws://127.0.0.1:1", "dev-a", "desktop", {
      onPublishAccepted: () => seen.push("accepted"),
    });

    (transport as unknown as { handleFrame(raw: string): void }).handleFrame(
      JSON.stringify({
        t: "publish.ack",
        accepted: [],
        rejected: [{ recordId: "record-1", reason: "stale" }],
      }),
    );

    expect(seen).toEqual([]);
  });

  it("does not open the cookie fence until every publish is acknowledged", async () => {
    const sent: string[] = [];
    const transport = connectedTransport(sent);
    const recordId = "a".repeat(64);
    transport.publish([wire(recordId)]);

    let settled = false;
    const flush = transport.flushCookiePublishes().then((confirmed) => {
      settled = true;
      return confirmed;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    (transport as unknown as { handleFrame(raw: string): void }).handleFrame(
      JSON.stringify({ t: "publish.ack", accepted: [recordId], rejected: [] }),
    );
    await expect(flush).resolves.toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("accepts a stale ack as proof the hub already has that cookie winner", async () => {
    const sent: string[] = [];
    const transport = connectedTransport(sent);
    const recordId = "d".repeat(64);
    transport.publish([wire(recordId)]);
    const flush = transport.flushCookiePublishes();

    (transport as unknown as { handleFrame(raw: string): void }).handleFrame(
      JSON.stringify({
        t: "publish.ack",
        accepted: [],
        rejected: [{ recordId, reason: "stale" }],
      }),
    );

    await expect(flush).resolves.toBe(true);
  });

  it("does not count an exclusive_lease rejection against the cookie fence", async () => {
    const sent: string[] = [];
    const rejected: string[] = [];
    const transport = connectedTransport(sent, {
      onPublishRejected: (rejections) =>
        rejected.push(...rejections.map((r) => r.reason)),
    });
    const recordId = "e".repeat(64);
    transport.publish([wire(recordId)]);
    const flush = transport.flushCookiePublishes();

    (transport as unknown as { handleFrame(raw: string): void }).handleFrame(
      JSON.stringify({
        t: "publish.ack",
        accepted: [],
        rejected: [{ recordId, reason: "exclusive_lease" }],
      }),
    );

    // The engine owns the deferred record; the fence stays open.
    await expect(flush).resolves.toBe(true);
    expect(rejected).toEqual(["exclusive_lease"]);
    await expect(transport.flushCookiePublishes()).resolves.toBe(true);

    // A lease_required rejection still holds the fence closed until retried.
    transport.publish([wire(recordId)]);
    (transport as unknown as { handleFrame(raw: string): void }).handleFrame(
      JSON.stringify({
        t: "publish.ack",
        accepted: [],
        rejected: [{ recordId, reason: "lease_required" }],
      }),
    );
    await expect(transport.flushCookiePublishes()).resolves.toBe(false);
  });

  it("holds the cookie fence closed for a rate_limited ack and for a reason it does not know", async () => {
    const sent: string[] = [];
    const rejected: string[] = [];
    const transport = connectedTransport(sent, {
      onPublishRejected: (rejections) =>
        rejected.push(...rejections.map((r) => r.reason)),
    });
    const throttled = "1".repeat(64);
    const future = "2".repeat(64);
    transport.publish([wire(throttled)]);
    const flush = transport.flushCookiePublishes();

    // The hub stored nothing: unlike `stale`, this must not confirm the
    // causal fence. An unrecognised reason from a newer hub must not drop
    // the whole frame (that strands every record in the batch) and must not
    // be treated as durable either.
    (transport as unknown as { handleFrame(raw: string): void }).handleFrame(
      JSON.stringify({
        t: "publish.ack",
        accepted: [],
        rejected: [
          { recordId: throttled, reason: "rate_limited" },
          { recordId: future, reason: "quota_exhausted_v2" },
        ],
      }),
    );

    await expect(flush).resolves.toBe(false);
    expect(rejected).toEqual(["rate_limited", "unknown"]);
  });

  it("does not hold the cookie fence closed for a record it withheld as oversized", async () => {
    // Finding V8a: the id was added to the pending set before chunkFrames
    // decided to withhold the record, so no ack could ever clear it and every
    // flush timed out false while the socket loss looped it through the
    // offline queue.
    const sent: string[] = [];
    const withheld: string[] = [];
    const interrupted: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const transport = connectedTransport(sent, {
      onPublishWithheld: (what) => withheld.push(what),
      onPublishInterrupted: (recordIds) => interrupted.push(...recordIds),
    });
    const huge = "f".repeat(64);
    const small = "0".repeat(64);
    transport.publish([oversized(huge), wire(small)]);

    // Only the record that fits went out; the withheld one is still warned about.
    expect(sent).toHaveLength(1);
    expect(withheld).toEqual([`record ${huge}`]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();

    (transport as unknown as { handleFrame(raw: string): void }).handleFrame(
      JSON.stringify({ t: "publish.ack", accepted: [small], rejected: [] }),
    );
    await expect(transport.flushCookiePublishes()).resolves.toBe(true);

    // And a socket loss must not push it back through the offline queue.
    const internal = transport as unknown as {
      socket: unknown;
      scheduleReconnect(socket: unknown): void;
    };
    internal.scheduleReconnect(internal.socket);
    expect(interrupted).toEqual([]);
  });

  it("keeps the fence closed until every wire of one record is acknowledged", async () => {
    // Finding V8b: two rapid writes to one cookie put two wires in flight;
    // a Set lost the second, so the first ack opened the fence and a later
    // socket loss never reported the second wire back to the engine.
    const sent: string[] = [];
    const interrupted: string[] = [];
    const transport = connectedTransport(sent, {
      onPublishInterrupted: (recordIds) => interrupted.push(...recordIds),
    });
    const recordId = "9".repeat(64);
    transport.publish([wire(recordId)]);
    transport.publish([wire(recordId)]);
    expect(sent).toHaveLength(2);

    let settled = false;
    const flush = transport.flushCookiePublishes().then((confirmed) => {
      settled = true;
      return confirmed;
    });
    (transport as unknown as { handleFrame(raw: string): void }).handleFrame(
      JSON.stringify({ t: "publish.ack", accepted: [recordId], rejected: [] }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    // The socket dies with the second wire unacked: the engine has to hear
    // about it or that wire stays marked published for ever.
    const internal = transport as unknown as {
      socket: unknown;
      scheduleReconnect(socket: unknown): void;
    };
    internal.scheduleReconnect(internal.socket);
    await expect(flush).resolves.toBe(false);
    expect(interrupted).toEqual([recordId]);
  });

  it("counts a rejected wire against the same record's remaining wires", async () => {
    const sent: string[] = [];
    const transport = connectedTransport(sent);
    const recordId = "8".repeat(64);
    transport.publish([wire(recordId)]);
    transport.publish([wire(recordId)]);
    const flush = transport.flushCookiePublishes();

    const handle = (transport as unknown as { handleFrame(raw: string): void })
      .handleFrame.bind(transport);
    handle(
      JSON.stringify({
        t: "publish.ack",
        accepted: [],
        rejected: [{ recordId, reason: "stale" }],
      }),
    );
    // One wire still out: the fence stays closed.
    let settled = false;
    void flush.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    handle(JSON.stringify({ t: "publish.ack", accepted: [recordId], rejected: [] }));
    await expect(flush).resolves.toBe(true);
  });

  it("coalesces concurrent same-origin lease requests", async () => {
    const sent: string[] = [];
    const transport = connectedTransport(sent);
    const first = transport.acquireLease("space-1", "google-origin");
    const second = transport.acquireLease("space-1", "google-origin");

    expect(sent.map((value) => JSON.parse(value))).toEqual([
      {
        t: "lease.acquire",
        spaceId: "space-1",
        originId: "google-origin",
      },
    ]);
    (transport as unknown as { handleFrame(raw: string): void }).handleFrame(
      JSON.stringify({
        t: "lease.granted",
        spaceId: "space-1",
        originId: "google-origin",
        holderDeviceId: "dev-a",
        expiresAtMs: Date.now() + 60_000,
        exclusive: false,
      }),
    );

    await expect(Promise.all([first, second])).resolves.toEqual([
      { granted: true, exclusive: false },
      { granted: true, exclusive: false },
    ]);
  });

  it("returns unacknowledged records to the engine when a socket is replaced", () => {
    const sent: string[] = [];
    const interrupted: string[] = [];
    const transport = connectedTransport(sent, {
      onPublishInterrupted: (recordIds) => interrupted.push(...recordIds),
    });
    const recordId = "c".repeat(64);
    transport.publish([wire(recordId)]);

    const internal = transport as unknown as {
      socket: unknown;
      scheduleReconnect(socket: unknown): void;
    };
    internal.scheduleReconnect(internal.socket);

    expect(interrupted).toEqual([recordId]);
    expect(transport.state).toBe("offline");
  });
});
