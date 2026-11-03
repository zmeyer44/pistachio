import { describe, expect, it } from "vitest";
import type {
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
  ExtTab,
  ExtToast,
} from "../src/api-types.js";
import {
  EXT_CALL_CHANNEL,
  EXT_ERROR_CODES,
  EXT_EVENT_CHANNEL,
  EXT_EVENT_NAMES,
  EXT_HANDLER_TIMEOUTS,
  EXT_METHOD_NAMES,
  EXT_RATE_LIMITS,
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
] = [true, true, true, true, true, true, true, true, true, true, true, true, true];

/** Never called: it only has to compile against the global `pistachio` of pistachio.d.ts. */
async function authorCode(): Promise<void> {
  const tabs: Pistachio.Tab[] = await pistachio.tabs.query();
  const space = await pistachio.spaces.current();
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
    const kinds: ExtInvokeKind[] = ["tool", "bar", "menu", "key", "action", "message", "statusAction", "installed"];
    expect(Object.keys(EXT_HANDLER_TIMEOUTS).sort()).toEqual([...kinds].sort());
    expect(EXT_HANDLER_TIMEOUTS.tool).toBe(30_000);
    expect(EXT_HANDLER_TIMEOUTS.bar).toBe(10_000);
    expect(EXT_HANDLER_TIMEOUTS.menu).toBe(5_000);
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
