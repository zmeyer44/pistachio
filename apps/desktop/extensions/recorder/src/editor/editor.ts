/**
 * The editor's state (docs/recorder.md §5): the project, the selection, the
 * playhead (output seconds), and what the solvers derive from the project. Every
 * edit goes through `edit`, which keeps the history, re-solves only what the edit
 * changed (the time map on cuts and speed; the render state — the lib's
 * `renderStateFor`, as the export builds it — on zooms, zoom settings, the cursor
 * and the duration), and schedules the autosave.
 */
import { cursorSpecAllowed } from "../lib/cursor-modes.js";
import type { CameraSample, Project, RenderState, Size, TimeMap } from "../lib/types.js";
import { createAutosave, type Autosave } from "./autosave.js";
import { eventMarks, type EventMark } from "./derive.js";
import { History } from "./history.js";
import type { LoadedRecording } from "./load.js";
import { NONE, clamp, cloneProject, mergeAutoZooms, sameJson, stringifyProject, validSelection, type Selection } from "./model.js";
import type { DevKit, Solvers } from "./solvers.js";

export type Change =
  /** The project changed (an edit, an undo). */
  | "project"
  /** The derived state changed (a re-solve, the media's real duration). */
  | "derived"
  | "selection"
  /** The playhead was moved by a person (the player must seek). */
  | "seek"
  /** The playhead moved with playback. */
  | "playhead"
  /** Playing, the raw view. */
  | "mode"
  | "saved";

const IDENTITY: CameraSample = { cx: 0.5, cy: 0.5, z: 1 };

export class Editor {
  readonly rec: LoadedRecording;
  readonly solvers: Solvers;
  readonly dev: DevKit | null;
  readonly history = new History<Project>();
  readonly autosave: Autosave;
  readonly marks: EventMark[];
  /** Smooth and Glide need a capture without Chromium's cursor (R5): only when the engine says `cursorBaked: false`. */
  readonly cursorModesLocked: boolean;

  project: Project;
  selection: Selection = NONE;
  /** Output seconds. */
  playhead = 0;
  playing = false;
  /** Preview the raw recording instead of the look. */
  raw = false;
  /** Source seconds. */
  duration: number;
  map!: TimeMap;
  saveState: "saved" | "saving" | "error" = "saved";
  /** The solved render state (camera path, cursor path, chapters, chips), rebuilt only when what it solves from changes. */
  private solved!: RenderState;
  private readonly listeners = new Set<(change: Change) => void>();

  constructor(rec: LoadedRecording, solvers: Solvers, dev: DevKit | null) {
    this.rec = rec;
    this.solvers = solvers;
    this.dev = dev;
    this.cursorModesLocked = rec.meta.cursorBaked !== false;
    // (A restored project may say Hidden or Hide when idle from before the lock, or from another Pistachio.)
    this.project = { ...rec.project, cursor: cursorSpecAllowed(rec.project.cursor, this.cursorModesLocked) };
    this.duration = rec.duration;
    this.marks = eventMarks(rec.events);
    this.autosave = createAutosave((text) => pistachio.files.data.write(rec.paths.project, text), {
      onSaved: () => {
        this.saveState = this.autosave.pending ? "saving" : "saved";
        this.emit("saved");
      },
      onError: (error) => {
        this.saveState = "error";
        pistachio.runtime.log("error", "recorder: project.json not saved", { message: error instanceof Error ? error.message : String(error) });
        this.emit("saved");
      },
    });
    this.resolve(null);
  }

  on(fn: (change: Change) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(change: Change): void {
    for (const fn of this.listeners) fn(change);
  }

  // ── Edits ────────────────────────────────────────────────────────────────

  /**
   * Change the project. `mutate` edits a copy in place or returns a new one. `key`
   * coalesces a run (a slider's drag) into one undo step. Returns whether it changed.
   */
  edit(mutate: (draft: Project) => Project | void, options: { key?: string | null; select?: Selection } = {}): boolean {
    const before = this.project;
    const draft = cloneProject(before);
    const next = mutate(draft) ?? draft;
    if (before.zoom.auto !== next.zoom.auto || before.zoom.maxLevel !== next.zoom.maxLevel) {
      next.zooms = mergeAutoZooms(next.zooms, this.solveAutoZooms(next), next.zoom.auto);
    }
    if (sameJson(before, next)) {
      if (options.select !== undefined) this.select(options.select);
      return false;
    }
    this.history.record(before, options.key ?? null);
    this.project = next;
    this.resolve(before);
    if (options.select !== undefined) this.selection = options.select;
    this.selection = validSelection(next, this.selection);
    this.save();
    this.emit("project");
    return true;
  }

  /** End a coalesced run (a drag's release). */
  seal(): void {
    this.history.seal();
  }

  undo(): void {
    const previous = this.history.undo(this.project);
    if (previous !== null) this.restore(previous);
  }

  redo(): void {
    const next = this.history.redo(this.project);
    if (next !== null) this.restore(next);
  }

  private restore(project: Project): void {
    const before = this.project;
    this.project = project;
    this.resolve(before);
    this.selection = validSelection(project, this.selection);
    this.save();
    this.emit("project");
  }

  private save(): void {
    this.saveState = "saving";
    this.autosave.schedule(stringifyProject(this.project));
    this.emit("saved");
  }

  select(selection: Selection): void {
    const next = validSelection(this.project, selection);
    if (sameJson(next, this.selection)) return;
    this.selection = next;
    this.emit("selection");
  }

  // ── Time ────────────────────────────────────────────────────────────────

  /** A person moved the playhead (output seconds). */
  seek(tOut: number): void {
    this.playhead = clamp(tOut, 0, this.map.duration);
    this.emit("seek");
  }

  /** Playback moved the playhead. */
  tick(tOut: number): void {
    this.playhead = clamp(tOut, 0, this.map.duration);
    this.emit("playhead");
  }

  /** The playhead in source seconds. */
  get playheadSource(): number {
    return this.map.toSource(this.playhead);
  }

  setPlaying(playing: boolean): void {
    if (this.playing === playing) return;
    this.playing = playing;
    this.emit("mode");
  }

  setRaw(raw: boolean): void {
    if (this.raw === raw) return;
    this.raw = raw;
    this.emit("mode");
  }

  /** The media said how long the recording really is. */
  setDuration(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0 || Math.abs(seconds - this.duration) < 0.02) return;
    this.duration = seconds;
    this.resolve(null);
    this.emit("derived");
  }

  /** The zoom whose rectangle the preview shows: selected, and not playing. */
  get editingZoomId(): string | null {
    if (this.playing || this.raw || this.selection.kind !== "zoom") return null;
    return this.selection.id;
  }

  // ── The solvers ─────────────────────────────────────────────────────────

  private solveAutoZooms(project: Project) {
    const { meta, events } = this.rec;
    return this.solvers.zoomSegments(events, meta.view, meta.capture.dpr, project.zoom);
  }

  /** Re-solve what depends on what changed between `before` and the project (everything when null). */
  private resolve(before: Project | null): void {
    const p = this.project;
    if (before === null || !sameJson(before.cuts, p.cuts) || !sameJson(before.speed, p.speed)) {
      this.map = this.solvers.timeMap(p.cuts, p.speed, this.duration);
      this.playhead = clamp(this.playhead, 0, this.map.duration);
    }
    if (before === null || !sameJson(before.zooms, p.zooms) || !sameJson(before.zoom, p.zoom) || !sameJson(before.cursor, p.cursor)) {
      this.solved = this.solvers.renderStateFor(p, this.rec, { w: 1, h: 1 }, { duration: this.duration });
    }
    if (before !== null) this.emit("derived");
  }

  /** The camera at a source time, as the export will move it. */
  cameraAt(tSrc: number): CameraSample {
    return this.solved.camera(tSrc);
  }

  /**
   * What the renderer needs for an output size: the lib's render state (the
   * export's own) over the project as it is now. While a zoom is being aimed
   * the camera holds still at 1× so the whole page shows.
   */
  renderState(output: Size): RenderState {
    const still = this.editingZoomId !== null;
    return { ...this.solved, project: this.project, output, camera: still ? () => IDENTITY : this.solved.camera };
  }
}
