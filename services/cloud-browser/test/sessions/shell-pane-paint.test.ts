/**
 * The first frame a pane ever gets (docs/web-browser-design.md §6.3).
 *
 * A screencast is silent whenever the page is, and a welcome page, a reader
 * document or any page an agent left alone is silent for ever — so the whole
 * of what such a viewer sees is the ONE-OFF snapshot taken when its pane
 * joins. Everything here is about that snapshot not landing on the first try:
 * the page was still navigating, the guard session was not attached yet, the
 * screencast itself refused to start. Each of those used to end with the pane
 * showing "Opening…" until the person gave up, because nothing tried again.
 *
 * CDP is faked. What is under test is the retry, not Chromium.
 */

import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { CDPSession } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { ControlClient, type SessionTicketRedemption } from "../../src/control-client.js";
import type { ClaimOutcome, SessionClosing } from "../../src/sessions/session-registry.js";
import type { ShellHost } from "../../src/sessions/shell-host.js";
import { ShellSocketServer, type ShellSession, type ShellSessionRegistry } from "../../src/sessions/shell-server.js";
import { startFakeControl, type FakeControl } from "../helpers/fake-control.js";
import { settle } from "../helpers/fixture-server.js";
import { shellProof, USER_A, verifyShellProof } from "../helpers/keys.js";

const SPACE = "work";
const BROWSER_URL = "https://app.example";
const TAB = "web:1";

interface Frame {
  t: string;
  [key: string]: unknown;
}

/** Not a JPEG, on purpose: the size then comes off the layout metrics. */
const PIXELS = Buffer.from("a still of the page").toString("base64");

const METRICS = {
  cssLayoutViewport: { clientWidth: 400, clientHeight: 300 },
  cssVisualViewport: { pageX: 0, pageY: 0, scale: 1 },
};

/**
 * A page's CDP session, as much of it as a screencast touches. The knobs are
 * the three ways a first frame goes missing in the wild.
 */
class FakeCdp extends EventEmitter {
  readonly calls: string[] = [];
  /** How many `Page.captureScreenshot` calls reject before one answers. */
  failScreenshots = 0;
  /** While true, `Page.captureScreenshot` rejects however often it is asked. */
  screenshotsBlocked = false;
  /** How many `Page.startScreencast` calls reject before one is accepted. */
  failStarts = 0;
  /**
   * While true, `Page.captureScreenshot` NEVER SETTLES — which is what
   * Chromium does for a page that is not the front one in its context, and is
   * not the same thing as failing.
   */
  screenshotsHang = false;
  screenshots = 0;
  starts = 0;

  async send(method: string): Promise<unknown> {
    this.calls.push(method);
    if (method === "Page.captureScreenshot") {
      this.screenshots += 1;
      if (this.screenshotsHang) return new Promise<never>(() => undefined);
      if (this.screenshotsBlocked || this.screenshots <= this.failScreenshots) {
        throw new Error("Unable to capture screenshot");
      }
      return { data: PIXELS };
    }
    if (method === "Page.getLayoutMetrics") return METRICS;
    if (method === "Page.startScreencast") {
      this.starts += 1;
      if (this.starts <= this.failStarts) throw new Error("Target closed");
      return {};
    }
    return {};
  }

  /** One live frame, as Chromium would send it when the page paints. */
  paint(): void {
    this.emit("Page.screencastFrame", {
      data: PIXELS,
      metadata: { deviceWidth: 400, deviceHeight: 300, pageScaleFactor: 1, scrollOffsetX: 0, scrollOffsetY: 0 },
      sessionId: 1,
    });
  }
}

/** A session with no browser behind it: a fake CDP and a tab that may not be guarded yet. */
class PaneSession implements ShellSession {
  readonly viewers = new Set<WebSocket>();
  control: ShellSession["control"] = { holder: "human", generation: 1 };
  closed = false;
  readonly cdp = new FakeCdp();
  /** Whether the tab's page has a guard session yet (a tab the host just opened may not). */
  guarded = true;
  readonly host: ShellHost;
  readonly #listeners = new Set<() => void>();

  constructor(
    readonly id: string,
    readonly userId: string,
    readonly spaceId: string,
  ) {
    this.host = {
      getSnapshot: async () => ({ tabs: [], spaces: [] }),
      onSnapshot: () => () => undefined,
      hasTab: (tabId: string) => tabId === TAB,
      noteViewerActivity: () => undefined,
      setPane: () => undefined,
      paneFor: () => null,
      guardSessionFor: (tabId: string) =>
        tabId === TAB && this.guarded ? (this.cdp as unknown as CDPSession) : null,
      visibleTabIds: () => [TAB],
    } as unknown as ShellHost;
  }

  async verifySpaceProof(nonce: string, proof: string): Promise<boolean> {
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

  mayAct(): boolean {
    return true;
  }
}

let fake: FakeControl;
let server: Server;
let shell: ShellSocketServer;
let baseUrl: string;
let session: PaneSession;
let sessionId: string;
let device: { id: string };

beforeEach(async () => {
  fake = await startFakeControl();
  device = fake.addWebDevice(USER_A);
  sessionId = fake.addBrowserSession({ userId: USER_A, spaceId: SPACE }).id;
  session = new PaneSession(sessionId, USER_A, SPACE);
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

afterEach(async () => {
  await shell.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fake.close();
});

async function attach(): Promise<{ ws: WebSocket; frames: Frame[] }> {
  const ticket = fake.mintSessionTicket({ userId: USER_A, deviceId: device.id, sessionId });
  const ws = new WebSocket(`${baseUrl}/v1/shell/${sessionId}?access_token=${ticket}`, { origin: BROWSER_URL });
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

const pane = (visible = true): string =>
  JSON.stringify({ t: "pane", tabId: TAB, width: 400, height: 300, dpr: 1, visible });

const painted = (frames: Frame[]): Frame[] => frames.filter((frame) => frame.t === "frame");

describe("the first frame a pane is given", () => {
  it("refreshes a static page after its viewport changes even without a compositor frame", async () => {
    const { ws, frames } = await attach();
    ws.send(pane());
    await settle(() => painted(frames).length > 0);
    const before = painted(frames).length;
    session.cdp.emit("Page.frameResized");
    await settle(() => painted(frames).length > before);
  });
  it("a static page still paints for a viewer whose first snapshot failed", async () => {
    // The page was mid-navigation when the pane arrived — `captureScreenshot`
    // refuses while the frame is being swapped — and the document it lands on
    // is static, so no `Page.screencastFrame` will ever arrive on its own.
    // The pane used to sit on "Opening…" for ever.
    session.cdp.failScreenshots = 1;
    const { ws, frames } = await attach();
    ws.send(pane());
    await settle(() => painted(frames).length > 0, { turns: 400 });
    expect(painted(frames)[0]).toMatchObject({ tabId: TAB, width: 400, height: 300 });
    expect(session.cdp.screenshots).toBeGreaterThanOrEqual(2);
  });

  it("paints as soon as the page finishes loading, without waiting out the backoff", async () => {
    // Nothing can be captured until the document is there. `Page.loadEventFired`
    // says it is, and the retry takes its picture then rather than on its own
    // schedule.
    session.cdp.screenshotsBlocked = true;
    const { ws, frames } = await attach();
    ws.send(pane());
    await settle(() => session.cdp.screenshots >= 1, { turns: 400 });
    expect(painted(frames)).toHaveLength(0);

    session.cdp.screenshotsBlocked = false;
    session.cdp.emit("Page.loadEventFired", { timestamp: 1 });
    await settle(() => painted(frames).length > 0, { turns: 200 });
    expect(painted(frames)[0]).toMatchObject({ tabId: TAB });
  });

  it("waits for the guard session of a tab the host has only just opened", async () => {
    // A document tab the host renders itself (`#showWelcome`, the reader) is
    // published to the shell as soon as it exists, so the pane can report
    // itself visible before the page has a guard session to screencast. The
    // pane message used to be dropped on the floor.
    session.guarded = false;
    const { ws, frames } = await attach();
    ws.send(pane());
    // Long enough that the server has certainly read the message and found
    // nothing to screencast.
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    expect(session.cdp.calls).toHaveLength(0);
    expect(painted(frames)).toHaveLength(0);

    session.guarded = true;
    await settle(() => painted(frames).length > 0, { turns: 400 });
    expect(painted(frames)[0]).toMatchObject({ tabId: TAB });
  });

  it("takes a fresh picture when a pane says it is visible again while still blank", async () => {
    session.cdp.screenshotsBlocked = true;
    const { ws, frames } = await attach();
    ws.send(pane());
    await settle(() => session.cdp.screenshots >= 1, { turns: 400 });
    expect(painted(frames)).toHaveLength(0);

    // The client re-reports the same pane — the shell does this on a reconnect
    // and on a re-render. A pane still showing "Opening…" is asking for a
    // picture it never got, and the repeat used to return early.
    session.cdp.screenshotsBlocked = false;
    ws.send(pane());
    await settle(() => painted(frames).length > 0, { turns: 400 });
    expect(painted(frames)[0]).toMatchObject({ tabId: TAB });
  });

  it("starts the screencast again when the first start was refused", async () => {
    // `Page.startScreencast` rejecting used to leave the stream marked
    // started: no live frames, no retry, and every later viewer of that page
    // inherited the silence.
    session.cdp.failStarts = 1;
    const { ws, frames } = await attach();
    ws.send(pane());
    await settle(() => painted(frames).length > 0, { turns: 400 });
    await settle(() => session.cdp.starts >= 2, { turns: 400 });

    // And the stream is live: a frame the page paints reaches the viewer.
    const before = painted(frames).length;
    session.cdp.paint();
    await settle(() => painted(frames).length > before, { turns: 200 });
  });

  it("a backgrounded page whose screenshot never answers still joins the live stream", async () => {
    // THE ONE THAT WAS ACTUALLY HAPPENING. `Page.captureScreenshot` does not
    // fail for a page that is not the front one in its context — it never
    // settles. Awaiting it before registering the viewer parked the whole
    // attach: no live emitter, no `Page.startScreencast`, no retry, and a
    // pane that said "Opening…" for the life of the session.
    session.cdp.screenshotsHang = true;
    const { ws, frames } = await attach();
    ws.send(pane());
    await settle(() => session.cdp.calls.includes("Page.startScreencast"), { turns: 400 });
    expect(painted(frames)).toHaveLength(0);

    // The page paints — the shell brought the tab to the front, the document
    // finished loading — and the pane has it, screenshot or no screenshot.
    session.cdp.paint();
    await settle(() => painted(frames).length > 0, { turns: 200 });
    expect(painted(frames)[0]).toMatchObject({ tabId: TAB });
  });

  it("gives up on a screenshot that never answers rather than waiting on it for ever", async () => {
    session.cdp.screenshotsHang = true;
    const { ws, frames } = await attach();
    ws.send(pane());
    await settle(() => session.cdp.screenshots >= 1, { turns: 400 });
    // The first capture is abandoned and asked again — an unbounded await
    // would have left this at one for the life of the page.
    await settle(() => session.cdp.screenshots >= 2, { turns: 800 });

    session.cdp.screenshotsHang = false;
    await settle(() => painted(frames).length > 0, { turns: 800 });
    expect(painted(frames)[0]).toMatchObject({ tabId: TAB, width: 400, height: 300 });
  });

  it("stops trying once a live frame has painted the pane", async () => {
    const { ws, frames } = await attach();
    ws.send(pane());
    await settle(() => painted(frames).length > 0, { turns: 400 });
    const taken = session.cdp.screenshots;
    // The snapshot answered at once, so there is nothing to retry: a page
    // that is already on screen must not be screenshotted every 250 ms.
    await settle(() => false, { turns: 20, stepMs: 25 }).catch(() => undefined);
    expect(session.cdp.screenshots).toBe(taken);
  });
});
