/**
 * The DOM mirror over the real shell socket into a real Chromium page
 * (docs/web-browser-design.md §16, §16.3).
 *
 * A viewer proves the Space key, declares a `dom` pane, and gets the page's
 * document as a mirror snapshot whose asset URLs are tokens; it asks for one
 * of those tokens and the bytes come back on a BINARY frame, reassembled to
 * the fixture's real image; it sends a `key` that names the focused field and
 * the character lands in the page; it sends an `edit` and the field takes the
 * whole value. It is `shell-stream.test.ts`'s sibling — the same real stack,
 * the mirror channel instead of the screencast.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { BrowserContext } from "playwright-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import WebSocket from "ws";
import { AssetAssembler, type MirrorServerMessage } from "@pistachio/dom-mirror";
import { decodeShellServerFrame, DOWNLOAD_KEY_HEADER } from "@pistachio/shell-contracts/socket";
import { ControlClient, type SessionTicketRedemption } from "../../src/control-client.js";
import { PlaywrightBrowserBackend } from "../../src/backend/playwright-backend.js";
import { installNetworkGuard } from "../../src/browser/guard.js";
import { SafeBrowserNetworkPolicy } from "../../src/browser/network-policy.js";
import { PlaywrightBrowserRuntime } from "../../src/browser/runtime.js";
import type { ClaimOutcome, SessionClosing } from "../../src/sessions/session-registry.js";
import { ShellHost, type ShellHostSpace } from "../../src/sessions/shell-host.js";
import { ShellSocketServer, type ShellSession, type ShellSessionRegistry } from "../../src/sessions/shell-server.js";
import { CHROMIUM, describeChromium } from "../helpers/chromium.js";
import { startFakeControl, type FakeControl } from "../helpers/fake-control.js";
import { settle, startFixture, type FixtureServer } from "../helpers/fixture-server.js";
import { shellProof, USER_A, verifyShellProof } from "../helpers/keys.js";

const SPACE = "work";
const BROWSER_URL = "https://app.example";

/** A 1×1 red PNG the fixture serves at /logo.png, for the asset broker to fetch. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC",
  "base64",
);

const runtime = new PlaywrightBrowserRuntime({ executablePath: CHROMIUM ?? undefined, proxyMode: "direct" });
const contexts: BrowserContext[] = [];
const fixture: FixtureServer = await startFixture((request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  if (path === "/page.html") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      `<!doctype html><html><head><title>Mirror me</title></head><body style="margin:0">
<h1 id="heading">Live document</h1>
<input id="field" autofocus />
<img id="logo" src="/logo.png" width="1" height="1" />
<script>document.getElementById("field").focus();</script>
</body></html>`,
    );
    return;
  }
  if (path === "/logo.png") {
    response.writeHead(200, { "content-type": "image/png" });
    response.end(PNG);
    return;
  }
  response.writeHead(404);
  response.end();
});
const pageUrl = `${fixture.origin}/page.html`;

class LiveFakeSession implements ShellSession {
  readonly viewers = new Set<WebSocket>();
  control: ShellSession["control"] = { holder: "human", generation: 3 };
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

describeChromium("the DOM mirror over the socket", () => {
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
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false, viewport: { width: 1280, height: 800 } });
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
    host = new ShellHost({ sessionId, userId: USER_A, spaceId: SPACE, space, control: () => session.control });
    session = new LiveFakeSession(sessionId, USER_A, SPACE, host);
    const registry: ShellSessionRegistry = {
      get: () => session,
      claim: async (_id: string, _redemption: SessionTicketRedemption): Promise<ClaimOutcome<ShellSession>> => ({ kind: "session", session }),
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
    server = createServer((request, response) => {
      if (shell.handleRequest(request, response)) return;
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

  interface Attached {
    ws: WebSocket;
    frames: Array<Record<string, unknown>>;
    /** Mirror messages for the tab, in order. */
    mirror: MirrorServerMessage[];
    assembler: AssetAssembler;
    assets: Map<string, { type: string; bytes: Uint8Array }>;
  }

  async function attach(): Promise<Attached> {
    const ticket = fake.mintSessionTicket({ userId: USER_A, deviceId, sessionId });
    const ws = new WebSocket(`${baseUrl}/v1/shell/${sessionId}?access_token=${ticket}`);
    const frames: Array<Record<string, unknown>> = [];
    const mirror: MirrorServerMessage[] = [];
    const assembler = new AssetAssembler();
    const assets = new Map<string, { type: string; bytes: Uint8Array }>();
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        const asset = assembler.receive(new Uint8Array(data));
        if (asset !== null) assets.set(asset.id, { type: asset.type, bytes: asset.bytes });
        return;
      }
      const frame = decodeShellServerFrame(data.toString());
      if (frame === null) return;
      frames.push(frame as unknown as Record<string, unknown>);
      if (frame.t === "mirror") mirror.push(frame.msg);
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    await settle(() => frames.length >= 1);
    const nonce = frames[0]?.["nonce"] as string;
    ws.send(JSON.stringify({ t: "auth", proof: await shellProof(SPACE, sessionId, nonce) }));
    await settle(() => frames.some((frame) => frame["t"] === "ready"));
    return { ws, frames, mirror, assembler, assets };
  }

  it("mirrors the document, brokers an asset, and takes typed and edited input", async () => {
    const view = await attach();

    view.ws.send(JSON.stringify({ t: "call", id: "1", method: "createTab", args: [pageUrl] }));
    await settle(() => view.frames.some((frame) => frame["t"] === "reply" && frame["id"] === "1"));
    const tabId = (await host.getSnapshot()).activeTabId!;

    // A pane that wants the document, not pixels (§16).
    view.ws.send(JSON.stringify({ t: "pane", tabId, width: 800, height: 600, dpr: 1, visible: true, renderer: "dom" }));
    await settle(() => view.mirror.some((message) => message.k === "snapshot"), { turns: 400 });
    const snapshot = view.mirror.find((message) => message.k === "snapshot");
    expect(snapshot?.k).toBe("snapshot");

    // The document carries the heading text, and the logo as an asset token.
    const flat = JSON.stringify(snapshot);
    expect(flat).toContain("Live document");
    const token = /pa-asset:([A-Za-z0-9_-]+)/u.exec(flat);
    expect(token).not.toBeNull();
    const assetId = token![1]!;

    // Ask for the asset; its bytes come back on a binary frame and match the fixture's PNG.
    view.ws.send(JSON.stringify({ t: "mirror", tabId, generation: 3, msg: { k: "need", ids: [assetId] } }));
    await settle(() => view.assets.has(assetId), { turns: 400 });
    const asset = view.assets.get(assetId)!;
    expect(asset.type).toBe("image/png");
    expect(Buffer.from(asset.bytes).equals(PNG)).toBe(true);

    // Type into the focused field by naming it; the character lands in the page.
    view.ws.send(
      JSON.stringify({
        t: "mirror",
        tabId,
        generation: 3,
        msg: { k: "key", frame: "main", epoch: snapshot !== undefined && snapshot.k === "snapshot" ? snapshot.epoch : 1, id: null, event: { kind: "key", type: "keyDown", key: "z", code: "KeyZ", text: "z", modifiers: 0 } },
      }),
    );
    expect(await waitForField(host, tabId, "z")).toBe("z");

    // An edit sets the whole value at once (paste, autofill, IME).
    const fieldId = findFieldId(snapshot);
    expect(fieldId).not.toBeNull();
    view.ws.send(
      JSON.stringify({
        t: "mirror",
        tabId,
        generation: 3,
        msg: { k: "edit", frame: "main", epoch: snapshot !== undefined && snapshot.k === "snapshot" ? snapshot.epoch : 1, id: fieldId, rev: 1, v: "typed by edit", s: null, e: null },
      }),
    );
    expect(await waitForField(host, tabId, "typed by edit")).toBe("typed by edit");
    // The cloud acknowledged the edit revision.
    await settle(() => view.mirror.some((message) => message.k === "edited" && message.rev === 1));

    // A stale control generation is refused, and counted (W7).
    session.control = { holder: "human", generation: 4 };
    const before = await fieldValue(host, tabId);
    view.ws.send(
      JSON.stringify({
        t: "mirror",
        tabId,
        generation: 3,
        msg: { k: "edit", frame: "main", epoch: 1, id: fieldId, rev: 2, v: "should not land", s: null, e: null },
      }),
    );
    await settle(() => session.dropped >= 1);
    expect(await fieldValue(host, tabId)).toBe(before);

    view.ws.close();
  });
  it("serves captured assets over HTTP only to a live proved viewer and does not refetch private addresses", async () => {
    session.control = { holder: "human", generation: 10 };
    const view = await attach();
    await host.createTab(pageUrl);
    const tabId = (await host.getSnapshot()).activeTabId!;
    view.ws.send(JSON.stringify({ t: "pane", tabId, width: 800, height: 600, dpr: 1, visible: true, renderer: "dom" }));
    await settle(() => view.mirror.some(message => message.k === "snapshot"));
    const snapshot = view.mirror.find(message => message.k === "snapshot");
    const id = /pa-asset:([A-Za-z0-9_-]+)/u.exec(JSON.stringify(snapshot))![1]!;
    const key = view.frames.find(frame => frame["t"] === "ready")!["downloadKey"] as string;
    const url = `${baseUrl.replace("ws:", "http:")}/v1/shell/${encodeURIComponent(sessionId)}/assets/${encodeURIComponent(tabId)}/${id}`;
    expect((await fetch(url)).status).toBe(404);
    expect((await fetch(url, { headers: { [DOWNLOAD_KEY_HEADER]: "wrong" } })).status).toBe(404);
    expect((await fetch(url, { headers: { [DOWNLOAD_KEY_HEADER]: key, origin: "https://untrusted.example" } })).status).toBe(403);
    const options = await fetch(url, { method: "OPTIONS", headers: { origin: BROWSER_URL } });
    expect(options.status).toBe(204);
    const response = await fetch(url, { headers: { [DOWNLOAD_KEY_HEADER]: key, origin: BROWSER_URL } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
    let privateHits = 0;
    const privateServer = await startFixture((_request, response) => { privateHits += 1; response.writeHead(200); response.end("private"); });
    try {
      await expect(new SafeBrowserNetworkPolicy().assertAllowed(privateServer.origin)).rejects.toThrow();
      const broker = host.assetBroker();
      const unobserved = broker.assign(`${privateServer.origin}/secret`, "image");
      expect(await broker.bytesFor(unobserved)).toBe("pending");
      expect(privateHits).toBe(0);
    } finally { await privateServer.close(); }
    view.ws.close();
    await new Promise<void>(resolve => view.ws.once("close", () => resolve()));
    expect((await fetch(url, { headers: { [DOWNLOAD_KEY_HEADER]: key } })).status).toBe(404);
  });

  it("keeps the first viewer's viewport and sends edit acknowledgements only to their originator", async () => {
    session.control = { holder: "human", generation: 20 };
    const first = await attach();
    await host.createTab(pageUrl);
    const tabId = (await host.getSnapshot()).activeTabId!;
    first.ws.send(JSON.stringify({ t: "pane", tabId, width: 900, height: 600, dpr: 1, visible: true, renderer: "dom" }));
    await settle(() => first.mirror.some(message => message.k === "snapshot"));
    const second = await attach();
    second.ws.send(JSON.stringify({ t: "pane", tabId, width: 500, height: 400, dpr: 1, visible: true, renderer: "dom" }));
    await settle(() => second.mirror.some(message => message.k === "snapshot"));
    const cdp = host.guardSessionFor(tabId)!;
    await expect.poll(async () => (await cdp.send("Runtime.evaluate", { expression: "innerWidth", returnByValue: true })).result.value).toBe(900);
    const snapshot = second.mirror.find(message => message.k === "snapshot")!;
    if (snapshot.k !== "snapshot") throw new Error("missing snapshot");
    const id = findFieldId(snapshot)!;
    second.ws.send(JSON.stringify({ t: "mirror", tabId, generation: 20, msg: { k: "edit", frame: "main", epoch: snapshot.epoch, id, rev: 1, v: "second viewer", s: null, e: null } }));
    await settle(() => second.mirror.some(message => message.k === "edited"));
    expect(first.mirror.some(message => message.k === "edited")).toBe(false);
    expect(await fieldValue(host, tabId)).toBe("second viewer");
    await expect.poll(async () => (await cdp.send("Runtime.evaluate", { expression: "innerWidth", returnByValue: true })).result.value).toBe(500);
    session.control = { holder: "agent", generation: 21 };
    const before = second.mirror.filter(message => message.k === "snapshot").length;
    second.ws.send(JSON.stringify({ t: "mirror", tabId, generation: 21, msg: { k: "resync" } }));
    await settle(() => second.mirror.filter(message => message.k === "snapshot").length > before);
    first.ws.close(); second.ws.close();
  });

});

/** The node id of the `input`, from the snapshot's tree. */
function findFieldId(snapshot: MirrorServerMessage | undefined): number | null {
  if (snapshot === undefined || snapshot.k !== "snapshot") return null;
  let found: number | null = null;
  const walk = (node: { t: string; id?: number; tag?: string; c?: unknown[]; sh?: unknown[] }): void => {
    if (found !== null) return;
    if (node.t === "e" && node.tag === "input" && node.id !== undefined) {
      found = node.id;
      return;
    }
    for (const child of [...(node.c ?? []), ...(node.sh ?? [])]) walk(child as never);
  };
  walk(snapshot.root as never);
  return found;
}

async function waitForField(host: ShellHost, tabId: string, wanted: string): Promise<string> {
  let value = "";
  for (let turn = 0; turn < 120; turn += 1) {
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
