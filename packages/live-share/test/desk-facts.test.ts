import { describe, expect, it } from "vitest";
import { deskFacts, deskNotices, sameFacts, type LiveDeskAllowance } from "../src/react/index.js";
import type { LiveDeskFrame, LiveWindow } from "../src/index.js";

function win(id: string, extra: Partial<LiveWindow> = {}): LiveWindow {
  return {
    id,
    kind: "page",
    title: `Title ${id}`,
    origin: "example.com",
    favicon: null,
    frame: { x: 0, y: 0, w: 400, h: 300 },
    page: { x: 0, y: 0, w: 400, h: 300 },
    focused: false,
    minimized: false,
    controllable: false,
    track: `win:${id}`,
    paused: false,
    ...extra,
  };
}

function frame(windows: LiveWindow[], extra: Partial<LiveDeskFrame> = {}): LiveDeskFrame {
  return { v: 1, seq: 1, stage: { w: 1200, h: 800 }, hostPresent: true, space: { title: "Launch plan", color: "#46A758" }, windows, ...extra };
}

describe("deskFacts and sameFacts", () => {
  it("leave geometry out: a window moving is not a render", () => {
    const a = frame([win("a"), win("b")]);
    const moved = frame([win("a", { frame: { x: 50, y: 60, w: 400, h: 300 }, page: { x: 50, y: 60, w: 400, h: 300 } }), win("b")], { seq: 2 });
    expect(sameFacts(deskFacts(a), deskFacts(moved))).toBe(true);
  });

  it("see what a guest is shown change: focus, a title, the order, drawing", () => {
    const base = deskFacts(frame([win("a"), win("b")]));
    expect(sameFacts(base, deskFacts(frame([win("a", { focused: true }), win("b")])))).toBe(false);
    expect(sameFacts(base, deskFacts(frame([win("a", { title: "New" }), win("b")])))).toBe(false);
    expect(sameFacts(base, deskFacts(frame([win("b"), win("a")])))).toBe(false);
    expect(sameFacts(base, deskFacts(frame([win("a"), win("b")], { guestsCanDraw: false })))).toBe(false);
    expect(sameFacts(base, null)).toBe(false);
  });

  it("keep a terminal said to be one — the guest page lets its hands onto it — and see it change", () => {
    const shell = win("t", { kind: "shell" });
    const terminal = win("t", { kind: "shell", terminal: true });
    expect(deskFacts(frame([terminal])).windows[0]?.terminal).toBe(true);
    // (A frame without it, as before terminals could be used: nothing added.)
    expect(deskFacts(frame([shell])).windows[0]).not.toHaveProperty("terminal");
    expect(sameFacts(deskFacts(frame([shell])), deskFacts(frame([terminal])))).toBe(false);
  });

  it("read a frame without guestsCanDraw as drawing allowed", () => {
    expect(deskFacts(frame([])).guestsCanDraw).toBe(true);
    expect(deskFacts(frame([], { guestsCanDraw: false })).guestsCanDraw).toBe(false);
  });
});

describe("deskNotices", () => {
  const first = (f: LiveDeskFrame): LiveDeskAllowance => deskNotices(null, f).allowance;

  it("says nothing about the first frame", () => {
    expect(deskNotices(null, frame([win("a", { controllable: true })], { hostPresent: false })).notices).toEqual([]);
  });

  it("tells a window given over and taken back, but not one that closed", () => {
    const start = first(frame([win("a"), win("b", { controllable: true })]));
    const given = deskNotices(start, frame([win("a", { controllable: true }), win("b", { controllable: true })]));
    expect(given.notices).toEqual([{ kind: "granted", windowId: "a", title: "Title a" }]);
    const taken = deskNotices(given.allowance, frame([win("a")]));
    // b closed: no notice for it.
    expect(taken.notices).toEqual([{ kind: "revoked", windowId: "a", title: "Title a" }]);
  });

  it("keeps what guests may use while the host is away, and coming back is one notice", () => {
    const start = first(frame([win("a", { controllable: true })]));
    // Away: frames say nothing is controllable.
    const away = deskNotices(start, frame([win("a")], { hostPresent: false }));
    expect(away.notices).toEqual([]);
    expect([...away.allowance.usable]).toEqual(["a"]);
    const back = deskNotices(away.allowance, frame([win("a", { controllable: true })]));
    expect(back.notices).toEqual([{ kind: "back" }]);
  });

  it("tells drawing turned off and on", () => {
    const start = first(frame([]));
    const off = deskNotices(start, frame([], { guestsCanDraw: false }));
    expect(off.notices).toEqual([{ kind: "drawing", allowed: false }]);
    expect(deskNotices(off.allowance, frame([])).notices).toEqual([{ kind: "drawing", allowed: true }]);
  });
});
