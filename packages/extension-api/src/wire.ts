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
  "tabs.setMark",
  "spaces.list",
  "spaces.current",
  "spaces.sendAway",
  "spaces.bringBack",
  "spaces.close",
  "spaces.create",
  "spaces.away",
  "spaces.setMark",
  // the theme (docs/primitives.md §4): a backdrop and an accent the shell draws, for every space or one
  "theme.set",
  "theme.clear",
  "theme.get",
  // the places it fills with rows (docs/primitives.md §4.5): the band beside the Bar, a section of the sidebar
  "sites.set",
  "sites.clear",
  "sites.get",
  // triggers (pistachio.json → triggers; main keeps the clock)
  "triggers.get",
  "triggers.list",
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
  "ai.complete",
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
  "spaces.awayChanged",
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

/**
 * What main invokes in a worker: a declared tool, Bar command, menu item, key command, the icon's action, a message
 * from another context, a press on a row it has the shell showing (`press`: docs/primitives.md §4.5) — or a declared
 * trigger, the one kind nobody's hand is behind (docs/primitives.md §3).
 */
export type ExtInvokeKind = "tool" | "bar" | "menu" | "key" | "action" | "message" | "statusAction" | "press" | "installed" | "trigger";

/** The kinds a person is behind: their command, their menu, their key, their click, the agent's turn they asked for. */
export const EXT_ATTENDED_KINDS: readonly ExtInvokeKind[] = ["tool", "bar", "menu", "key", "action", "statusAction", "press"];

/**
 * What a worker may call **unattended** — while a trigger's handler runs and nobody's hand is on the extension
 * (docs/primitives.md §3): it may read, keep its own state, tell the person, talk to its hosts, send away or bring
 * back a space it was given, make a space behind what is in front, and open a tab there — the writes main can undo. Everything else waits for the person: a toast
 * with an action is how a trigger asks for them. A method not listed here is refused then, so a method added later
 * is closed until someone decides it is safe with nobody there.
 */
export const EXT_UNATTENDED_METHODS: readonly ExtMethod[] = [
  "runtime.info",
  "runtime.sendMessage",
  "runtime.done",
  "runtime.log",
  "storage.get",
  "storage.set",
  "storage.remove",
  "settings.get",
  "ui.toast",
  "ui.setBadge",
  "ui.setStatus",
  "notifications.show",
  "tabs.query",
  "tabs.get",
  // (A tab opened behind what is in front — never shown, a dozen an hour at most — and written in the journal: Undo closes it.)
  "tabs.create",
  // (A mark on a tab's row: the shell's drawing, under the extension's name, removed in one press.)
  "tabs.setMark",
  "spaces.list",
  "spaces.current",
  "spaces.sendAway",
  "spaces.bringBack",
  // (Close space, as the person's menu does it: filed in the archive, written in the journal — Undo restores it.)
  "spaces.close",
  // (A space made behind what is in front — never shown, a few an hour at most — and written in the journal: Undo closes it.)
  "spaces.create",
  "spaces.away",
  // (What the shell draws for it: kept by main, named as its own, removed by the person in one press — and a theme set
  // with nobody there is in the journal with its Undo.)
  "spaces.setMark",
  "theme.set",
  "theme.clear",
  "theme.get",
  // (Rows in the band and the sidebar: the shell's own drawing, under the extension's mark, removed in one press.)
  "sites.set",
  "sites.clear",
  "sites.get",
  "triggers.get",
  "triggers.list",
  "desk.state",
  "files.data.open",
  "files.data.write",
  "files.data.close",
  "files.data.read",
  "files.data.list",
  "files.data.remove",
  "files.data.freeSpace",
  "net.fetch",
  // (A question to a model: nothing of the person's changes, and a dozen an hour is the most it spends with nobody there.)
  "ai.complete",
  "events.on",
  "events.off",
];

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
  // (A loop that sends away what another brings back runs out of calls, not out of patience.)
  "spaces.sendAway": 20,
  "spaces.bringBack": 20,
  "spaces.close": 20,
  "spaces.create": 10,
  "ai.complete": 10,
  "spaces.setMark": 60,
  "tabs.setMark": 240,
  "theme.set": 20,
  // (A score that moves, a timer: once a second is as often as a row is worth saying again.)
  "sites.set": 60,
  "pages.read": 120,
  "pages.screenshot": 60,
  "notes.create": 30,
  "notes.update": 60,
};

/** `spaces.create`'s bounds (docs/primitives.md §2.7): how many pages a space is made with at most. */
export const SPACE_TABS_MAX = 12;
/** How many spaces an extension may make with nobody there, in any hour. */
export const SPACES_UNATTENDED_PER_HOUR = 4;

/** `ai.complete`'s bounds (docs/primitives.md §3.8): how much may be asked, and how long an answer may run. */
export const AI_PROMPT_MAX = 24_000;
export const AI_SYSTEM_MAX = 4_000;
export const AI_TOKENS_MIN = 16;
export const AI_TOKENS_MAX = 2_000;
export const AI_TOKENS_DEFAULT = 600;
/** How many questions an extension may ask a model with nobody there, in any hour. */
export const AI_UNATTENDED_PER_HOUR = 12;
/** How long an answer may take at most. */
export const AI_COMPLETE_TIMEOUT_MS = 20_000;
/**
 * Asked from a handler, how much of the handler's own time (EXT_HANDLER_TIMEOUTS) is kept back from the wait: the
 * answer — or UNAVAILABLE — must come while the handler can still act on it, not after main has given up on it.
 */
export const AI_HANDLER_MARGIN_MS = 1_500;
/** The least a model is given: with less than this left, nobody is asked. */
export const AI_COMPLETE_MIN_MS = 1_000;

/** How long main waits for a handler before `TIMEOUT` (ms). */
export const EXT_HANDLER_TIMEOUTS: Record<ExtInvokeKind, number> = {
  tool: 30_000,
  bar: 10_000,
  menu: 5_000,
  key: 5_000,
  action: 5_000,
  message: 10_000,
  statusAction: 5_000,
  press: 5_000,
  installed: 5_000,
  trigger: 10_000,
};
