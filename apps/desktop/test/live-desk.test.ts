/**
 * The desk frames guests rebuild the shared desk from (docs/live-share.md §4
 * `lv.desk`, §6.1): what main lays on the shell's report — which windows are
 * pages, which stream (eight at most, the top of the stack first, minimized
 * ones not), which guests may use, what leaves the Mac of a page's address
 * and icon, when a shell-drawn window's picture is held — and that frames go
 * out only on change, at most every 33 ms, but at once when they hold a
 * picture that was running.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { liveDeskFrameSchema, type LiveDeskFrame } from "@pistachio/live-share";
import type { LiveDeskReport, LiveDeskReportWindow } from "@pistachio/shell-contracts/live-share";
import { deskFrame, DESK_FRAME_MS, faviconOf, LiveDeskFrames, originOf, pausedWindow, shellMarkOf, spaceColor, streamedWindows, type LiveWindowFacts } from "../src/main/live/live-desk";

function win(id: string, patch: Partial<LiveDeskReportWindow> = {}): LiveDeskReportWindow {
  return { id, kind: "page", frame: { x: 10, y: 10, w: 400, h: 300 }, page: { x: 10, y: 40, w: 400, h: 270 }, focused: false, minimized: false, masked: false, covered: false, ...patch };
}

function report(windows: LiveDeskReportWindow[], shellCovered = false): LiveDeskReport {
  return { groupId: "g1", stage: { w: 1200, h: 800 }, stageInWindow: { x: 240, y: 12, w: 1200, h: 800 }, viewport: { w: 1440, h: 900 }, windows, settled: true, shellCovered, covers: [], mark: 1 };
}

const PAGE: LiveWindowFacts = { title: "GitHub", url: "https://github.com/acme/app/pull/12?token=secret", favicon: "https://github.com/favicon.ico", page: true };

function frameOf(windows: LiveDeskReportWindow[], options: { facts?: (id: string) => LiveWindowFacts | null; controllable?: string[]; hostPresent?: boolean; shellCovered?: boolean } = {}) {
  return deskFrame({
    report: report(windows, options.shellCovered),
    facts: options.facts ?? (() => PAGE),
    controllable: new Set(options.controllable ?? []),
    hostPresent: options.hostPresent ?? true,
    space: { title: "Launch plan", color: spaceColor("blue") },
  });
}

describe("deskFrame", () => {
  it("lays main's facts on the shell's report: the site and never the address, the icon, the stage and the space", () => {
    const frame = frameOf([win("a", { focused: true })]);
    expect(frame).toMatchObject({ v: 1, stage: { w: 1200, h: 800 }, hostPresent: true, space: { title: "Launch plan", color: "#388cf0" } });
    expect(frame.windows[0]).toEqual({
      id: "a",
      kind: "page",
      title: "GitHub",
      origin: "github.com",
      favicon: "https://github.com/favicon.ico",
      frame: { x: 10, y: 10, w: 400, h: 300 },
      page: { x: 10, y: 40, w: 400, h: 270 },
      focused: true,
      minimized: false,
      controllable: false,
      track: "win:a",
      paused: false,
    });
    expect(JSON.stringify(frame)).not.toContain("pull/12");
    // What the host app sends as lv.desk is a body every guest's schema takes.
    expect(liveDeskFrameSchema.safeParse({ ...frame, seq: 1 }).success).toBe(true);
  });

  it("streams eight windows at most, the top of the stack first, and never a minimized one", () => {
    const windows = Array.from({ length: 11 }, (_, index) => win(`w${String(index)}`, { minimized: index === 9 }));
    const frame = frameOf(windows);
    const streamed = frame.windows.filter((window) => window.track !== null).map((window) => window.id);
    // Bottom to top is w0…w10: from the top, w10, then w8 down to w2 (w9 is minimized).
    expect(streamed).toEqual(["w2", "w3", "w4", "w5", "w6", "w7", "w8", "w10"]);
    expect(frame.windows.find((window) => window.id === "w9")?.track).toBeNull();
    // A shell-drawn window streams too (cut from the shell's page), and takes one of the eight.
    expect([...streamedWindows([{ id: "s", kind: "shell", minimized: false, masked: false }])]).toEqual(["s"]);
    expect(streamedWindows([{ id: "s", kind: "shell", minimized: true, masked: false }]).size).toBe(0);
  });

  it("never streams a masked window: its capture would be the whole page, what the mask cuts away too", () => {
    // Bottom to top: a, w0…w6, then the masked window on top of them all.
    const windows = [win("a"), ...Array.from({ length: 7 }, (_, index) => win(`w${String(index)}`)), win("m", { masked: true })];
    const frame = frameOf(windows, { controllable: ["m"] });
    // Its frame alone, its picture held, like a shell-drawn window's (§6.6), until it can be cut to the region.
    expect(frame.windows.find((window) => window.id === "m")).toMatchObject({ kind: "page", track: null, paused: true, controllable: false });
    // Nor does it take one of the eight tracks: the window at the foot of the stack streams in its place.
    expect(frame.windows.filter((window) => window.track !== null).map((window) => window.id)).toEqual(["a", "w0", "w1", "w2", "w3", "w4", "w5", "w6"]);
  });

  it("makes a window a page only when the shell says so and main knows it as a tab's own page", () => {
    const facts = (id: string): LiveWindowFacts | null =>
      id === "home" ? { title: "Home", url: null, favicon: "data:image/svg+xml,%3Csvg/%3E", page: false } : id === "gone" ? null : PAGE;
    const frame = frameOf([win("home"), win("file:doc", { kind: "shell" }), win("gone"), win("a")], { facts });
    expect(frame.windows.map((window) => [window.id, window.kind, window.track, window.paused])).toEqual([
      // A shell page the shell called a page is still the shell's: never captured as a tab — its picture is cut from the shell's.
      ["home", "shell", "win:home", false],
      ["file:doc", "shell", "win:file:doc", false],
      ["a", "page", "win:a", false],
    ]);
    expect(frame.windows[0]?.origin).toBeNull();
  });

  it("holds a shell-drawn window's picture while the host is away, while anything of the shell's lies over the desk, and while something floats over it", () => {
    const windows = [win("term", { kind: "shell" }), win("a"), win("doc", { kind: "shell", covered: true })];
    const paused = (options: Parameters<typeof frameOf>[1]): Array<[string, boolean]> => frameOf(windows, options).windows.map((window) => [window.id, window.paused]);
    expect(paused({})).toEqual([
      ["term", false],
      ["a", false],
      ["doc", true],
    ]);
    // A page's picture is its tab's capture, whatever the shell draws over it: it runs on.
    expect(paused({ shellCovered: true })).toEqual([
      ["term", true],
      ["a", false],
      ["doc", true],
    ]);
    expect(paused({ hostPresent: false })).toEqual([
      ["term", true],
      ["a", false],
      ["doc", true],
    ]);
    expect(pausedWindow("shell", { masked: false, covered: false }, false, { hostPresent: true, shellCovered: false })).toBe(true);
    expect(pausedWindow("page", { masked: true, covered: false }, false, { hostPresent: true, shellCovered: false })).toBe(true);
  });

  it("lets guests use a window only while allowed, the host is on the space, and it is a whole page in view", () => {
    const windows = [win("a"), win("b", { minimized: true }), win("c", { masked: true }), win("d"), win("e", { kind: "shell" })];
    const controllable = ["a", "b", "c", "e"];
    expect(frameOf(windows, { controllable }).windows.filter((window) => window.controllable).map((window) => window.id)).toEqual(["a"]);
    expect(frameOf(windows, { controllable, hostPresent: false }).windows.some((window) => window.controllable)).toBe(false);
  });

  it("never lets guests use a window past the eight that stream: they see its frame alone, and no input reaches it", () => {
    // Bottom to top: w0…w9, every one allowed; w0 and w1 lie under the eight that stream.
    const windows = Array.from({ length: 10 }, (_, index) => win(`w${String(index)}`));
    const frame = frameOf(windows, { controllable: windows.map((window) => window.id) });
    expect(frame.windows.filter((window) => window.controllable).map((window) => window.id)).toEqual(["w2", "w3", "w4", "w5", "w6", "w7", "w8", "w9"]);
    expect(frame.windows.find((window) => window.id === "w0")).toMatchObject({ track: null, controllable: false });
  });

  it("keeps the protocol's bounds on what it says of a page", () => {
    expect(originOf("http://localhost:3000/x")).toBe("localhost");
    expect(originOf("file:///Users/me/secret.txt")).toBeNull();
    expect(originOf("pistachio://home")).toBeNull();
    expect(faviconOf("http://site.test/icon.png")).toBeNull();
    expect(faviconOf(`data:image/png;base64,${"A".repeat(5000)}`)).toBeNull();
    expect(faviconOf("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    const title = frameOf([win("a")], { facts: () => ({ ...PAGE, title: "x".repeat(500) }) }).windows[0]!.title;
    expect([...title].length).toBe(300);
  });

  it("clips titles as the protocol counts them, in UTF-16 units, never through a character", () => {
    // 300 characters but 301 units: past the schema's 300, which would drop the whole frame.
    const edge = `${"x".repeat(299)}😀`;
    const emoji = "😀".repeat(400);
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
    for (const title of [edge, emoji, `${"x".repeat(298)}😀😀`]) {
      const frame = deskFrame({ report: report([win("a")]), facts: () => ({ ...PAGE, title }), controllable: new Set(), hostPresent: true, space: { title, color: spaceColor("blue") } });
      for (const clipped of [frame.windows[0]!.title, frame.space.title]) {
        expect(clipped.length).toBeLessThanOrEqual(300);
        expect(clipped.endsWith("…")).toBe(true);
        expect(loneSurrogate.test(clipped)).toBe(false);
      }
      expect(liveDeskFrameSchema.safeParse({ ...frame, seq: 1 }).success).toBe(true);
    }
    // Exactly 300 units stands as it is.
    const whole = `${"x".repeat(298)}😀`;
    expect(frameOf([win("a")], { facts: () => ({ ...PAGE, title: whole }) }).windows[0]!.title).toBe(whole);
  });
});

describe("LiveDeskFrames", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends a frame only when it changed, numbered, at most every 33 ms — the latest one", () => {
    const sent: LiveDeskFrame[] = [];
    const frames = new LiveDeskFrames((frame) => sent.push(frame));
    const at = (x: number) => frameOf([win("a", { frame: { x, y: 10, w: 400, h: 300 } })]);
    frames.update(at(1));
    expect(sent.map((frame) => [frame.seq, frame.windows[0]!.frame.x])).toEqual([[1, 1]]);
    frames.update(at(1));
    frames.update(at(2));
    frames.update(at(3));
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(DESK_FRAME_MS);
    expect(sent.map((frame) => [frame.seq, frame.windows[0]!.frame.x])).toEqual([
      [1, 1],
      [2, 3],
    ]);
    expect(frames.latest?.seq).toBe(2);
    // Moved and back before the interval was up: nothing new to say.
    frames.update(at(4));
    frames.update(at(3));
    vi.advanceTimersByTime(DESK_FRAME_MS * 2);
    expect(sent).toHaveLength(2);
  });

  it("sends each frame with the shell's mark it was built under; a new mark alone goes too, at the pace, the frame's number kept", () => {
    const sent: Array<{ seq: number; mark: number | null }> = [];
    const frames = new LiveDeskFrames((frame, shell) => sent.push({ seq: frame.seq, mark: shell?.mark ?? null }));
    const frame = frameOf([win("term", { kind: "shell" })]);
    const mark = (n: number) => shellMarkOf({ ...report([win("term", { kind: "shell" })]), mark: n });
    frames.update(frame, mark(1));
    expect(sent).toEqual([{ seq: 1, mark: 1 }]);
    // The shell reported again, nothing guests see changed: its new number goes, the frame's stays.
    frames.update(frame, mark(2));
    frames.update(frame, mark(3));
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(DESK_FRAME_MS);
    expect(sent).toEqual([
      { seq: 1, mark: 1 },
      { seq: 1, mark: 3 },
    ]);
    expect(frames.latestShell).toEqual({ mark: 3, stage: { x: 240, y: 12, w: 1200, h: 800 }, viewport: { w: 1440, h: 900 } });
    // The same frame and mark again: nothing.
    frames.update(frame, mark(3));
    vi.advanceTimersByTime(DESK_FRAME_MS * 2);
    expect(sent).toHaveLength(2);
  });

  it("sends at once a frame that holds a picture the last one let run; one that lets it run again waits its turn", () => {
    const sent: LiveDeskFrame[] = [];
    const frames = new LiveDeskFrames((frame) => sent.push(frame));
    const term = (shellCovered: boolean) => frameOf([win("term", { kind: "shell" })], { shellCovered });
    frames.update(term(false));
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(5);
    frames.update(term(true));
    expect(sent.map((frame) => frame.windows[0]!.paused)).toEqual([false, true]);
    vi.advanceTimersByTime(5);
    frames.update(term(false));
    expect(sent).toHaveLength(2);
    vi.advanceTimersByTime(DESK_FRAME_MS);
    expect(sent.map((frame) => frame.windows[0]!.paused)).toEqual([false, true, false]);
  });
});
