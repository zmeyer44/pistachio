/**
 * Camera backgrounds (docs/live-share.md §1: none, blur, a few built-in
 * images, an uploaded picture), over `@livekit/track-processors`.
 *
 * One processor per camera track: the first effect sets it, every later
 * choice switches its mode, so changing a background never re-loads the
 * segmenter or blinks the picture. "None" switches it to pass-through rather
 * than tearing it down for the same reason.
 *
 * The processor's code (MediaPipe's JavaScript with it) is loaded when the
 * first effect is put on a camera, never before: this module is what menus
 * import for the choices and the support check, and a room that nobody
 * gives a background never fetches it.
 *
 * The segmenter's WASM and model come from the page's own origin, at
 * `EFFECTS_ASSET_PATH` unless `assetPath` names another base: www serves
 * them there, and so does the desktop's live-host page
 * (`@pistachio/live-share/assets` puts them in place for both). Never from
 * MediaPipe's CDN — a guest's browser talks to us and the room, nobody else.
 *
 * A camera let go for good is stopped with `stopCamera`, not its own
 * `stop()`: LiveKit destroys the processor a track has as it stops it, but
 * one whose segmenter is still loading is put on after — and would hold its
 * segmenter and WebGL context for as long as the page lives.
 *
 * Not a frame of what a background hides leaves the processor, by its
 * construction, not by timing. The library puts a new processor's first
 * frame out as it came, unprocessed, to show something while the segmenter
 * warms up — just after `setProcessor` resolves, by when LiveKit has swapped
 * a published camera onto the processed track (probed, 0.8.1: 20–38 ms
 * after) — so every processor starts past it (`isFirstFrame`), and one that
 * cannot be told to is refused. And a background counts as on only once a
 * processed picture has come out (`onFrameProcessed`): a camera behind it
 * is published after that, never on a track still waiting for its first —
 * or never, the background taken as not loading, when none comes in
 * `FIRST_PICTURE_TIMEOUT_MS`.
 *
 * Browser-only: import it where a camera exists, never in Electron main.
 */

import type { BackgroundProcessorWrapper } from "@livekit/track-processors";
import type { LocalVideoTrack } from "livekit-client";

export type LiveBackground =
  | { kind: "none" }
  | { kind: "blur"; strength?: "light" | "strong" }
  | { kind: "image"; url: string; label?: string };

export type LiveImageBackground = Extract<LiveBackground, { kind: "image" }>;

/**
 * Where the segmenter's files are served on the page's own origin:
 * `<base>/wasm/*` (the `@mediapipe/tasks-vision` wasm folder) and
 * `<base>/selfie_segmenter.tflite` (assets/index.mjs EFFECTS_ASSET_DIR).
 */
export const EFFECTS_ASSET_PATH = "/live/mediapipe";

export interface ApplyBackgroundOptions {
  /** Base URL of the segmenter's files; `EFFECTS_ASSET_PATH` when absent. */
  assetPath?: string;
}

const PROCESSOR_NAME = "live-background";

/**
 * How long a background's processor may take to put out its first processed
 * picture before the background counts as not having loaded: far past a
 * GPU's (well under a second), and past SwiftShader's on a loaded machine
 * (12–15 s from the processor going on, measured at load 12–19).
 */
export const FIRST_PICTURE_TIMEOUT_MS = 60_000;

const BLUR_RADIUS = { light: 6, strong: 16 } as const;

let supported: boolean | null = null;

/**
 * Whether this browser can run background effects at all; when not, the
 * effects menu is disabled. The same test `@livekit/track-processors` makes
 * (a WebGL 2 canvas, VideoFrame, OffscreenCanvas; a track processor or a
 * canvas stream), made here so a menu need not load the processor to ask —
 * and made once, its WebGL context let go at once: menus ask on every
 * render, and Chromium drops the oldest live context past sixteen, which
 * could be the segmenter's own.
 */
export function supportsBackgroundProcessors(): boolean {
  if (typeof document === "undefined" || typeof window === "undefined") return false;
  supported ??= detectSupport();
  return supported;
}

function detectSupport(): boolean {
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    const segmenter = typeof OffscreenCanvas !== "undefined" && typeof VideoFrame !== "undefined" && typeof createImageBitmap !== "undefined" && gl !== null;
    const frames =
      ("MediaStreamTrackProcessor" in globalThis && "MediaStreamTrackGenerator" in globalThis) ||
      (typeof HTMLCanvasElement !== "undefined" && "captureStream" in HTMLCanvasElement.prototype);
    return segmenter && frames;
  } catch {
    return false;
  }
}

const NO_BACKGROUND: LiveBackground = { kind: "none" };

/**
 * Per camera track: how many backgrounds were asked for, the turn of the one
 * asked for last, and the background on it now — null while nobody can say
 * (a change failed, and the one before could not be put back either).
 * Loading the processor takes a while (the first effect fetches the
 * segmenter), and the lobby and the room both let the person choose again
 * meanwhile: Blur, then None before it loaded, must not end on the blur that
 * finished loading after.
 */
interface Choices {
  asked: number;
  turn: Promise<unknown>;
  on: LiveBackground | null;
}

const choices = new WeakMap<LocalVideoTrack, Choices>();

/** Cameras let go for good (`stopCamera`). */
const stopped = new WeakSet<LocalVideoTrack>();

/** Per camera track with a processor: whether it has put out a processed picture yet, and when it does. */
interface FirstPicture {
  came: boolean;
  coming: Promise<void>;
}

const pictures = new WeakMap<LocalVideoTrack, FirstPicture>();

/** Whoever waits on a camera's first picture, woken to look again when a later choice comes or the camera is stopped. */
const waiting = new WeakMap<LocalVideoTrack, Set<() => void>>();

function wake(track: LocalVideoTrack): void {
  for (const look of waiting.get(track) ?? []) look();
}

/**
 * Put `bg` behind the person on `track`. Resolves false (and changes nothing)
 * where effects are unsupported; rejects when the effect fails to load (the
 * segmenter could not be fetched, a picture could not be read), for the
 * caller to say so — the background the track had put back on it first:
 * a switch that fails can leave the processor between the two (the blur
 * taken off, the picture not on).
 *
 * A background other than none resolves only once the processor has put out
 * a processed picture, and rejects when none comes in
 * `FIRST_PICTURE_TIMEOUT_MS` (as one that did not load).
 *
 * Choices on one track take turns, and the last one is what the camera
 * shows: a choice another came after, before its turn, while the processor
 * loaded for it or while it waited on its first picture, is let go (resolving
 * true; the later one answers for itself).
 */
export function applyBackground(track: LocalVideoTrack, bg: LiveBackground, options: ApplyBackgroundOptions = {}): Promise<boolean> {
  const choice = choices.get(track) ?? { asked: 0, turn: Promise.resolve(), on: NO_BACKGROUND };
  choices.set(track, choice);
  choice.asked += 1;
  wake(track);
  const ask = choice.asked;
  const superseded = (): boolean => choice.asked !== ask;
  const applied = choice.turn.then(() => (superseded() ? true : takeTurn(choice, track, bg, options, superseded)));
  choice.turn = applied.catch(() => undefined);
  return applied;
}

/**
 * Stop a camera for good — turned off, the room or the lobby left — and let
 * go of a background still loading for it: a processor that comes after is
 * destroyed as it lands, and none is made once it is stopped.
 */
export function stopCamera(track: LocalVideoTrack): void {
  stopped.add(track);
  track.stop();
  wake(track);
}

/** The background on `track` now: none for a camera never given one, null when nobody can say (`applyBackground`). */
export function backgroundOn(track: LocalVideoTrack): LiveBackground | null {
  const choice = choices.get(track);
  return choice === undefined ? NO_BACKGROUND : choice.on;
}

async function takeTurn(choice: Choices, track: LocalVideoTrack, bg: LiveBackground, options: ApplyBackgroundOptions, superseded: () => boolean): Promise<boolean> {
  try {
    const result = await putBackground(track, bg, options, superseded);
    if (result === "on") choice.on = bg;
    return result !== "unsupported";
  } catch (error) {
    const had = choice.on;
    choice.on = null;
    if (had !== null && (await putBackground(track, had, options, () => false).catch(() => null)) === "on") choice.on = had;
    throw error;
  }
}

/**
 * Put `bg` on: "skipped" when a later choice came while the processor loaded or while it waited on its first
 * picture, or the camera was stopped meanwhile; "unsupported" (nothing changed) where effects cannot run.
 */
async function putBackground(track: LocalVideoTrack, bg: LiveBackground, options: ApplyBackgroundOptions, superseded: () => boolean): Promise<"on" | "skipped" | "unsupported"> {
  const existing = ownProcessor(track);
  if (bg.kind === "none") {
    if (existing !== null) await existing.switchTo({ mode: "disabled" });
    return "on";
  }
  if (!supportsBackgroundProcessors()) return "unsupported";
  const mode =
    bg.kind === "blur"
      ? ({ mode: "background-blur", blurRadius: BLUR_RADIUS[bg.strength ?? "strong"] } as const)
      : ({ mode: "virtual-background", imagePath: bg.url } as const);
  if (existing !== null) {
    await existing.switchTo(mode);
    return firstPicture(track, superseded);
  }
  const processors = await import("@livekit/track-processors");
  // Chosen again while it loaded: the later choice puts on what it wants (None, nothing at all). Stopped: nothing to put it on.
  if (superseded() || stopped.has(track)) return "skipped";
  if (!processors.supportsBackgroundProcessors()) return "unsupported";
  const base = trimSlash(options.assetPath ?? EFFECTS_ASSET_PATH);
  let came = (): void => undefined;
  const picture: FirstPicture = { came: false, coming: new Promise<void>((resolve) => (came = resolve)) };
  const processor = processors.BackgroundProcessor(
    {
      ...mode,
      assetPaths: { tasksVisionFileSet: `${base}/wasm`, modelAssetPath: `${base}/selfie_segmenter.tflite` },
      onFrameProcessed: () => {
        if (picture.came) return;
        picture.came = true;
        came();
      },
    },
    PROCESSOR_NAME,
  );
  startPastFirstFrame(processor);
  pictures.set(track, picture);
  await track.setProcessor(processor);
  // Stopped while the segmenter loaded: stopping it again destroys the processor it has now, as stopping it did the one before.
  if (stopped.has(track)) {
    track.stop();
    return "skipped";
  }
  return firstPicture(track, superseded);
}

/**
 * The library puts a new processor's first frame out as it came, unprocessed (`isFirstFrame`, set until that
 * frame has gone): the processor starts past it, its first frame out the first one processed. One without the
 * switch (another version) is refused rather than trusted with the camera.
 */
function startPastFirstFrame(processor: BackgroundProcessorWrapper): void {
  const transformer: { isFirstFrame?: unknown } = processor.transformer;
  if (typeof transformer.isFirstFrame !== "boolean") throw new Error("this background processor would put the camera's first frame out unprocessed");
  transformer.isFirstFrame = false;
}

/**
 * "on" once the processor on `track` has put out a processed picture — at once when it has; "skipped" when a
 * later choice comes or the camera is stopped first; rejects when none comes in `FIRST_PICTURE_TIMEOUT_MS`.
 */
function firstPicture(track: LocalVideoTrack, superseded: () => boolean): Promise<"on" | "skipped"> {
  const picture = pictures.get(track);
  if (picture === undefined || picture.came) return Promise.resolve("on");
  return new Promise((resolve, reject) => {
    const watchers = waiting.get(track) ?? new Set<() => void>();
    waiting.set(track, watchers);
    const done = (): void => {
      clearTimeout(timer);
      watchers.delete(look);
    };
    const look = (): void => {
      if (!superseded() && !stopped.has(track)) return;
      done();
      resolve("skipped");
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error(`the background gave no picture in ${String(FIRST_PICTURE_TIMEOUT_MS / 1000)} s`));
    }, FIRST_PICTURE_TIMEOUT_MS);
    watchers.add(look);
    void picture.coming.then(() => {
      done();
      resolve("on");
    });
  });
}

/** The background processor this module put on `track`, if any. */
function ownProcessor(track: LocalVideoTrack): BackgroundProcessorWrapper | null {
  const processor = track.getProcessor();
  if (processor === undefined || processor.name !== PROCESSOR_NAME) return null;
  return processor as BackgroundProcessorWrapper;
}

function trimSlash(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

// ---------------------------------------------------------------------------
// Built-in backgrounds
// ---------------------------------------------------------------------------

/**
 * Soft, out-of-focus scenes drawn as SVG (no binary assets): blurred colour
 * fields that read as a room behind a person rather than as a pattern, so
 * the edges of the segmentation never look cut out against them.
 */
function scene(defs: string, body: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">` +
    `<defs><filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="70"/></filter>${defs}</defs>` +
    `${body}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const linear = (id: string, stops: readonly string[], x2 = 0, y2 = 1): string =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="${String(x2)}" y2="${String(y2)}">${stops
    .map((color, index) => `<stop offset="${String(index / (stops.length - 1))}" stop-color="${color}"/>`)
    .join("")}</linearGradient>`;

const blobs = (circles: ReadonlyArray<readonly [number, number, number, string, number?]>): string =>
  `<g filter="url(#b)">${circles
    .map(([cx, cy, r, fill, opacity]) => `<circle cx="${String(cx)}" cy="${String(cy)}" r="${String(r)}" fill="${fill}" opacity="${String(opacity ?? 1)}"/>`)
    .join("")}</g>`;

export const BUILTIN_BACKGROUNDS: readonly LiveImageBackground[] = [
  {
    kind: "image",
    label: "Dawn",
    url: scene(linear("g", ["#FCD9C4", "#E9C6E6", "#C9D3F5"]), `<rect width="1280" height="720" fill="url(#g)"/>${blobs([[260, 180, 220, "#FFE9B8", 0.9], [1040, 520, 260, "#F7B7C9", 0.7], [760, 120, 160, "#FFFFFF", 0.5]])}`),
  },
  {
    kind: "image",
    label: "Pistachio",
    url: scene(linear("g", ["#E6F0D8", "#C8DEB2", "#9FC49A"]), `<rect width="1280" height="720" fill="url(#g)"/>${blobs([[200, 560, 280, "#7FAF6E", 0.55], [1080, 160, 240, "#F3F7E8", 0.8], [700, 420, 180, "#B9D7A0", 0.6]])}`),
  },
  {
    kind: "image",
    label: "Dusk",
    url: scene(linear("g", ["#1E1B4B", "#3B2A6B", "#6D3B7A"]), `<rect width="1280" height="720" fill="url(#g)"/>${blobs([[980, 200, 230, "#F08A5D", 0.55], [260, 520, 260, "#4F46E5", 0.5], [640, 700, 200, "#C084FC", 0.4]])}`),
  },
  {
    kind: "image",
    label: "Studio",
    url: scene(
      `<radialGradient id="g" cx="0.5" cy="0.38" r="0.75"><stop offset="0" stop-color="#EDE7DF"/><stop offset="0.6" stop-color="#CFC6BA"/><stop offset="1" stop-color="#8F877D"/></radialGradient>`,
      `<rect width="1280" height="720" fill="url(#g)"/>${blobs([[640, 240, 260, "#FFF8EE", 0.6], [120, 640, 200, "#7D746A", 0.4], [1160, 640, 200, "#7D746A", 0.4]])}`,
    ),
  },
  {
    kind: "image",
    label: "Lagoon",
    url: scene(linear("g", ["#D6F1F2", "#9AD4D6", "#4D9DB5"], 1, 1), `<rect width="1280" height="720" fill="url(#g)"/>${blobs([[1000, 160, 260, "#E8FBF6", 0.7], [300, 600, 300, "#2E7FA1", 0.45], [640, 360, 160, "#B5EBE0", 0.5]])}`),
  },
  {
    kind: "image",
    label: "Paper",
    url: scene(linear("g", ["#FAF8F4", "#F1EDE6"]), `<rect width="1280" height="720" fill="url(#g)"/>${blobs([[1050, 560, 260, "#E7DFD2", 0.8], [220, 140, 220, "#FFFFFF", 0.9], [540, 640, 160, "#EDE3F2", 0.6]])}`),
  },
];
