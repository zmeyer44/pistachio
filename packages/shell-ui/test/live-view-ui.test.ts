import { describe, expect, it } from "vitest";
import { DEFAULT_SHELL_STATE, isShellCommand, isShellState } from "@pistachio/shell-contracts/chrome";
import type { CloudFrame } from "@pistachio/shell-contracts/ipc";
import {
  frameAspectRatio,
  frameIsForRun,
  frameSource,
  keyInput,
  liveModifiers,
  liveMouseButton,
  livePoint,
  mouseInput,
  virtualKeyCode,
} from "../src/lib/live-view";

function frame(patch: Partial<CloudFrame> = {}, metadata: Partial<CloudFrame["metadata"]> = {}): CloudFrame {
  return {
    runId: "run-1",
    data: "AAAA",
    width: 1280,
    height: 800,
    ...patch,
    metadata: { deviceWidth: 1280, deviceHeight: 800, pageScaleFactor: 1, scrollOffsetX: 0, scrollOffsetY: 0, ...metadata },
  };
}

const NO_MODIFIERS = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };

describe("livePoint", () => {
  it("is §8.5's expression exactly when the image is painted at its own size", () => {
    // x = offsetX * metadata.deviceWidth / width, with offsetX = clientX - left.
    const box = { left: 40, top: 20, width: 1280, height: 800 };
    expect(livePoint(frame(), box, 40 + 640, 20 + 400)).toEqual({ x: 640, y: 400 });
    expect(livePoint(frame({}, { deviceWidth: 640, deviceHeight: 400 }), box, 40 + 640, 20 + 400)).toEqual({ x: 320, y: 200 });
  });

  it("corrects for the scale the pane paints it at", () => {
    // The same click on an image drawn at half size is the same page point.
    const half = { left: 0, top: 0, width: 640, height: 400 };
    expect(livePoint(frame(), half, 320, 200)).toEqual({ x: 640, y: 400 });
    expect(livePoint(frame(), half, 0, 0)).toEqual({ x: 0, y: 0 });
  });

  it("never points outside the page, whatever the pointer does", () => {
    const box = { left: 0, top: 0, width: 1280, height: 800 };
    expect(livePoint(frame(), box, -50, -50)).toEqual({ x: 0, y: 0 });
    expect(livePoint(frame(), box, 5_000, 5_000)).toEqual({ x: 1280, y: 800 });
  });

  it("answers the origin rather than NaN for a box or a frame with no extent", () => {
    expect(livePoint(frame(), { left: 0, top: 0, width: 0, height: 0 }, 10, 10)).toEqual({ x: 0, y: 0 });
    expect(livePoint(frame({ width: 0, height: 0 }), { left: 0, top: 0, width: 100, height: 100 }, 10, 10)).toEqual({ x: 0, y: 0 });
    expect(livePoint(frame(), { left: 0, top: 0, width: 100, height: 100 }, Number.NaN, 10)).toMatchObject({ x: 0 });
  });
});

describe("liveModifiers", () => {
  it("is the CDP bitmask: Alt 1, Ctrl 2, Meta 4, Shift 8", () => {
    expect(liveModifiers(NO_MODIFIERS)).toBe(0);
    expect(liveModifiers({ ...NO_MODIFIERS, altKey: true })).toBe(1);
    expect(liveModifiers({ ...NO_MODIFIERS, ctrlKey: true })).toBe(2);
    expect(liveModifiers({ ...NO_MODIFIERS, metaKey: true })).toBe(4);
    expect(liveModifiers({ ...NO_MODIFIERS, shiftKey: true })).toBe(8);
    expect(liveModifiers({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15);
  });
});

describe("mouse input", () => {
  it("names the button the DOM numbers, and nothing while none is held", () => {
    expect(liveMouseButton(0)).toBe("left");
    expect(liveMouseButton(1)).toBe("middle");
    expect(liveMouseButton(2)).toBe("right");
    expect(liveMouseButton(4)).toBe("none");
    expect(liveMouseButton(0, false)).toBe("none");
  });

  it("builds the §8.5 envelope, with the wheel deltas only when there are some", () => {
    expect(mouseInput({ type: "mousePressed", point: { x: 12, y: 34 }, button: "left", clickCount: 2, modifiers: 8 })).toEqual({
      t: "input",
      event: { kind: "mouse", type: "mousePressed", x: 12, y: 34, button: "left", clickCount: 2, modifiers: 8 },
    });
    const wheel = mouseInput({ type: "mouseWheel", point: { x: 1, y: 2 }, deltaX: 0, deltaY: -120 });
    expect(wheel).toMatchObject({ event: { deltaX: 0, deltaY: -120, button: "none", clickCount: 0 } });
    expect(Object.keys((mouseInput({ type: "mouseMoved", point: { x: 1, y: 2 } }) as { event: object }).event)).not.toContain("deltaY");
  });
});

describe("key input", () => {
  it("sends text only for a printable keyDown", () => {
    const down = keyInput({ key: "a", code: "KeyA", ...NO_MODIFIERS }, "keyDown");
    expect(down).toMatchObject({ event: { kind: "key", type: "keyDown", key: "a", code: "KeyA", text: "a", windowsVirtualKeyCode: 65 } });
    const up = keyInput({ key: "a", code: "KeyA", ...NO_MODIFIERS }, "keyUp");
    expect(up).toMatchObject({ event: { type: "keyUp" } });
    expect(Object.keys((up as { event: object }).event)).not.toContain("text");
  });

  it("does not type the letter of a shortcut", () => {
    const command = keyInput({ key: "c", code: "KeyC", ...NO_MODIFIERS, metaKey: true }, "keyDown");
    expect(Object.keys((command as { event: object }).event)).not.toContain("text");
    expect(command).toMatchObject({ event: { modifiers: 4 } });
  });

  it("carries a virtual key code for the keys that need one, and refuses an empty key", () => {
    expect(virtualKeyCode("Enter")).toBe(13);
    expect(virtualKeyCode("ArrowLeft")).toBe(37);
    expect(virtualKeyCode("Backspace")).toBe(8);
    expect(virtualKeyCode("q")).toBe(81);
    expect(virtualKeyCode("F5")).toBeUndefined();
    expect(keyInput({ key: "", code: "", ...NO_MODIFIERS }, "keyDown")).toBeNull();
    expect(keyInput({ key: "Enter", code: "Enter", ...NO_MODIFIERS }, "keyDown")).toMatchObject({
      event: { windowsVirtualKeyCode: 13 },
    });
  });
});

describe("the image itself", () => {
  it("is the frame's base64 as a data URL, at the frame's own ratio", () => {
    expect(frameSource(frame({ data: "Zm9v" }))).toBe("data:image/jpeg;base64,Zm9v");
    expect(frameAspectRatio(frame({ width: 1024, height: 640 }))).toBe("1024 / 640");
    expect(frameAspectRatio(null)).toBe("1280 / 800");
    expect(frameAspectRatio(frame({ width: 0, height: 0 }))).toBe("1280 / 800");
  });
});

describe("the shell's side of the live view", () => {
  it("takes the command with or without a run id, and refuses a silly one", () => {
    expect(isShellCommand({ type: "openLiveView" })).toBe(true);
    expect(isShellCommand({ type: "openLiveView", runId: "run-1" })).toBe(true);
    expect(isShellCommand({ type: "closeLiveView" })).toBe(true);
    expect(isShellCommand({ type: "openLiveView", runId: "" })).toBe(false);
    expect(isShellCommand({ type: "openLiveView", runId: 7 })).toBe(false);
    expect(isShellCommand({ type: "openLiveView", runId: "x".repeat(129) })).toBe(false);
  });

  it("carries the flag in the state the shell publishes to main, and requires it", () => {
    expect(DEFAULT_SHELL_STATE.liveViewOpen).toBe(false);
    expect(isShellState({ ...DEFAULT_SHELL_STATE, liveViewOpen: true })).toBe(true);
    const { liveViewOpen: _omitted, ...without } = DEFAULT_SHELL_STATE;
    expect(isShellState(without)).toBe(false);
  });
});

describe("which frames may be painted", () => {
  it("takes the run's own frames and drops the previous run's", () => {
    expect(frameIsForRun(frame({ runId: "run-1" }), "run-1")).toBe(true);
    expect(frameIsForRun(frame({ runId: "run-1" }), "run-2")).toBe(false);
  });

  it("takes anything while no run is being shown", () => {
    // The view is opened before main answers with the run it attached to;
    // blanking the surface in that gap would be a flicker, not honesty.
    expect(frameIsForRun(frame({ runId: "run-1" }), null)).toBe(true);
  });

  it("is asked twice per frame, so a run change mid-flight drops it", () => {
    // Arrival, then again inside the animation frame it was coalesced into:
    // between the two the view can be showing a different run.
    const arriving = frame({ runId: "run-1" });
    expect(frameIsForRun(arriving, "run-1")).toBe(true);
    expect(frameIsForRun(arriving, "run-2")).toBe(false);
  });
});
