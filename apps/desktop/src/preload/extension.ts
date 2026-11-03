import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { ExtRuntimeInfo } from "@pistachio/extension-api";
import { EXT_HANDLER_TIMEOUTS, type EXT_CALL_CHANNEL, type EXT_EVENT_CHANNEL, type EXT_GUARD_KEY, type ExtErrorCode, type ExtEventMessage, type ExtReply } from "@pistachio/extension-api/wire";
import { buildPistachio, type PISTACHIO_WIRE_KEY, type PORT_HANDOFF_KEY, type PistachioWire } from "@pistachio/extension-api/runtime";

/**
 * The extension preload (docs/extensions.md §4 "Views", "The wire"). Every
 * Pistachio extension context — its pages (tabs), its panel, its worker — is
 * a sandboxed, context-isolated view on `persist:pistachio-ext-<id>` with
 * this preload, and this is all it gives the page, in two layers:
 *
 *  1. `__pistachioWire` through contextBridge: `call(method, args)` →
 *     `ipcRenderer.invoke("pistachio-ext:call", …)` answered by an ExtReply
 *     (never a throw), `onEvent(fn)` relaying "pistachio-ext:event" (JSON and
 *     ArrayBuffers), `log(…)`. No ipcRenderer, no require, no other channel.
 *     A MessagePort main sends with a `runtime.connect` event is handed to
 *     the page's world with `window.postMessage({ __pistachioPort: portId },
 *     "*", [port])` — the two worlds share the window, so the page's world
 *     receives the port itself (contextBridge would drop it).
 *  2. `pistachio`, built in the page's own world by `buildPistachio`
 *     (@pistachio/extension-api/runtime) through executeInMainWorld before
 *     the page's first script: over the wire, with real MediaStreams, real
 *     MessagePorts and errors that keep their `code` — none of which survive
 *     contextBridge's copy.
 *
 * Who the extension is comes from main (`runtime.info`, which main answers
 * from the sender's view, never from the message). That answer is async, so
 * both layers exist at once on any `pistachio-ext:` page, but the wire is
 * shut until the answer agrees with the page's own origin
 * (`pistachio-ext://<id>`): calls wait for it, events are held, and on a
 * mismatch every call is refused and nothing is ever relayed.
 *
 * A sandboxed preload can load no module but Electron's, so nothing here may
 * be shared with another preload (the bundler would put it in a chunk of
 * both): the channels are spelled out, held equal to the wire's names by the
 * compiler; `buildPistachio` and the handler timeouts are the only values
 * imported, from modules no other preload imports.
 */

const CALL: typeof EXT_CALL_CHANNEL = "pistachio-ext:call";
const EVENT: typeof EXT_EVENT_CHANNEL = "pistachio-ext:event";
const WIRE_KEY: typeof PISTACHIO_WIRE_KEY = "__pistachioWire";
const PORT_KEY: typeof PORT_HANDOFF_KEY = "__pistachioPort";
const GUARD_KEY: typeof EXT_GUARD_KEY = "__pistachioGuard";

/** What the guard hands this world: its two functions, reached by main here and never through the page's globals. */
interface CaptureGuard {
  live(): string[];
  end(source?: string): number;
}
const PROTOCOL = "pistachio-ext:";

/**
 * In the page's world, before its first script: every display capture the
 * page takes — and every clone of its tracks, or of a stream holding them,
 * since a clone keeps the source alive — is remembered, and two globals
 * no script can replace say and do what main needs (docs/extensions.md §5
 * "Ending"; main/extensions/capture.ts): `__pistachioLiveCaptures` counts
 * the tracks still live (main's word on whether the worker captures: the
 * tab's own `isBeingCaptured()` counts every capturer there is, a live
 * share's or Playwright's), `__pistachioEndCaptures` stops them all (main's
 * hand on a capture told to end that goes on). Only what was taken hold of
 * here is called, never a prototype the page may have changed since. The
 * same two functions are returned, for the isolated world to keep: main asks
 * there (`EXT_GUARD_KEY`), where no script of the page can rebind
 * `globalThis` or put a setter in the way.
 */
function guardCaptures(): CaptureGuard | undefined {
  const scope = globalThis as unknown as { MediaDevices?: { prototype: MediaDevices }; MediaStreamTrack?: { prototype: MediaStreamTrack }; MediaStream?: { prototype: MediaStream } };
  const devices = scope.MediaDevices?.prototype;
  const tracks = scope.MediaStreamTrack?.prototype;
  const streams = scope.MediaStream?.prototype;
  if (devices === undefined || tracks === undefined || streams === undefined || typeof devices.getDisplayMedia !== "function") return undefined;
  const apply = Reflect.apply;
  const defineProperty = Object.defineProperty;
  const getDisplayMedia = devices.getDisplayMedia;
  const getTracks = streams.getTracks;
  const cloneStream = streams.clone;
  const clone = tracks.clone;
  const stop = tracks.stop;
  const getSettings = tracks.getSettings;
  const readyState = Object.getOwnPropertyDescriptor(tracks, "readyState")?.get;
  const held = new Set<MediaStreamTrack>();
  const add = Set.prototype.add;
  const has = Set.prototype.has;
  const remove = Set.prototype.delete;
  const forEach = Set.prototype.forEach;
  const ended = (track: MediaStreamTrack): boolean => readyState !== undefined && apply(readyState, track, []) === "ended";
  // What a track captures, as Chromium names it: `web-contents-media-stream://<process>:<frame>` of the source's main frame.
  const sourceOf = (track: MediaStreamTrack): string => {
    const settings = apply(getSettings, track, []) as { deviceId?: unknown };
    return typeof settings.deviceId === "string" ? settings.deviceId : "";
  };
  const keep = (stream: MediaStream): void => {
    // (What ended on its own is let go: the set holds a worker's tracks for its life.)
    apply(forEach, held, [(track: MediaStreamTrack) => void (ended(track) && apply(remove, held, [track]))]);
    const list = apply(getTracks, stream, []) as MediaStreamTrack[];
    for (let i = 0; i < list.length; i++) apply(add, held, [list[i]]);
  };
  devices.getDisplayMedia = async function (this: MediaDevices, ...args: unknown[]): Promise<MediaStream> {
    const stream = (await apply(getDisplayMedia, this, args)) as MediaStream;
    keep(stream);
    return stream;
  };
  tracks.clone = function (this: MediaStreamTrack): MediaStreamTrack {
    const copy = apply(clone, this, []) as MediaStreamTrack;
    if (apply(has, held, [this]) === true) apply(add, held, [copy]);
    return copy;
  };
  // (A stream's clone clones its tracks natively, past the track's clone above.)
  streams.clone = function (this: MediaStream): MediaStream {
    const copy = apply(cloneStream, this, []) as MediaStream;
    const own = apply(getTracks, this, []) as MediaStreamTrack[];
    let kept = false;
    for (let i = 0; i < own.length && !kept; i++) kept = apply(has, held, [own[i]]) === true;
    if (kept) keep(copy);
    return copy;
  };
  // The sources of the tracks taken here that are live, one entry a track: main's word on what this worker still captures (CaptureBook).
  const live = (): string[] => {
    const list: string[] = [];
    // (An own property made by an intrinsic, never `list[i] = …` nor Array.prototype.push: a setter the page put on
    // Array.prototype would take the assignment, and the list would come back empty with the captures still live.)
    apply(forEach, held, [
      (track: MediaStreamTrack) =>
        void (ended(track) ? apply(remove, held, [track]) : defineProperty(list, list.length, { value: sourceOf(track), writable: true, enumerable: true, configurable: true })),
    ]);
    return list;
  };
  // The tracks of one source ended (every track, with no source named): main's hand on a capture told to end that goes on.
  const end = (source?: unknown): number => {
    const which = typeof source === "string" ? source : null;
    let count = 0;
    apply(forEach, held, [
      (track: MediaStreamTrack) => {
        if (which !== null && sourceOf(track) !== which) return;
        try {
          if (!ended(track)) count += 1;
          apply(stop, track, []);
        } catch {
          // (Gone already.)
        }
        apply(remove, held, [track]);
      },
    ]);
    return count;
  };
  defineProperty(globalThis, "__pistachioLiveCaptures", { value: live, writable: false, configurable: false, enumerable: false });
  defineProperty(globalThis, "__pistachioEndCaptures", { value: end, writable: false, configurable: false, enumerable: false });
  return { live, end };
}

const refusal = (code: ExtErrorCode, message: string): ExtReply => ({ ok: false, code, message });
const isReply = (value: unknown): value is ExtReply => value !== null && typeof value === "object" && typeof (value as { ok?: unknown }).ok === "boolean";
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function invoke(method: string, args: unknown): Promise<ExtReply> {
  try {
    const reply: unknown = await ipcRenderer.invoke(CALL, method, args === undefined ? {} : args);
    return isReply(reply) ? reply : refusal("UNAVAILABLE", `${method}: Pistachio gave no answer`);
  } catch (error) {
    const message = messageOf(error);
    // A value structured clone refuses (a function, a DOM node) never left the page.
    return refusal(/could not be cloned/i.test(message) ? "INVALID_ARGUMENT" : "UNAVAILABLE", `${method}: ${message}`);
  }
}

function start(): void {
  const info: Promise<ExtReply> = invoke("runtime.info", {}).then((reply) => {
    if (!reply.ok) return reply;
    const id = (reply.v as ExtRuntimeInfo | null)?.id;
    if (typeof id === "string" && location.origin === `${PROTOCOL}//${id}`) return reply;
    return refusal("PERMISSION_DENIED", `pistachio works only on the extension's own pages (pistachio-ext://<id>/), not on ${location.origin}`);
  });
  /** Null until `runtime.info` is in; then whether the page is the extension's own. */
  let open: boolean | null = null;
  const listeners = new Set<(message: ExtEventMessage) => void>();
  const held: { message: ExtEventMessage; port: MessagePort | undefined }[] = [];

  const relay = (message: ExtEventMessage, port: MessagePort | undefined): void => {
    if (port !== undefined) {
      const portId = message.kind === "event" && message.e === "runtime.connect" ? (message.v as { portId?: unknown } | null)?.portId : undefined;
      if (typeof portId === "number") window.postMessage({ [PORT_KEY]: portId }, "*", [port]);
      else port.close();
    }
    for (const fn of [...listeners]) {
      try {
        fn(message);
      } catch (error) {
        console.error("pistachio: an event's listener failed:", error);
      }
    }
  };

  void info.then((reply) => {
    open = reply.ok;
    const waiting = held.splice(0);
    for (const { message, port } of waiting) {
      if (open) relay(message, port);
      else port?.close();
    }
  });

  ipcRenderer.on(EVENT, (event: IpcRendererEvent, message: unknown) => {
    if (open === false || message === null || typeof message !== "object") return;
    const sent = message as ExtEventMessage;
    if (sent.kind === "reload") {
      // The dev folder changed (docs/extensions.md §4 "Hot reload"): the address, query and all, is kept.
      location.reload();
      return;
    }
    const port = event.ports[0];
    if (open === null) held.push({ message: sent, port });
    else relay(sent, port);
  });

  const wire: PistachioWire = {
    async call(method, args) {
      if (typeof method !== "string") return refusal("INVALID_ARGUMENT", "a method's name is a string");
      if (method === "runtime.info") return info;
      const checked = await info;
      if (!checked.ok) return checked;
      return invoke(method, args);
    },
    onEvent(fn) {
      if (typeof fn !== "function") return () => undefined;
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    log(level, message, data) {
      void wire.call("runtime.log", { level, message: String(message), data });
    },
  };

  contextBridge.exposeInMainWorld(WIRE_KEY, wire);
  try {
    // The guard's functions come back proxied, and stay here: main reaches them in this world alone (EXT_GUARD_KEY).
    const guard: unknown = contextBridge.executeInMainWorld({ func: guardCaptures });
    if (guard !== null && typeof guard === "object") Object.defineProperty(globalThis, GUARD_KEY, { value: guard, writable: false, configurable: false, enumerable: false });
  } catch (error) {
    console.error("pistachio: the capture guard could not be set in this page:", error);
  }
  try {
    contextBridge.executeInMainWorld({ func: buildPistachio, args: [{ install: true, timeouts: EXT_HANDLER_TIMEOUTS }] });
  } catch (error) {
    console.error("pistachio: the API could not be built in this page:", error);
    wire.log("error", `the API could not be built in this page: ${messageOf(error)}`);
  }
}

// Only an extension's own pages: a view that navigated elsewhere is refused by main, and gets nothing here.
if (location.protocol === PROTOCOL) start();
