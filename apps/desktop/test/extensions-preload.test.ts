import { afterEach, describe, expect, it, vi } from "vitest";
import type { buildPistachio, PistachioWire } from "@pistachio/extension-api/runtime";
import type { ExtEventMessage, ExtReply } from "@pistachio/extension-api/wire";

// The extension preload (src/preload/extension.ts, docs/extensions.md §4): what it exposes, when
// the wire opens, and how a port reaches the page's world. Electron is faked; the preload runs at
// import, so each test imports it afresh.

const electron = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  executed: [] as { func: (...args: never[]) => unknown; args: unknown[] }[],
  invoke: null as unknown as (channel: string, method: string, args: unknown) => Promise<unknown>,
  listeners: new Map<string, (event: { ports: unknown[] }, message: unknown) => void>(),
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: unknown) => electron.exposed.set(key, api),
    executeInMainWorld: (script: { func: (...args: never[]) => unknown; args: unknown[] }) => {
      electron.executed.push(script);
    },
  },
  ipcRenderer: {
    invoke: (channel: string, method: string, args: unknown) => electron.invoke(channel, method, args),
    on: (channel: string, fn: (event: { ports: unknown[] }, message: unknown) => void) => electron.listeners.set(channel, fn),
  },
}));

const INFO = { id: "dev.test.ext", manifest: { api: 1, id: "dev.test.ext", name: "Test", version: "1.0.0" }, context: "worker", page: null, timeOrigin: 0 };
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function load(options: { origin?: string; protocol?: string; info?: () => Promise<unknown> } = {}) {
  vi.resetModules();
  electron.exposed.clear();
  electron.executed.length = 0;
  electron.listeners.clear();
  const calls: { channel: string; method: string; args: unknown }[] = [];
  electron.invoke = async (channel, method, args) => {
    calls.push({ channel, method, args });
    if (method === "runtime.info") return options.info ? options.info() : { ok: true, v: INFO };
    if (method === "tabs.query") return { ok: true, v: [{ id: "t1" }] };
    if (method === "tabs.create") throw new Error("An object could not be cloned.");
    if (method === "tabs.close") throw new Error("Error invoking remote method 'pistachio-ext:call': Error: main went away");
    return { ok: true, v: null };
  };
  const location = { protocol: options.protocol ?? "pistachio-ext:", origin: options.origin ?? "pistachio-ext://dev.test.ext", reload: vi.fn() };
  const window = { postMessage: vi.fn() };
  vi.stubGlobal("location", location);
  vi.stubGlobal("window", window);
  await import("../src/preload/extension");
  const wire = electron.exposed.get("__pistachioWire") as PistachioWire | undefined;
  const emit = (message: ExtEventMessage, ports: unknown[] = []) => electron.listeners.get("pistachio-ext:event")?.({ ports }, message);
  return { calls, location, window, wire, emit };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the extension preload", () => {
  it("exposes the wire alone, and builds pistachio in the page's world before its scripts", async () => {
    const { wire, calls } = await load();
    expect([...electron.exposed.keys()]).toEqual(["__pistachioWire"]);
    expect(Object.keys(wire ?? {}).sort()).toEqual(["call", "log", "onEvent"]);
    // Two scripts in the page's world, in order: the capture guard, then the API.
    expect(electron.executed.map((script) => script.func.name)).toEqual(["guardCaptures", "buildPistachio"]);
    const script = electron.executed[1];
    expect(script?.args).toEqual([{ install: true, timeouts: expect.objectContaining({ tool: 30_000, bar: 10_000 }) }]);
    // What the page's world gets: the API over this wire.
    const build = script?.func as unknown as typeof buildPistachio;
    const api = build({ install: false, wire });
    expect(await api?.tabs.query()).toEqual([{ id: "t1" }]);
    expect(calls.map((call) => [call.channel, call.method])).toEqual([
      ["pistachio-ext:call", "runtime.info"],
      ["pistachio-ext:call", "tabs.query"],
    ]);
  });

  it("guards every display capture the page takes — and every clone of a track or a stream — so main can count and end them", async () => {
    // The guard runs once in this file: its globals are not to be redefined.
    class FakeTrack {
      #state: "live" | "ended" = "live";
      constructor(readonly source: string) {}
      get readyState(): string {
        return this.#state;
      }
      // (Chromium names a tab capture's source in the track's settings: web-contents-media-stream://<process>:<frame>.)
      getSettings(): { deviceId: string } {
        return { deviceId: this.source };
      }
      stop(): void {
        this.#state = "ended";
      }
      clone(): FakeTrack {
        return new FakeTrack(this.source);
      }
    }
    class FakeStream {
      constructor(readonly tracks: FakeTrack[]) {}
      getTracks(): FakeTrack[] {
        return [...this.tracks];
      }
      // (As Chromium does: the tracks cloned natively, never through MediaStreamTrack.prototype.clone.)
      clone(): FakeStream {
        return new FakeStream(this.tracks.map((track) => new FakeTrack(track.source)));
      }
    }
    let next = 0;
    class FakeDevices {
      getDisplayMedia(): Promise<FakeStream> {
        next += 1;
        return Promise.resolve(new FakeStream([new FakeTrack(`web-contents-media-stream://13:${String(next)}`)]));
      }
    }
    vi.stubGlobal("MediaDevices", FakeDevices);
    vi.stubGlobal("MediaStream", FakeStream);
    vi.stubGlobal("MediaStreamTrack", FakeTrack);
    await load();
    const guard = electron.executed[0]?.func as (() => { live(): string[]; end(source?: string): number } | undefined) | undefined;
    expect(guard?.name).toBe("guardCaptures");
    const handle = guard?.();
    const g = globalThis as unknown as { __pistachioLiveCaptures: () => string[]; __pistachioEndCaptures: (source?: string) => number };
    // What the isolated world keeps is the same two functions.
    expect(handle?.live).toBe(g.__pistachioLiveCaptures);
    expect(handle?.end).toBe(g.__pistachioEndCaptures);
    expect(typeof g.__pistachioLiveCaptures).toBe("function");
    expect(Object.getOwnPropertyDescriptor(globalThis, "__pistachioEndCaptures")).toMatchObject({ writable: false, configurable: false });
    expect(g.__pistachioLiveCaptures()).toEqual([]);
    const first = "web-contents-media-stream://13:1";
    const second = "web-contents-media-stream://13:2";
    const stream = await new FakeDevices().getDisplayMedia();
    expect(g.__pistachioLiveCaptures()).toEqual([first]);
    // A track's clone and a stream's clone keep the source alive: both are listed under it, and ended with the rest.
    const trackCopy = stream.getTracks()[0]!.clone();
    const streamCopy = stream.clone();
    expect(g.__pistachioLiveCaptures()).toEqual([first, first, first]);
    stream.getTracks()[0]!.stop();
    expect(g.__pistachioLiveCaptures()).toEqual([first, first]);
    // A second capture of another window: ending the first's source leaves it alone.
    const other = await new FakeDevices().getDisplayMedia();
    expect(g.__pistachioLiveCaptures()).toEqual([first, first, second]);
    // A setter the page put on Array.prototype takes no entry: the list is made of own properties (read while broken,
    // restored at once — the runner's own arrays go through that setter too).
    const stolen: unknown[] = [];
    Object.defineProperty(Array.prototype, "0", { set: (value: unknown) => void stolen.push(value), get: () => undefined, configurable: true });
    let listed: string[];
    try {
      listed = g.__pistachioLiveCaptures();
    } finally {
      delete (Array.prototype as unknown as Record<string, unknown>)["0"];
    }
    expect(listed).toEqual([first, first, second]);
    expect(stolen).toEqual([]);
    expect(g.__pistachioEndCaptures(first)).toBe(2);
    expect([trackCopy.readyState, streamCopy.getTracks()[0]!.readyState, other.getTracks()[0]!.readyState]).toEqual(["ended", "ended", "live"]);
    expect(g.__pistachioLiveCaptures()).toEqual([second]);
    // No source named: every track.
    expect(g.__pistachioEndCaptures()).toBe(1);
    expect(g.__pistachioLiveCaptures()).toEqual([]);
    // A stream made without the guard's hands (no capture) is not its concern.
    const loose = new FakeStream([new FakeTrack("elsewhere")]);
    loose.clone();
    expect(g.__pistachioLiveCaptures()).toEqual([]);
    // A page that broke the prototypes the guard could have leaned on changes nothing it says or does. (The results are
    // read while they are broken and judged once they are whole again: the runner leans on them too.)
    const third = await new FakeDevices().getDisplayMedia();
    const targets = [[Array.prototype, "push"], [Set.prototype, "forEach"], [Set.prototype, "add"], [Set.prototype, "delete"], [Set.prototype, "has"], [FakeTrack.prototype, "stop"], [FakeTrack.prototype, "getSettings"]] as const;
    // (Every descriptor saved before any is broken: a saving by push would stop working with the first.)
    const saved = targets.map(([proto, name]) => Object.getOwnPropertyDescriptor(proto, name)!);
    for (const [proto, name] of targets) Object.defineProperty(proto, name, { value: () => undefined, configurable: true, writable: true });
    let live: string[];
    let endedNow: number;
    let state: string;
    try {
      live = g.__pistachioLiveCaptures();
      endedNow = g.__pistachioEndCaptures();
      state = third.getTracks()[0]!.readyState;
    } finally {
      targets.forEach(([proto, name], index) => Object.defineProperty(proto, name, saved[index]!));
    }
    expect(live).toEqual(["web-contents-media-stream://13:3"]);
    expect(endedNow).toBe(1);
    expect(state).toBe("ended");
  });

  it("gives nothing to a page that is not pistachio-ext:", async () => {
    const { calls } = await load({ protocol: "https:", origin: "https://example.com" });
    expect(electron.exposed.size).toBe(0);
    expect(electron.executed).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("keeps the wire shut when main's answer names another extension than the page's origin", async () => {
    const { wire, calls, emit, window } = await load({ origin: "pistachio-ext://dev.other.ext" });
    const listener = vi.fn();
    wire?.onEvent(listener);
    const reply = await wire?.call("tabs.query", {});
    expect(reply).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    expect((await wire?.call("runtime.info", {}))?.ok).toBe(false);
    emit({ kind: "event", subscription: 1, e: "tabs.removed", v: { tabId: "t1" } });
    expect(listener).not.toHaveBeenCalled();
    expect(window.postMessage).not.toHaveBeenCalled();
    expect(calls.map((call) => call.method)).toEqual(["runtime.info"]);
  });

  it("holds events until the origin is checked, then relays them and hands ports to the page's world", async () => {
    let answer!: (reply: ExtReply) => void;
    const { wire, emit, window } = await load({ info: () => new Promise((resolve) => (answer = resolve)) });
    const seen: ExtEventMessage[] = [];
    wire?.onEvent((message) => seen.push(message));
    const port = { close: vi.fn() };
    const connect: ExtEventMessage = { kind: "event", subscription: 0, e: "runtime.connect", v: { portId: 5, name: "chat", from: "worker" } };
    emit(connect, [port]);
    emit({ kind: "invoke", id: 1, invoke: "bar", name: "hello", v: { arg: "" } });
    await settle();
    expect(seen).toEqual([]);
    expect(window.postMessage).not.toHaveBeenCalled();
    answer({ ok: true, v: INFO });
    await settle();
    expect(window.postMessage).toHaveBeenCalledWith({ __pistachioPort: 5 }, "*", [port]);
    expect(seen.map((message) => message.kind)).toEqual(["event", "invoke"]);
    expect(port.close).not.toHaveBeenCalled();
  });

  it("reloads on main's reload, and closes a port that came with anything but runtime.connect", async () => {
    const { emit, location, window } = await load();
    await settle();
    const stray = { close: vi.fn() };
    emit({ kind: "event", subscription: 3, e: "tabs.created", v: { tab: {} } }, [stray]);
    expect(stray.close).toHaveBeenCalled();
    expect(window.postMessage).not.toHaveBeenCalled();
    emit({ kind: "reload" });
    expect(location.reload).toHaveBeenCalledTimes(1);
  });

  it("answers an IPC failure as an ExtReply, never a throw", async () => {
    const { wire } = await load();
    expect(await wire?.call("tabs.create", { url: () => 1 })).toMatchObject({ ok: false, code: "INVALID_ARGUMENT" });
    expect(await wire?.call("tabs.close", { id: "t1" })).toMatchObject({ ok: false, code: "UNAVAILABLE", message: expect.stringContaining("main went away") });
    expect(await wire?.call(42 as unknown as string, {})).toMatchObject({ ok: false, code: "INVALID_ARGUMENT" });
  });
});
