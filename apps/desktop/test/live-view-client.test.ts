/**
 * LiveViewClient (docs/cloud-sync-design.md §8.5, §10.4): the socket dials
 * the worker control named, with control's one-minute ticket as
 * `?access_token=`, frames are relayed
 * to the shell, input goes out only while the person holds control, a 4003
 * close means "device revoked" with no reconnect, and any other drop
 * re-dials until the person closes the view.
 */

import { describe, expect, it } from "vitest";
import { CLOSE_REVOKED, LiveViewClient, liveViewUrl, type LiveSocketEvent, type LiveSocketLike } from "../src/main/cloud/live-view-client";
import type { CloudFrame } from "@pistachio/shell-contracts/ipc";

class FakeSocket implements LiveSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  readonly closes: Array<{ code: number | undefined; reason: string | undefined }> = [];
  readonly #listeners = new Map<string, Array<(event: LiveSocketEvent) => void>>();

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.readyState = 3;
  }

  addEventListener(type: string, listener: (event: LiveSocketEvent) => void): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  emit(type: string, event: LiveSocketEvent = {}): void {
    if (type === "open") this.readyState = 1;
    if (type === "close") this.readyState = 3;
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }

  message(frame: unknown): void {
    this.emit("message", { data: JSON.stringify(frame) });
  }
}

interface Harness {
  client: LiveViewClient;
  sockets: FakeSocket[];
  frames: CloudFrame[];
  statusChanges: number;
  /** What control's live-ticket route answers with; null means "not watchable". */
  ticket: { url: string; ticket: string } | null;
  /** Whether this Mac can open the run's Space, and so answer the challenge. */
  spaceKey: boolean;
}

function harness(options: { ticket?: { url: string; ticket: string } | null; spaceKey?: boolean } = {}): Harness {
  const h: Harness = {
    client: undefined as unknown as LiveViewClient,
    sockets: [],
    frames: [],
    statusChanges: 0,
    ticket:
      options.ticket === undefined ? { url: "https://runner.example/", ticket: "live-ticket" } : options.ticket,
    spaceKey: options.spaceKey ?? true,
  };
  h.client = new LiveViewClient({
    ticket: async () => h.ticket,
    proveSpaceKey: async (_spaceId, _runId, nonce) => (h.spaceKey ? `proof:${nonce}` : null),
    publishFrame: (frame) => h.frames.push(frame),
    onStatusChanged: () => {
      h.statusChanges += 1;
    },
    socketFactory: (url) => {
      const socket = new FakeSocket(url);
      h.sockets.push(socket);
      return socket;
    },
    reconnectDelayMs: 5,
    maxReconnects: 2,
  });
  return h;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Dial and complete the handshake. */
async function opened(h: Harness, runId = "run-1"): Promise<FakeSocket> {
  const pending = h.client.open(runId);
  await sleep(0);
  const socket = h.sockets.at(-1)!;
  socket.emit("open");
  await pending;
  return socket;
}

describe("dialing", () => {
  it("dials the worker control named, with control's ticket as access_token", async () => {
    const h = harness();
    const socket = await opened(h, "run 1");
    expect(socket.url).toBe("wss://runner.example/v1/live/run%201?access_token=live-ticket");
    expect(h.client.status()).toEqual({ liveRunId: "run 1", liveState: "open", liveError: null, liveControl: null, liveStatus: null, liveTabs: [], liveActiveTabId: null });
    expect(liveViewUrl("http://localhost:8791", "r", "t")).toBe("ws://localhost:8791/v1/live/r?access_token=t");
    expect(liveViewUrl("wss://already.example", "r", "t")).toBe("wss://already.example/v1/live/r?access_token=t");
  });

  it("fails without a ticket instead of dialing", async () => {
    const h = harness({ ticket: null });
    expect(await h.client.open("run-1")).toMatchObject({
      liveState: "error",
      liveError: expect.stringMatching(/cannot be watched/),
    });
    expect(h.sockets).toHaveLength(0);
  });

  it("re-asks for a ticket on every dial, so a re-claimed run follows its new worker", async () => {
    const h = harness();
    const first = await opened(h, "run-1");
    h.ticket = { url: "https://runner-7.example", ticket: "second" };
    first.emit("close", { code: 1006 });
    await sleep(20);
    expect(h.sockets.at(-1)!.url).toBe("wss://runner-7.example/v1/live/run-1?access_token=second");
  });

  it("settles a dial that a second open() superseded, so the IPC caller is never left hanging", async () => {
    const h = harness();
    // The first dial never sees its socket open: open() tears it down and
    // bumps the generation, so its own listeners are all guarded out.
    const first = h.client.open("run-1");
    await sleep(0);
    let firstSettled = false;
    void first.then(() => {
      firstSettled = true;
    });
    const second = h.client.open("run-2");
    await sleep(0);
    h.sockets.at(-1)!.emit("open");
    await second;
    // The superseded socket's own close event arrives late; either way the
    // first caller gets the superseding outcome rather than nothing.
    h.sockets[0]!.emit("close", { code: 1006 });
    expect(await first).toMatchObject({ liveRunId: "run-2" });
    expect(firstSettled).toBe(true);
  });

  it("settles a dial that close() superseded", async () => {
    const h = harness();
    const pending = h.client.open("run-1");
    await sleep(0);
    await h.client.close();
    expect(await pending).toMatchObject({ liveRunId: null, liveState: "closed" });
  });

  it("closes the previous socket when another run is opened, and on close()", async () => {
    const h = harness();
    const first = await opened(h, "run-1");
    const second = await opened(h, "run-2");
    expect(first.closes).toEqual([{ code: 1000, reason: "closed" }]);
    expect(h.client.status().liveRunId).toBe("run-2");
    await h.client.close();
    expect(second.closes).toEqual([{ code: 1000, reason: "closed" }]);
    expect(h.client.status()).toMatchObject({ liveRunId: null, liveState: "closed", liveError: null });
    // The socket's own close event after ours changes nothing and dials nothing.
    second.emit("close", { code: 1005, reason: "" });
    await sleep(20);
    expect(h.sockets).toHaveLength(2);
    expect(h.client.status().liveState).toBe("closed");
  });
});

describe("the Space-key challenge", () => {
  it("answers the runner's challenge with the sealed nonce", async () => {
    const h = harness();
    const socket = await opened(h);
    socket.message({ t: "challenge", spaceId: "work", nonce: "n0nce" });
    await sleep(0);
    expect(socket.sent.map((raw) => JSON.parse(raw) as unknown)).toEqual([{ t: "auth", proof: "proof:n0nce" }]);
  });

  it("says so rather than dialling on when this Mac cannot open the Space", async () => {
    const h = harness({ spaceKey: false });
    const socket = await opened(h);
    socket.message({ t: "challenge", spaceId: "other", nonce: "n0nce" });
    await sleep(0);
    expect(socket.sent).toEqual([]);
    expect(h.client.status()).toMatchObject({ liveState: "error", liveError: expect.stringMatching(/cannot open/) });
  });
});

describe("frames and status", () => {
  it("relays whole frames with the run id, and drops malformed ones entirely", async () => {
    const h = harness();
    const socket = await opened(h);
    socket.message({ t: "frame", data: "AAAA", width: 1280, height: 800, metadata: { deviceWidth: 1280, deviceHeight: 800, pageScaleFactor: 1, scrollOffsetX: 0, scrollOffsetY: 120 } });
    // A frame that does not match the schema is not repaired into one. Half a
    // frame is a picture drawn at the wrong size — worse than no picture, and
    // impossible to notice.
    socket.message({ t: "frame", data: "BBBB", width: "x", height: 1, metadata: null });
    socket.message({ t: "frame", data: 42 });
    socket.message("not json at all");
    expect(h.frames).toEqual([
      { runId: "run-1", data: "AAAA", width: 1280, height: 800, metadata: { deviceWidth: 1280, deviceHeight: 800, pageScaleFactor: 1, scrollOffsetX: 0, scrollOffsetY: 120 } },
    ]);
  });

  it("tracks tabs and who holds control", async () => {
    const h = harness();
    const socket = await opened(h);
    // A tabs frame carrying a tab this build cannot read is dropped whole, so
    // the strip keeps the last list it understood rather than half of one.
    socket.message({ t: "tabs", tabs: [{ nope: true }], activeTabId: "cloud:1" });
    expect(h.client.status().liveTabs).toEqual([]);
    socket.message({ t: "tabs", tabs: [{ id: "cloud:1", spaceId: "work", title: "Shop", url: "https://shop.example/", loading: false, canGoBack: true, canGoForward: false, kind: "agent" }], activeTabId: "cloud:1" });
    socket.message({ t: "status", status: "human_control", control: "human" });
    expect(h.client.status()).toMatchObject({
      liveControl: "human",
      liveStatus: "human_control",
      liveActiveTabId: "cloud:1",
      liveTabs: [{ id: "cloud:1", spaceId: "work", title: "Shop", url: "https://shop.example/", loading: false, canGoBack: true, canGoForward: false, kind: "agent" }],
    });
    expect(h.client.runStatus()).toBe("human_control");
  });

  it("surfaces a runner error and stays closed when the run has ended", async () => {
    const h = harness();
    const socket = await opened(h);
    socket.message({ t: "error", code: "ended", message: "the run has ended" });
    socket.emit("close", { code: 1000, reason: "" });
    await sleep(20);
    expect(h.client.status()).toMatchObject({ liveState: "error", liveError: "the run has ended" });
    expect(h.sockets).toHaveLength(1);
  });
});

describe("input", () => {
  it("forwards input only while open and under human control; focus always goes through", async () => {
    const h = harness();
    const mouse = { t: "input" as const, event: { kind: "mouse" as const, type: "mousePressed" as const, x: 10, y: 20, button: "left" as const, clickCount: 1, modifiers: 0 } };
    h.client.input(mouse);
    const socket = await opened(h);
    h.client.input(mouse);
    expect(socket.sent).toEqual([]);
    h.client.input({ t: "focus", tabId: "cloud:1" });
    socket.message({ t: "status", status: "human_control", control: "human" });
    h.client.input(mouse);
    h.client.input({ t: "input", event: { kind: "key", type: "keyDown", key: "a", code: "KeyA", modifiers: 0 } });
    socket.message({ t: "status", status: "running", control: "agent" });
    h.client.input(mouse);
    expect(socket.sent.map((data) => JSON.parse(data))).toEqual([
      { t: "focus", tabId: "cloud:1" },
      mouse,
      { t: "input", event: { kind: "key", type: "keyDown", key: "a", code: "KeyA", modifiers: 0 } },
    ]);
  });
});

describe("closing", () => {
  it("4003 means the device was revoked: no reconnect, and it says so", async () => {
    const h = harness();
    const socket = await opened(h);
    socket.emit("close", { code: CLOSE_REVOKED, reason: "revoked" });
    await sleep(30);
    expect(h.client.status()).toMatchObject({ liveRunId: "run-1", liveState: "revoked", liveError: "device revoked" });
    expect(h.sockets).toHaveLength(1);
    // Input after revocation goes nowhere.
    h.client.input({ t: "focus", tabId: "cloud:1" });
    expect(socket.sent).toEqual([]);
  });

  it("re-dials after an unexpected drop, then gives up after the cap", async () => {
    const h = harness();
    const socket = await opened(h);
    socket.emit("close", { code: 1006, reason: "" });
    expect(h.client.status().liveState).toBe("connecting");
    await sleep(20);
    expect(h.sockets).toHaveLength(2);
    h.sockets[1]!.emit("open");
    expect(h.client.status().liveState).toBe("open");
    h.sockets[1]!.emit("close", { code: 1006, reason: "" });
    await sleep(20);
    h.sockets[2]!.emit("close", { code: 1006, reason: "" });
    await sleep(40);
    h.sockets[3]?.emit("close", { code: 1006, reason: "" });
    await sleep(60);
    expect(h.client.status()).toMatchObject({ liveState: "error", liveError: expect.stringMatching(/lost/) });
    expect(h.sockets.length).toBeLessThanOrEqual(4);
  });
});
