/**
 * The editor window (docs/recorder.md §5, R6): the title bar, the preview with its
 * transport, the inspector at the trailing edge, the timeline under the preview,
 * the export sheet; and the keys.
 */
import type { Renderer } from "../lib/render.js";
import type { LookSpec } from "../lib/types.js";
import { recordingTitle } from "./derive.js";
import { ICONS, h, icon } from "./dom.js";
import { Editor } from "./editor.js";
import { engineExports, ExportSheet, localExports } from "./export-sheet.js";
import { Inspector } from "./inspector.js";
import { commandFor, keyBelongsToField, nextShuttleRate, type Command } from "./keys.js";
import type { LoadedRecording } from "./load.js";
import { NONE, addSpeedOver, addZoomAt, clamp, deleteSelection, speedSpanFor, splitAt } from "./model.js";
import { Preview } from "./preview.js";
import type { DevKit, Solvers } from "./solvers.js";
import { Timeline } from "./timeline.js";

const ASPECTS: { value: LookSpec["aspect"]; label: string }[] = [
  { value: "16:9", label: "16:9" },
  { value: "9:16", label: "9:16" },
  { value: "1:1", label: "1:1" },
  { value: "4:3", label: "4:3" },
  { value: "fit", label: "Fit" },
];

export function mountEditor(root: HTMLElement, rec: LoadedRecording, solvers: Solvers, dev: DevKit | null): Editor {
  const editor = new Editor(rec, solvers, dev);
  const title = recordingTitle(rec.chapters, rec.meta);
  document.title = `${title} — Recorder`;

  let shuttle = { direction: 0 as -1 | 0 | 1, rate: 1 };
  const play = (direction: 1 | -1 = 1, rate = 1) => {
    preview.player.play(editor.playhead, direction, rate);
    editor.setPlaying(true);
  };
  const pause = () => {
    shuttle = { direction: 0, rate: 1 };
    preview.player.pause();
    editor.setPlaying(false);
  };
  const togglePlay = () => (editor.playing ? pause() : play());

  const chapterTimes = () => {
    const times = new Set<number>([0]);
    for (const chapter of rec.chapters) times.add(editor.map.toOutput(chapter.tSrc));
    return [...times].sort((a, b) => a - b);
  };

  const preview = new Preview(editor, {
    togglePlay,
    previousChapter: () => {
      const before = chapterTimes().filter((t) => t < editor.playhead - 0.25);
      editor.seek(before.length === 0 ? 0 : before[before.length - 1]!);
    },
    nextChapter: () => {
      const after = chapterTimes().find((t) => t > editor.playhead + 0.01);
      editor.seek(after ?? editor.map.duration);
    },
  });
  const timeline = new Timeline(editor);

  const run = (command: Command) => {
    const tSrc = editor.playheadSource;
    const fps = rec.meta.fps > 0 ? rec.meta.fps : 60;
    switch (command.type) {
      case "togglePlay":
        togglePlay();
        break;
      case "stepFrames":
        pause();
        editor.seek(editor.playhead + command.frames / fps);
        break;
      case "stepSeconds":
        editor.seek(editor.playhead + command.seconds);
        break;
      case "shuttle": {
        if (command.direction === 0) {
          pause();
          break;
        }
        const rate = editor.playing ? nextShuttleRate(shuttle.rate, shuttle.direction === command.direction) : 1;
        shuttle = { direction: command.direction, rate };
        play(command.direction, rate);
        break;
      }
      case "split": {
        const cuts = splitAt(editor.project.cuts, tSrc);
        if (cuts !== null) editor.edit((p) => void (p.cuts = cuts));
        break;
      }
      case "delete": {
        const result = deleteSelection(editor.project, editor.selection);
        if (result !== null) editor.edit(() => result.project, { select: result.selection });
        break;
      }
      case "addZoom": {
        const point = solvers.pointerAt(rec.events, tSrc);
        const centre: [number, number] = point === null ? [0.5, 0.5] : [clamp(point.x / rec.meta.view.w, 0, 1), clamp(point.y / rec.meta.view.h, 0, 1)];
        const added = addZoomAt(editor.project, tSrc, centre, editor.duration);
        if (added !== null) {
          if (editor.playing) pause();
          if (!editor.edit(() => added.project, { select: { kind: "zoom", id: added.id } })) editor.select({ kind: "zoom", id: added.id });
        }
        break;
      }
      case "addSpeed": {
        const span = speedSpanFor(editor.selection, tSrc, editor.duration);
        const added = addSpeedOver(editor.project, span.start, span.end, 2, editor.duration);
        if (added !== null) editor.edit(() => added.project, { select: { kind: "speed", id: added.id } });
        break;
      }
      case "undo":
        editor.undo();
        break;
      case "redo":
        editor.redo();
        break;
      case "deselect":
        editor.select(NONE);
        break;
      case "home":
        editor.seek(0);
        break;
      case "end":
        editor.seek(editor.map.duration);
        break;
    }
  };

  const inspector = new Inspector(editor, {
    deleteSelection: () => run({ type: "delete" }),
    speedUpSelection: () => run({ type: "addSpeed" }),
  });

  // ── The title bar ───────────────────────────────────────────────────────

  const undoButton = h("button", { class: "icon-button", title: "Undo (⌘Z)", onclick: () => editor.undo() }, icon(ICONS.undo));
  const redoButton = h("button", { class: "icon-button", title: "Redo (⌘⇧Z)", onclick: () => editor.redo() }, icon(ICONS.redo));
  const aspect = h("select", { class: "select", title: "Aspect", "aria-label": "Aspect" }, ...ASPECTS.map((a) => h("option", { value: a.value }, a.label)));
  aspect.addEventListener("change", () => {
    editor.edit((p) => void (p.look.aspect = aspect.value as LookSpec["aspect"]));
    aspect.blur();
  });
  const lookToggle = h("button", { class: "toggle-button", "aria-pressed": "true", title: "Preview with the look, or the raw recording", onclick: () => editor.setRaw(!editor.raw) }, icon(ICONS.eye, 14), "Preview");
  const saveState = h("span", { class: "save-state" });
  const exportButton = h("button", { class: "button primary", onclick: () => sheet.open() }, "Export");
  // The engine runs exports (they outlive this window); the `?fake=1` kit runs the same job keeper here, with its stand-in Worker.
  const exports = dev !== null ? localExports(() => dev.createExportWorker(exportDrawer(editor), editor.map.duration)) : engineExports();
  const sheet = new ExportSheet(editor, exports, (status) => {
    exportButton.textContent = status === null ? "Export" : `Exporting ${status}`;
    exportButton.classList.toggle("running", status !== null);
  });

  const back = () => {
    void editor.autosave.flush();
    // The panel's Recent list is the way back: asked for first, since the window goes with the page — main closes
    // the tab of a page that closed itself (docs/extensions.md §4).
    void pistachio.ui.openPanel().catch(() => undefined);
    window.close();
  };

  const titlebar = h(
    "header",
    { class: "titlebar" },
    h("button", { class: "icon-button", title: "Back to recordings", onclick: back }, icon(ICONS.back)),
    h("div", { class: "title" }, h("span", { class: "title-text", title }, title), saveState),
    h("div", { class: "titlebar-tools" }, undoButton, redoButton, h("span", { class: "divider" }), aspect, lookToggle, exportButton),
  );

  const syncTitlebar = () => {
    undoButton.disabled = !editor.history.canUndo;
    redoButton.disabled = !editor.history.canRedo;
    aspect.value = editor.project.look.aspect;
    lookToggle.setAttribute("aria-pressed", String(!editor.raw));
    lookToggle.classList.toggle("on", !editor.raw);
    saveState.textContent = editor.saveState === "error" ? "Not saved" : editor.saveState === "saving" ? "Saving…" : "Saved";
    saveState.classList.toggle("error", editor.saveState === "error");
  };
  editor.on((change) => {
    if (change === "project" || change === "mode" || change === "saved") syncTitlebar();
  });
  syncTitlebar();

  root.replaceChildren(
    h("div", { class: "editor" }, titlebar, preview.el, inspector.el, timeline.el, sheet.el, sheet.card),
  );
  preview.layout();
  timeline.layout();

  // ── Keys ────────────────────────────────────────────────────────────────

  document.addEventListener("keydown", (event) => {
    if (sheet.isOpen) {
      if (event.key === "Escape") sheet.close();
      return;
    }
    const target = event.target as HTMLElement | null;
    const inputType = target instanceof HTMLInputElement ? target.type : undefined;
    if (keyBelongsToField(target?.tagName, inputType, event.key)) return;
    if ((event.key === " " || event.key === "Enter") && target instanceof HTMLButtonElement) return;
    const command = commandFor(event);
    if (command === null) return;
    event.preventDefault();
    run(command);
  });
  // A click on a control should not leave it holding the keys (Space would press it again).
  document.addEventListener("mousedown", (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest("button, .segment") !== null && target?.closest(".sheet") === null) event.preventDefault();
  });

  const flush = () => void editor.autosave.flush();
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
  return editor;
}

/** The dev kit's export draws its frames with a renderer of its own size, made once. */
function exportDrawer(editor: Editor): (ctx: CanvasRenderingContext2D, tOut: number, width: number, height: number) => void {
  let renderer: Renderer | null = null;
  return (ctx, tOut, width, height) => {
    renderer ??= editor.solvers.createRenderer(editor.renderState({ w: width, h: height }), editor.map);
    renderer.render(ctx, tOut, { screen: editor.dev?.screenFrame(editor.map.toSource(tOut)) ?? null, camera: null });
  };
}
