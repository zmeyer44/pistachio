import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveInputEvent } from "../src/index.js";
import { attachWindowInput } from "../src/react/index.js";

/**
 * A guest's hands on a window (`attachWindowInput`) over a stand-in DOM —
 * Node's own EventTarget for the page box, the keyboard's textarea, the
 * document and the browser window: what goes out as `lv.input`, what is let
 * go when the keyboard or the browser window leaves the page, and what is let
 * go again once the host hears the guest after a drop. The real page is
 * proved by apps/desktop/e2e/tests/live-share-guest.spec.ts.
 */

class FakeDocument extends EventTarget {
  activeElement: unknown = null;
  visibilityState: DocumentVisibilityState = "visible";
}

/** The hidden textarea that holds the keyboard: focus and blur as the browser fires them. */
class FakeTextarea extends EventTarget {
  readonly style = { transform: "" };
  value = "";
  constructor(private readonly doc: FakeDocument) {
    super();
  }
  focus(): void {
    if (this.doc.activeElement === this) return;
    this.doc.activeElement = this;
    this.dispatchEvent(new Event("focus"));
  }
  blur(): void {
    if (this.doc.activeElement !== this) return;
    this.doc.activeElement = null;
    this.dispatchEvent(new Event("blur"));
  }
}

class FakePage extends EventTarget {
  readonly #captured = new Set<number>();
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 800, height: 600 };
  }
  setPointerCapture(id: number): void {
    this.#captured.add(id);
  }
  hasPointerCapture(id: number): boolean {
    return this.#captured.has(id);
  }
  releasePointerCapture(id: number): void {
    this.#captured.delete(id);
  }
}

const noModifiers = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false };

function keyEvent(type: "keydown" | "keyup", key: string, code: string, modifiers: Partial<typeof noModifiers> = {}): Event {
  return Object.assign(new Event(type, { cancelable: true }), { key, code, repeat: false, isComposing: false, ...noModifiers, ...modifiers });
}

function pointerEvent(type: "pointerdown" | "pointerup", clientX: number, clientY: number): Event {
  return Object.assign(new Event(type, { cancelable: true }), { pointerId: 1, button: 0, buttons: type === "pointerdown" ? 1 : 0, clientX, clientY, ...noModifiers });
}

let doc: FakeDocument;
let browserWindow: EventTarget;
let page: FakePage;
let keys: FakeTextarea;
let sent: LiveInputEvent[];
let detach: () => void;
let reconnected: Set<() => void>;

/** The host hears the guest again after a drop (its list of the guests, on the guest page). */
function reconnect(): void {
  for (const listener of reconnected) listener();
}

beforeEach(() => {
  doc = new FakeDocument();
  browserWindow = new EventTarget();
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", browserWindow);
  vi.stubGlobal("requestAnimationFrame", (run: () => void) => setTimeout(run, 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  page = new FakePage();
  keys = new FakeTextarea(doc);
  sent = [];
  reconnected = new Set();
  detach = attachWindowInput({
    page: page as unknown as HTMLElement,
    keys: keys as unknown as HTMLTextAreaElement,
    usable: () => true,
    send: (event) => sent.push(event),
    onKeyboard: () => undefined,
    onReconnected: (listener) => {
      reconnected.add(listener);
      return () => reconnected.delete(listener);
    },
  });
});

afterEach(() => {
  detach();
  vi.unstubAllGlobals();
});

const keyUps = () => sent.filter((event) => event.type === "keyUp");

describe("a guest's keys on a window", () => {
  it("are let go when the textarea loses the keyboard (the chat, another window), each whose press went out and was not released", () => {
    keys.focus();
    keys.dispatchEvent(keyEvent("keydown", "a", "KeyA"));
    keys.dispatchEvent(keyEvent("keydown", "Meta", "MetaLeft", { metaKey: true }));
    keys.dispatchEvent(keyEvent("keydown", "b", "KeyB"));
    keys.dispatchEvent(keyEvent("keyup", "b", "KeyB"));
    expect(keyUps()).toEqual([{ type: "keyUp", key: "b", code: "KeyB", modifiers: [] }]);
    sent = [];
    // A press on the chat: the keyup of a and ⌘ lands there, never here.
    keys.blur();
    expect(sent).toEqual([
      { type: "keyUp", key: "a", code: "KeyA", modifiers: [] },
      { type: "keyUp", key: "Meta", code: "MetaLeft", modifiers: ["meta"] },
    ]);
    // Let go once.
    browserWindow.dispatchEvent(new Event("blur"));
    expect(sent).toHaveLength(2);
  });

  it("and the button are let go when the browser window loses focus or the tab is hidden", () => {
    page.dispatchEvent(pointerEvent("pointerdown", 400, 300));
    keys.dispatchEvent(keyEvent("keydown", "Shift", "ShiftLeft", { shiftKey: true }));
    expect(doc.activeElement).toBe(keys);
    sent = [];
    // ⌘Tab mid-drag: the button's and the key's releases go to another app.
    browserWindow.dispatchEvent(new Event("blur"));
    expect(sent).toEqual([
      { type: "mouseUp", x: 0.5, y: 0.5, button: "left", buttons: 0, clickCount: 1, modifiers: [] },
      { type: "keyUp", key: "Shift", code: "ShiftLeft", modifiers: ["shift"] },
    ]);
    // The pointer's own release, should it come after, is nothing more.
    page.dispatchEvent(pointerEvent("pointerup", 400, 300));
    expect(sent).toHaveLength(2);

    sent = [];
    keys.dispatchEvent(keyEvent("keydown", "c", "KeyC"));
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(keyUps()).toEqual([{ type: "keyUp", key: "c", code: "KeyC", modifiers: [] }]);
  });

  it("are let go when the window's input is taken down (the window gone, the room left), and nothing is heard after", () => {
    keys.focus();
    keys.dispatchEvent(keyEvent("keydown", "d", "KeyD"));
    sent = [];
    detach();
    expect(sent).toEqual([{ type: "keyUp", key: "d", code: "KeyD", modifiers: [] }]);
    keys.dispatchEvent(keyEvent("keydown", "e", "KeyE"));
    browserWindow.dispatchEvent(new Event("blur"));
    expect(sent).toHaveLength(1);
  });
});

describe("after a drop", () => {
  it("lets go again of each key and the button let go of, whose release the host may have missed, but of nothing pressed again since", () => {
    page.dispatchEvent(pointerEvent("pointerdown", 400, 300));
    page.dispatchEvent(pointerEvent("pointerup", 200, 150));
    keys.dispatchEvent(keyEvent("keydown", "a", "KeyA"));
    keys.dispatchEvent(keyEvent("keyup", "a", "KeyA"));
    keys.dispatchEvent(keyEvent("keydown", "Shift", "ShiftLeft", { shiftKey: true }));
    keys.dispatchEvent(keyEvent("keydown", "B", "KeyB", { shiftKey: true }));
    keys.dispatchEvent(keyEvent("keyup", "B", "KeyB", { shiftKey: true }));
    sent = [];
    // Each as it went, where the button was let go; Shift, still held, is the guest's to let go.
    reconnect();
    const released: LiveInputEvent[] = [
      { type: "mouseUp", x: 0.25, y: 0.25, button: "left", buttons: 0, clickCount: 1, modifiers: [] },
      { type: "keyUp", key: "a", code: "KeyA", modifiers: [] },
      { type: "keyUp", key: "B", code: "KeyB", modifiers: ["shift"] },
    ];
    expect(sent).toEqual(released);
    // Again after each drop: what was sent again may have been lost too.
    sent = [];
    reconnect();
    expect(sent).toEqual(released);
    // The button and a, pressed again, are down.
    page.dispatchEvent(pointerEvent("pointerdown", 400, 300));
    keys.dispatchEvent(keyEvent("keydown", "a", "KeyA"));
    sent = [];
    reconnect();
    expect(sent).toEqual([{ type: "keyUp", key: "B", code: "KeyB", modifiers: ["shift"] }]);
  });

  it("lets go again of what was let go as the browser window left the page, and of nothing once the input is taken down", () => {
    page.dispatchEvent(pointerEvent("pointerdown", 400, 300));
    keys.dispatchEvent(keyEvent("keydown", "d", "KeyD"));
    sent = [];
    browserWindow.dispatchEvent(new Event("blur"));
    const letGo = sent;
    expect(letGo).toEqual([
      { type: "mouseUp", x: 0.5, y: 0.5, button: "left", buttons: 0, clickCount: 1, modifiers: [] },
      { type: "keyUp", key: "d", code: "KeyD", modifiers: [] },
    ]);
    sent = [];
    reconnect();
    expect(sent).toEqual(letGo);
    detach();
    sent = [];
    reconnect();
    expect(sent).toEqual([]);
  });
});
