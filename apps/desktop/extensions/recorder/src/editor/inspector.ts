/**
 * The inspector (docs/recorder.md §2 "Edit"), 280 px at the trailing edge: what is
 * selected on the timeline, then Background, Frame, Cursor, Zoom, Camera, Audio.
 * Every control edits the project through `Editor.edit` (a slider's drag is one
 * undo step) and follows the project back on undo.
 */
import { CURSOR_LOCK_NOTE, cursorModeAvailable, hideIdleAvailable } from "../lib/cursor-modes.js";
import type { CameraBubbleSpec, CursorSpec, LookSpec, Project, ZoomEase } from "../lib/types.js";
import { formatClock, levelText } from "./derive.js";
import { ICONS, h, icon } from "./dom.js";
import type { Editor } from "./editor.js";
import { clamp, type Selection } from "./model.js";
import { SWATCHES, backgroundOf, swatchCss } from "./swatches.js";
import { speedLabel } from "./timeline.js";

export interface InspectorActions {
  deleteSelection(): void;
  speedUpSelection(): void;
}

type Sync = (project: Project) => void;

interface Option<T> {
  value: T;
  label: string;
  title?: string;
  disabled?: boolean;
}

/** Controls that keep themselves in step with the project. */
class Controls {
  readonly syncs: Sync[] = [];
  private readonly editor: Editor;

  constructor(editor: Editor) {
    this.editor = editor;
  }

  sync(project: Project): void {
    for (const fn of this.syncs) fn(project);
  }

  slider(options: { label: string; min: number; max: number; step: number; get: (p: Project) => number; set: (p: Project, v: number) => void; format: (v: number) => string; key: string; disabled?: (p: Project) => boolean }): HTMLElement {
    const input = h("input", { type: "range", min: options.min, max: options.max, step: options.step, "aria-label": options.label });
    const value = h("output", { class: "row-value" });
    input.addEventListener("input", () => {
      const v = Number(input.value);
      this.editor.edit((draft) => options.set(draft, v), { key: options.key });
    });
    input.addEventListener("change", () => this.editor.seal());
    const row = h("label", { class: "row" }, h("span", { class: "row-label" }, options.label), input, value);
    this.syncs.push((p) => {
      const v = options.get(p);
      if (document.activeElement !== input || input.value !== String(v)) input.value = String(v);
      input.style.setProperty("--fill", `${String(((clamp(v, options.min, options.max) - options.min) / (options.max - options.min)) * 100)}%`);
      value.textContent = options.format(v);
      const disabled = options.disabled?.(p) ?? false;
      input.disabled = disabled;
      row.classList.toggle("disabled", disabled);
    });
    return row;
  }

  segmented<T extends string | number>(options: { label?: string; choices: Option<T>[]; get: (p: Project) => T; set: (p: Project, v: T) => void; disabled?: (p: Project, v: T) => boolean; wide?: boolean }): HTMLElement {
    const buttons = options.choices.map((choice) => {
      const button = h("button", { type: "button", class: "segment", title: choice.title ?? choice.label, onclick: () => this.editor.edit((draft) => options.set(draft, choice.value)) }, choice.label);
      return { button, choice };
    });
    const group = h("div", { class: `segmented${options.wide === true ? " wide" : ""}`, role: "radiogroup", "aria-label": options.label ?? "" }, ...buttons.map((b) => b.button));
    this.syncs.push((p) => {
      const current = options.get(p);
      for (const { button, choice } of buttons) {
        const on = choice.value === current;
        button.classList.toggle("on", on);
        button.setAttribute("aria-checked", String(on));
        button.disabled = choice.disabled === true || (options.disabled?.(p, choice.value) ?? false);
      }
    });
    if (options.label === undefined) return group;
    // Four or more choices take the row's full width, under their label.
    const stacked = options.choices.length > 3 || options.wide === true;
    return h("div", { class: stacked ? "row stacked" : "row paired" }, h("span", { class: "row-label" }, options.label), group);
  }

  toggle(options: { label: string; get: (p: Project) => boolean; set: (p: Project, v: boolean) => void; disabled?: (p: Project) => boolean }): HTMLElement {
    const input = h("input", { type: "checkbox", class: "switch", role: "switch" });
    input.addEventListener("change", () => this.editor.edit((draft) => options.set(draft, input.checked)));
    const row = h("label", { class: "row toggle" }, h("span", { class: "row-label" }, options.label), input);
    this.syncs.push((p) => {
      input.checked = options.get(p);
      const disabled = options.disabled?.(p) ?? false;
      input.disabled = disabled;
      row.classList.toggle("disabled", disabled);
    });
    return row;
  }
}

function section(title: string, ...children: (Node | null)[]): HTMLElement {
  return h("details", { class: "section", open: true }, h("summary", {}, title), h("div", { class: "section-body" }, ...children));
}

const percent = (v: number) => `${String(Math.round(v * 100))}%`;

export class Inspector {
  readonly el: HTMLElement;
  private readonly editor: Editor;
  private readonly actions: InspectorActions;
  private readonly controls: Controls;
  private readonly selectionSlot: HTMLElement;
  private selectionControls: Controls | null = null;
  private selectionKey = "";

  constructor(editor: Editor, actions: InspectorActions) {
    this.editor = editor;
    this.actions = actions;
    const c = (this.controls = new Controls(editor));
    const hasCamera = editor.rec.urls.camera !== null || editor.dev !== null;
    const hasMic = editor.rec.micLevels !== null || editor.rec.urls.mic !== null;
    const locked = editor.cursorModesLocked;
    const lockNote = locked ? "Needs a newer Pistachio" : undefined;

    this.selectionSlot = h("div", { class: "selection-slot" });

    const background = section(
      "Background",
      this.swatches(),
      c.toggle({ label: "Blur of the page", get: (p) => p.look.background.type === "blur", set: (p, v) => void (p.look.background = v ? { type: "blur" } : backgroundOf(SWATCHES[0]!)) }),
    );

    const frame = section(
      "Frame",
      c.slider({ label: "Padding", min: 0, max: 0.2, step: 0.005, key: "look.padding", get: (p) => p.look.padding, set: (p, v) => void (p.look.padding = v), format: percent }),
      c.slider({ label: "Corners", min: 0, max: 40, step: 1, key: "look.radius", get: (p) => p.look.radius, set: (p, v) => void (p.look.radius = v), format: (v) => String(Math.round(v)) }),
      c.slider({ label: "Shadow", min: 0, max: 1, step: 0.01, key: "look.shadow", get: (p) => p.look.shadow, set: (p, v) => void (p.look.shadow = v), format: percent }),
      c.segmented<LookSpec["frame"]>({
        label: "Window",
        choices: [
          { value: "browser", label: "Browser" },
          { value: "mac", label: "Mac" },
          { value: "none", label: "None" },
        ],
        get: (p) => p.look.frame,
        set: (p, v) => void (p.look.frame = v),
      }),
      c.segmented<LookSpec["aspect"]>({
        label: "Aspect",
        choices: [
          { value: "16:9", label: "16:9" },
          { value: "9:16", label: "9:16" },
          { value: "1:1", label: "1:1" },
          { value: "4:3", label: "4:3" },
          { value: "fit", label: "Fit" },
        ],
        get: (p) => p.look.aspect,
        set: (p, v) => void (p.look.aspect = v),
      }),
    );

    const cursor = section(
      "Cursor",
      c.segmented<CursorSpec["mode"]>({
        label: "Mode",
        choices: (["natural", "smooth", "glide", "hidden"] as const).map((value) => ({
          value,
          label: value === "natural" ? "Natural" : value === "smooth" ? "Smooth" : value === "glide" ? "Glide" : "Hidden",
          disabled: !cursorModeAvailable(value, locked),
          ...(lockNote === undefined || cursorModeAvailable(value, locked) ? {} : { title: lockNote }),
        })),
        get: (p) => p.cursor.mode,
        set: (p, v) => void (p.cursor.mode = v),
      }),
      locked ? h("p", { class: "note" }, CURSOR_LOCK_NOTE) : null,
      c.slider({ label: "Size", min: 1, max: 3, step: 0.05, key: "cursor.size", get: (p) => p.cursor.size, set: (p, v) => void (p.cursor.size = v), format: (v) => `${v.toFixed(1)}×`, disabled: (p) => p.cursor.mode === "hidden" }),
      c.slider({ label: "Smoothing", min: 0, max: 1, step: 0.01, key: "cursor.smoothing", get: (p) => p.cursor.smoothing, set: (p, v) => void (p.cursor.smoothing = v), format: percent, disabled: (p) => locked || p.cursor.mode !== "smooth" }),
      c.segmented<CursorSpec["click"]>({
        label: "Clicks",
        choices: [
          { value: "ripple", label: "Ripple" },
          { value: "none", label: "None" },
        ],
        get: (p) => p.cursor.click,
        set: (p, v) => void (p.cursor.click = v),
      }),
      c.toggle({ label: "Hide when idle", get: (p) => p.cursor.hideIdle, set: (p, v) => void (p.cursor.hideIdle = v), disabled: () => !hideIdleAvailable(locked) }),
    );

    const zoom = section(
      "Zoom",
      c.toggle({ label: "Automatic zoom", get: (p) => p.zoom.auto, set: (p, v) => void (p.zoom.auto = v) }),
      c.segmented<Project["zoom"]["feel"]>({
        label: "Feel",
        choices: [
          { value: "quick", label: "Quick" },
          { value: "mellow", label: "Mellow" },
          { value: "slow", label: "Slow" },
        ],
        get: (p) => p.zoom.feel,
        set: (p, v) => void (p.zoom.feel = v),
      }),
      c.slider({ label: "Max level", min: 1.25, max: 4, step: 0.05, key: "zoom.maxLevel", get: (p) => p.zoom.maxLevel, set: (p, v) => void (p.zoom.maxLevel = v), format: levelText }),
    );

    const noCamera = (_p: Project) => !hasCamera;
    const camera = section(
      "Camera",
      hasCamera ? null : h("p", { class: "note" }, "No camera in this recording."),
      c.segmented<CameraBubbleSpec["shape"]>({
        label: "Shape",
        choices: [
          { value: "circle", label: "Circle" },
          { value: "rounded", label: "Rounded" },
        ],
        get: (p) => p.camera.shape,
        set: (p, v) => void (p.camera.shape = v),
        disabled: noCamera,
      }),
      c.slider({ label: "Size", min: 0.08, max: 0.4, step: 0.01, key: "camera.size", get: (p) => p.camera.size, set: (p, v) => void (p.camera.size = v), format: percent, disabled: noCamera }),
      c.segmented<CameraBubbleSpec["corner"]>({
        label: "Corner",
        choices: [
          { value: "tl", label: "↖", title: "Top left" },
          { value: "tr", label: "↗", title: "Top right" },
          { value: "bl", label: "↙", title: "Bottom left" },
          { value: "br", label: "↘", title: "Bottom right" },
        ],
        get: (p) => p.camera.corner,
        set: (p, v) => void (p.camera.corner = v),
        disabled: noCamera,
      }),
      c.toggle({ label: "Shrink on zoom", get: (p) => p.camera.shrinkOnZoom, set: (p, v) => void (p.camera.shrinkOnZoom = v), disabled: noCamera }),
    );

    const audio = section(
      "Audio",
      c.slider({ label: "Mic", min: 0, max: 1, step: 0.01, key: "audio.mic", get: (p) => p.audio.mic, set: (p, v) => void (p.audio.mic = v), format: percent, disabled: () => !hasMic }),
      c.slider({ label: "Page", min: 0, max: 1, step: 0.01, key: "audio.page", get: (p) => p.audio.page, set: (p, v) => void (p.audio.page = v), format: percent }),
      c.toggle({ label: "Mute while sped up", get: (p) => p.audio.muteSpedUp, set: (p, v) => void (p.audio.muteSpedUp = v) }),
    );

    this.el = h("aside", { class: "inspector", "aria-label": "Inspector" }, this.selectionSlot, background, frame, cursor, zoom, camera, audio);
    this.sync();
    editor.on((change) => {
      if (change === "project" || change === "selection") this.sync();
    });
  }

  private sync(): void {
    const project = this.editor.project;
    this.controls.sync(project);
    this.syncSelection();
  }

  private swatches(): HTMLElement {
    const editor = this.editor;
    const tiles = SWATCHES.map((swatch) => {
      const button = h("button", { type: "button", class: "swatch", title: swatch.name, style: `background:${swatchCss(swatch)}`, onclick: () => editor.edit((p) => void (p.look.background = backgroundOf(swatch))) });
      return { button, matches: (p: Project) => p.look.background.type === swatch.kind && p.look.background.id === swatch.id };
    });
    const colour = h("input", { type: "color", class: "swatch-colour", title: "A solid colour", "aria-label": "Solid colour" });
    colour.addEventListener("input", () => editor.edit((p) => void (p.look.background = { type: "solid", color: colour.value }), { key: "look.solid" }));
    colour.addEventListener("change", () => editor.seal());
    const solid = h("label", { class: "swatch solid", title: "A solid colour" }, colour);
    this.controls.syncs.push((p) => {
      for (const tile of tiles) tile.button.classList.toggle("on", tile.matches(p));
      const isSolid = p.look.background.type === "solid";
      solid.classList.toggle("on", isSolid);
      if (p.look.background.type === "solid") {
        colour.value = p.look.background.color;
        solid.style.background = p.look.background.color;
      }
    });
    return h(
      "div",
      { class: "swatches" },
      h("div", { class: "swatch-group-label" }, "Wallpapers"),
      h("div", { class: "swatch-grid" }, ...tiles.filter((_t, i) => SWATCHES[i]!.kind === "wallpaper").map((t) => t.button)),
      h("div", { class: "swatch-group-label" }, "Gradients"),
      h("div", { class: "swatch-grid" }, ...tiles.filter((_t, i) => SWATCHES[i]!.kind === "gradient").map((t) => t.button), solid),
    );
  }

  // ── What is selected ────────────────────────────────────────────────────

  private syncSelection(): void {
    const selection = this.editor.selection;
    const key = selectionKey(selection);
    if (key !== this.selectionKey) {
      this.selectionKey = key;
      this.selectionControls = new Controls(this.editor);
      const body = this.buildSelection(selection, this.selectionControls);
      this.selectionSlot.replaceChildren(...(body === null ? [] : [body]));
      // What was just selected on the timeline is what the person wants to see.
      if (body !== null) this.el.scrollTop = 0;
    }
    this.selectionControls?.sync(this.editor.project);
    const heading = this.selectionSlot.querySelector<HTMLElement>("[data-live]");
    if (heading !== null) heading.textContent = this.selectionHeading(selection);
  }

  private selectionHeading(selection: Selection): string {
    const project = this.editor.project;
    const span = (start: number, end: number) => `${formatClock(start)}–${formatClock(end)}`;
    switch (selection.kind) {
      case "zoom": {
        const zoom = project.zooms.find((z) => z.id === selection.id);
        return zoom === undefined ? "" : `${span(zoom.start, zoom.end)}${zoom.auto ? " · auto" : ""}`;
      }
      case "speed": {
        const speed = project.speed.find((s) => s.id === selection.id);
        return speed === undefined ? "" : `${speedLabel(speed.rate, speed.auto)} · ${span(speed.start, speed.end)}`;
      }
      case "range":
        return `${(selection.end - selection.start).toFixed(2)} s of the recording`;
      case "clip": {
        const cut = project.cuts[selection.index];
        return cut === undefined ? "" : `Piece ${String(selection.index + 1)} of ${String(project.cuts.length)} · ${span(cut.in, cut.out)}`;
      }
      case "gap": {
        const left = project.cuts[selection.index];
        const right = project.cuts[selection.index + 1];
        if (left === undefined || right === undefined) return "";
        const removed = right.in - left.out;
        return removed > 0.01 ? `${removed.toFixed(2)} s cut out` : "A split";
      }
      case "none":
        return "";
    }
  }

  private buildSelection(selection: Selection, c: Controls): HTMLElement | null {
    const editor = this.editor;
    const live = h("div", { class: "selection-detail", "data-live": "" });
    const remove = (label: string) => h("button", { type: "button", class: "button subtle", onclick: () => this.actions.deleteSelection() }, icon(ICONS.trash, 14), label, h("kbd", {}, "⌫"));
    switch (selection.kind) {
      case "zoom": {
        const id = selection.id;
        const find = (p: Project) => p.zooms.find((z) => z.id === id);
        return section(
          "Zoom",
          live,
          c.slider({
            label: "Level",
            min: 1.1,
            max: 4,
            step: 0.05,
            key: `zoom:${id}:level`,
            get: (p) => find(p)?.level ?? 1,
            set: (p, v) => {
              const z = find(p);
              if (z !== undefined) Object.assign(z, { level: v, auto: false });
            },
            format: levelText,
          }),
          c.segmented<ZoomEase>({
            label: "Ease",
            choices: [
              { value: "spring", label: "Spring" },
              { value: "smooth", label: "Smooth" },
              { value: "cut", label: "Cut" },
            ],
            get: (p) => find(p)?.ease ?? "spring",
            set: (p, v) => {
              const z = find(p);
              if (z !== undefined) Object.assign(z, { ease: v, auto: false });
            },
          }),
          c.toggle({
            label: "Follow the cursor",
            get: (p) => find(p)?.follow ?? false,
            set: (p, v) => {
              const z = find(p);
              if (z !== undefined) Object.assign(z, { follow: v, auto: false });
            },
          }),
          h("p", { class: "note" }, "Drag the rectangle on the preview to aim it; its corners set the level."),
          h("div", { class: "actions" }, remove("Delete zoom")),
        );
      }
      case "speed": {
        const id = selection.id;
        const find = (p: Project) => p.speed.find((s) => s.id === id);
        return section(
          "Speed",
          live,
          c.segmented<number>({
            label: "Rate",
            wide: true,
            choices: [1.5, 2, 3, 4, 8, Infinity].map((rate) => ({ value: rate, label: Number.isFinite(rate) ? `${String(rate)}×` : "Cut", title: Number.isFinite(rate) ? `${String(rate)} times as fast` : "Cut it out (a short crossfade)" })),
            get: (p) => find(p)?.rate ?? 1,
            set: (p, v) => {
              const s = find(p);
              if (s !== undefined) s.rate = v;
            },
          }),
          h("div", { class: "actions" }, remove("Delete speed-up")),
        );
      }
      case "range":
        return section(
          "Selection",
          live,
          h(
            "div",
            { class: "actions" },
            h("button", { type: "button", class: "button subtle", onclick: () => this.actions.deleteSelection() }, icon(ICONS.scissors, 14), "Cut out", h("kbd", {}, "⌫")),
            h("button", { type: "button", class: "button subtle", onclick: () => this.actions.speedUpSelection() }, icon(ICONS.speed, 14), "Speed up", h("kbd", {}, "X")),
          ),
        );
      case "clip": {
        const only = editor.project.cuts.length <= 1;
        return section("Clip", live, only ? h("p", { class: "note" }, "Split it (S) to cut a piece out.") : h("div", { class: "actions" }, remove("Delete piece")));
      }
      case "gap":
        return section("Cut", live, h("div", { class: "actions" }, h("button", { type: "button", class: "button subtle", onclick: () => this.actions.deleteSelection() }, "Join back", h("kbd", {}, "⌫"))));
      case "none":
        return null;
    }
  }
}

function selectionKey(selection: Selection): string {
  switch (selection.kind) {
    case "zoom":
    case "speed":
      return `${selection.kind}:${selection.id}`;
    case "clip":
    case "gap":
      return `${selection.kind}:${String(selection.index)}`;
    default:
      return selection.kind;
  }
}
