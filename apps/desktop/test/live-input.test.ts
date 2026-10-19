/**
 * A guest's hands on a window (docs/live-share.md §6.1, §10): every refusal
 * the gate makes before an event reaches a page, the rate a guest is held
 * to, and what an accepted click, key and wheel become in the view's DIPs —
 * a press making the window the one in use and its guest the one using it —
 * and what no guest's page may send whatever it is: a button but the left,
 * a click with ⌘, Ctrl or Shift, a zooming wheel, one of the app's own keys.
 */

import { describe, expect, it } from "vitest";
import type { ElectronInputStep, LiveInputEvent, LiveModifier } from "@pistachio/live-share";
import { DEFAULT_SHORTCUTS } from "@pistachio/shell-contracts/shortcuts";
import { isAppShortcut, LIVE_INPUT_RATE, LiveInputGate, type LiveInputContext } from "../src/main/live/live-input";

function setup(overrides: Partial<LiveInputContext> = {}, viewSize: { width: number; height: number } | null = { width: 800, height: 600 }) {
  const sent: Array<{ tabId: string; steps: readonly ElectronInputStep[] }> = [];
  const activated: string[] = [];
  const used: Array<[string, string]> = [];
  let now = 1_000;
  const context: LiveInputContext = {
    isGuest: (identity) => identity === "g_ann",
    allowed: (windowId) => windowId !== "closed",
    window: (windowId) => (windowId === "off-desk" ? null : { streamed: windowId !== "cold", minimized: windowId === "mini", masked: windowId === "masked" }),
    hostPresent: () => true,
    ...overrides,
  };
  const gate = new LiveInputGate(
    context,
    {
      viewSize: () => viewSize,
      send: (tabId, steps) => {
        sent.push({ tabId, steps });
        return true;
      },
      activate: (tabId) => activated.push(tabId),
      isShortcut: (key) => isAppShortcut(DEFAULT_SHORTCUTS, "darwin", key),
    },
    (windowId, identity) => used.push([windowId, identity]),
    () => now,
  );
  return { gate, sent, activated, used, tick: (ms: number) => (now += ms) };
}

const click = (type: "mouseDown" | "mouseUp", x: number, y: number): LiveInputEvent => ({ type, x, y, button: "left", buttons: type === "mouseDown" ? 1 : 0, clickCount: 1, modifiers: [] });

describe("LiveInputGate", () => {
  it("refuses each event that may not reach its page, and says why", () => {
    const move: LiveInputEvent = { type: "mouseMove", x: 0.5, y: 0.5, buttons: 0, clickCount: 0, modifiers: [] };
    expect(setup().gate.apply("g_ann", "tab", { type: "mouseMove", x: 2 })).toBe("invalid");
    expect(setup().gate.apply("g_bob", "tab", move)).toBe("not-a-guest");
    expect(setup().gate.apply("host", "tab", move)).toBe("not-a-guest");
    expect(setup().gate.apply("g_ann", "closed", move)).toBe("not-allowed");
    expect(setup().gate.apply("g_ann", "off-desk", move)).toBe("not-streamed");
    expect(setup().gate.apply("g_ann", "cold", move)).toBe("not-streamed");
    expect(setup().gate.apply("g_ann", "mini", move)).toBe("minimized");
    expect(setup().gate.apply("g_ann", "masked", move)).toBe("masked");
    expect(setup({ hostPresent: () => false }).gate.apply("g_ann", "tab", move)).toBe("host-away");
    expect(setup({}, null).gate.apply("g_ann", "tab", move)).toBe("no-page");
    const refused = setup({ hostPresent: () => false });
    refused.gate.apply("g_ann", "tab", click("mouseDown", 0.5, 0.5));
    expect(refused.sent).toEqual([]);
    expect(refused.activated).toEqual([]);
  });

  it("sends a click at the page's point in view DIPs, the window put in use by the press and its guest using it", () => {
    const { gate, sent, activated, used } = setup();
    expect(gate.apply("g_ann", "tab", click("mouseDown", 0.25, 0.5))).toBeNull();
    expect(gate.apply("g_ann", "tab", click("mouseUp", 0.25, 0.5))).toBeNull();
    expect(sent.map(({ tabId, steps }) => [tabId, steps])).toEqual([
      ["tab", [{ type: "mouseDown", x: 200, y: 300, button: "left", clickCount: 1, modifiers: ["leftbuttondown"] }]],
      ["tab", [{ type: "mouseUp", x: 200, y: 300, button: "left", clickCount: 1, modifiers: [] }]],
    ]);
    expect(activated).toEqual(["tab"]);
    expect(used).toEqual([["tab", "g_ann"]]);
  });

  it("types with the guest's own char and scrolls the way the guest's wheel went", () => {
    const { gate, sent } = setup();
    gate.apply("g_ann", "tab", { type: "keyDown", key: "h", code: "KeyH", modifiers: [] });
    gate.apply("g_ann", "tab", { type: "char", text: "h" });
    gate.apply("g_ann", "tab", { type: "keyUp", key: "h", code: "KeyH", modifiers: [] });
    gate.apply("g_ann", "tab", { type: "insertText", text: "pasted" });
    gate.apply("g_ann", "tab", { type: "wheel", x: 0.5, y: 0.5, dx: 0, dy: 120, modifiers: [] });
    expect(sent.flatMap(({ steps }) => steps)).toEqual([
      { type: "keyDown", keyCode: "h", modifiers: [] },
      { type: "char", keyCode: "h", modifiers: [] },
      { type: "keyUp", keyCode: "h", modifiers: [] },
      { type: "insertText", text: "pasted" },
      // DOM's positive deltaY scrolls down; Chromium's positive deltaY scrolls up.
      { type: "mouseWheel", x: 400, y: 300, deltaX: -0, deltaY: -120, hasPreciseScrollingDeltas: true, canScroll: true, modifiers: [] },
    ]);
  });

  it("takes the left button alone: a right press would open the host's context menu, a middle one open tabs", () => {
    const { gate, sent, activated } = setup();
    const press = (button: "left" | "middle" | "right", buttons: number): LiveInputEvent => ({ type: "mouseDown", x: 0.5, y: 0.5, button, buttons, clickCount: 1, modifiers: [] });
    expect(gate.apply("g_ann", "tab", press("right", 2))).toBe("button");
    expect(gate.apply("g_ann", "tab", press("middle", 4))).toBe("button");
    expect(gate.apply("g_ann", "tab", { type: "mouseUp", x: 0.5, y: 0.5, button: "right", buttons: 0, clickCount: 1, modifiers: [] })).toBe("button");
    // A press or release must name its button; a move dragging another one is refused too.
    expect(gate.apply("g_ann", "tab", { type: "mouseDown", x: 0.5, y: 0.5, buttons: 1, clickCount: 1, modifiers: [] })).toBe("button");
    expect(gate.apply("g_ann", "tab", { type: "mouseMove", x: 0.5, y: 0.5, button: "right", buttons: 2, clickCount: 0, modifiers: [] })).toBe("button");
    expect(gate.apply("g_ann", "tab", { type: "mouseMove", x: 0.5, y: 0.5, buttons: 3, clickCount: 0, modifiers: [] })).toBe("button");
    expect(sent).toEqual([]);
    expect(activated).toEqual([]);
    // The left one, pressed or dragged, goes.
    expect(gate.apply("g_ann", "tab", press("left", 1))).toBeNull();
    expect(gate.apply("g_ann", "tab", { type: "mouseMove", x: 0.6, y: 0.5, button: "left", buttons: 1, clickCount: 0, modifiers: [] })).toBeNull();
  });

  it("takes no click with ⌘, Ctrl or Shift: Chromium would open the host's context menu, or a tab or window of the host's for a link", () => {
    const { gate, sent, activated, used } = setup();
    const at = (type: "mouseDown" | "mouseUp", modifiers: LiveModifier[]): LiveInputEvent => ({ type, x: 0.5, y: 0.5, button: "left", buttons: type === "mouseDown" ? 1 : 0, clickCount: 1, modifiers });
    for (const modifiers of [["control"], ["meta"], ["shift"], ["meta", "shift"], ["alt", "shift"], ["control", "alt"]] as const) {
      expect(gate.apply("g_ann", "tab", at("mouseDown", [...modifiers])), `press ${modifiers.join("+")}`).toBe("chord");
      expect(gate.apply("g_ann", "tab", at("mouseUp", [...modifiers])), `release ${modifiers.join("+")}`).toBe("chord");
    }
    expect(sent).toEqual([]);
    expect(activated).toEqual([]);
    expect(used).toEqual([]);
    // Moving with them held opens nothing, nor does a click with ⌥ alone.
    expect(gate.apply("g_ann", "tab", { type: "mouseMove", x: 0.5, y: 0.5, buttons: 0, clickCount: 0, modifiers: ["meta", "shift"] })).toBeNull();
    expect(gate.apply("g_ann", "tab", at("mouseDown", ["alt"]))).toBeNull();
    expect(gate.apply("g_ann", "tab", at("mouseUp", ["alt"]))).toBeNull();
    // A plain press let go with ⌘ and Shift held since: the page gets its release, plain, so its click opens nothing elsewhere.
    sent.length = 0;
    expect(gate.apply("g_ann", "tab", at("mouseDown", []))).toBeNull();
    expect(gate.apply("g_ann", "tab", at("mouseUp", ["meta", "shift"]))).toBeNull();
    expect(sent.flatMap(({ steps }) => steps)).toEqual([
      { type: "mouseDown", x: 400, y: 300, button: "left", clickCount: 1, modifiers: ["leftbuttondown"] },
      { type: "mouseUp", x: 400, y: 300, button: "left", clickCount: 1, modifiers: [] },
    ]);
  });

  it("scrolls but never zooms: a wheel with ⌘ or Ctrl is refused (Chromium would keep the site's zoom for the host)", () => {
    const { gate, sent } = setup();
    const wheel = (modifiers: Array<"shift" | "control" | "alt" | "meta">): LiveInputEvent => ({ type: "wheel", x: 0.5, y: 0.5, dx: 0, dy: -120, modifiers });
    expect(gate.apply("g_ann", "tab", wheel(["control"]))).toBe("zoom");
    expect(gate.apply("g_ann", "tab", wheel(["meta"]))).toBe("zoom");
    expect(sent).toEqual([]);
    expect(gate.apply("g_ann", "tab", wheel(["shift"]))).toBeNull();
  });

  it("keeps the app's own keys from a guest: the person's bindings, the clipboard's chords, quit and hide; the page's own go", () => {
    const { gate, sent } = setup();
    const key = (k: string, code: string, modifiers: Array<"shift" | "control" | "alt" | "meta">): LiveInputEvent => ({ type: "keyDown", key: k, code, modifiers });
    for (const [k, code, modifiers] of [
      ["w", "KeyW", ["meta"]],
      ["t", "KeyT", ["meta"]],
      ["l", "KeyL", ["meta"]],
      ["=", "Equal", ["meta"]],
      ["c", "KeyC", ["meta"]],
      ["x", "KeyX", ["meta"]],
      ["v", "KeyV", ["meta"]],
      ["V", "KeyV", ["meta", "shift"]],
      ["q", "KeyQ", ["meta"]],
      ["h", "KeyH", ["meta"]],
    ] as const) {
      expect(gate.apply("g_ann", "tab", key(k, code, [...modifiers])), `${modifiers.join("+")}+${k}`).toBe("shortcut");
      expect(gate.apply("g_ann", "tab", { type: "keyUp", key: k, code, modifiers: [...modifiers] })).toBe("shortcut");
    }
    expect(sent).toEqual([]);
    // A page's own: ⌘Enter to send a comment, ⌘K for its search, plain keys, a Mac's Control keys.
    for (const [k, code, modifiers] of [
      ["Enter", "Enter", ["meta"]],
      ["k", "KeyK", ["meta"]],
      ["a", "KeyA", []],
      ["a", "KeyA", ["control"]],
    ] as const) expect(gate.apply("g_ann", "tab", key(k, code, [...modifiers])), `${modifiers.join("+")}+${k}`).toBeNull();
    expect(sent).toHaveLength(4);
  });

  it("breaks a line on a guest's Shift+Enter, Shift on its char; a char with ⌥, ⌘ or Ctrl is no event", () => {
    const { gate, sent } = setup();
    expect(gate.apply("g_ann", "tab", { type: "keyDown", key: "Enter", code: "Enter", modifiers: ["shift"] })).toBeNull();
    expect(gate.apply("g_ann", "tab", { type: "char", text: "\r", modifiers: ["shift"] })).toBeNull();
    expect(gate.apply("g_ann", "tab", { type: "keyUp", key: "Enter", code: "Enter", modifiers: ["shift"] })).toBeNull();
    expect(sent.flatMap(({ steps }) => steps)).toEqual([
      { type: "keyDown", keyCode: "Enter", modifiers: ["shift"] },
      { type: "char", keyCode: "\r", modifiers: ["shift"] },
      { type: "keyUp", keyCode: "Enter", modifiers: ["shift"] },
    ]);
    // Whatever a guest's page puts on a char: ⌥ would make a form submit a download of the host's, ⌘ and Ctrl are chords.
    for (const modifiers of [["alt"], ["meta"], ["control"], ["shift", "meta"]]) {
      expect(gate.apply("g_ann", "tab", { type: "char", text: "v", modifiers }), modifiers.join("+")).toBe("invalid");
    }
    expect(sent).toHaveLength(3);
  });

  it("gives the page no key a guest names after what every object inherits: sendInputEvent throws on a keyCode that is not a string", () => {
    const { gate, sent } = setup();
    // (No key-down of theirs reaches the page, so their key-ups are releases of nothing it has down.)
    const result = { keyDown: null, keyUp: "not-held" } as const;
    for (const name of Object.getOwnPropertyNames(Object.prototype)) {
      for (const type of ["keyDown", "keyUp"] as const) {
        expect(gate.apply("g_ann", "tab", { type, key: name, code: "", modifiers: [] }), `${type} ${name}`).toBe(result[type]);
        expect(gate.apply("g_ann", "tab", { type, key: name, code: "", modifiers: ["meta"] }), `${type} ⌘${name}`).toBe(result[type]);
        expect(gate.apply("g_ann", "tab", { type, key: "ж", code: name, modifiers: [] }), `${type} code ${name}`).toBe(result[type]);
      }
    }
    expect(sent.flatMap(({ steps }) => steps)).toEqual([]);
  });

  it("lets a guest's own release of a press it let through go whatever changed since, once", () => {
    let allowed = true;
    const { gate, sent } = setup({ allowed: () => allowed });
    expect(gate.apply("g_ann", "tab", click("mouseDown", 0.25, 0.5))).toBeNull();
    expect(gate.apply("g_ann", "tab", { type: "keyDown", key: "c", code: "KeyC", modifiers: [] })).toBeNull();
    // The host takes the window back mid-press (the share not yet told the gate).
    allowed = false;
    sent.length = 0;
    expect(gate.apply("g_ann", "tab", click("mouseUp", 0.5, 0.5))).toBeNull();
    // ⌘ pressed since: as a chord it would be the app's, but it only lets go of the key the page has down — plain.
    expect(gate.apply("g_ann", "tab", { type: "keyUp", key: "c", code: "KeyC", modifiers: ["meta"] })).toBeNull();
    expect(sent.flatMap(({ steps }) => steps)).toEqual([
      { type: "mouseUp", x: 400, y: 300, button: "left", clickCount: 1, modifiers: [] },
      { type: "keyUp", keyCode: "c", modifiers: [] },
    ]);
    // Let go once: another release, or a new press, is refused as anything else is.
    expect(gate.apply("g_ann", "tab", click("mouseUp", 0.5, 0.5))).toBe("not-allowed");
    expect(gate.apply("g_ann", "tab", { type: "keyUp", key: "c", code: "KeyC", modifiers: [] })).toBe("not-allowed");
    expect(gate.apply("g_ann", "tab", click("mouseDown", 0.5, 0.5))).toBe("not-allowed");
    expect(sent).toHaveLength(2);
  });

  it("sends no release of a press the page does not have down: a guest's page sends its releases again after a drop, and a page acts on a stray one", () => {
    const { gate, sent } = setup();
    const keyUp = (key: string, code: string): LiveInputEvent => ({ type: "keyUp", key, code, modifiers: [] });
    gate.apply("g_ann", "tab", click("mouseDown", 0.25, 0.5));
    gate.apply("g_ann", "tab", click("mouseUp", 0.25, 0.5));
    gate.apply("g_ann", "tab", { type: "keyDown", key: "Enter", code: "Enter", modifiers: [] });
    gate.apply("g_ann", "tab", keyUp("Enter", "Enter"));
    sent.length = 0;
    // Releases that arrived, sent again: a second key-up of Enter would search again on a page that searches on it.
    expect(gate.apply("g_ann", "tab", click("mouseUp", 0.25, 0.5))).toBe("not-held");
    expect(gate.apply("g_ann", "tab", keyUp("Enter", "Enter"))).toBe("not-held");
    // A release of a press the page never had (refused, or lost on the way).
    expect(gate.apply("g_ann", "tab", keyUp("a", "KeyA"))).toBe("not-held");
    expect(sent).toEqual([]);
    // Presses whose releases were lost: the ones sent again let them go, once.
    gate.apply("g_ann", "tab", click("mouseDown", 0.5, 0.5));
    gate.apply("g_ann", "tab", { type: "keyDown", key: "b", code: "KeyB", modifiers: [] });
    sent.length = 0;
    expect(gate.apply("g_ann", "tab", click("mouseUp", 0.75, 0.5))).toBeNull();
    expect(gate.apply("g_ann", "tab", keyUp("b", "KeyB"))).toBeNull();
    expect(gate.apply("g_ann", "tab", click("mouseUp", 0.75, 0.5))).toBe("not-held");
    expect(gate.apply("g_ann", "tab", keyUp("b", "KeyB"))).toBe("not-held");
    expect(sent.flatMap(({ steps }) => steps)).toEqual([
      { type: "mouseUp", x: 600, y: 300, button: "left", clickCount: 1, modifiers: [] },
      { type: "keyUp", keyCode: "b", modifiers: [] },
    ]);
    // However many come, they spend none of the guest's 240 a second.
    for (let index = 0; index < LIVE_INPUT_RATE; index += 1) gate.apply("g_ann", "tab", keyUp("z", "KeyZ"));
    expect(gate.apply("g_ann", "tab", { type: "mouseMove", x: 0.5, y: 0.5, buttons: 0, clickCount: 0, modifiers: [] })).toBeNull();
  });

  it("lets go of what a guest holds down as their hands come off the window, where their pointer last was", () => {
    const share = { allowed: true, present: true, minimized: false };
    const { gate, sent } = setup({ allowed: () => share.allowed, hostPresent: () => share.present, window: () => ({ streamed: true, minimized: share.minimized, masked: false }) });
    const hold = (): void => {
      gate.apply("g_ann", "tab", click("mouseDown", 0.1, 0.2));
      gate.apply("g_ann", "tab", { type: "mouseMove", x: 0.3, y: 0.4, button: "left", buttons: 1, clickCount: 0, modifiers: [] });
      gate.apply("g_ann", "tab", { type: "keyDown", key: "Shift", code: "ShiftLeft", modifiers: ["shift"] });
      gate.apply("g_ann", "tab", { type: "keyDown", key: "A", code: "KeyA", modifiers: ["shift"] });
      sent.length = 0;
    };
    const released = [{ tabId: "tab", steps: [
      { type: "mouseUp", x: 240, y: 240, button: "left", clickCount: 1, modifiers: [] },
      { type: "keyUp", keyCode: "Shift", modifiers: [] },
      { type: "keyUp", keyCode: "a", modifiers: [] },
    ] }];
    hold();
    // Nothing changed: nothing is let go.
    gate.releaseWithdrawn();
    expect(sent).toEqual([]);
    for (const withdraw of [() => (share.allowed = false), () => (share.present = false), () => (share.minimized = true)]) {
      Object.assign(share, { allowed: true, present: true, minimized: false });
      hold();
      withdraw();
      gate.releaseWithdrawn();
      expect(sent).toEqual(released);
      // Once: the guest's own release after is refused, and the next change lets go of nothing more.
      expect(gate.apply("g_ann", "tab", click("mouseUp", 0.3, 0.4))).not.toBeNull();
      gate.releaseWithdrawn();
      expect(sent).toHaveLength(1);
    }
    // A guest who leaves, or is removed, with a button down.
    Object.assign(share, { allowed: true, present: true, minimized: false });
    hold();
    gate.forget("g_ann");
    expect(sent).toEqual(released);
  });

  it("lets no key down it could not let go of: one past the 16 a guest holds in a window is refused, and every key the page has down is released", () => {
    let allowed = true;
    const { gate, sent } = setup({ allowed: () => allowed });
    const keyDown = (index: number): LiveInputEvent => ({ type: "keyDown", key: String.fromCharCode(97 + index), code: `Key${String.fromCharCode(65 + index)}`, modifiers: [] });
    for (let index = 0; index < 16; index += 1) expect(gate.apply("g_ann", "tab", keyDown(index))).toBeNull();
    expect(gate.apply("g_ann", "tab", keyDown(16))).toBe("too-many-keys");
    // A key already down repeats as it is held; in another window the guest's hands are free.
    expect(gate.apply("g_ann", "tab", keyDown(0))).toBeNull();
    expect(gate.apply("g_ann", "other", keyDown(16))).toBeNull();
    expect(gate.apply("g_ann", "other", { type: "keyUp", key: "q", code: "KeyQ", modifiers: [] })).toBeNull();
    // The host takes the window back: whatever key reached the page down is let go.
    allowed = false;
    gate.releaseWithdrawn();
    const down = new Set<string>();
    for (const step of sent.filter(({ tabId }) => tabId === "tab").flatMap(({ steps }) => steps)) {
      if (step.type === "keyDown") down.add(step.keyCode);
      else if (step.type === "keyUp") down.delete(step.keyCode);
    }
    expect([...down]).toEqual([]);
  });

  it("holds each guest to 240 events a second, dropping the rest, and forgets a guest who left", () => {
    const { gate, tick } = setup();
    const move: LiveInputEvent = { type: "mouseMove", x: 0.1, y: 0.1, buttons: 0, clickCount: 0, modifiers: [] };
    const results = Array.from({ length: LIVE_INPUT_RATE + 10 }, () => gate.apply("g_ann", "tab", move));
    expect(results.filter((result) => result === null)).toHaveLength(LIVE_INPUT_RATE);
    expect(results.filter((result) => result === "rate-limited")).toHaveLength(10);
    tick(100);
    expect(gate.apply("g_ann", "tab", move)).toBeNull();
    gate.forget("g_ann");
    expect(Array.from({ length: LIVE_INPUT_RATE }, () => gate.apply("g_ann", "tab", move)).every((result) => result === null)).toBe(true);
  });
});
