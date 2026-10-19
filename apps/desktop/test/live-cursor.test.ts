/**
 * The host's pointer for the room (docs/live-share.md §6.1): the OS pointer,
 * in the window's content box, as 0..1 of the stage — off the stage it is
 * hidden — read at 60 Hz only while someone is there to see it and the host
 * is on the space, and said only when it moves.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CursorPoint } from "@pistachio/shell-contracts/ipc";
import { LIVE_POINTER_MS, LiveCursorPoll, stagePoint, type StagePoint } from "../src/main/live/live-cursor";

const STAGE = { x: 240, y: 12, w: 1200, h: 800 };

describe("stagePoint", () => {
  it("maps the window's content box onto the stage, and is null off it", () => {
    expect(stagePoint({ x: 240, y: 12 }, STAGE)).toEqual({ x: 0, y: 0 });
    expect(stagePoint({ x: 840, y: 412 }, STAGE)).toEqual({ x: 0.5, y: 0.5 });
    expect(stagePoint({ x: 1440, y: 812 }, STAGE)).toEqual({ x: 1, y: 1 });
    // Over the sidebar, or below the desk.
    expect(stagePoint({ x: 100, y: 400 }, STAGE)).toBeNull();
    expect(stagePoint({ x: 800, y: 900 }, STAGE)).toBeNull();
    expect(stagePoint({ x: 800, y: 400 }, { x: 0, y: 0, w: 0, h: 0 })).toBeNull();
  });
});

describe("LiveCursorPoll", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function poll() {
    let point: CursorPoint | null = { x: 840, y: 412 };
    const said: Array<StagePoint | null> = [];
    const reads = { count: 0 };
    const cursor = new LiveCursorPoll(
      () => {
        reads.count += 1;
        return point;
      },
      (at) => said.push(at),
    );
    return { cursor, said, reads, move: (next: CursorPoint | null) => (point = next) };
  }

  it("reads the pointer only while active with a stage, says it when it moves, and hides it as it stops", () => {
    const { cursor, said, reads, move } = poll();
    cursor.setActive(true);
    vi.advanceTimersByTime(LIVE_POINTER_MS * 5);
    expect(reads.count).toBe(0);
    cursor.setStage(STAGE);
    expect(said).toEqual([{ x: 0.5, y: 0.5 }]);
    vi.advanceTimersByTime(LIVE_POINTER_MS * 3);
    expect(said).toHaveLength(1);
    move({ x: 240, y: 12 });
    vi.advanceTimersByTime(LIVE_POINTER_MS);
    move({ x: 10, y: 10 });
    vi.advanceTimersByTime(LIVE_POINTER_MS);
    expect(said).toEqual([{ x: 0.5, y: 0.5 }, { x: 0, y: 0 }, null]);
    move({ x: 840, y: 412 });
    vi.advanceTimersByTime(LIVE_POINTER_MS);
    cursor.setActive(false);
    expect(said.at(-1)).toBeNull();
    const before = reads.count;
    vi.advanceTimersByTime(LIVE_POINTER_MS * 10);
    expect(reads.count).toBe(before);
  });

  it("goes quiet when the host leaves the space (no stage), and hides the pointer when it cannot read it", () => {
    const { cursor, said, move } = poll();
    cursor.setStage(STAGE);
    cursor.setActive(true);
    cursor.setStage(null);
    expect(said).toEqual([{ x: 0.5, y: 0.5 }, null]);
    cursor.setStage(STAGE);
    move(null);
    vi.advanceTimersByTime(LIVE_POINTER_MS * 3);
    expect(said).toEqual([{ x: 0.5, y: 0.5 }, null, { x: 0.5, y: 0.5 }, null]);
    cursor.dispose();
  });
});
