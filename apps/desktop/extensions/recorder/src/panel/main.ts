/**
 * The panel (docs/recorder.md §2 "Start"): the source (the window in use,
 * chosen; *Another window ▸* lists the desk's windows with their stills), the
 * mic with a live meter, the camera with a small preview, page sound,
 * quality, the countdown, **Record**; while recording the same card shows the
 * clock with Pause and Stop. *Recent* lists the last five recordings.
 *
 * It never captures: Record asks the worker (`runtime.sendMessage`), and a
 * `runtime.connect("panel")` port brings the session's state back. The mic
 * meter and the camera preview are the panel's own short-lived streams,
 * stopped before the worker opens the devices.
 */
import "./panel.css";
import { PreviewSlot } from "./previews.js";
import { CHOICES_KEY, choicesFrom, qualityOf, type Choices } from "../engine/choices.js";
import { formatClock } from "../engine/ids.js";
import type { SessionSnapshot } from "../engine/recorder.js";
import type { RecordingSummary } from "../lib/types.js";

await pistachio.runtime.ready;

type Json = Pistachio.Json;
type Child = Node | string | null | false | undefined;

/** A tiny element builder: `h("button", { class: "x", onclick }, "Text")`. */
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value as EventListener);
    else if (key === "class") el.className = String(value);
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (key in el && typeof value !== "string") (el as unknown as Record<string, unknown>)[key] = value;
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children) if (child !== null && child !== false && child !== undefined) el.append(child);
  return el;
}

const ask = async (message: Record<string, Json>): Promise<Record<string, Json>> => {
  try {
    const answer = await pistachio.runtime.sendMessage(message);
    return answer !== null && typeof answer === "object" && !Array.isArray(answer) ? answer : { ok: false, error: "no answer" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

// ── State ────────────────────────────────────────────────────────────────

const settings: Record<string, Json> = await pistachio.settings.getAll().catch(() => ({}));
let choices: Choices = choicesFrom((await pistachio.storage.local.get(CHOICES_KEY).catch((): Record<string, Json> => ({})))[CHOICES_KEY], settings);
let sources: Pistachio.CaptureSource[] = [];
let chosen: string | null = null;
let othersOpen = false;
let live: SessionSnapshot | null = null;
let recent: RecordingSummary[] = [];
let error: string | null = null;
let busy = false;
let mics: MediaDeviceInfo[] = [];
let confirmDelete: string | null = null;

const saveChoices = (): void => void pistachio.storage.local.set({ [CHOICES_KEY]: choices as unknown as Json }).catch(() => undefined);
const isLive = (): boolean => live !== null && (live.state === "counting" || live.state === "recording" || live.state === "paused" || live.state === "finalizing");

// ── The mic meter and the camera preview (the panel's own streams) ────────

const micSlot = new PreviewSlot<MediaStream>();
let micContext: AudioContext | null = null;
let micFrame = 0;
const cameraSlot = new PreviewSlot<MediaStream>();
const meterBars = Array.from({ length: 4 }, () => h("i"));
const meter = h("span", { class: "meter", "aria-hidden": "true" }, ...meterBars);
const preview = h("video", { class: "preview", autoplay: true, muted: true, playsInline: true });

function stopMic(): void {
  cancelAnimationFrame(micFrame);
  // (A stop while getUserMedia waits: the stream it brings is stopped as it comes — PreviewSlot.)
  micSlot.stop();
  void micContext?.close().catch(() => undefined);
  micContext = null;
  meter.classList.remove("on");
}

function stopCamera(): void {
  cameraSlot.stop();
  preview.srcObject = null;
  preview.classList.remove("on");
}

/** Whether a mic meter is wanted now: a mic chosen, nothing recording, the panel shown. */
const micWanted = (): boolean => choices.mic !== null && !isLive() && !document.hidden;
const cameraWanted = (): boolean => choices.camera && !isLive() && !document.hidden;

async function startMic(): Promise<void> {
  stopMic();
  const mic = choices.mic;
  if (mic === null || !micWanted()) return;
  try {
    const audio: MediaTrackConstraints = mic === "default" ? {} : { deviceId: { exact: mic } };
    const stream = await micSlot.open(() => navigator.mediaDevices.getUserMedia({ audio }), micWanted);
    if (stream === null) return;
    await listMics();
    const context = new AudioContext();
    micContext = context;
    void context.resume();
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const levels = [0, 0, 0, 0];
    let last = 0;
    meter.classList.add("on");
    const draw = (time: number): void => {
      micFrame = requestAnimationFrame(draw);
      if (time - last < 80) return;
      last = time;
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const value of samples) sum += value * value;
      const db = 20 * Math.log10(Math.max(Math.sqrt(sum / samples.length), 1e-9));
      levels.shift();
      levels.push(Math.min(1, Math.max(0, (db + 60) / 60)));
      levels.forEach((level, index) => {
        (meterBars[index] as HTMLElement).style.transform = `scaleY(${String(0.15 + level * 0.85)})`;
      });
    };
    micFrame = requestAnimationFrame(draw);
  } catch {
    // (No grant yet, or no mic: no meter. The worker asks again when recording.)
    meter.classList.remove("on");
  }
}

async function startCamera(): Promise<void> {
  stopCamera();
  if (!cameraWanted()) return;
  const stream = await cameraSlot.open(() => navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 180, frameRate: 15 } }), cameraWanted);
  if (stream === null) {
    preview.classList.remove("on");
    return;
  }
  preview.srcObject = stream;
  preview.classList.add("on");
}

async function listMics(): Promise<void> {
  try {
    mics = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "audioinput" && device.deviceId !== "default" && device.deviceId !== "");
  } catch {
    mics = [];
  }
  render();
}

// ── Talking to the worker ─────────────────────────────────────────────────

async function loadSources(): Promise<void> {
  // Asked by the panel itself, never through the worker: the open panel is the person's chooser, and what it lists is
  // theirs to pick — the grant that lets a window other than the one in use be recorded — with each window's picture.
  try {
    sources = await pistachio.capture.sources();
  } catch {
    sources = [];
  }
  if (chosen === null || !sources.some((source) => source.tabId === chosen)) chosen = sources.find((source) => source.inUse)?.tabId ?? sources[0]?.tabId ?? null;
  render();
}

async function loadRecent(): Promise<void> {
  const answer = await ask({ type: "recent", limit: 5 });
  recent = Array.isArray(answer["recordings"]) ? (answer["recordings"] as unknown as RecordingSummary[]) : [];
  render();
}

async function record(): Promise<void> {
  if (busy || isLive()) return;
  busy = true;
  error = null;
  stopMic();
  stopCamera();
  render();
  const quality = qualityOf(choices.quality, settings["fps"]);
  const answer = await ask({
    type: "start",
    tabId: chosen,
    mic: choices.mic,
    camera: choices.camera,
    pageAudio: choices.pageAudio,
    scale: quality.scale,
    fps: quality.fps,
    countdown: choices.countdown,
  });
  busy = false;
  if (answer["ok"] !== true) {
    error = typeof answer["error"] === "string" ? answer["error"] : "The recording did not start.";
    void startMic();
    void startCamera();
  }
  render();
}

const port = pistachio.runtime.connect("panel");
port.onMessage((message) => {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return;
  if (message["type"] === "state") {
    const was = isLive();
    live = (message["state"] ?? null) as unknown as SessionSnapshot | null;
    if (was && !isLive()) {
      void loadRecent();
      void startMic();
      void startCamera();
    }
    if (!was && isLive()) {
      stopMic();
      stopCamera();
    }
    render();
  } else if (message["type"] === "recent") {
    void loadRecent();
  }
});

// ── Rendering ─────────────────────────────────────────────────────────────

const root = h("main", { class: "panel" });
document.body.append(root);

function still(source: { still: string | null; favIconUrl: string | null; title: string }, className: string): HTMLElement {
  if (source.still !== null) return h("img", { class: className, src: source.still, alt: "" });
  return h("span", { class: `${className} blank` }, source.favIconUrl === null ? "" : h("img", { class: "favicon", src: source.favIconUrl, alt: "" }));
}

const BAR_GLYPHS = "▁▂▃▄▅▆▇█";

/** The engine's four-glyph meter (`▁▃▅▂`) drawn as four bars. */
function liveMeter(glyphs: string): HTMLElement {
  return h(
    "span",
    { class: "live-meter", "aria-hidden": "true" },
    ...[...glyphs].map((glyph) => {
      const bar = h("i");
      bar.style.transform = `scaleY(${String((Math.max(0, BAR_GLYPHS.indexOf(glyph)) + 1) / BAR_GLYPHS.length)})`;
      return bar;
    }),
  );
}

function liveCard(state: SessionSnapshot): HTMLElement {
  const counting = state.state === "counting";
  const paused = state.state === "paused";
  const saving = state.state === "finalizing";
  const head = counting
    ? h("div", { class: "clock" }, h("span", { class: "dot" }), state.countdown === null ? "Starting…" : `Starting in ${String(state.countdown)}`)
    : h("div", { class: `clock${paused ? " paused" : ""}` }, h("span", { class: "dot" }), formatClock(state.elapsedMs), state.meter !== "" && !paused && !saving ? liveMeter(state.meter) : null, paused ? h("span", { class: "note" }, "Paused") : null, saving ? h("span", { class: "note" }, "Saving…") : null);
  return h(
    "section",
    { class: "card live", "aria-live": "polite" },
    head,
    h("div", { class: "live-title", title: state.title }, state.title),
    saving
      ? null
      : h(
          "div",
          { class: "actions" },
          counting ? null : h("button", { type: "button", onclick: () => void ask({ type: paused ? "resume" : "pause" }) }, paused ? "Resume" : "Pause"),
          counting ? null : h("button", { type: "button", class: "primary stop", onclick: () => void ask({ type: "stop" }) }, "Stop"),
          h("button", { type: "button", class: "quiet", onclick: () => void ask({ type: "discard" }) }, counting ? "Cancel" : "Discard"),
        ),
  );
}

function setupCard(): HTMLElement {
  const chosenSource = sources.find((source) => source.tabId === chosen) ?? null;
  const others = sources.filter((source) => source.tabId !== chosen);
  const quality = qualityOf("crisp", settings["fps"]);
  const field = (label: string, ...controls: Child[]): HTMLElement => h("div", { class: "field" }, h("span", { class: "label" }, label), h("span", { class: "control" }, ...controls));
  const toggle = (label: string, on: boolean, change: (on: boolean) => void): HTMLElement =>
    h("input", { type: "checkbox", role: "switch", class: "switch", checked: on, "aria-label": label, onchange: (event: Event) => change((event.target as HTMLInputElement).checked) });

  const micSelect = h(
    "select",
    {
      "aria-label": "Microphone",
      onchange: (event: Event) => {
        const value = (event.target as HTMLSelectElement).value;
        choices = { ...choices, mic: value === "" ? null : value };
        saveChoices();
        void startMic();
      },
    },
    h("option", { value: "", selected: choices.mic === null }, "No microphone"),
    h("option", { value: "default", selected: choices.mic === "default" }, "Default microphone"),
    ...mics.map((device, index) => h("option", { value: device.deviceId, selected: choices.mic === device.deviceId }, device.label || `Microphone ${String(index + 1)}`)),
  );
  if (choices.mic !== null && choices.mic !== "default" && !mics.some((device) => device.deviceId === choices.mic)) {
    micSelect.append(h("option", { value: choices.mic, selected: true }, "The last microphone"));
  }

  return h(
    "section",
    { class: "card setup" },
    h("h1", {}, "Record"),
    chosenSource === null
      ? h("p", { class: "empty" }, "No window to record. Open a page on the desk.")
      : h("div", { class: "source chosen" }, still(chosenSource, "thumb"), h("div", { class: "source-text" }, h("div", { class: "source-title", title: chosenSource.title }, chosenSource.title || chosenSource.url), h("div", { class: "source-note" }, chosenSource.inUse ? "The window in use" : "Another window"))),
    others.length === 0
      ? null
      : h(
          "button",
          {
            type: "button",
            class: "disclosure",
            "aria-expanded": othersOpen ? "true" : "false",
            onclick: () => {
              othersOpen = !othersOpen;
              render();
              if (othersOpen) void loadSources();
            },
          },
          othersOpen ? "Another window ▾" : "Another window ▸",
        ),
    othersOpen && others.length > 0
      ? h(
          "div",
          { class: "tiles" },
          ...others.map((source) =>
            h(
              "button",
              {
                type: "button",
                class: "tile",
                title: source.title,
                onclick: () => {
                  chosen = source.tabId;
                  othersOpen = false;
                  render();
                },
              },
              still(source, "tile-still"),
              h("span", { class: "tile-title" }, source.title || source.url),
            ),
          ),
        )
      : null,
    field("Microphone", micSelect, meter),
    field(
      "Camera",
      preview,
      toggle("Camera", choices.camera, (on) => {
        choices = { ...choices, camera: on };
        saveChoices();
        void startCamera();
        render();
      }),
    ),
    field(
      "Page sound",
      toggle("Page sound", choices.pageAudio, (on) => {
        choices = { ...choices, pageAudio: on };
        saveChoices();
      }),
    ),
    field(
      "Quality",
      h(
        "select",
        {
          "aria-label": "Quality",
          onchange: (event: Event) => {
            choices = { ...choices, quality: (event.target as HTMLSelectElement).value === "native" ? "native" : "crisp" };
            saveChoices();
          },
        },
        h("option", { value: "crisp", selected: choices.quality === "crisp" }, `Crisp 2× · ${String(quality.fps)} fps`),
        h("option", { value: "native", selected: choices.quality === "native" }, "Native · 30 fps"),
      ),
    ),
    field(
      "Countdown",
      h(
        "select",
        {
          "aria-label": "Countdown",
          onchange: (event: Event) => {
            choices = { ...choices, countdown: Number((event.target as HTMLSelectElement).value) };
            saveChoices();
          },
        },
        ...[0, 3, 5].map((seconds) => h("option", { value: String(seconds), selected: choices.countdown === seconds }, seconds === 0 ? "Off" : `${String(seconds)} s`)),
      ),
    ),
    error === null ? null : h("p", { class: "error", role: "alert" }, error),
    h("button", { type: "button", class: "record", disabled: busy || chosen === null, onclick: () => void record() }, h("span", { class: "dot" }), busy ? "Starting…" : "Record", h("kbd", {}, "⌘⇧6")),
  );
}

/** `3:32 PM` today, `Oct 29` before. */
function when(at: number): string {
  const date = new Date(at);
  return date.toDateString() === new Date().toDateString() ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function recentList(): HTMLElement | null {
  if (recent.length === 0) return null;
  return h(
    "section",
    { class: "recent" },
    h("h2", {}, "Recent"),
    h(
      "ul",
      {},
      ...recent.map((item) =>
        h(
          "li",
          { class: "row" },
          item.thumbUrl === null ? h("span", { class: "row-thumb blank" }) : h("img", { class: "row-thumb", src: item.thumbUrl, alt: "" }),
          h(
            "div",
            { class: "row-body" },
            h("button", { type: "button", class: "row-title", title: `Open ${item.title}`, onclick: () => void ask({ type: "open", id: item.id }) }, item.title),
            h(
              "div",
              { class: "row-line" },
              h("span", { class: "row-note" }, `${formatClock(item.durationMs)} · ${when(item.startedAt)}`),
              h("button", { type: "button", class: "quiet", onclick: () => void ask({ type: "open", id: item.id }) }, "Open"),
              h("button", { type: "button", class: "quiet", onclick: () => void ask({ type: "reveal", id: item.id }) }, "Reveal"),
              h(
                "button",
                {
                  type: "button",
                  class: `quiet${confirmDelete === item.id ? " danger" : ""}`,
                  onclick: async () => {
                    if (confirmDelete !== item.id) {
                      confirmDelete = item.id;
                      render();
                      setTimeout(() => {
                        if (confirmDelete === item.id) {
                          confirmDelete = null;
                          render();
                        }
                      }, 3000);
                      return;
                    }
                    confirmDelete = null;
                    await ask({ type: "delete", id: item.id });
                    await loadRecent();
                  },
                },
                confirmDelete === item.id ? "Delete?" : "Delete",
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

function render(): void {
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement.getAttribute("aria-label") : null;
  root.replaceChildren(...[live !== null && isLive() ? liveCard(live) : setupCard(), recentList()].filter((node): node is HTMLElement => node !== null));
  if (focused !== null) root.querySelector<HTMLElement>(`[aria-label="${CSS.escape(focused)}"]`)?.focus();
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopMic();
    stopCamera();
  } else {
    void startMic();
    void startCamera();
    void loadSources();
  }
});
window.addEventListener("pagehide", () => {
  stopMic();
  stopCamera();
});

render();
const initial = await ask({ type: "state" });
live = (initial["state"] ?? null) as unknown as SessionSnapshot | null;
await Promise.all([loadSources(), loadRecent(), listMics()]);
void startMic();
void startCamera();
