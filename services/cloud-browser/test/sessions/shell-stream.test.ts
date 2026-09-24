/**
 * The pane and the keyboard, end to end over the socket into a real Chromium
 * page (docs/web-browser-design.md §6.3, §6.5).
 *
 * A viewer opens a session, proves the Space key, declares a pane, and gets
 * JPEG frames sized to that pane; it types, and the characters land in the
 * fixture's `<input>`; it types again under a stale control generation, and
 * nothing lands.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { BrowserContext } from "playwright-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import WebSocket from "ws";
import { ControlClient, type SessionTicketRedemption } from "../../src/control-client.js";
import { PlaywrightBrowserBackend } from "../../src/backend/playwright-backend.js";
import { installNetworkGuard } from "../../src/browser/guard.js";
import { SafeBrowserNetworkPolicy } from "../../src/browser/network-policy.js";
import { PlaywrightBrowserRuntime } from "../../src/browser/runtime.js";
import { jpegSize } from "../../src/live/common.js";
import type { ClaimOutcome, SessionClosing } from "../../src/sessions/session-registry.js";
import { ShellHost, type ShellHostSpace } from "../../src/sessions/shell-host.js";
import {
  ShellSocketServer,
  type ShellSession,
  type ShellSessionRegistry,
} from "../../src/sessions/shell-server.js";
import { CHROMIUM, describeChromium } from "../helpers/chromium.js";
import { startFakeControl, type FakeControl } from "../helpers/fake-control.js";
import { settle, startFixture, type FixtureServer } from "../helpers/fixture-server.js";
import { shellProof, USER_A, verifyShellProof } from "../helpers/keys.js";

const SPACE = "work";
const BROWSER_URL = "https://app.example";

const PAGE_HTML = `<!doctype html><html><head><title>Typing</title></head><body style="margin:0;background:#204020">
<input id="field" autofocus style="font-size:32px;width:90%" />
<script>document.getElementById("field").focus();</script>
</body></html>`;

const runtime = new PlaywrightBrowserRuntime({ executablePath: CHROMIUM ?? undefined, proxyMode: "direct" });
const contexts: BrowserContext[] = [];
const fixture: FixtureServer = await startFixture((request, response) => {
  if (new URL(request.url ?? "/", "http://localhost").pathname === "/type.html") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(PAGE_HTML);
    return;
  }
  response.writeHead(404);
  response.end();
});
const pageUrl = `${fixture.origin}/type.html`;

/** A session over a real host: the fence is a field, the browser is real. */
class LiveFakeSession implements ShellSession {
  readonly viewers = new Set<WebSocket>();
  control: ShellSession["control"] = { holder: "human", generation: 5 };
  closed = false;
  dropped = 0;
  readonly #listeners = new Set<() => void>();

  constructor(
    readonly id: string,
    readonly userId: string,
    readonly spaceId: string,
    readonly host: ShellHost,
  ) {}

  verifySpaceProof(nonce: string, proof: string): Promise<boolean> {
    return verifyShellProof(this.spaceId, this.id, nonce, proof);
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  attachViewer(ws: WebSocket): void {
    this.viewers.add(ws);
  }

  detachViewer(ws: WebSocket): void {
    this.viewers.delete(ws);
  }

  mayAct(generation: number): boolean {
    if (this.control.holder === "human" && generation === this.control.generation) return true;
    this.dropped += 1;
    return false;
  }
}

interface Frame {
  t: string;
  [key: string]: unknown;
}

describeChromium("the streamed pane", () => {
  let fake: FakeControl;
  let server: Server;
  let shell: ShellSocketServer;
  let baseUrl: string;
  let session: LiveFakeSession;
  let host: ShellHost;
  let sessionId: string;
  let deviceId: string;

  beforeAll(async () => {
    fake = await startFakeControl();
    deviceId = fake.addWebDevice(USER_A).id;
    sessionId = fake.addBrowserSession({ userId: USER_A, spaceId: SPACE }).id;

    const browser = await runtime.browser();
    const context = await browser.newContext({
      serviceWorkers: "block",
      acceptDownloads: false,
      viewport: { width: 1280, height: 800 },
    });
    contexts.push(context);
    const policy = new SafeBrowserNetworkPolicy({ allowedOrigins: [fixture.origin] });
    const listeners = new Set<() => void>();
    const backend = await PlaywrightBrowserBackend.attach({
      context,
      spaceId: SPACE,
      policy,
      installGuard: (page) => installNetworkGuard(page, { policy, gateway: () => null, credential: () => null }),
      onTabsChanged: () => {
        for (const listener of [...listeners]) listener();
      },
      settle: async () => undefined,
    });
    const space: ShellHostSpace = {
      browser: {
        backend,
        onTabsChanged: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      workspace: null,
    };
    host = new ShellHost({
      sessionId,
      userId: USER_A,
      spaceId: SPACE,
      space,
      control: () => session.control,
    });
    session = new LiveFakeSession(sessionId, USER_A, SPACE, host);
    const registry: ShellSessionRegistry = {
      get: () => session,
      claim: async (_id: string, _redemption: SessionTicketRedemption): Promise<ClaimOutcome<ShellSession>> => ({
        kind: "session",
        session,
      }),
      viewerAttached: () => undefined,
      viewerDetached: () => undefined,
      onClosing: (_listener: (id: string, reason: SessionClosing) => void) => () => undefined,
    };
    shell = new ShellSocketServer({
      control: new ControlClient({ baseUrl: fake.baseUrl, serviceToken: fake.serviceToken }),
      registry,
      browserUrl: BROWSER_URL,
      serviceToken: fake.serviceToken,
      recheckIntervalMs: 30_000,
      proofTimeoutMs: 5_000,
    });
    server = createServer((_request, response) => {
      response.statusCode = 404;
      response.end();
    });
    shell.attach(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `ws://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await shell.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fake.close();
    await Promise.all(contexts.splice(0).map((context) => context.close().catch(() => undefined)));
    await runtime.close();
    await fixture.close();
  });

  async function attach(): Promise<{ ws: WebSocket; frames: Frame[] }> {
    const ticket = fake.mintSessionTicket({ userId: USER_A, deviceId, sessionId });
    const ws = new WebSocket(`${baseUrl}/v1/shell/${sessionId}?access_token=${ticket}`);
    const frames: Frame[] = [];
    ws.on("message", (data) => frames.push(JSON.parse(data.toString()) as Frame));
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    await settle(() => frames.length >= 1);
    const nonce = frames[0]?.["nonce"] as string;
    ws.send(JSON.stringify({ t: "auth", proof: await shellProof(SPACE, sessionId, nonce) }));
    await settle(() => frames.some((frame) => frame.t === "ready"));
    return { ws, frames };
  }

  it("streams the pane, types into the page, and drops a stale generation", async () => {
    const { ws, frames } = await attach();

    // Open the fixture through the RPC envelope, as the shell would.
    ws.send(JSON.stringify({ t: "call", id: "1", method: "createTab", args: [pageUrl] }));
    await settle(() => frames.some((frame) => frame.t === "reply" && frame["id"] === "1"));
    const tabId = (await host.getSnapshot()).activeTabId!;

    // A pane declares its size; the stream follows it (W10). The first frame
    // is the page as it was — a still taken before the viewport moved — so
    // what is asserted is that the STREAM comes back inside the pane.
    ws.send(JSON.stringify({ t: "pane", tabId, width: 400, height: 300, dpr: 1, visible: true }));
    await settle(() => frames.some((frame) => frame.t === "frame"));
    expect(frames.find((frame) => frame.t === "frame")?.["tabId"]).toBe(tabId);
    await settle(() =>
      frames.some((frame) => {
        if (frame.t !== "frame") return false;
        const size = jpegSize(Buffer.from(frame["data"] as string, "base64"));
        return size !== null && size.width <= 400 && size.height <= 300;
      }),
    );

    // Typing under the current fence lands in the page.
    for (const character of "hi") {
      ws.send(
        JSON.stringify({
          t: "input",
          tabId,
          generation: 5,
          event: { kind: "key", type: "keyDown", key: character, code: `Key${character.toUpperCase()}`, text: character, modifiers: 0 },
        }),
      );
      ws.send(
        JSON.stringify({
          t: "input",
          tabId,
          generation: 5,
          event: { kind: "key", type: "keyUp", key: character, code: `Key${character.toUpperCase()}`, modifiers: 0 },
        }),
      );
    }
    expect(await waitForField(host, tabId, "hi")).toBe("hi");

    // The same keystroke under the generation before the fence moved goes
    // nowhere, and is counted (W7).
    session.control = { holder: "human", generation: 6 };
    ws.send(
      JSON.stringify({
        t: "input",
        tabId,
        generation: 5,
        event: { kind: "key", type: "keyDown", key: "z", code: "KeyZ", text: "z", modifiers: 0 },
      }),
    );
    await settle(() => session.dropped === 1);
    expect(await fieldValue(host, tabId)).toBe("hi");

    ws.close();
  });

  it("navigates through the socket and finds the same session after a reconnect", async () => {
    const first = await attach();
    first.ws.send(JSON.stringify({ t: "call", id: "n1", method: "createTab", args: [pageUrl] }));
    await settle(() => first.frames.some((frame) => frame.t === "reply" && frame["id"] === "n1"));
    const tabId = (await host.getSnapshot()).activeTabId!;

    first.ws.send(JSON.stringify({ t: "call", id: "n2", method: "navigate", args: [tabId, `${pageUrl}?again=1`] }));
    await settle(() => first.frames.some((frame) => frame.t === "reply" && frame["id"] === "n2"));
    expect((await host.getSnapshot()).tabs.find((tab) => tab.id === tabId)?.url).toBe(`${pageUrl}?again=1`);

    // The viewer goes; the session does not (W4). A fresh ticket, a fresh
    // socket, and the same tab is still live behind it.
    first.ws.close();
    await settle(() => session.viewers.size === 0);
    const second = await attach();
    second.ws.send(JSON.stringify({ t: "call", id: "n3", method: "getSnapshot", args: [] }));
    await settle(() => second.frames.some((frame) => frame.t === "reply" && frame["id"] === "n3"));
    const reply = second.frames.find((frame) => frame.t === "reply" && frame["id"] === "n3");
    const snapshot = reply?.["result"] as { tabs: Array<{ id: string; url: string }> };
    expect(snapshot.tabs.map((tab) => tab.id)).toContain(tabId);
    expect(snapshot.tabs.find((tab) => tab.id === tabId)?.url).toBe(`${pageUrl}?again=1`);
    second.ws.close();
  });
});

/** Poll the fixture's input until it holds `wanted`, or give up and report it. */
async function waitForField(host: ShellHost, tabId: string, wanted: string): Promise<string> {
  let value = "";
  for (let turn = 0; turn < 80; turn += 1) {
    value = await fieldValue(host, tabId);
    if (value === wanted) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return value;
}

async function fieldValue(host: ShellHost, tabId: string): Promise<string> {
  const cdp = host.guardSessionFor(tabId);
  if (cdp === null) return "";
  const result = (await cdp.send("Runtime.evaluate", {
    expression: "document.getElementById('field').value",
    returnByValue: true,
  })) as { result: { value: string } };
  return result.result.value;
}
