/**
 * The gateway's three control-plane interactions against a fake control
 * server: the revocation feed, the throttle limits, and the usage flush.
 */

import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";

import { RevocationSet } from "../src/auth.js";
import { ControlClient } from "../src/control.js";
import { LIMITS_POLL_CONCURRENCY, LimitsPoller, parseLimits } from "../src/limits.js";
import { EgressMetrics, MetricsFlusher, type UsageReport } from "../src/metrics.js";
import { RevocationPoller, parseRevocationFeed } from "../src/revocation.js";
import type { TunnelClosedEvent } from "../src/server.js";
import { TunnelRegistry } from "../src/tunnels.js";
import {
  DEVICE_A,
  DEVICE_B,
  REVOCATION_PAGE_LIMIT,
  USER_A,
  USER_B,
  basic,
  credentialFor,
  startEcho,
  startFakeControl,
  startGateway,
  withTimeout,
  type EchoServer,
  type FakeControl,
  type GatewayHarness,
} from "./helpers.js";

/** A distinct, well-formed device id per synthetic feed row. */
const deviceIdFor = (n: number): string => `${n.toString(16).padStart(8, "0")}-2222-4222-8222-222222222222`;

describe("control plane", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanup.length > 0) await cleanup.pop()?.();
  });

  async function fixture(
    options: Parameters<typeof startGateway>[0] = {},
  ): Promise<{ echo: EchoServer; gw: GatewayHarness; control: FakeControl; client: ControlClient; target: string }> {
    const echo = await startEcho();
    cleanup.push(() => echo.close());
    const control = await startFakeControl();
    cleanup.push(() => control.close());
    const gw = await startGateway({ extraPorts: [echo.port], ...options });
    cleanup.push(() => gw.close());
    const client = new ControlClient({ baseUrl: control.url, token: control.token });
    return { echo, gw, control, client, target: `127.0.0.1:${echo.port}` };
  }

  it("polls the revocation feed with the cursor and cuts tunnels by device or credential", async () => {
    const { gw, control, client, target } = await fixture();
    const poller = new RevocationPoller({ control: client, revocations: gw.revocations, tunnels: gw.tunnels });

    const cut = credentialFor(USER_B, DEVICE_B);
    const kept = credentialFor(USER_B, DEVICE_B);
    const a = await gw.connectTo(target, basic(credentialFor(USER_A, DEVICE_A)));
    const b = await gw.connectTo(target, basic(cut));
    const c = await gw.connectTo(target, basic(kept));
    for (const socket of [a, b, c]) expect((await socket.readHead()).startsWith("HTTP/1.1 200")).toBe(true);

    await poller.pollNow();
    expect(poller.cursor).toBe(0);
    expect(control.requests.at(-1)?.url).toBe("/v1/egress/revocations?since=0");
    expect(control.requests.at(-1)?.authorization).toBe(`Bearer ${control.token}`);

    // credentialId null → the whole device goes.
    control.revocations.push({ id: 7, deviceId: DEVICE_A, credentialId: null, at: new Date().toISOString() });
    await poller.pollNow();
    expect(poller.cursor).toBe(7);
    await withTimeout(a.readToEnd(), 5000, "device tunnel cut by the feed");
    expect(gw.revocations.isDeviceRevoked(DEVICE_A)).toBe(true);
    const again = await gw.connectTo(target, basic(credentialFor(USER_A, DEVICE_A)));
    expect((await again.readResponse()).status).toBe(407);

    // A credential revocation cuts only that credential's tunnels.
    control.revocations.push({ id: 9, deviceId: DEVICE_B, credentialId: cut.credentialId, at: new Date().toISOString() });
    await poller.pollNow();
    // The poll resumes at the cursor and then probes the tail once more.
    expect(control.requests.map((r) => r.url)).toContain("/v1/egress/revocations?since=7");
    expect(control.requests.at(-1)?.url).toBe("/v1/egress/revocations?since=9");
    expect(poller.cursor).toBe(9);
    await withTimeout(b.readToEnd(), 5000, "credential tunnel cut by the feed");
    c.socket.write("alive");
    expect((await c.readExact(5)).toString()).toBe("alive");
    const reuse = await gw.connectTo(target, basic(cut));
    expect((await reuse.readResponse()).status).toBe(407);
    const fresh = await gw.connectTo(target, basic(kept));
    expect((await fresh.readHead()).startsWith("HTTP/1.1 200")).toBe(true);

    // A failing control plane keeps the cursor and state; the next poll resumes.
    control.failWith = 503;
    await poller.pollNow();
    expect(poller.cursor).toBe(9);
    control.failWith = null;
    await poller.pollNow();
    expect(control.requests.at(-1)?.url).toBe("/v1/egress/revocations?since=9");
  });

  it("re-reads the feed from the start when control says its cursor was pruned", async () => {
    const { gw, control, client, target } = await fixture();
    const poller = new RevocationPoller({ control: client, revocations: gw.revocations, tunnels: gw.tunnels });
    const at = new Date().toISOString();

    // The gateway drains normally, then goes away long enough for control to
    // prune everything it had seen.
    control.revocations.push({ id: 4, deviceId: DEVICE_A, credentialId: null, at });
    await poller.pollNow();
    expect(poller.cursor).toBe(4);
    expect(gw.revocations.isDeviceRevoked(DEVICE_A)).toBe(true);

    // Control pruned rows 1..4 and now retains only a later revocation, so a
    // poll at since=4 reports reset: nothing between 4 and 40 is provable.
    control.revocations.length = 0;
    control.revocations.push({ id: 40, deviceId: DEVICE_B, credentialId: null, at });
    const before = control.requests.length;
    await poller.pollNow();

    // It rewound to 0 and picked up the row it would otherwise never have seen.
    const urls = control.requests.slice(before).map((request) => request.url);
    expect(urls[0]).toBe("/v1/egress/revocations?since=4");
    expect(urls[1]).toBe("/v1/egress/revocations?since=0");
    expect(poller.cursor).toBe(40);
    expect(gw.revocations.isDeviceRevoked(DEVICE_B)).toBe(true);
    // Rewinding never un-revokes what the gateway already knew: the pruned
    // row's device stays revoked even though control no longer lists it.
    expect(gw.revocations.isDeviceRevoked(DEVICE_A)).toBe(true);

    // A live tunnel for the newly revoked device is cut on that same poll.
    const survivor = await gw.connectTo(target, basic(credentialFor(USER_B, DEVICE_B)));
    expect((await survivor.readResponse()).status).toBe(407);

    // Steady state: the adopted cursor no longer resets, so it does not loop.
    const settled = control.requests.length;
    await poller.pollNow();
    expect(control.requests.slice(settled).map((request) => request.url)).toEqual([
      "/v1/egress/revocations?since=40",
    ]);
  });

  it("drains every revocation page in one poll instead of one page per tick", async () => {
    const control = await startFakeControl();
    cleanup.push(() => control.close());
    const client = new ControlClient({ baseUrl: control.url, token: control.token });
    const revocations = new RevocationSet();
    const tunnels = new TunnelRegistry();
    const poller = new RevocationPoller({ control: client, revocations, tunnels });

    // A restarted gateway meets a feed far longer than control's page cap.
    const rows = REVOCATION_PAGE_LIMIT * 2 + 500;
    for (let i = 1; i <= rows; i += 1) {
      control.revocations.push({ id: i, deviceId: deviceIdFor(i), credentialId: null, at: "" });
    }

    await poller.pollNow();

    // One poll reaches the newest row: the last revocation is enforced now.
    expect(poller.cursor).toBe(rows);
    expect(revocations.isDeviceRevoked(deviceIdFor(rows))).toBe(true);
    expect(revocations.isDeviceRevoked(deviceIdFor(1))).toBe(true);
    const feedRequests = control.requests.filter((r) => r.url.startsWith("/v1/egress/revocations"));
    expect(feedRequests.map((r) => r.url)).toEqual([
      "/v1/egress/revocations?since=0",
      `/v1/egress/revocations?since=${REVOCATION_PAGE_LIMIT}`,
      `/v1/egress/revocations?since=${REVOCATION_PAGE_LIMIT * 2}`,
      `/v1/egress/revocations?since=${rows}`,
    ]);

    // The tail is quiet again: a further poll makes exactly one request.
    await poller.pollNow();
    expect(control.requests.filter((r) => r.url.startsWith("/v1/egress/revocations"))).toHaveLength(5);
    expect(poller.cursor).toBe(rows);
  });

  it("stops draining when a full page fails to advance the cursor", async () => {
    // A control plane that keeps replaying the same page must not spin forever.
    class StuckControl extends ControlClient {
      calls = 0;
      override get(): Promise<unknown> {
        this.calls += 1;
        return Promise.resolve({
          revocations: [{ id: 5, deviceId: DEVICE_A, credentialId: null, at: "" }],
          cursor: 5,
        });
      }
    }
    const stuck = new StuckControl({ baseUrl: "http://control.invalid", token: "t" });
    const revocations = new RevocationSet();
    const poller = new RevocationPoller({ control: stuck, revocations, tunnels: new TunnelRegistry() });

    await withTimeout(poller.pollNow(), 5000, "stuck revocation feed drain");
    expect(poller.cursor).toBe(5);
    expect(revocations.isDeviceRevoked(DEVICE_A)).toBe(true);
    expect(stuck.calls).toBe(2);
  });

  it("validates the revocation feed shape", () => {
    expect(parseRevocationFeed({ revocations: [], cursor: 3 })).toEqual({
      revocations: [],
      cursor: 3,
      reset: false,
    });
    expect(
      parseRevocationFeed({
        revocations: [{ id: 2, deviceId: DEVICE_A, credentialId: null, at: "t" }],
        cursor: "2",
      }),
    ).toEqual({
      revocations: [{ id: 2, deviceId: DEVICE_A, credentialId: null, at: "t" }],
      cursor: 2,
      reset: false,
    });
    // Only a literal `true` resets; an absent or malformed field must never
    // send the gateway back to the start of the feed.
    expect(parseRevocationFeed({ revocations: [], cursor: 3, reset: true })?.reset).toBe(true);
    for (const shrug of ["true", 1, null, undefined, {}]) {
      expect(parseRevocationFeed({ revocations: [], cursor: 3, reset: shrug })?.reset).toBe(false);
    }
    expect(parseRevocationFeed({ revocations: [{ id: 5, deviceId: DEVICE_A, credentialId: null }] })?.cursor).toBe(5);
    for (const bad of [null, {}, { revocations: [{ id: "1", deviceId: DEVICE_A, credentialId: null }] }, { revocations: [{ id: 1 }] }]) {
      expect(parseRevocationFeed(bad)).toBeNull();
    }
  });

  it("throttles users control flags and clears them again", async () => {
    const control = await startFakeControl();
    cleanup.push(() => control.close());
    const client = new ControlClient({ baseUrl: control.url, token: control.token });
    const echo = await startEcho();
    cleanup.push(() => echo.close());
    const gw = await startGateway({ extraPorts: [echo.port], throttle: null });
    cleanup.push(() => gw.close());
    const limits = new LimitsPoller({ control: client, tunnels: gw.tunnels });
    const target = `127.0.0.1:${echo.port}`;

    // The server consults a throttle source; wire this one in through the harness.
    const throttled = await startGateway({ extraPorts: [echo.port], throttle: limits });
    cleanup.push(() => throttled.close());

    control.throttled.add(USER_A);
    const before = await throttled.connectTo(target, basic(credentialFor(USER_A, DEVICE_A)));
    expect((await before.readHead()).startsWith("HTTP/1.1 200")).toBe(true);
    expect(limits.candidates()).toEqual([USER_A]);

    await limits.pollNow();
    expect(control.requests.some((r) => r.url === `/v1/egress/limits?userId=${USER_A}`)).toBe(true);
    expect(limits.isThrottled(USER_A)).toBe(true);
    const during = await throttled.connectTo(target, basic(credentialFor(USER_A, DEVICE_A)));
    const response = await during.readResponse();
    expect(response.status).toBe(429);
    expect(response.body.trim()).toBe("egress throttled for this user");
    const other = await throttled.connectTo(target, basic(credentialFor(USER_B, DEVICE_B)));
    expect((await other.readHead()).startsWith("HTTP/1.1 200")).toBe(true);

    control.throttled.delete(USER_A);
    await limits.pollNow();
    expect(limits.isThrottled(USER_A)).toBe(false);
    const after = await throttled.connectTo(target, basic(credentialFor(USER_A, DEVICE_A)));
    expect((await after.readHead()).startsWith("HTTP/1.1 200")).toBe(true);

    expect(parseLimits({ throttled: true })).toEqual({ throttled: true });
    expect(parseLimits({ throttled: "yes" })).toBeNull();
    expect(gw.tunnels.size).toBe(0);
  });

  it("polls candidates with bounded concurrency, not one user at a time", async () => {
    // Control has no batch limits route, so a poll is one request per user.
    // Hold every request open to observe how many the poller runs at once.
    const release: Array<() => void> = [];
    let inFlight = 0;
    let peak = 0;
    let served = 0;
    const client = new ControlClient({
      baseUrl: "http://control.invalid",
      token: "t",
      fetch: async (input) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((resolve) => release.push(resolve));
        inFlight -= 1;
        served += 1;
        const userId = new URL(input).searchParams.get("userId") ?? "";
        return new Response(JSON.stringify({ userId, throttled: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const poller = new LimitsPoller({ control: client });
    const users = Array.from({ length: LIMITS_POLL_CONCURRENCY * 3 }, (_, i) => `user-${String(i)}`);
    for (const userId of users) poller.noteUser(userId);

    const done = poller.pollNow();
    // Nothing beyond the cap may be in flight, however long control takes.
    const drainer = setInterval(() => {
      while (release.length > 0) release.shift()?.();
    }, 1);
    await withTimeout(done, 5000, "bounded limits poll");
    clearInterval(drainer);
    expect(served).toBe(users.length);
    expect(peak).toBe(LIMITS_POLL_CONCURRENCY);
  });

  it("flushes numeric-only usage per user to POST /v1/usage/egress with the gateway token", async () => {
    const { gw, control, client, target } = await fixture();
    const flusher = new MetricsFlusher({ metrics: gw.metrics, control: client });

    const payload = Buffer.alloc(1000, 7);
    const closed = once(gw.server, "tunnel:closed") as Promise<[TunnelClosedEvent]>;
    const socket = await gw.connectTo(target, basic(credentialFor(USER_A, DEVICE_A)), payload);
    expect((await socket.readHead()).startsWith("HTTP/1.1 200")).toBe(true);
    expect((await socket.readExact(payload.length)).equals(payload)).toBe(true);
    socket.socket.write("xyz");
    expect((await socket.readExact(3)).toString()).toBe("xyz");
    socket.socket.destroy();
    await withTimeout(closed, 5000, "tunnel:closed");

    const before = Date.now();
    await flusher.flushNow();
    expect(control.usage).toHaveLength(1);
    const report = control.usage[0];
    expect(report?.authorization).toBe(`Bearer ${control.token}`);
    expect(report?.url).toBe("/v1/usage/egress");
    const body = report?.body as UsageReport;
    expect(body.userId).toBe(USER_A);
    expect(body.connections).toBe(1);
    expect(body.bytesToTarget).toBe(1003);
    expect(body.bytesToClient).toBe(1003);
    expect(body.proxiedBytes).toBe(2006);
    expect(body.activeMillis).toBeGreaterThanOrEqual(0);
    expect(body.periodStart).toBeLessThanOrEqual(body.periodEnd);
    expect(body.periodEnd).toBeLessThanOrEqual(before + 1000);
    // Numeric only: the user id is the single string in the report.
    for (const [key, value] of Object.entries(body)) {
      expect(typeof value, key).toBe(key === "userId" ? "string" : "number");
    }
    expect(JSON.stringify(body)).not.toContain("127.0.0.1");

    // Drained: a second flush with nothing new sends nothing.
    await flusher.flushNow();
    expect(control.usage).toHaveLength(1);
    expect(gw.metrics.size).toBe(0);

    // A failed flush merges the totals back for the next window.
    gw.metrics.record(USER_B, { bytesToTarget: 5, bytesToClient: 6, durationMs: 10 });
    control.failWith = 500;
    await flusher.flushNow();
    expect(control.usage).toHaveLength(1);
    expect(gw.metrics.totals(USER_B)).toEqual({ connections: 1, bytesToTarget: 5, bytesToClient: 6, activeMillis: 10 });
    control.failWith = null;
    await flusher.flushNow();
    expect(control.usage).toHaveLength(2);
    expect((control.usage[1]?.body as UsageReport).userId).toBe(USER_B);
    expect((control.usage[1]?.body as UsageReport).proxiedBytes).toBe(11);
  });

  it("accumulates per-user counters", () => {
    const metrics = new EgressMetrics();
    metrics.record("user-a", { bytesToTarget: 100, bytesToClient: 2000, durationMs: 1500 });
    metrics.record("user-a", { bytesToTarget: 50, bytesToClient: 500, durationMs: 500 });
    metrics.record("user-b", { bytesToTarget: 1, bytesToClient: 1, durationMs: 1 });
    expect(metrics.totals("user-a")).toEqual({ connections: 2, bytesToTarget: 150, bytesToClient: 2500, activeMillis: 2000 });
    expect(metrics.totals("user-b")?.connections).toBe(1);
    expect(metrics.totals("nobody")).toBeNull();
    const drained = metrics.drain();
    expect([...drained.keys()]).toEqual(["user-a", "user-b"]);
    expect(metrics.size).toBe(0);
  });
});
