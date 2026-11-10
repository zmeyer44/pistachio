import { afterEach, describe, expect, it, vi } from "vitest";
import { DISK_CHECK_MS, formatBytes, GB, startVerdict, watchVerdict } from "../src/engine/disk.js";
import { AppendLog, EventsWriter, type AppendSink } from "../src/engine/events-writer.js";
import { formatClock, idOfPath, isRecordingId, recordingFiles, recordingId, recordingIdTime, uniqueRecordingId } from "../src/engine/ids.js";
import { barFor, LevelList, LevelMeter, levelBytes, meterBars, rms, toDbfs } from "../src/engine/levels.js";
import { choicesFrom, qualityOf } from "../src/engine/choices.js";
import { projectFor, RecordingSession, screenBitrate, type RecorderApi, type RecordOptions } from "../src/engine/recorder.js";
import type { Recording } from "../src/lib/events.js";
import { solveDefaults } from "../src/lib/project.js";
import { readProject, writeProject } from "../src/lib/project.js";
import type { RecordedEvent } from "../src/lib/types.js";
import { isLive, isOver, next, type SessionAction, type SessionState } from "../src/engine/state.js";
import { appendSink, dataWritableStream } from "../src/engine/writable.js";

/** A sink that keeps what was written, as text lines per write. */
function memorySink() {
  const writes: string[] = [];
  let opened = 0;
  let closed = false;
  const decoder = new TextDecoder();
  const open = async (): Promise<AppendSink> => {
    opened += 1;
    return {
      write: async (chunk) => {
        writes.push(decoder.decode(chunk));
      },
      close: async () => {
        closed = true;
      },
    };
  };
  return {
    open,
    writes,
    get opened() {
      return opened;
    },
    get closed() {
      return closed;
    },
    lines: () => writes.join("").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

const META = { source: { kind: "tab" as const, tabId: "t1", title: "A page", url: "https://example.com/" }, capture: { w: 3200, h: 1800, dpr: 2 }, view: { w: 1600, h: 900 }, fps: 60, startedAt: 1000 };

afterEach(() => {
  vi.useRealTimers();
});

describe("the events writer", () => {
  it("writes nothing before the meta line, and the meta line first", async () => {
    const sink = memorySink();
    const clock = { now: 0 };
    const writer = new EventsWriter(sink.open, { now: () => clock.now, flushMs: 0, reorderMs: 0 });
    writer.start(1000);
    writer.add({ t: 1100, k: "move", x: 1, y: 2 });
    clock.now = 5000;
    await writer.flush();
    expect(sink.writes).toEqual([]);
    expect(sink.opened).toBe(0);
    writer.setMeta(META);
    await writer.flush();
    const lines = sink.lines();
    expect(lines[0]).toEqual({ t: 0, k: "meta", ...META });
    expect(lines[1]).toEqual({ t: 100, k: "move", x: 1, y: 2 });
  });

  it("makes t relative to t0, rounded to a tenth of a millisecond, and drops what came before", async () => {
    const sink = memorySink();
    const writer = new EventsWriter(sink.open, { now: () => 1e9, flushMs: 0, reorderMs: 0 });
    // (Before t0 is known, events wait; those before t0 are dropped when it is.)
    writer.add({ t: 990, k: "move", x: 0, y: 0 });
    writer.add({ t: 1004.26, k: "move", x: 1, y: 1 });
    writer.start(1000);
    writer.setMeta(META);
    writer.add({ t: 1500.04, k: "down", x: 5, y: 6, button: "left" });
    writer.add({ t: 999.9, k: "move", x: 2, y: 2 });
    await writer.close();
    const lines = sink.lines();
    expect(lines.map((line) => line["t"])).toEqual([0, 4.3, 500]);
    expect(lines[2]).toMatchObject({ k: "down", button: "left" });
    expect(writer.events.map((event) => event.t)).toEqual([4.3, 500]);
    expect(sink.closed).toBe(true);
  });

  it("starts in the state the subscription found: the last page, box and cursor before t0 at t = 0", async () => {
    const sink = memorySink();
    const writer = new EventsWriter(sink.open, { now: () => 1e9, flushMs: 0, reorderMs: 0 });
    // (Said when the subscription begins, during the countdown; then the person moves before the first frame.)
    writer.add({ t: 100, k: "box", view: { x: 0, y: 0, w: 1144, h: 884 }, visible: true });
    writer.add({ t: 100, k: "nav", url: "https://example.com/a", title: "A" });
    writer.add({ t: 400, k: "nav", url: "https://example.com/b", title: "B" });
    writer.add({ t: 500, k: "move", x: 3, y: 4 });
    writer.add({ t: 600, k: "cursor", type: "pointer" });
    writer.start(1000);
    writer.setMeta(META);
    writer.add({ t: 1200, k: "move", x: 5, y: 6 });
    // (A page's word from before t0, delivered late: still the start's.)
    writer.add({ t: 700, k: "load", loading: false });
    await writer.close();
    const lines = sink.lines().slice(1);
    expect(lines.map((line) => [line["t"], line["k"]])).toEqual([
      [0, "box"],
      [0, "nav"],
      [0, "cursor"],
      [0, "load"],
      [200, "move"],
    ]);
    expect(lines[1]).toMatchObject({ url: "https://example.com/b", title: "B" });
    expect(writer.events.map((event) => event.k)).toEqual(["box", "nav", "cursor", "load", "move"]);
  });

  it("appends in 250 ms batches: one write a batch, none for an empty one", async () => {
    vi.useFakeTimers();
    const sink = memorySink();
    const clock = { now: 1000 };
    const writer = new EventsWriter(sink.open, { now: () => clock.now, reorderMs: 0 });
    writer.start(1000);
    writer.setMeta(META);
    for (let index = 0; index < 10; index += 1) writer.add({ t: 1000 + index * 10, k: "move", x: index, y: index });
    clock.now = 1200;
    await vi.advanceTimersByTimeAsync(250);
    expect(sink.writes).toHaveLength(1);
    expect(sink.writes[0]?.split("\n").filter(Boolean)).toHaveLength(11);
    await vi.advanceTimersByTimeAsync(250);
    expect(sink.writes).toHaveLength(1);
    writer.add({ t: 1300, k: "frame" });
    clock.now = 1700;
    await vi.advanceTimersByTimeAsync(250);
    expect(sink.writes).toHaveLength(2);
    expect(sink.writes[1]).toBe('{"t":300,"k":"frame"}\n');
    await writer.close();
  });

  it("sorts each batch and keeps the youngest lines back for late input", async () => {
    const sink = memorySink();
    const clock = { now: 2000 };
    const writer = new EventsWriter(sink.open, { now: () => clock.now, flushMs: 0, reorderMs: 300 });
    writer.start(1000);
    writer.setMeta(META);
    writer.add({ t: 1950, k: "frame" });
    writer.add({ t: 1500, k: "frame" });
    writer.add({ t: 1400, k: "move", x: 0, y: 0 });
    await writer.flush();
    // Media time is 1000 ms: lines up to 700 ms are written, 950 waits.
    expect(sink.lines().map((line) => line["t"])).toEqual([0, 400, 500]);
    writer.add({ t: 1900, k: "move", x: 1, y: 1 });
    await writer.close();
    expect(sink.lines().map((line) => line["t"])).toEqual([0, 400, 500, 900, 950]);
  });

  it("takes pauses out of t: the pause and the resume share the seam", async () => {
    const sink = memorySink();
    const writer = new EventsWriter(sink.open, { now: () => 1e9, flushMs: 0, reorderMs: 0 });
    writer.start(1000);
    writer.setMeta(META);
    writer.add({ t: 1500, k: "move", x: 0, y: 0 });
    writer.pause(2000);
    expect(writer.paused).toBe(true);
    expect(writer.mediaTime(2500)).toBe(1000);
    writer.add({ t: 2200, k: "move", x: 9, y: 9 });
    writer.add({ t: 2300, k: "nav", url: "https://example.com/a", title: "A" });
    writer.add({ t: 2400, k: "nav", url: "https://example.com/b", title: "B" });
    writer.resume(5000);
    writer.add({ t: 5250, k: "move", x: 1, y: 1 });
    // (Delivered late, from inside the pause: not recorded.)
    writer.add({ t: 4000, k: "down", x: 1, y: 1, button: "left" });
    // (Delivered late, from before the pause: kept where it was.)
    writer.add({ t: 1999, k: "move", x: 3, y: 3 });
    expect(writer.mediaTime(6000)).toBe(2000);
    await writer.close();
    const lines = sink.lines().slice(1);
    expect(lines).toEqual([
      { t: 500, k: "move", x: 0, y: 0 },
      { t: 999, k: "move", x: 3, y: 3 },
      { t: 1000, k: "pause" },
      { t: 1000, k: "resume" },
      { t: 1000, k: "nav", url: "https://example.com/b", title: "B" },
      { t: 1250, k: "move", x: 1, y: 1 },
    ]);
    expect(writer.rel(3000)).toBeNull();
    expect(writer.rel(6000)).toBe(2000);
  });

  it("drops everything when abandoned", async () => {
    const sink = memorySink();
    const writer = new EventsWriter(sink.open, { now: () => 1e9, flushMs: 0, reorderMs: 0 });
    writer.start(0);
    writer.setMeta(META);
    writer.add({ t: 10, k: "frame" });
    await writer.abandon();
    expect(sink.writes).toEqual([]);
  });
});

describe("the append log", () => {
  it("concatenates what was appended into one write, and reports a failed open once a flush", async () => {
    const writes: Uint8Array[] = [];
    const log = new AppendLog(async () => ({ write: async (chunk) => void writes.push(chunk), close: async () => undefined }));
    log.append(new Uint8Array([1, 2]));
    log.append(new Uint8Array([3]));
    await log.flush();
    expect(writes.map((chunk) => [...chunk])).toEqual([[1, 2, 3]]);
    expect(log.written).toBe(3);
    const errors: unknown[] = [];
    const broken = new AppendLog(() => Promise.reject(new Error("disk")), (error) => errors.push(error));
    broken.append(new Uint8Array([1]));
    await broken.flush();
    expect(errors).toHaveLength(1);
  });
});

describe("the session's states", () => {
  const walk = (actions: SessionAction[], from: SessionState = "counting"): (SessionState | null)[] => {
    let state: SessionState = from;
    return actions.map((action) => {
      const to = next(state, action);
      if (to !== null) state = to;
      return to;
    });
  };

  it("counts, records, pauses, resumes, finalizes", () => {
    expect(walk(["go", "pause", "resume", "pause", "stop", "finish"])).toEqual(["recording", "paused", "recording", "paused", "finalizing", "done"]);
  });

  it("refuses what makes no sense", () => {
    expect(next("counting", "pause")).toBeNull();
    expect(next("counting", "finish")).toBeNull();
    expect(next("recording", "go")).toBeNull();
    expect(next("recording", "resume")).toBeNull();
    expect(next("paused", "pause")).toBeNull();
    expect(next("finalizing", "discard")).toBeNull();
    expect(next("finalizing", "stop")).toBeNull();
    for (const action of ["go", "pause", "resume", "stop", "end", "discard", "finish", "fail"] as SessionAction[]) {
      expect(next("done", action)).toBeNull();
      expect(next("discarded", action)).toBeNull();
    }
  });

  it("cancels while counting, saves what there is when the source ends, discards while recording", () => {
    expect(next("counting", "stop")).toBe("discarded");
    expect(next("counting", "end")).toBe("failed");
    expect(next("recording", "end")).toBe("finalizing");
    expect(next("paused", "end")).toBe("finalizing");
    expect(next("paused", "discard")).toBe("discarded");
    expect(next("finalizing", "fail")).toBe("failed");
    expect(isLive("finalizing")).toBe(true);
    expect(isOver("finalizing")).toBe(false);
    expect(isOver("failed")).toBe(true);
  });
});

describe("free space", () => {
  it("refuses under 1 GB, warns under 5 GB", () => {
    expect(startVerdict(0.5 * GB)).toBe("refuse");
    expect(startVerdict(1 * GB - 1)).toBe("refuse");
    expect(startVerdict(1 * GB)).toBe("warn");
    expect(startVerdict(4.9 * GB)).toBe("warn");
    expect(startVerdict(5 * GB)).toBe("ok");
    expect(startVerdict(Number.NaN)).toBe("ok");
  });

  it("stops a running recording under 1 GB, checked every ten seconds", () => {
    expect(watchVerdict(0.99 * GB)).toBe("stop");
    expect(watchVerdict(1.01 * GB)).toBe("ok");
    expect(DISK_CHECK_MS).toBe(10_000);
    expect(formatBytes(3.24 * GB)).toBe("3.2 GB");
    expect(formatBytes(640e6)).toBe("640 MB");
  });
});

describe("a recording's id and folder", () => {
  it("is the local start time, YYYY-MM-DDTHH-mm-ss", () => {
    const at = new Date(2026, 9, 30, 15, 4, 12);
    expect(recordingId(at)).toBe("2026-10-30T15-04-12");
    expect(recordingId(new Date(2027, 0, 2, 3, 5, 9))).toBe("2027-01-02T03-05-09");
    expect(recordingIdTime("2026-10-30T15-04-12")).toBe(at.getTime());
    expect(isRecordingId("2026-10-30T15-04-12")).toBe(true);
    expect(isRecordingId("2026-10-30T15-04-12-2")).toBe(true);
    expect(isRecordingId("../2026-10-30T15-04-12")).toBe(false);
    expect(isRecordingId("2026-10-30")).toBe(false);
  });

  it("takes a suffix when the second is taken", () => {
    expect(uniqueRecordingId("2026-10-30T15-04-12", new Set())).toBe("2026-10-30T15-04-12");
    expect(uniqueRecordingId("2026-10-30T15-04-12", new Set(["2026-10-30T15-04-12", "2026-10-30T15-04-12-2"]))).toBe("2026-10-30T15-04-12-3");
  });

  it("names the files in recordings/<id>/", () => {
    expect(recordingFiles("2026-10-30T15-04-12", { mic: true, camera: false })).toEqual({
      id: "2026-10-30T15-04-12",
      dir: "recordings/2026-10-30T15-04-12",
      screen: "recordings/2026-10-30T15-04-12/screen.mp4",
      mic: "recordings/2026-10-30T15-04-12/mic.m4a",
      camera: null,
      events: "recordings/2026-10-30T15-04-12/events.jsonl",
      micLevels: "recordings/2026-10-30T15-04-12/mic.levels",
      thumb: "recordings/2026-10-30T15-04-12/thumb.jpg",
      project: "recordings/2026-10-30T15-04-12/project.json",
    });
    expect(idOfPath("recordings/2026-10-30T15-04-12/screen.mp4")).toBe("2026-10-30T15-04-12");
    expect(idOfPath("exports/x.mp4")).toBeNull();
  });

  it("formats the clock", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(42_900)).toBe("0:42");
    expect(formatClock(725_000)).toBe("12:05");
    expect(formatClock(3_729_000)).toBe("1:02:09");
  });
});

describe("the mic's levels", () => {
  it("is the RMS of each 20 ms window of PCM", () => {
    const meter = new LevelMeter(48_000);
    expect(meter.window).toBe(960);
    // A full-scale square wave: RMS 1. A sine of amplitude 0.5: RMS 0.5/√2.
    const square = Float32Array.from({ length: 960 }, (_, index) => (index % 2 === 0 ? 1 : -1));
    const sine = Float32Array.from({ length: 960 }, (_, index) => 0.5 * Math.sin((2 * Math.PI * index) / 96));
    const levels = meter.push([Float32Array.from([...square, ...sine])]);
    expect(levels).toHaveLength(2);
    expect(levels[0]).toBeCloseTo(1, 6);
    expect(levels[1]).toBeCloseTo(0.5 / Math.SQRT2, 4);
  });

  it("carries a window over between chunks, averages channels in power, and resets on a pause", () => {
    const meter = new LevelMeter(44_100);
    expect(meter.window).toBe(882);
    expect(meter.push([new Float32Array(441).fill(0.5)])).toEqual([]);
    expect(meter.push([new Float32Array(441).fill(0.5)])).toEqual([0.5]);
    const stereo = new LevelMeter(100 * 50);
    expect(stereo.push([new Float32Array(100).fill(0.6), new Float32Array(100).fill(0.8)])[0]).toBeCloseTo(Math.sqrt((0.36 + 0.64) / 2), 6);
    stereo.push([new Float32Array(50).fill(1), new Float32Array(50).fill(1)]);
    stereo.reset();
    expect(stereo.push([new Float32Array(100).fill(0.1), new Float32Array(100).fill(0.1)])[0]).toBeCloseTo(0.1, 6);
  });

  it("draws the pill's four-bar meter from the last second", () => {
    expect(toDbfs(1)).toBeCloseTo(0, 6);
    expect(barFor(0)).toBe("▁");
    expect(barFor(1)).toBe("█");
    expect(barFor(0.001)).toBe("▁");
    const second = [...new Array(25).fill(0.0001), ...new Array(25).fill(1)];
    // (Four slices of 13 levels: the first all quiet, the second reaching the loud half.)
    expect(meterBars(second)).toBe("▁███");
    expect(meterBars([...new Array(50).fill(0.03)])).toBe("▄▄▄▄");
    expect(meterBars([])).toBe("▁▁▁▁");
    expect(rms([3, 4], 0, 2)).toBeCloseTo(Math.sqrt(12.5), 6);
  });

  it("keeps the levels as little-endian Float32", () => {
    const list = new LevelList();
    list.push(new Array(1500).fill(0.25));
    list.push([0.5]);
    expect(list.length).toBe(1501);
    expect(list.toArray()[1500]).toBe(0.5);
    const bytes = levelBytes([0.25, 1]);
    expect(new DataView(bytes.buffer).getFloat32(0, true)).toBe(0.25);
    expect(new DataView(bytes.buffer).getFloat32(4, true)).toBe(1);
  });
});

describe("the data-file sinks", () => {
  it("appends mediabunny's chunks in order and refuses a seek", async () => {
    const written: number[][] = [];
    const file = { write: async (chunk: ArrayBuffer | Uint8Array) => void written.push([...new Uint8Array(chunk as ArrayBuffer)]), close: async () => undefined, abort: async () => undefined };
    const counter = { bytes: 0, chunks: 0 };
    const stream = dataWritableStream(async () => file, counter);
    const writer = stream.getWriter();
    await writer.write({ type: "write", data: new Uint8Array([1, 2]), position: 0 });
    await writer.write({ type: "write", data: new Uint8Array([3]), position: 2 });
    expect(written).toEqual([[1, 2], [3]]);
    expect(counter).toEqual({ bytes: 3, chunks: 2 });
    await expect(writer.write({ type: "write", data: new Uint8Array([9]), position: 0 })).rejects.toThrow(/only appends/);
    const sink = appendSink(file);
    await sink.write(new Uint8Array([7]));
    expect(written.at(-1)).toEqual([7]);
  });
});

describe("the engine's choices", () => {
  it("reads the last choices over the settings' defaults", () => {
    expect(choicesFrom(undefined, { scale: "crisp", countdown: "3", fps: "60" })).toEqual({ mic: null, camera: false, pageAudio: true, quality: "crisp", countdown: 3 });
    expect(choicesFrom(undefined, { scale: "native", countdown: "0" })).toMatchObject({ quality: "native", countdown: 0 });
    expect(choicesFrom({ mic: "default", camera: true, pageAudio: false, quality: "native", countdown: 5 }, {})).toEqual({ mic: "default", camera: true, pageAudio: false, quality: "native", countdown: 5 });
    expect(choicesFrom({ countdown: 7, quality: "huge" }, { countdown: "5" })).toMatchObject({ countdown: 5, quality: "crisp" });
  });

  it("maps quality to scale and frame rate", () => {
    expect(qualityOf("crisp", "60")).toEqual({ scale: 2, fps: 60 });
    expect(qualityOf("crisp", "30")).toEqual({ scale: 2, fps: 30 });
    expect(qualityOf("native", "60")).toEqual({ scale: 1, fps: 30 });
  });

  it("sizes the screen's bitrate by area", () => {
    expect(screenBitrate(3840, 2160)).toBe(10e6);
    expect(screenBitrate(3200, 1800)).toBe(Math.round((10e6 * 3200 * 1800) / (3840 * 2160)));
    expect(screenBitrate(640, 360)).toBe(2e6);
    expect(screenBitrate(7680, 4320)).toBe(25e6);
  });

  it("solves project.json with the real solver: the whole recording kept, a zoom on the click", () => {
    const meta = { t: 0 as const, k: "meta" as const, ...META, cursorBaked: true };
    const events: RecordedEvent[] = [
      { t: 400, k: "move", x: 300, y: 600 },
      { t: 1200, k: "move", x: 812, y: 318 },
      { t: 2000, k: "down", button: "left", x: 812, y: 318, target: { x: 760, y: 300, w: 120, h: 36, role: "button" } },
      { t: 2090, k: "up", button: "left", x: 812, y: 318 },
      { t: 4000, k: "move", x: 820, y: 330 },
    ];
    const logged: string[] = [];
    const project = projectFor({ meta, events }, null, 12.5, (message) => logged.push(message));
    expect(logged).toEqual([]);
    expect(project.v).toBe(1);
    expect(project.cuts).toEqual([{ in: 0, out: 12.5 }]);
    expect(project.zooms.length).toBeGreaterThanOrEqual(1);
    const zoom = project.zooms[0]!;
    expect(zoom.auto).toBe(true);
    expect(zoom.start).toBeLessThan(2);
    expect(zoom.end).toBeGreaterThan(2);
    expect(zoom.level).toBeGreaterThan(1);
    // The centre is the button's, normalized to the view.
    expect(zoom.center[0]).toBeCloseTo(820 / 1600, 1);
    expect(project.export.fps).toBe(60);
    expect(projectFor({ meta: { ...meta, fps: 30 }, events }, null, 12.5).export.fps).toBe(30);
    // Stopped soon after the click: the zoom ends with the recording.
    const short = projectFor({ meta, events }, null, 2.6);
    expect(short.zooms.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...short.zooms.map((z) => z.end))).toBeLessThanOrEqual(2.6);
    // What the engine writes is what the editor reads back.
    const written = writeProject({ ...project, speed: [{ id: "s1", start: 5, end: 11, rate: Infinity, auto: "idle" }] });
    const read = readProject(written);
    expect(read.speed[0]!.rate).toBe(Infinity);
    expect(read.zooms).toEqual(project.zooms);
  });
});

/** A promise settled from outside. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** A device's or a capture's stream as the session reads it, each track's stop() counted. */
function fakeStream(kinds: ("audio" | "video")[]) {
  const tracks = kinds.map((kind) => ({ kind, readyState: "live", stop: vi.fn(), addEventListener: vi.fn(), getSettings: () => ({}) }));
  const stream = {
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((track) => track.kind === "video"),
    getAudioTracks: () => tracks.filter((track) => track.kind === "audio"),
  } as unknown as MediaStream;
  return { stream, tracks, stopped: () => tracks.every((track) => track.stop.mock.calls.length > 0) };
}

/**
 * The members of `pistachio` a session touches, doing nothing; the capture is the test's — the first tab's, and
 * then one per `captures` entry for the tabs the person moves to. `activate` is `tabs.onActivated`'s listener.
 */
function fakeRecorderApi(capture: Promise<MediaStream>, more: { captures?: Record<string, () => Promise<MediaStream>>; tabs?: Record<string, Partial<Pistachio.Tab>> } = {}) {
  const release = () => undefined;
  const file = { write: async () => undefined, close: async () => undefined, abort: async () => undefined };
  const calls: { tab: string[]; hold: string[]; released: string[]; subscribed: string[]; stopped: string[]; status: string[] } = { tab: [], hold: [], released: [], subscribed: [], stopped: [], status: [] };
  let activate: ((tabId: string | null) => void) | null = null;
  let update: ((tab: Pistachio.Tab, changed: string[]) => void) | null = null;
  const api = {
    runtime: { now: () => Date.now(), keepAlive: async () => release, log: () => undefined },
    capture: {
      hold: async (tabId: string) => {
        calls.hold.push(tabId);
        return () => calls.released.push(tabId);
      },
      tab: (tabId: string) => {
        calls.tab.push(tabId);
        const other = more.captures?.[tabId];
        return other === undefined ? capture : other();
      },
    },
    input: {
      subscribe: async (tabId: string) => {
        calls.subscribed.push(tabId);
        return { onEvent: () => release, stop: async () => void calls.stopped.push(tabId) };
      },
    },
    tabs: {
      get: async (id: string) => ({ id, spaceId: null, profileId: "p", title: `Tab ${id}`, url: `https://${id}.example/`, favIconUrl: null, active: true, loading: false, kind: "page", ...more.tabs?.[id] }),
      onActivated: (fn: (tabId: string | null) => void) => {
        activate = fn;
        return release;
      },
      onUpdated: (fn: (tab: Pistachio.Tab, changed: string[]) => void) => {
        update = fn;
        return release;
      },
    },
    files: { data: { open: async () => file, write: async () => undefined, remove: async () => undefined, freeSpace: async () => 100e9 } },
    ui: { setStatus: async (status: { text: string } | null) => void calls.status.push(status?.text ?? ""), toast: async () => undefined },
    power: { preventSleep: async () => release },
  } as unknown as RecorderApi;
  return {
    api,
    calls,
    activate: (tabId: string | null) => activate?.(tabId),
    update: (tab: Partial<Pistachio.Tab> & { id: string }, changed: string[]) =>
      update?.({ spaceId: null, profileId: "p", title: `Tab ${tab.id}`, url: `https://${tab.id}.example/`, favIconUrl: null, active: true, loading: false, kind: "page", ...tab }, changed),
  };
}

const recordOptions = (overrides: Partial<RecordOptions> = {}): RecordOptions => ({
  tabId: "t1",
  title: "A page",
  url: "https://example.com/",
  mic: null,
  camera: false,
  pageAudio: true,
  scale: 1,
  fps: 30,
  countdown: 0,
  ...overrides,
});

/** Lets every promise already settled run its handlers. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("projectFor", () => {
  it("solves on the events in the first view's units: a click after the window shrank lands where it was, not at a quarter", () => {
    const meta = { t: 0, k: "meta", source: { kind: "tab", tabId: "t1", title: "A page", url: "https://example.com/" }, capture: { w: 1600, h: 900, dpr: 1 }, view: { w: 1600, h: 900 }, fps: 30, startedAt: 0 } as unknown as Recording["meta"];
    const click = (t: number, x: number, y: number) => ({ t, k: "down" as const, x, y, button: "left" as const, target: { x: x - 50, y: y - 25, w: 100, h: 50, role: "button" } });
    const raw: Recording = {
      meta,
      events: [
        { t: 10, k: "box", view: { x: 0, y: 0, w: 1600, h: 900 }, visible: true },
        { t: 1000, k: "box", view: { x: 0, y: 0, w: 1600, h: 720 }, visible: true },
        click(2000, 800, 360),
        { t: 2010, k: "up", x: 800, y: 360, button: "left" },
      ],
    };
    const solved = projectFor(raw, null, 10);
    // The click at the shortened window's middle height is at the view's middle height: the zoom centres there —
    // where the raw numbers taken as the first view's would put it at 0.4. (The solver clamps a centre to keep the
    // viewport inside the content, to [0.4, 0.6] here: both values sit within it.)
    expect(solved.zooms.length).toBeGreaterThan(0);
    expect(solved.zooms[0]!.center[1]).toBeCloseTo(0.5, 6);
    expect(solveDefaults(raw, null, 10).zooms[0]!.center[1]).toBeCloseTo(0.4, 6);
  });
});

describe("a session follows the tab in front", () => {
  it("opens the new tab's feed — its hold, its capture, its input — before letting the first go, and names it in the pill; a shell page changes nothing", async () => {
    const first = fakeStream(["video", "audio"]);
    const second = fakeStream(["video", "audio"]);
    const rig = fakeRecorderApi(Promise.resolve(first.stream), {
      captures: { t2: async () => second.stream },
      tabs: { home: { kind: "shell", url: "pistachio://home/" } },
    });
    const session = new RecordingSession(rig.api, "2026-10-30T15-04-12", recordOptions({ countdown: 3 }));
    await session.begin();
    expect(rig.calls.tab).toEqual(["t1"]);
    expect(rig.calls.hold).toEqual(["t1"]);
    expect(rig.calls.subscribed).toEqual(["t1"]);
    expect(session.snapshot().tabId).toBe("t1");
    rig.activate("t2");
    await vi.waitFor(() => expect(session.snapshot().tabId).toBe("t2"));
    expect(rig.calls.tab).toEqual(["t1", "t2"]);
    expect(rig.calls.hold).toEqual(["t1", "t2"]);
    expect(rig.calls.subscribed).toEqual(["t1", "t2"]);
    // The first feed went once the second was up: its tracks stopped, its input stopped, its hold released.
    expect(first.stopped()).toBe(true);
    expect(second.stopped()).toBe(false);
    expect(rig.calls.stopped).toEqual(["t1"]);
    expect(rig.calls.released).toEqual(["t1"]);
    expect(rig.calls.status.at(-1)).toContain("Tab t2");
    // Its page's title arrives after the switch (a tab activated as it opens is "New tab" until then): the pill follows.
    rig.update({ id: "t2", title: "Second page" }, ["title"]);
    expect(session.snapshot().title).toBe("Second page");
    expect(rig.calls.status.at(-1)).toContain("Second page");
    rig.update({ id: "t1", title: "Elsewhere" }, ["title"]);
    expect(session.snapshot().title).toBe("Second page");
    // Home in front: the recording stays on the page (nothing is opened, nothing let go).
    rig.activate("home");
    await settle();
    await settle();
    expect(rig.calls.tab).toEqual(["t1", "t2"]);
    expect(session.snapshot().tabId).toBe("t2");
    // The tab in front again is the one recorded: no new feed.
    rig.activate("t2");
    await settle();
    await settle();
    expect(rig.calls.tab).toEqual(["t1", "t2"]);
    await session.discard();
    expect(second.stopped()).toBe(true);
    expect(rig.calls.released).toEqual(["t1", "t2"]);
  });
});

describe("a session that never starts", () => {
  it("stops the mic when the window's capture fails", async () => {
    const capture = deferred<MediaStream>();
    const mic = fakeStream(["audio"]);
    const ended = vi.fn();
    const session = new RecordingSession(fakeRecorderApi(capture.promise).api, "2026-10-30T15-04-12", recordOptions({ mic: "default" }), { ended }, { getUserMedia: async () => mic.stream });
    const begun = session.begin();
    await settle();
    capture.reject(new Error("no frame to capture"));
    await expect(begun).rejects.toThrow("no frame to capture");
    expect(session.state).toBe("failed");
    expect(ended).toHaveBeenCalledWith(session, expect.objectContaining({ state: "failed" }));
    expect(mic.stopped()).toBe(true);
  });

  it("stops a mic that opens only after the capture failed; a camera that never opened is no error", async () => {
    const micOpen = deferred<MediaStream>();
    const mic = fakeStream(["audio"]);
    const session = new RecordingSession(
      fakeRecorderApi(Promise.reject(new Error("no frame to capture"))).api,
      "2026-10-30T15-04-12",
      recordOptions({ mic: "default", camera: true }),
      {},
      { getUserMedia: (constraints) => (constraints.video !== undefined ? Promise.reject(new Error("no camera")) : micOpen.promise) },
    );
    await expect(session.begin()).rejects.toThrow("no frame to capture");
    micOpen.resolve(mic.stream);
    await settle();
    expect(mic.stopped()).toBe(true);
  });

  it.each(["stop", "discard"] as const)("stops every stream that arrives after a %s while counting", async (how) => {
    const capture = deferred<MediaStream>();
    const micOpen = deferred<MediaStream>();
    const cameraOpen = deferred<MediaStream>();
    const screen = fakeStream(["video", "audio"]);
    const mic = fakeStream(["audio"]);
    const camera = fakeStream(["video"]);
    const ended = vi.fn();
    const session = new RecordingSession(
      fakeRecorderApi(capture.promise).api,
      "2026-10-30T15-04-12",
      recordOptions({ mic: "default", camera: true, countdown: 3 }),
      { ended },
      { getUserMedia: (constraints) => (constraints.video !== undefined ? cameraOpen.promise : micOpen.promise) },
    );
    const begun = session.begin();
    await settle();
    // (The mic opens during the count; the capture and the camera are still on their way.)
    micOpen.resolve(mic.stream);
    await settle();
    expect(session.state).toBe("counting");
    await session[how]();
    expect(session.state).toBe("discarded");
    expect(ended).toHaveBeenCalledWith(session, expect.objectContaining({ state: "discarded" }));
    capture.resolve(screen.stream);
    cameraOpen.resolve(camera.stream);
    await begun;
    await settle();
    expect(screen.stopped()).toBe(true);
    expect(mic.stopped()).toBe(true);
    expect(camera.stopped()).toBe(true);
  });
});
