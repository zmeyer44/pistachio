import { describe, expect, it, vi } from "vitest";
import type { IMessageThreadRouteRequest } from "@pistachio/protocol";
import { createCloudBrowserApp, type SteerBody } from "../src/app.js";
import type { ControlDevice } from "../src/control-client.js";
import { USER_A } from "./helpers/keys.js";

const device: ControlDevice = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Cloud browser",
  platform: "cloud",
  devicePublicKey: "AA==",
  agreementPublicKey: "AA==",
  createdAt: "2026-09-02T00:00:00.000Z",
  lastSeenAt: null,
  revokedAt: null,
};

function build(overrides: { provisionStatus?: 200 | 201 | 409; browser?: "not_started" | "connected" | "disconnected" } = {}) {
  const provision = vi.fn(async () =>
    overrides.provisionStatus === 409 ? ({ status: 409, error: "cloud_device_exists" } as const) : ({ status: overrides.provisionStatus ?? 201, device } as const),
  );
  const steer = vi.fn<(body: SteerBody) => Promise<void>>(async () => undefined);
  const routeIMessage = vi.fn(async (_input: IMessageThreadRouteRequest) => ({ decision: "continue" as const, confidence: 0.92 }));
  const app = createCloudBrowserApp({
    serviceToken: "svc-token",
    provision,
    steer,
    routeIMessage,
    ...(overrides.browser === undefined ? {} : { health: () => ({ browser: overrides.browser as "connected" }) }),
  });
  return { app, provision, steer, routeIMessage };
}

const json = (body: unknown, token = "svc-token"): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify(body),
});

describe("cloud browser HTTP surface", () => {
  it("answers healthz without auth", async () => {
    const { app } = build();
    const response = await app.request("/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, browser: "not_started" });
  });

  it("provisions only under the service bearer with a valid body", async () => {
    const { app, provision } = build();
    expect((await app.request("/v1/devices/provision", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await app.request("/v1/devices/provision", json({ userId: USER_A, nonce: "n" }, "wrong"))).status).toBe(401);
    expect((await app.request("/v1/devices/provision", json({ userId: "nope", nonce: "n" }))).status).toBe(400);
    expect((await app.request("/v1/devices/provision", { ...json({}), body: "{not json" })).status).toBe(400);
    const created = await app.request("/v1/devices/provision", json({ userId: USER_A, nonce: "n" }));
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ device });
    expect(provision).toHaveBeenCalledWith(USER_A, "n");
    const { app: existing } = build({ provisionStatus: 200 });
    expect((await existing.request("/v1/devices/provision", json({ userId: USER_A, nonce: "n" }))).status).toBe(200);
    const { app: taken } = build({ provisionStatus: 409 });
    const conflict = await taken.request("/v1/devices/provision", json({ userId: USER_A, nonce: "n" }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "cloud_device_exists" });
  });

  it("accepts both steer bodies and rejects everything else", async () => {
    const { app, steer } = build();
    const revoked = { kind: "device.revoked", userId: USER_A, deviceId: device.id };
    expect((await app.request("/v1/tasks/steer", json(revoked))).status).toBe(204);
    const command = { kind: "run.command", runId: device.id, command: { t: "cmd.interrupt" } };
    expect((await app.request("/v1/tasks/steer", json(command))).status).toBe(204);
    expect(steer.mock.calls.map((call) => call[0])).toEqual([revoked, command]);
    expect((await app.request("/v1/tasks/steer", json({ kind: "nope" }))).status).toBe(400);
    expect((await app.request("/v1/tasks/steer", json(revoked, "wrong"))).status).toBe(401);
    const oversized = await app.request("/v1/tasks/steer", {
      ...json({}),
      headers: { "content-type": "application/json", authorization: "Bearer svc-token", "content-length": String(10 * 1024 * 1024) },
      body: "{}",
    });
    expect(oversized.status).toBe(413);
  });

  it("authenticates and validates synchronous iMessage routing requests", async () => {
    const { app, routeIMessage } = build();
    const input = {
      candidate: {
        runId: "33333333-3333-4333-8333-333333333333",
        userId: USER_A,
        spaceId: "work",
        intent: "Book dinner",
        status: "completed",
        createdAt: "2026-09-04T17:00:00.000Z",
        updatedAt: "2026-09-04T17:05:00.000Z",
        completedAt: "2026-09-04T17:05:00.000Z",
        lastIMessageAt: "2026-09-04T17:00:00.000Z",
      },
      incoming: { text: "Make it 7 pm instead", receivedAt: "2026-09-04T17:06:00.000Z" },
      events: [],
    };
    expect((await app.request("/v1/imessage/route", json(input, "wrong"))).status).toBe(401);
    expect((await app.request("/v1/imessage/route", json({ ...input, incoming: { text: "" } }))).status).toBe(400);
    const response = await app.request("/v1/imessage/route", json(input));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ decision: "continue", confidence: 0.92 });
    expect(routeIMessage).toHaveBeenCalledWith(input, expect.any(AbortSignal));

    // Control mints `${t}:${runId}:${idempotencyKey}:${index}` with client
    // keys of up to 128 characters, so a real command id exceeds 128.
    const longId = `cmd.message:${input.candidate.runId}:${"k".repeat(128)}:0`;
    expect(longId.length).toBeGreaterThan(128);
    const withLongId = {
      ...input,
      events: [{ eventId: longId, at: "2026-09-04T17:01:00.000Z", event: { t: "cmd.message", text: "Book dinner" } }],
    };
    expect((await app.request("/v1/imessage/route", json(withLongId))).status).toBe(200);
  });
});

describe("health", () => {
  it("is unhealthy once the browser is gone, not merely while Node still answers", async () => {
    expect((await build().app.request("/healthz")).status).toBe(200);
    const connected = await build({ browser: "connected" }).app.request("/healthz");
    expect(connected.status).toBe(200);
    expect(await connected.json()).toEqual({ ok: true, browser: "connected" });
    const gone = await build({ browser: "disconnected" }).app.request("/healthz");
    expect(gone.status).toBe(503);
    expect(await gone.json()).toEqual({ ok: false, browser: "disconnected" });
  });
});
