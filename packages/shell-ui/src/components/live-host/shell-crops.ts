/**
 * The shell-drawn windows' pictures (docs/live-share.md §6.6): home, notes,
 * the brief, a terminal, a document — windows the shell draws in its own
 * page, which a capture of their tab would show blank. The shell's page is
 * captured once (main's `liveHostShellSource`), and each such window of the
 * shared desk is cut out of every frame of it — its page box alone, in the
 * frame's own pixels — and written to a track of its own (a
 * `MediaStreamTrackGenerator`), published as `win:<id>` like any window.
 *
 * Nothing but a window's own box ever leaves the Mac (§10), and only while
 * nothing of the shell's lies over it. Every frame says which of the shell's
 * desk reports it was painted under: the shell paints the report's number
 * into its corner in the task it sends the report (lib/live/marker.ts), and
 * main sends each report's word on with the desk frame built from it (its
 * windows' page boxes and holds, where it put the stage: `LiveShellMark`).
 * So a frame is cut only:
 * - when its mark reads true off the frame, the page captured at its own
 *   device pixels;
 * - by the word of that very report: where its windows were and which of
 *   them nothing covered (`live`) — a frame painted under a menu is cut by
 *   the report that said the menu was up, however late that word comes, and
 *   one that comes before its word waits for it (the newest such alone);
 * - if its mark is stale (the shell drew a window elsewhere since that
 *   report, its own report kept back), for the windows alone that the word
 *   and the one numbered just before it put in the same place — the shell
 *   reports at once a window of those that moves;
 * - inside the stage and the window's page box (never a pixel beside it,
 *   nor of the mark);
 * - while the latest word lets the window run too (the host away, it is
 *   held whatever the frame says).
 *
 * A held window's track keeps its publication, and its last picture: nothing
 * is cut for it, but the last crop written to it goes out again every
 * CROP_REFRESH_MS — a track of frames has nothing but what is written to it
 * for a guest who starts watching, or whose decoder asks for a whole picture
 * (nothing asks it for one, as an encoder asks a capture), and a held window
 * has nothing new to give. That crop is kept as another handle on it while
 * the window runs, each new one replacing it; once the window is held, its
 * pixels are copied out into memory of their own and the handle let go — a
 * frame of the capture is the whole page, and one of the few the capture can
 * have out at once. A window's crop that changes size goes on at the size it
 * had until the new one has stood a moment (RESIZE_SETTLE_MS: a window being
 * resized changes it every frame, and every new size is a new encoder), then
 * at the new size, the room told (`replaceWindowTrack`, the bitrate follows).
 * A crop longer than `maxSide` is scaled down to it on its way out. A window
 * whose picture runs is given a frame at least every CROP_REFRESH_MS, the
 * capture asked for the page as it is: a still shell repaints nothing, and a
 * guest who starts watching needs a picture. Every frame read is closed;
 * every crop is the track's once written, or closed here; a window's kept
 * picture is closed as the next replaces it, as the window goes, or as this
 * ends. A window's track the room does not take (a publish that timed out, a
 * sender gone with the connection) is asked of it again, slower and slower,
 * and at once when the room is back after a drop (`reconnected`), until it
 * does; a new size asks afresh, and the window leaving or a new room ends the
 * asking.
 *
 * The browser's pieces — main's source id, the capture and its frames, the
 * mark read off a frame, the generators, the cut, the copy — come in as
 * `ShellCropDeps`, so test/live-host-shell-crops.test.ts drives it all
 * without a browser.
 */

import { LIVE_SHELL_MARKS, type LiveShellMark } from "@pistachio/shell-contracts/live-share";
import { MARK_BOX, markAfter, type MarkReading } from "../../lib/live/marker";
import { captureSize, sameCaptureSize, type PixelSize } from "./capture-size";

/** A box in CSS px. */
export interface CropBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A region of a frame, in its pixels (a VideoFrame's `visibleRect`). */
export interface FrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A frame of the shell's capture, as far as this reads it (a WebCodecs `VideoFrame`). */
export interface ShellFrame {
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly visibleRect: FrameRect | null;
  /** Another handle on the same picture (no pixels copied), closed on its own. */
  clone(): this;
  close(): void;
}

/** The shell's page, captured. */
export interface ShellCapture<F extends ShellFrame> {
  /** The next frame (the capture brings one only when the page repaints), or null once it has ended. */
  read(): Promise<F | null>;
  /** Frames of this size from now on (the window was resized). */
  resize(size: PixelSize): Promise<void>;
  /** A frame of the page as it is now, though nothing repainted. */
  refresh(): void;
  stop(): void;
}

/** A window's own picture track. */
export interface CropGenerator<T, F extends ShellFrame> {
  readonly track: T;
  /**
   * Hand it a frame, which is the generator's from then on; null when it
   * cannot take one now (the last is still going), the frame left to the
   * caller. Settles once the frame is on the track.
   */
  write(frame: F): Promise<void> | null;
  stop(): void;
}

/** The room, as far as these windows go (`LiveRoom`). */
export interface CropPublisher<T> {
  replaceWindowTrack(windowId: string, video: T): Promise<void>;
  unpublishWindow(windowId: string): Promise<void>;
}

export interface ShellCropDeps<T, F extends ShellFrame> {
  /** Main's source id for one capture of the shell's page, or null (it allows none now). */
  source(): Promise<string | null>;
  open(sourceId: string, size: PixelSize): Promise<ShellCapture<F>>;
  generator(): CropGenerator<T, F>;
  /** The mark painted in `frame` (lib/live/marker.ts), the content's corner at `origin` (frame px) and `scale` whole frame px a CSS px; null if none reads true. */
  readMark(frame: F, origin: { x: number; y: number }, scale: number): Promise<MarkReading | null>;
  /** `rect` of `frame`, as a frame of its own shown at `size`. */
  cut(frame: F, rect: FrameRect, size: PixelSize): F;
  /** A crop's pixels copied into memory of its own, shown at its size: nothing of the frame it was cut from is kept with it. */
  copy(frame: F): Promise<F>;
  /** The browser window's content box (CSS px; this window lies exactly over it) and the display's device px per CSS px. */
  viewport(): { width: number; height: number; ratio: number };
  /** The longest side a window's picture goes out at. */
  maxSide: number;
  /** The longest side the shell's page is captured at: past it the page is scaled, and no mark reads true off it. */
  captureMaxSide: number;
  now?: () => number;
  later?: (run: () => void, ms: number) => () => void;
  log?: (message: string, error?: unknown) => void;
}

/** A shell-drawn window of the latest desk frame that streams. */
export interface ShellCropWindow {
  id: string;
  /** Its page box in the stage, CSS px. */
  page: CropBox;
  /** Its picture may run: the frame does not hold it. */
  live: boolean;
}

/** A crop of a new size is taken at it once it has stood this long. */
export const RESIZE_SETTLE_MS = 300;
/**
 * A window whose picture runs gets a frame at least this often. The capture
 * brings one only when the page repaints, and a picture track has nothing to
 * give a guest who starts watching, or whose decoder asks for a whole
 * picture, but what is written to it: a still terminal would stay blank for
 * them. So the capture is asked for the page as it is (`refresh`).
 */
export const CROP_REFRESH_MS = 1_000;
/** A frame painted under a report main has not passed on yet waits this long for it, at most. */
export const MARK_WAIT_MS = 1_000;
/** How often whether a refresh is due is looked at, while the shell is captured. */
const REFRESH_CHECK_MS = 250;
/** Reports' words kept: a frame comes a frame or two after its report, never a sixteen. */
const MARKS_KEPT = 16;
/** A frame's sides are within this share of a whole number of the window's: the page captured at its own device pixels. */
const WHOLE_SCALE_SLACK = 0.01;
/** Waits before capturing again after a capture failed, or asking the room again for a track it refused; the last repeats while one is wanted. */
export const RETRY_MS: readonly number[] = [1_000, 3_000, 8_000, 20_000];

/* -------------------------------- geometry -------------------------------- */

/** The even pixel at or after `value` (I420's chroma is a pixel for two: a crop starts on an even one). */
function evenUp(value: number): number {
  return Math.ceil((value - 1e-6) / 2) * 2;
}

function evenDown(value: number): number {
  return Math.floor((value + 1e-6) / 2) * 2;
}

/** Where the window's content lies in a frame: a tab capture fits it in, its shape kept, centred (letterboxed). */
export function contentInFrame(frame: FrameRect, content: { width: number; height: number }): { x: number; y: number; scale: number } | null {
  if (!(content.width > 0) || !(content.height > 0) || !(frame.width > 0) || !(frame.height > 0)) return null;
  const scale = Math.min(frame.width / content.width, frame.height / content.height);
  return { x: frame.x + (frame.width - content.width * scale) / 2, y: frame.y + (frame.height - content.height * scale) / 2, scale };
}

/**
 * The whole frame px a CSS px a frame was captured at — its sides each a
 * whole number of the window's, within a hair (asked at its device pixels
 * rounded to even, Chromium stretches the page that hair to fill it; probed,
 * Electron 43: a 1441 × 901 window at 1× filled a 1442 × 902 frame, its
 * corner's pixels its own) — or null: the page was scaled, or the frame is
 * of another size of the window (being resized).
 */
export function wholeScale(frame: FrameRect, content: { width: number; height: number }): number | null {
  if (!(content.width > 0) || !(content.height > 0)) return null;
  const across = frame.width / content.width;
  const down = frame.height / content.height;
  const whole = Math.round(across);
  if (whole < 1 || Math.abs(across - whole) > WHOLE_SCALE_SLACK * whole || Math.abs(down - whole) > WHOLE_SCALE_SLACK * whole) return null;
  return whole;
}

/**
 * The region of a frame a window's picture is: its page box (stage CSS px)
 * in the window, inside the stage and the content box, in the frame's
 * pixels — the scale read off the frame against the content's size, never
 * assumed — rounded inward to even pixels, so not a pixel of what lies
 * beside it is in it. Null when nothing of it is on the stage.
 */
export function cropRect(frame: FrameRect, content: { width: number; height: number }, stage: CropBox, page: CropBox): FrameRect | null {
  const fit = contentInFrame(frame, content);
  if (fit === null) return null;
  const left = Math.max(stage.x + page.x, stage.x, 0);
  const top = Math.max(stage.y + page.y, stage.y, 0);
  const right = Math.min(stage.x + page.x + page.w, stage.x + stage.w, content.width);
  const bottom = Math.min(stage.y + page.y + page.h, stage.y + stage.h, content.height);
  if (!(right > left) || !(bottom > top)) return null;
  const x0 = Math.max(evenUp(fit.x + left * fit.scale), evenUp(frame.x));
  const y0 = Math.max(evenUp(fit.y + top * fit.scale), evenUp(frame.y));
  const x1 = Math.min(evenDown(fit.x + right * fit.scale), evenDown(frame.x + frame.width));
  const y1 = Math.min(evenDown(fit.y + bottom * fit.scale), evenDown(frame.y + frame.height));
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Whether a crop of a frame takes in any pixel of the mark (its box, a pixel round it, at the content's corner). */
export function cropTakesMark(rect: FrameRect, frame: FrameRect, content: { width: number; height: number }): boolean {
  const fit = contentInFrame(frame, content);
  if (fit === null) return true;
  const right = fit.x + (MARK_BOX.x + MARK_BOX.w + 1) * fit.scale;
  const bottom = fit.y + (MARK_BOX.y + MARK_BOX.h + 1) * fit.scale;
  return rect.x < right && rect.y < bottom && rect.x + rect.width > fit.x - fit.scale && rect.y + rect.height > fit.y - fit.scale;
}

/** The size a crop goes out at: its own, or scaled down to `maxSide` on its longer side, its shape kept. */
export function cropOutput(rect: FrameRect, maxSide: number): PixelSize {
  return captureSize({ w: rect.width, h: rect.height }, 1, maxSide) ?? { width: 2, height: 2 };
}

/** A frame's picture region: its visible rect, or the whole of it. */
function pictureOf(frame: ShellFrame): FrameRect {
  const rect = frame.visibleRect;
  return rect === null ? { x: 0, y: 0, width: frame.codedWidth, height: frame.codedHeight } : { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/* ---------------------------------- crops ---------------------------------- */

interface Entry<T, F extends ShellFrame> {
  readonly id: string;
  readonly generator: CropGenerator<T, F>;
  /** The latest word lets its picture run. */
  live: boolean;
  /** Since when it has (for the refresh): Infinity while held. */
  liveSince: number;
  /** The size its pictures go out at; null before the first. */
  out: PixelSize | null;
  /** The size its crop would go out at now. */
  want: PixelSize | null;
  settle: (() => void) | null;
  /** The size the room was last told of (`replaceWindowTrack`); null while unpublished. */
  told: PixelSize | null;
  /** Bumped as each publication is asked of the room: only the latest's outcome counts. */
  publishing: number;
  /** Publications in a row the room refused. */
  publishFailures: number;
  /** The room refused the window's track: asked again then. */
  republish: (() => void) | null;
  /** The last crop written to its track, to write again while it is held: a copy of its pixels alone once it is (`own`). */
  kept: { frame: F; own: boolean } | null;
  /** While it is held: its kept picture goes out again then. */
  replay: (() => void) | null;
}

/** A report's word, as main passed it on: where it put the stage, in what window, and its shell-drawn windows. */
interface Word {
  stage: CropBox;
  viewport: { width: number; height: number };
  windows: ReadonlyMap<string, { page: CropBox; live: boolean }>;
}

export class ShellCrops<T, F extends ShellFrame> {
  readonly #deps: ShellCropDeps<T, F>;
  readonly #now: () => number;
  readonly #later: (run: () => void, ms: number) => () => void;
  readonly #entries = new Map<string, Entry<T, F>>();
  /** The reports' words by mark, oldest first. */
  readonly #words = new Map<number, Word>();
  #latestMark: number | null = null;
  /** The newest frame painted under a report whose word has not come yet. */
  #waiting: { frame: F; reading: MarkReading; at: number } | null = null;
  #publisher: CropPublisher<T> | null = null;
  /** Where the stage lies in this window while the host is on it; null: nothing is captured. */
  #stage: CropBox | null = null;
  #viewport: { width: number; height: number; ratio: number } | null = null;
  #capture: ShellCapture<F> | null = null;
  /** Bumped whenever a capture is let go: an opening or a read of an older one finds it stale. */
  #generation = 0;
  #opening = false;
  #failures = 0;
  #retry: (() => void) | null = null;
  /** When the capture last brought a frame. */
  #lastFrameAt = Number.NEGATIVE_INFINITY;
  #refreshTimer: (() => void) | null = null;
  /** Frames no mark read true off, since one last did: said once a run. */
  #unmarked = 0;
  #disposed = false;

  constructor(deps: ShellCropDeps<T, F>) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => performance.now());
    this.#later =
      deps.later ??
      ((run, ms) => {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      });
  }

  /**
   * The shell-drawn windows that stream now, where the stage lies in the
   * window (null: the host is away, the shell shows another space — nothing
   * is captured), and the shell's mark the frame they come in was built
   * under (`shell`). Any other window is let go and unpublished. Called
   * again as the browser window resizes: the viewport is read here.
   */
  update(input: { windows: readonly ShellCropWindow[]; stage: CropBox | null; shell: LiveShellMark | null }): void {
    if (this.#disposed) return;
    const now = this.#now();
    const viewport = this.#deps.viewport();
    if (!sameViewport(this.#viewport, viewport) && this.#capture !== null) this.#resizeCapture(viewport);
    this.#stage = input.stage === null ? null : { ...input.stage };
    this.#viewport = viewport;
    const listed = new Set<string>();
    for (const window of input.windows) {
      listed.add(window.id);
      const entry = this.#entries.get(window.id);
      const live = window.live && input.stage !== null;
      if (entry === undefined) {
        this.#entries.set(window.id, { id: window.id, generator: this.#deps.generator(), live, liveSince: live ? now : Infinity, out: null, want: null, settle: null, told: null, publishing: 0, publishFailures: 0, republish: null, kept: null, replay: null });
        continue;
      }
      if (!live) entry.liveSince = Infinity;
      else if (!entry.live) entry.liveSince = now;
      entry.live = live;
      this.#replayWhileHeld(entry);
    }
    for (const entry of [...this.#entries.values()]) if (!listed.has(entry.id)) this.#drop(entry);
    if (input.shell !== null) this.#heard(input.shell, input.windows);
    this.#follow();
  }

  /** The room to publish to (a new one after the last ended), or null while there is none. */
  setPublisher(publisher: CropPublisher<T> | null): void {
    this.#publisher = publisher;
    for (const entry of this.#entries.values()) {
      // (What the last room refused is nothing to a new one, which is handed every track afresh.)
      this.#clearRepublish(entry);
      entry.publishFailures = 0;
      if (publisher !== null && entry.told !== null) this.#publish(entry);
    }
  }

  /**
   * The room is connected again after a drop (LiveKit resumed it, or it
   * joined afresh): every window with a picture is asked of it now — one it
   * refused meanwhile, or could not publish again after joining, goes out; one
   * it has is only told its size again.
   */
  reconnected(): void {
    if (this.#disposed || this.#publisher === null) return;
    for (const entry of this.#entries.values()) {
      if (entry.told === null) continue;
      entry.publishFailures = 0;
      this.#publish(entry);
    }
  }

  /** The shell's page is captured now. */
  capturing(): boolean {
    return this.#capture !== null;
  }

  /** Stop: no capture, no track; nothing is published or cut after. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#stopCapture();
    this.#retry?.();
    this.#retry = null;
    for (const entry of this.#entries.values()) this.#release(entry);
    this.#entries.clear();
    this.#words.clear();
  }

  /* --------------------------------- the words --------------------------------- */

  /** A report's word: kept by its mark (the newest of it, as main may say it again), and a frame that waited for it cut by it. */
  #heard(shell: LiveShellMark, windows: readonly ShellCropWindow[]): void {
    const latest = this.#latestMark;
    // Counting began again (a shell whose count was lost): no word from before can stand for a frame from now.
    if (latest !== null && shell.mark !== latest && !markAfter(shell.mark, latest)) this.#words.clear();
    this.#words.delete(shell.mark);
    this.#words.set(shell.mark, {
      stage: { ...shell.stage },
      viewport: { width: shell.viewport.w, height: shell.viewport.h },
      windows: new Map(windows.map((window) => [window.id, { page: { ...window.page }, live: window.live }])),
    });
    while (this.#words.size > MARKS_KEPT) this.#words.delete(this.#words.keys().next().value!);
    this.#latestMark = shell.mark;
    const waiting = this.#waiting;
    if (waiting === null) return;
    if (waiting.reading.mark === shell.mark) {
      this.#waiting = null;
      this.#cut(waiting.frame, waiting.reading);
    } else if (!markAfter(waiting.reading.mark, shell.mark)) {
      // (A report main passed over: its word will not come.)
      this.#waiting = null;
      waiting.frame.close();
    }
  }

  /* -------------------------------- the capture -------------------------------- */

  /** A capture while a window streams and the host is on the space; none otherwise. */
  #follow(): void {
    const wanted = !this.#disposed && this.#entries.size > 0 && this.#stage !== null;
    if (!wanted) {
      this.#stopCapture();
      this.#retry?.();
      this.#retry = null;
      this.#failures = 0;
      return;
    }
    if (this.#capture === null && !this.#opening && this.#retry === null) void this.#open();
  }

  async #open(): Promise<void> {
    const generation = this.#generation;
    const viewport = this.#viewport ?? this.#deps.viewport();
    const size = captureSize({ w: viewport.width, h: viewport.height }, viewport.ratio, this.#deps.captureMaxSide);
    if (size === null) return;
    this.#opening = true;
    let capture: ShellCapture<F>;
    try {
      const sourceId = await this.#deps.source();
      if (sourceId === null) throw new Error("main handed over no capture of the shell");
      capture = await this.#deps.open(sourceId, size);
    } catch (error) {
      this.#opening = false;
      // (One let go while it opened kept a desk that wants a capture again meanwhile from opening its own: it opens now.)
      if (generation === this.#generation) this.#failed(error);
      else this.#follow();
      return;
    }
    this.#opening = false;
    const stillWanted = generation === this.#generation && !this.#disposed && this.#entries.size > 0 && this.#stage !== null;
    if (!stillWanted) {
      capture.stop();
      this.#follow();
      return;
    }
    this.#capture = capture;
    // (The window may have been resized while this opened.)
    const now = this.#deps.viewport();
    if (!sameViewport(viewport, now)) this.#resizeCapture(now);
    this.#scheduleRefresh();
    void this.#pump(capture, generation);
  }

  #scheduleRefresh(): void {
    this.#refreshTimer?.();
    this.#refreshTimer = this.#later(() => {
      this.#refreshTimer = null;
      if (this.#capture === null) return;
      this.#expireWaiting();
      this.#refreshIfDue();
      this.#scheduleRefresh();
    }, REFRESH_CHECK_MS);
  }

  /** A window may run and has had no frame since it could, or none for CROP_REFRESH_MS: the page as it is, please. */
  #refreshIfDue(): void {
    const now = this.#now();
    for (const entry of this.#entries.values()) {
      if (!entry.live) continue;
      if (this.#lastFrameAt < entry.liveSince || now - this.#lastFrameAt >= CROP_REFRESH_MS) {
        this.#capture?.refresh();
        // (Counted as a frame: the next ask waits its turn, whatever comes of this one.)
        this.#lastFrameAt = now;
        return;
      }
    }
  }

  /** A frame that waited MARK_WAIT_MS for its word is let go: main is far behind, and the next frames will do. */
  #expireWaiting(): void {
    const waiting = this.#waiting;
    if (waiting === null || this.#now() - waiting.at < MARK_WAIT_MS) return;
    this.#waiting = null;
    waiting.frame.close();
  }

  async #pump(capture: ShellCapture<F>, generation: number): Promise<void> {
    const openedAt = this.#now();
    for (;;) {
      let frame: F | null;
      try {
        frame = await capture.read();
      } catch (error) {
        this.#log("the shell's capture failed", error);
        frame = null;
      }
      if (frame === null) break;
      if (generation !== this.#generation || this.#disposed) {
        frame.close();
        return;
      }
      this.#failures = 0;
      await this.#take(frame, generation);
    }
    if (generation !== this.#generation || this.#disposed) return;
    // Ended under it (its page went, the source was taken back): capture again, unless that keeps failing.
    this.#stopCapture();
    if (this.#now() - openedAt < 2_000) this.#failed(new Error("the shell's capture ended as soon as it began"));
    else this.#follow();
  }

  #resizeCapture(viewport: { width: number; height: number; ratio: number }): void {
    const capture = this.#capture;
    const size = captureSize({ w: viewport.width, h: viewport.height }, viewport.ratio, this.#deps.captureMaxSide);
    if (capture === null || size === null) return;
    void capture.resize(size).catch((error: unknown) => {
      // One that will not resize is captured afresh, at the new size.
      this.#log("could not resize the shell's capture; capturing it again", error);
      if (this.#capture !== capture) return;
      this.#stopCapture();
      this.#follow();
    });
  }

  #failed(error: unknown): void {
    this.#failures += 1;
    const wait = RETRY_MS[Math.min(this.#failures, RETRY_MS.length) - 1] ?? 20_000;
    if (this.#failures <= RETRY_MS.length) this.#log("could not capture the shell; trying again", error);
    this.#retry?.();
    this.#retry = this.#later(() => {
      this.#retry = null;
      this.#follow();
    }, wait);
  }

  #stopCapture(): void {
    this.#generation += 1;
    const capture = this.#capture;
    this.#capture = null;
    capture?.stop();
    this.#waiting?.frame.close();
    this.#waiting = null;
    this.#refreshTimer?.();
    this.#refreshTimer = null;
    this.#lastFrameAt = Number.NEGATIVE_INFINITY;
  }

  /* ---------------------------------- cutting ---------------------------------- */

  /** A frame came: the mark painted in it, and it is cut by that report's word — now, once the word comes, or never. */
  async #take(frame: F, generation: number): Promise<void> {
    this.#lastFrameAt = this.#now();
    const viewport = this.#viewport;
    if (this.#stage === null || viewport === null) {
      frame.close();
      return;
    }
    const picture = pictureOf(frame);
    const scale = wholeScale(picture, viewport);
    let reading: MarkReading | null = null;
    if (scale !== null) {
      try {
        reading = await this.#deps.readMark(frame, { x: picture.x, y: picture.y }, scale);
      } catch (error) {
        this.#log("could not read the shell's mark", error);
      }
    }
    if (generation !== this.#generation || this.#disposed) {
      frame.close();
      return;
    }
    if (reading === null) {
      // (Its page scaled, or the window being resized, or no mark painted yet: nothing in it can be vouched for.)
      if (this.#unmarked++ === 0) this.#log("a frame of the shell bore no mark that reads true: none is cut until one does");
      frame.close();
      return;
    }
    this.#unmarked = 0;
    if (this.#words.has(reading.mark)) {
      this.#cut(frame, reading);
      return;
    }
    // Painted under a report whose word main has not passed on yet: it waits for it, the newest such frame alone —
    // but a fresh one waiting is worth more than a stale one of the same report after it (it is cut for every window).
    if (this.#latestMark === null || markAfter(reading.mark, this.#latestMark)) {
      const waiting = this.#waiting;
      if (waiting !== null && waiting.reading.mark === reading.mark && !waiting.reading.stale && reading.stale) {
        frame.close();
        return;
      }
      waiting?.frame.close();
      this.#waiting = { frame, reading, at: this.#now() };
      return;
    }
    frame.close();
  }

  /**
   * Each window the word of the frame's report lets run, that runs still,
   * cut out of the frame where the word put it — of a frame whose mark is
   * stale, only those the word numbered just before put in the same place
   * (none, if main passed that word over).
   */
  #cut(frame: F, reading: MarkReading): void {
    const word = this.#words.get(reading.mark)!;
    const before = reading.stale ? (this.#words.get((reading.mark + LIVE_SHELL_MARKS - 1) % LIVE_SHELL_MARKS) ?? null) : null;
    const picture = pictureOf(frame);
    for (const [id, window] of word.windows) {
      const entry = this.#entries.get(id);
      if (entry === undefined || !entry.live || !window.live) continue;
      if (reading.stale && !sameBox(before?.windows.get(id)?.page ?? null, window.page)) continue;
      const rect = cropRect(picture, word.viewport, word.stage, window.page);
      if (rect === null || cropTakesMark(rect, picture, word.viewport)) continue;
      this.#emit(entry, frame, rect);
    }
    frame.close();
  }

  #emit(entry: Entry<T, F>, frame: F, rect: FrameRect): void {
    const size = this.#outputFor(entry, cropOutput(rect, this.#deps.maxSide));
    let piece: F;
    try {
      piece = this.#deps.cut(frame, rect, size);
    } catch (error) {
      this.#log(`could not cut ${entry.id} out of the shell's picture`, error);
      return;
    }
    // (Taken before it is written: the generator closes what it takes.)
    const kept = piece.clone();
    const written = entry.generator.write(piece);
    if (written === null) {
      piece.close();
      kept.close();
      return;
    }
    entry.kept?.frame.close();
    entry.kept = { frame: kept, own: false };
    written.catch((error: unknown) => {
      piece.close();
      this.#log(`could not write ${entry.id}'s picture`, error);
    });
    // A first picture, or one of a new size: the room publishes it, or sets the bitrate for it, once it is on the track.
    if (entry.told === null || !sameCaptureSize(entry.told, size)) {
      entry.told = size;
      void written.then(
        () => {
          if (this.#entries.get(entry.id) === entry && entry.told === size) this.#publish(entry);
        },
        () => undefined,
      );
    }
  }

  /** The size a window's picture goes out at: what it had, until a new size has stood RESIZE_SETTLE_MS. */
  #outputFor(entry: Entry<T, F>, want: PixelSize): PixelSize {
    const wanted = entry.want;
    entry.want = want;
    if (entry.out === null) {
      entry.out = want;
      return want;
    }
    if (sameCaptureSize(entry.out, want)) {
      entry.settle?.();
      entry.settle = null;
      return entry.out;
    }
    // (The size it is settling on, again: it has stood since it was first asked, however many frames came since.)
    if (entry.settle !== null && wanted !== null && sameCaptureSize(wanted, want)) return entry.out;
    entry.settle?.();
    entry.settle = this.#later(() => {
      entry.settle = null;
      if (entry.want !== null) entry.out = entry.want;
    }, RESIZE_SETTLE_MS);
    return entry.out;
  }

  /* ------------------------------- a held window ------------------------------- */

  /**
   * While a window is held, its kept picture goes out again every
   * CROP_REFRESH_MS — copied out of the capture's frame first — and nothing
   * else: a guest who starts watching it meanwhile has its last picture, and
   * not a pixel of what holds it. Once it runs, its pictures are cut again.
   */
  #replayWhileHeld(entry: Entry<T, F>): void {
    if (entry.live || entry.kept === null) {
      entry.replay?.();
      entry.replay = null;
      return;
    }
    if (entry.replay !== null) return;
    // (Copied once a hold: one that could not be keeps its handle, and goes out all the same.)
    this.#ownKept(entry);
    const again = (): void => {
      entry.replay = null;
      if (this.#entries.get(entry.id) !== entry || entry.live) return;
      this.#writeKept(entry);
      entry.replay = this.#later(again, CROP_REFRESH_MS);
    };
    entry.replay = this.#later(again, CROP_REFRESH_MS);
  }

  /** The kept crop's pixels in memory of their own, its handle on the capture's frame let go: a window may be held for long. */
  #ownKept(entry: Entry<T, F>): void {
    const kept = entry.kept;
    if (kept === null || kept.own) return;
    this.#deps.copy(kept.frame).then(
      (copy) => {
        // (Replaced meanwhile — the window ran again, or went: the copy is nothing now.)
        if (entry.kept !== kept) {
          copy.close();
          return;
        }
        entry.kept = { frame: copy, own: true };
        kept.frame.close();
      },
      (error: unknown) => {
        if (entry.kept === kept) this.#log(`could not copy ${entry.id}'s last picture; keeping it as it is`, error);
      },
    );
  }

  /** The kept picture on the window's track again (another handle on it: the generator closes what it takes). */
  #writeKept(entry: Entry<T, F>): void {
    if (entry.kept === null) return;
    const piece = entry.kept.frame.clone();
    const written = entry.generator.write(piece);
    if (written === null) {
      piece.close();
      return;
    }
    written.catch((error: unknown) => {
      piece.close();
      this.#log(`could not write ${entry.id}'s picture`, error);
    });
  }

  /* --------------------------------- publishing -------------------------------- */

  /** The window's track is published, or the room told its size: asked again until the room takes it. */
  #publish(entry: Entry<T, F>): void {
    const publisher = this.#publisher;
    if (publisher === null) return;
    this.#clearRepublish(entry);
    entry.publishing += 1;
    const attempt = entry.publishing;
    publisher.replaceWindowTrack(entry.id, entry.generator.track).then(
      () => {
        if (entry.publishing === attempt) entry.publishFailures = 0;
      },
      (error: unknown) => {
        // (Asked again since, for a new size or by a new room, or the window gone: that one answers.)
        if (entry.publishing === attempt && this.#publisher === publisher && this.#entries.get(entry.id) === entry) this.#publishFailed(entry, error);
      },
    );
  }

  /** The room refused the window's track: asked again, slower and slower, for as long as the window streams. */
  #publishFailed(entry: Entry<T, F>, error: unknown): void {
    entry.publishFailures += 1;
    const wait = RETRY_MS[Math.min(entry.publishFailures, RETRY_MS.length) - 1] ?? 20_000;
    if (entry.publishFailures <= RETRY_MS.length) this.#log(`could not publish ${entry.id}; trying again`, error);
    entry.republish = this.#later(() => {
      entry.republish = null;
      if (this.#entries.get(entry.id) === entry) this.#publish(entry);
    }, wait);
  }

  #drop(entry: Entry<T, F>): void {
    this.#entries.delete(entry.id);
    const published = entry.told !== null;
    this.#release(entry);
    if (published) void this.#publisher?.unpublishWindow(entry.id).catch((error: unknown) => this.#log(`could not unpublish ${entry.id}`, error));
  }

  #release(entry: Entry<T, F>): void {
    entry.settle?.();
    entry.settle = null;
    entry.replay?.();
    entry.replay = null;
    entry.kept?.frame.close();
    entry.kept = null;
    this.#clearRepublish(entry);
    entry.generator.stop();
  }

  #clearRepublish(entry: Entry<T, F>): void {
    entry.republish?.();
    entry.republish = null;
  }

  #log(message: string, error?: unknown): void {
    (this.#deps.log ?? ((text: string, cause?: unknown) => console.warn(`[live-host] ${text}`, cause)))(message, error);
  }
}

function sameBox(a: CropBox | null, b: CropBox): boolean {
  return a !== null && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

function sameViewport(a: { width: number; height: number; ratio: number } | null, b: { width: number; height: number; ratio: number }): boolean {
  return a !== null && a.width === b.width && a.height === b.height && a.ratio === b.ratio;
}
