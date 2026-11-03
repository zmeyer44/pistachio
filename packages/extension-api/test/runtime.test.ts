import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtRuntimeInfo } from "../src/api-types.js";
import { buildPistachio, PISTACHIO_WIRE_KEY, PORT_HANDOFF_KEY, type PistachioWire } from "../src/runtime.js";
import { EXT_HANDLER_TIMEOUTS, type ExtEventMessage, type ExtReply } from "../src/wire.js";

// The runtime is the `pistachio` an extension's code holds (src/runtime.ts). These run it over a
// fake wire — the preload's `__pistachioWire` — in Node, which has the web's MessageChannel,
// EventTarget, AbortController, Blob, TextDecoder and atob.

const INFO: ExtRuntimeInfo = { id: "dev.test.ext", manifest: { api: 1, id: "dev.test.ext", name: "Test", version: "1.0.0" }, context: "worker", page: null, timeOrigin: 0 };

type Answer = (args: never) => ExtReply | Promise<ExtReply>;
const ok = (v: unknown): ExtReply => ({ ok: true, v });
const settle = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(answers: Record<string, Answer> = {}, options: { build?: typeof buildPistachio } = {}) {
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  const logs: unknown[][] = [];
  let listener: ((message: ExtEventMessage) => void) | null = null;
  const wire: PistachioWire = {
    async call(method, args) {
      calls.push({ method, args: args as Record<string, unknown> });
      const answer = answers[method];
      if (answer !== undefined) return answer(args as never);
      if (method === "runtime.info") return ok(INFO);
      if (method === "events.on") return ok({ subscriptionId: calls.length });
      return ok(null);
    },
    onEvent(fn) {
      listener = fn;
      return () => {
        listener = null;
      };
    },
    log(...args) {
      logs.push(args);
    },
  };
  const api = (options.build ?? buildPistachio)({ install: false, wire, timeouts: EXT_HANDLER_TIMEOUTS });
  if (api === null) throw new Error("no api");
  // The runtime implements pistachio.d.ts: this assignment is the type check.
  const typed: Pistachio.Api = api;
  return {
    api: typed,
    calls,
    logs,
    emit: (message: ExtEventMessage) => listener?.(message),
    argsOf: (method: string) => calls.filter((call) => call.method === method).map((call) => call.args),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("calls", () => {
  it("answer the reply's value, and fail with an ExtError that keeps its code", async () => {
    const { api, argsOf } = harness({
      "tabs.query": () => ok([{ id: "t1" }]),
      "tabs.get": () => ({ ok: false, code: "NOT_FOUND", message: "no tab t9" }),
    });
    expect(await api.tabs.query({ active: true })).toEqual([{ id: "t1" }]);
    expect(argsOf("tabs.query")).toEqual([{ active: true }]);
    const error = await api.tabs.get("t9").catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: "ExtError", code: "NOT_FOUND", message: "no tab t9" });
  });

  it("wait for runtime.info; id, manifest and context throw until then", async () => {
    const info = deferred<ExtReply>();
    const { api, calls } = harness({ "runtime.info": () => info.promise });
    expect(() => api.runtime.id).toThrow(/await pistachio\.runtime\.ready/);
    expect(() => api.files.data.url("a.txt")).toThrow(/await pistachio\.runtime\.ready/);
    const tabs = api.tabs.query();
    await settle();
    expect(calls.map((call) => call.method)).toEqual(["runtime.info"]);
    info.resolve(ok(INFO));
    await tabs;
    await api.runtime.ready;
    expect(calls.map((call) => call.method)).toEqual(["runtime.info", "tabs.query"]);
    expect([api.runtime.id, api.runtime.context, api.runtime.manifest.name]).toEqual(["dev.test.ext", "worker", "Test"]);
    expect(api.files.data.url("rec/a b.mp4")).toBe("pistachio-ext://dev.test.ext/__data__/rec/a%20b.mp4");
    expect(() => api.files.data.url("../secrets")).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });

  it("all fail with main's refusal when runtime.info is refused", async () => {
    const { api } = harness({ "runtime.info": () => ({ ok: false, code: "PERMISSION_DENIED", message: "not an extension's page" }) });
    await expect(api.runtime.ready).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(api.storage.local.get()).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(() => api.runtime.id).toThrow("not an extension's page");
  });

  it("shape their arguments and results as pistachio.d.ts says", async () => {
    const { api, argsOf } = harness({
      "storage.get": () => ok({ a: 1 }),
      "settings.get": () => ok({ fps: "60", theme: "dark" }),
      "ui.openPage": () => ok({ tabId: "t7" }),
      "pages.read": () => ok({ text: "# Hi" }),
      "pages.screenshot": () => ok({ png: new Uint8Array([137, 80]).buffer }),
      "runtime.keepAlive": () => ok({ holdId: 3 }),
    });
    expect(await api.storage.local.get("a")).toEqual({ a: 1 });
    await api.storage.local.get();
    await api.storage.local.remove("a");
    expect(argsOf("storage.get")).toEqual([{ keys: ["a"] }, { keys: null }]);
    expect(argsOf("storage.remove")).toEqual([{ keys: ["a"] }]);
    expect(await api.settings.get("fps")).toBe("60");
    expect(await api.settings.getAll()).toEqual({ fps: "60", theme: "dark" });
    expect(argsOf("settings.get")).toEqual([{ key: "fps" }, { key: null }]);
    expect(await api.ui.openPage("editor", { query: "rec=1" })).toBe("t7");
    expect(argsOf("ui.openPage")).toEqual([{ name: "editor", query: "rec=1" }]);
    expect(await api.pages.read("t1")).toBe("# Hi");
    expect(argsOf("pages.read")).toEqual([{ tabId: "t1", format: "text" }]);
    const png = await api.pages.screenshot("t1");
    expect(png.type).toBe("image/png");
    expect([...new Uint8Array(await png.arrayBuffer())]).toEqual([137, 80]);
    const release = await api.runtime.keepAlive("recording");
    release();
    release();
    await settle();
    expect(argsOf("runtime.release")).toEqual([{ holdId: 3 }]);
  });

  it("net.fetch decodes the body main sends as base64", async () => {
    const body = Buffer.from(JSON.stringify({ login: "ada", emoji: "🌰" })).toString("base64");
    const { api, argsOf } = harness({ "net.fetch": () => ok({ status: 200, headers: { "content-type": "application/json" }, body }) });
    const response = await api.net.fetch("https://api.github.com/user", { method: "POST", body: new Uint8Array([1, 2, 3]).subarray(1) });
    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ login: "ada", emoji: "🌰" });
    expect(await response.text()).toBe('{"login":"ada","emoji":"🌰"}');
    expect((await response.arrayBuffer()).byteLength).toBe(Buffer.from(body, "base64").byteLength);
    const sent = argsOf("net.fetch")[0] as { body: ArrayBuffer; method: string };
    expect(sent.method).toBe("POST");
    expect([...new Uint8Array(sent.body)]).toEqual([2, 3]);
  });
});

describe("events", () => {
  it("subscribe with events.on, keep what arrives before the id, and stop with events.off", async () => {
    const reply = deferred<ExtReply>();
    const { api, emit, argsOf } = harness({ "events.on": () => reply.promise });
    const seen: unknown[] = [];
    const off = api.tabs.onCreated((tab) => seen.push(tab.id));
    await settle();
    expect(argsOf("events.on")).toEqual([{ event: "tabs.created" }]);
    emit({ kind: "event", subscription: 12, e: "tabs.created", v: { tab: { id: "early" } } });
    reply.resolve(ok({ subscriptionId: 12 }));
    await settle();
    emit({ kind: "event", subscription: 12, e: "tabs.created", v: { tab: { id: "live" } } });
    emit({ kind: "event", subscription: 99, e: "tabs.created", v: { tab: { id: "someone else's" } } });
    expect(seen).toEqual(["early", "live"]);
    off();
    await settle();
    expect(argsOf("events.off")).toEqual([{ subscriptionId: 12 }]);
    emit({ kind: "event", subscription: 12, e: "tabs.created", v: { tab: { id: "after" } } });
    expect(seen).toEqual(["early", "live"]);
  });

  it("give each listener its own arguments", async () => {
    const { api, emit, argsOf } = harness();
    const seen: unknown[] = [];
    api.tabs.onUpdated((tab, changed) => seen.push([tab.id, changed]));
    api.settings.onChanged((key, value) => seen.push([key, value]));
    await settle();
    const [updated, changed] = argsOf("events.on").map((_, index) => index + 2);
    emit({ kind: "event", subscription: updated ?? 0, e: "tabs.updated", v: { tab: { id: "t1" }, changed: ["title"] } });
    emit({ kind: "event", subscription: changed ?? 0, e: "settings.changed", v: { key: "fps", value: "30" } });
    expect(seen).toEqual([
      ["t1", ["title"]],
      ["fps", "30"],
    ]);
  });
});

describe("invocations", () => {
  it("run the Bar command's handler and answer through runtime.done", async () => {
    const { api, emit, argsOf } = harness();
    api.bar.onCommand("hello", ({ arg }) => ({ openPage: "hello", query: `name=${arg}` }));
    emit({ kind: "invoke", id: 4, invoke: "bar", name: "hello", v: { arg: "Ada", spaceId: null, tabId: "t1", selection: null } });
    emit({ kind: "invoke", id: 5, invoke: "bar", name: "other", v: { arg: "", spaceId: null, tabId: null, selection: null } });
    await settle();
    expect(argsOf("runtime.done")).toEqual([{ id: 4, v: { openPage: "hello", query: "name=Ada" } }]);
  });

  it("hold an invocation until its handler is registered", async () => {
    const { api, emit, argsOf } = harness();
    emit({ kind: "invoke", id: 8, invoke: "tool", name: "word_count", v: { input: { text: "a b c" }, runId: "r1", spaceId: "s1" } });
    await settle();
    expect(argsOf("runtime.done")).toEqual([]);
    let context: Pistachio.ToolContext | null = null;
    api.agent.onToolCall<{ text: string }>("word_count", async ({ text }, ctx) => {
      context = ctx;
      ctx.progress("counting");
      return { words: text.split(" ").length };
    });
    await settle();
    expect(argsOf("runtime.done")).toEqual([{ id: 8, v: { words: 3 } }]);
    expect(context).toMatchObject({ runId: "r1", spaceId: "s1" });
    expect((context as Pistachio.ToolContext | null)?.signal).toBeInstanceOf(AbortSignal);
  });

  it("answer a handler's throw as the step's error, and a non-JSON answer as one too", async () => {
    const { api, emit, argsOf } = harness();
    api.agent.onToolCall("broken", async () => {
      throw new Error("no such repository");
    });
    api.agent.onToolCall("odd", async () => (() => 1) as never);
    emit({ kind: "invoke", id: 1, invoke: "tool", name: "broken", v: { input: {}, runId: "r", spaceId: null } });
    emit({ kind: "invoke", id: 2, invoke: "tool", name: "odd", v: { input: {}, runId: "r", spaceId: null } });
    await settle();
    expect(argsOf("runtime.done")).toEqual([
      { id: 1, error: "no such repository" },
      { id: 2, error: expect.stringContaining("not JSON") },
    ]);
  });

  it("say what to add when nothing handles an invocation", async () => {
    vi.useFakeTimers();
    const { emit, argsOf } = harness();
    emit({ kind: "invoke", id: 3, invoke: "bar", name: "prs", v: { arg: "", spaceId: null, tabId: null, selection: null } });
    emit({ kind: "invoke", id: 4, invoke: "installed", name: "", v: { reason: "install" } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(argsOf("runtime.done")).toEqual([]);
    await vi.advanceTimersByTimeAsync(600);
    expect(argsOf("runtime.done")).toEqual([{ id: 3, error: expect.stringContaining('pistachio.bar.onCommand("prs", …)') }, { id: 4 }]);
  });

  it("abort a tool's signal when Pistachio stops waiting", async () => {
    vi.useFakeTimers();
    const { api, emit } = harness();
    let signal: AbortSignal | null = null;
    api.agent.onToolCall("slow", (_input, ctx) => {
      signal = ctx.signal;
      return new Promise(() => undefined);
    });
    emit({ kind: "invoke", id: 1, invoke: "tool", name: "slow", v: { input: {}, runId: "r", spaceId: null } });
    await vi.advanceTimersByTimeAsync(29_000);
    expect((signal as AbortSignal | null)?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
  });

  it("send a status, toast or notification action to the handler of its source", async () => {
    const { api, emit } = harness();
    const seen: string[] = [];
    api.ui.onStatusAction((action) => seen.push(`status:${action}`));
    api.ui.onToastAction((action) => seen.push(`toast:${action}`));
    api.notifications.onAction((action) => seen.push(`notification:${action}`));
    emit({ kind: "invoke", id: 1, invoke: "statusAction", name: "undo", v: { action: "undo", source: "toast" } });
    emit({ kind: "invoke", id: 2, invoke: "statusAction", name: "stop", v: { action: "stop", source: "status" } });
    await settle();
    expect(seen).toEqual(["toast:undo", "status:stop"]);
  });

  it("answer runtime.onMessage, from an invocation or a runtime.message event with a reply id", async () => {
    const { api, emit, argsOf } = harness();
    const seen: unknown[] = [];
    api.runtime.onMessage((message, from) => {
      seen.push([message, from]);
      return { pong: message };
    });
    emit({ kind: "invoke", id: 6, invoke: "message", name: "", v: { message: "a", from: "panel" } });
    emit({ kind: "event", subscription: 0, e: "runtime.message", v: { message: "b", from: "page", replyId: 7 } });
    emit({ kind: "event", subscription: 0, e: "runtime.message", v: { message: "c", from: "worker", replyId: null } });
    await settle();
    expect(seen).toEqual([
      ["a", "panel"],
      ["b", "page"],
      ["c", "worker"],
    ]);
    expect(argsOf("runtime.done")).toEqual([
      { id: 6, v: { pong: "a" } },
      { id: 7, v: { pong: "b" } },
    ]);
  });
});

describe("ports", () => {
  const handOff = (win: EventTarget, portId: number, port: MessagePort): void => {
    const event = new Event("message");
    Object.defineProperties(event, { data: { value: { [PORT_HANDOFF_KEY]: portId } }, source: { value: win }, ports: { value: [port] } });
    win.dispatchEvent(event);
  };

  it("register a page's onMessage with main as a runtime.message subscription, and let it go with the listener", async () => {
    const { api, argsOf, emit } = harness({ "events.on": () => ok({ subscriptionId: 42 }) });
    const heard: unknown[] = [];
    const off = api.runtime.onMessage((message) => {
      heard.push(message);
      return { got: message };
    });
    await vi.waitFor(() => expect(argsOf("events.on")).toEqual([{ event: "runtime.message" }]));
    await settle();
    // (Main sends a worker's message only to a view subscribed to runtime.message.)
    emit({ kind: "event", subscription: 42, e: "runtime.message", v: { message: "hi", from: "worker", replyId: 9 } });
    await settle();
    expect(heard).toEqual(["hi"]);
    expect(argsOf("runtime.done")).toEqual([{ id: 9, v: { got: "hi" } }]);
    off();
    await settle();
    expect(argsOf("events.off")).toEqual([{ subscriptionId: 42 }]);
  });

  it("share one runtime.message subscription among a page's listeners, let go with the last", async () => {
    const { api, argsOf } = harness({ "events.on": () => ok({ subscriptionId: 43 }) });
    const offA = api.runtime.onMessage(() => undefined);
    const offB = api.runtime.onMessage(() => undefined);
    await vi.waitFor(() => expect(argsOf("events.on")).toEqual([{ event: "runtime.message" }]));
    await settle();
    offA();
    offA();
    await settle();
    expect(argsOf("events.off")).toEqual([]);
    offB();
    await settle();
    expect(argsOf("events.off")).toEqual([{ subscriptionId: 43 }]);
    // Listening again subscribes again.
    api.runtime.onMessage(() => undefined);
    await settle();
    expect(argsOf("events.on")).toHaveLength(2);
  });

  it("wrap the port main hands over, whichever half arrives first", async () => {
    const win = new EventTarget();
    vi.stubGlobal("window", win);
    const reply = deferred<ExtReply>();
    const { api, emit, argsOf } = harness({ "runtime.info": () => ok({ ...INFO, context: "panel" }), "runtime.connect": () => reply.promise });
    const port = api.runtime.connect("chat");
    port.postMessage({ queued: true });
    const channel = new MessageChannel();
    const received: unknown[] = [];
    channel.port2.onmessage = (event) => received.push(event.data);
    const messages: unknown[] = [];
    let disconnected = 0;
    port.onMessage((message) => messages.push(message));
    port.onDisconnect(() => (disconnected += 1));
    // The port and its event, both before connect's reply.
    handOff(win, 5, channel.port1);
    emit({ kind: "event", subscription: 0, e: "runtime.connect", v: { portId: 5, name: "chat", from: "worker" } });
    await settle();
    expect(argsOf("runtime.connect")).toEqual([{ name: "chat", target: "worker" }]);
    reply.resolve(ok({ portId: 5 }));
    await settle(20);
    expect(received).toEqual([[0, { queued: true }]]);
    channel.port2.postMessage([0, "back"]);
    await settle(20);
    expect(messages).toEqual(["back"]);
    channel.port2.postMessage([1]);
    await settle(20);
    expect(disconnected).toBe(1);
    expect(() => port.postMessage("late")).toThrow(/disconnected/);
    channel.port2.close();
  });

  it("give an arriving port to onConnect, even one that came before the listener", async () => {
    const win = new EventTarget();
    vi.stubGlobal("window", win);
    const { api, emit } = harness();
    await api.runtime.ready;
    const channel = new MessageChannel();
    emit({ kind: "event", subscription: 0, e: "runtime.connect", v: { portId: 9, name: "panel", from: "panel" } });
    handOff(win, 9, channel.port1);
    const names: string[] = [];
    const echoes: unknown[] = [];
    channel.port2.onmessage = (event) => echoes.push(event.data);
    api.runtime.onConnect((port) => {
      names.push(port.name);
      port.onMessage((message) => port.postMessage({ echo: message }));
    });
    channel.port2.postMessage([0, "hi"]);
    await settle(20);
    expect(names).toEqual(["panel"]);
    expect(echoes).toEqual([[0, { echo: "hi" }]]);
    channel.port2.close();
  });

  it("keep a port's messages until its first onMessage: nothing sent before the other end listened is lost", async () => {
    const win = new EventTarget();
    vi.stubGlobal("window", win);
    const { api, emit } = harness();
    await api.runtime.ready;
    const channel = new MessageChannel();
    emit({ kind: "event", subscription: 0, e: "runtime.connect", v: { portId: 11, name: "export", from: "panel" } });
    handOff(win, 11, channel.port1);
    const echoes: unknown[] = [];
    channel.port2.onmessage = (event) => echoes.push(event.data);
    // Sent while the page is still setting up — before it has an onConnect, let alone an onMessage.
    channel.port2.postMessage([0, "first"]);
    await settle(20);
    const taken: ReturnType<typeof api.runtime.connect>[] = [];
    api.runtime.onConnect((port) => taken.push(port));
    await settle(20);
    channel.port2.postMessage([0, "second"]);
    await settle(20);
    // The listener comes later still (an await in the handler): it hears both, in order, and what follows.
    const heard: unknown[] = [];
    const port = taken[0]!;
    port.onMessage((message) => {
      heard.push(message);
      port.postMessage({ echo: message });
    });
    channel.port2.postMessage([0, "third"]);
    await settle(20);
    expect(heard).toEqual(["first", "second", "third"]);
    expect(echoes).toEqual([[0, { echo: "first" }], [0, { echo: "second" }], [0, { echo: "third" }]]);
    channel.port2.close();
  });

  it("refuse a connect from the worker that names no page", async () => {
    const { api, argsOf } = harness();
    let disconnected = false;
    const port = api.runtime.connect();
    port.onDisconnect(() => (disconnected = true));
    await settle();
    expect(disconnected).toBe(true);
    expect(argsOf("runtime.connect")).toEqual([]);
  });
});

describe("files.data", () => {
  it("writes chunks one at a time, in order, copied when written", async () => {
    let active = 0;
    let most = 0;
    const order: number[] = [];
    const { api, argsOf } = harness({
      "files.data.open": () => ok({ handle: 9 }),
      "files.data.write": async (args: { chunk: ArrayBuffer }) => {
        active += 1;
        most = Math.max(most, active);
        await settle(3);
        order.push(...new Uint8Array(args.chunk));
        active -= 1;
        return ok(null);
      },
    });
    const file = await api.files.data.open("rec/screen.mp4", { append: true });
    expect(argsOf("files.data.open")).toEqual([{ path: "rec/screen.mp4", append: true }]);
    const reused = new Uint8Array([1]);
    const first = file.write(reused);
    reused[0] = 99;
    const rest = [file.write(new Uint8Array([2])), file.write(new Uint8Array([7, 3]).subarray(1)), file.write(new Uint8Array([4]).buffer)];
    await Promise.all([first, ...rest]);
    await file.close();
    expect(order).toEqual([1, 2, 3, 4]);
    expect(most).toBe(1);
    expect(argsOf("files.data.write").every((args) => args["handle"] === 9 && args["path"] === null)).toBe(true);
    expect(argsOf("files.data.close")).toEqual([{ handle: 9, abort: false }]);
    await expect(file.write(new Uint8Array([5]))).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("aborts: the write in flight ends, the queued ones are cancelled", async () => {
    const { api, argsOf } = harness({
      "files.data.open": () => ok({ handle: 2 }),
      "files.data.write": async () => {
        await settle(5);
        return ok(null);
      },
    });
    const file = await api.files.data.open("x.bin");
    const inFlight = file.write(new Uint8Array([1]));
    const queued = file.write(new Uint8Array([2]));
    await settle();
    const aborted = file.abort();
    await expect(queued).rejects.toMatchObject({ code: "CANCELLED" });
    await inFlight;
    await aborted;
    expect(argsOf("files.data.write")).toHaveLength(1);
    expect(argsOf("files.data.close")).toEqual([{ handle: 2, abort: true }]);
  });

  it("writes a whole file from text, bytes or a Blob", async () => {
    const { api, argsOf } = harness();
    await api.files.data.write("a.txt", "hé");
    await api.files.data.write("b.bin", new Blob([new Uint8Array([1, 2])]));
    const sent = argsOf("files.data.write").map((args) => [args["path"], [...new Uint8Array(args["chunk"] as ArrayBuffer)]]);
    expect(sent).toEqual([
      ["a.txt", [104, 195, 169]],
      ["b.bin", [1, 2]],
    ]);
  });
});

describe("capture and input", () => {
  class FakeTrack extends EventTarget {
    readyState: "live" | "ended" = "live";
    stop(): void {
      this.readyState = "ended";
    }
  }

  it("capture.tab arms main, then asks getDisplayMedia in this world and answers that very stream", async () => {
    const track = new FakeTrack();
    const stream = { getTracks: () => [track] };
    const getDisplayMedia = vi.fn(async () => stream);
    vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia } });
    const { api, emit, argsOf } = harness({ "capture.arm": () => ok({ width: 2560, height: 1600 }) });
    const answered = await api.capture.tab("t3", { audio: true, scale: 2 });
    expect(answered).toBe(stream);
    expect(argsOf("capture.arm")).toEqual([{ tabId: "t3", audio: true, scale: 2, frameRate: 60 }]);
    expect(getDisplayMedia).toHaveBeenCalledWith({
      video: { width: { ideal: 2560 }, height: { ideal: 1600 }, frameRate: { ideal: 60 } },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 },
    });
    let ended = false;
    track.addEventListener("ended", () => (ended = true));
    emit({ kind: "event", subscription: 0, e: "capture.ended", v: { tabId: "t3", reason: "closed" } });
    expect([track.readyState, ended]).toEqual(["ended", true]);
  });

  it("capture.tab fails as PERMISSION_DENIED when the request is refused", async () => {
    const refusal = Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
    vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia: async () => Promise.reject(refusal) } });
    const { api } = harness({ "capture.arm": () => ok({ width: 1280, height: 800 }) });
    await expect(api.capture.tab("t3")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("input.subscribe fans batches out, keeps what came before its id, and stops", async () => {
    const reply = deferred<ExtReply>();
    const { api, emit, argsOf } = harness({ "input.subscribe": () => reply.promise });
    const pending = api.input.subscribe("t1", ["move", "down"]);
    await settle();
    emit({ kind: "event", subscription: 0, e: "input.event", v: { subscriptionId: 4, events: [{ t: 1, k: "move", x: 1, y: 1 }] } });
    reply.resolve(ok({ subscriptionId: 4 }));
    const subscription = await pending;
    const seen: number[] = [];
    subscription.onEvent((event) => seen.push(event.t));
    await settle();
    emit({ kind: "event", subscription: 0, e: "input.event", v: { subscriptionId: 4, events: [{ t: 2, k: "move", x: 2, y: 2 }, { t: 3, k: "load", loading: false }] } });
    expect(seen).toEqual([1, 2, 3]);
    expect(argsOf("input.subscribe")).toEqual([{ tabId: "t1", kinds: ["move", "down"] }]);
    await subscription.stop();
    expect(argsOf("input.stop")).toEqual([{ subscriptionId: 4 }]);
    emit({ kind: "event", subscription: 0, e: "input.event", v: { subscriptionId: 4, events: [{ t: 4, k: "move", x: 0, y: 0 }] } });
    expect(seen).toEqual([1, 2, 3]);
  });
});

describe("the object", () => {
  it("has exactly the API's namespaces, frozen", () => {
    const { api } = harness();
    expect(Object.keys(api)).toEqual(["runtime", "storage", "settings", "ui", "bar", "contextMenus", "commands", "tabs", "spaces", "desk", "pages", "capture", "input", "files", "clipboard", "notifications", "net", "notes", "agent", "power"]);
    expect(Object.isFrozen(api) && Object.isFrozen(api.tabs) && Object.isFrozen(api.files.data) && Object.isFrozen(api.storage.local)).toBe(true);
    expect(Math.abs(api.runtime.now() - Date.now())).toBeLessThan(1_000);
  });

  it("runs from its source text alone, as executeInMainWorld runs it", async () => {
    const rebuilt = new Function(`return (${buildPistachio.toString()})`)() as typeof buildPistachio;
    const { api } = harness({ "tabs.close": () => ({ ok: false, code: "RATE_LIMITED", message: "slow down" }) }, { build: rebuilt });
    await api.runtime.ready;
    expect(api.runtime.id).toBe("dev.test.ext");
    await expect(api.tabs.close("t1")).rejects.toMatchObject({ name: "ExtError", code: "RATE_LIMITED" });
  });

  it("installs a read-only global over the wire the preload exposed", async () => {
    const methods: string[] = [];
    const wire: PistachioWire = {
      call: async (method) => {
        methods.push(method);
        return method === "runtime.info" ? ok(INFO) : ok(null);
      },
      onEvent: () => () => undefined,
      log: () => undefined,
    };
    vi.stubGlobal(PISTACHIO_WIRE_KEY, wire);
    expect(buildPistachio({ install: true })).toBeNull();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "pistachio");
    expect(descriptor).toMatchObject({ writable: false, configurable: false, enumerable: true });
    const installed = (globalThis as unknown as { pistachio: Pistachio.Api }).pistachio;
    await installed.runtime.ready;
    expect(installed.runtime.id).toBe("dev.test.ext");
    expect(methods).toEqual(["runtime.info"]);
  });
});
