/**
 * The engine (docs/recorder.md §3): the handlers main calls — `/record` and
 * `/stop` in the Bar, ⌘⇧6, *Record this window* on a window's ⋯, the pill's
 * actions — and the panel's messages; at most one session at a time.
 *
 * The panel talks to it by `runtime.sendMessage` (requests, answered) and
 * keeps a `runtime.connect("panel")` port open, on which the engine pushes
 * `{ type: "state", state }` whenever the session changes (every second while
 * recording) and `{ type: "recent" }` when the list of recordings changed.
 *
 * Exports run here too (`./exports.ts`), not in the editor's window, so one
 * goes on when the editor closes: the editor asks `exportStart`,
 * `exportCancel`, `exportState` and `exportDismiss`, and a
 * `runtime.connect("export")` port brings their news back.
 */
import { workerPort, type ExportPort } from "../export/port.js";
import type { RecordingSummary } from "../lib/types.js";
import { CHOICES_KEY, choicesFrom, qualityOf, type Choices } from "./choices.js";
import { formatBytes, startVerdict } from "./disk.js";
import { EXPORT_PORT, Exports, REVEAL_ACTION, type ExportNews } from "./exports.js";
import { formatClock, isRecordingId, recordingFiles, recordingId, recordingIdTime, RECORDINGS_DIR, uniqueRecordingId } from "./ids.js";
import { RecordingSession, type RecordOptions, type SessionOutcome, type SessionSnapshot } from "./recorder.js";

type Api = typeof pistachio;
type Json = Pistachio.Json;

const SUMMARY_PREFIX = "recording:";
const RECENT_DEFAULT = 5;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The export Worker, a module beside the worker's page: main loads
 * `pistachio-ext://<id>/__pistachio__/worker.html`, so its address is from the
 * extension's root, where the build puts it (`src/export/export.worker.js`).
 */
function exportWorker(): ExportPort {
  return workerPort(new Worker(new URL("/src/export/export.worker.js", location.href), { type: "module" }));
}

/** A start request as the panel sends it (every field optional but the tab). */
interface StartRequest {
  tabId?: unknown;
  mic?: unknown;
  camera?: unknown;
  pageAudio?: unknown;
  scale?: unknown;
  fps?: unknown;
  countdown?: unknown;
}

export class Engine {
  readonly #api: Api;
  #session: RecordingSession | null = null;
  /** A start under way (between the request and the session existing). */
  #starting = false;
  readonly #ports = new Set<Pistachio.Port>();
  readonly #exports: Exports;
  /** The editors' "export" ports. */
  readonly #exportPorts = new Set<Pistachio.Port>();

  constructor(api: Api, createExportWorker: () => ExportPort = exportWorker) {
    this.#api = api;
    this.#exports = new Exports(api, { createWorker: createExportWorker, notify: (news) => this.#pushExport(news) });
  }

  register(): void {
    const api = this.#api;
    api.bar.onCommand("record", async (ctx) => {
      const arg = ctx.arg.trim().toLowerCase();
      if (arg === "desk" || arg === "area" || arg === "screen") {
        await this.#toast("Only a window, for now", `Recording the whole ${arg === "area" ? "area" : arg} arrives later; /record records the window in use.`);
        return;
      }
      await this.startOnWindowInUse(ctx.tabId);
    });
    api.bar.onCommand("stop", async () => {
      if (this.#session === null) await this.#toast("Nothing is recording");
      else void this.#session.stop();
    });
    api.contextMenus.onClicked("record-window", (info) => void this.startOn(info.windowTabId ?? info.tabId ?? null));
    api.commands.onCommand("toggle", (ctx) => {
      if (this.#session !== null) void this.#session.stop();
      else void this.startOnWindowInUse(ctx.tabId);
    });
    api.ui.onStatusAction((action) => this.#statusAction(action));
    // (A notice's button is heard here, in the worker, whichever context put the notice up.)
    api.ui.onToastAction((action) => {
      if (action === REVEAL_ACTION) void this.#exports.reveal();
    });
    api.runtime.onMessage((message) => this.message(message));
    api.runtime.onConnect((port) => {
      if (port.name === EXPORT_PORT) {
        this.#exportPorts.add(port);
        port.onDisconnect(() => this.#exportPorts.delete(port));
        return;
      }
      if (port.name !== "panel") return;
      this.#ports.add(port);
      port.onDisconnect(() => this.#ports.delete(port));
      port.postMessage({ type: "state", state: this.#state() as unknown as Json });
    });
    api.runtime.onInstalled((details) => api.runtime.log("info", `recorder: ${details.reason}`));
    void this.#exports.restore();
  }

  // ── Starting ───────────────────────────────────────────────────────────

  /** The desk window in use: the capture sources' `inUse`, else the Bar's tab, else the current space's active tab. */
  async windowInUse(hint: string | null): Promise<string | null> {
    const api = this.#api;
    try {
      const sources = await api.capture.sources();
      const inUse = sources.find((source) => source.inUse);
      if (inUse !== undefined) return inUse.tabId;
      if (hint !== null && sources.some((source) => source.tabId === hint)) return hint;
    } catch {
      // (Sources unavailable: fall back to the tabs.)
    }
    if (hint !== null) return hint;
    try {
      const space = await api.spaces.current();
      const tabs = await api.tabs.query(space === null ? { active: true } : { active: true, spaceId: space.id });
      return tabs.find((tab) => tab.kind === "page")?.id ?? null;
    } catch {
      return null;
    }
  }

  async startOnWindowInUse(hint: string | null): Promise<void> {
    const tabId = await this.windowInUse(hint);
    if (tabId === null) {
      await this.#toast("No window to record", "Open a page on the desk, then try again.");
      return;
    }
    await this.startOn(tabId);
  }

  /** Start on a tab with the last choices. */
  async startOn(tabId: string | null, overrides: Partial<RecordOptions> = {}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    const api = this.#api;
    if (tabId === null) {
      await this.#toast("No window to record");
      return { ok: false, error: "no window" };
    }
    if (this.#session !== null || this.#starting) {
      await this.#toast("A recording is already running", "Stop it first: ■ in its pill, or ⌘⇧6.");
      return { ok: false, error: "a recording is already running" };
    }
    this.#starting = true;
    try {
      const [stored, settings] = await Promise.all([api.storage.local.get(CHOICES_KEY).then((items) => items[CHOICES_KEY]), api.settings.getAll().catch((): Record<string, Json> => ({}))]);
      const choices = choicesFrom(stored, settings);
      const quality = qualityOf(choices.quality, settings["fps"]);
      let tab: Pistachio.Tab;
      try {
        tab = await api.tabs.get(tabId);
      } catch (error) {
        await this.#toast("That window cannot be recorded", messageOf(error));
        return { ok: false, error: messageOf(error) };
      }
      if (tab.kind !== "page") {
        await this.#toast("That window cannot be recorded", "Only a page's window can be recorded.");
        return { ok: false, error: "not a page" };
      }
      // Free space: refuse under 1 GB, warn under 5 GB.
      let free = Infinity;
      try {
        free = await api.files.data.freeSpace();
      } catch {
        // (Unknown: record, and let the watch stop it.)
      }
      const verdict = startVerdict(free);
      if (verdict === "refuse") {
        await this.#toast("Not enough disk space to record", `${formatBytes(free)} free; a recording needs at least 1 GB.`);
        return { ok: false, error: "not enough disk space" };
      }
      if (verdict === "warn") await this.#toast("The disk is nearly full", `${formatBytes(free)} free: the recording stops on its own under 1 GB.`);

      const taken = new Set((await api.files.data.list(RECORDINGS_DIR).catch(() => [])).map((file) => file.path.split("/")[1] ?? ""));
      const id = uniqueRecordingId(recordingId(new Date()), taken);
      const options: RecordOptions = {
        tabId,
        title: tab.title || tab.url,
        url: tab.url,
        mic: choices.mic,
        camera: choices.camera,
        pageAudio: choices.pageAudio,
        scale: quality.scale,
        fps: quality.fps,
        countdown: choices.countdown,
        ...overrides,
      };
      const session = new RecordingSession(api, id, options, {
        changed: () => this.#push(),
        ended: (ended, outcome) => void this.#ended(ended, outcome),
      });
      this.#session = session;
      this.#starting = false;
      try {
        await session.begin();
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      return { ok: true, id };
    } finally {
      this.#starting = false;
    }
  }

  async #ended(session: RecordingSession, outcome: SessionOutcome): Promise<void> {
    if (this.#session === session) this.#session = null;
    const api = this.#api;
    this.#push();
    if (outcome.state === "done") {
      const recording = session.recording;
      const summary = {
        id: session.id,
        title: session.options.title,
        startedAt: recording?.meta.startedAt ?? recordingIdTime(session.id) ?? Date.now(),
        durationMs: Math.round(outcome.durationMs),
      };
      await api.storage.local.set({ [SUMMARY_PREFIX + session.id]: summary }).catch(() => undefined);
      this.#pushRecent();
      try {
        await api.ui.openPage("editor", { query: `rec=${session.id}` });
      } catch (error) {
        api.runtime.log("warn", `recorder: the editor did not open: ${messageOf(error)}`);
      }
      await this.#toast(outcome.message ?? "Recording saved", `${session.options.title} · ${formatClock(outcome.durationMs)}`);
    } else if (outcome.state === "discarded") {
      this.#pushRecent();
      await this.#toast("Recording discarded");
    } else {
      this.#pushRecent();
      await this.#toast("The recording failed", outcome.message ?? undefined);
    }
  }

  // ── The pill ───────────────────────────────────────────────────────────

  #statusAction(action: string): void {
    const session = this.#session;
    if (session === null) return;
    if (action === "pause") session.pause();
    else if (action === "resume") session.resume();
    else if (action === "stop") void session.stop();
    else if (action === "discard") void session.discard();
  }

  // ── The panel ──────────────────────────────────────────────────────────

  #state(): SessionSnapshot | null {
    return this.#session?.snapshot() ?? null;
  }

  #push(): void {
    const message = { type: "state", state: this.#state() as unknown as Json };
    for (const port of this.#ports) {
      try {
        port.postMessage(message);
      } catch {
        this.#ports.delete(port);
      }
    }
  }

  #pushExport(news: ExportNews): void {
    for (const port of this.#exportPorts) {
      try {
        port.postMessage(news as unknown as Json);
      } catch {
        this.#exportPorts.delete(port);
      }
    }
  }

  #pushRecent(): void {
    for (const port of this.#ports) {
      try {
        port.postMessage({ type: "recent" });
      } catch {
        this.#ports.delete(port);
      }
    }
  }

  /** The panel's and the editor's requests. Answers JSON; never throws at the wire. */
  async message(raw: Json): Promise<Json> {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "not a request" };
    const message = raw as Record<string, Json>;
    const api = this.#api;
    try {
      switch (message["type"]) {
        case "start":
          return (await this.#startRequest(message as StartRequest)) as Json;
        case "stop":
          if (this.#session === null) return { ok: false, error: "nothing is recording" };
          void this.#session.stop();
          return { ok: true };
        case "pause":
          this.#session?.pause();
          return { ok: this.#session !== null };
        case "resume":
          this.#session?.resume();
          return { ok: this.#session !== null };
        case "discard":
          if (this.#session === null) return { ok: false, error: "nothing is recording" };
          void this.#session.discard();
          return { ok: true };
        case "state":
          return { ok: true, state: this.#state() as unknown as Json };
        case "recent":
          return { ok: true, recordings: (await this.recent(typeof message["limit"] === "number" ? message["limit"] : RECENT_DEFAULT)) as unknown as Json };
        case "sources":
          return { ok: true, sources: (await api.capture.sources()) as unknown as Json };
        case "open": {
          const id = message["id"];
          if (!isRecordingId(id)) return { ok: false, error: "no such recording" };
          await api.ui.openPage("editor", { query: `rec=${id}` });
          return { ok: true };
        }
        case "reveal": {
          const id = message["id"];
          if (!isRecordingId(id)) return { ok: false, error: "no such recording" };
          await api.files.reveal(recordingFiles(id, { mic: false, camera: false }).screen);
          return { ok: true };
        }
        case "exportStart":
          return (await this.#exports.start(message)) as Json;
        case "exportCancel":
          return { ok: this.#exports.cancel() };
        case "exportState":
          return { ok: true, ...(this.#exports.state() as unknown as Record<string, Json>) };
        case "exportDismiss":
          await this.#exports.dismiss();
          return { ok: true };
        case "delete": {
          const id = message["id"];
          if (!isRecordingId(id)) return { ok: false, error: "no such recording" };
          if (this.#session?.id === id) return { ok: false, error: "that recording is running" };
          // (Its export reads the files as it goes: not while one runs.)
          if (this.#exports.state().running?.recordingId === id) return { ok: false, error: "that recording is exporting: wait for the export, or cancel it" };
          await api.files.data.remove(`${RECORDINGS_DIR}/${id}`);
          await api.storage.local.remove(SUMMARY_PREFIX + id).catch(() => undefined);
          this.#pushRecent();
          return { ok: true };
        }
        default:
          return { ok: false, error: `unknown request ${JSON.stringify(message["type"] ?? null)}` };
      }
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  async #startRequest(request: StartRequest): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    const tabId = typeof request.tabId === "string" && request.tabId !== "" ? request.tabId : await this.windowInUse(null);
    const choices: Choices = {
      mic: typeof request.mic === "string" && request.mic !== "" ? request.mic : request.mic === true ? "default" : null,
      camera: request.camera === true,
      pageAudio: request.pageAudio !== false,
      quality: request.scale === 1 ? "native" : "crisp",
      countdown: typeof request.countdown === "number" && request.countdown >= 0 ? Math.min(10, Math.round(request.countdown)) : 3,
    };
    // (The panel's choices are the next /record's too.)
    await this.#api.storage.local.set({ [CHOICES_KEY]: choices as unknown as Json }).catch(() => undefined);
    const overrides: Partial<RecordOptions> = {
      mic: choices.mic,
      camera: choices.camera,
      pageAudio: choices.pageAudio,
      countdown: choices.countdown,
    };
    if (request.scale === 1 || request.scale === 2) overrides.scale = request.scale;
    if (request.fps === 30 || request.fps === 60) overrides.fps = request.fps;
    return this.startOn(tabId, overrides);
  }

  /** The newest recordings first: the summary kept at the end, else the meta line and the last event. */
  async recent(limit = RECENT_DEFAULT): Promise<RecordingSummary[]> {
    const api = this.#api;
    const folders = (await api.files.data.list(RECORDINGS_DIR).catch(() => []))
      .filter((file) => file.kind === "dir")
      .map((file) => file.path.split("/")[1] ?? "")
      .filter((id) => isRecordingId(id) && id !== this.#session?.id)
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
      .slice(0, Math.max(1, Math.min(50, limit)));
    const stored = folders.length === 0 ? {} : await api.storage.local.get(folders.map((id) => SUMMARY_PREFIX + id)).catch(() => ({}) as Record<string, Json>);
    return Promise.all(
      folders.map(async (id): Promise<RecordingSummary> => {
        const files = recordingFiles(id, { mic: false, camera: false });
        const listing = await api.files.data.list(files.dir).catch(() => []);
        const has = (path: string | null): boolean => path !== null && listing.some((file) => file.path === path);
        const thumbUrl = has(files.thumb) && files.thumb !== null ? api.files.data.url(files.thumb) : null;
        const kept = stored[SUMMARY_PREFIX + id] as Partial<RecordingSummary> | undefined;
        if (kept !== undefined && typeof kept.durationMs === "number") {
          return { id, title: String(kept.title ?? id), startedAt: Number(kept.startedAt ?? recordingIdTime(id) ?? 0), durationMs: kept.durationMs, thumbUrl };
        }
        const read = await readEventsEnds(api, files.events, listing.find((file) => file.path === files.events)?.size ?? 0);
        return {
          id,
          title: read.title ?? id,
          startedAt: read.startedAt ?? recordingIdTime(id) ?? 0,
          durationMs: Math.round(read.lastT ?? 0),
          thumbUrl,
        };
      }),
    );
  }

  async #toast(title: string, body?: string): Promise<void> {
    await this.#api.ui.toast(body === undefined ? { title } : { title, body }).catch(() => undefined);
  }
}

/** A recording without a summary (it crashed, or predates them): its meta line's title and start, its last line's `t`. */
async function readEventsEnds(api: Api, path: string, size: number): Promise<{ title: string | null; startedAt: number | null; lastT: number | null }> {
  const decoder = new TextDecoder();
  let title: string | null = null;
  let startedAt: number | null = null;
  let lastT: number | null = null;
  try {
    const head = decoder.decode(await api.files.data.read(path, { start: 0, end: Math.min(size, 16384) }));
    const meta = JSON.parse(head.split("\n")[0] ?? "") as { source?: { title?: unknown }; startedAt?: unknown };
    if (typeof meta.source?.title === "string") title = meta.source.title;
    if (typeof meta.startedAt === "number") startedAt = meta.startedAt;
    const tail = decoder.decode(await api.files.data.read(path, { start: Math.max(0, size - 4096), end: size }));
    for (const line of tail.split("\n").reverse()) {
      try {
        const event = JSON.parse(line) as { t?: unknown };
        if (typeof event.t === "number") {
          lastT = event.t;
          break;
        }
      } catch {
        // (A torn line: the one before it.)
      }
    }
  } catch {
    // (No events: an empty summary.)
  }
  return { title, startedAt, lastT };
}

export function startEngine(): void {
  new Engine(pistachio).register();
}
