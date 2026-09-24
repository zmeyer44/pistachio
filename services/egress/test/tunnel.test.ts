/**
 * Loopback integration tests: a real gateway on an ephemeral port, a real
 * echo server behind it. The splice test is the executable form of the
 * "blind by construction" claim — bytes (including non-UTF-8 binary) cross
 * the tunnel unmodified in both directions.
 */

import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";

import { PROXY_AUTH_REALM } from "../src/config.js";
import { tcpDial, type LookupFn } from "../src/policy.js";
import type { TunnelClosedEvent } from "../src/server.js";
import {
  DEVICE_A,
  DEVICE_B,
  OTHER_SECRET_HEX,
  USER_A,
  USER_B,
  basic,
  bearer,
  closedPort,
  credentialFor,
  sleep,
  startEcho,
  startGateway,
  withTimeout,
  type EchoServer,
  type GatewayHarness,
} from "./helpers.js";

/** Millisecond deadlines so the timeout tests finish in milliseconds. */
const FAST_TIMEOUTS = { headReadMs: 150, idleMs: 150, connectionsCheckingIntervalMs: 50 } as const;

const PAYLOAD = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

describe("egress tunnel", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanup.length > 0) await cleanup.pop()?.();
  });

  async function echoAndGateway(
    options: Parameters<typeof startGateway>[0] = {},
    echoOptions: Parameters<typeof startEcho>[0] = {},
  ): Promise<{ echo: EchoServer; gw: GatewayHarness; target: string }> {
    const echo = await startEcho(echoOptions);
    cleanup.push(() => echo.close());
    const gw = await startGateway({ extraPorts: [echo.port], ...options });
    cleanup.push(() => gw.close());
    return { echo, gw, target: `127.0.0.1:${echo.port}` };
  }

  it("is a blind splice with Basic credentials", async () => {
    const { gw, target } = await echoAndGateway();
    const client = await gw.connectTo(target, basic(credentialFor()));
    const head = await client.readHead();
    expect(head.startsWith("HTTP/1.1 200")).toBe(true);
    for (let round = 0; round < 3; round += 1) {
      client.socket.write(PAYLOAD);
      const echoed = await client.readExact(PAYLOAD.length);
      expect(echoed.equals(PAYLOAD)).toBe(true);
    }
    expect(gw.tunnels.size).toBe(1);
    expect(gw.tunnels.countForDevice(DEVICE_A)).toBe(1);
    expect(gw.tunnels.countForUser(USER_A)).toBe(1);
  });

  it("accepts the same credential as a Bearer split at the last dot", async () => {
    const { gw, target } = await echoAndGateway();
    const client = await gw.connectTo(target, bearer(credentialFor()));
    expect((await client.readHead()).startsWith("HTTP/1.1 200")).toBe(true);
    client.socket.write("ping");
    expect((await client.readExact(4)).toString()).toBe("ping");
  });

  it("forwards bytes pipelined behind the CONNECT head", async () => {
    const { gw, target } = await echoAndGateway();
    const client = await gw.connectTo(target, basic(credentialFor()), PAYLOAD);
    expect((await client.readHead()).startsWith("HTTP/1.1 200")).toBe(true);
    expect((await client.readExact(PAYLOAD.length)).equals(PAYLOAD)).toBe(true);
  });

  it("answers 405 to anything that is not CONNECT", async () => {
    const { gw } = await echoAndGateway();
    for (const request of [
      "GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n",
      "POST /healthz HTTP/1.1\r\nHost: gw\r\nContent-Length: 0\r\n\r\n",
      "GET / HTTP/1.1\r\nHost: gw\r\n\r\n",
    ]) {
      const client = await gw.connect();
      client.socket.write(request);
      const response = await client.readResponse();
      expect(response.status, request).toBe(405);
      expect(response.body.trim()).toBe("CONNECT only");
      expect(response.headers["connection"]).toBe("close");
      client.socket.destroy();
    }
  });

  it("serves GET /healthz", async () => {
    const { gw } = await echoAndGateway();
    const client = await gw.connect();
    client.socket.write("GET /healthz HTTP/1.1\r\nHost: gw\r\n\r\n");
    const response = await client.readResponse();
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(response.body)).toEqual({ ok: true });
    client.socket.destroy();
  });

  it("challenges a missing or unverifiable credential with 407 Basic", async () => {
    const { gw, target } = await echoAndGateway();
    const good = credentialFor();
    const cases: Array<[string, string | null]> = [
      ["missing", null],
      ["garbage", "Basic !!!"],
      ["wrong prefix", basic({ ...good, username: good.username.replace("pe1", "pe0") })],
      ["four fields", `Bearer pe1.${USER_A}.${DEVICE_A}.${good.expiresAt}.${good.password}`],
      ["tampered mac", basic({ ...good, password: `${good.password.slice(0, -1)}${good.password.at(-1) === "A" ? "B" : "A"}` })],
      ["foreign secret", basic(credentialFor(USER_A, DEVICE_A, { secretHex: OTHER_SECRET_HEX }))],
      ["swapped user", basic({ ...good, username: good.username.replace(USER_A, USER_B) })],
      ["digest scheme", `Digest ${good.username}`],
    ];
    for (const [label, auth] of cases) {
      const client = await gw.connectTo(target, auth);
      const response = await client.readResponse();
      expect(response.status, label).toBe(407);
      expect(response.headers["proxy-authenticate"], label).toBe(`Basic realm="${PROXY_AUTH_REALM}"`);
      expect(response.headers["connection"], label).toBe("close");
      expect(response.body.trim()).toBe("proxy authentication required");
      await withTimeout(client.readToEnd(), 2000, `${label}: EOF after 407`);
    }
    expect(gw.tunnels.size).toBe(0);
  });

  it("rejects an expired credential with 407 and accepts one that is still valid", async () => {
    const { gw, target } = await echoAndGateway();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expired = await gw.connectTo(target, basic(credentialFor(USER_A, DEVICE_A, { expiresAtSeconds: nowSeconds - 1 })));
    expect((await expired.readResponse()).status).toBe(407);
    const boundary = await gw.connectTo(target, basic(credentialFor(USER_A, DEVICE_A, { expiresAtSeconds: nowSeconds - 5 })));
    expect((await boundary.readResponse()).status).toBe(407);
    const fresh = await gw.connectTo(target, basic(credentialFor(USER_A, DEVICE_A, { expiresAtSeconds: nowSeconds + 3600 })));
    expect((await fresh.readHead()).startsWith("HTTP/1.1 200")).toBe(true);
  });

  it("refuses a revoked device but not the user's other devices", async () => {
    const { gw, target } = await echoAndGateway();
    gw.revocations.revokeDevice(DEVICE_A);
    const revoked = await gw.connectTo(target, basic(credentialFor(USER_A, DEVICE_A)));
    expect((await revoked.readResponse()).status).toBe(407);
    const other = await gw.connectTo(target, basic(credentialFor(USER_A, DEVICE_B)));
    expect((await other.readHead()).startsWith("HTTP/1.1 200")).toBe(true);
  });

  it("refuses a revoked credential but not the device's other credentials", async () => {
    const { gw, target } = await echoAndGateway();
    const cut = credentialFor();
    const kept = credentialFor();
    gw.revocations.revokeCredential(cut.credentialId);
    const revoked = await gw.connectTo(target, bearer(cut));
    expect((await revoked.readResponse()).status).toBe(407);
    const other = await gw.connectTo(target, bearer(kept));
    expect((await other.readHead()).startsWith("HTTP/1.1 200")).toBe(true);
  });

  it("answers 403 to another user's credential on an owner-pinned gateway", async () => {
    const { gw, target } = await echoAndGateway({ ownerUserId: USER_A });
    const foreign = await gw.connectTo(target, basic(credentialFor(USER_B, DEVICE_B)));
    const response = await foreign.readResponse();
    expect(response.status).toBe(403);
    expect(response.headers["proxy-authenticate"]).toBeUndefined();
    expect(response.body.trim()).toBe("credential is not valid for this gateway");
    const owner = await gw.connectTo(target, basic(credentialFor(USER_A, DEVICE_A)));
    expect((await owner.readHead()).startsWith("HTTP/1.1 200")).toBe(true);
  });

  it("refuses private targets and disallowed ports with harbor's 403 bodies under strict policy", async () => {
    const echo = await startEcho();
    cleanup.push(() => echo.close());
    const gw = await startGateway({ strict: true, extraPorts: [echo.port] });
    cleanup.push(() => gw.close());
    const auth = basic(credentialFor());
    const cases: Array<[string, string]> = [
      [`127.0.0.1:${echo.port}`, "private or local targets are never tunnelled"],
      ["127.0.0.1:443", "private or local targets are never tunnelled"],
      ["[::1]:443", "private or local targets are never tunnelled"],
      ["localhost:443", "private or local targets are never tunnelled"],
      ["10.0.0.1:443", "private or local targets are never tunnelled"],
      ["build-server:443", "private or local targets are never tunnelled"],
      ["example.com:25", "port 25 is never tunnelled"],
      ["example.com:4444", "port 4444 is not allowed"],
    ];
    for (const [target, body] of cases) {
      const client = await gw.connectTo(target, auth);
      const response = await client.readResponse();
      expect(response.status, target).toBe(403);
      expect(response.body.trim(), target).toBe(body);
    }
    expect(gw.tunnels.size).toBe(0);
  });

  it("keeps port 25 shut even under the permissive local policy", async () => {
    const { gw } = await echoAndGateway({ extraPorts: [25] });
    const client = await gw.connectTo("127.0.0.1:25", basic(credentialFor()));
    const response = await client.readResponse();
    expect(response.status).toBe(403);
    expect(response.body.trim()).toBe("port 25 is never tunnelled");
  });

  it("re-checks resolved addresses so a public name cannot rebind into private space", async () => {
    const lookup: LookupFn = async (host) =>
      host === "rebind.example.com" ? [{ address: "127.0.0.1", family: 4 }] : [];
    const gw = await startGateway({ strict: true, lookup });
    cleanup.push(() => gw.close());
    const rebinding = await gw.connectTo("rebind.example.com:443", basic(credentialFor()));
    const response = await rebinding.readResponse();
    expect(response.status).toBe(403);
    expect(response.body.trim()).toBe("target did not resolve to a permitted address");
    const unresolved = await gw.connectTo("missing.example.com:443", basic(credentialFor()));
    expect((await unresolved.readResponse()).body.trim()).toBe("target did not resolve to a permitted address");
  });

  it("answers 502 when no vetted address accepts the connection", async () => {
    const port = await closedPort();
    const gw = await startGateway({ extraPorts: [port] });
    cleanup.push(() => gw.close());
    const client = await gw.connectTo(`127.0.0.1:${port}`, basic(credentialFor()));
    const response = await client.readResponse();
    expect(response.status).toBe(502);
    expect(response.body.trim()).toBe("could not reach target");

    const attempted: string[] = [];
    const stubbed = await startGateway({
      strict: true,
      lookup: async () => [
        { address: "93.184.216.1", family: 4 },
        { address: "93.184.216.2", family: 4 },
      ],
      dial: async (address) => {
        attempted.push(address);
        return null;
      },
    });
    cleanup.push(() => stubbed.close());
    const dead = await stubbed.connectTo("dead.example.com:443", basic(credentialFor()));
    expect((await dead.readResponse()).status).toBe(502);
    expect(attempted).toEqual(["93.184.216.1", "93.184.216.2"]);
    expect(stubbed.tunnels.size).toBe(0);
  });

  it("falls through to the next address when the first dial outlives the head-read deadline", async () => {
    // A blackholed AAAA record: the first dial hangs well past headReadMs.
    // The head is already in hand, so that deadline must not answer 408 while
    // the A record is still untried.
    const echo = await startEcho();
    cleanup.push(() => echo.close());
    const attempted: string[] = [];
    const gw = await startGateway({
      timeouts: { ...FAST_TIMEOUTS, dialMs: 5_000 },
      lookup: () =>
        Promise.resolve([
          { address: "2001:db8::1", family: 6 },
          { address: "93.184.216.7", family: 4 },
        ]),
      dial: async (address) => {
        attempted.push(address);
        if (address.includes(":")) {
          await sleep(FAST_TIMEOUTS.headReadMs * 3);
          return null;
        }
        return tcpDial("127.0.0.1", echo.port, 1000);
      },
    });
    cleanup.push(() => gw.close());

    const client = await gw.connectTo("dual.example.com:443", basic(credentialFor()));
    const head = await withTimeout(client.readHead(), 5000, "200 after the v6 blackhole");
    expect(head.startsWith("HTTP/1.1 200")).toBe(true);
    expect(attempted).toEqual(["2001:db8::1", "93.184.216.7"]);
    client.socket.write("hi");
    expect((await client.readExact(2)).toString("utf8")).toBe("hi");
  });

  it("answers 400 to a malformed CONNECT target", async () => {
    const { gw } = await echoAndGateway();
    for (const target of ["example.com", "example.com:0"]) {
      const client = await gw.connectTo(target, basic(credentialFor()));
      const response = await client.readResponse();
      expect(response.status, target).toBe(400);
    }
  });

  it("caps the request head", async () => {
    const { gw, target } = await echoAndGateway();
    const client = await gw.connect();
    client.socket.write(`CONNECT ${target} HTTP/1.1\r\nX-Pad: ${"a".repeat(9000)}\r\n\r\n`);
    const head = await client.readHead();
    expect(head.startsWith("HTTP/1.1 431")).toBe(true);
  });

  it("times out a stalled request head with 408 (slowloris)", async () => {
    const { gw } = await echoAndGateway({ timeouts: FAST_TIMEOUTS });
    const dribbling = await gw.connect();
    dribbling.socket.write("CONNECT exa");
    const head = await withTimeout(dribbling.readHead(), 5000, "408 for a partial head");
    expect(head.startsWith("HTTP/1.1 408")).toBe(true);

    const silent = await gw.connect();
    const silentHead = await withTimeout(silent.readHead(), 5000, "408 for a silent socket");
    expect(silentHead.startsWith("HTTP/1.1 408")).toBe(true);
    await withTimeout(silent.readToEnd(), 2000, "EOF after 408");
  });

  it("closes an idle tunnel but keeps a chatty one alive", async () => {
    const { gw, target } = await echoAndGateway({ timeouts: FAST_TIMEOUTS });
    const client = await gw.connectTo(target, basic(credentialFor()));
    expect((await client.readHead()).startsWith("HTTP/1.1 200")).toBe(true);
    // Traffic keeps it alive across more than one idle window...
    for (let tick = 0; tick < 3; tick += 1) {
      await sleep(60);
      client.socket.write("tick");
      expect((await client.readExact(4)).toString()).toBe("tick");
    }
    // ...and silence ends it: both sockets are dropped, so the client's next
    // read is a clean EOF rather than a hang.
    const closed = once(gw.server, "tunnel:closed") as Promise<[TunnelClosedEvent]>;
    const rest = await withTimeout(client.readToEnd(), 5000, "idle tunnel must be closed, not left hanging");
    expect(rest.length).toBe(0);
    const [event] = await withTimeout(closed, 5000, "tunnel:closed after idle");
    expect(event.sample.bytesToTarget).toBe(12);
    expect(event.sample.bytesToClient).toBe(12);
    expect(gw.tunnels.size).toBe(0);
  });

  it("forwards half-close in both directions", async () => {
    const { gw, target } = await echoAndGateway({}, { farewell: true });
    const client = await gw.connectTo(target, basic(credentialFor()));
    expect((await client.readHead()).startsWith("HTTP/1.1 200")).toBe(true);
    client.socket.write("hello");
    expect((await client.readExact(5)).toString()).toBe("hello");
    const closed = once(gw.server, "tunnel:closed") as Promise<[TunnelClosedEvent]>;
    // Client FIN → gateway ends its write half to the echo server, which
    // answers "bye" and closes: the reply must still flow back.
    client.socket.end();
    const tail = await withTimeout(client.readToEnd(), 5000, "bye after half-close");
    expect(tail.toString()).toBe("bye");
    const [event] = await withTimeout(closed, 5000, "tunnel:closed after half-close");
    expect(event.identity).toEqual({ userId: USER_A, deviceId: DEVICE_A, credentialId: event.identity.credentialId });
    expect(event.sample.bytesToTarget).toBe(5);
    expect(event.sample.bytesToClient).toBe(8);
  });

  it("meters bytes in both directions per user, numeric only", async () => {
    const { gw, target } = await echoAndGateway();
    const credential = credentialFor();
    const closed = once(gw.server, "tunnel:closed") as Promise<[TunnelClosedEvent]>;
    const client = await gw.connectTo(target, basic(credential), PAYLOAD);
    expect((await client.readHead()).startsWith("HTTP/1.1 200")).toBe(true);
    expect((await client.readExact(PAYLOAD.length)).equals(PAYLOAD)).toBe(true);
    client.socket.write("abc");
    expect((await client.readExact(3)).toString()).toBe("abc");
    client.socket.destroy();
    await withTimeout(closed, 5000, "tunnel:closed");
    const totals = gw.metrics.totals(USER_A);
    expect(totals).not.toBeNull();
    expect(totals?.connections).toBe(1);
    expect(totals?.bytesToTarget).toBe(PAYLOAD.length + 3);
    expect(totals?.bytesToClient).toBe(PAYLOAD.length + 3);
    expect(totals?.activeMillis).toBeGreaterThanOrEqual(0);
    expect(Object.values(totals ?? {}).every((v) => typeof v === "number")).toBe(true);
    expect(gw.metrics.totals(USER_B)).toBeNull();
    expect(gw.tunnels.countForDevice(DEVICE_A)).toBe(0);
  });

  it("caps concurrent tunnels per device and per user with 429", async () => {
    const { gw, target } = await echoAndGateway({ limits: { maxTunnelsPerDevice: 2, maxTunnelsPerUser: 3 } });
    const open = async (deviceId: string): Promise<ReturnType<GatewayHarness["connectTo"]>> => {
      const client = await gw.connectTo(target, basic(credentialFor(USER_A, deviceId)));
      expect((await client.readHead()).startsWith("HTTP/1.1 200")).toBe(true);
      return client;
    };
    const first = await open(DEVICE_A);
    await open(DEVICE_A);
    const third = await gw.connectTo(target, basic(credentialFor(USER_A, DEVICE_A)));
    const perDevice = await third.readResponse();
    expect(perDevice.status).toBe(429);
    expect(perDevice.body.trim()).toBe("too many tunnels for this device");

    await open(DEVICE_B);
    const fourth = await gw.connectTo(target, basic(credentialFor(USER_A, DEVICE_B)));
    const perUser = await fourth.readResponse();
    expect(perUser.status).toBe(429);
    expect(perUser.body.trim()).toBe("too many tunnels for this user");

    // Releasing a slot lets the next tunnel through.
    const closed = once(gw.server, "tunnel:closed");
    first.socket.destroy();
    await withTimeout(closed, 5000, "slot released");
    await open(DEVICE_A);
  });

  it("answers 429 for a throttled user", async () => {
    const noted: string[] = [];
    const { gw, target } = await echoAndGateway({
      throttle: { isThrottled: (userId) => userId === USER_A, noteUser: (userId) => noted.push(userId) },
    });
    const throttled = await gw.connectTo(target, basic(credentialFor(USER_A, DEVICE_A)));
    const response = await throttled.readResponse();
    expect(response.status).toBe(429);
    expect(response.body.trim()).toBe("egress throttled for this user");
    const other = await gw.connectTo(target, basic(credentialFor(USER_B, DEVICE_B)));
    expect((await other.readHead()).startsWith("HTTP/1.1 200")).toBe(true);
    expect(noted).toEqual([USER_A, USER_B]);
  });

  it("destroys live tunnels by device and by credential", async () => {
    const { gw, target } = await echoAndGateway();
    const cut = credentialFor(USER_A, DEVICE_A);
    const kept = credentialFor(USER_A, DEVICE_A);
    const a = await gw.connectTo(target, basic(cut));
    const b = await gw.connectTo(target, basic(kept));
    const c = await gw.connectTo(target, basic(credentialFor(USER_A, DEVICE_B)));
    for (const client of [a, b, c]) expect((await client.readHead()).startsWith("HTTP/1.1 200")).toBe(true);
    expect(gw.tunnels.countForCredential(cut.credentialId)).toBe(1);

    expect(gw.tunnels.destroyByCredential(cut.credentialId)).toBe(1);
    await withTimeout(a.readToEnd(), 5000, "credential tunnel cut");
    b.socket.write("still");
    expect((await b.readExact(5)).toString()).toBe("still");

    expect(gw.tunnels.destroyByDevice(DEVICE_A)).toBe(1);
    await withTimeout(b.readToEnd(), 5000, "device tunnel cut");
    c.socket.write("other");
    expect((await c.readExact(5)).toString()).toBe("other");
  });
});
