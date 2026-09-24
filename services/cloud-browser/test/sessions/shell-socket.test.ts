import { checkActionFence } from "../../src/runs/control-fence.js";
/**
 * The shell socket's authentication and routing (docs/web-browser-design.md
 * §5, §6.4, §6.5).
 *
 * The protocol is driven here against a fake session, so what is under test is
 * the transport itself: the origin pin, the one-redemption ticket, the
 * Space-key proof, the RPC envelope, the control fence over input, the
 * in-fleet relay, and what happens to viewers when the lease goes.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { ControlClient, type SessionTicketRedemption } from "../../src/control-client.js";
import type { ClaimOutcome, SessionClosing } from "../../src/sessions/session-registry.js";
import type { ShellHost } from "../../src/sessions/shell-host.js";
import {
  mayQueueEvent,
  MAX_BUFFERED_EVENT_BYTES,
  ShellSocketServer,
  type ShellSession,
  type ShellSessionRegistry,
} from "../../src/sessions/shell-server.js";
import { startFakeControl, type FakeControl } from "../helpers/fake-control.js";
import { settle } from "../helpers/fixture-server.js";
import { shellProof, USER_A, USER_B, verifyShellProof } from "../helpers/keys.js";

const SPACE = "work";
/**
 * The two web apps (docs/web-browser-design.md §15). The shell socket and its
 * download route belong to the browser app alone; `www` is a different site,
 * and a page there is a stranger here.
 */
const BROWSER_URL = "https://app.example";
const WWW_URL = "https://www.example";

interface Frame {
  t: string;
  [key: string]: unknown;
}

let fake: FakeControl;
let server: Server;
let shell: ShellSocketServer;
let baseUrl: string;
let session: FakeSession;
let registry: FakeRegistry;
let sessionId: string;
let device: { id: string };

/** A session with no browser behind it: enough for the protocol, and no more. */
class FakeSession implements ShellSession {
  readonly viewers = new Set<WebSocket>();
  control: ShellSession["control"] = { holder: "human", generation: 3 };
  closed = false;
  dropped = 0;
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  /** Host tabs this fake still has; a pane for anything else is stale. */
  readonly tabs = new Set<string>(["web:1"]);
  /** What the screencast actually asked CDP for. */
  readonly cdpCalls: string[] = [];
  readonly cdp = {
    send: async (method: string): Promise<unknown> => {
      this.cdpCalls.push(method);
      return method === "Page.captureScreenshot" ? { data: "" } : {};
    },
    on: () => undefined,
    off: () => undefined,
  } as unknown as import("playwright-core").CDPSession;
  readonly #listeners = new Set<() => void>();
  readonly host: ShellHost;

  constructor(
    readonly id: string,
    readonly userId: string,
    readonly spaceId: string,
  ) {
    const emit = new Set<(payload: unknown) => void>();
    this.host = {
      getSnapshot: async () => {
        this.calls.push({ method: "getSnapshot", args: [] });
        return { tabs: [], spaces: [] };
      },
      createTab: async (url?: string) => {
        this.calls.push({ method: "createTab", args: [url] });
        for (const listener of emit) listener({ tabs: [{ id: "web:1", url }] });
      },
      notes: async (request: unknown) => {
        this.calls.push({ method: "notes", args: [request] });
        return { type: "list", notes: [] };
      },
      onSnapshot: (listener: (payload: unknown) => void) => {
        emit.add(listener);
        return () => emit.delete(listener);
      },
      hasTab: (tabId: string) => this.tabs.has(tabId),
      noteViewerActivity: () => undefined,
      setPane: () => undefined,
      paneFor: () => null,
      guardSessionFor: (tabId: string) => (this.tabs.has(tabId) ? this.cdp : null),
      visibleTabIds: () => [...this.tabs],
    } as unknown as ShellHost;
  }

  async verifySpaceProof(nonce: string, proof: string): Promise<boolean> {
    return verifyShellProof(this.spaceId, this.id, nonce, proof);
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  notify(): void {
    for (const listener of [...this.#listeners]) listener();
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

class FakeRegistry implements ShellSessionRegistry {
  outcome: ClaimOutcome<ShellSession>;
  attached = 0;
  detached = 0;
  readonly claims: string[] = [];
  readonly #closing = new Set<(sessionId: string, reason: SessionClosing) => void>();

  constructor(private readonly held: FakeSession) {
    this.outcome = { kind: "session", session: held };
  }

  get(id: string): ShellSession | null {
    return id === this.held.id && this.outcome.kind === "session" ? this.held : null;
  }

  async claim(id: string, _redemption: SessionTicketRedemption): Promise<ClaimOutcome<ShellSession>> {
    this.claims.push(id);
    return this.outcome;
  }

  viewerAttached(): void {
    this.attached += 1;
  }

  viewerDetached(): void {
    this.detached += 1;
  }

  onClosing(listener: (sessionId: string, reason: SessionClosing) => void): () => void {
    this.#closing.add(listener);
    return () => this.#closing.delete(listener);
  }

  fire(id: string, reason: SessionClosing): void {
    for (const listener of [...this.#closing]) listener(id, reason);
  }
}

interface Opened {
  ws: WebSocket;
  status: number | null;
  frames: Frame[];
  /**
   * The close code, resolved from a listener registered at OPEN time. A test
   * that attaches one after the fact races a socket the server may already
   * have closed — and a race that hangs reads as a bug in the server rather
   * than in the test.
   */
  closed: Promise<number>;
}

function open(
  token: string | null,
  via: "header" | "query" = "query",
  id = sessionId,
  origin?: string,
): Promise<Opened> {
  const url = `${baseUrl}/v1/shell/${id}${via === "query" && token !== null ? `?access_token=${encodeURIComponent(token)}` : ""}`;
  const headers: Record<string, string> = {
    ...(via === "header" && token !== null ? { authorization: `Bearer ${token}` } : {}),
    ...(origin === undefined ? {} : { origin }),
  };
  const ws = new WebSocket(url, Object.keys(headers).length === 0 ? {} : { headers });
  const frames: Frame[] = [];
  ws.on("message", (data) => frames.push(JSON.parse(data.toString()) as Frame));
  const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
  return new Promise((resolve) => {
    ws.once("open", () => resolve({ ws, status: null, frames, closed }));
    ws.once("unexpected-response", (_request, response) => {
      resolve({ ws, status: response.statusCode ?? 0, frames, closed });
      response.resume();
    });
    ws.once("error", () => undefined);
  });
}

async function prove(opened: Opened, answer?: (nonce: string) => Promise<string>): Promise<void> {
  await settle(() => opened.frames.length >= 1);
  const challenge = opened.frames.shift();
  expect(challenge?.t).toBe("challenge");
  const nonce = challenge?.["nonce"] as string;
  const proof = answer === undefined ? await shellProof(SPACE, sessionId, nonce) : await answer(nonce);
  opened.ws.send(JSON.stringify({ t: "auth", proof }));
  await settle(() => opened.frames.some((frame) => frame.t === "ready" || frame.t === "error"));
}

function ticket(): string {
  return fake.mintSessionTicket({ userId: USER_A, deviceId: device.id, sessionId });
}

beforeEach(async () => {
  fake = await startFakeControl();
  const webDevice = fake.addWebDevice(USER_A);
  device = { id: webDevice.id };
  const row = fake.addBrowserSession({ userId: USER_A, spaceId: SPACE });
  sessionId = row.id;
  session = new FakeSession(sessionId, USER_A, SPACE);
  registry = new FakeRegistry(session);
  shell = new ShellSocketServer({
    control: new ControlClient({ baseUrl: fake.baseUrl, serviceToken: fake.serviceToken }),
    registry,
    browserUrl: BROWSER_URL,
    serviceToken: fake.serviceToken,
    recheckIntervalMs: 40,
    proofTimeoutMs: 1_500,
  });
  server = createServer((request, response) => {
    // The runner asks the shell server first (it owns one plain HTTP route,
    // the download); anything it does not claim is this fake's 404.
    if (shell.handleRequest(request, response)) return;
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

describe("upgrade authentication", () => {
  it("refuses an upgrade with no ticket at all", async () => {
    const { status } = await open(null);
    expect(status).toBe(401);
  });

  it("refuses a ticket that was never issued", async () => {
    const { status } = await open("pst_nonsense");
    expect(status).toBe(401);
  });

  it("spends a ticket exactly once", async () => {
    const spent = ticket();
    const first = await open(spent);
    expect(first.status).toBeNull();
    first.ws.close();
    const second = await open(spent);
    expect(second.status).toBe(401);
  });

  it("refuses a browser on any origin but the browser app's", async () => {
    const { status } = await open(ticket(), "query", sessionId, "https://evil.example");
    expect(status).toBe(403);
    // The ticket is spent by the redemption, not by the origin check, so the
    // refusal must come FIRST — otherwise a hostile page burns real tickets.
    expect(fake.sessionTickets.size).toBe(1);
  });

  it("refuses www, which is a different site from the browser app", async () => {
    // The dashboard is not the shell. It may watch a run's live view (§8.5),
    // but nothing on it drives someone's browser session, so its origin gets
    // no more here than a stranger's does — and, like a stranger's, it is
    // refused before the ticket is looked at.
    const { status } = await open(ticket(), "query", sessionId, WWW_URL);
    expect(status).toBe(403);
    expect(fake.sessionTickets.size).toBe(1);
  });

  it("accepts the browser app's own origin", async () => {
    const { status } = await open(ticket(), "query", sessionId, BROWSER_URL);
    expect(status).toBeNull();
  });

  it("refuses a ticket whose device was revoked between issue and redemption", async () => {
    const spent = ticket();
    fake.revokeDevice(device.id);
    const { status } = await open(spent);
    expect(status).toBe(401);
  });
});

describe("the Space key proof", () => {
  it("sends the challenge and nothing else until the viewer answers", async () => {
    const opened = await open(ticket());
    await settle(() => opened.frames.length >= 1);
    expect(opened.frames.map((frame) => frame.t)).toEqual(["challenge"]);
    // A call before the proof is not answered at all.
    opened.ws.send(JSON.stringify({ t: "call", id: "1", method: "getSnapshot", args: [] }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(opened.frames.map((frame) => frame.t)).toEqual(["challenge"]);
    expect(session.calls).toHaveLength(0);
    opened.ws.close();
  });

  it("answers `ready` with the control fence once the proof opens", async () => {
    const opened = await open(ticket());
    await prove(opened);
    const ready = opened.frames.find((frame) => frame.t === "ready");
    expect(ready).toMatchObject({ sessionId, control: { holder: "human", generation: 3 } });
  });

  it("closes 4004 on a wrong proof, and does not reissue the nonce", async () => {
    const opened = await open(ticket());
    await prove(opened, async () => "not-a-proof");
    expect(opened.frames.find((frame) => frame.t === "error")).toMatchObject({ code: "space_key_required" });
    expect(await opened.closed).toBe(4004);
  });

  it("closes 4004 when the viewer never answers", async () => {
    const opened = await open(ticket());
    expect(await opened.closed).toBe(4004);
    expect(opened.frames.find((frame) => frame.t === "error")).toMatchObject({ code: "space_key_required" });
  });

  it("refuses a proof sealed for another session", async () => {
    const opened = await open(ticket());
    await prove(opened, (nonce) => shellProof(SPACE, "another-session", nonce));
    expect(await opened.closed).toBe(4004);
  });
});

describe("the device re-check", () => {
  it("closes 4003 when the viewer's device is revoked mid-socket", async () => {
    const opened = await open(ticket());
    await prove(opened);
    fake.revokeDevice(device.id);
    expect(await opened.closed).toBe(4003);
  });

  it("closes 4003 when the device now belongs to somebody else", async () => {
    const opened = await open(ticket());
    await prove(opened);
    const row = fake.devices.get(device.id);
    if (row !== undefined) row.userId = USER_B;
    expect(await opened.closed).toBe(4003);
  });
});

describe("the RPC envelope", () => {
  it("calls the host and replies with its result", async () => {
    const opened = await open(ticket());
    await prove(opened);
    opened.ws.send(JSON.stringify({ t: "call", id: "a1", method: "getSnapshot", args: [] }));
    await settle(() => opened.frames.some((frame) => frame.t === "reply"));
    const reply = opened.frames.find((frame) => frame.t === "reply");
    expect(reply).toMatchObject({ id: "a1", ok: true, result: { tabs: [], spaces: [] } });
  });

  it("answers a method this host does not have with `unsupported`, and stays open", async () => {
    const opened = await open(ticket());
    await prove(opened);
    // `forkSpace` is a real ShellApi member the fake host does not implement.
    opened.ws.send(JSON.stringify({ t: "call", id: "a2", method: "forkSpace", args: [{}] }));
    await settle(() => opened.frames.some((frame) => frame.t === "reply"));
    expect(opened.frames.find((frame) => frame.t === "reply")).toMatchObject({
      id: "a2",
      ok: false,
      error: { code: "unsupported" },
    });
    expect(opened.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("ignores a frame that is not a frame at all", async () => {
    const opened = await open(ticket());
    await prove(opened);
    opened.ws.send("{{{not json");
    opened.ws.send(JSON.stringify({ t: "call", id: 7, method: "getSnapshot" }));
    opened.ws.send(JSON.stringify({ t: "call", id: "a3", method: "getSnapshot", args: [] }));
    await settle(() => opened.frames.some((frame) => frame.t === "reply"));
    expect(opened.frames.filter((frame) => frame.t === "reply")).toHaveLength(1);
  });

  it("carries a host event on its own channel", async () => {
    const opened = await open(ticket());
    await prove(opened);
    opened.ws.send(JSON.stringify({ t: "call", id: "a4", method: "createTab", args: ["https://example.test/"] }));
    await settle(() => opened.frames.some((frame) => frame.t === "event"));
    expect(opened.frames.find((frame) => frame.t === "event")).toMatchObject({
      channel: "pistachio:snapshot-changed",
      payload: { tabs: [{ id: "web:1", url: "https://example.test/" }] },
    });
  });

  it("re-sends the control fence when it moves", async () => {
    const opened = await open(ticket());
    await prove(opened);
    session.control = { holder: "agent", generation: 4 };
    session.notify();
    await settle(() => opened.frames.some((frame) => frame.t === "control"));
    expect(opened.frames.find((frame) => frame.t === "control")).toMatchObject({ holder: "agent", generation: 4 });
  });
});

describe("input under the control fence (W7)", () => {
  it("drops input issued under an older generation, and counts it", async () => {
    const opened = await open(ticket());
    await prove(opened);
    opened.ws.send(
      JSON.stringify({
        t: "input",
        tabId: "web:1",
        generation: 2,
        event: { kind: "key", type: "keyDown", key: "a", code: "KeyA", modifiers: 0 },
      }),
    );
    await settle(() => session.dropped === 1);
    expect(session.dropped).toBe(1);
  });

  it("drops input while the agent holds the wheel, whatever generation it carries", async () => {
    const opened = await open(ticket());
    await prove(opened);
    session.control = { holder: "agent", generation: 3 };
    opened.ws.send(
      JSON.stringify({
        t: "input",
        tabId: "web:1",
        generation: 3,
        event: { kind: "mouse", type: "mousePressed", x: 1, y: 1, button: "left", clickCount: 1, modifiers: 0 },
      }),
    );
    await settle(() => session.dropped === 1);
    expect(session.dropped).toBe(1);
  });
});

describe("two viewers", () => {
  it("both attach to the same session and both hear its events", async () => {
    const first = await open(ticket());
    await prove(first);
    const second = await open(ticket());
    await prove(second);
    expect(session.viewers.size).toBe(2);
    first.ws.send(JSON.stringify({ t: "call", id: "b1", method: "createTab", args: ["https://example.test/"] }));
    await settle(() => first.frames.some((frame) => frame.t === "event") && second.frames.some((frame) => frame.t === "event"));
    expect(second.frames.find((frame) => frame.t === "event")).toMatchObject({ channel: "pistachio:snapshot-changed" });
  });

  it("counts a viewer out again when it goes, so the idle clock can start", async () => {
    const opened = await open(ticket());
    await prove(opened);
    expect(registry.attached).toBe(1);
    opened.ws.close();
    await settle(() => registry.detached === 1);
    expect(session.viewers.size).toBe(0);
  });
});

describe("the lease and the session's end", () => {
  it("closes every viewer 4005 when the worker loses the lease", async () => {
    const opened = await open(ticket());
    await prove(opened);
    registry.fire(sessionId, "lease_lost");
    expect(await opened.closed).toBe(4005);
    expect(opened.frames.find((frame) => frame.t === "error")).toMatchObject({ code: "lease_lost" });
  });

  it("closes every viewer 1000 when the person ended the session", async () => {
    const opened = await open(ticket());
    await prove(opened);
    registry.fire(sessionId, "ended");
    expect(await opened.closed).toBe(1000);
    expect(opened.frames.find((frame) => frame.t === "error")).toMatchObject({ code: "ended" });
  });

  it("refuses the upgrade when the session has ended under the ticket", async () => {
    registry.outcome = { kind: "refused", reason: "ended" };
    const { status } = await open(ticket());
    expect(status).toBe(404);
  });

  it("refuses with 409 when a sibling took the session between redemption and claim", async () => {
    registry.outcome = { kind: "refused", reason: "held_elsewhere" };
    const { status } = await open(ticket());
    expect(status).toBe(409);
  });
});

describe("the in-fleet hop", () => {
  it("relays to the worker that holds the session, challenge and all", async () => {
    // A second server standing in for the holding worker; the first only has
    // the private address control handed it.
    const holderSession = new FakeSession(sessionId, USER_A, SPACE);
    const holderRegistry = new FakeRegistry(holderSession);
    const holder = new ShellSocketServer({
      control: new ControlClient({ baseUrl: fake.baseUrl, serviceToken: fake.serviceToken }),
      registry: holderRegistry,
      browserUrl: BROWSER_URL,
      serviceToken: fake.serviceToken,
      recheckIntervalMs: 10_000,
      proofTimeoutMs: 2_000,
    });
    const holderServer = createServer((_request, response) => {
      response.statusCode = 404;
      response.end();
    });
    holder.attach(holderServer);
    await new Promise<void>((resolve) => holderServer.listen(0, "127.0.0.1", resolve));
    const holderUrl = `http://127.0.0.1:${String((holderServer.address() as AddressInfo).port)}`;
    registry.outcome = { kind: "relay", workerUrl: holderUrl };

    const opened = await open(ticket());
    expect(opened.status).toBeNull();
    await settle(() => opened.frames.length >= 1);
    expect(opened.frames[0]).toMatchObject({ t: "challenge", spaceId: SPACE });
    const nonce = opened.frames[0]?.["nonce"] as string;
    opened.ws.send(JSON.stringify({ t: "auth", proof: await shellProof(SPACE, sessionId, nonce) }));
    await settle(() => opened.frames.some((frame) => frame.t === "ready"));
    // The proof was opened by the HOLDER, end to end through the hop.
    expect(holderSession.viewers.size).toBe(1);
    expect(session.viewers.size).toBe(0);

    opened.ws.close();
    await holder.close();
    holderServer.closeAllConnections();
    await new Promise<void>((resolve) => holderServer.close(() => resolve()));
  });

  it("refuses the internal path without the service bearer", async () => {
    const url = `${baseUrl}/v1/internal/shell/${sessionId}?userId=${USER_A}&deviceId=${device.id}&platform=web`;
    const ws = new WebSocket(url, { headers: { authorization: "Bearer nope" } });
    const status = await new Promise<number>((resolve) => {
      ws.once("unexpected-response", (_request, response) => {
        resolve(response.statusCode ?? 0);
        response.resume();
      });
      ws.once("open", () => resolve(0));
      ws.once("error", () => resolve(-1));
    });
    expect(status).toBe(401);
  });

  it("never relays onward from the internal path", async () => {
    registry.outcome = { kind: "relay", workerUrl: "http://127.0.0.1:1" };
    const url = `${baseUrl}/v1/internal/shell/${sessionId}?userId=${USER_A}&deviceId=${device.id}&platform=web`;
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${fake.serviceToken}` } });
    const status = await new Promise<number>((resolve) => {
      ws.once("unexpected-response", (_request, response) => {
        resolve(response.statusCode ?? 0);
        response.resume();
      });
      ws.once("open", () => resolve(0));
      ws.once("error", () => resolve(-1));
    });
    expect(status).toBe(404);
  });
});

/* ------------------------- adversarial review fixes ------------------------ */

describe("what an unproven socket may cost the worker", () => {
  it("is closed rather than parsed when it sends more than a proof", async () => {
    const opened = await open(ticket());
    await settle(() => opened.frames.length >= 1);
    // Sessions of DIFFERENT users share this process. Before the proof the
    // only thing a viewer may send is `{t:'auth', proof}`, and the frame used
    // to be stringified and JSON-parsed whole before the `proved` check ran.
    opened.ws.send(JSON.stringify({ t: "auth", proof: "x".repeat(64 * 1024) }));
    expect(await opened.closed).toBe(4004);
  });

  it("refuses a frame larger than any call could honestly be", async () => {
    const opened = await open(ticket());
    await prove(opened);
    const before = opened.frames.length;
    // `ws`'s own 100 MiB default is not a policy; 48 MiB is the upload ceiling
    // plus base64 and the envelope around it.
    opened.ws.send(JSON.stringify({ t: "call", id: "big", method: "getSnapshot", args: ["x".repeat(60 * 1024 * 1024)] }));
    await settle(() => opened.ws.readyState === opened.ws.CLOSED || opened.frames.length > before, { turns: 200 });
    expect(opened.frames.filter((frame) => frame.t === "reply" && frame["id"] === "big")).toHaveLength(0);
  });
});

describe("the RPC envelope", () => {
  it("bounds the argument list rather than passing whatever arrived", async () => {
    const opened = await open(ticket());
    await prove(opened);
    opened.frames.length = 0;
    opened.ws.send(
      JSON.stringify({ t: "call", id: "wide", method: "getSnapshot", args: [1, 2, 3, 4, 5, 6, 7, 8, 9] }),
    );
    // A frame that is not a call this build can make sense of is dropped, and
    // the socket stays up: a shell built against a newer host must degrade to
    // a disabled button, not a dead connection.
    opened.ws.send(JSON.stringify({ t: "call", id: "narrow", method: "getSnapshot", args: [] }));
    await settle(() => opened.frames.some((frame) => frame["id"] === "narrow"));
    expect(opened.frames.some((frame) => frame["id"] === "wide")).toBe(false);
    expect(opened.ws.readyState).toBe(opened.ws.OPEN);
  });
});

describe("a viewer that is not draining", () => {
  it("has its events dropped rather than making the worker buffer without bound", () => {
    // Frames already had this; events did not, and a PAGE drives them — a
    // clipboard mirror is up to a megabyte and the page decides when to copy.
    expect(mayQueueEvent(0)).toBe(true);
    expect(mayQueueEvent(MAX_BUFFERED_EVENT_BYTES)).toBe(true);
    expect(mayQueueEvent(MAX_BUFFERED_EVENT_BYTES + 1)).toBe(false);
  });
});

describe("the download route", () => {
  const httpBase = (): string => baseUrl.replace("ws://", "http://");

  it("answers the preflight the pane's fetch needs, for the browser app's origin and no other", async () => {
    const url = `${httpBase()}/v1/shell/${sessionId}/downloads/d1`;
    const preflight = await fetch(url, {
      method: "OPTIONS",
      headers: { origin: BROWSER_URL, "access-control-request-method": "GET", "access-control-request-headers": "x-pistachio-download-key" },
    });
    expect(preflight.status).toBe(204);
    // Never `*`: a URL that leaked would otherwise be readable by any page.
    expect(preflight.headers.get("access-control-allow-origin")).toBe(BROWSER_URL);
    expect(preflight.headers.get("access-control-allow-headers")).toBe("x-pistachio-download-key");
    expect(preflight.headers.get("vary")).toBe("Origin");

    const foreign = await fetch(url, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "GET" },
    });
    expect(foreign.status).toBe(403);

    // Including www: a download belongs to the pane that asked for it, and
    // the pane only ever exists on the browser app (§15).
    const site = await fetch(url, {
      method: "OPTIONS",
      headers: { origin: WWW_URL, "access-control-request-method": "GET" },
    });
    expect(site.status).toBe(403);
    expect(site.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("refuses a GET from another origin, and one with no viewer key at all", async () => {
    const url = `${httpBase()}/v1/shell/${sessionId}/downloads/d1?access_token=pdl_whatever`;
    expect((await fetch(url, { headers: { origin: "https://evil.example" } })).status).toBe(403);
    // The token in the address is half the credential; the viewer's own key
    // is the other half, and only the socket it was issued to holds one.
    const answered = await fetch(url, { headers: { origin: BROWSER_URL } });
    expect(answered.status).toBe(404);
    expect(answered.headers.get("access-control-allow-origin")).toBe(BROWSER_URL);

    // www gets the same 403 the preflight gave it, and no allow-origin.
    const site = await fetch(url, { headers: { origin: WWW_URL } });
    expect(site.status).toBe(403);
    expect(site.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("a pane whose tab has gone", () => {
  it("still stops its screencast when the client releases it", async () => {
    const opened = await open(ticket());
    await prove(opened);
    opened.ws.send(JSON.stringify({ t: "pane", tabId: "web:1", width: 400, height: 300, dpr: 1, visible: true }));
    await settle(() => session.cdpCalls.includes("Page.startScreencast"), { turns: 400 });

    // The host forgets a closed or suspended tab, and the pane's release
    // arrives afterwards. Bailing on "unknown tab" BEFORE handling
    // `visible: false` leaked the screencast and its entry in `viewer.panes`
    // every single time a tab was closed.
    session.tabs.delete("web:1");
    session.cdpCalls.length = 0;
    opened.ws.send(JSON.stringify({ t: "pane", tabId: "web:1", width: 400, height: 300, dpr: 1, visible: false }));
    await settle(() => session.cdpCalls.includes("Page.stopScreencast"), { turns: 400 });
    expect(session.cdpCalls).toContain("Page.stopScreencast");
  });
});

describe("linked viewers", () => {
  it.each(["null", "file://", "pistachio-app://shell", "http://localhost:5173"])("accepts native origin %s only with a desktop ticket", async origin => {
    expect((await open(ticket(), "query", sessionId, origin)).status).toBe(403);
    const desktop = await fake.addDesktop(USER_A);
    const token = fake.mintSessionTicket({ userId: USER_A, deviceId: desktop.id, sessionId, platform: "macos" });
    const native = await open(token, "query", sessionId, origin);
    expect(native.status).toBeNull();
    await prove(native);
    expect(native.frames.some(frame => frame.t === "ready")).toBe(true);
    native.ws.close();
  });

  it("fences a controller action waiting on an asynchronous browser operation", async () => {
    const first = await open(ticket()); await prove(first);
    const second = await open(ticket()); await prove(second);
    first.ws.send(JSON.stringify({ t: "link", action: "enable", generation: 0 }));
    await settle(() => first.frames.some(frame => frame.t === "linked" && (frame["state"] as { enabled: boolean }).enabled));
    let resume!: () => void;
    let entered = false;
    let changed = false;
    const barrier = new Promise<void>(resolve => { resume = resolve; });
    session.host.createTab = async () => {
      entered = true;
      await barrier;
      checkActionFence();
      changed = true;
    };
    first.ws.send(JSON.stringify({ t: "call", id: "waiting", method: "createTab", args: [], viewGeneration: 1 }));
    await settle(() => entered);
    second.ws.send(JSON.stringify({ t: "link", action: "take-control", generation: 1 }));
    await settle(() => first.frames.some(frame => frame.t === "linked" && (frame["state"] as { generation: number }).generation === 2));
    resume();
    await settle(() => first.frames.some(frame => frame["id"] === "waiting"));
    expect(changed).toBe(false);
    expect(first.frames.find(frame => frame["id"] === "waiting")?.["ok"]).toBe(false);
    first.ws.close(); second.ws.close();
  });

  it("lets a follower read the person's notes and refuses every note request that writes", async () => {
    const first = await open(ticket()); await prove(first);
    const second = await open(ticket()); await prove(second);
    first.ws.send(JSON.stringify({ t: "link", action: "enable", generation: 0 }));
    await settle(() => second.frames.some(frame => frame.t === "linked" && (frame["state"] as { enabled: boolean }).enabled));
    // `notes` carries its verb in the request, not in the method name, so the
    // wheel is decided from the arguments (docs/notes.md §7).
    second.ws.send(JSON.stringify({ t: "call", id: "read", method: "notes", args: [{ type: "list" }], viewGeneration: 1 }));
    second.ws.send(JSON.stringify({ t: "call", id: "write", method: "notes", args: [{ type: "create" }], viewGeneration: 1 }));
    second.ws.send(JSON.stringify({ t: "call", id: "publish", method: "notes", args: [{ type: "setVisibility", id: "0123456789ab", visibility: "public" }], viewGeneration: 1 }));
    // Naming a tab is a change to what everyone looking at it sees.
    second.ws.send(JSON.stringify({ t: "call", id: "rename", method: "setTabTitle", args: ["web:1", "Pie crust"], viewGeneration: 1 }));
    await settle(() => ["read", "write", "publish", "rename"].every(id => second.frames.some(frame => frame.t === "reply" && frame["id"] === id)));
    expect(second.frames.find(frame => frame["id"] === "read")?.["ok"]).toBe(true);
    for (const id of ["write", "publish", "rename"]) {
      const reply = second.frames.find(frame => frame["id"] === id);
      expect(reply?.["ok"], id).toBe(false);
      expect((reply?.["error"] as { message: string }).message, id).toMatch(/Take control/u);
    }
    // Only the read ever reached the host.
    expect(session.calls.filter(call => call.method === "notes")).toHaveLength(1);
    first.ws.close(); second.ws.close();
  });

  it("rejects follower mutations and stale input while allowing reads and fenced handoff", async () => {
    const first = await open(ticket()); await prove(first);
    const second = await open(ticket()); await prove(second);
    first.ws.send(JSON.stringify({ t: "link", action: "enable", generation: 0 }));
    await settle(() => second.frames.some(frame => frame.t === "linked" && (frame["state"] as { enabled: boolean }).enabled));
    second.ws.send(JSON.stringify({ t: "call", id: "blocked", method: "createTab", args: ["https://example.test"], viewGeneration: 1 }));
    second.ws.send(JSON.stringify({ t: "call", id: "read", method: "getSnapshot", args: [], viewGeneration: 1 }));
    await settle(() => second.frames.some(frame => frame.t === "reply" && frame["id"] === "read"));
    expect(second.frames.find(frame => frame["id"] === "blocked")?.["ok"]).toBe(false);
    expect(second.frames.find(frame => frame["id"] === "read")?.["ok"]).toBe(true);
    expect(session.calls.some(call => call.method === "createTab")).toBe(false);
    const input = { t: "input", tabId: "web:1", generation: 3, viewGeneration: 1, event: { kind: "mouse", type: "mouseMoved", x: 20, y: 20, button: "none", clickCount: 0, modifiers: 0 } };
    second.ws.send(JSON.stringify(input));
    second.ws.send(JSON.stringify({ t: "link", action: "take-control", generation: 1 }));
    await settle(() => first.frames.some(frame => frame.t === "linked" && (frame["state"] as { generation: number }).generation === 2));
    first.ws.send(JSON.stringify(input));
    second.ws.send(JSON.stringify({ ...input, viewGeneration: 2 }));
    await settle(() => session.cdpCalls.includes("Input.dispatchMouseEvent"));
    expect(session.cdpCalls.filter(method => method === "Input.dispatchMouseEvent")).toHaveLength(1);
    second.ws.close();
    await second.closed;
    await settle(() => first.frames.some(frame => frame.t === "linked" && (frame["state"] as { generation: number }).generation === 3));
    first.ws.close();
  });
});
