import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtInputEvent } from "@pistachio/extension-api";
import { classifyKey, INPUT_BATCH_MS, InputTaps, onView, parsePreloadInput, screenToView, type InputHost, type TapContents, type TapFrame } from "../src/main/extensions/input";

describe("a key, with nothing typed in it", () => {
  it("is a char for a key that types — and says nothing more", () => {
    for (const facts of [{ key: "a", code: "KeyA" }, { key: "A", code: "KeyA", shift: true }, { key: "7", code: "Digit7" }, { key: "é", code: "KeyE", alt: true }, { key: "Dead", code: "KeyE", alt: true }]) {
      const kind = classifyKey(facts, "darwin");
      expect(kind, facts.key).toEqual({ kind: "char" });
      expect(Object.keys(kind!)).toEqual(["kind"]);
      expect(JSON.stringify(kind)).not.toContain(`"${facts.key}"`);
    }
  });

  it("is a nav for the keys that move and edit", () => {
    for (const key of ["ArrowLeft", "Enter", "Tab", "Escape", "Backspace", "Delete", "PageDown"]) expect(classifyKey({ key }, "darwin"), key).toEqual({ kind: "nav" });
    expect(classifyKey({ key: "Tab", shift: true }, "darwin")).toEqual({ kind: "nav" });
  });

  it("is a chord, labelled, with ⌘ or ⌃ (or a function key)", () => {
    expect(classifyKey({ key: "k", code: "KeyK", meta: true }, "darwin")).toEqual({ kind: "chord", chord: "⌘K" });
    expect(classifyKey({ key: "P", code: "KeyP", meta: true, shift: true }, "darwin")).toEqual({ kind: "chord", chord: "⇧⌘P" });
    expect(classifyKey({ key: "p", code: "KeyP", control: true, alt: true }, "darwin")).toEqual({ kind: "chord", chord: "⌃⌥P" });
    expect(classifyKey({ key: "ArrowLeft", meta: true }, "darwin")).toEqual({ kind: "chord", chord: "⌘←" });
    expect(classifyKey({ key: "F5" }, "darwin")).toEqual({ kind: "chord", chord: "F5" });
    expect(classifyKey({ key: "k", code: "KeyK", control: true }, "other")).toEqual({ kind: "chord", chord: "Ctrl+K" });
    // Option alone with a letter types on a Mac; elsewhere it is a chord.
    expect(classifyKey({ key: "å", code: "KeyA", alt: true }, "darwin")).toEqual({ kind: "char" });
    expect(classifyKey({ key: "a", code: "KeyA", alt: true }, "other")).toEqual({ kind: "chord", chord: "Alt+A" });
  });

  it("is nothing for a modifier alone", () => {
    for (const key of ["Shift", "Meta", "Control", "Alt", "CapsLock"]) expect(classifyKey({ key }, "darwin")).toBeNull();
  });
});

describe("screen → view", () => {
  it("takes the window's content origin and the view's off the OS pointer", () => {
    expect(screenToView({ x: 500, y: 300 }, { x: 100, y: 50 }, { x: 40, y: 60 })).toEqual({ x: 360, y: 190 });
    expect(onView({ x: 360, y: 190 }, { width: 800, height: 600 })).toBe(true);
    expect(onView({ x: -1, y: 190 }, { width: 800, height: 600 })).toBe(false);
    expect(onView({ x: 800, y: 0 }, { width: 800, height: 600 })).toBe(false);
  });
});

describe("the preload's word", () => {
  it("takes the shapes it expects, and nothing else", () => {
    expect(parsePreloadInput({ k: "down", x: 1, y: 2, button: "left", target: { x: 0, y: 0, w: 10, h: 10, role: "button" }, z: 1 })).toMatchObject({ k: "down", target: { role: "button" } });
    expect(parsePreloadInput({ k: "down", x: 1, y: 2, button: "thumb" })).toBeNull();
    expect(parsePreloadInput({ k: "focus", rect: null, secret: 1 })).toEqual({ k: "focus", rect: null, secret: false, z: 1 });
    expect(parsePreloadInput({ k: "caret", rect: { x: 1, y: 1, w: -3, h: 1 } })).toBeNull();
    expect(parsePreloadInput({ k: "key", key: "a" })).toBeNull();
    expect(parsePreloadInput("down")).toBeNull();
  });
});

/* ------------------------------ the taps ------------------------------ */

class FakeFrame implements TapFrame {
  readonly sent: unknown[][] = [];
  readonly framesInSubtree: TapFrame[] = [this];
  constructor(
    readonly processId: number,
    readonly routingId: number,
  ) {}
  send(channel: string, ...args: unknown[]): void {
    this.sent.push([channel, ...args]);
  }
}

class FakeContents extends EventEmitter {
  readonly id = 7;
  readonly mainFrame = new FakeFrame(1, 1);
  url = "https://example.com/";
  title = "Example";
  isDestroyed(): boolean {
    return false;
  }
  getURL(): string {
    return this.url;
  }
  getTitle(): string {
    return this.title;
  }
  isLoading(): boolean {
    return false;
  }
}

function setup(options: { pointer?: { x: number; y: number } | null; focused?: () => boolean } = {}) {
  const contents = new FakeContents();
  let now = 1_000;
  const host: InputHost = {
    contents: () => contents as unknown as TapContents,
    exists: () => true,
    view: () => ({ bounds: { x: 100, y: 50, width: 800, height: 600 }, visible: true }),
    pointer: () => options.pointer ?? null,
    ...(options.focused === undefined ? {} : { focused: options.focused }),
    now: () => now,
    platform: "darwin",
  };
  const taps = new InputTaps(host);
  const batches: ExtInputEvent[][] = [];
  taps.subscribe({ id: 1, extensionId: "dev.x", tabId: "t1", kinds: null, deliver: (events) => batches.push(events) });
  const all = (): ExtInputEvent[] => batches.flat();
  const advance = (ms: number): void => {
    now += ms;
    vi.advanceTimersByTime(ms);
  };
  const key = (input: Partial<Electron.Input>): void => void contents.emit("before-input-event", {}, { type: "keyDown", ...input });
  const mouse = (input: Partial<Electron.MouseInputEvent>): void => void contents.emit("before-mouse-event", {}, { x: 0, y: 0, ...input });
  return { contents, taps, batches, all, advance, key, mouse, setNow: (ms: number) => (now = ms) };
}

describe("an input subscription", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("tells the page's frames to report while it lasts, and stops them after", () => {
    const { contents, taps } = setup();
    expect(contents.mainFrame.sent).toContainEqual(["pistachio:extension-input-on", true]);
    taps.stop(1);
    expect(contents.mainFrame.sent.at(-1)).toEqual(["pistachio:extension-input-on", false]);
    expect(contents.listenerCount("before-input-event")).toBe(0);
    taps.dispose();
  });

  it("opens with where the view is and what it shows, then batches what happens every 50 ms, in order", () => {
    const { all, batches, advance, mouse, key, taps } = setup();
    advance(INPUT_BATCH_MS);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((event) => event.k)).toEqual(["box", "nav", "load"]);
    for (let i = 0; i < 5; i += 1) {
      mouse({ type: "mouseMove", x: 10 + i, y: 20 });
      advance(4);
    }
    key({ key: "a", code: "KeyA" });
    expect(batches).toHaveLength(1);
    advance(INPUT_BATCH_MS);
    expect(batches).toHaveLength(2);
    expect(batches[1]!.map((event) => event.k)).toEqual(["move", "move", "move", "move", "move", "key"]);
    expect(all().filter((event) => event.k === "move").map((event) => (event as { x: number }).x)).toEqual([10, 11, 12, 13, 14]);
    taps.dispose();
  });

  it("never says the character: a key is its kind alone", () => {
    const { all, advance, key, taps } = setup();
    key({ key: "s", code: "KeyS" });
    key({ key: "k", code: "KeyK", meta: true });
    key({ key: "Enter", code: "Enter" });
    key({ key: "Shift", code: "ShiftLeft" });
    advance(INPUT_BATCH_MS);
    const keys = all().filter((event) => event.k === "key");
    expect(keys).toEqual([
      { t: expect.any(Number), k: "key", kind: "char" },
      { t: expect.any(Number), k: "key", kind: "chord", chord: "⌘K" },
      { t: expect.any(Number), k: "key", kind: "nav" },
    ]);
    expect(JSON.stringify(keys)).not.toMatch(/"s"|KeyS/);
    taps.dispose();
  });

  it("says nothing of keys or the caret while a secret field has focus — in any frame", () => {
    const { contents, all, advance, key, taps } = setup();
    // (The secret frame is one of the page's: a frame gone from the page says no focusout, and its word is pruned.)
    contents.mainFrame.framesInSubtree.push(new FakeFrame(2, 9));
    taps.fromPreload(7, { processId: 2, routingId: 9 }, false, { k: "focus", rect: { x: 0, y: 0, w: 100, h: 20 }, secret: true, z: 1 });
    key({ key: "h", code: "KeyH" });
    key({ key: "Enter", code: "Enter" });
    key({ key: "v", code: "KeyV", meta: true });
    taps.fromPreload(7, { processId: 1, routingId: 1 }, true, { k: "caret", rect: { x: 5, y: 5, w: 1, h: 16 }, z: 1 });
    // Another frame's field getting focus does not lift the first frame's secret.
    taps.fromPreload(7, { processId: 1, routingId: 1 }, true, { k: "focus", rect: { x: 0, y: 0, w: 100, h: 20 }, secret: false, z: 1 });
    key({ key: "i", code: "KeyI" });
    advance(INPUT_BATCH_MS);
    expect(all().filter((event) => event.k === "key" || event.k === "caret")).toEqual([]);
    expect(all().filter((event) => event.k === "focus").map((event) => (event as { secret: boolean }).secret)).toEqual([true, false]);
    // The secret frame's focus leaves its field: keys are kinds again.
    taps.fromPreload(7, { processId: 2, routingId: 9 }, false, { k: "focus", rect: null, secret: false, z: 1 });
    key({ key: "j", code: "KeyJ" });
    advance(INPUT_BATCH_MS);
    expect(all().filter((event) => event.k === "key")).toEqual([{ t: expect.any(Number), k: "key", kind: "char" }]);
    taps.dispose();
  });

  it("lifts a secret frame's silence once the frame is gone from the page — it says no focusout", () => {
    const { contents, taps, all, advance, key } = setup();
    const frame = new FakeFrame(2, 9);
    contents.mainFrame.framesInSubtree.push(frame);
    taps.fromPreload(7, { processId: 2, routingId: 9 }, false, { k: "focus", rect: { x: 0, y: 0, w: 100, h: 20 }, secret: true, z: 1 });
    key({ key: "a", code: "KeyA" });
    advance(100);
    expect(all().filter((event) => event.k === "key")).toHaveLength(0);
    // The iframe is removed: no focusout ever comes. Its word no longer holds.
    contents.mainFrame.framesInSubtree.splice(contents.mainFrame.framesInSubtree.indexOf(frame), 1);
    key({ key: "b", code: "KeyB" });
    advance(100);
    expect(all().filter((event) => event.k === "key")).toHaveLength(1);
  });

  it("holds a press for its page's word on what was pressed, and keeps what follows behind it", () => {
    const { all, advance, mouse, taps } = setup();
    mouse({ type: "mouseDown", x: 250, y: 140, button: "left" });
    mouse({ type: "mouseMove", x: 251, y: 140 });
    advance(INPUT_BATCH_MS);
    expect(all().some((event) => event.k === "down" || event.k === "move")).toBe(false);
    // The main frame's word: the element's rect in its CSS px, at zoom 1.25 → the view's px.
    taps.fromPreload(7, { processId: 1, routingId: 1 }, true, { k: "down", x: 200, y: 112, button: "left", target: { x: 180, y: 100, w: 80, h: 32, role: "button" }, z: 1.25 });
    advance(INPUT_BATCH_MS);
    const [down, move] = all().filter((event) => event.k === "down" || event.k === "move");
    expect(down).toMatchObject({ k: "down", x: 250, y: 140, button: "left", target: { x: 225, y: 125, w: 100, h: 40, role: "button" } });
    expect(move).toMatchObject({ k: "move", x: 251 });
    taps.dispose();
  });

  it("finds where a frame of another site lies from its press, and places its rects by it", () => {
    const { all, advance, mouse, taps } = setup();
    mouse({ type: "mouseDown", x: 250, y: 140, button: "left" });
    // The frame's own coordinates: the press at (50, 40) in it, its button at (20, 30).
    taps.fromPreload(7, { processId: 2, routingId: 5 }, false, { k: "down", x: 50, y: 40, button: "left", target: { x: 20, y: 30, w: 100, h: 40, role: "button" }, z: 1 });
    taps.fromPreload(7, { processId: 2, routingId: 5 }, false, { k: "focus", rect: { x: 10, y: 10, w: 200, h: 24 }, secret: false, z: 1 });
    advance(INPUT_BATCH_MS);
    expect(all().find((event) => event.k === "down")).toMatchObject({ target: { x: 220, y: 130, w: 100, h: 40 } });
    expect(all().find((event) => event.k === "focus")).toMatchObject({ rect: { x: 210, y: 110, w: 200, h: 24 } });
    taps.dispose();
  });

  it("lets a press main never heard (a frame of another site's) be placed by the OS pointer", () => {
    // The pointer at (350, 190) in the window's content box: (250, 140) on the view at (100, 50).
    const { all, advance, taps } = setup({ pointer: { x: 350, y: 190 } });
    taps.fromPreload(7, { processId: 2, routingId: 5 }, false, { k: "down", x: 50, y: 40, button: "left", target: { x: 20, y: 30, w: 100, h: 40, role: "button" }, z: 1 });
    advance(INPUT_BATCH_MS);
    expect(all().find((event) => event.k === "down")).toMatchObject({ x: 250, y: 140, target: { x: 220, y: 130 } });
    taps.dispose();
  });

  it("reads nothing from the OS pointer while another application is in front: a pointer over the window's place is that application's", () => {
    const { all, advance, taps } = setup({ pointer: { x: 150, y: 80 }, focused: () => false });
    advance(100);
    expect(all().filter((event) => event.k === "move")).toEqual([]);
    taps.dispose();
  });

  it("fills the moves' gaps from the OS pointer while it is over the view, and says when the view's box changes", () => {
    const pointer = { x: 150, y: 80 };
    const { all, advance, taps } = setup({ pointer });
    advance(100);
    const moves = all().filter((event) => event.k === "move");
    expect(moves[0]).toMatchObject({ x: 50, y: 30 });
    // (Still: said once.)
    expect(moves).toHaveLength(1);
    pointer.x = 2_000;
    advance(100);
    expect(all().filter((event) => event.k === "move")).toHaveLength(1);
    taps.dispose();
  });

  it("asks for only what it subscribed to", () => {
    const contents = new FakeContents();
    let now = 0;
    const taps = new InputTaps({
      contents: () => contents as unknown as TapContents,
      exists: () => true,
      view: () => ({ bounds: { x: 0, y: 0, width: 100, height: 100 }, visible: true }),
      pointer: () => null,
      now: () => now,
      platform: "darwin",
    });
    const got: ExtInputEvent[] = [];
    taps.subscribe({ id: 2, extensionId: "dev.x", tabId: "t1", kinds: new Set(["key"]), deliver: (events) => got.push(...events) });
    contents.emit("before-mouse-event", {}, { type: "mouseMove", x: 1, y: 1 });
    contents.emit("before-input-event", {}, { type: "keyDown", key: "a", code: "KeyA" });
    now += INPUT_BATCH_MS;
    vi.advanceTimersByTime(INPUT_BATCH_MS);
    expect(got.map((event) => event.k)).toEqual(["key"]);
    taps.dispose();
  });

  it("ends a tab's subscriptions when the tab is gone", () => {
    const contents = new FakeContents();
    let exists = true;
    const ended = vi.fn();
    const taps = new InputTaps(
      { contents: () => (exists ? (contents as unknown as TapContents) : null), exists: () => exists, view: () => null, pointer: () => null, now: () => 0, platform: "darwin" },
      ended,
    );
    taps.subscribe({ id: 3, extensionId: "dev.x", tabId: "t1", kinds: null, deliver: () => undefined });
    exists = false;
    taps.refresh();
    expect(ended).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }), "closed");
    expect(taps.subscribers()).toEqual([]);
    expect(contents.listenerCount("before-mouse-event")).toBe(0);
  });
});
