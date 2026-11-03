/**
 * The preview (docs/recorder.md §5): a canvas at the panel's pixel size that the
 * renderer draws `render(tOut)` into — the same function the export calls — over
 * the screen `<video>`'s current frame; the transport; and, while a zoom is
 * selected, its rectangle to drag (re-aim) and resize (the level).
 */
import type { Renderer } from "../lib/render.js";
import type { Size } from "../lib/types.js";
import { fitBox, formatClock, levelText } from "./derive.js";
import { ICONS, h, icon } from "./dom.js";
import type { Editor } from "./editor.js";
import { aimZoom, resizeZoom, viewportOf } from "./model.js";
import { Player } from "./player.js";
import { streamOffset } from "../lib/events.js";

export interface PreviewActions {
  togglePlay(): void;
  previousChapter(): void;
  nextChapter(): void;
}

export class Preview {
  readonly el: HTMLElement;
  readonly player: Player;
  private readonly editor: Editor;
  private readonly area: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly rect: HTMLElement;
  private readonly rectLabel: HTMLElement;
  private readonly note: HTMLElement;
  private readonly clock: HTMLElement;
  private readonly playButton: HTMLButtonElement;
  private readonly screen: HTMLVideoElement | null;
  private readonly camera: HTMLVideoElement | null;
  private readonly mic: HTMLAudioElement | null;
  private renderer: Renderer | null = null;
  private output: Size = { w: 0, h: 0 };
  private scheduled = 0;
  private failure: string | null = null;

  constructor(editor: Editor, actions: PreviewActions) {
    this.editor = editor;
    const { urls } = editor.rec;
    const media = (kind: "video" | "audio", src: string | null, cls: string) => {
      if (src === null) return null;
      const el = document.createElement(kind);
      el.className = `media ${cls}`;
      el.muted = kind === "video" && cls === "camera";
      el.preload = "auto";
      if (el instanceof HTMLVideoElement) el.playsInline = true;
      el.src = src;
      return el;
    };
    this.screen = editor.dev === null ? (media("video", urls.screen, "screen") as HTMLVideoElement | null) : null;
    this.camera = editor.dev === null ? (media("video", urls.camera, "camera") as HTMLVideoElement | null) : null;
    this.mic = editor.dev === null ? (media("audio", urls.mic, "mic") as HTMLAudioElement | null) : null;

    this.canvas = h("canvas", { class: "preview-canvas", "aria-label": "Preview" });
    this.ctx = this.canvas.getContext("2d", { alpha: false });
    this.rectLabel = h("span", { class: "zoom-rect-level" });
    this.rect = h(
      "div",
      { class: "zoom-rect", hidden: true },
      this.rectLabel,
      ...(["nw", "ne", "sw", "se"] as const).map((corner) => h("span", { class: "zoom-rect-handle", "data-corner": corner })),
    );
    this.note = h("div", { class: "preview-note", hidden: true });
    this.area = h("div", { class: "preview" }, this.canvas, this.rect, this.note, this.screen, this.camera, this.mic);

    this.playButton = h("button", { class: "icon-button play", title: "Play (Space)", onclick: () => actions.togglePlay() }, icon(ICONS.play));
    this.clock = h("span", { class: "clock" });
    this.el = h(
      "section",
      { class: "stage" },
      this.area,
      h(
        "div",
        { class: "transport" },
        h("div", { class: "transport-side" }),
        h(
          "div",
          { class: "transport-main" },
          h("button", { class: "icon-button", title: "Previous chapter", onclick: () => actions.previousChapter() }, icon(ICONS.rewind)),
          this.playButton,
          h("button", { class: "icon-button", title: "Next chapter", onclick: () => actions.nextChapter() }, icon(ICONS.forward)),
          this.clock,
        ),
        h("div", { class: "transport-side hints" }, h("span", {}, h("kbd", {}, "S"), " split"), h("span", {}, h("kbd", {}, "Z"), " zoom"), h("span", {}, h("kbd", {}, "X"), " speed")),
      ),
    );

    const offsets = { mic: streamOffset(editor.rec.meta, "mic"), camera: streamOffset(editor.rec.meta, "camera") };
    this.player = new Player(
      { screen: this.screen, camera: this.camera, mic: this.mic },
      {
        map: () => editor.map,
        audio: () => editor.project.audio,
        offsets: () => offsets,
        frame: (tOut) => editor.tick(tOut),
        stopped: () => editor.setPlaying(false),
      },
    );

    if (this.screen !== null) {
      const screen = this.screen;
      screen.addEventListener("loadedmetadata", () => {
        if (Number.isFinite(screen.duration)) editor.setDuration(screen.duration);
        this.player.seek(editor.playhead);
        this.invalidate();
      });
      screen.addEventListener("seeked", () => {
        if (!editor.playing) this.invalidate();
      });
      screen.addEventListener("loadeddata", () => this.invalidate());
      screen.addEventListener("error", () => this.setFailure("The screen recording can't be played."));
    } else if (editor.dev === null) {
      this.setFailure("This recording has no screen.mp4.");
    }
    this.camera?.addEventListener("seeked", () => {
      if (!editor.playing) this.invalidate();
    });

    this.wireRect();
    new ResizeObserver(() => this.layout()).observe(this.area);
    window.matchMedia("(resolution: 2dppx)").addEventListener("change", () => this.layout());

    editor.on((change) => {
      switch (change) {
        case "project":
        case "derived":
          this.renderer = null;
          this.layout();
          // The map may have moved the playhead's source time (a speed segment or a cut before it): paused, the media
          // is sought to where the playhead now lands, and drawn once it is there.
          if (!editor.playing) {
            this.player.seek(editor.playhead);
            this.requestFrameAfterSeek();
          }
          break;
        case "selection":
          this.renderer = null;
          this.invalidate();
          break;
        case "mode":
          this.renderer = null;
          this.playButton.replaceChildren(icon(editor.playing ? ICONS.pause : ICONS.play));
          this.playButton.title = editor.playing ? "Pause (Space)" : "Play (Space)";
          this.invalidate();
          break;
        case "seek":
          this.player.seek(editor.playhead);
          this.invalidate();
          this.requestFrameAfterSeek();
          break;
        case "playhead":
          // Already inside the player's animation frame: draw now.
          this.draw();
          break;
        default:
          break;
      }
    });
  }

  /** Size the canvas to the output's aspect inside the area, at the display's pixel ratio. */
  layout(): void {
    const area = { w: this.area.clientWidth, h: this.area.clientHeight };
    if (area.w === 0 || area.h === 0) return;
    const { project, rec } = this.editor;
    // The export's own shape (the lib's outputSize: Fit is the window plus its frame and padding).
    const shape = this.editor.solvers.outputSize(project.look, rec.meta.view, 1080);
    const box = fitBox(area, shape.w / shape.h, 20);
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(2, Math.round(box.w * dpr));
    const hgt = Math.max(2, Math.round(box.h * dpr));
    this.canvas.style.left = `${String(box.x)}px`;
    this.canvas.style.top = `${String(box.y)}px`;
    this.canvas.style.width = `${String(box.w)}px`;
    this.canvas.style.height = `${String(box.h)}px`;
    if (this.canvas.width !== w || this.canvas.height !== hgt) {
      this.canvas.width = w;
      this.canvas.height = hgt;
      this.renderer = null;
    }
    this.output = { w, h: hgt };
    this.invalidate();
  }

  invalidate(): void {
    if (this.scheduled !== 0) return;
    this.scheduled = requestAnimationFrame(() => {
      this.scheduled = 0;
      this.draw();
    });
  }

  /** The frame after a seek lands, while paused. */
  private requestFrameAfterSeek(): void {
    const screen = this.screen;
    if (screen === null || this.editor.playing || !("requestVideoFrameCallback" in screen)) return;
    screen.requestVideoFrameCallback(() => this.invalidate());
  }

  private ensureRenderer(): Renderer | null {
    if (this.renderer !== null) return this.renderer;
    try {
      this.renderer = this.editor.solvers.createRenderer(this.editor.renderState(this.output), this.editor.map);
    } catch (error) {
      this.setFailure(`The renderer failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return this.renderer;
  }

  private screenSource(tSrc: number): CanvasImageSource | null {
    const dev = this.editor.dev;
    if (dev !== null) return dev.screenFrame(tSrc);
    const screen = this.screen;
    return screen !== null && screen.readyState >= 2 ? screen : null;
  }

  draw(): void {
    const ctx = this.ctx;
    if (ctx === null || this.output.w === 0) return;
    const editor = this.editor;
    const tOut = editor.playhead;
    const tSrc = editor.map.toSource(tOut);
    const screen = this.screenSource(tSrc);
    if (editor.raw) {
      drawRaw(ctx, this.output, screen);
    } else {
      const renderer = this.ensureRenderer();
      if (renderer !== null) {
        try {
          const camera = this.camera !== null && this.camera.readyState >= 2 ? this.camera : null;
          renderer.render(ctx, tOut, { screen, camera });
        } catch (error) {
          this.setFailure(`The renderer failed: ${error instanceof Error ? error.message : String(error)}`);
          drawRaw(ctx, this.output, screen);
        }
      } else {
        drawRaw(ctx, this.output, screen);
      }
    }
    this.placeRect();
    this.clock.textContent = `${formatClock(tOut)} / ${formatClock(editor.map.duration)}`;
  }

  private setFailure(message: string): void {
    if (this.failure === message) return;
    this.failure = message;
    this.note.textContent = message;
    this.note.hidden = false;
  }

  // ── The zoom rectangle ──────────────────────────────────────────────────

  private placeRect(): void {
    const id = this.editor.editingZoomId;
    const segment = id === null ? undefined : this.editor.project.zooms.find((z) => z.id === id);
    const renderer = this.renderer;
    if (segment === undefined || renderer === null || this.editor.raw) {
      this.rect.hidden = true;
      return;
    }
    const box = renderer.contentBox();
    const view = viewportOf(segment);
    const scale = this.canvas.clientWidth / Math.max(1, this.canvas.width);
    const left = this.canvas.offsetLeft + (box.x + view.x * box.w) * scale;
    const top = this.canvas.offsetTop + (box.y + view.y * box.h) * scale;
    this.rect.style.left = `${String(left)}px`;
    this.rect.style.top = `${String(top)}px`;
    this.rect.style.width = `${String(view.w * box.w * scale)}px`;
    this.rect.style.height = `${String(view.h * box.h * scale)}px`;
    this.rect.classList.toggle("auto", segment.auto);
    this.rectLabel.textContent = levelText(segment.level);
    this.rect.hidden = false;
  }

  /** A pointer position in the content's normalized coordinates (0..1 across the recorded page). */
  private toContent(event: PointerEvent): { x: number; y: number } | null {
    const renderer = this.renderer;
    if (renderer === null) return null;
    const box = renderer.contentBox();
    const bounds = this.canvas.getBoundingClientRect();
    const px = ((event.clientX - bounds.left) * this.canvas.width) / Math.max(1, bounds.width);
    const py = ((event.clientY - bounds.top) * this.canvas.height) / Math.max(1, bounds.height);
    return { x: (px - box.x) / Math.max(1, box.w), y: (py - box.y) / Math.max(1, box.h) };
  }

  private wireRect(): void {
    this.rect.addEventListener("pointerdown", (event) => {
      const id = this.editor.editingZoomId;
      const segment = id === null ? undefined : this.editor.project.zooms.find((z) => z.id === id);
      const start = this.toContent(event);
      if (id === null || segment === undefined || start === null) return;
      event.preventDefault();
      event.stopPropagation();
      this.rect.setPointerCapture(event.pointerId);
      const corner = (event.target as HTMLElement).dataset["corner"];
      const view = viewportOf(segment);
      const anchor =
        corner === undefined
          ? null
          : { x: corner.includes("w") ? view.x + view.w : view.x, y: corner.startsWith("n") ? view.y + view.h : view.y };
      const centre: [number, number] = [view.x + view.w / 2, view.y + view.h / 2];
      this.rect.classList.add("dragging");
      const move = (ev: PointerEvent) => {
        const at = this.toContent(ev);
        if (at === null) return;
        this.editor.edit(
          (draft) => {
            const index = draft.zooms.findIndex((z) => z.id === id);
            const current = draft.zooms[index];
            if (current === undefined) return;
            draft.zooms[index] =
              anchor === null ? aimZoom(current, [centre[0] + at.x - start.x, centre[1] + at.y - start.y]) : resizeZoom(current, anchor, at, Math.max(1.25, draft.zoom.maxLevel));
          },
          { key: `rect:${id}` },
        );
      };
      const up = (ev: PointerEvent) => {
        this.rect.releasePointerCapture(ev.pointerId);
        this.rect.classList.remove("dragging");
        this.rect.removeEventListener("pointermove", move);
        this.rect.removeEventListener("pointerup", up);
        this.rect.removeEventListener("pointercancel", up);
        this.editor.seal();
      };
      this.rect.addEventListener("pointermove", move);
      this.rect.addEventListener("pointerup", up);
      this.rect.addEventListener("pointercancel", up);
    });
  }
}

/** The recording as it was, letterboxed: the Preview toggle's "raw". */
function drawRaw(ctx: CanvasRenderingContext2D, output: Size, source: CanvasImageSource | null): void {
  ctx.fillStyle = "#0b0b0c";
  ctx.fillRect(0, 0, output.w, output.h);
  if (source === null) return;
  const size = sourceSize(source);
  if (size.w === 0 || size.h === 0) return;
  const box = fitBox(output, size.w / size.h);
  ctx.drawImage(source, box.x, box.y, box.w, box.h);
}

function sourceSize(source: CanvasImageSource): Size {
  if (source instanceof HTMLVideoElement) return { w: source.videoWidth, h: source.videoHeight };
  if (typeof VideoFrame !== "undefined" && source instanceof VideoFrame) return { w: source.displayWidth, h: source.displayHeight };
  const sized = source as { width?: number | SVGAnimatedLength; height?: number | SVGAnimatedLength };
  return { w: typeof sized.width === "number" ? sized.width : 0, h: typeof sized.height === "number" ? sized.height : 0 };
}
