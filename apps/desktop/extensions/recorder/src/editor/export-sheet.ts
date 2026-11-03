/**
 * The export sheet and the finished card (docs/recorder.md §2 "Export", §5). The
 * sheet picks format, size, fps, quality and where it goes; Export asks the
 * engine — the extension's worker, which outlives this window — to run it
 * (src/engine/exports.ts): the engine runs the export Worker, writes the file,
 * saves it to the screenshots folder (`files.save`) and reveals, copies or
 * notes it, and says *Exported*. This sheet only follows: the engine's news on
 * a `runtime.connect("export")` port (progress, done, error, cancelled), and
 * its `exportState` when the editor opens, so a reopened editor shows a
 * running export or the finished card. The card plays the result on a loop.
 * Under `?fake=1` the same job keeper runs in this page instead (`localExports`).
 */
import { EXPORT_PORT, Exports, noteMarkdown, type ExportDestination, type ExportNews, type ExportState, type FinishedExport } from "../engine/exports.js";
import type { ExportPort } from "../export/port.js";
import type { ExportSpec, Project } from "../lib/types.js";
import { exportName, exportSizeAllowed, formatClock, recordingTitle } from "./derive.js";
import { ICONS, h, icon } from "./dom.js";
import type { Editor } from "./editor.js";

type Json = Pistachio.Json;
type Destination = ExportDestination;

/** Where exports run, as the sheet sees it. */
export interface ExportClient {
  /** An `exportStart` request: answered once the export runs, or with why not. */
  start(request: Json): Promise<{ ok: true } | { ok: false; error: string }>;
  cancel(): void;
  /** The finished card went: its copy in the extension's data may go. */
  dismiss(): void;
  state(): Promise<ExportState | null>;
  listen(fn: (news: ExportNews) => void): void;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The engine's exports: requests by `runtime.sendMessage`, news on the "export" port. */
export function engineExports(): ExportClient {
  const ask = async (message: Json): Promise<Record<string, Json>> => {
    const answer = await pistachio.runtime.sendMessage(message);
    return answer !== null && answer !== undefined && typeof answer === "object" && !Array.isArray(answer) ? answer : { ok: false, error: "The Recorder did not answer." };
  };
  return {
    start: async (request) => {
      try {
        const answer = await ask(request);
        return answer["ok"] === true ? { ok: true } : { ok: false, error: typeof answer["error"] === "string" ? answer["error"] : "The export did not start." };
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    },
    cancel: () => void ask({ type: "exportCancel" }).catch(() => undefined),
    dismiss: () => void ask({ type: "exportDismiss" }).catch(() => undefined),
    state: async () => {
      const answer = await ask({ type: "exportState" }).catch((): Record<string, Json> => ({ ok: false }));
      return answer["ok"] === true ? ({ running: answer["running"] ?? null, finished: answer["finished"] ?? null } as unknown as ExportState) : null;
    },
    listen: (fn) => {
      pistachio.runtime.connect(EXPORT_PORT).onMessage((message) => fn(message as unknown as ExportNews));
    },
  };
}

/** The `?fake=1` kit's exports: the engine's own job keeper, run in this page over the shim and the stand-in Worker. */
export function localExports(createWorker: () => ExportPort): ExportClient {
  const listeners: ((news: ExportNews) => void)[] = [];
  const exports = new Exports(pistachio, { createWorker, notify: (news) => listeners.forEach((fn) => fn(news)) });
  return {
    start: (request) => exports.start(request),
    cancel: () => void exports.cancel(),
    dismiss: () => void exports.dismiss(),
    state: async () => exports.state(),
    listen: (fn) => void listeners.push(fn),
  };
}

const FORMATS: { value: ExportSpec["format"]; label: string; title: string }[] = [
  { value: "mp4-h264", label: "MP4", title: "MP4 · H.264: plays everywhere" },
  { value: "mp4-hevc", label: "MP4 · HEVC", title: "MP4 · HEVC: about half the size; some web players can't play it" },
  { value: "webm", label: "WebM", title: "WebM · VP9" },
  { value: "gif", label: "GIF", title: "GIF: 960 px wide, 15 fps, best under 20 s" },
];
const SIZES: { value: ExportSpec["height"]; label: string }[] = [
  { value: 720, label: "720p" },
  { value: 1080, label: "1080p" },
  { value: 1440, label: "1440p" },
  { value: 2160, label: "4K" },
];
const QUALITIES: { value: ExportSpec["quality"]; label: string }[] = [
  { value: "standard", label: "Standard" },
  { value: "high", label: "High" },
  { value: "studio", label: "Studio" },
];
const DESTINATIONS: { value: Destination; label: string }[] = [
  { value: "folder", label: "Screenshots folder" },
  { value: "copy", label: "Copy" },
  { value: "note", label: "Add to a note" },
];
const GIF_LIMIT = 20;

function extensionOf(format: ExportSpec["format"]): string {
  return format === "gif" ? "gif" : format === "webm" ? "webm" : "mp4";
}

function aboutSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 1.5) return "about a second";
  if (seconds < 60) return `about ${String(Math.round(seconds))} s`;
  return `about ${String(Math.round(seconds / 60))} min`;
}

/** The measured pipeline: ~200 fps at 1080p, encoder-bound near 60 at 4K; a GIF frame takes ~5 ms. */
function estimateSeconds(spec: ExportSpec, duration: number): number {
  if (spec.format === "gif") return Math.min(duration, GIF_LIMIT) * 15 * 0.005;
  const perSecond = spec.format === "webm" ? 80 : 200 * Math.min(1, (1080 / spec.height) ** 1.6);
  return (duration * spec.fps) / Math.max(20, perSecond);
}

export class ExportSheet {
  readonly el: HTMLElement;
  readonly card: HTMLElement;
  private readonly editor: Editor;
  private readonly client: ExportClient;
  private readonly sheet: HTMLElement;
  private readonly onStatus: (text: string | null) => void;
  private destination: Destination = "folder";
  /** An export of this recording runs (here or started from another window). */
  private running = false;

  constructor(editor: Editor, client: ExportClient, onStatus: (text: string | null) => void) {
    this.editor = editor;
    this.client = client;
    this.onStatus = onStatus;
    this.sheet = h("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": "Export" });
    this.el = h("div", { class: "sheet-layer", hidden: true, onpointerdown: (event: PointerEvent) => event.target === this.el && !this.running && this.close() }, this.sheet);
    this.card = h("div", { class: "finished-card", hidden: true });
    this.el.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        this.close();
      }
    });
    void pistachio.storage.local
      .get("exportDestination")
      .then((stored) => {
        const value = stored["exportDestination"];
        if (value === "folder" || value === "copy" || value === "note") this.destination = value;
      })
      .catch(() => undefined);
    // The engine's news, and what it holds already: an export running, or the last one finished (this window may be new).
    client.listen((news) => this.heard(news));
    void client.state().then((state) => {
      if (state !== null) this.caughtUp(state);
    });
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  open(): void {
    if (!this.running) this.showOptions();
    this.el.hidden = false;
    this.sheet.querySelector<HTMLElement>("button.primary, button")?.focus();
  }

  close(): void {
    this.el.hidden = true;
  }

  // ── Options ─────────────────────────────────────────────────────────────

  private showOptions(): void {
    const editor = this.editor;
    const spec = editor.project.export;
    const capture = editor.rec.meta.capture;
    const duration = editor.map.duration;
    const gif = spec.format === "gif";
    const set = (mutate: (draft: Project) => void) => {
      editor.edit(mutate);
      this.showOptions();
    };
    const segmented = <T extends string | number>(choices: { value: T; label: string; title?: string; disabled?: boolean }[], current: T, pick: (value: T) => void) =>
      h(
        "div",
        { class: "segmented", role: "radiogroup" },
        ...choices.map((choice) =>
          h("button", { type: "button", class: `segment${choice.value === current ? " on" : ""}`, "aria-checked": String(choice.value === current), title: choice.title ?? choice.label, disabled: choice.disabled === true, onclick: () => pick(choice.value) }, choice.label),
        ),
      );
    const row = (label: string, control: Node) => h("div", { class: "sheet-row" }, h("span", { class: "row-label" }, label), control);

    const notes: string[] = [];
    if (gif && duration > GIF_LIMIT) notes.push(`GIFs are best under ${String(GIF_LIMIT)} s; this one runs ${formatClock(duration, false)}. MP4 is smaller and sharper.`);
    if (spec.format === "mp4-hevc") notes.push("HEVC is about half the size; some web players can't play it.");
    if (editor.rec.urls.screen === null && editor.dev === null) notes.push("This recording has no screen.mp4 to export.");

    this.sheet.replaceChildren(
      h("header", { class: "sheet-head" }, h("h2", {}, "Export"), h("span", { class: "sheet-sub" }, `${formatClock(duration, false)} · ${aboutSeconds(estimateSeconds(spec, duration))} to export`)),
      row("Format", segmented(FORMATS, spec.format, (v) => set((p) => void (p.export.format = v)))),
      row(
        "Size",
        gif
          ? h("span", { class: "fixed" }, "960 px wide")
          : segmented(
              SIZES.map((s) => ({ ...s, disabled: !exportSizeAllowed(s.value, capture), title: exportSizeAllowed(s.value, capture) ? s.label : `${s.label}: larger than the recording` })),
              spec.height,
              (v) => set((p) => void (p.export.height = v)),
            ),
      ),
      row(
        "Frame rate",
        gif
          ? h("span", { class: "fixed" }, "15 fps")
          : segmented(
              [
                { value: 30 as const, label: "30 fps" },
                { value: 60 as const, label: "60 fps" },
              ],
              spec.fps,
              (v) => set((p) => void (p.export.fps = v)),
            ),
      ),
      row("Quality", segmented(QUALITIES, spec.quality, (v) => set((p) => void (p.export.quality = v)))),
      row(
        "Then",
        segmented(DESTINATIONS, this.destination, (v) => {
          this.destination = v;
          void pistachio.storage.local.set({ exportDestination: v }).catch(() => undefined);
          this.showOptions();
        }),
      ),
      ...(notes.length === 0 ? [] : [h("div", { class: "sheet-notes" }, ...notes.map((note) => h("p", { class: "note warn" }, note)))]),
      h(
        "footer",
        { class: "sheet-foot" },
        h("button", { type: "button", class: "button", onclick: () => this.close() }, "Cancel"),
        h("button", { type: "button", class: "button primary", disabled: editor.rec.urls.screen === null && editor.dev === null, onclick: () => void this.start() }, "Export"),
      ),
    );
  }

  // ── Running ─────────────────────────────────────────────────────────────

  private showProgress(fraction: number, eta: number | null, label = "Exporting"): void {
    const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
    const bar = h("div", { class: "progress" }, h("div", { class: "progress-fill", style: `width:${String(pct)}%` }));
    this.sheet.replaceChildren(
      h("header", { class: "sheet-head" }, h("h2", {}, label), h("span", { class: "sheet-sub" }, `${String(pct)}%${eta === null ? "" : ` · ${aboutSeconds(eta)} left`}`)),
      bar,
      h("p", { class: "note" }, "It keeps going if you close the window."),
      h(
        "footer",
        { class: "sheet-foot" },
        h("button", { type: "button", class: "button", onclick: () => this.close() }, "Hide"),
        h("button", { type: "button", class: "button danger", onclick: () => this.cancel() }, "Cancel export"),
      ),
    );
    this.onStatus(`${String(pct)}%`);
  }

  private showError(message: string): void {
    this.sheet.replaceChildren(
      h("header", { class: "sheet-head" }, h("h2", {}, "The export stopped")),
      h("p", { class: "note warn" }, message),
      h(
        "footer",
        { class: "sheet-foot" },
        h("button", { type: "button", class: "button", onclick: () => this.close() }, "Close"),
        h("button", { type: "button", class: "button primary", onclick: () => this.showOptions() }, "Try again"),
      ),
    );
    this.el.hidden = false;
    this.onStatus(null);
  }

  private cancel(): void {
    this.client.cancel();
    this.showProgress(0, null, "Cancelling");
  }

  private async start(): Promise<void> {
    if (this.running) return;
    const editor = this.editor;
    const { rec } = editor;
    const spec = editor.project.export;
    this.running = true;
    // (The last export's card goes: the engine drops its copy as this one begins, so the preview lets go of it first.)
    this.releaseCard();
    this.card.hidden = true;
    this.showProgress(0, null);
    // (The export carries the project itself, so the request goes first: the window may close at once. project.json follows.)
    const answering = this.client.start({
      type: "exportStart",
      recordingId: rec.id,
      urls: { screen: rec.urls.screen ?? "", mic: rec.urls.mic, camera: rec.urls.camera, events: rec.urls.events },
      // (As project.json is written: a cut's rate is Infinity, which JSON has not.)
      project: editor.solvers.writeProject(editor.project),
      meta: rec.meta as unknown as Json,
      name: exportName(rec.meta.startedAt, extensionOf(spec.format)),
      destination: this.destination,
      title: recordingTitle(rec.chapters, rec.meta),
    });
    void editor.autosave.flush().catch(() => undefined);
    const answer = await answering;
    // (Its news may have come first: an export that ended at once has said so.)
    if (!answer.ok && this.running) {
      this.running = false;
      this.showError(answer.error);
    }
  }

  // ── The engine's news ───────────────────────────────────────────────────

  private heard(news: ExportNews): void {
    const recordingId = news.type === "progress" ? news.running.recordingId : news.type === "done" ? news.finished.recordingId : news.recordingId;
    if (recordingId !== this.editor.rec.id) return;
    switch (news.type) {
      case "progress":
        this.running = true;
        this.showProgress(news.running.fraction, news.running.etaSeconds, news.running.cancelling ? "Cancelling" : "Exporting");
        break;
      case "done":
        this.running = false;
        this.onStatus(null);
        this.close();
        this.showCard(news.finished);
        break;
      case "error":
        this.running = false;
        this.showError(news.message);
        break;
      case "cancelled":
        this.running = false;
        this.onStatus(null);
        this.close();
        break;
    }
  }

  /** What the engine held when this window opened: this recording's export running, or its last one finished. */
  private caughtUp(state: ExportState): void {
    const id = this.editor.rec.id;
    if (state.running !== null && state.running.recordingId === id) {
      this.running = true;
      this.showProgress(state.running.fraction, state.running.etaSeconds, state.running.cancelling ? "Cancelling" : "Exporting");
    } else if (state.finished !== null && state.finished.recordingId === id && !this.running && this.card.hidden) {
      this.showCard(state.finished);
    }
  }

  // ── Done ────────────────────────────────────────────────────────────────

  private async copy(done: FinishedExport): Promise<void> {
    await pistachio.clipboard.write({ filePath: done.saved ?? done.dataPath });
    await pistachio.ui.toast({ title: "Copied", body: done.name }).catch(() => undefined);
  }

  private async addToNote(done: FinishedExport): Promise<void> {
    const title = recordingTitle(this.editor.rec.chapters, this.editor.rec.meta);
    await pistachio.notes.create({ title, markdown: noteMarkdown(done.name, done.saved) });
    await pistachio.ui.toast({ title: "Added to a note", body: title }).catch(() => undefined);
  }

  private showCard(done: FinishedExport): void {
    const url = pistachio.files.data.url(done.dataPath);
    const media: HTMLImageElement | HTMLVideoElement = done.gif ? h("img", { src: url, alt: done.name }) : h("video", { src: url, muted: true, loop: true, autoplay: true, playsInline: true });
    if (media instanceof HTMLVideoElement) media.muted = true;
    const thumb = h("div", { class: "finished-thumb", draggable: true, title: "Drag it out" }, media);
    thumb.addEventListener("dragstart", (event) => {
      event.preventDefault();
      void pistachio.files.startDrag(done.dataPath);
    });
    const sizeText = done.bytes > 0 ? `${(done.bytes / 1e6).toFixed(done.bytes > 1e8 ? 0 : 1)} MB · ` : "";
    this.card.replaceChildren(
      thumb,
      h(
        "div",
        { class: "finished-meta" },
        h("div", { class: "finished-name", title: done.name }, done.saved === null ? "Not saved" : done.name),
        h("div", { class: "finished-sub" }, `${sizeText}${formatClock(done.durationSeconds, false)}`),
      ),
      h(
        "div",
        { class: "finished-actions" },
        h("button", { type: "button", class: "button subtle", title: "Copy the file", onclick: () => void this.copy(done) }, icon(ICONS.copy, 14), "Copy"),
        h("button", { type: "button", class: "button subtle", title: "Show in Finder", disabled: done.saved === null, onclick: () => done.saved !== null && void pistachio.files.reveal(done.saved) }, icon(ICONS.folder, 14), "Reveal"),
        h("button", { type: "button", class: "button subtle", title: "Add a link to a new note", onclick: () => void this.addToNote(done) }, icon(ICONS.note, 14), "Add to a note"),
      ),
      h(
        "button",
        {
          type: "button",
          class: "icon-button finished-close",
          title: "Close",
          onclick: () => {
            this.card.hidden = true;
            this.releaseCard();
            this.client.dismiss();
          },
        },
        icon(ICONS.close, 14),
      ),
    );
    this.card.hidden = false;
  }

  /**
   * The card's preview lets go of the finished export's copy in the
   * extension's data (`exports/…`), which the engine removes once the card
   * goes — dismissed, or the next export begun — and only once the file was
   * saved to the screenshots folder: unsaved, it is the only copy, and stays.
   * (Closing the window keeps it, for the card when the editor opens again.)
   */
  private releaseCard(): void {
    const video = this.card.querySelector("video");
    if (video !== null) {
      video.removeAttribute("src");
      video.load();
    }
  }
}
