/**
 * Live share's contracts (docs/live-share.md §6.2). shell-contracts cannot
 * depend on @pistachio/live-share, so the shapes that cross the main ↔
 * live-host bridge as protocol bodies are restated there; the compiler holds
 * the two equal here, where both packages are in reach. And the guards main
 * checks every renderer's word with take what they should and nothing else.
 */

import { describe, expect, it } from "vitest";
import type { LiveChatEntry, LiveDeskFrame, LiveGrant } from "@pistachio/live-share";
import type { LiveBackground } from "@pistachio/live-share/effects";
import {
  isLiveCommand,
  isLiveDeskReport,
  isLiveHostReport,
  type LiveBackgroundChoice,
  type LiveChatMessage,
  type LiveDeskReport,
  type LiveHostDeskFrame,
} from "@pistachio/shell-contracts/live-share";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const FRAME_IS_THE_PROTOCOLS: Same<LiveHostDeskFrame, LiveDeskFrame> = true;
const CHAT_IS_THE_PROTOCOLS: Same<LiveChatMessage, LiveChatEntry> = true;
const BACKGROUND_IS_THE_EFFECTS: Same<LiveBackgroundChoice, LiveBackground> = true;
// A window's use is the protocol's grant, renamed for the shell.
const USE_CARRIES_A_GRANT: Same<{ windowId: string; identity: string }, { windowId: LiveGrant["w"]; identity: NonNullable<LiveGrant["user"]> }> = true;

const REPORT: LiveDeskReport = {
  groupId: "g1",
  stage: { w: 1200, h: 800 },
  stageInWindow: { x: 240, y: 12, w: 1200, h: 800 },
  windows: [{ id: "a", kind: "page", frame: { x: 0, y: 0, w: 600, h: 400 }, page: { x: 0, y: 30, w: 600, h: 370 }, focused: true, minimized: false, masked: false, covered: false }],
  settled: false,
  shellCovered: false,
  covers: [{ x: -8, y: -8, w: 346, h: 816 }],
  viewport: { w: 1440, h: 900 },
  mark: 7,
};

describe("live share contracts", () => {
  it("restate the protocol's shapes exactly", () => {
    expect([FRAME_IS_THE_PROTOCOLS, CHAT_IS_THE_PROTOCOLS, BACKGROUND_IS_THE_EFFECTS, USE_CARRIES_A_GRANT]).toEqual([true, true, true, true]);
  });

  it("take the shell's commands and refuse what is not one", () => {
    expect(isLiveCommand({ type: "start", groupId: "g1" })).toBe(true);
    expect(isLiveCommand({ type: "start", groupId: "g1", hostName: "Zach" })).toBe(true);
    expect(isLiveCommand({ type: "setControllable", windowId: "a", allowed: true })).toBe(true);
    expect(isLiveCommand({ type: "setDrawing", drawing: { tool: "laser", color: "#3E63DD" } })).toBe(true);
    expect(isLiveCommand({ type: "setDrawing", drawing: null })).toBe(true);
    expect(isLiveCommand({ type: "setBackground", background: { kind: "image", url: "data:image/png;base64,AAAA" } })).toBe(true);
    expect(isLiveCommand({ type: "setDevice", kind: "videoinput", deviceId: null })).toBe(true);
    expect(isLiveCommand({ type: "start" })).toBe(false);
    expect(isLiveCommand({ type: "setDrawing", drawing: { tool: "pen", color: "red" } })).toBe(false);
    expect(isLiveCommand({ type: "setBackground", background: { kind: "image", url: "file:///etc/passwd" } })).toBe(false);
    expect(isLiveCommand({ type: "setAdmission", admission: "anyone" })).toBe(false);
    expect(isLiveCommand({ type: "launch" })).toBe(false);
    expect(isLiveCommand(null)).toBe(false);
  });

  it("take the shell's desk report and refuse a malformed one", () => {
    expect(isLiveDeskReport(REPORT)).toBe(true);
    expect(isLiveDeskReport({ ...REPORT, stage: { w: 0, h: 800 } })).toBe(false);
    expect(isLiveDeskReport({ ...REPORT, stageInWindow: { x: 0, y: 0, w: Number.NaN, h: 1 } })).toBe(false);
    expect(isLiveDeskReport({ ...REPORT, windows: [{ ...REPORT.windows[0], kind: "tab" }] })).toBe(false);
    expect(isLiveDeskReport({ ...REPORT, windows: Array.from({ length: 65 }, () => REPORT.windows[0]) })).toBe(false);
    expect(isLiveDeskReport({ ...REPORT, settled: undefined })).toBe(false);
    // Unsaid whether the shell covers the desk, or a window: no report (a shell-drawn window's picture is never cut on a guess).
    expect(isLiveDeskReport({ ...REPORT, shellCovered: undefined })).toBe(false);
    expect(isLiveDeskReport({ ...REPORT, windows: [{ ...REPORT.windows[0], covered: "no" }] })).toBe(false);
    // Unnumbered, or numbered past what the mark carries: no word a frame of the shell could be cut by.
    expect(isLiveDeskReport({ ...REPORT, mark: undefined })).toBe(false);
    expect(isLiveDeskReport({ ...REPORT, mark: 65_536 })).toBe(false);
    expect(isLiveDeskReport({ ...REPORT, mark: 1.5 })).toBe(false);
    // Where the shell's own lies over the desk, each a box, a handful at most: what the outlines go under.
    expect(isLiveDeskReport({ ...REPORT, covers: [] })).toBe(true);
    expect(isLiveDeskReport({ ...REPORT, covers: undefined })).toBe(false);
    expect(isLiveDeskReport({ ...REPORT, covers: [{ x: 0, y: 0, w: Number.POSITIVE_INFINITY, h: 1 }] })).toBe(false);
    expect(isLiveDeskReport({ ...REPORT, covers: Array.from({ length: 33 }, () => REPORT.covers[0]) })).toBe(false);
    expect(isLiveDeskReport({ ...REPORT, viewport: { w: 0, h: 900 } })).toBe(false);
    expect(isLiveDeskReport({ ...REPORT, viewport: undefined })).toBe(false);
  });

  it("take the host app's reports and refuse what is not one", () => {
    expect(isLiveHostReport({ type: "roster", guests: [{ identity: "g_a", name: "Ann", color: "#E54D2E", micOn: true, cameraOn: false }] })).toBe(true);
    expect(isLiveHostReport({ type: "input", from: "g_a", windowId: "a", event: { type: "char", text: "h" } })).toBe(true);
    expect(isLiveHostReport({ type: "connection", state: "reconnecting" })).toBe(true);
    expect(isLiveHostReport({ type: "command", command: { type: "stop" } })).toBe(true);
    expect(isLiveHostReport({ type: "interactive", active: "yes" })).toBe(false);
    expect(isLiveHostReport({ type: "roster", guests: [{ identity: "g_a", name: "Ann", color: "pink", micOn: true, cameraOn: false }] })).toBe(false);
    expect(isLiveHostReport({ type: "input", from: "g_a", windowId: "a", event: "click" })).toBe(false);
    expect(isLiveHostReport({ type: "command", command: { type: "launch" } })).toBe(false);
    // A background that did not take names the one the camera shows instead.
    expect(isLiveHostReport({ type: "mediaFailed", kind: "camera", error: "No camera was found." })).toBe(true);
    expect(isLiveHostReport({ type: "mediaFailed", kind: "background", tried: { kind: "image", url: "data:image/png;base64,AAAA" }, background: { kind: "blur" }, error: "The camera background didn't load." })).toBe(true);
    expect(isLiveHostReport({ type: "mediaFailed", kind: "background", tried: { kind: "blur" }, error: "The camera background didn't load." })).toBe(false);
    expect(isLiveHostReport({ type: "mediaFailed", kind: "background", background: { kind: "blur" }, error: "The camera background didn't load." })).toBe(false);
    expect(isLiveHostReport({ type: "mediaFailed", kind: "background", tried: { kind: "blur" }, background: { kind: "image", url: "file:///etc/passwd" }, error: "x" })).toBe(false);
    expect(isLiveHostReport({ type: "mediaFailed", kind: "speaker", error: "x" })).toBe(false);
  });
});
