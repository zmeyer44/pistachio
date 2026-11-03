/**
 * The `pistachio` global of an extension's own pages, panel and worker
 * (docs/extensions.md §4 "Views", §5), built in the PAGE's own world.
 *
 * Two layers. The extension preload (apps/desktop/src/preload/extension.ts)
 * exposes one raw wire through contextBridge, `__pistachioWire` — `call`,
 * `onEvent`, `log`, JSON and ArrayBuffers only — and hands every MessagePort
 * main sends to this world with `window.postMessage({ __pistachioPort: id },
 * "*", [port])`. Then it runs `buildPistachio` here with
 * `contextBridge.executeInMainWorld`, before the page's first script, and
 * this builds `globalThis.pistachio` over the wire. Not the other way round,
 * because contextBridge copies what crosses it: a MediaStream, a MessagePort,
 * a ReadableStream or an AbortSignal arrives as an empty object, an Error
 * loses every property but its message (so `code`), an exposed object is
 * frozen and its getters are read once. Built here, `capture.tab` answers
 * the real stream `getDisplayMedia` gave this world, a `Port` holds a real
 * MessagePort, errors are real `ExtError`s, and `runtime.id` is a getter.
 *
 * SELF-CONTAINED ON PURPOSE: Electron serializes `buildPistachio` by its
 * source text, so it closes over nothing — no import, no module constant
 * (the two keys below are spelled out inside it too, and a test runs it
 * from its source text alone). Only types are imported.
 *
 * The bootstrap is asynchronous (`runtime.info` is an invoke), so the object
 * exists at once and `runtime.ready` resolves when the extension's identity
 * is in. Every call waits for it on its own; only the synchronous members —
 * `runtime.id`, `runtime.manifest`, `runtime.context`, `files.data.url` —
 * throw when read before it, saying so.
 */

import type {
  ExtBarCommandContext,
  ExtCaptureSource,
  ExtContext,
  ExtDataFile,
  ExtDeskState,
  ExtEventMap,
  ExtInputEvent,
  ExtInputEventKind,
  ExtInvokeMap,
  ExtMenuClick,
  ExtMethodMap,
  ExtNoteSummary,
  ExtRuntimeInfo,
  ExtSpace,
  ExtStatus,
  ExtTab,
  ExtToast,
  Json,
} from "./api-types.js";
import type { ExtErrorCode, ExtEvent, ExtEventMessage, ExtInvokeKind, ExtReply } from "./wire.js";

/** The global the preload exposes the wire under. */
export const PISTACHIO_WIRE_KEY = "__pistachioWire";
/** The key of the `window.postMessage` that hands a port to this world. */
export const PORT_HANDOFF_KEY = "__pistachioPort";

/** What the preload exposes as `__pistachioWire`: the wire and nothing else. */
export interface PistachioWire {
  /** `ipcRenderer.invoke(EXT_CALL_CHANNEL, method, args)`; never throws: a failed IPC answers `UNAVAILABLE`. */
  call(method: string, args: unknown): Promise<ExtReply>;
  /** Every message of `EXT_EVENT_CHANNEL` but `reload` (the preload reloads), without its ports. */
  onEvent(fn: (message: ExtEventMessage) => void): () => void;
  /** `runtime.log`, fire and forget. */
  log(level: "info" | "warn" | "error", message: string, data?: Json): void;
}

export interface BuildPistachioOptions {
  /** Define `globalThis.pistachio` (read-only) and answer null; false answers the API (tests). */
  install: boolean;
  /** How long main waits for each kind of handler (wire.ts `EXT_HANDLER_TIMEOUTS`); a tool's `signal` aborts then. */
  timeouts?: Partial<Record<ExtInvokeKind, number>>;
  /** The wire; `globalThis.__pistachioWire` when absent. */
  wire?: PistachioWire;
}

type Unsubscribe = () => void;
type Bytes = ArrayBuffer | ArrayBufferView;

interface InvokeMessage {
  id: number;
  invoke: ExtInvokeKind;
  name: string;
  v: unknown;
}

interface Handler {
  kind: ExtInvokeKind;
  /** The tool, command, menu item or key's name; a status action's source; null for every invocation of the kind. */
  key: string | null;
  run: (v: never, signal: AbortSignal) => unknown;
}

interface Waiting {
  message: InvokeMessage;
  /** False for a `runtime.message` event with no reply id: run, but answer nothing. */
  answer: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

interface ToolContext {
  runId: string;
  spaceId: string | null;
  signal: AbortSignal;
  progress(text: string): void;
}

interface Port {
  name: string;
  postMessage(message: Json): void;
  onMessage(fn: (message: Json) => void): Unsubscribe;
  onDisconnect(fn: () => void): Unsubscribe;
  disconnect(): void;
}

interface PortEnd {
  port: Port;
  attach(raw: MessagePort): void;
  fail(): void;
}

interface DataWritable {
  write(chunk: ArrayBuffer | Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

interface FetchResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  text(): Promise<string>;
  json(): Promise<Json>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export function buildPistachio(options: BuildPistachioOptions) {
  const scope = globalThis as unknown as Record<string, unknown>;
  const given = options.wire ?? (scope["__pistachioWire"] as PistachioWire | undefined);
  if (given === undefined || given === null) throw new Error("pistachio: the extension preload's wire is missing");
  const wire: PistachioWire = given;
  const timeouts: Record<ExtInvokeKind, number> = {
    tool: 30_000,
    bar: 10_000,
    menu: 5_000,
    key: 5_000,
    action: 5_000,
    message: 10_000,
    statusAction: 5_000,
    installed: 5_000,
    ...options.timeouts,
  };
  const codes: readonly ExtErrorCode[] = ["PERMISSION_DENIED", "NOT_FOUND", "INVALID_ARGUMENT", "UNAVAILABLE", "TIMEOUT", "RATE_LIMITED", "CANCELLED"];

  /** What every failed call throws: an Error named "ExtError" whose `code` says which kind of failure. */
  class ExtError extends Error {
    declare readonly code: ExtErrorCode;
    constructor(code: ExtErrorCode, message: string) {
      super(message);
      this.name = "ExtError";
      this.code = code;
    }
  }

  const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
  const report = (where: string, error: unknown): void => {
    console.error(`pistachio: ${where}:`, error);
  };
  const noop = (): undefined => undefined;
  /** Run a listener; what it throws, now or later, is reported, never thrown at the wire. */
  const deliver = (where: string, run: () => unknown): void => {
    try {
      const result = run();
      if (result !== null && typeof result === "object" && typeof (result as PromiseLike<unknown>).then === "function") {
        (result as PromiseLike<unknown>).then(undefined, (error: unknown) => report(where, error));
      }
    } catch (error) {
      report(where, error);
    }
  };
  /** The arguments without their undefined keys. */
  const defined = <T extends object>(value: T): T => {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) if (item !== undefined) out[key] = item;
    return out as T;
  };
  /** A copy of exactly the chunk's bytes, so a buffer the caller reuses is not written twice. */
  const copyBytes = (where: string, data: Bytes): ArrayBuffer => {
    if (data instanceof ArrayBuffer) return data.slice(0);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer;
    throw new ExtError("INVALID_ARGUMENT", `${where}: expected an ArrayBuffer or a Uint8Array`);
  };
  const toJson = (where: string, value: unknown): Json | undefined => {
    if (value === undefined) return undefined;
    try {
      const text = JSON.stringify(value);
      if (text === undefined) throw new Error("it has no JSON form");
      return JSON.parse(text) as Json;
    } catch (error) {
      throw new ExtError("INVALID_ARGUMENT", `${where}: not JSON (${messageOf(error)})`);
    }
  };

  // ── Who this is: runtime.info ──────────────────────────────────────────────
  let info: ExtRuntimeInfo | null = null;
  let infoError: ExtError | null = null;
  const ready: Promise<void> = (async () => {
    let reply: ExtReply;
    try {
      reply = await wire.call("runtime.info", {});
    } catch (error) {
      throw new ExtError("UNAVAILABLE", `runtime.info: ${messageOf(error)}`);
    }
    if (reply === null || typeof reply !== "object") throw new ExtError("UNAVAILABLE", "runtime.info: no answer from Pistachio");
    if (!reply.ok) throw new ExtError(codes.includes(reply.code) ? reply.code : "UNAVAILABLE", reply.message);
    info = reply.v as ExtRuntimeInfo;
  })();
  // Handled here, so a page that never reads `ready` logs no unhandled rejection; awaiting it still throws.
  ready.catch((error: unknown) => {
    infoError = error instanceof ExtError ? error : new ExtError("UNAVAILABLE", messageOf(error));
  });
  const known = (member: string): ExtRuntimeInfo => {
    if (info !== null) return info;
    if (infoError !== null) throw infoError;
    throw new ExtError("UNAVAILABLE", `pistachio.${member} is not known yet: await pistachio.runtime.ready first (one line at the top of the script)`);
  };

  async function call<M extends keyof ExtMethodMap>(method: M, args: ExtMethodMap[M]["args"]): Promise<ExtMethodMap[M]["result"]> {
    await ready;
    let reply: ExtReply;
    try {
      reply = await wire.call(method, args);
    } catch (error) {
      throw new ExtError("UNAVAILABLE", `${method}: ${messageOf(error)}`);
    }
    if (reply === null || typeof reply !== "object") throw new ExtError("UNAVAILABLE", `${method}: no answer from Pistachio`);
    if (!reply.ok) throw new ExtError(codes.includes(reply.code) ? reply.code : "UNAVAILABLE", reply.message);
    return reply.v as ExtMethodMap[M]["result"];
  }
  /** Fire and forget: what fails is reported. */
  const send = <M extends keyof ExtMethodMap>(method: M, args: ExtMethodMap[M]["args"]): void => {
    call(method, args).then(noop, (error: unknown) => report(method, error));
  };
  /** A release that runs once. */
  const releaser = (run: () => void): Unsubscribe => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      run();
    };
  };

  // ── Events: events.on, dispatched by subscription ──────────────────────────
  const listeners = new Map<number, (v: unknown) => void>();
  /** Events for a subscription whose id has not come back yet (the reply and the event race). */
  const early = new Map<number, unknown[]>();
  let subscribing = 0;

  function on<E extends ExtEvent>(event: E, fn: (v: ExtEventMap[E]) => void): Unsubscribe {
    let id: number | null = null;
    let off = false;
    subscribing += 1;
    call("events.on", { event })
      .then(
        ({ subscriptionId }) => {
          if (off) {
            send("events.off", { subscriptionId });
            return;
          }
          id = subscriptionId;
          listeners.set(subscriptionId, fn as (v: unknown) => void);
          const queued = early.get(subscriptionId) ?? [];
          early.delete(subscriptionId);
          for (const v of queued) deliver(event, () => fn(v as ExtEventMap[E]));
        },
        (error: unknown) => report(`listening to ${event}`, error),
      )
      .finally(() => {
        subscribing -= 1;
        if (subscribing === 0) early.clear();
      });
    return () => {
      if (off) return;
      off = true;
      if (id === null) return;
      listeners.delete(id);
      send("events.off", { subscriptionId: id });
    };
  }

  // ── Invocations: main runs a declared tool, command, item, key… here ──────
  const handlers: Handler[] = [];
  /** runtime.onMessage listeners, and the one `runtime.message` subscription they share while any is there. */
  let messageListeners = 0;
  let offMessageEvent: Unsubscribe | null = null;
  const waiting: Waiting[] = [];
  /** The document has loaded: an invocation still without a handler a moment later has none. */
  let loaded = false;
  let draining = false;

  const keyOf = (message: InvokeMessage): string | null => {
    if (message.invoke !== "statusAction") return message.name;
    const v = message.v as { source?: unknown } | null;
    return typeof v?.source === "string" ? v.source : null;
  };
  const matching = (message: InvokeMessage): Handler[] =>
    handlers.filter((handler) => handler.kind === message.invoke && (handler.key === null || handler.key === keyOf(message)));

  const answer = async (id: number, outcome: { v?: unknown; error?: string }): Promise<void> => {
    let error = outcome.error;
    let v: Json | undefined;
    if (error === undefined) {
      try {
        v = toJson("the handler's answer", outcome.v);
      } catch (failure) {
        error = messageOf(failure);
      }
    }
    try {
      await call("runtime.done", error !== undefined ? { id, error } : v !== undefined ? { id, v } : { id });
    } catch (failure) {
      report("answering Pistachio", failure);
    }
  };

  /** Every matching handler in order; the first that answers something (or throws) is the answer. */
  const runInvoke = async (entry: Waiting): Promise<void> => {
    const { message } = entry;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new ExtError("TIMEOUT", `Pistachio stopped waiting after ${timeouts[message.invoke]} ms`)), timeouts[message.invoke]);
    try {
      let result: unknown = undefined;
      for (const handler of matching(message)) {
        result = await (handler.run as (v: unknown, signal: AbortSignal) => unknown)(message.v, controller.signal);
        if (result !== undefined) break;
      }
      if (entry.answer) await answer(message.id, { v: result });
    } catch (error) {
      if (entry.answer) await answer(message.id, { error: messageOf(error) });
      else report(`a ${message.invoke} handler`, error);
    } finally {
      clearTimeout(timer);
    }
  };

  const hints: Record<ExtInvokeKind, (name: string) => string> = {
    tool: (name) => `the tool "${name}": add pistachio.agent.onToolCall("${name}", …) to the worker`,
    bar: (name) => `the Bar command "/${name}": add pistachio.bar.onCommand("${name}", …) to the worker`,
    menu: (name) => `the menu item "${name}": add pistachio.contextMenus.onClicked("${name}", …) to the worker`,
    key: (name) => `the key command "${name}": add pistachio.commands.onCommand("${name}", …) to the worker`,
    action: () => `the Ledge icon: add pistachio.runtime.onAction(…) to the worker`,
    message: () => "",
    statusAction: () => "",
    installed: () => "",
  };
  const giveUp = (entry: Waiting): void => {
    const index = waiting.indexOf(entry);
    if (index === -1) return;
    waiting.splice(index, 1);
    if (!entry.answer) return;
    const { invoke, name, id } = entry.message;
    // A message, a status action or an install nobody listens to is not a mistake: it answers nothing.
    if (invoke === "message" || invoke === "statusAction" || invoke === "installed") void answer(id, {});
    else void answer(id, { error: `nothing handles ${hints[invoke](name)}` });
  };
  const schedule = (entry: Waiting): void => {
    if (entry.timer !== null) clearTimeout(entry.timer);
    const limit = Math.max(0, timeouts[entry.message.invoke] - 250);
    entry.timer = setTimeout(() => giveUp(entry), loaded ? Math.min(1_500, limit) : limit);
  };
  /** After the script that registered a handler has run to its end, so every handler it registers is there. */
  const drain = (): void => {
    if (draining) return;
    draining = true;
    queueMicrotask(() => {
      draining = false;
      for (const entry of [...waiting]) {
        if (matching(entry.message).length === 0) continue;
        waiting.splice(waiting.indexOf(entry), 1);
        if (entry.timer !== null) clearTimeout(entry.timer);
        void runInvoke(entry);
      }
    });
  };
  const onInvoke = (message: InvokeMessage, reply: boolean): void => {
    if (typeof message.id !== "number" && reply) return;
    const entry: Waiting = { message, answer: reply, timer: null };
    if (matching(message).length > 0) {
      void runInvoke(entry);
      return;
    }
    waiting.push(entry);
    schedule(entry);
  };
  function handle<K extends ExtInvokeKind>(kind: K, key: string | null, run: (v: ExtInvokeMap[K], signal: AbortSignal) => unknown): Unsubscribe {
    if (typeof run !== "function") throw new ExtError("INVALID_ARGUMENT", "a handler is a function");
    const handler: Handler = { kind, key, run: run as Handler["run"] };
    handlers.push(handler);
    if (waiting.length > 0) drain();
    return () => {
      const index = handlers.indexOf(handler);
      if (index !== -1) handlers.splice(index, 1);
    };
  }
  /** Handlers whose return value is not an answer: every one of them runs. */
  const each =
    <V>(fn: (v: V) => unknown) =>
    async (v: V): Promise<undefined> => {
      await fn(v);
      return undefined;
    };

  // ── Ports: runtime.connect, main off the path ─────────────────────────────
  /** Both halves of an arrival: the port (window.postMessage) and what it is (the event). */
  const portObjects = new Map<number, MessagePort>();
  const portInfos = new Map<number, ExtEventMap["runtime.connect"]>();
  /** This context's own connects whose id is known and whose port is still on its way. */
  const ownWaiting = new Map<number, PortEnd>();
  const claimed = new Set<number>();
  /** Connects whose reply has not come: an arrival meanwhile may be one of them. */
  let connecting = 0;
  const held: number[] = [];
  const connectListeners = new Set<(port: Port) => void>();
  const unheard: Port[] = [];

  const makePort = (name: string): PortEnd => {
    let raw: MessagePort | null = null;
    let closed = false;
    const queue: Json[] = [];
    /** What the other end sent before anyone here listened: handed to the first onMessage, in order. */
    const inbox: Json[] = [];
    const messageFns = new Set<(message: Json) => void>();
    const disconnectFns = new Set<() => void>();
    const end = (fire: boolean): void => {
      if (closed) return;
      closed = true;
      raw?.close();
      if (fire) for (const fn of [...disconnectFns]) deliver("port.onDisconnect", fn);
    };
    const port: Port = {
      name,
      postMessage(message) {
        if (closed) throw new ExtError("UNAVAILABLE", `the port "${name}" is disconnected`);
        const data = toJson("port.postMessage", message) ?? null;
        if (raw === null) queue.push(data);
        else raw.postMessage([0, data]);
      },
      onMessage(fn) {
        messageFns.add(fn);
        for (const message of inbox.splice(0)) deliver("port.onMessage", () => fn(message));
        return () => void messageFns.delete(fn);
      },
      onDisconnect(fn) {
        disconnectFns.add(fn);
        return () => void disconnectFns.delete(fn);
      },
      disconnect() {
        if (closed) return;
        try {
          raw?.postMessage([1]);
        } catch {
          // Already gone.
        }
        end(false);
      },
    };
    return {
      port,
      attach(next) {
        if (closed) {
          next.postMessage([1]);
          next.close();
          return;
        }
        raw = next;
        // [0, message] carries a message, [1] says the other end disconnected; both ends are this runtime.
        next.onmessage = (event: MessageEvent) => {
          const data = event.data as unknown;
          if (!Array.isArray(data)) return;
          if (data[0] === 1) end(true);
          else if (data[0] === 0) {
            // (A port is handed over as it arrives, and its page may listen only after an await: nothing is dropped meanwhile.)
            if (messageFns.size === 0) inbox.push(data[1] as Json);
            else for (const fn of [...messageFns]) deliver("port.onMessage", () => fn(data[1] as Json));
          }
        };
        // Chromium fires `close` when the other end is closed or collected.
        next.addEventListener("close", () => end(true));
        for (const message of queue.splice(0)) next.postMessage([0, message]);
      },
      fail() {
        end(true);
      },
    };
  };

  const incoming = (portId: number): void => {
    const raw = portObjects.get(portId);
    const about = portInfos.get(portId);
    if (raw === undefined || about === undefined) return;
    portObjects.delete(portId);
    portInfos.delete(portId);
    const end = makePort(typeof about.name === "string" ? about.name : "");
    end.attach(raw);
    if (connectListeners.size === 0) unheard.push(end.port);
    else for (const fn of [...connectListeners]) deliver("runtime.onConnect", () => fn(end.port));
  };
  const settleHeld = (): void => {
    if (connecting > 0) return;
    for (const portId of held.splice(0)) incoming(portId);
  };
  const portArrived = (portId: number): void => {
    if (claimed.has(portId)) {
      portInfos.delete(portId);
      return;
    }
    const raw = portObjects.get(portId);
    const own = ownWaiting.get(portId);
    if (raw !== undefined && own !== undefined) {
      ownWaiting.delete(portId);
      portObjects.delete(portId);
      portInfos.delete(portId);
      claimed.add(portId);
      own.attach(raw);
      return;
    }
    if (raw === undefined || !portInfos.has(portId)) return;
    if (connecting > 0) {
      if (!held.includes(portId)) held.push(portId);
      return;
    }
    incoming(portId);
  };

  const connect = (name?: string): Port => {
    const end = makePort(name ?? "");
    connecting += 1;
    void (async () => {
      let portId: number | null = null;
      try {
        await ready;
        const worker = known("runtime.context").context === "worker";
        if (worker && (name === undefined || name === "")) throw new ExtError("INVALID_ARGUMENT", "runtime.connect: from the worker, name the page to connect to");
        portId = (await call("runtime.connect", { name: name ?? "", target: worker ? { page: name ?? "" } : "worker" })).portId;
      } catch (error) {
        report("runtime.connect", error);
        end.fail();
      }
      connecting -= 1;
      if (portId !== null) {
        const index = held.indexOf(portId);
        if (index !== -1) held.splice(index, 1);
        ownWaiting.set(portId, end);
        portArrived(portId);
      }
      settleHeld();
    })();
    return end.port;
  };

  // ── Input and capture ──────────────────────────────────────────────────────
  const inputSinks = new Map<number, (events: ExtInputEvent[]) => void>();
  const earlyInput = new Map<number, ExtInputEvent[][]>();
  let subscribingInput = 0;
  const captures = new Map<string, MediaStream[]>();

  const inputArrived = (v: ExtEventMap["input.event"]): void => {
    if (v === null || typeof v !== "object" || !Array.isArray(v.events)) return;
    const sink = inputSinks.get(v.subscriptionId);
    if (sink !== undefined) sink(v.events);
    else if (subscribingInput > 0) {
      const batches = earlyInput.get(v.subscriptionId) ?? [];
      if (batches.length < 64) batches.push(v.events);
      earlyInput.set(v.subscriptionId, batches);
    }
  };
  /** Main ended a capture (the tab closed, the extension lost the grant): its tracks end as a stopped source's do. */
  const captureEnded = (v: ExtEventMap["capture.ended"]): void => {
    const streams = captures.get(v?.tabId);
    if (streams === undefined) return;
    captures.delete(v.tabId);
    for (const stream of streams) {
      for (const track of stream.getTracks()) {
        if (track.readyState === "ended") continue;
        track.stop();
        track.dispatchEvent(new Event("ended"));
      }
    }
  };

  // ── The event channel ──────────────────────────────────────────────────────
  wire.onEvent((message) => {
    if (message === null || typeof message !== "object") return;
    if (message.kind === "invoke") {
      onInvoke({ id: message.id, invoke: message.invoke, name: message.name, v: message.v }, true);
      return;
    }
    if (message.kind !== "event") return;
    switch (message.e) {
      case "runtime.connect": {
        const v = message.v as ExtEventMap["runtime.connect"];
        if (v === null || typeof v !== "object" || typeof v.portId !== "number") return;
        if (!claimed.has(v.portId)) portInfos.set(v.portId, v);
        portArrived(v.portId);
        return;
      }
      case "input.event":
        inputArrived(message.v as ExtEventMap["input.event"]);
        return;
      case "runtime.message": {
        const v = message.v as ExtEventMap["runtime.message"];
        if (v === null || typeof v !== "object") return;
        const reply = typeof v.replyId === "number";
        onInvoke({ id: reply ? (v.replyId as number) : -1, invoke: "message", name: "", v: { message: v.message, from: v.from } }, reply);
        return;
      }
      case "capture.ended":
        captureEnded(message.v as ExtEventMap["capture.ended"]);
        break;
    }
    const fn = listeners.get(message.subscription);
    if (fn !== undefined) deliver(message.e, () => fn(message.v));
    else if (subscribing > 0) {
      const queued = early.get(message.subscription) ?? [];
      if (queued.length < 256) queued.push(message.v);
      early.set(message.subscription, queued);
    }
  });

  // ── The window: ports handed over, the load, the panel's size ─────────────
  const win = scope["window"] as EventTarget | undefined;
  const doc = scope["document"] as Document | undefined;
  if (win !== undefined && typeof win.addEventListener === "function") {
    win.addEventListener("message", (event: Event) => {
      const { data, source, ports } = event as MessageEvent;
      if (source !== win || data === null || typeof data !== "object") return;
      const portId = (data as Record<string, unknown>)["__pistachioPort"];
      const raw = ports?.[0];
      if (typeof portId !== "number" || raw === undefined) return;
      // The handoff is the runtime's, not the page's.
      event.stopImmediatePropagation();
      if (claimed.has(portId)) {
        raw.close();
        return;
      }
      portObjects.set(portId, raw);
      portArrived(portId);
    });
    if (doc?.readyState === "complete") loaded = true;
    else {
      win.addEventListener(
        "load",
        () => {
          loaded = true;
          for (const entry of waiting) schedule(entry);
        },
        { once: true },
      );
    }
  } else loaded = true;

  /** The panel's side card fits its content: the document's size, 50 ms after it settles. */
  const watchPanelSize = (): void => {
    const Observer = scope["ResizeObserver"] as typeof ResizeObserver | undefined;
    if (doc === undefined || Observer === undefined) return;
    const start = (): void => {
      const root = doc.documentElement;
      if (root === null) return;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let last = "";
      const post = (): void => {
        timer = null;
        const rect = root.getBoundingClientRect();
        const width = Math.ceil(Math.max(rect.width, root.scrollWidth));
        const height = Math.ceil(rect.height);
        const size = `${width}x${height}`;
        if (size === last || (width === 0 && height === 0)) return;
        last = size;
        call("ui.preferredSize", { width, height }).then(noop, noop);
      };
      new Observer(() => {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(post, 50);
      }).observe(root);
    };
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", start, { once: true });
    else start();
  };
  ready.then(() => {
    if (info?.context === "panel") watchPanelSize();
  }, noop);

  // ── Files: data writes in order ────────────────────────────────────────────
  const writable = (handle: number): DataWritable => {
    let tail: Promise<unknown> = Promise.resolve();
    let state: "open" | "closing" | "closed" = "open";
    let broken: unknown = null;
    const enqueue = (job: () => Promise<unknown>): Promise<void> => {
      const next = tail.then(() => {
        if (broken !== null) throw broken;
        return job();
      });
      tail = next.catch((error: unknown) => {
        broken ??= error;
      });
      return next.then(noop);
    };
    return {
      write(chunk) {
        if (state !== "open") return Promise.reject(new ExtError("INVALID_ARGUMENT", "files.data: this file is closed"));
        let bytes: ArrayBuffer;
        try {
          bytes = copyBytes("files.data write", chunk);
        } catch (error) {
          return Promise.reject(error);
        }
        return enqueue(() => call("files.data.write", { handle, path: null, chunk: bytes }));
      },
      close() {
        if (state !== "open") return tail.then(noop);
        state = "closing";
        return enqueue(() => call("files.data.close", { handle, abort: false })).then(
          () => {
            state = "closed";
          },
          (error: unknown) => {
            state = "closed";
            call("files.data.close", { handle, abort: true }).then(noop, noop);
            throw error;
          },
        );
      },
      abort() {
        if (state === "closed") return Promise.resolve();
        state = "closed";
        broken ??= new ExtError("CANCELLED", "files.data: the write was aborted");
        return tail.then(() => call("files.data.close", { handle, abort: true })).then(noop);
      },
    };
  };
  const bytesOf = async (where: string, data: ArrayBuffer | ArrayBufferView | string | Blob): Promise<ArrayBuffer> => {
    if (typeof data === "string") return copyBytes(where, new TextEncoder().encode(data));
    if (typeof Blob !== "undefined" && data instanceof Blob) return data.arrayBuffer();
    return copyBytes(where, data as Bytes);
  };
  const dataUrl = (path: string): string => {
    const id = known("files.data.url").id;
    const clean = String(path).replace(/^\.\//, "");
    const parts = clean.split("/");
    if (clean === "" || clean.startsWith("/") || parts.includes("..")) throw new ExtError("INVALID_ARGUMENT", `files.data.url: "${path}" is not a path inside the extension's data folder`);
    return `pistachio-ext://${id}/__data__/${parts.map(encodeURIComponent).join("/")}`;
  };
  const decodeBase64 = (text: string): Uint8Array => {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  };

  // ── The API (pistachio.d.ts) ───────────────────────────────────────────────
  const runtime = {
    /** Resolves once this extension's id, manifest and context are known; every call waits for it on its own. */
    ready,
    get id(): string {
      return known("runtime.id").id;
    },
    get manifest(): { api: 1; id: string; name: string; version: string; [key: string]: unknown } {
      return known("runtime.manifest").manifest as unknown as { api: 1; id: string; name: string; version: string };
    },
    get context(): ExtContext {
      return known("runtime.context").context;
    },
    now: (): number => performance.timeOrigin + performance.now(),
    connect,
    onConnect(fn: (port: Port) => void): Unsubscribe {
      connectListeners.add(fn);
      for (const port of unheard.splice(0)) deliver("runtime.onConnect", () => fn(port));
      return () => void connectListeners.delete(fn);
    },
    sendMessage: async (message: Json): Promise<Json | undefined> => call("runtime.sendMessage", { message: toJson("runtime.sendMessage", message) ?? null }),
    onMessage: (fn: (message: Json, from: ExtContext) => unknown): Unsubscribe => {
      const offHandler = handle("message", null, (v) => fn(v.message, v.from));
      // A page or the panel hears the worker's messages through ONE subscription main keeps (`runtime.message`, each
      // copy answered through every handler above: one per context, however many listen); the worker is invoked
      // outright, and its subscription is never a target.
      messageListeners += 1;
      offMessageEvent ??= on("runtime.message", () => undefined);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        offHandler();
        messageListeners -= 1;
        if (messageListeners > 0) return;
        offMessageEvent?.();
        offMessageEvent = null;
      };
    },
    keepAlive: async (reason: string): Promise<Unsubscribe> => {
      const { holdId } = await call("runtime.keepAlive", { reason: String(reason) });
      return releaser(() => send("runtime.release", { holdId }));
    },
    onInstalled: (fn: (details: { reason: "install" | "update" | "dev-reload" }) => void): Unsubscribe => handle("installed", null, each(fn)),
    onAction: (fn: (ctx: { tabId: string | null; spaceId: string | null }) => void): Unsubscribe => handle("action", null, each(fn)),
    log(level: "info" | "warn" | "error", message: string, data?: Json): void {
      let payload: Json | undefined;
      try {
        payload = toJson("runtime.log", data);
      } catch {
        payload = String(data);
      }
      wire.log(level, String(message), payload);
    },
  };

  const local = {
    get: async (keys?: string | string[]): Promise<Record<string, Json>> => call("storage.get", { keys: keys === undefined ? null : typeof keys === "string" ? [keys] : keys }),
    set: async (items: Record<string, Json>): Promise<void> => {
      await call("storage.set", { items: toJson("storage.local.set", items) as Record<string, Json> });
    },
    remove: async (keys: string | string[]): Promise<void> => {
      await call("storage.remove", { keys: typeof keys === "string" ? [keys] : keys });
    },
    onChanged: (fn: (changes: Record<string, { oldValue?: Json; newValue?: Json }>) => void): Unsubscribe => on("storage.changed", (v) => fn(v.changes)),
  };

  const settings = {
    get: async (key: string): Promise<Json | undefined> => (await call("settings.get", { key }))[key],
    getAll: (): Promise<Record<string, Json>> => call("settings.get", { key: null }),
    onChanged: (fn: (key: string, value: Json | undefined) => void): Unsubscribe => on("settings.changed", (v) => fn(v.key, v.value)),
  };

  const ui = {
    openPanel: async (): Promise<void> => {
      await call("ui.openPanel", {});
    },
    closePanel: async (): Promise<void> => {
      await call("ui.closePanel", {});
    },
    openPage: async (name: string, options?: { query?: string; space?: "current" | "new" | string }): Promise<string> =>
      (await call("ui.openPage", defined({ name, query: options?.query, space: options?.space }))).tabId,
    toast: async (toast: ExtToast): Promise<void> => {
      await call("ui.toast", defined({ title: toast.title, body: toast.body, action: toast.action }));
    },
    setBadge: async (text: string | null): Promise<void> => {
      await call("ui.setBadge", { text });
    },
    setStatus: async (status: ExtStatus | null): Promise<void> => {
      await call("ui.setStatus", { status: status === null ? null : defined({ text: status.text, actions: status.actions }) });
    },
    onStatusAction: (fn: (action: string) => void): Unsubscribe => handle("statusAction", "status", each((v) => fn(v.action))),
    onToastAction: (fn: (action: string) => void): Unsubscribe => handle("statusAction", "toast", each((v) => fn(v.action))),
  };

  const bar = {
    onCommand: (name: string, fn: (ctx: ExtBarCommandContext) => unknown): Unsubscribe => handle("bar", name, (v) => fn(v)),
  };
  const contextMenus = {
    onClicked: (id: string, fn: (info: ExtMenuClick) => void): Unsubscribe => handle("menu", id, each(fn)),
  };
  const commands = {
    onCommand: (id: string, fn: (ctx: { tabId: string | null; spaceId: string | null }) => void): Unsubscribe => handle("key", id, each(fn)),
  };

  const tabs = {
    query: (query?: { spaceId?: string; active?: boolean; url?: string }): Promise<ExtTab[]> =>
      call("tabs.query", defined({ spaceId: query?.spaceId, active: query?.active, url: query?.url })),
    get: (id: string): Promise<ExtTab> => call("tabs.get", { id }),
    create: (options: { url: string; space?: "current" | "new" | string; show?: boolean }): Promise<ExtTab> =>
      call("tabs.create", defined({ url: options.url, space: options.space, show: options.show })),
    navigate: async (id: string, url: string): Promise<void> => {
      await call("tabs.navigate", { id, url });
    },
    show: async (id: string): Promise<void> => {
      await call("tabs.show", { id });
    },
    close: async (id: string): Promise<void> => {
      await call("tabs.close", { id });
    },
    onCreated: (fn: (tab: ExtTab) => void): Unsubscribe => on("tabs.created", (v) => fn(v.tab)),
    onUpdated: (fn: (tab: ExtTab, changed: ("title" | "url" | "loading" | "favIconUrl")[]) => void): Unsubscribe => on("tabs.updated", (v) => fn(v.tab, v.changed)),
    onRemoved: (fn: (tabId: string) => void): Unsubscribe => on("tabs.removed", (v) => fn(v.tabId)),
    onActivated: (fn: (tabId: string | null) => void): Unsubscribe => on("tabs.activated", (v) => fn(v.tabId)),
  };

  const spaces = {
    list: (): Promise<ExtSpace[]> => call("spaces.list", {}),
    current: (): Promise<ExtSpace | null> => call("spaces.current", {}),
    onCurrentChanged: (fn: (space: ExtSpace | null) => void): Unsubscribe => on("spaces.currentChanged", (v) => fn(v.space)),
  };

  const desk = {
    state: (spaceId?: string): Promise<ExtDeskState> => call("desk.state", defined({ spaceId })),
    onChanged: (fn: (state: ExtDeskState) => void): Unsubscribe => on("desk.changed", (v) => fn(v.state)),
  };

  const pages = {
    read: async (tabId: string, options?: { format?: "text" | "markdown" | "elements" }): Promise<string> =>
      (await call("pages.read", { tabId, format: options?.format ?? "text" })).text,
    screenshot: async (tabId: string): Promise<Blob> => new Blob([(await call("pages.screenshot", { tabId })).png], { type: "image/png" }),
  };

  const capture = {
    sources: (): Promise<ExtCaptureSource[]> => call("capture.sources", {}),
    /**
     * Arm, then ask: main answers this extension session's next getDisplayMedia
     * with the tab's frame (setDisplayMediaRequestHandler), and the stream this
     * world gets is the real one. Run here and not in the preload: the preload's
     * isolated world shares this frame, so its getDisplayMedia would be answered
     * the same way, but its MediaStream could never cross contextBridge.
     */
    tab: async (tabId: string, options?: { audio?: boolean; scale?: 1 | 2; frameRate?: 30 | 60 }): Promise<MediaStream> => {
      const audio = options?.audio === true;
      const frameRate = options?.frameRate === 30 ? 30 : 60;
      const size = await call("capture.arm", { tabId, audio, scale: options?.scale === 2 ? 2 : 1, frameRate });
      const media = (scope["navigator"] as Navigator | undefined)?.mediaDevices;
      if (media === undefined || typeof media.getDisplayMedia !== "function") throw new ExtError("UNAVAILABLE", "capture.tab: getDisplayMedia is not available here (capture.tab works in the worker)");
      let stream: MediaStream;
      try {
        stream = await media.getDisplayMedia({
          video: { width: { ideal: size.width }, height: { ideal: size.height }, frameRate: { ideal: frameRate } },
          // The page's own sound, untouched: no echo cancellation, suppression or gain, in stereo.
          audio: audio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 } : false,
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        throw new ExtError(name === "NotAllowedError" ? "PERMISSION_DENIED" : "UNAVAILABLE", `capture.tab: ${messageOf(error)}`);
      }
      const live = (captures.get(tabId) ?? []).filter((kept) => kept.getTracks().some((track) => track.readyState !== "ended"));
      live.push(stream);
      captures.set(tabId, live);
      return stream;
    },
    hold: async (tabId: string): Promise<Unsubscribe> => {
      const { holdId } = await call("capture.hold", { tabId });
      return releaser(() => send("capture.release", { holdId }));
    },
  };

  const input = {
    subscribe: async (
      tabId: string,
      kinds?: ExtInputEventKind[],
    ): Promise<{ onEvent(fn: (event: ExtInputEvent) => void): Unsubscribe; stop(): Promise<void> }> => {
      const fns = new Set<(event: ExtInputEvent) => void>();
      const sink = (events: ExtInputEvent[]): void => {
        for (const event of events) for (const fn of [...fns]) deliver("input.onEvent", () => fn(event));
      };
      let subscriptionId: number;
      subscribingInput += 1;
      try {
        subscriptionId = (await call("input.subscribe", { tabId, kinds: kinds ?? null })).subscriptionId;
        inputSinks.set(subscriptionId, sink);
        const batches = earlyInput.get(subscriptionId) ?? [];
        earlyInput.delete(subscriptionId);
        // Delivered once the caller can have added its onEvent: after this answer settles.
        if (batches.length > 0) setTimeout(() => batches.forEach(sink), 0);
      } finally {
        subscribingInput -= 1;
        if (subscribingInput === 0) earlyInput.clear();
      }
      let stopped = false;
      return {
        onEvent(fn) {
          fns.add(fn);
          return () => void fns.delete(fn);
        },
        async stop() {
          if (stopped) return;
          stopped = true;
          inputSinks.delete(subscriptionId);
          await call("input.stop", { subscriptionId });
        },
      };
    },
  };

  const data = {
    open: async (path: string, options?: { append?: boolean }): Promise<DataWritable> =>
      writable((await call("files.data.open", { path, append: options?.append === true })).handle),
    write: async (path: string, content: ArrayBuffer | Uint8Array | string | Blob): Promise<void> => {
      await call("files.data.write", { handle: null, path, chunk: await bytesOf("files.data.write", content) });
    },
    read: async (path: string, range?: { start: number; end?: number }): Promise<ArrayBuffer> =>
      (await call("files.data.read", defined({ path, start: range?.start, end: range?.end }))).bytes,
    list: (dir?: string): Promise<ExtDataFile[]> => call("files.data.list", { dir: dir ?? "" }),
    remove: async (path: string): Promise<void> => {
      await call("files.data.remove", { path });
    },
    url: dataUrl,
    freeSpace: async (): Promise<number> => (await call("files.data.freeSpace", {})).bytes,
  };

  const files = {
    pick: async (options?: { accept?: string[]; multiple?: boolean }): Promise<string[]> =>
      (await call("files.pick", defined({ accept: options?.accept, multiple: options?.multiple }))).paths,
    save: async (
      content: ArrayBuffer | Uint8Array | Blob | { dataPath: string },
      options: { suggestedName: string; folder?: "downloads" | "screenshots" | "ask" },
    ): Promise<string | null> => {
      const fromData = content !== null && typeof content === "object" && "dataPath" in content && typeof content.dataPath === "string";
      const args = {
        data: fromData ? null : await bytesOf("files.save", content as ArrayBuffer | Uint8Array | Blob),
        dataPath: fromData ? (content as { dataPath: string }).dataPath : null,
        suggestedName: options.suggestedName,
        folder: options.folder ?? "ask",
      };
      return (await call("files.save", args)).path;
    },
    reveal: async (path: string): Promise<void> => {
      await call("files.reveal", { path });
    },
    startDrag: async (dataPath: string): Promise<void> => {
      await call("files.startDrag", { dataPath });
    },
    data,
  };

  const clipboard = {
    write: async (content: { text?: string; html?: string; image?: Blob; filePath?: string }): Promise<void> => {
      const imagePng = content.image === undefined ? undefined : await content.image.arrayBuffer();
      await call("clipboard.write", defined({ text: content.text, html: content.html, imagePng, filePath: content.filePath }));
    },
    readText: async (): Promise<string> => (await call("clipboard.readText", {})).text,
  };

  const notifications = {
    show: async (notification: { title: string; body?: string; action?: { id: string; title: string } }): Promise<void> => {
      await call("notifications.show", defined({ title: notification.title, body: notification.body, action: notification.action }));
    },
    onAction: (fn: (action: string) => void): Unsubscribe => handle("statusAction", "notification", each((v) => fn(v.action))),
  };

  const net = {
    fetch: async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string | ArrayBuffer | Uint8Array }): Promise<FetchResponse> => {
      const body = init?.body === undefined || typeof init.body === "string" ? init?.body : copyBytes("net.fetch", init.body);
      const result = await call("net.fetch", defined({ url, method: init?.method, headers: init?.headers, body }));
      const bytes = decodeBase64(result.body);
      const text = async (): Promise<string> => new TextDecoder().decode(bytes);
      return {
        status: result.status,
        ok: result.status >= 200 && result.status < 300,
        headers: result.headers,
        text,
        json: async (): Promise<Json> => JSON.parse(await text()) as Json,
        arrayBuffer: async (): Promise<ArrayBuffer> => bytes.slice().buffer,
      };
    },
  };

  const notes = {
    list: (): Promise<ExtNoteSummary[]> => call("notes.list", {}),
    search: (query: string, limit?: number): Promise<ExtNoteSummary[]> => call("notes.search", defined({ query, limit })),
    read: (id: string): Promise<{ id: string; title: string; markdown: string }> => call("notes.read", { id }),
    create: (note: { title: string; markdown: string }): Promise<{ id: string }> => call("notes.create", { title: note.title, markdown: note.markdown }),
    update: async (id: string, change: { mode: "replace" | "append" | "section"; markdown: string; section?: string }): Promise<void> => {
      await call("notes.update", defined({ id, mode: change.mode, markdown: change.markdown, section: change.section }));
    },
  };

  const agent = {
    onToolCall: (name: string, fn: (input: never, ctx: ToolContext) => unknown): Unsubscribe =>
      handle("tool", name, (v, signal) =>
        fn(v.input as never, {
          runId: v.runId,
          spaceId: v.spaceId,
          signal,
          // No wire method carries a step's progress yet: it goes to the extension's log, marked with the run.
          progress: (text: string) => wire.log("info", String(text), { runId: v.runId, progress: true }),
        }),
      ),
    ask: async (prompt: string, options?: { spaceId?: string }): Promise<void> => {
      await call("agent.ask", defined({ prompt, spaceId: options?.spaceId }));
    },
  };

  const power = {
    preventSleep: async (): Promise<Unsubscribe> => {
      const { holdId } = await call("power.preventSleep", {});
      return releaser(() => send("power.release", { holdId }));
    },
  };

  const storage = { local };
  const api = { runtime, storage, settings, ui, bar, contextMenus, commands, tabs, spaces, desk, pages, capture, input, files, clipboard, notifications, net, notes, agent, power };
  for (const part of [local, data, ...Object.values(api)]) Object.freeze(part);
  Object.freeze(api);

  if (options.install) {
    Object.defineProperty(scope, "pistachio", { value: api, enumerable: true, configurable: false, writable: false });
    return null;
  }
  return api;
}
