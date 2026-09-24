import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { ControlClient } from "../src/control-client.js";
import { CLOSE_UNPROVEN, LiveViewServer, type LiveRun } from "../src/live/server.js";
import { startFakeControl, type FakeControl } from "./helpers/fake-control.js";
import { settle } from "./helpers/fixture-server.js";
import { USER_A, USER_B } from "./helpers/keys.js";

const RUN_ID = "44444444-4444-4444-8444-444444444444";
/**
 * The two web apps (docs/web-browser-design.md §15). A live view is watched
 * from the run page on `www` and, in time, from the browser app, so the pin
 * is a list; a third origin is still a stranger.
 */
const WWW_URL = "https://www.example";
const BROWSER_URL = "https://app.example";
const OTHER_RUN = "55555555-5555-4555-8555-555555555555";

let fake: FakeControl;
let server: Server;
let live: LiveViewServer;
let baseUrl: string;
let run: LiveRun & { status: LiveRun["status"]; control: LiveRun["control"]; ended: boolean };

function open(
  token: string | null,
  via: "header" | "query" = "header",
  runId = RUN_ID,
  /** What a browser would put on the upgrade; a native client sends none. */
  origin?: string,
): Promise<{ ws: WebSocket; status: number | null; frames: unknown[] }> {
  const url = `${baseUrl}/v1/live/${runId}${via === "query" && token !== null ? `?access_token=${encodeURIComponent(token)}` : ""}`;
  const headers: Record<string, string> = {
    ...(via === "header" && token !== null ? { authorization: `Bearer ${token}` } : {}),
    ...(origin === undefined ? {} : { origin }),
  };
  const ws = new WebSocket(url, Object.keys(headers).length === 0 ? {} : { headers });
  // Listen before the handshake resolves: the first frames ride right behind it.
  const frames: unknown[] = [];
  ws.on("message", (data) => frames.push(JSON.parse(data.toString())));
  return new Promise((resolve) => {
    ws.once("open", () => resolve({ ws, status: null, frames }));
    ws.once("unexpected-response", (_request, response) => {
      resolve({ ws, status: response.statusCode ?? 0, frames });
      response.resume();
    });
    ws.once("error", () => undefined);
  });
}

function closed(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once("close", (code) => resolve(code)));
}

/**
 * The challenge is the first frame on every accepted socket (§8.5); answer it
 * so the test can get at what follows.
 */
async function prove(opened: { ws: WebSocket; frames: unknown[] }, seal = (nonce: string) => `sealed:${nonce}`): Promise<void> {
  await settle(() => opened.frames.length >= 1);
  const challenge = opened.frames.shift() as { t: string; nonce: string };
  expect(challenge.t).toBe("challenge");
  opened.ws.send(JSON.stringify({ t: "auth", proof: seal(challenge.nonce) }));
}

beforeEach(async () => {
  fake = await startFakeControl();
  run = {
    userId: USER_A,
    spaceId: "work",
    status: "running",
    control: "agent",
    ended: false,
    // The fixture's Space key is the literal string below; a real one is AES.
    verifySpaceProof: async (nonce, proof) => proof === `sealed:${nonce}`,
    tabs: () => [],
    activeTabId: () => null,
    guardSessionFor: () => null,
    focusTab: async () => undefined,
    subscribe: () => () => undefined,
  };
  const control = new ControlClient({ baseUrl: fake.baseUrl, serviceToken: fake.serviceToken });
  live = new LiveViewServer({
    control,
    runs: { get: (runId) => (runId === RUN_ID ? run : null) },
    recheckIntervalMs: 40,
    viewerOrigins: [WWW_URL, BROWSER_URL],
  });
  server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  live.attach(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `ws://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterEach(async () => {
  await live.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fake.close();
});

describe("upgrade robustness", () => {
  it("answers a malformed request-target with 400 instead of dying on an unhandled rejection", async () => {
    const url = new URL(baseUrl.replace("ws://", "http://"));
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({
        host: url.hostname,
        port: url.port,
        path: "/v1/live/%E0%A4%A",
        headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" },
      });
      req.once("response", (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.once("upgrade", () => reject(new Error("upgrade unexpectedly succeeded")));
      req.once("error", reject);
      req.end();
    });
    expect(status).toBe(400);
    // Still serving afterwards.
    const opened = await open("nope");
    expect(opened.status).toBe(401);
  });
});

describe("live view upgrade auth", () => {
  it("rejects missing, bootstrap, cloud, foreign, and unknown-run tokens before the handshake", async () => {
    const desktop = await fake.addDesktop(USER_A);
    const cloud = fake.addCloudDevice(USER_A, { devicePublicKey: "AA==", agreementPublicKey: "AA==" });
    const other = await fake.addDesktop(USER_B);
    const cloudTicket = fake.mintLiveTicket({ userId: USER_A, deviceId: cloud.id, platform: "cloud", runId: RUN_ID });
    const otherTicket = fake.mintLiveTicket({ userId: USER_B, deviceId: other.id, platform: "macos", runId: RUN_ID });
    const desktopTicket = fake.mintLiveTicket({ userId: USER_A, deviceId: desktop.id, platform: "macos", runId: RUN_ID });
    const wrongRun = fake.mintLiveTicket({ userId: USER_A, deviceId: desktop.id, platform: "macos", runId: OTHER_RUN });

    expect((await open(null)).status).toBe(401);
    expect((await open("plt_unknown")).status).toBe(401);
    expect((await open(cloudTicket)).status).toBe(403);
    expect((await open(otherTicket)).status).toBe(404);
    // A ticket is bound to ONE run: it does not open another of the user's.
    expect((await open(wrongRun, "header", RUN_ID)).status).toBe(401);
    expect(live.connections).toBe(0);

    const accepted = await open(desktopTicket);
    expect(accepted.status).toBeNull();
    const frames = accepted.frames;
    await prove(accepted);
    await settle(() => frames.length >= 2);
    expect(frames).toEqual([
      { t: "status", status: "running", control: "agent" },
      { t: "tabs", tabs: [], activeTabId: null },
    ]);
    expect(live.connections).toBe(1);
    accepted.ws.close();
    await closed(accepted.ws);

    // And it is spent: the same ticket does not open a second socket.
    expect((await open(desktopTicket)).status).toBe(401);
    const viaQuery = await open(
      fake.mintLiveTicket({ userId: USER_A, deviceId: desktop.id, platform: "macos", runId: RUN_ID }),
      "query",
    );
    expect(viaQuery.status).toBeNull();
    viaQuery.ws.close();
    await closed(viaQuery.ws);
  });

  it("lets either web app watch, and no third origin", async () => {
    const web = fake.addWebDevice(USER_A);
    const desktop = await fake.addDesktop(USER_A);
    const ticketFor = (device: { id: string }, platform: "macos" | "web") =>
      fake.mintLiveTicket({ userId: USER_A, deviceId: device.id, platform, runId: RUN_ID });

    // A browser puts Origin on every upgrade. Both of ours are allowed — the
    // run page lives on www, and the browser app is a second site (§15) —
    // and any other page holding a valid ticket is not, whatever device it
    // names.
    for (const origin of [WWW_URL, BROWSER_URL]) {
      const accepted = await open(ticketFor(web, "web"), "query", RUN_ID, origin);
      expect(accepted.status, origin).toBeNull();
      await prove(accepted);
      await settle(() => accepted.frames.length >= 2);
      expect(accepted.frames[0]).toEqual({ t: "status", status: "running", control: "agent" });
      accepted.ws.close();
      await closed(accepted.ws);
    }

    expect((await open(ticketFor(web, "web"), "query", RUN_ID, "https://evil.example")).status).toBe(403);
    // The origin is checked before the token means anything: a desktop token
    // from a hostile page is still a hostile page.
    expect((await open(ticketFor(desktop, "macos"), "header", RUN_ID, "https://evil.example")).status).toBe(403);
    // And a native client, which sends no Origin at all, is unaffected.
    expect((await open(ticketFor(desktop, "macos"))).status).toBeNull();
    expect(live.connections).toBe(1);
  });

  it("sends nothing until the viewer proves it holds the Space key", async () => {
    const desktop = await fake.addDesktop(USER_A);
    const ticket = () => fake.mintLiveTicket({ userId: USER_A, deviceId: desktop.id, platform: "macos", runId: RUN_ID });

    // A device token opens the socket. It does not open the picture.
    const wrong = await open(ticket());
    expect(wrong.status).toBeNull();
    await settle(() => wrong.frames.length >= 1);
    expect(wrong.frames).toEqual([{ t: "challenge", spaceId: "work", nonce: expect.any(String) }]);
    const nonce = (wrong.frames[0] as { nonce: string }).nonce;
    wrong.ws.send(JSON.stringify({ t: "auth", proof: "not-the-key" }));
    expect(await closed(wrong.ws)).toBe(CLOSE_UNPROVEN);
    expect(wrong.frames.at(-1)).toMatchObject({ t: "error", code: "space_key_required" });
    expect(live.connections).toBe(0);

    // The right answer, and only then, starts the stream.
    const right = await open(ticket());
    await prove(right);
    await settle(() => right.frames.length >= 2);
    expect(right.frames[0]).toEqual({ t: "status", status: "running", control: "agent" });
    // The nonce is per socket, so a proof cannot be lifted from one to another.
    expect(nonce).not.toBe("");
    right.ws.close();
    await closed(right.ws);
  });

  it("hands a run it does not hold to the worker that does", async () => {
    // Two workers, one shared public address: whichever the load balancer
    // picks relays to the one whose memory the run lives in (§8.5).
    const holder = new LiveViewServer({
      control: new ControlClient({ baseUrl: fake.baseUrl, serviceToken: fake.serviceToken }),
      runs: { get: (runId) => (runId === RUN_ID ? run : null) },
      serviceToken: fake.serviceToken,
      viewerOrigins: [WWW_URL, BROWSER_URL],
    });
    const holderServer = createServer((_request, response) => {
      response.statusCode = 404;
      response.end();
    });
    holder.attach(holderServer);
    await new Promise<void>((resolve) => holderServer.listen(0, "127.0.0.1", resolve));
    const holderUrl = `http://127.0.0.1:${String((holderServer.address() as AddressInfo).port)}`;

    // The gateway holds no runs of its own.
    await live.close();
    live = new LiveViewServer({
      control: new ControlClient({ baseUrl: fake.baseUrl, serviceToken: fake.serviceToken }),
      runs: { get: () => null },
      serviceToken: fake.serviceToken,
      viewerOrigins: [WWW_URL, BROWSER_URL],
    });
    live.attach(server);

    const desktop = await fake.addDesktop(USER_A);
    const ticket = fake.mintLiveTicket({
      userId: USER_A,
      deviceId: desktop.id,
      platform: "macos",
      runId: RUN_ID,
      workerUrl: holderUrl,
    });
    const viewer = await open(ticket);
    expect(viewer.status).toBeNull();
    // The challenge comes from the HOLDER, through the gateway untouched: the
    // hop can neither answer it nor read what it protects.
    await prove(viewer);
    await settle(() => viewer.frames.length >= 2);
    expect(viewer.frames[0]).toEqual({ t: "status", status: "running", control: "agent" });
    expect(holder.connections).toBe(1);
    expect(live.connections).toBe(0);

    viewer.ws.close();
    await closed(viewer.ws);
    await settle(() => holder.connections === 0);
    await holder.close();
    holderServer.closeAllConnections();
    await new Promise<void>((resolve) => holderServer.close(() => resolve()));
  });

  it("pings idle sockets so a proxy between does not cull them", async () => {
    // A screencast is silent while the page is, and every load balancer
    // drops a connection that says nothing (§8.5). The server's own pings
    // are what keep it open; browsers answer them without the page knowing.
    await live.close();
    const control = new ControlClient({ baseUrl: fake.baseUrl, serviceToken: fake.serviceToken });
    live = new LiveViewServer({
      control,
      runs: { get: (runId) => (runId === RUN_ID ? run : null) },
      recheckIntervalMs: 10_000,
      pingIntervalMs: 30,
      viewerOrigins: [WWW_URL, BROWSER_URL],
    });
    live.attach(server);

    const desktop = await fake.addDesktop(USER_A);
    const token = fake.mintLiveTicket({ userId: USER_A, deviceId: desktop.id, platform: "macos", runId: RUN_ID });
    const accepted = await open(token);
    expect(accepted.status).toBeNull();
    const pings: number[] = [];
    accepted.ws.on("ping", () => pings.push(Date.now()));
    await settle(() => pings.length >= 2);
    expect(pings.length).toBeGreaterThanOrEqual(2);
    // Answering them (which `ws` does for us) keeps the socket up.
    expect(accepted.ws.readyState).toBe(WebSocket.OPEN);
    expect(live.connections).toBe(1);
    accepted.ws.close();
    await closed(accepted.ws);
  });

  it("closes 4003 within one re-check after the desktop is revoked, and at once on steer", async () => {
    const desktop = await fake.addDesktop(USER_A);
    const desktopToken = fake.mintLiveTicket({ userId: USER_A, deviceId: desktop.id, platform: "macos", runId: RUN_ID });
    const first = await open(desktopToken);
    expect(first.status).toBeNull();
    const firstClosed = closed(first.ws);
    fake.revokeDevice(desktop.id);
    expect(await firstClosed).toBe(4003);

    const other = await fake.addDesktop(USER_A, "Second desktop");
    const otherToken = fake.mintLiveTicket({ userId: USER_A, deviceId: other.id, platform: "macos", runId: RUN_ID });
    const second = await open(otherToken);
    expect(second.status).toBeNull();
    const secondClosed = closed(second.ws);
    live.closeUser(USER_A);
    expect(await secondClosed).toBe(4003);
    expect(live.connections).toBe(0);
  });

  it("drops input while the agent holds control and reports an ended run", async () => {
    const desktop = await fake.addDesktop(USER_A);
    const desktopToken = fake.mintLiveTicket({ userId: USER_A, deviceId: desktop.id, platform: "macos", runId: RUN_ID });
    let focused: string | null = null;
    run.focusTab = async (tabId) => {
      focused = tabId;
    };
    const socket = await open(desktopToken);
    expect(socket.status).toBeNull();
    await prove(socket);
    socket.ws.send(JSON.stringify({ t: "focus", tabId: "cloud:1" }));
    socket.ws.send(JSON.stringify({ t: "input", event: { kind: "key", type: "keyDown", key: "a", code: "KeyA", modifiers: 0 } }));
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(focused).toBeNull();
    run.control = "human";
    socket.ws.send(JSON.stringify({ t: "focus", tabId: "cloud:1" }));
    await settle(() => focused === "cloud:1");
    run.ended = true;
    const done = closed(socket.ws);
    live.closeRun(RUN_ID);
    expect(await done).toBe(1000);
    expect(socket.frames.at(-1)).toEqual({ t: "error", code: "ended", message: "the run has ended" });
  });
});
