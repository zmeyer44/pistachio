/**
 * The wire between an extension context and main (docs/extensions.md §4):
 * a call on `pistachio-ext:call`, an event or a handler invocation on
 * `pistachio-ext:event`. The method names here are the API's; main's
 * dispatch table is checked against them, so a method in the types with no
 * row in main does not compile.
 */

export const EXT_CALL_CHANNEL = "pistachio-ext:call";
export const EXT_EVENT_CHANNEL = "pistachio-ext:event";
/**
 * Where main reaches the capture guard: a property of the preload's isolated world (never the page's), holding the
 * guard's functions as `contextBridge.executeInMainWorld` handed them back — `live()` and `end(source?)`.
 */
export const EXT_GUARD_KEY = "__pistachioGuard";
/** Electron's world for a context-isolated preload (`executeJavaScriptInIsolatedWorld`'s documented id). */
export const EXT_ISOLATED_WORLD = 999;

export const EXT_METHOD_NAMES = [
  // runtime
  "runtime.info",
  "runtime.sendMessage",
  "runtime.connect",
  "runtime.keepAlive",
  "runtime.release",
  "runtime.done",
  "runtime.log",
  // storage
  "storage.get",
  "storage.set",
  "storage.remove",
  // settings
  "settings.get",
  // ui
  "ui.openPanel",
  "ui.closePanel",
  "ui.openPage",
  "ui.toast",
  "ui.setBadge",
  "ui.setStatus",
  "ui.preferredSize",
  // tabs, spaces, desk, pages
  "tabs.query",
  "tabs.get",
  "tabs.create",
  "tabs.navigate",
  "tabs.show",
  "tabs.close",
  "spaces.list",
  "spaces.current",
  "desk.state",
  "pages.read",
  "pages.screenshot",
  // capture, input
  "capture.sources",
  "capture.arm",
  "capture.hold",
  "capture.release",
  "input.subscribe",
  "input.stop",
  // files
  "files.pick",
  "files.save",
  "files.reveal",
  "files.data.open",
  "files.data.write",
  "files.data.close",
  "files.data.read",
  "files.data.list",
  "files.data.remove",
  "files.data.freeSpace",
  "files.startDrag",
  // clipboard, notifications, net, notes, agent, power
  "clipboard.write",
  "clipboard.readText",
  "notifications.show",
  "net.fetch",
  "notes.list",
  "notes.search",
  "notes.read",
  "notes.create",
  "notes.update",
  "agent.ask",
  "power.preventSleep",
  "power.release",
  // subscriptions (the event channel carries what they ask for)
  "events.on",
  "events.off",
] as const;

export type ExtMethod = (typeof EXT_METHOD_NAMES)[number];

export function isExtMethod(value: unknown): value is ExtMethod {
  return typeof value === "string" && (EXT_METHOD_NAMES as readonly string[]).includes(value);
}

export const EXT_EVENT_NAMES = [
  "storage.changed",
  "settings.changed",
  "tabs.created",
  "tabs.updated",
  "tabs.removed",
  "tabs.activated",
  "spaces.currentChanged",
  "desk.changed",
  "input.event",
  "capture.ended",
  "runtime.message",
  "runtime.connect",
] as const;

export type ExtEvent = (typeof EXT_EVENT_NAMES)[number];

export function isExtEvent(value: unknown): value is ExtEvent {
  return typeof value === "string" && (EXT_EVENT_NAMES as readonly string[]).includes(value);
}

export const EXT_ERROR_CODES = ["PERMISSION_DENIED", "NOT_FOUND", "INVALID_ARGUMENT", "UNAVAILABLE", "TIMEOUT", "RATE_LIMITED", "CANCELLED"] as const;
export type ExtErrorCode = (typeof EXT_ERROR_CODES)[number];

/** A call's answer. */
export type ExtReply = { ok: true; v: unknown } | { ok: false; code: ExtErrorCode; message: string };

/** What main invokes in a worker: a declared tool, Bar command, menu item, key command, the icon's action, or a message from another context. */
export type ExtInvokeKind = "tool" | "bar" | "menu" | "key" | "action" | "message" | "statusAction" | "installed";

/** Everything the event channel carries. */
export type ExtEventMessage =
  | { kind: "event"; subscription: number; e: ExtEvent; v: unknown }
  | { kind: "invoke"; id: number; invoke: ExtInvokeKind; name: string; v: unknown }
  | { kind: "reload" };

export class ExtError extends Error {
  readonly code: ExtErrorCode;
  constructor(code: ExtErrorCode, message: string) {
    super(message);
    this.name = "ExtError";
    this.code = code;
  }
}

/** The per-method limits main enforces (calls per minute). */
export const EXT_RATE_LIMITS: Partial<Record<ExtMethod, number>> = {
  "ui.toast": 10,
  "notifications.show": 10,
  "agent.ask": 10,
  "net.fetch": 600,
  "tabs.create": 30,
  "pages.read": 120,
  "pages.screenshot": 60,
  "notes.create": 30,
  "notes.update": 60,
};

/** How long main waits for a handler before `TIMEOUT` (ms). */
export const EXT_HANDLER_TIMEOUTS: Record<ExtInvokeKind, number> = {
  tool: 30_000,
  bar: 10_000,
  menu: 5_000,
  key: 5_000,
  action: 5_000,
  message: 10_000,
  statusAction: 5_000,
  installed: 5_000,
};
