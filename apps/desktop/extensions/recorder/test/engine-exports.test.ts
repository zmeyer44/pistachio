import { describe, expect, it, vi } from "vitest";
import { Exports, noteMarkdown, parseExportStart, REVEAL_ACTION, type ExportNews, type ExportsApi } from "../src/engine/exports.js";
import type { ExportPort } from "../src/export/port.js";
import type { ExportEvent, ExportMessage } from "../src/export/protocol.js";
import { defaultProject, writeProject } from "../src/lib/project.js";

type Json = Pistachio.Json;

const REC = "2026-10-30T15-04-12";
const NAME = "Screen Recording 2026-10-30 at 3.04.12 PM.mp4";
/** A finished export's copy, as a restored card names it (any path under exports/). */
const DATA_PATH = `exports/m1abc-1-${NAME}`;
/** The copy an attempt opened: its own path (exportDataPath), read off the open it made. */
const openedPath = (run: { raw: { files: { data: { open: { mock: { calls: unknown[][] } } } } } }): string => run.raw.files.data.open.mock.calls.at(-1)?.[0] as string;
const SAVED = `/shots/${NAME}`;
const META = { t: 0, k: "meta", source: { kind: "tab", tabId: "t1", title: "A page", url: "https://example.com/" }, capture: { w: 3200, h: 1800, dpr: 2 }, view: { w: 1600, h: 900 }, fps: 60, startedAt: 1000 };

/** The editor's `exportStart`, as it sends it. */
const request = (overrides: Record<string, Json> = {}): Json => ({
  type: "exportStart",
  recordingId: REC,
  urls: { screen: `pistachio-ext://com.pistachio.recorder/__data__/recordings/${REC}/screen.mp4`, mic: null, camera: null, events: `pistachio-ext://com.pistachio.recorder/__data__/recordings/${REC}/events.jsonl` },
  project: writeProject(defaultProject()),
  meta: META,
  name: NAME,
  destination: "copy",
  title: "A page",
  ...overrides,
});

/** An export Worker the test speaks for: what it was sent, and `emit` for what it says. */
function fakeWorker() {
  const sent: ExportMessage[] = [];
  let listener: ((event: ExportEvent) => void) | null = null;
  let terminated = false;
  const port: ExportPort = {
    send: (message) => void sent.push(message),
    listen: (fn) => {
      listener = fn;
    },
    terminate: () => {
      terminated = true;
    },
  };
  return {
    port,
    sent,
    emit: (event: ExportEvent) => listener?.(event),
    get terminated() {
      return terminated;
    },
  };
}

/** The members of `pistachio` an export touches, keeping what was done with them. */
function fakeApi(options: { saveFails?: boolean } = {}) {
  const writes: number[][] = [];
  const files = new Map<string, "open" | "closed" | "aborted">();
  const removed: string[] = [];
  const toasts: { title: string; body?: string; action?: { id: string; title: string } }[] = [];
  const stored: Record<string, Json> = {};
  let held = 0;
  const api = {
    runtime: {
      keepAlive: async () => {
        held += 1;
        return () => {
          held -= 1;
        };
      },
      log: () => undefined,
    },
    files: {
      save: vi.fn(async (_data: unknown, saving: { suggestedName: string }) => {
        if (options.saveFails === true) throw new Error("the disk is full");
        return `/shots/${saving.suggestedName}`;
      }),
      reveal: vi.fn(async () => undefined),
      data: {
        open: vi.fn(async (path: string) => {
          files.set(path, "open");
          return {
            write: async (chunk: ArrayBuffer | Uint8Array) => void writes.push([...new Uint8Array(chunk as ArrayBuffer)]),
            close: async () => void files.set(path, "closed"),
            abort: async () => void files.set(path, "aborted"),
          };
        }),
        remove: vi.fn(async (path: string) => void removed.push(path)),
      },
    },
    clipboard: { write: vi.fn(async () => undefined) },
    notes: { create: vi.fn(async () => ({ id: "note_1" })) },
    ui: { toast: vi.fn(async (toast: { title: string; body?: string; action?: { id: string; title: string } }) => void toasts.push(toast)) },
    storage: {
      local: {
        get: async (keys?: string | string[]) => {
          const list = keys === undefined ? Object.keys(stored) : typeof keys === "string" ? [keys] : keys;
          return Object.fromEntries(list.filter((key) => key in stored).map((key) => [key, stored[key] as Json]));
        },
        set: async (items: Record<string, Json>) => void Object.assign(stored, items),
        remove: async (keys: string | string[]) => {
          for (const key of typeof keys === "string" ? [keys] : keys) delete stored[key];
        },
      },
    },
  };
  return {
    api: api as unknown as ExportsApi,
    raw: api,
    writes,
    files,
    removed,
    toasts,
    stored,
    /** The worker's keep-alive holds not yet released. */
    held: () => held,
  };
}

function setUp(options: { saveFails?: boolean } = {}) {
  const fake = fakeApi(options);
  const workers: ReturnType<typeof fakeWorker>[] = [];
  const news: ExportNews[] = [];
  const clock = { t: 0 };
  const exports = new Exports(fake.api, {
    createWorker: () => {
      const worker = fakeWorker();
      workers.push(worker);
      return worker.port;
    },
    notify: (item) => void news.push(item),
    now: () => clock.t,
  });
  return { ...fake, exports, workers, news, clock, worker: () => workers.at(-1)! };
}

const FINISHED = { recordingId: REC, name: NAME, dataPath: DATA_PATH, saved: SAVED, bytes: 3, durationSeconds: 4, gif: false };

/** Starts an export and runs it to `done`: two chunks, then the end. */
async function exportThrough(run: ReturnType<typeof setUp>, overrides: Record<string, Json> = {}): Promise<void> {
  expect(await run.exports.start(request(overrides))).toEqual({ ok: true });
  run.worker().emit({ type: "chunk", seq: 0, bytes: new Uint8Array([1, 2]).buffer });
  run.worker().emit({ type: "chunk", seq: 1, bytes: new Uint8Array([3]).buffer });
  run.worker().emit({ type: "done", bytes: 3, durationSeconds: 4 });
  await vi.waitFor(() => expect(run.news.some((item) => item.type === "done")).toBe(true));
  await vi.waitFor(() => expect(run.toasts.some((toast) => toast.title === "Exported" || toast.title === "The export was not saved")).toBe(true));
}

describe("the engine's exports", () => {
  it("runs the export Worker on the editor's request and tells the editors its progress", async () => {
    const run = setUp();
    expect(await run.exports.start(request())).toEqual({ ok: true });
    expect(openedPath(run)).toMatch(/^exports\/[0-9a-z]+-1-Screen Recording 2026-10-30 at 3\.04\.12 PM\.mp4$/);
    expect(run.workers).toHaveLength(1);
    const start = run.worker().sent[0];
    expect(start).toMatchObject({ type: "start", recordingDir: `recordings/${REC}`, outputPath: openedPath(run), meta: META });
    expect(start?.type === "start" && start.project.cuts).toEqual(defaultProject().cuts);
    expect(run.held()).toBe(1);
    run.clock.t = 2;
    run.worker().emit({ type: "progress", fraction: 0.5, etaSeconds: null, frames: 30 });
    const running = { recordingId: REC, name: NAME, fraction: 0.5, etaSeconds: 2, cancelling: false };
    expect(run.news).toEqual([{ type: "progress", running }]);
    expect(run.exports.state()).toEqual({ running, finished: null });
  });

  it("appends the chunks in order, answering each; then saves to the screenshots folder, copies, and says Exported", async () => {
    const run = setUp();
    await exportThrough(run);
    expect(run.writes).toEqual([[1, 2], [3]]);
    expect(run.worker().sent.filter((message) => message.type === "written")).toEqual([
      { type: "written", seq: 0 },
      { type: "written", seq: 1 },
    ]);
    expect(run.files.get(openedPath(run))).toBe("closed");
    expect(run.raw.files.save).toHaveBeenCalledWith({ dataPath: openedPath(run) }, { suggestedName: NAME, folder: "screenshots" });
    expect(run.raw.clipboard.write).toHaveBeenCalledWith({ filePath: SAVED });
    expect(run.toasts.map((toast) => toast.title)).toEqual(["Copied", "Exported"]);
    expect(run.toasts.at(-1)).toEqual({ title: "Exported", body: NAME, action: { id: REVEAL_ACTION, title: "Show in Finder" } });
    expect(run.news.at(-1)).toEqual({ type: "done", finished: { ...FINISHED, dataPath: openedPath(run) } });
    expect(run.exports.state()).toEqual({ running: null, finished: { ...FINISHED, dataPath: openedPath(run) } });
    expect(run.worker().terminated).toBe(true);
    expect(run.held()).toBe(0);
    // (The copy in the data folder stays for the finished card.)
    expect(run.removed).toEqual([]);
  });

  it("shows the file in the Finder, or writes a note that links to it, as the person chose", async () => {
    const folder = setUp();
    await exportThrough(folder, { destination: "folder" });
    expect(folder.raw.files.reveal).toHaveBeenCalledWith(SAVED);
    expect(folder.toasts.map((toast) => toast.title)).toEqual(["Exported"]);
    const note = setUp();
    await exportThrough(note, { destination: "note", title: "Issue LIN-42" });
    expect(note.raw.notes.create).toHaveBeenCalledWith({ title: "Issue LIN-42", markdown: `[Recording](file://${encodeURI(SAVED)})` });
    expect(note.toasts.map((toast) => toast.title)).toEqual(["Added to a note", "Exported"]);
  });

  it("copies or notes nothing that was not saved, says why, and never links a note to nowhere", async () => {
    const run = setUp({ saveFails: true });
    await exportThrough(run, { destination: "note" });
    expect(run.raw.notes.create).not.toHaveBeenCalled();
    expect(run.raw.clipboard.write).not.toHaveBeenCalled();
    expect(run.toasts).toEqual([{ title: "The export was not saved", body: "the disk is full" }]);
    expect(run.exports.state().finished).toEqual({ ...FINISHED, dataPath: openedPath(run), saved: null });
    expect(noteMarkdown(NAME, null)).not.toMatch(/\]\(|file:/);
    expect(noteMarkdown(NAME, null)).toContain(NAME);
    // A saved path's "#" or "?" is a character of a folder's name, not a fragment or a query.
    expect(noteMarkdown(NAME, "/Users/p/Movies/Project #1/Take ?2/Recording.mp4")).toBe("[Recording](file:///Users/p/Movies/Project%20%231/Take%20%3F2/Recording.mp4)");
  });

  it("cancels: the Worker is told, the partial file aborted and removed", async () => {
    const run = setUp();
    await run.exports.start(request());
    run.worker().emit({ type: "chunk", seq: 0, bytes: new Uint8Array([1]).buffer });
    expect(run.exports.cancel()).toBe(true);
    expect(run.worker().sent.at(-1)).toEqual({ type: "cancel" });
    expect(run.news.at(-1)).toMatchObject({ type: "progress", running: { cancelling: true } });
    run.worker().emit({ type: "cancelled" });
    await vi.waitFor(() => expect(run.news.at(-1)).toEqual({ type: "cancelled", recordingId: REC }));
    expect(run.files.get(openedPath(run))).toBe("aborted");
    expect(run.removed).toEqual([openedPath(run)]);
    expect(run.exports.state()).toEqual({ running: null, finished: null });
    expect(run.held()).toBe(0);
    expect(run.worker().terminated).toBe(true);
    expect(run.exports.cancel()).toBe(false);
  });

  it("ends on the Worker's error the same way, and the person hears it", async () => {
    const run = setUp();
    await run.exports.start(request());
    run.worker().emit({ type: "error", message: "No encoder here can make HEVC." });
    await vi.waitFor(() => expect(run.news.at(-1)).toEqual({ type: "error", recordingId: REC, message: "No encoder here can make HEVC." }));
    expect(run.files.get(openedPath(run))).toBe("aborted");
    expect(run.removed).toEqual([openedPath(run)]);
    expect(run.exports.state().running).toBeNull();
    expect(run.held()).toBe(0);
    await vi.waitFor(() => expect(run.toasts).toEqual([{ title: "The export stopped", body: "No encoder here can make HEVC." }]));
  });

  it("runs one export at a time: a second start is refused until the first ends", async () => {
    const run = setUp();
    const [first, second] = await Promise.all([run.exports.start(request()), run.exports.start(request({ recordingId: "2026-10-31T09-00-00" }))]);
    expect(first).toEqual({ ok: true });
    expect(second).toMatchObject({ ok: false, error: expect.stringMatching(/already running/) });
    expect(run.workers).toHaveLength(1);
    run.worker().emit({ type: "done", bytes: 0, durationSeconds: 1 });
    await vi.waitFor(() => expect(run.exports.state().running).toBeNull());
    expect(await run.exports.start(request())).toEqual({ ok: true });
    expect(run.workers).toHaveLength(2);
  });

  it("answers its state to an editor that opens late, and remembers the finished export across a restart", async () => {
    const run = setUp();
    await exportThrough(run);
    expect(run.exports.state()).toEqual({ running: null, finished: { ...FINISHED, dataPath: openedPath(run) } });
    const restarted = new Exports(run.api, { createWorker: () => fakeWorker().port, notify: () => undefined });
    expect(restarted.state().finished).toBeNull();
    await restarted.restore();
    expect(restarted.state()).toEqual({ running: null, finished: { ...FINISHED, dataPath: openedPath(run) } });
  });

  it("drops the finished copy when its card is dismissed or the next export begins, and only once it was saved", async () => {
    const dismissed = setUp();
    await exportThrough(dismissed);
    const first = dismissed.exports.state().finished!.dataPath;
    expect(first).toMatch(/^exports\/[0-9a-z]+-1-Screen Recording 2026-10-30 at 3\.04\.12 PM\.mp4$/);
    await dismissed.exports.dismiss();
    expect(dismissed.removed).toEqual([first]);
    expect(dismissed.exports.state().finished).toBeNull();
    expect(dismissed.stored).toEqual({});

    const next = setUp();
    await exportThrough(next);
    const kept = next.exports.state().finished!.dataPath;
    next.raw.files.data.open.mockClear();
    expect(await next.exports.start(request({ name: "Screen Recording 2026-10-30 at 3.04.12 PM.gif" }))).toEqual({ ok: true });
    expect(next.removed).toEqual([kept]);
    expect(next.raw.files.data.open).toHaveBeenCalledWith(expect.stringMatching(/^exports\/[0-9a-z]+-2-Screen Recording 2026-10-30 at 3\.04\.12 PM\.gif$/));

    const unsaved = setUp({ saveFails: true });
    await exportThrough(unsaved);
    await unsaved.exports.dismiss();
    // (Unsaved, the data copy is the only one: it stays.)
    expect(unsaved.removed).toEqual([]);
  });

  it("gives every attempt a copy of its own: a retry of an unsaved export never truncates or removes the one copy there is", async () => {
    const run = setUp({ saveFails: true });
    await exportThrough(run);
    const only = run.exports.state().finished!.dataPath;
    run.raw.files.data.open.mockClear();
    expect(await run.exports.start(request())).toEqual({ ok: true });
    const retry = run.raw.files.data.open.mock.calls[0]?.[0] as string;
    expect(retry).not.toBe(only);
    expect(run.files.get(only)).toBe("closed");
    // The retry cancelled: its own partial file goes, the first copy stays.
    run.worker().emit({ type: "cancelled" });
    await vi.waitFor(() => expect(run.news.some((item) => item.type === "cancelled")).toBe(true));
    expect(run.removed).toEqual([retry]);
    expect(run.files.get(only)).toBe("closed");
  });

  it("shows the last saved file in the Finder from the notice's button, even once its card went", async () => {
    const run = setUp();
    await exportThrough(run);
    await run.exports.dismiss();
    await run.exports.reveal();
    expect(run.raw.files.reveal).toHaveBeenCalledWith(SAVED);
  });

  it("refuses what is not an export request, and starts nothing for it", async () => {
    expect(parseExportStart(request())).toMatchObject({ recordingId: REC, name: NAME, destination: "copy", title: "A page" });
    for (const bad of [
      request({ name: "../escape.mp4" }),
      request({ name: ".hidden.mp4" }),
      request({ recordingId: "../elsewhere" }),
      request({ destination: "mail" }),
      request({ project: null }),
      request({ urls: { screen: null, mic: null, camera: null, events: null } }),
      "start",
    ]) {
      expect(typeof parseExportStart(bad)).toBe("string");
    }
    const run = setUp();
    expect(await run.exports.start(request({ name: "a/b.mp4" }))).toMatchObject({ ok: false });
    expect(run.workers).toHaveLength(0);
    expect(run.raw.files.data.open).not.toHaveBeenCalled();
  });
});
