/**
 * The shared windows' pictures (docs/live-share.md §3, §6.3): for every
 * window the latest desk frame streams, one capture of its tab, published to
 * the room as `win:<id>`; a window that leaves the frame is unpublished and
 * its capture stopped.
 *
 * Captures are taken one at a time (main hands out one source id at a time,
 * and each `getUserMedia` of a tab is a round trip through the browser
 * process), and every track this owns is stopped on every path — a window
 * gone, replaced, ended, the room gone — since the room never stops a
 * window's track itself (`stopLocalTrackOnUnpublish: false`).
 *
 * A window streaming keeps its publication whatever happens to its
 * picture, so guests never lose it (unpublishing and publishing again left
 * them a blank window, for a second or for good): a page box that changes
 * size is settled first (300 ms, a window being dragged larger changes it
 * every frame), then its track is resized in place and the room told, which
 * sets the bitrate for the new size (capture-size.ts); a track that ends
 * (its page replaced, the tab gone), or a window main says has a new page,
 * is captured again and the fresh track swapped in on the same publication
 * (`replaceWindowTrack`). A capture whose first frame never comes (a page
 * never laid out) is reported.
 *
 * A picture the room does not take (a publish that timed out, a sender gone
 * with the connection) is asked of it again, slower and slower (RETRY_MS),
 * and at once when the room is back after a drop (`reconnected`), until it
 * does: nothing else would ask, and guests would keep a blank or frozen
 * window. A new capture asks afresh; the window leaving, its track ending or
 * a new room ends the asking.
 *
 * The browser's pieces — main's source ids, `getUserMedia`, the first-frame
 * watch, the room — come in as `WindowCaptureDeps` and `WindowPublisher`, so
 * test/live-host-captures.test.ts drives it all without a browser.
 */

import { captureSize, sameCaptureSize, type PixelSize } from "./capture-size";

/** What this needs of a capture's track. */
export type CaptureTrack = Pick<MediaStreamTrack, "stop" | "applyConstraints" | "addEventListener" | "removeEventListener">;

/** A window to stream: its id and its page box (CSS px). */
export interface CaptureWindow {
  id: string;
  page: { w: number; h: number };
}

/** The room, as far as windows go (`LiveRoom.replaceWindowTrack` / `unpublishWindow`). */
export interface WindowPublisher<T extends CaptureTrack> {
  /** The window's picture is this track now (a fresh capture, or the same one resized), its publication kept; published if it has none. */
  replaceWindowTrack(windowId: string, video: T): Promise<void>;
  unpublishWindow(windowId: string): Promise<void>;
}

export interface WindowCaptureDeps<T extends CaptureTrack> {
  /** A tab source id for one capture of this window's page (main's `liveHostSource`), or null. */
  source(windowId: string): Promise<string | null>;
  /** Open a capture of that source at `size`. */
  open(sourceId: string, size: PixelSize): Promise<T>;
  /** Whether the track's first frame came within `ms`. */
  firstFrame(track: T, ms: number): Promise<boolean>;
  /** A capture brought no picture: its page may never have been laid out. */
  stalled(windowId: string): void;
  /** The display's device pixels per CSS px. */
  pixelRatio(): number;
  /** The longest side a capture may have (`WINDOW_CAPTURE_MAX_SIDE`). */
  maxSide: number;
  now?: () => number;
  log?: (message: string, error?: unknown) => void;
}

/** A page box that changed size is captured at its new size once it has stood this long. */
export const RESIZE_SETTLE_MS = 300;
/** A capture whose first frame takes longer than this is reported. */
export const FIRST_FRAME_MS = 4_000;
/**
 * Waits before trying a failed capture, or a publication the room refused,
 * again; the last repeats for as long as the window streams (a page that could
 * not be captured may come right: woken, laid out, its source handed out
 * again; a room's connection comes back).
 */
export const RETRY_MS: readonly number[] = [1_000, 3_000, 8_000, 20_000];
/** A track that ends sooner than this after it opened failed, as far as retrying goes. */
const SHORT_LIVED_MS = 2_000;

interface Entry<T> {
  readonly id: string;
  /** The size the page wants now; null while its box has no area. */
  want: PixelSize | null;
  track: T | null;
  /** The size `track` gives. */
  size: PixelSize | null;
  openedAt: number;
  onEnded: (() => void) | null;
  /** The track must be replaced whatever its size (a new page, the old track ended). */
  stale: boolean;
  /** Failed captures in a row; at RETRY_MS.length the window is struggling (see #failed). */
  failures: number;
  /** A capture of it is being taken now. */
  capturing: boolean;
  settle: ReturnType<typeof setTimeout> | null;
  retry: ReturnType<typeof setTimeout> | null;
  /** Bumped as each publication is asked of the room: only the latest's outcome counts. */
  publishing: number;
  /** Publications in a row the room refused. */
  publishFailures: number;
  /** The room refused the window's picture: asked again then. */
  republish: ReturnType<typeof setTimeout> | null;
}

export class WindowCaptures<T extends CaptureTrack = MediaStreamTrack> {
  readonly #deps: WindowCaptureDeps<T>;
  readonly #now: () => number;
  readonly #entries = new Map<string, Entry<T>>();
  /** Windows waiting for a capture, first come first served. */
  readonly #queue: string[] = [];
  #running = false;
  #publisher: WindowPublisher<T> | null = null;
  #disposed = false;

  constructor(deps: WindowCaptureDeps<T>) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => performance.now());
  }

  /** The windows that stream now; any other is unpublished and let go. */
  update(windows: readonly CaptureWindow[]): void {
    if (this.#disposed) return;
    const ratio = this.#deps.pixelRatio();
    const listed = new Set<string>();
    for (const window of windows) {
      listed.add(window.id);
      const want = captureSize(window.page, ratio, this.#deps.maxSide);
      const entry = this.#entries.get(window.id);
      if (entry === undefined) {
        const fresh: Entry<T> = { id: window.id, want, track: null, size: null, openedAt: 0, onEnded: null, stale: false, failures: 0, capturing: false, settle: null, retry: null, publishing: 0, publishFailures: 0, republish: null };
        this.#entries.set(window.id, fresh);
        if (want !== null) this.#enqueue(fresh);
        continue;
      }
      entry.want = want;
      this.#follow(entry);
    }
    for (const entry of [...this.#entries.values()]) {
      if (!listed.has(entry.id)) this.#drop(entry);
    }
  }

  /** The window's page is a new one (woken, back from a crash): capture it again. */
  recapture(windowId: string): void {
    const entry = this.#entries.get(windowId);
    if (entry === undefined || this.#disposed) return;
    entry.stale = true;
    entry.failures = 0;
    this.#clearRetry(entry);
    this.#enqueue(entry);
  }

  /** The room to publish to (a new one after the last ended), or null while there is none. */
  setPublisher(publisher: WindowPublisher<T> | null): void {
    this.#publisher = publisher;
    for (const entry of this.#entries.values()) {
      // (What the last room refused is nothing to a new one, which is handed every picture afresh.)
      this.#clearRepublish(entry);
      entry.publishFailures = 0;
      if (publisher !== null && entry.track !== null) void this.#publish(entry, entry.track);
    }
  }

  /**
   * The room is connected again after a drop (LiveKit resumed it, or it
   * joined afresh): every window's picture is asked of it now — one it
   * refused meanwhile, or could not publish again after joining, goes out; one
   * it has is only told its size again.
   */
  reconnected(): void {
    if (this.#disposed || this.#publisher === null) return;
    for (const entry of this.#entries.values()) {
      if (entry.track === null) continue;
      entry.publishFailures = 0;
      void this.#publish(entry, entry.track);
    }
  }

  /** The windows with a capture now (for the overlay and the specs). */
  captured(): string[] {
    return [...this.#entries.values()].filter((entry) => entry.track !== null).map((entry) => entry.id);
  }

  /** Stop every capture; nothing is published or captured after. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#queue.length = 0;
    for (const entry of this.#entries.values()) this.#release(entry);
    this.#entries.clear();
  }

  /* --------------------------------- resizing --------------------------------- */

  /** The page's wanted size changed (or not): settle, then resize the capture in place. */
  #follow(entry: Entry<T>): void {
    const want = entry.want;
    if (want === null) return;
    if (entry.track === null || entry.size === null) {
      // Not captured yet: one is on its way unless none is queued, running or waiting to be tried again.
      if (!entry.capturing && entry.retry === null) this.#enqueue(entry);
      return;
    }
    if (sameCaptureSize(entry.size, want)) {
      this.#clearSettle(entry);
      return;
    }
    if (entry.settle !== null) clearTimeout(entry.settle);
    entry.settle = setTimeout(() => {
      entry.settle = null;
      if (!this.#current(entry) || entry.track === null || entry.size === null || entry.want === null) return;
      if (!sameCaptureSize(entry.size, entry.want)) void this.#resize(entry, entry.track, entry.want);
    }, RESIZE_SETTLE_MS);
  }

  /** The same track at a new size, and the room told so (the bitrate follows); a track that will not resize is captured again. */
  async #resize(entry: Entry<T>, track: T, size: PixelSize): Promise<void> {
    try {
      await track.applyConstraints({ width: size.width, height: size.height });
    } catch (error) {
      this.#log(`could not resize the capture of ${entry.id}; capturing it again`, error);
      if (this.#current(entry) && entry.track === track) this.#enqueue(entry);
      return;
    }
    if (!this.#current(entry) || entry.track !== track) return;
    entry.size = size;
    await this.#publish(entry, track);
  }

  /* --------------------------------- capturing -------------------------------- */

  #enqueue(entry: Entry<T>): void {
    if (this.#disposed || this.#queue.includes(entry.id)) return;
    this.#queue.push(entry.id);
    void this.#pump();
  }

  async #pump(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      for (let id = this.#queue.shift(); id !== undefined; id = this.#queue.shift()) {
        const entry = this.#entries.get(id);
        if (entry !== undefined) await this.#capture(entry);
      }
    } finally {
      this.#running = false;
    }
  }

  async #capture(entry: Entry<T>): Promise<void> {
    const want = entry.want;
    if (want === null) return;
    // Asked twice while one ran: the first already brought what the second wanted.
    if (!entry.stale && entry.track !== null && entry.size !== null && sameCaptureSize(entry.size, want)) return;
    // (Cleared while this one runs, so a new page meanwhile asks for another after it.)
    const replacing = entry.stale;
    entry.stale = false;
    entry.capturing = true;
    let track: T;
    try {
      const sourceId = await this.#deps.source(entry.id);
      if (!this.#current(entry)) return;
      if (sourceId === null) throw new Error("main handed over no capture of this window");
      track = await this.#deps.open(sourceId, want);
    } catch (error) {
      if (!this.#current(entry)) return;
      // The track it was to replace is still the window's, at the size: the retry must replace it all the same.
      entry.stale ||= replacing;
      this.#failed(entry, error);
      return;
    } finally {
      entry.capturing = false;
    }
    if (!this.#current(entry)) {
      track.stop();
      return;
    }
    await this.#install(entry, track, want);
  }

  /** The new capture becomes the window's: swapped in on its publication, the old one stopped. */
  async #install(entry: Entry<T>, track: T, size: PixelSize): Promise<void> {
    const previous = entry.track;
    if (previous !== null && entry.onEnded !== null) previous.removeEventListener("ended", entry.onEnded);
    const onEnded = (): void => this.#ended(entry, track);
    track.addEventListener("ended", onEnded);
    entry.track = track;
    entry.size = size;
    entry.onEnded = onEnded;
    entry.openedAt = this.#now();
    entry.failures = 0;
    this.#clearRetry(entry);
    void this.#watchFirstFrame(entry, track);
    await this.#publish(entry, track);
    // (The room has the new track by now; the old one shows nothing anywhere.)
    previous?.stop();
    // The page may have changed size again while this was captured.
    if (this.#current(entry) && entry.track === track) this.#follow(entry);
  }

  /** The window's picture is `track` now: on its publication, published if it has none yet — asked again until the room takes it. */
  async #publish(entry: Entry<T>, track: T): Promise<void> {
    const publisher = this.#publisher;
    if (publisher === null) return;
    this.#clearRepublish(entry);
    entry.publishing += 1;
    const attempt = entry.publishing;
    try {
      await publisher.replaceWindowTrack(entry.id, track);
      if (entry.publishing === attempt) entry.publishFailures = 0;
    } catch (error) {
      // (Asked again since, by a new capture, a resize or a new room, or the window gone: that one answers.)
      if (entry.publishing === attempt && this.#publisher === publisher && this.#current(entry) && entry.track === track) this.#publishFailed(entry, error);
    }
  }

  /** The room refused the window's picture: asked again, slower and slower, for as long as the window streams. */
  #publishFailed(entry: Entry<T>, error: unknown): void {
    entry.publishFailures += 1;
    const wait = RETRY_MS[Math.min(entry.publishFailures, RETRY_MS.length) - 1] ?? 20_000;
    if (entry.publishFailures < RETRY_MS.length) this.#log(`could not publish ${entry.id}; trying again`, error);
    else if (entry.publishFailures === RETRY_MS.length) this.#log(`still cannot publish ${entry.id}; trying every ${String(wait / 1000)} s`, error);
    entry.republish = setTimeout(() => {
      entry.republish = null;
      if (this.#current(entry) && entry.track !== null) void this.#publish(entry, entry.track);
    }, wait);
  }

  async #watchFirstFrame(entry: Entry<T>, track: T): Promise<void> {
    const came = await this.#deps.firstFrame(track, FIRST_FRAME_MS).catch(() => true);
    if (!came && this.#current(entry) && entry.track === track) this.#deps.stalled(entry.id);
  }

  /** The window's track ended under it (its page went): capture it again, unless that keeps failing. */
  #ended(entry: Entry<T>, track: T): void {
    if (!this.#current(entry) || entry.track !== track) return;
    if (entry.onEnded !== null) track.removeEventListener("ended", entry.onEnded);
    entry.track = null;
    entry.size = null;
    entry.onEnded = null;
    track.stop();
    // (A picture gone is asked of the room no more: the next capture is.)
    this.#clearRepublish(entry);
    if (this.#now() - entry.openedAt < SHORT_LIVED_MS) {
      this.#failed(entry, new Error("the capture ended as soon as it began"));
      return;
    }
    entry.failures = 0;
    this.#enqueue(entry);
  }

  #failed(entry: Entry<T>, error: unknown): void {
    entry.failures += 1;
    const wait = RETRY_MS[Math.min(entry.failures, RETRY_MS.length) - 1] ?? 20_000;
    if (entry.failures === RETRY_MS.length) {
      this.#log(`still cannot capture ${entry.id}; trying every ${String(wait / 1000)} s`, error);
      // A window with no picture is not left showing its last one.
      if (entry.track === null) void this.#publisher?.unpublishWindow(entry.id).catch((cause: unknown) => this.#log(`could not unpublish ${entry.id}`, cause));
    } else if (entry.failures < RETRY_MS.length) {
      this.#log(`could not capture ${entry.id}; trying again`, error);
    }
    this.#clearRetry(entry);
    entry.retry = setTimeout(() => {
      entry.retry = null;
      if (this.#current(entry)) this.#enqueue(entry);
    }, wait);
  }

  /* --------------------------------- letting go -------------------------------- */

  #drop(entry: Entry<T>): void {
    this.#entries.delete(entry.id);
    const queued = this.#queue.indexOf(entry.id);
    if (queued !== -1) this.#queue.splice(queued, 1);
    this.#release(entry);
    // Track or not: one that ended (its fresh capture still to come) is still the room's, which would publish it again joining afresh.
    void this.#publisher?.unpublishWindow(entry.id).catch((error: unknown) => this.#log(`could not unpublish ${entry.id}`, error));
  }

  #release(entry: Entry<T>): void {
    this.#clearSettle(entry);
    this.#clearRetry(entry);
    this.#clearRepublish(entry);
    if (entry.track !== null) {
      if (entry.onEnded !== null) entry.track.removeEventListener("ended", entry.onEnded);
      entry.track.stop();
    }
    entry.track = null;
    entry.size = null;
    entry.onEnded = null;
  }

  #clearSettle(entry: Entry<T>): void {
    if (entry.settle !== null) clearTimeout(entry.settle);
    entry.settle = null;
  }

  #clearRetry(entry: Entry<T>): void {
    if (entry.retry !== null) clearTimeout(entry.retry);
    entry.retry = null;
  }

  #clearRepublish(entry: Entry<T>): void {
    if (entry.republish !== null) clearTimeout(entry.republish);
    entry.republish = null;
  }

  #current(entry: Entry<T>): boolean {
    return !this.#disposed && this.#entries.get(entry.id) === entry;
  }

  #log(message: string, error?: unknown): void {
    (this.#deps.log ?? ((text: string, cause?: unknown) => console.warn(`[live-host] ${text}`, cause)))(message, error);
  }
}
