import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureSize, sameCaptureSize } from "../src/components/live-host/capture-size";
import { FIRST_FRAME_MS, RESIZE_SETTLE_MS, RETRY_MS, WindowCaptures, type WindowCaptureDeps } from "../src/components/live-host/window-captures";

/** A capture's track: stopped or not, its constraints, and an `ended` it can fire. */
class FakeTrack extends EventTarget {
  stopped = false;
  readonly constraints: MediaTrackConstraints[] = [];
  refuseConstraints = false;
  constructor(readonly name: string) {
    super();
  }
  stop(): void {
    this.stopped = true;
  }
  async applyConstraints(constraints?: MediaTrackConstraints): Promise<void> {
    if (this.refuseConstraints) throw new Error("overconstrained");
    this.constraints.push(constraints ?? {});
  }
  end(): void {
    this.dispatchEvent(new Event("ended"));
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The browser and the room around the captures, every capture held until the test lets it land. */
function harness(options: { ratio?: number; firstFrame?: boolean } = {}) {
  const opens: Array<{ windowId: string; size: { width: number; height: number }; landing: Deferred<FakeTrack>; landed?: boolean }> = [];
  const tracks: FakeTrack[] = [];
  const published: Array<[string, string]> = [];
  const unpublished: string[] = [];
  const stalled: string[] = [];
  let sourceFor: (windowId: string) => string | null = (windowId) => `source-${windowId}`;
  let refusing = false;
  const deps: WindowCaptureDeps<FakeTrack> = {
    source: (windowId) => Promise.resolve(sourceFor(windowId)),
    open: (sourceId, size) => {
      const landing = deferred<FakeTrack>();
      opens.push({ windowId: sourceId.replace("source-", ""), size, landing });
      return landing.promise;
    },
    firstFrame: () => Promise.resolve(options.firstFrame ?? true),
    stalled: (windowId) => stalled.push(windowId),
    pixelRatio: () => options.ratio ?? 2,
    maxSide: 2560,
    log: () => undefined,
  };
  const captures = new WindowCaptures<FakeTrack>(deps);
  // (The room's replaceWindowTrack: the window's picture is this track now, on its one publication — or, refusing, not.)
  const room = {
    replaceWindowTrack: vi.fn(async (windowId: string, track: FakeTrack) => {
      if (refusing) throw new Error("publication of local track timed out");
      published.push([windowId, track.name]);
    }),
    unpublishWindow: vi.fn(async (windowId: string) => {
      unpublished.push(windowId);
    }),
  };
  captures.setPublisher(room);
  /** Let the oldest capture still open land with a fresh track. */
  const land = async (): Promise<FakeTrack> => {
    const open = opens.find((candidate) => candidate.landed !== true);
    if (open === undefined) throw new Error("no capture is waiting");
    open.landed = true;
    const track = new FakeTrack(`${open.windowId}#${String(tracks.length + 1)}`);
    tracks.push(track);
    open.landing.resolve(track);
    await vi.advanceTimersByTimeAsync(0);
    return track;
  };
  return {
    captures,
    room,
    opens,
    tracks,
    published,
    unpublished,
    stalled,
    land,
    refuseSources(refuse: boolean) {
      sourceFor = refuse ? () => null : (windowId) => `source-${windowId}`;
    },
    /** The room fails every publication asked of it (its connection dropping, a publish timing out). */
    refusePublishing(refuse: boolean) {
      refusing = refuse;
    },
  };
}

const page = (w: number, h: number) => ({ w, h });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("captureSize", () => {
  it("is the page box in device pixels, its shape kept, even-sided, no longer than the protocol allows", () => {
    expect(captureSize(page(984, 804), 2, 2560)).toEqual({ width: 1968, height: 1608 });
    expect(captureSize(page(1720, 1000), 2, 2560)).toEqual({ width: 2560, height: 1488 });
    expect(captureSize(page(301, 201), 1, 2560)).toEqual({ width: 302, height: 202 });
  });

  it("is nothing for a box with no area", () => {
    expect(captureSize(page(0, 600), 2, 2560)).toBeNull();
    expect(captureSize(page(Number.NaN, 600), 2, 2560)).toBeNull();
  });
});

describe("sameCaptureSize", () => {
  it("leaves rounding alone; any other change is a resize", () => {
    expect(sameCaptureSize({ width: 1000, height: 800 }, { width: 1002, height: 798 })).toBe(true);
    expect(sameCaptureSize({ width: 1000, height: 800 }, { width: 1006, height: 800 })).toBe(false);
    expect(sameCaptureSize({ width: 1000, height: 800 }, { width: 1000, height: 1600 })).toBe(false);
  });
});

describe("WindowCaptures", () => {
  it("captures each streamed window one at a time, at its page's device size, and publishes it", async () => {
    const h = harness();
    h.captures.update([
      { id: "a", page: page(600, 400) },
      { id: "b", page: page(500, 500) },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    // The second waits for the first.
    expect(h.opens.map((open) => open.windowId)).toEqual(["a"]);
    expect(h.opens[0]?.size).toEqual({ width: 1200, height: 800 });
    await h.land();
    expect(h.opens.map((open) => open.windowId)).toEqual(["a", "b"]);
    await h.land();
    expect(h.published).toEqual([
      ["a", "a#1"],
      ["b", "b#2"],
    ]);
    expect(h.captures.captured()).toEqual(["a", "b"]);
  });

  it("unpublishes and stops a window that leaves the frame, and stops a capture that lands after it left", async () => {
    const h = harness();
    h.captures.update([{ id: "a", page: page(600, 400) }]);
    await vi.advanceTimersByTimeAsync(0);
    const a = await h.land();
    h.captures.update([{ id: "b", page: page(600, 400) }]);
    expect(a.stopped).toBe(true);
    expect(h.unpublished).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(0);
    // b is gone again before its capture lands: it is stopped, never published.
    h.captures.update([]);
    const b = await h.land();
    expect(b.stopped).toBe(true);
    expect(h.published).toEqual([["a", "a#1"]]);
    expect(h.captures.captured()).toEqual([]);
  });

  it("unpublishes a window that leaves while its ended capture is taken again: the room still holds it", async () => {
    const h = harness();
    h.captures.update([{ id: "a", page: page(600, 400) }]);
    await vi.advanceTimersByTimeAsync(0);
    const first = await h.land();
    await vi.advanceTimersByTimeAsync(5_000);
    // Its page went: the track ends, and a fresh capture is on its way when the window is closed (or minimized).
    first.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.opens).toHaveLength(2);
    h.captures.update([]);
    expect(h.unpublished).toEqual(["a"]);
    // The capture that lands after is stopped, never published.
    const second = await h.land();
    expect(second.stopped).toBe(true);
    expect(h.published).toEqual([["a", "a#1"]]);
  });

  it("resizes the same track in place once a resize settles, smaller or larger, and tells the room (its bitrate follows); never unpublishes", async () => {
    const h = harness({ ratio: 1 });
    h.captures.update([{ id: "a", page: page(1000, 800) }]);
    await vi.advanceTimersByTimeAsync(0);
    const first = await h.land();

    // Dragged wider: nothing until it stands still, then the same track is resized, and handed to the room again.
    h.captures.update([{ id: "a", page: page(1030, 800) }]);
    h.captures.update([{ id: "a", page: page(1060, 800) }]);
    await vi.advanceTimersByTimeAsync(RESIZE_SETTLE_MS - 1);
    expect(first.constraints).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(first.constraints).toEqual([{ width: 1060, height: 800 }]);
    expect(h.published).toEqual([
      ["a", "a#1"],
      ["a", "a#1"],
    ]);

    // Much larger, then much smaller: the same, in place — no fresh capture, nothing unpublished, nothing stopped.
    h.captures.update([{ id: "a", page: page(1600, 1000) }]);
    await vi.advanceTimersByTimeAsync(RESIZE_SETTLE_MS);
    h.captures.update([{ id: "a", page: page(500, 400) }]);
    await vi.advanceTimersByTimeAsync(RESIZE_SETTLE_MS);
    expect(first.constraints.slice(1)).toEqual([
      { width: 1600, height: 1000 },
      { width: 500, height: 400 },
    ]);
    expect(h.opens).toHaveLength(1);
    expect(h.published.map(([, name]) => name)).toEqual(["a#1", "a#1", "a#1", "a#1"]);
    expect(h.unpublished).toEqual([]);
    expect(first.stopped).toBe(false);
  });

  it("captures afresh a track that will not resize, and swaps the new one in on the same publication", async () => {
    const h = harness({ ratio: 1 });
    h.captures.update([{ id: "a", page: page(1000, 800) }]);
    await vi.advanceTimersByTimeAsync(0);
    const first = await h.land();
    first.refuseConstraints = true;
    h.captures.update([{ id: "a", page: page(1600, 1000) }]);
    await vi.advanceTimersByTimeAsync(RESIZE_SETTLE_MS);
    expect(h.opens[1]?.size).toEqual({ width: 1600, height: 1000 });
    const second = await h.land();
    expect(h.published).toEqual([
      ["a", "a#1"],
      ["a", "a#2"],
    ]);
    expect(h.unpublished).toEqual([]);
    // Stopped only once the room had the new one.
    expect(first.stopped).toBe(true);
    expect(second.stopped).toBe(false);
  });

  it("captures again when the track ends or main says the page is a new one", async () => {
    const h = harness();
    h.captures.update([{ id: "a", page: page(600, 400) }]);
    await vi.advanceTimersByTimeAsync(0);
    const first = await h.land();
    await vi.advanceTimersByTimeAsync(5_000);
    first.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(first.stopped).toBe(true);
    const second = await h.land();
    h.captures.recapture("a");
    await vi.advanceTimersByTimeAsync(0);
    const third = await h.land();
    expect(second.stopped).toBe(true);
    // Each swapped in on the window's publication: guests never see it unpublished.
    expect(h.published.map(([, name]) => name)).toEqual(["a#1", "a#2", "a#3"]);
    expect(h.unpublished).toEqual([]);
    expect(third.stopped).toBe(false);
  });

  it("tries a refused capture again, slower and slower, for as long as the window streams; a new page tries at once", async () => {
    const h = harness();
    h.refuseSources(true);
    h.captures.update([{ id: "a", page: page(600, 400) }]);
    await vi.advanceTimersByTimeAsync(0);
    for (const wait of RETRY_MS) await vi.advanceTimersByTimeAsync(wait);
    // Frames keep coming; they do not hurry the next try.
    h.captures.update([{ id: "a", page: page(600, 400) }]);
    h.refuseSources(false);
    const last = RETRY_MS.at(-1)!;
    await vi.advanceTimersByTimeAsync(last - 1);
    expect(h.opens).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await h.land();
    expect(h.published).toEqual([["a", "a#1"]]);

    // Refused again after a new page: main's word tries at once, not at the slow pace.
    h.refuseSources(true);
    h.captures.recapture("a");
    await vi.advanceTimersByTimeAsync(0);
    h.refuseSources(false);
    h.captures.recapture("a");
    await vi.advanceTimersByTimeAsync(0);
    await h.land();
    expect(h.published.map(([, name]) => name)).toEqual(["a#1", "a#2"]);
  });

  it("owes a new page its capture until one lands, though the old track is still at the page's size", async () => {
    const h = harness();
    h.captures.update([{ id: "a", page: page(600, 400) }]);
    await vi.advanceTimersByTimeAsync(0);
    const first = await h.land();
    // The page is a new one; main has no source for it at first, and then its capture fails.
    h.refuseSources(true);
    h.captures.recapture("a");
    await vi.advanceTimersByTimeAsync(0);
    h.refuseSources(false);
    await vi.advanceTimersByTimeAsync(RETRY_MS[0]!);
    expect(h.opens).toHaveLength(2);
    const failing = h.opens[1]!;
    failing.landed = true;
    failing.landing.reject(new Error("the tab could not be captured"));
    await vi.advanceTimersByTimeAsync(RETRY_MS[1]!);
    expect(h.opens).toHaveLength(3);
    await h.land();
    expect(h.published.map(([, name]) => name)).toEqual(["a#1", "a#2"]);
    expect(first.stopped).toBe(true);
  });

  it("reports a capture whose first frame never comes", async () => {
    const h = harness({ firstFrame: false });
    h.captures.update([{ id: "a", page: page(600, 400) }]);
    await vi.advanceTimersByTimeAsync(0);
    await h.land();
    await vi.advanceTimersByTimeAsync(FIRST_FRAME_MS);
    expect(h.stalled).toEqual(["a"]);
  });

  it("asks the room again for a picture it refused, slower and slower, though the desk stands still, until it takes it", async () => {
    const h = harness();
    h.refusePublishing(true);
    h.captures.update([{ id: "a", page: page(600, 400) }]);
    await vi.advanceTimersByTimeAsync(0);
    const first = await h.land();
    expect(h.room.replaceWindowTrack).toHaveBeenCalledTimes(1);
    // Desk frames of the same size keep coming: they ask nothing of the room.
    h.captures.update([{ id: "a", page: page(600, 400) }]);
    await vi.advanceTimersByTimeAsync(RETRY_MS[0]! - 1);
    expect(h.room.replaceWindowTrack).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.room.replaceWindowTrack).toHaveBeenCalledTimes(2);
    for (const wait of RETRY_MS.slice(1)) await vi.advanceTimersByTimeAsync(wait);
    expect(h.room.replaceWindowTrack).toHaveBeenCalledTimes(RETRY_MS.length + 1);
    // The last wait repeats; the room takes it once it can, and is asked nothing more.
    const last = RETRY_MS.at(-1)!;
    await vi.advanceTimersByTimeAsync(last);
    expect(h.room.replaceWindowTrack).toHaveBeenCalledTimes(RETRY_MS.length + 2);
    h.refusePublishing(false);
    await vi.advanceTimersByTimeAsync(last);
    expect(h.published).toEqual([["a", "a#1"]]);
    await vi.advanceTimersByTimeAsync(3 * last);
    expect(h.room.replaceWindowTrack).toHaveBeenCalledTimes(RETRY_MS.length + 3);
    // The same capture all along: nothing captured again, nothing stopped.
    expect(h.opens).toHaveLength(1);
    expect(first.stopped).toBe(false);
  });

  it("asks the room for every window's picture at once when it is back after a drop", async () => {
    const h = harness();
    h.captures.update([
      { id: "a", page: page(600, 400) },
      { id: "b", page: page(600, 400) },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    await h.land();
    // The connection drops as b goes out: refused.
    h.refusePublishing(true);
    await h.land();
    h.refusePublishing(false);
    h.captures.reconnected();
    await vi.advanceTimersByTimeAsync(0);
    // b goes out; a, which the room had (or lost, joining afresh), is asked again too.
    expect(h.published).toEqual([
      ["a", "a#1"],
      ["a", "a#1"],
      ["b", "b#2"],
    ]);
    // The ask b's refusal had set up went with it.
    await vi.advanceTimersByTimeAsync(RETRY_MS.at(-1)!);
    expect(h.room.replaceWindowTrack).toHaveBeenCalledTimes(4);
  });

  it("asks no more for a refused picture once a new capture is in, the window leaves, or a new room has it", async () => {
    const h = harness();
    h.refusePublishing(true);
    h.captures.update([
      { id: "a", page: page(600, 400) },
      { id: "b", page: page(600, 400) },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    await h.land();
    await h.land();
    expect(h.room.replaceWindowTrack).toHaveBeenCalledTimes(2);
    // a's page is a new one: its fresh capture is what is asked for now.
    h.refusePublishing(false);
    h.captures.recapture("a");
    await vi.advanceTimersByTimeAsync(0);
    await h.land();
    expect(h.published).toEqual([["a", "a#3"]]);
    // b leaves the desk.
    h.captures.update([{ id: "a", page: page(600, 400) }]);
    expect(h.unpublished).toEqual(["b"]);
    await vi.advanceTimersByTimeAsync(3 * RETRY_MS.at(-1)!);
    expect(h.room.replaceWindowTrack).toHaveBeenCalledTimes(3);

    // Refused by one room, then handed to the next: the last is asked no more.
    h.refusePublishing(true);
    h.captures.recapture("a");
    await vi.advanceTimersByTimeAsync(0);
    await h.land();
    expect(h.room.replaceWindowTrack).toHaveBeenCalledTimes(4);
    const next = { replaceWindowTrack: vi.fn(async () => undefined), unpublishWindow: vi.fn(async () => undefined) };
    h.captures.setPublisher(next);
    expect(next.replaceWindowTrack).toHaveBeenCalledWith("a", h.tracks.at(-1));
    await vi.advanceTimersByTimeAsync(3 * RETRY_MS.at(-1)!);
    expect(h.room.replaceWindowTrack).toHaveBeenCalledTimes(4);
    expect(next.replaceWindowTrack).toHaveBeenCalledTimes(1);
  });

  it("publishes what it holds to a new room, and stops everything on dispose, a capture in flight included", async () => {
    const h = harness();
    h.captures.update([
      { id: "a", page: page(600, 400) },
      { id: "b", page: page(600, 400) },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    const a = await h.land();
    const next = { replaceWindowTrack: vi.fn(async () => undefined), unpublishWindow: vi.fn(async () => undefined) };
    h.captures.setPublisher(next);
    expect(next.replaceWindowTrack).toHaveBeenCalledWith("a", a);
    h.captures.dispose();
    expect(a.stopped).toBe(true);
    const b = await h.land();
    expect(b.stopped).toBe(true);
    expect(next.replaceWindowTrack).toHaveBeenCalledTimes(1);
  });
});
