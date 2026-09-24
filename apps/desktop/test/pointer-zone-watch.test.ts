import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CursorPoint } from "@pistachio/shell-contracts/ipc";
import {
  POINTER_WATCH_IDLE_MS,
  POINTER_WATCH_MS,
  PointerZoneWatch,
  type PointerWindow,
} from "../src/main/pointer-zone-watch";

type WindowEvent = Parameters<PointerWindow["on"]>[0];

/** A BrowserWindow stand-in: focus and visibility as flags, events fired by hand, sends recorded. */
function fakeWindow() {
  const listeners = new Map<WindowEvent, Array<() => void>>();
  const sent: string[] = [];
  const state = { focused: true, visible: true, minimized: false, destroyed: false };
  const window: PointerWindow = {
    isDestroyed: () => state.destroyed,
    isVisible: () => state.visible,
    isMinimized: () => state.minimized,
    isFocused: () => state.focused,
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return window;
    },
    webContents: { send: (channel) => sent.push(channel) },
  };
  const fire = (event: WindowEvent) => {
    for (const listener of listeners.get(event) ?? []) listener();
  };
  return { window, state, sent, fire };
}

const CHANNELS = { entered: "entered", left: "left" };
const inZone = (point: CursorPoint) => point.x < 20;

describe("PointerZoneWatch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reveals on a move inside the zone while the window is active, never on a resting pointer", () => {
    const { window, sent } = fakeWindow();
    let pointer: CursorPoint = { x: 5, y: 100 };
    const watch = new PointerZoneWatch(window, CHANNELS, () => pointer);
    watch.setEntry(inZone);
    // Resting inside the zone at arming: not an entry.
    vi.advanceTimersByTime(POINTER_WATCH_MS * 3);
    expect(sent).toEqual([]);
    pointer = { x: 6, y: 100 };
    vi.advanceTimersByTime(POINTER_WATCH_MS);
    expect(sent).toEqual(["entered"]);
    // Fired once: the entry disarmed itself.
    pointer = { x: 7, y: 100 };
    vi.advanceTimersByTime(POINTER_WATCH_MS * 3);
    expect(sent).toEqual(["entered"]);
    watch.dispose();
  });

  it("does not reveal through another app's window: a move while unfocused is not an entry", () => {
    const { window, state, sent, fire } = fakeWindow();
    let pointer: CursorPoint = { x: 300, y: 100 };
    const watch = new PointerZoneWatch(window, CHANNELS, () => pointer);
    watch.setEntry(inZone);
    // Another app comes to the front over ours; the pointer crosses our zone on it.
    state.focused = false;
    fire("blur");
    for (const x of [200, 100, 10, 5, 12]) {
      pointer = { x, y: 100 };
      vi.advanceTimersByTime(POINTER_WATCH_IDLE_MS);
    }
    expect(sent).toEqual([]);
    // Back to our window with the pointer still resting in the zone: still
    // not an entry — the moves happened on the other app.
    state.focused = true;
    fire("focus");
    vi.advanceTimersByTime(POINTER_WATCH_MS * 3);
    expect(sent).toEqual([]);
    // The first move made on our window is.
    pointer = { x: 13, y: 100 };
    vi.advanceTimersByTime(POINTER_WATCH_MS);
    expect(sent).toEqual(["entered"]);
    watch.dispose();
  });

  it("keeps the hold test running unfocused, so an open column still retreats", () => {
    const { window, state, sent, fire } = fakeWindow();
    let pointer: CursorPoint = { x: 5, y: 100 };
    const watch = new PointerZoneWatch(window, CHANNELS, () => pointer);
    watch.setHold(inZone);
    vi.advanceTimersByTime(POINTER_WATCH_MS * 2);
    expect(sent).toEqual([]);
    // Blur is itself a leave.
    state.focused = false;
    fire("blur");
    expect(sent).toEqual(["left"]);
    // Re-armed while unfocused (the shell put the column back), the pointer
    // wandering out is still reported, at the idle cadence.
    watch.setHold(inZone);
    pointer = { x: 500, y: 100 };
    vi.advanceTimersByTime(POINTER_WATCH_MS);
    expect(sent).toEqual(["left"]);
    vi.advanceTimersByTime(POINTER_WATCH_IDLE_MS);
    expect(sent).toEqual(["left", "left"]);
    watch.dispose();
  });

  it("never polls when disabled, nor while the window cannot be pointed at", () => {
    const { window, state, sent } = fakeWindow();
    const reads: number[] = [];
    let n = 0;
    const read = () => {
      reads.push(++n);
      return { x: n, y: 0 };
    };
    const off = new PointerZoneWatch(window, CHANNELS, read, { enabled: false });
    off.setEntry(inZone);
    vi.advanceTimersByTime(POINTER_WATCH_MS * 5);
    expect(sent).toEqual([]);
    expect(reads).toEqual([1]); // arming reads the resting place; nothing after
    off.dispose();

    reads.length = 0;
    state.minimized = true;
    const on = new PointerZoneWatch(window, CHANNELS, read);
    on.setEntry(inZone);
    vi.advanceTimersByTime(POINTER_WATCH_MS * 5);
    expect(reads).toEqual([2]);
    on.dispose();
  });
});
