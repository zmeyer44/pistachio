import { describe, expect, it } from "vitest";
import type {
  ExtAwaySpace,
  ExtBackdrop,
  ExtBarCommandContext,
  ExtCaptureSource,
  ExtDataFile,
  ExtDeskState,
  ExtDeskWindow,
  ExtEventMap,
  ExtInputEvent,
  ExtInputEventKind,
  ExtInvokeMap,
  ExtMenuClick,
  ExtMethodMap,
  ExtNoteSummary,
  ExtSpace,
  ExtSpaceMark,
  ExtTab,
  ExtTheme,
  ExtToast,
  ExtTriggerState,
} from "../src/api-types.js";
import {
  EXT_ATTENDED_KINDS,
  EXT_CALL_CHANNEL,
  EXT_ERROR_CODES,
  EXT_EVENT_CHANNEL,
  EXT_EVENT_NAMES,
  EXT_HANDLER_TIMEOUTS,
  EXT_METHOD_NAMES,
  EXT_RATE_LIMITS,
  EXT_UNATTENDED_METHODS,
  ExtError,
  isExtEvent,
  isExtMethod,
  type ExtErrorCode,
  type ExtEvent,
  type ExtInvokeKind,
  type ExtMethod,
} from "../src/wire.js";

// ── Type-level: checked by `tsc` (the package's check-types), asserted true at runtime too ──

/** Each assignable to the other. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// Every method name has a row in ExtMethodMap and every row is a method: a method main must
// answer cannot be missing from the wire's types, nor a typed method from the names.
const methodsInStep: Same<ExtMethod, keyof ExtMethodMap> = true;
const eventsInStep: Same<ExtEvent, keyof ExtEventMap> = true;
const invokesInStep: Same<ExtInvokeKind, keyof ExtInvokeMap> = true;
const codesInStep: Same<Pistachio.ExtError["code"], ExtErrorCode> = true;

// pistachio.d.ts (what authors see) declares the same shapes as api-types.ts (what the wire carries).
const shapesInStep: [
  Same<Pistachio.Tab, ExtTab>,
  Same<Pistachio.Space, ExtSpace>,
  Same<Pistachio.AwaySpace, ExtAwaySpace>,
  Same<Pistachio.TriggerState, ExtTriggerState>,
  Same<Pistachio.Backdrop, ExtBackdrop>,
  Same<Pistachio.Theme, ExtTheme>,
  Same<Pistachio.SpaceMark, ExtSpaceMark>,
  Same<Pistachio.DeskWindow, ExtDeskWindow>,
  Same<Pistachio.DeskState, ExtDeskState>,
  Same<Pistachio.CaptureSource, ExtCaptureSource>,
  Same<Pistachio.InputEventKind, ExtInputEventKind>,
  Same<Pistachio.InputEvent, ExtInputEvent>,
  Same<Pistachio.DataFile, ExtDataFile>,
  Same<Pistachio.NoteSummary, ExtNoteSummary>,
  Same<Pistachio.MenuClick, ExtMenuClick>,
  Same<Pistachio.BarCommandContext, ExtBarCommandContext>,
  Same<Parameters<Pistachio.Ui["toast"]>[0], ExtToast>,
  Same<Pistachio.Json, import("../src/api-types.js").Json>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true];

/** Never called: it only has to compile against the global `pistachio` of pistachio.d.ts. */
async function authorCode(): Promise<void> {
  const sunday: Pistachio.TriggerState = await pistachio.triggers.get("sunday");
  pistachio.triggers.on("sunday", async (state) => (state.kind === "during" && state.holds ? pistachio.spaces.bringBack("s") : pistachio.spaces.sendAway("s")));
  void [sunday.kind === "during" ? sunday.changesAt : sunday.kind === "when" ? sunday.known : sunday.kind === "on" ? sunday.events.length : sunday.next, (await pistachio.triggers.list()).length];
  // What Tidy had and the API did not (docs/primitives.md §2.6, §3.8): when a space was last used and whose it is, the
  // verb that closes one into the archive, and one question to a model.
  pistachio.triggers.on("sweep", async () => {
    for (const space of await pistachio.spaces.list()) {
      if (space.byPerson || Date.now() - space.lastActiveAt < 12 * 60 * 60 * 1000) continue;
      const tabs: Pistachio.Tab[] = await pistachio.tabs.query({ spaceId: space.id });
      const about: string = await pistachio.ai.complete({ system: "Five words or fewer.", prompt: tabs.map((tab) => `${tab.title} ${String(tab.lastActiveAt)}`).join(", "), maxTokens: 30 });
      await pistachio.spaces.close(space.id);
      void about;
    }
  });
  pistachio.triggers.on("shown", async (state) => {
    if (state.kind !== "on") return;
    for (const event of state.events) if (event.tabId !== undefined) await pistachio.tabs.setMark(event.tabId, null);
    const unread: Pistachio.SpaceMark = { tone: "blue", label: "Not read yet" };
    await pistachio.tabs.setMark("t1", unread);
  });
  pistachio.triggers.on("opened", async (state) => {
    if (state.kind !== "on") return;
    const events: Pistachio.TriggerEvent[] = state.events;
    for (const event of events) if (event.tabId !== undefined) await pistachio.tabs.get(event.tabId);
  });
  pistachio.triggers.on("scores", async (state) => (state.kind === "every" && state.at !== null ? pistachio.ui.band.set({ rows: [{ text: "KC 21 – BUF 17" }] }) : undefined));
  pistachio.triggers.on("standup", async (state) => (state.kind === "when" && state.holds ? pistachio.spaces.bringBack("s") : undefined));
  pistachio.contextMenus.onClicked("here", async ({ spaceId }) => {
    if (spaceId === undefined) return;
    const stadium: Pistachio.Theme = { spaceId, backdrop: { image: "field.svg", dim: 0.2 }, colors: { accent: "#1f8a4c" } };
    await pistachio.theme.set(stadium);
    await pistachio.theme.set({ backdrop: { gradient: { colors: ["#0b3d2e", "#145c43"], angle: 160 } } });
    const mine: Pistachio.Theme | null = await pistachio.theme.get({ spaceId });
    await pistachio.spaces.setMark(spaceId, { glyph: "🏈", tone: "green", label: mine === null ? "Games off" : "Games on" });
    await pistachio.spaces.setMark(spaceId, null);
    await pistachio.theme.clear({ spaceId });
    await pistachio.theme.clear();
  });
  const tabs: Pistachio.Tab[] = await pistachio.tabs.query();
  const space = await pistachio.spaces.current();
  const gone: Pistachio.AwaySpace = await pistachio.spaces.sendAway(space?.id ?? "", { until: new Date(Date.now() + 60_000) });
  pistachio.spaces.onAwayChanged(({ event, space: changed }) => void [event, changed.mine, gone.until]);
  await pistachio.runtime.ready;
  const id: string = pistachio.runtime.id;
  const stream: MediaStream = await pistachio.capture.tab(tabs[0]?.id ?? "", { audio: true, scale: 2 });
  const port: Pistachio.Port = pistachio.runtime.connect();
  port.postMessage({ id, space: space?.name ?? null, tracks: stream.getTracks().length });
  const response = await pistachio.net.fetch("https://api.github.com/user");
  if (!response.ok) throw new Error(String(response.status));
  pistachio.agent.onToolCall<{ text: string }>("word_count", async ({ text }, { signal }) => ({ words: text.split(" ").length, aborted: signal.aborted }));
  const unsubscribe: Pistachio.Unsubscribe = pistachio.bar.onCommand("hello", ({ arg }) => ({ openPage: "hello", query: `name=${arg}` }));
  unsubscribe();
}

describe("the wire", () => {
  it("keeps the method, event and invocation names in step with their maps", () => {
    expect([methodsInStep, eventsInStep, invokesInStep, codesInStep, ...shapesInStep].every(Boolean)).toBe(true);
    expect(typeof authorCode).toBe("function");
  });

  it("names each method, event and code once", () => {
    expect(new Set(EXT_METHOD_NAMES).size).toBe(EXT_METHOD_NAMES.length);
    expect(new Set(EXT_EVENT_NAMES).size).toBe(EXT_EVENT_NAMES.length);
    expect(new Set(EXT_ERROR_CODES).size).toBe(EXT_ERROR_CODES.length);
  });

  it("tells methods and events from anything else", () => {
    expect(isExtMethod("tabs.query")).toBe(true);
    expect(isExtMethod("tabs.query ")).toBe(false);
    expect(isExtMethod("pistachio:tabs")).toBe(false);
    expect(isExtMethod(42)).toBe(false);
    expect(isExtEvent("tabs.created")).toBe(true);
    expect(isExtEvent("tabs.query")).toBe(false);
  });

  it("limits only real methods, and times out every kind of handler", () => {
    for (const method of Object.keys(EXT_RATE_LIMITS)) expect(isExtMethod(method), method).toBe(true);
    const kinds: ExtInvokeKind[] = ["tool", "bar", "menu", "key", "action", "message", "statusAction", "press", "installed", "trigger"];
    expect(Object.keys(EXT_HANDLER_TIMEOUTS).sort()).toEqual([...kinds].sort());
    expect(EXT_HANDLER_TIMEOUTS.tool).toBe(30_000);
    expect(EXT_HANDLER_TIMEOUTS.bar).toBe(10_000);
    expect(EXT_HANDLER_TIMEOUTS.menu).toBe(5_000);
    expect(EXT_HANDLER_TIMEOUTS.trigger).toBe(10_000);
  });

  it("answers, with nobody there, only real methods — each once — and none that moves the person or cannot be undone", () => {
    for (const method of EXT_UNATTENDED_METHODS) expect(isExtMethod(method), method).toBe(true);
    expect(new Set(EXT_UNATTENDED_METHODS).size).toBe(EXT_UNATTENDED_METHODS.length);
    // The two writes main can undo, and the asking.
    for (const method of ["spaces.sendAway", "spaces.bringBack", "triggers.get", "triggers.list", "ui.toast", "storage.set", "net.fetch", "runtime.done"] as const) {
      expect(EXT_UNATTENDED_METHODS, method).toContain(method);
    }
    // And what the shell draws for it: values main keeps, the person removes in one press.
    for (const method of ["theme.set", "theme.clear", "theme.get", "spaces.setMark"] as const) {
      expect(EXT_METHOD_NAMES, method).toContain(method);
      expect(EXT_UNATTENDED_METHODS, method).toContain(method);
    }
    expect(EXT_RATE_LIMITS["theme.set"]).toBe(20);
    expect(EXT_RATE_LIMITS["spaces.setMark"]).toBe(60);
    // And the rows of the band and the sidebar: the shell's own drawing, under the extension's mark.
    for (const method of ["sites.set", "sites.clear", "sites.get"] as const) {
      expect(EXT_METHOD_NAMES, method).toContain(method);
      expect(EXT_UNATTENDED_METHODS, method).toContain(method);
    }
    expect(EXT_RATE_LIMITS["sites.set"]).toBe(60);
    // A tab opened behind what is in front: main writes it down, and Undo closes it (docs/primitives.md §3.7).
    expect(EXT_UNATTENDED_METHODS).toContain("tabs.create");
    // A space closed into the archive, journaled with its Undo; and a question to a model, a dozen an hour (§2.6, §3.8).
    for (const method of ["spaces.close", "ai.complete"] as const) {
      expect(EXT_METHOD_NAMES, method).toContain(method);
      expect(EXT_UNATTENDED_METHODS, method).toContain(method);
    }
    expect(EXT_RATE_LIMITS["spaces.close"]).toBe(20);
    expect(EXT_RATE_LIMITS["ai.complete"]).toBe(10);
    // Closed until someone decides otherwise: the person's tabs, their pages, their notes, their clipboard, the agent, a worker that stays.
    const closed = EXT_METHOD_NAMES.filter((method) => !EXT_UNATTENDED_METHODS.includes(method));
    for (const method of ["tabs.navigate", "tabs.show", "tabs.close", "ui.openPanel", "ui.openPage", "pages.read", "pages.screenshot", "notes.create", "notes.update", "notes.read", "clipboard.write", "clipboard.readText", "agent.ask", "capture.arm", "input.subscribe", "runtime.keepAlive", "power.preventSleep", "files.pick", "files.save"] as const) {
      expect(closed, method).toContain(method);
    }
  });

  it("counts a trigger as the one kind of invocation nobody is behind", () => {
    expect(EXT_ATTENDED_KINDS).not.toContain("trigger");
    // (A press on a row the shell draws for it is the person's hand, as a pill's action is.)
    expect([...EXT_ATTENDED_KINDS].sort()).toEqual(["action", "bar", "key", "menu", "press", "statusAction", "tool"]);
  });

  it("has its own two channels, outside the shell's pistachio:*", () => {
    expect(EXT_CALL_CHANNEL).toBe("pistachio-ext:call");
    expect(EXT_EVENT_CHANNEL).toBe("pistachio-ext:event");
    expect(EXT_CALL_CHANNEL.startsWith("pistachio:")).toBe(false);
  });

  it("makes errors that carry their code", () => {
    const error = new ExtError("PERMISSION_DENIED", 'notes.update needs "notes:write" in pistachio.json → permissions');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ExtError");
    expect(error.code).toBe("PERMISSION_DENIED");
  });
});
