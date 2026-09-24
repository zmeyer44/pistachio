/**
 * Which viewer is driving (docs/web-browser-design.md §11, §13 revision 6).
 *
 * A session can have several viewers at once, and a page's file picker
 * belongs to exactly one of them: the person who just clicked. The host's
 * idea of who that is came only from RPC calls — every RPC, `getSnapshot`
 * included — while raw input, which is what a click over a streamed pane
 * actually is, never touched it. So a second viewer merely READING the
 * snapshot took the picker away from the person who clicked, and the click's
 * own viewer could not answer it.
 *
 * Real Chromium, a real page, two real sockets: the whole point is that the
 * picker is raised by the page, out of band from any call.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { BrowserContext } from "playwright-core";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import type { StreamFileRequest } from "@pistachio/shell-contracts/socket";
import { PlaywrightBrowserBackend } from "../../src/backend/playwright-backend.js";
import { installNetworkGuard } from "../../src/browser/guard.js";
import { SafeBrowserNetworkPolicy } from "../../src/browser/network-policy.js";
import { PlaywrightBrowserRuntime } from "../../src/browser/runtime.js";
import { ControlClient, type SessionTicketRedemption } from "../../src/control-client.js";
import { BrowserSession } from "../../src/sessions/browser-session.js";
import type { ClaimOutcome, SessionClosing } from "../../src/sessions/session-registry.js";
import type { SessionSpace } from "../../src/sessions/shell-host.js";
import { ShellSocketServer, type ShellSession, type ShellSessionRegistry } from "../../src/sessions/shell-server.js";
import { CHROMIUM, describeChromium } from "../helpers/chromium.js";
import { openShellSocket, type ShellSocket } from "../helpers/desktop.js";
import { startFakeControl, type FakeControl } from "../helpers/fake-control.js";
import { must, settle, startFixture, type FixtureServer } from "../helpers/fixture-server.js";
import { testSpaceKeys, USER_A } from "../helpers/keys.js";

const SPACE = "work";

const PAGE_HTML = `<!doctype html><html><head><title>Upload</title></head><body style="margin:0">
<input id="file" type="file" style="position:absolute;left:20px;top:20px;width:200px;height:40px">
</body></html>`;

const runtime = new PlaywrightBrowserRuntime({ executablePath: CHROMIUM ?? undefined, proxyMode: "direct" });
const contexts: BrowserContext[] = [];

const fixture: FixtureServer = await startFixture((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(PAGE_HTML);
});

/** The registry the socket server asks; this worker holds exactly one session. */
class OneSession implements ShellSessionRegistry {
  constructor(private readonly held: BrowserSession) {}

  get(id: string): ShellSession | null {
    return id === this.held.id ? this.held : null;
  }

  async claim(_id: string, _redemption: SessionTicketRedemption): Promise<ClaimOutcome<ShellSession>> {
    return { kind: "session", session: this.held };
  }

  viewerAttached(): void {
    // The idle clock is the registry's business, not this suite's.
  }

  viewerDetached(): void {
    // As above.
  }

  onClosing(_listener: (sessionId: string, reason: SessionClosing) => void): () => void {
    return () => undefined;
  }
}

let fake: FakeControl;
let server: Server;
let shell: ShellSocketServer;
let session: BrowserSession;
let port: number;
let deviceId: string;
let sealKey: CryptoKey;

beforeEach(async () => {
  fake = await startFakeControl();
  const control = new ControlClient({ baseUrl: fake.baseUrl, serviceToken: fake.serviceToken });
  deviceId = fake.addWebDevice(USER_A).id;
  const row = fake.addBrowserSession({ userId: USER_A, spaceId: SPACE });
  const claimed = await control.claimSession(row.id, "worker-a", null);
  if ("refused" in claimed) throw new Error(`the fake refused the claim: ${claimed.refused}`);

  const browser = await runtime.browser();
  const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
  contexts.push(context);
  const policy = new SafeBrowserNetworkPolicy({ allowedOrigins: [fixture.origin] });
  const backend = await PlaywrightBrowserBackend.attach({
    context,
    spaceId: SPACE,
    policy,
    installGuard: (page) => installNetworkGuard(page, { policy, gateway: () => null, credential: () => null }),
    settle: async () => undefined,
  });
  const listeners = new Set<() => void>();
  const space: SessionSpace = {
    ready: Promise.resolve(),
    workspace: null,
    browser: {
      backend,
      onTabsChanged: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
  const keys = await testSpaceKeys(SPACE);
  sealKey = keys.sealKey;
  session = new BrowserSession({
    id: row.id,
    userId: USER_A,
    spaceId: SPACE,
    space,
    keys,
    leaseToken: claimed.leaseToken,
    controlClient: control,
    viewerDeviceId: deviceId,
  });
  shell = new ShellSocketServer({
    control,
    registry: new OneSession(session),
    browserUrl: "https://app.example",
    serviceToken: fake.serviceToken,
    recheckIntervalMs: 30_000,
  });
  server = createServer((request, response) => {
    if (shell.handleRequest(request, response)) return;
    response.statusCode = 404;
    response.end();
  });
  shell.attach(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await shell.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await session.close("shutdown").catch(() => undefined);
  await fake.close();
});

afterAll(async () => {
  for (const context of contexts.splice(0)) await context.close().catch(() => undefined);
  await runtime.close();
  await fixture.close();
});

/** One viewer, attached and past the Space-key proof. */
function attach(sessionId: string): Promise<ShellSocket> {
  const ticket = fake.mintSessionTicket({ userId: USER_A, deviceId, sessionId });
  return openShellSocket(port, sessionId, ticket, sealKey);
}

function fileRequests(socket: ShellSocket): StreamFileRequest[] {
  return socket
    .of("event")
    .filter((frame) => frame["channel"] === "pistachio:file-request")
    .map((frame) => frame["payload"] as StreamFileRequest);
}

describeChromium("a page's file picker with two viewers attached", () => {
  it("goes to the viewer whose input raised it, not the one that last read the snapshot", async () => {
    await session.host.createTab(`${fixture.origin}/page.html`);
    const tabId = must((await session.host.getSnapshot()).tabs[0], "the tab").id;
    const a = await attach(session.id);
    const b = await attach(session.id);

    // B is only LOOKING: a snapshot read is not driving, and it must not take
    // the picker away from whoever clicks next.
    await b.call("getSnapshot");

    // A clicks the file control over its own pane. This is raw input, which
    // is what a click on a streamed page is — no RPC accompanies it. The
    // control is at a fixed place in the fixture, so the coordinates need no
    // round trip of their own.
    const box = { x: 120, y: 40 };
    const generation = session.control.generation;
    for (const type of ["mousePressed", "mouseReleased"] as const) {
      a.input(tabId, generation, {
        kind: "mouse",
        type,
        x: box.x,
        y: box.y,
        button: "left",
        clickCount: 1,
        modifiers: 0,
      });
    }

    await settle(() => fileRequests(a).length + fileRequests(b).length > 0, { turns: 200, stepMs: 25 });
    expect(fileRequests(a)).toHaveLength(1);
    expect(fileRequests(b)).toHaveLength(0);
    expect(fileRequests(a)[0]?.tabId).toBe(tabId);

    a.ws.close();
    b.ws.close();
  }, 60_000);

  it("moves the wheel on accepted input, and not on input the fence refused", async () => {
    await session.host.createTab(`${fixture.origin}/page.html`);
    const tabId = must((await session.host.getSnapshot()).tabs[0], "the tab").id;
    const a = await attach(session.id);
    const b = await attach(session.id);

    // B did something real, so B is driving.
    await b.call("selectTab", [tabId]);
    const driving = session.host.drivingViewerId();
    expect(driving).not.toBeNull();

    // A's input under a fence that has moved on is dropped — and a dropped
    // input is not driving either, so the wheel stays with B.
    a.input(tabId, session.control.generation + 5, {
      kind: "mouse",
      type: "mousePressed",
      x: 120,
      y: 40,
      button: "left",
      clickCount: 1,
      modifiers: 0,
    });
    await settle(() => session.droppedInput > 0, { turns: 200, stepMs: 25 });
    expect(session.host.drivingViewerId()).toBe(driving);

    // A's input under the current fence IS driving.
    a.input(tabId, session.control.generation, {
      kind: "mouse",
      type: "mouseMoved",
      x: 120,
      y: 40,
      button: "none",
      clickCount: 0,
      modifiers: 0,
    });
    await settle(() => session.host.drivingViewerId() !== driving, { turns: 200, stepMs: 25 });
    expect(session.host.drivingViewerId()).not.toBe(driving);

    a.ws.close();
    b.ws.close();
  }, 60_000);
});
