/**
 * Exports, run by the engine (docs/recorder.md §5): the editor asks
 * (`runtime.sendMessage({ type: "exportStart", … })`); the engine runs the
 * export Worker (src/export/protocol.ts), appends its chunks to
 * `exports/<name>` in the extension's data, saves the file to the
 * screenshots folder and does what the person chose with it — shown in the
 * Finder, copied, or linked from a new note — then says *Exported*. The
 * worker outlives the editor's window, so closing it never stops an export.
 *
 * One export at a time. The last one finished is kept for the editor's
 * finished card — remembered in storage, so a restarted worker still knows
 * it — and its copy in the data folder goes when the card is dismissed or
 * the next export begins (once it was saved: unsaved, it is the only copy).
 *
 * The editor follows on a `runtime.connect("export")` port (`ExportNews`)
 * and asks `exportState` when it opens, so a reopened editor shows a running
 * export or the finished card. The `?fake=1` dev kit runs this same class in
 * the page, over its shim and its stand-in Worker.
 */
import type { ExportPort } from "../export/port.js";
import type { ExportEvent, ExportRequest } from "../export/protocol.js";
import { readProject } from "../lib/project.js";
import type { MetaEvent, Project } from "../lib/types.js";
import { RECORDINGS_DIR } from "./ids.js";

type Json = Pistachio.Json;

export const EXPORTS_DIR = "exports";

/**
 * Where an attempt's copy goes in the data folder: its own path, never the
 * name's alone — a retry of a name whose last copy was not saved (the save
 * failed) would otherwise truncate the one copy there is, and a cancel
 * remove it.
 */
export function exportDataPath(name: string, stamp: number, attempt: number): string {
  return `${EXPORTS_DIR}/${stamp.toString(36)}-${String(attempt)}-${name}`;
}
/** The name of the editor's port to the engine. */
export const EXPORT_PORT = "export";
/** The *Exported* notice's *Show in Finder*. */
export const REVEAL_ACTION = "recorder-reveal";
const FINISHED_KEY = "exportFinished";

export type ExportDestination = "folder" | "copy" | "note";
const DESTINATIONS: readonly string[] = ["folder", "copy", "note"];

/** An `exportStart` request, read and checked. */
export interface ExportJob {
  recordingId: string;
  urls: ExportRequest["urls"];
  project: Project;
  meta: MetaEvent;
  /** The file's name: `Screen Recording 2026-10-30 at 3.04.12 PM.mp4`. */
  name: string;
  destination: ExportDestination;
  /** A note's title, for *Add to a note*. */
  title: string;
}

export interface RunningExport {
  recordingId: string;
  name: string;
  fraction: number;
  etaSeconds: number | null;
  cancelling: boolean;
}

export interface FinishedExport {
  recordingId: string;
  name: string;
  /** The copy in the extension's data the finished card plays and drags out (`exports/<name>`). */
  dataPath: string;
  /** Where it was saved in the screenshots folder, or null when it was not. */
  saved: string | null;
  bytes: number;
  durationSeconds: number;
  gif: boolean;
}

export interface ExportState {
  running: RunningExport | null;
  finished: FinishedExport | null;
}

/** What the engine tells the editors on their "export" ports. */
export type ExportNews =
  | { type: "progress"; running: RunningExport }
  | { type: "done"; finished: FinishedExport }
  | { type: "error"; recordingId: string; message: string }
  | { type: "cancelled"; recordingId: string };

/** The members of `pistachio` an export uses (every one of them works from the worker). */
export interface ExportsApi {
  runtime: Pick<Pistachio.Runtime, "keepAlive" | "log">;
  files: Pick<Pistachio.Files, "save" | "reveal"> & { data: Pick<Pistachio.Data, "open" | "remove"> };
  clipboard: Pick<Pistachio.Clipboard, "write">;
  notes: Pick<Pistachio.Notes, "create">;
  ui: Pick<Pistachio.Ui, "toast">;
  storage: { local: Pick<Pistachio.StorageArea, "get" | "set" | "remove"> };
}

export interface ExportsOptions {
  /** A fresh export Worker for each export. */
  createWorker(): ExportPort;
  /** Tells the editors. */
  notify(news: ExportNews): void;
  /** Seconds on any clock, for the ETA. */
  now?(): number;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const isRecord = (value: Json | undefined): value is Record<string, Json> => value !== null && typeof value === "object" && !Array.isArray(value);
const textOf = (value: Json | undefined): string | null => (typeof value === "string" && value !== "" ? value : null);

/** The editor's `exportStart` read and checked: the job, or why not. The project comes as `project.json`'s text (a cut's rate is Infinity). */
export function parseExportStart(raw: Json): ExportJob | string {
  if (!isRecord(raw)) return "not an export request";
  const recordingId = raw["recordingId"];
  // (A folder's name under recordings/; the dev kit's sample is "fake".)
  if (typeof recordingId !== "string" || !/^[\w.-]{1,80}$/.test(recordingId) || recordingId.startsWith(".")) return "no such recording";
  const name = raw["name"];
  if (typeof name !== "string" || !/^[^/\\:\0]{1,200}$/.test(name) || name.startsWith(".")) return "the export's name is not a file name";
  const destination = raw["destination"];
  if (typeof destination !== "string" || !DESTINATIONS.includes(destination)) return "no such destination";
  const urls = raw["urls"];
  if (!isRecord(urls)) return "the recording's files are missing";
  const screen = textOf(urls["screen"]);
  const events = textOf(urls["events"]);
  if (screen === null || events === null) return "the recording's files are missing";
  const meta = raw["meta"];
  if (!isRecord(meta) || meta["k"] !== "meta") return "the recording's meta line is missing";
  const project = raw["project"];
  if (typeof project !== "string") return "the project is missing";
  return {
    recordingId,
    urls: { screen, mic: textOf(urls["mic"]), camera: textOf(urls["camera"]), events },
    project: readProject(project),
    meta: meta as unknown as MetaEvent,
    name,
    destination: destination as ExportDestination,
    title: textOf(raw["title"]) ?? name,
  };
}

/** *Add to a note*: a link to the saved file; with none saved (the save failed), the name alone — never a link to nowhere. */
export function noteMarkdown(name: string, saved: string | null): string {
  // (Each path segment escaped on its own: encodeURI would leave a folder's "#" or "?" as a fragment or query.)
  return saved === null ? `Recording: ${name} (not saved)` : `[Recording](file://${saved.split("/").map(encodeURIComponent).join("/")})`;
}

function finishedFrom(value: Json | undefined): FinishedExport | null {
  if (!isRecord(value)) return null;
  const { recordingId, name, dataPath, saved, bytes, durationSeconds, gif } = value;
  if (typeof recordingId !== "string" || typeof name !== "string" || typeof dataPath !== "string" || !dataPath.startsWith(`${EXPORTS_DIR}/`)) return null;
  return {
    recordingId,
    name,
    dataPath,
    saved: typeof saved === "string" ? saved : null,
    bytes: typeof bytes === "number" ? bytes : 0,
    durationSeconds: typeof durationSeconds === "number" ? durationSeconds : 0,
    gif: gif === true,
  };
}

interface Run {
  job: ExportJob;
  dataPath: string;
  port: ExportPort;
  writable: Pistachio.DataWritable;
  /** The chunks' writes, in order; `done` waits on them. */
  chain: Promise<void>;
  /** No more of the Worker's events count (done, failed or cancelled). */
  over: boolean;
  startedAt: number;
  running: RunningExport;
  /** `runtime.keepAlive`'s release, once it came. */
  hold: Promise<(() => void) | null>;
}

export class Exports {
  readonly #api: ExportsApi;
  readonly #options: ExportsOptions;
  readonly #now: () => number;
  #run: Run | null = null;
  /** Between a start request and its run (the file opening): a second start is refused meanwhile. */
  #starting = false;
  #finished: FinishedExport | null = null;
  /** The last file saved, for the notice's *Show in Finder* (the card may have gone). */
  #lastSaved: string | null = null;
  #attempts = 0;

  constructor(api: ExportsApi, options: ExportsOptions) {
    this.#api = api;
    this.#options = options;
    this.#now = options.now ?? (() => performance.now() / 1000);
  }

  state(): ExportState {
    return { running: this.#run === null ? null : { ...this.#run.running }, finished: this.#finished === null ? null : { ...this.#finished } };
  }

  /** The finished export a previous worker kept (its card, its copy to drop). */
  async restore(): Promise<void> {
    try {
      const stored = finishedFrom((await this.#api.storage.local.get(FINISHED_KEY))[FINISHED_KEY]);
      if (stored === null || this.#finished !== null || this.#run !== null) return;
      this.#finished = stored;
      this.#lastSaved ??= stored.saved;
    } catch {
      // (Nothing kept: nothing to show.)
    }
  }

  /** The editor's `exportStart`: answered once the Worker has its request (or why it has not). */
  async start(raw: Json): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.#run !== null || this.#starting) return { ok: false, error: "An export is already running: wait for it, or cancel it." };
    const job = parseExportStart(raw);
    if (typeof job === "string") return { ok: false, error: `That export cannot start: ${job}.` };
    this.#starting = true;
    try {
      // (The last export's card goes as the next begins: its file is in the screenshots folder.)
      await this.dismiss();
      this.#attempts += 1;
      const dataPath = exportDataPath(job.name, Date.now(), this.#attempts);
      let writable: Pistachio.DataWritable;
      try {
        writable = await this.#api.files.data.open(dataPath);
      } catch (error) {
        return { ok: false, error: `The export could not be written: ${messageOf(error)}` };
      }
      let port: ExportPort;
      try {
        port = this.#options.createWorker();
      } catch (error) {
        await writable.abort().catch(() => undefined);
        await this.#api.files.data.remove(dataPath).catch(() => undefined);
        return { ok: false, error: `The export could not start: ${messageOf(error)}` };
      }
      const run: Run = {
        job,
        dataPath,
        port,
        writable,
        chain: Promise.resolve(),
        over: false,
        startedAt: this.#now(),
        running: { recordingId: job.recordingId, name: job.name, fraction: 0, etaSeconds: null, cancelling: false },
        // (The worker would otherwise stop once idle with no page open: this one may have closed.)
        hold: this.#api.runtime.keepAlive("export").catch(() => null),
      };
      this.#run = run;
      port.listen((event) => this.#heard(run, event));
      port.send({ type: "start", recordingDir: `${RECORDINGS_DIR}/${job.recordingId}`, urls: job.urls, project: job.project, meta: job.meta, outputPath: dataPath });
      return { ok: true };
    } finally {
      this.#starting = false;
    }
  }

  /** Ask the Worker to stop; it answers `cancelled`. False when nothing runs. */
  cancel(): boolean {
    const run = this.#run;
    if (run === null || run.over) return false;
    if (!run.running.cancelling) {
      run.running = { ...run.running, cancelling: true };
      run.port.send({ type: "cancel" });
    }
    this.#options.notify({ type: "progress", running: { ...run.running } });
    return true;
  }

  /**
   * The finished card went (dismissed, or the next export begun): the copy in
   * the data folder goes too, once it was saved — unsaved, it is the only
   * copy, and stays.
   */
  async dismiss(): Promise<void> {
    const finished = this.#finished;
    if (finished === null) return;
    this.#finished = null;
    await this.#api.storage.local.remove(FINISHED_KEY).catch(() => undefined);
    if (finished.saved !== null) await this.#api.files.data.remove(finished.dataPath).catch(() => undefined);
  }

  /** The notice's *Show in Finder*. */
  async reveal(): Promise<void> {
    if (this.#lastSaved !== null) await this.#api.files.reveal(this.#lastSaved).catch(() => undefined);
  }

  // ── The Worker ──────────────────────────────────────────────────────────

  #heard(run: Run, event: ExportEvent): void {
    if (run.over) return;
    switch (event.type) {
      case "progress": {
        const fraction = Math.max(0, Math.min(1, event.fraction));
        const elapsed = this.#now() - run.startedAt;
        const etaSeconds = event.etaSeconds ?? (fraction > 0.02 ? (elapsed / fraction) * (1 - fraction) : null);
        run.running = { ...run.running, fraction, etaSeconds };
        this.#options.notify({ type: "progress", running: { ...run.running } });
        break;
      }
      case "chunk":
        run.chain = run.chain
          .then(async () => {
            if (run.over) return;
            await run.writable.write(event.bytes);
            run.port.send({ type: "written", seq: event.seq });
          })
          .catch((error: unknown) => void this.#fail(run, `Writing the file failed: ${messageOf(error)}`));
        break;
      case "done":
        run.chain = run.chain.then(() => this.#finish(run, event));
        break;
      case "error":
        void this.#fail(run, event.message);
        break;
      case "cancelled":
        void this.#cancelled(run);
        break;
    }
  }

  async #finish(run: Run, done: { bytes: number; durationSeconds: number }): Promise<void> {
    if (run.over) return;
    run.over = true;
    run.port.terminate();
    const { job } = run;
    try {
      await run.writable.close();
    } catch (error) {
      await this.#ended(run, { type: "error", recordingId: job.recordingId, message: `Writing the file failed: ${messageOf(error)}` });
      return;
    }
    let saved: string | null = null;
    let why: string | null = null;
    try {
      saved = await this.#api.files.save({ dataPath: run.dataPath }, { suggestedName: job.name, folder: "screenshots" });
    } catch (error) {
      why = messageOf(error);
    }
    const finished: FinishedExport = { recordingId: job.recordingId, name: job.name, dataPath: run.dataPath, saved, bytes: done.bytes, durationSeconds: done.durationSeconds, gif: job.project.export.format === "gif" };
    this.#finished = finished;
    if (saved !== null) this.#lastSaved = saved;
    await this.#api.storage.local.set({ [FINISHED_KEY]: finished as unknown as Json }).catch(() => undefined);
    this.#release(run);
    this.#options.notify({ type: "done", finished: { ...finished } });
    if (saved === null) {
      await this.#toast({ title: "The export was not saved", body: why ?? `${job.name} stays in the Recorder: Copy it from the editor.` });
      return;
    }
    try {
      if (job.destination === "folder") await this.#api.files.reveal(saved);
      else if (job.destination === "copy") {
        await this.#api.clipboard.write({ filePath: saved });
        await this.#toast({ title: "Copied", body: job.name });
      } else {
        await this.#api.notes.create({ title: job.title, markdown: noteMarkdown(job.name, saved) });
        await this.#toast({ title: "Added to a note", body: job.title });
      }
    } catch (error) {
      const what = job.destination === "copy" ? "Not copied" : job.destination === "note" ? "Not added to a note" : "Not shown in the Finder";
      await this.#toast({ title: what, body: messageOf(error) });
    }
    await this.#toast({ title: "Exported", body: job.name, action: { id: REVEAL_ACTION, title: "Show in Finder" } });
  }

  async #fail(run: Run, message: string): Promise<void> {
    if (run.over) return;
    run.over = true;
    run.port.terminate();
    await this.#ended(run, { type: "error", recordingId: run.job.recordingId, message });
  }

  async #cancelled(run: Run): Promise<void> {
    if (run.over) return;
    run.over = true;
    run.port.terminate();
    // (A write under way finishes before the file is thrown away.)
    await run.chain.catch(() => undefined);
    await this.#ended(run, { type: "cancelled", recordingId: run.job.recordingId });
  }

  /** A failed or cancelled export: the partial file removed, then the run let go and the editors told. */
  async #ended(run: Run, news: ExportNews & { type: "error" | "cancelled" }): Promise<void> {
    await run.writable.abort().catch(() => undefined);
    await this.#api.files.data.remove(run.dataPath).catch(() => undefined);
    this.#release(run);
    this.#options.notify(news);
    if (news.type === "error") {
      this.#api.runtime.log("warn", `recorder: the export stopped: ${news.message}`);
      await this.#toast({ title: "The export stopped", body: news.message });
    }
  }

  #release(run: Run): void {
    if (this.#run === run) this.#run = null;
    void run.hold.then((release) => {
      try {
        release?.();
      } catch {
        // (A release that throws has nothing left to release.)
      }
    });
  }

  async #toast(toast: { title: string; body?: string; action?: { id: string; title: string } }): Promise<void> {
    await this.#api.ui.toast(toast).catch(() => undefined);
  }
}
