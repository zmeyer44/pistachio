/**
 * The shell-drawn windows' pictures (docs/live-share.md §6.6,
 * src/components/live-host/shell-crops.ts): where a window lies in a frame
 * of the shell's capture — the scale read off the frame, never assumed,
 * letterboxing, the stage's edges, even pixels, rounded inward, never a
 * pixel of the mark — and when its picture is cut at all: only while a
 * shell-drawn window streams and the host is on the space is the shell
 * captured; a frame is cut only by the word of the report it was painted
 * under (its mark, read off the frame), where that word put each window and
 * only the windows it let run, however late the word comes — and, its mark
 * stale, only the windows that word and the one before it put in the same
 * place; a frame that comes before its word waits for it, the newest alone
 * and not for long; a frame with no mark that reads true is never cut; a crop of a new size goes
 * out at the old one until it has stood; a still window gets a frame anyway
 * (the capture asked for the page as it is); a held one its last picture
 * again, copied out of the capture's frame, and nothing new; every frame is
 * closed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveShellMark } from "@pistachio/shell-contracts/live-share";
import {
  contentInFrame,
  CROP_REFRESH_MS,
  cropOutput,
  cropRect,
  cropTakesMark,
  MARK_WAIT_MS,
  RESIZE_SETTLE_MS,
  RETRY_MS,
  ShellCrops,
  wholeScale,
  type CropBox,
  type CropGenerator,
  type FrameRect,
  type ShellCapture,
  type ShellCropWindow,
} from "../src/components/live-host/shell-crops";

/* ---------------------------------- fakes ---------------------------------- */

/** Every fake frame not closed yet: a frame anything made and nothing closed is one held on to. */
const unclosed = new Set<FakeFrame>();

class FakeFrame {
  closed = false;
  /** What it was made of: the frame it was cut from, the crop it is a copy of (null: a frame of the capture). */
  of: FakeFrame | null = null;
  /** A copy of a crop's pixels, in memory of its own. */
  own = false;
  constructor(
    readonly codedWidth: number,
    readonly codedHeight: number,
    /** The mark painted in it, as a reading of its corner would find it: null for none that reads true. */
    readonly mark: number | null = null,
    readonly visibleRect: FrameRect | null = null,
    /** For a crop: the size it is shown at. */
    readonly display: { width: number; height: number } | null = null,
    /** Its mark painted stale: the shell drew a window elsewhere since its report. */
    readonly stale = false,
  ) {
    unclosed.add(this);
  }
  clone(): this {
    if (this.closed) throw new Error("a closed frame cannot be cloned");
    return Object.assign(new FakeFrame(this.codedWidth, this.codedHeight, this.mark, this.visibleRect, this.display, this.stale), { of: this.of, own: this.own }) as this;
  }
  close(): void {
    this.closed = true;
    unclosed.delete(this);
  }
}

/** The frame of the capture a picture was made of. */
function rootOf(frame: FakeFrame): FakeFrame {
  let root = frame;
  while (root.of !== null) root = root.of;
  return root;
}

class FakeCapture implements ShellCapture<FakeFrame> {
  stopped = false;
  refreshes = 0;
  readonly sizes: Array<{ width: number; height: number }> = [];
  #waiting: ((frame: FakeFrame | null) => void) | null = null;
  constructor(size: { width: number; height: number }) {
    this.sizes.push(size);
  }
  read(): Promise<FakeFrame | null> {
    if (this.stopped) return Promise.resolve(null);
    return new Promise((resolve) => (this.#waiting = resolve));
  }
  async resize(size: { width: number; height: number }): Promise<void> {
    this.sizes.push(size);
  }
  refresh(): void {
    this.refreshes += 1;
  }
  stop(): void {
    this.stopped = true;
    this.#waiting?.(null);
    this.#waiting = null;
  }
  /** The shell repainted under report `mark` (stale or not): a frame of the capture's size now (or of `size`). */
  deliver(mark: number | null, size = this.sizes.at(-1)!, stale = false): FakeFrame {
    const frame = new FakeFrame(size.width, size.height, mark, null, null, stale);
    const waiting = this.#waiting;
    this.#waiting = null;
    if (waiting === null) throw new Error("nobody is reading the capture");
    waiting(frame);
    return frame;
  }
  /** The capture ended under it (the source taken back). */
  end(): void {
    this.#waiting?.(null);
    this.#waiting = null;
  }
}

class FakeGenerator implements CropGenerator<string, FakeFrame> {
  readonly written: FakeFrame[] = [];
  stopped = false;
  busy = false;
  constructor(readonly track: string) {}
  write(frame: FakeFrame): Promise<void> | null {
    if (this.busy) return null;
    this.written.push(frame);
    // (A generator closes what it takes.)
    frame.close();
    return Promise.resolve();
  }
  stop(): void {
    this.stopped = true;
  }
}

/** The stage past a 280px sidebar, under an 8px strip; a terminal window's page in it. */
const STAGE = { x: 280, y: 8, w: 1152, h: 884 };
const TERMINAL_PAGE = { x: 8, y: 0, w: 600, h: 400 };
const terminal = (live = true, page: CropBox = TERMINAL_PAGE): ShellCropWindow => ({ id: "t1", page, live });
const home = (live = true): ShellCropWindow => ({ id: "h1", page: { x: 640, y: 0, w: 500, h: 400 }, live });
/** Report `mark`'s word: where it put the stage, in a 1440 × 900 window. */
const word = (mark: number, stage: CropBox = STAGE): LiveShellMark => ({ mark, stage, viewport: { w: 1440, h: 900 } });

function harness(options: { source?: () => string | null | Promise<string | null>; copy?: (frame: FakeFrame) => Promise<FakeFrame> } = {}) {
  const viewport = { width: 1440, height: 900, ratio: 2 };
  const captures: FakeCapture[] = [];
  const generators = new Map<string, FakeGenerator>();
  const frames: FakeFrame[] = [];
  const reads: Array<{ origin: { x: number; y: number }; scale: number }> = [];
  /** Crops cut out of a frame of the capture, and copies made of one. */
  const counts = { cuts: 0, copies: 0 };
  const logged: string[] = [];
  let made = 0;
  const room = {
    replaceWindowTrack: vi.fn(async (_windowId: string, _track: string) => undefined),
    unpublishWindow: vi.fn(async (_windowId: string) => undefined),
  };
  const crops = new ShellCrops<string, FakeFrame>({
    source: async () => (options.source ?? (() => "shell-source"))(),
    open: async (_sourceId, size) => {
      const capture = new FakeCapture(size);
      captures.push(capture);
      return capture;
    },
    generator: () => {
      made += 1;
      const generator = new FakeGenerator(`track-${String(made)}`);
      generators.set(generator.track, generator);
      return generator;
    },
    readMark: async (frame, origin, scale) => {
      reads.push({ origin, scale });
      return frame.mark === null ? null : { mark: frame.mark, stale: frame.stale };
    },
    cut: (frame, rect, size) => {
      counts.cuts += 1;
      return Object.assign(new FakeFrame(rect.width, rect.height, null, rect, size), { of: frame });
    },
    copy: async (frame) => {
      counts.copies += 1;
      if (options.copy !== undefined) return options.copy(frame);
      const rect = frame.visibleRect!;
      return Object.assign(new FakeFrame(rect.width, rect.height, null, { x: 0, y: 0, width: rect.width, height: rect.height }, frame.display), { of: frame, own: true });
    },
    viewport: () => ({ ...viewport }),
    maxSide: 2560,
    captureMaxSide: 8192,
    now: () => Date.now(),
    log: (message) => logged.push(message),
  });
  crops.setPublisher(room);
  const capture = (): FakeCapture => captures.at(-1)!;
  /** A repaint of the shell under report `mark` (its mark stale, `stale`), read by the crops. */
  const repaint = async (mark: number | null, size?: { width: number; height: number }, stale = false): Promise<FakeFrame> => {
    const frame = capture().deliver(mark, size, stale);
    frames.push(frame);
    await vi.advanceTimersByTimeAsync(0);
    return frame;
  };
  /** The desk frame main sends: these windows, built from report `mark` (null: none yet). */
  const desk = (windows: ShellCropWindow[], mark: number | null, stage: CropBox | null = STAGE): void => crops.update({ windows, stage, shell: mark === null ? null : word(mark, stage ?? STAGE) });
  const writtenTo = (track: string): FakeFrame[] => generators.get(track)?.written ?? [];
  return { crops, room, captures, capture, generators, frames, reads, counts, logged, viewport, repaint, desk, writtenTo };
}

beforeEach(() => {
  vi.useFakeTimers();
  unclosed.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

/* -------------------------------- geometry -------------------------------- */

describe("where a window lies in a frame of the shell", () => {
  const content = { width: 1440, height: 900 };

  it("is its page box in the window, in the frame's own pixels: twice its CSS px on a 2× capture", () => {
    expect(cropRect({ x: 0, y: 0, width: 2880, height: 1800 }, content, STAGE, TERMINAL_PAGE)).toEqual({ x: 576, y: 16, width: 1200, height: 800 });
  });

  it("reads the scale off the frame, never assuming one, and rounds inward to even pixels", () => {
    // A capture held to 2560 wide: 1.777… device px a CSS px.
    const rect = cropRect({ x: 0, y: 0, width: 2560, height: 1600 }, content, STAGE, TERMINAL_PAGE)!;
    const scale = 2560 / 1440;
    expect([rect.x, rect.y, rect.width, rect.height].every((value) => value % 2 === 0)).toBe(true);
    expect(rect.x).toBeGreaterThanOrEqual(288 * scale);
    expect(rect.y).toBeGreaterThanOrEqual(8 * scale);
    expect(rect.x + rect.width).toBeLessThanOrEqual(888 * scale);
    expect(rect.y + rect.height).toBeLessThanOrEqual(408 * scale);
    expect(rect.width).toBeGreaterThan(600 * scale - 4);
  });

  it("finds the content where the capture letterboxed it", () => {
    // A frame taller than the window's shape: the content is centred, 50 px down.
    expect(contentInFrame({ x: 0, y: 0, width: 1440, height: 1000 }, content)).toEqual({ x: 0, y: 50, scale: 1 });
    expect(cropRect({ x: 0, y: 0, width: 1440, height: 1000 }, content, STAGE, TERMINAL_PAGE)).toEqual({ x: 288, y: 58, width: 600, height: 400 });
  });

  it("keeps to the stage: a window over its edge is cut at it, one off it is not cut at all", () => {
    const frame = { x: 0, y: 0, width: 1440, height: 900 };
    // Half over the sidebar: only what is on the stage.
    expect(cropRect(frame, content, STAGE, { x: -300, y: 100, w: 600, h: 300 })).toEqual({ x: 280, y: 108, width: 300, height: 300 });
    expect(cropRect(frame, content, STAGE, { x: -700, y: 100, w: 600, h: 300 })).toBeNull();
    // Past the window's foot.
    expect(cropRect(frame, content, STAGE, { x: 0, y: 800, w: 600, h: 300 })).toEqual({ x: 280, y: 808, width: 600, height: 84 });
  });

  it("starts on an even pixel, rounding inward, and goes no wider than the frame's picture", () => {
    expect(cropRect({ x: 0, y: 0, width: 1440, height: 900 }, content, { x: 281, y: 9, w: 1000, h: 800 }, { x: 0, y: 0, w: 501, h: 301 })).toEqual({ x: 282, y: 10, width: 500, height: 300 });
    // A frame whose picture is offset in it.
    expect(cropRect({ x: 10, y: 4, width: 1440, height: 900 }, content, STAGE, TERMINAL_PAGE)).toEqual({ x: 298, y: 12, width: 600, height: 400 });
  });

  it("goes out at its own size, or scaled to the longest side allowed", () => {
    expect(cropOutput({ x: 0, y: 0, width: 2288, height: 1768 }, 2560)).toEqual({ width: 2288, height: 1768 });
    expect(cropOutput({ x: 0, y: 0, width: 3200, height: 1800 }, 2560)).toEqual({ width: 2560, height: 1440 });
  });

  it("is a whole number of frame px a CSS px, or no frame to read a mark off", () => {
    expect(wholeScale({ x: 0, y: 0, width: 2880, height: 1800 }, content)).toBe(2);
    expect(wholeScale({ x: 0, y: 0, width: 1440, height: 900 }, content)).toBe(1);
    // An odd window at 1×, its capture asked at even sides: the page stretched a hair to fill it, its corner its own.
    expect(wholeScale({ x: 0, y: 0, width: 1442, height: 902 }, { width: 1441, height: 901 })).toBe(1);
    // Scaled down to fit a bound, or a frame of the window before a resize: no mark has pixels of its own.
    expect(wholeScale({ x: 0, y: 0, width: 2560, height: 1600 }, content)).toBeNull();
    expect(wholeScale({ x: 0, y: 0, width: 2880, height: 1800 }, { width: 1280, height: 900 })).toBeNull();
  });

  it("never takes a pixel of the mark in the window's corner", () => {
    const frame = { x: 0, y: 0, width: 2880, height: 1800 };
    expect(cropTakesMark({ x: 0, y: 0, width: 200, height: 200 }, frame, content)).toBe(true);
    expect(cropTakesMark({ x: 8, y: 4, width: 200, height: 200 }, frame, content)).toBe(true);
    expect(cropTakesMark({ x: 576, y: 16, width: 1200, height: 800 }, frame, content)).toBe(false);
    expect(cropTakesMark({ x: 0, y: 16, width: 200, height: 200 }, frame, content)).toBe(false);
  });
});

/* ---------------------------------- crops ---------------------------------- */

describe("the shell's capture", () => {
  it("is taken only while a shell-drawn window streams and the host is on the space, at the window's device pixels", async () => {
    const { desk, captures, crops } = harness();
    desk([], 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(captures).toHaveLength(0);
    desk([terminal()], 2);
    await vi.advanceTimersByTimeAsync(0);
    expect(captures).toHaveLength(1);
    expect(captures[0]!.sizes).toEqual([{ width: 2880, height: 1800 }]);
    // Away: the shell shows another space; nothing of it is captured.
    desk([terminal(false)], 2, null);
    expect(captures[0]!.stopped).toBe(true);
    expect(crops.capturing()).toBe(false);
    desk([terminal()], 3);
    await vi.advanceTimersByTimeAsync(0);
    expect(captures).toHaveLength(2);
    crops.dispose();
    expect(captures[1]!.stopped).toBe(true);
  });

  it("is captured again when it ends under it, and tried again while main hands none out", async () => {
    let allowed = false;
    const { crops, desk, captures } = harness({ source: () => (allowed ? "shell-source" : null) });
    desk([terminal()], 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(captures).toHaveLength(0);
    allowed = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(captures).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    captures[0]!.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(captures).toHaveLength(2);
    crops.dispose();
  });

  it("is opened for the desk as it is now when an opening from before the host left and came back fails", async () => {
    const asked: Array<{ refuse: (error: Error) => void }> = [];
    const { crops, desk, captures } = harness({
      source: () => (asked.length > 0 ? "shell-source" : new Promise<string>((_resolve, refuse) => asked.push({ refuse }))),
    });
    desk([terminal()], 1);
    await vi.advanceTimersByTimeAsync(0);
    // Away and back while main is still answering the first ask: that opening is no longer this desk's.
    desk([terminal(false)], 2, null);
    desk([terminal()], 3);
    await vi.advanceTimersByTimeAsync(0);
    expect(captures).toHaveLength(0);
    asked[0]!.refuse(new Error("the source went with the space"));
    await vi.advanceTimersByTimeAsync(0);
    expect(captures).toHaveLength(1);
    expect(crops.capturing()).toBe(true);
    crops.dispose();
  });

  it("follows the window's size in place, and cuts nothing from a frame of another size of it", async () => {
    const { crops, desk, capture, repaint, viewport, writtenTo } = harness();
    desk([terminal()], 1);
    await vi.advanceTimersByTimeAsync(0);
    await repaint(1);
    expect(writtenTo("track-1")).toHaveLength(1);
    viewport.width = 1280;
    viewport.height = 800;
    desk([terminal()], 1);
    expect(capture().sizes.at(-1)).toEqual({ width: 2560, height: 1600 });
    // (A frame of the old size, still on its way: no mark can be read off it as the window is now.)
    await repaint(1, { width: 2880, height: 1800 });
    expect(writtenTo("track-1")).toHaveLength(1);
    crops.dispose();
  });
});

describe("a window's picture", () => {
  it("is its box cut out of each frame by the word of the report it was painted under, on a track of its own published once, every frame closed", async () => {
    const { crops, desk, room, repaint, reads, writtenTo, frames } = harness();
    desk([terminal()], 7);
    await vi.advanceTimersByTimeAsync(0);
    await repaint(7);
    // The mark read where the page's corner is, at the capture's whole scale.
    expect(reads.at(-1)).toEqual({ origin: { x: 0, y: 0 }, scale: 2 });
    const [picture] = writtenTo("track-1");
    expect(picture!.visibleRect).toEqual({ x: 576, y: 16, width: 1200, height: 800 });
    expect(picture!.display).toEqual({ width: 1200, height: 800 });
    expect(room.replaceWindowTrack).toHaveBeenCalledTimes(1);
    expect(room.replaceWindowTrack).toHaveBeenCalledWith("t1", "track-1");
    await repaint(7);
    expect(writtenTo("track-1")).toHaveLength(2);
    expect(room.replaceWindowTrack).toHaveBeenCalledTimes(1);
    expect(frames.every((frame) => frame.closed)).toBe(true);
    crops.dispose();
  });

  it("is never cut from a frame painted under a report that held it, however late its word comes", async () => {
    const { crops, desk, repaint, writtenTo, frames } = harness();
    desk([terminal()], 1);
    await vi.advanceTimersByTimeAsync(0);
    const before = await repaint(1);
    expect(writtenTo("track-1")).toHaveLength(1);
    // A menu opens: the shell paints it under report 2, whose word main has not passed on — a stall of any length.
    await repaint(2);
    await repaint(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(writtenTo("track-1")).toHaveLength(1);
    // The word comes at last: report 2 held the terminal. Nothing painted under it is cut: what goes out is the picture from before.
    desk([terminal(false)], 2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(writtenTo("track-1").map(rootOf).every((frame) => frame === before)).toBe(true);
    expect(frames.every((frame) => frame.closed)).toBe(true);
    crops.dispose();
  });

  it("is cut from a frame that came before its word as that word comes, if it lets the window run", async () => {
    const { crops, desk, repaint, writtenTo } = harness();
    desk([terminal(false)], 4);
    await vi.advanceTimersByTimeAsync(0);
    // The menu went: report 5 painted, its word not here yet. The newest such frame waits for it.
    const early = await repaint(5);
    const newer = await repaint(5);
    expect(early.closed).toBe(true);
    expect(newer.closed).toBe(false);
    expect(writtenTo("track-1")).toHaveLength(0);
    desk([terminal(true)], 5);
    expect(writtenTo("track-1")).toHaveLength(1);
    expect(newer.closed).toBe(true);
    crops.dispose();
  });

  it("lets go of a frame whose word main passed over, or that waited too long", async () => {
    const { crops, desk, repaint, writtenTo } = harness();
    desk([terminal()], 10);
    await vi.advanceTimersByTimeAsync(0);
    const skipped = await repaint(11);
    // Main coalesced reports 11 and 12: 11's word never comes.
    desk([terminal()], 12);
    expect(skipped.closed).toBe(true);
    expect(writtenTo("track-1")).toHaveLength(0);
    const stalled = await repaint(13);
    await vi.advanceTimersByTimeAsync(MARK_WAIT_MS + 250);
    expect(stalled.closed).toBe(true);
    desk([terminal()], 13);
    expect(writtenTo("track-1")).toHaveLength(0);
    crops.dispose();
  });

  it("is never cut from a frame with no mark that reads true, nor from one its capture scaled", async () => {
    const { crops, desk, repaint, reads, writtenTo } = harness();
    desk([terminal()], 1);
    await vi.advanceTimersByTimeAsync(0);
    await repaint(null);
    const scaled = await repaint(1, { width: 2560, height: 1600 });
    expect(writtenTo("track-1")).toHaveLength(0);
    expect(scaled.closed).toBe(true);
    // (A scaled frame is not even read.)
    expect(reads).toHaveLength(1);
    crops.dispose();
  });

  it("is cut where the frame's report put the window, not where the newest word does", async () => {
    const { crops, desk, repaint, writtenTo } = harness();
    desk([terminal(true, TERMINAL_PAGE)], 1);
    await vi.advanceTimersByTimeAsync(0);
    // The window moved under report 2; a frame of report 1 comes after 2's word.
    desk([terminal(true, { x: 108, y: 50, w: 600, h: 400 })], 2);
    await repaint(1);
    expect(writtenTo("track-1").at(-1)!.visibleRect).toEqual({ x: 576, y: 16, width: 1200, height: 800 });
    await repaint(2);
    expect(writtenTo("track-1").at(-1)!.visibleRect).toEqual({ x: 776, y: 116, width: 1200, height: 800 });
    crops.dispose();
  });

  it("is cut from a frame whose mark is stale only if the word and the one before it put it in the same place: a window on the move only from a fresh frame", async () => {
    const { crops, desk, repaint, writtenTo, frames } = harness();
    desk([terminal(), home()], 1);
    await vi.advanceTimersByTimeAsync(0);
    // Carried: report 2 has the terminal elsewhere, home where report 1 had it.
    desk([terminal(true, { x: 108, y: 50, w: 600, h: 400 }), home()], 2);
    // Painted in the render report 2 went from: both, where it says.
    await repaint(2);
    expect(writtenTo("track-1").at(-1)!.visibleRect).toEqual({ x: 776, y: 116, width: 1200, height: 800 });
    expect(writtenTo("track-2")).toHaveLength(1);
    // Painted after the terminal moved on, report 3 kept back: home alone — the terminal is no longer where 2 says.
    await repaint(2, undefined, true);
    await repaint(2, undefined, true);
    expect(writtenTo("track-1")).toHaveLength(1);
    expect(writtenTo("track-2")).toHaveLength(3);
    // Let go, and settled: report 4 puts it where 3 did, so a stale frame of 4 has it where it says.
    desk([terminal(true, { x: 208, y: 50, w: 600, h: 400 }), home()], 3);
    desk([terminal(true, { x: 208, y: 50, w: 600, h: 400 }), home()], 4);
    await repaint(4, undefined, true);
    expect(writtenTo("track-1").at(-1)!.visibleRect).toEqual({ x: 976, y: 116, width: 1200, height: 800 });
    expect(frames.every((frame) => frame.closed)).toBe(true);
    crops.dispose();
  });

  it("cuts nothing from a frame whose mark is stale when main passed the word before it over: nothing says what stood still", async () => {
    const { crops, desk, repaint, writtenTo } = harness();
    desk([terminal(), home()], 1);
    // (Main coalesced 2 and 3.)
    desk([terminal(), home()], 3);
    await vi.advanceTimersByTimeAsync(0);
    await repaint(3, undefined, true);
    expect(writtenTo("track-1")).toHaveLength(0);
    expect(writtenTo("track-2")).toHaveLength(0);
    // Round the wrap, the word before 0 is 65535's.
    desk([terminal(), home()], 65_535);
    desk([terminal(), home()], 0);
    await repaint(0, undefined, true);
    expect(writtenTo("track-1")).toHaveLength(1);
    expect(writtenTo("track-2")).toHaveLength(1);
    crops.dispose();
  });

  it("keeps a fresh frame waiting for its word over a stale one of the same report after it; a newer report's frame still outruns it", async () => {
    const { crops, desk, repaint, writtenTo } = harness();
    desk([terminal(), home()], 1);
    await vi.advanceTimersByTimeAsync(0);
    // Report 2 painted fresh, then stale as the terminal moved on: its word not here yet.
    const fresh = await repaint(2);
    const stale = await repaint(2, undefined, true);
    expect(stale.closed).toBe(true);
    expect(fresh.closed).toBe(false);
    desk([terminal(true, { x: 108, y: 50, w: 600, h: 400 }), home()], 2);
    expect(writtenTo("track-1").at(-1)!.visibleRect).toEqual({ x: 776, y: 116, width: 1200, height: 800 });
    expect(writtenTo("track-2")).toHaveLength(1);
    // A newer report's frame outruns a waiting fresh one, stale or not: the newest report's frame waits.
    const older = await repaint(4);
    const newer = await repaint(5, undefined, true);
    expect(older.closed).toBe(true);
    expect(newer.closed).toBe(false);
    crops.dispose();
  });

  it("cuts a stale frame that waited for its word as stale", async () => {
    const { crops, desk, repaint, writtenTo } = harness();
    desk([terminal(), home()], 1);
    await vi.advanceTimersByTimeAsync(0);
    await repaint(2, undefined, true);
    expect(writtenTo("track-2")).toHaveLength(0);
    desk([terminal(true, { x: 108, y: 50, w: 600, h: 400 }), home()], 2);
    expect(writtenTo("track-1")).toHaveLength(0);
    expect(writtenTo("track-2")).toHaveLength(1);
    crops.dispose();
  });

  it("is held for one window and runs for another, as the word says of each", async () => {
    const { crops, desk, repaint, writtenTo } = harness();
    // The Live card over the terminal, not over home.
    desk([terminal(false), home(true)], 3);
    await vi.advanceTimersByTimeAsync(0);
    await repaint(3);
    expect(writtenTo("track-1")).toHaveLength(0);
    expect(writtenTo("track-2")).toHaveLength(1);
    crops.dispose();
  });

  it("is held by the newest word too: a frame of a report that let it run is not cut once main holds it", async () => {
    const { crops, desk, repaint, writtenTo } = harness();
    desk([terminal()], 1);
    await vi.advanceTimersByTimeAsync(0);
    await repaint(1);
    expect(writtenTo("track-1")).toHaveLength(1);
    // Main holds it now (the app hidden): the same report, its word renewed.
    desk([terminal(false)], 1);
    await repaint(1);
    expect(writtenTo("track-1")).toHaveLength(1);
    crops.dispose();
  });

  it("forgets every word when the shell's count begins again: a number from before stands for nothing now", async () => {
    const { crops, desk, repaint, writtenTo } = harness();
    desk([terminal()], 40_000);
    desk([terminal()], 40_001);
    await vi.advanceTimersByTimeAsync(0);
    // A shell that lost its count (no storage) began again behind it; 40000's word went with the old count.
    desk([terminal()], 30_000);
    await repaint(40_000);
    expect(writtenTo("track-1")).toHaveLength(0);
    await repaint(30_000);
    expect(writtenTo("track-1")).toHaveLength(1);
    crops.dispose();
  });

  it("goes out at its old size while it is being resized, then at its new one, the room told", async () => {
    const { crops, desk, room, repaint, writtenTo } = harness();
    desk([terminal()], 1);
    await vi.advanceTimersByTimeAsync(0);
    await repaint(1);
    desk([terminal(true, { x: 8, y: 0, w: 700, h: 450 })], 2);
    await repaint(2);
    const resizing = writtenTo("track-1").at(-1)!;
    expect(resizing.visibleRect).toEqual({ x: 576, y: 16, width: 1400, height: 900 });
    expect(resizing.display).toEqual({ width: 1200, height: 800 });
    expect(room.replaceWindowTrack).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RESIZE_SETTLE_MS);
    await repaint(2);
    expect(writtenTo("track-1").at(-1)!.display).toEqual({ width: 1400, height: 900 });
    expect(room.replaceWindowTrack).toHaveBeenCalledTimes(2);
    crops.dispose();
  });

  it("goes out at its new size once that has stood, though the window repaints every frame meanwhile", async () => {
    const { crops, desk, room, repaint, writtenTo } = harness();
    desk([terminal()], 1);
    await vi.advanceTimersByTimeAsync(0);
    await repaint(1);
    // Being resized: a new size every frame, a frame every 33 ms — the old size all the while.
    for (let step = 1; step <= 15; step += 1) {
      desk([terminal(true, { x: 8, y: 0, w: 600 + 10 * step, h: 400 + 5 * step })], 1 + step);
      await repaint(1 + step);
      await vi.advanceTimersByTimeAsync(33);
    }
    expect(writtenTo("track-1").at(-1)!.display).toEqual({ width: 1200, height: 800 });
    // Let go at 800 × 500, the terminal printing on: a frame every 33 ms, of a size that no longer changes.
    desk([terminal(true, { x: 8, y: 0, w: 800, h: 500 })], 20);
    for (let elapsed = 0; elapsed <= RESIZE_SETTLE_MS + 33; elapsed += 33) {
      await repaint(20);
      await vi.advanceTimersByTimeAsync(33);
    }
    await repaint(20);
    expect(writtenTo("track-1").at(-1)!.display).toEqual({ width: 1600, height: 1000 });
    expect(room.replaceWindowTrack).toHaveBeenCalledTimes(2);
    crops.dispose();
  });

  it("is had of a still page anyway: the capture asked for the page as it is once the window may run, then every second", async () => {
    const { crops, desk, capture, repaint, writtenTo } = harness();
    desk([terminal(false)], 1);
    await vi.advanceTimersByTimeAsync(0);
    // The capture's first frame came as it began, held; then nothing repaints, and nothing is asked for.
    await repaint(1);
    await vi.advanceTimersByTimeAsync(3 * CROP_REFRESH_MS);
    expect(capture().refreshes).toBe(0);
    // Let run: the page as it is, at once.
    desk([terminal(true)], 2);
    await vi.advanceTimersByTimeAsync(250);
    expect(capture().refreshes).toBe(1);
    await repaint(2);
    expect(writtenTo("track-1")).toHaveLength(1);
    // Still after it: a frame asked for once a second, so a guest who starts watching has a picture.
    await vi.advanceTimersByTimeAsync(3 * CROP_REFRESH_MS);
    expect(capture().refreshes).toBe(4);
    crops.dispose();
  });

  it("is its last safe crop again every second while it is held, copied out of the capture's frame: nothing is cut from a frame of the shell covered", async () => {
    const { crops, desk, capture, repaint, writtenTo, counts } = harness();
    // Home held from the start (the Live card over it): it never had a picture, so it has none to give again.
    desk([terminal(), home(false)], 1);
    await vi.advanceTimersByTimeAsync(0);
    const safe = await repaint(1);
    expect(writtenTo("track-1")).toHaveLength(1);
    // ⌘L: the palette over the desk. The shell goes on repainting under it; its word holds the terminal.
    desk([terminal(false), home(false)], 2);
    const cut = counts.cuts;
    const covered = [await repaint(2), await repaint(2)];
    await vi.advanceTimersByTimeAsync(3 * CROP_REFRESH_MS);
    await repaint(2);
    const written = writtenTo("track-1");
    // A frame a second for a guest who starts watching meanwhile: the picture from before ⌘L, as a copy of its own.
    expect(written).toHaveLength(4);
    expect(written.map(rootOf).every((frame) => frame === safe)).toBe(true);
    expect(written.slice(1).every((frame) => frame.own)).toBe(true);
    expect(written.some((frame) => covered.includes(rootOf(frame)))).toBe(false);
    expect(counts.cuts).toBe(cut);
    expect(counts.copies).toBe(1);
    expect(capture().refreshes).toBe(0);
    expect(writtenTo("track-2")).toHaveLength(0);
    // One frame kept for the window — the copy; the capture's frame it was cut from is let go.
    expect([...unclosed]).toEqual([expect.objectContaining({ own: true })]);
    crops.dispose();
    expect(unclosed.size).toBe(0);
  });

  it("is its last picture again while the host is away, the capture let go; its newest crop once it ran again, every one it replaced closed", async () => {
    const { crops, desk, captures, generators, repaint, writtenTo } = harness();
    desk([terminal()], 1);
    await vi.advanceTimersByTimeAsync(0);
    await repaint(1);
    const newest = await repaint(1);
    // Away: the shell shows another space, nothing of it is captured; the terminal's picture goes out again all the same.
    desk([terminal(false)], 1, null);
    expect(captures[0]!.stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(2 * CROP_REFRESH_MS);
    expect(writtenTo("track-1").slice(2).map(rootOf)).toEqual([newest, newest]);
    // Back, and resized meanwhile: it runs, cut from the new capture at its own size once that has stood; nothing goes out again.
    desk([terminal(true, { x: 8, y: 0, w: 700, h: 450 })], 2);
    await vi.advanceTimersByTimeAsync(0);
    await repaint(2);
    await vi.advanceTimersByTimeAsync(RESIZE_SETTLE_MS);
    const fresh = await repaint(2);
    const running = writtenTo("track-1").length;
    await vi.advanceTimersByTimeAsync(2 * CROP_REFRESH_MS);
    expect(writtenTo("track-1")).toHaveLength(running);
    expect(writtenTo("track-1").at(-1)!.display).toEqual({ width: 1400, height: 900 });
    // Held again: the newest crop, at its size; its track too busy once — that one dropped, closed.
    desk([terminal(false, { x: 8, y: 0, w: 700, h: 450 })], 3);
    generators.get("track-1")!.busy = true;
    await vi.advanceTimersByTimeAsync(CROP_REFRESH_MS);
    generators.get("track-1")!.busy = false;
    await vi.advanceTimersByTimeAsync(CROP_REFRESH_MS);
    expect(writtenTo("track-1")).toHaveLength(running + 1);
    expect(rootOf(writtenTo("track-1").at(-1)!)).toBe(fresh);
    expect(writtenTo("track-1").at(-1)!.display).toEqual({ width: 1400, height: 900 });
    expect(unclosed.size).toBe(1);
    // The window gone: its kept picture with it, nothing more goes out.
    desk([], 4);
    expect(unclosed.size).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * CROP_REFRESH_MS);
    expect(writtenTo("track-1")).toHaveLength(running + 1);
    crops.dispose();
  });

  it("goes out again as it was cut while it is held if its pixels cannot be copied, which is said once", async () => {
    const { crops, desk, repaint, writtenTo, logged } = harness({ copy: () => Promise.reject(new Error("this frame's pixels cannot be read")) });
    desk([terminal()], 1);
    await vi.advanceTimersByTimeAsync(0);
    const safe = await repaint(1);
    desk([terminal(false)], 2);
    await vi.advanceTimersByTimeAsync(3 * CROP_REFRESH_MS);
    expect(writtenTo("track-1").slice(1).map(rootOf)).toEqual([safe, safe, safe]);
    expect(logged.filter((message) => message.startsWith("could not copy"))).toHaveLength(1);
    crops.dispose();
    expect(unclosed.size).toBe(0);
  });

  it("drops a frame its track cannot take yet, closed, and the next one goes", async () => {
    const { crops, desk, generators, repaint, writtenTo, frames } = harness();
    desk([terminal()], 1);
    await vi.advanceTimersByTimeAsync(0);
    generators.get("track-1")!.busy = true;
    await repaint(1);
    expect(writtenTo("track-1")).toHaveLength(0);
    generators.get("track-1")!.busy = false;
    await repaint(1);
    expect(writtenTo("track-1")).toHaveLength(1);
    expect(frames.every((frame) => frame.closed)).toBe(true);
    crops.dispose();
  });

  it("is let go when its window leaves the desk: its track stopped, unpublished", async () => {
    const { crops, desk, room, generators, repaint, captures } = harness();
    desk([terminal()], 1);
    await vi.advanceTimersByTimeAsync(0);
    await repaint(1);
    desk([], 2);
    expect(generators.get("track-1")!.stopped).toBe(true);
    expect(room.unpublishWindow).toHaveBeenCalledWith("t1");
    expect(captures[0]!.stopped).toBe(true);
    crops.dispose();
  });

  it("is published to the next room once there is one again", async () => {
    const { crops, desk, room, repaint } = harness();
    desk([terminal()], 1);
    await vi.advanceTimersByTimeAsync(0);
    crops.setPublisher(null);
    await repaint(1);
    expect(room.replaceWindowTrack).not.toHaveBeenCalled();
    crops.setPublisher(room);
    expect(room.replaceWindowTrack).toHaveBeenCalledWith("t1", "track-1");
    crops.dispose();
  });

  it("is asked of the room again when it refuses it, slower and slower, though nothing changes, until it takes it", async () => {
    const { crops, desk, room, repaint } = harness();
    const timedOut = new Error("publication of local track timed out");
    room.replaceWindowTrack.mockRejectedValueOnce(timedOut).mockRejectedValueOnce(timedOut);
    desk([terminal()], 1);
    await vi.advanceTimersByTimeAsync(0);
    await repaint(1);
    expect(room.replaceWindowTrack).toHaveBeenCalledTimes(1);
    // It repaints at the size the room was told of: that asks nothing of the room.
    await repaint(1);
    await vi.advanceTimersByTimeAsync(RETRY_MS[0]! - 1);
    expect(room.replaceWindowTrack).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(room.replaceWindowTrack).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(RETRY_MS[1]!);
    expect(room.replaceWindowTrack).toHaveBeenCalledTimes(3);
    expect(room.replaceWindowTrack).toHaveBeenLastCalledWith("t1", "track-1");
    // Taken: asked no more.
    await vi.advanceTimersByTimeAsync(3 * RETRY_MS.at(-1)!);
    expect(room.replaceWindowTrack).toHaveBeenCalledTimes(3);
    crops.dispose();
  });

  it("is asked of the room at once when it is back after a drop, if it has a picture", async () => {
    const { crops, desk, room, repaint } = harness();
    room.replaceWindowTrack.mockRejectedValueOnce(new Error("publication of local track timed out"));
    // The home window is held: it has no picture, so nothing of it is asked.
    desk([terminal(), home(false)], 1);
    await vi.advanceTimersByTimeAsync(0);
    await repaint(1);
    crops.reconnected();
    await vi.advanceTimersByTimeAsync(0);
    expect(room.replaceWindowTrack.mock.calls).toEqual([
      ["t1", "track-1"],
      ["t1", "track-1"],
    ]);
    // The ask its refusal had set up went with it.
    await vi.advanceTimersByTimeAsync(RETRY_MS.at(-1)!);
    expect(room.replaceWindowTrack).toHaveBeenCalledTimes(2);
    crops.dispose();
  });

  it("is asked no more of a room that refused it once its window leaves, or a new room has it", async () => {
    const { crops, desk, room, repaint } = harness();
    room.replaceWindowTrack.mockRejectedValue(new Error("publication of local track timed out"));
    desk([terminal(), home()], 1);
    await vi.advanceTimersByTimeAsync(0);
    await repaint(1);
    expect(room.replaceWindowTrack).toHaveBeenCalledTimes(2);
    desk([home()], 2);
    expect(room.unpublishWindow).toHaveBeenCalledWith("t1");
    const next = { replaceWindowTrack: vi.fn(async (_windowId: string, _track: string) => undefined), unpublishWindow: vi.fn(async (_windowId: string) => undefined) };
    crops.setPublisher(next);
    expect(next.replaceWindowTrack.mock.calls).toEqual([["h1", "track-2"]]);
    await vi.advanceTimersByTimeAsync(3 * RETRY_MS.at(-1)!);
    expect(room.replaceWindowTrack).toHaveBeenCalledTimes(2);
    expect(next.replaceWindowTrack).toHaveBeenCalledTimes(1);
    crops.dispose();
  });
});
