/**
 * A recording session (docs/recorder.md §3): the tab's capture, the mic and
 * the camera encoded as they arrive into their own fragmented MP4s, the
 * events beside them, the holds, the status pill; then the files finalized,
 * the thumbnail, `project.json`. One session records once; `main.ts` keeps at
 * most one alive.
 *
 *   counting   — the capture is already running (started with the countdown,
 *                so the page's switch to device-pixel ratio 2 is never
 *                recorded), its frames dropped; the pill counts 3 · 2 · 1
 *   recording  — the screen encoder takes frames from the next on; t0 is
 *                that frame
 *   paused     — frames and chunks dropped; the media time leaves the gap out
 *   finalizing — every output finalized, thumb.jpg, project.json
 *
 * The recording follows the person (§2): what is captured is a *feed* — a
 * tab's capture, its input subscription and its hold — and when another page
 * comes in front (`tabs.onActivated`) a feed of it is opened, its first frame
 * takes over the picture and its sound the mixer, and the old feed is let
 * go (`Follow`). One `screen.mp4` holds it all; the new tab's input says
 * where its view is and what page it shows (a `box`, a `nav`), so the clip's
 * chapters and zooms follow too. A shell page in front — Home, the notes, an
 * extension's page — is never recorded: the last picture holds until a page
 * is in front again.
 *
 * The API comes in as `api` (the global `pistachio` in the worker, a fake in
 * the probe) so the session never reads a global but `navigator`.
 */
import { canEncodeVideo, MediaStreamAudioTrackSource, MediaStreamVideoTrackSource, Mp4OutputFormat, Output, Quality, StreamTarget } from "mediabunny";
import { inViewUnits, type Recording } from "../lib/events.js";
import { defaultProject, solveDefaults, writeProject } from "../lib/project.js";
import type { MetaEvent, Project, RecordingFiles, Size } from "../lib/types.js";
import { DISK_CHECK_MS, formatBytes, watchVerdict } from "./disk.js";
import { EventsWriter, AppendLog, type StampedEvent } from "./events-writer.js";
import { Follow, type FollowTarget } from "./follow.js";
import { formatClock, recordingFiles } from "./ids.js";
import { LevelList, levelBytes, meterBars } from "./levels.js";
import { LevelWatch, Still, TrackPump } from "./media.js";
import { ScreenEncoder } from "./screen.js";
import { isLive, isOver, next, type SessionAction, type SessionState } from "./state.js";
import { appendSink, dataWritableStream, type WriteCounter } from "./writable.js";

export { PAGE_AUDIO_BITRATE } from "./screen.js";

type Unsubscribe = () => void;

/** The members of `pistachio` a session uses. */
export interface RecorderApi {
  runtime: Pick<Pistachio.Runtime, "now" | "keepAlive" | "log">;
  capture: Pick<Pistachio.Capture, "tab" | "hold">;
  input: Pick<Pistachio.Input, "subscribe">;
  tabs: Pick<Pistachio.Tabs, "get" | "onActivated" | "onUpdated">;
  files: { data: Pick<Pistachio.Data, "open" | "write" | "remove" | "freeSpace"> };
  ui: Pick<Pistachio.Ui, "setStatus" | "toast">;
  power: Pick<Pistachio.Power, "preventSleep">;
}

export interface RecordOptions {
  tabId: string;
  title: string;
  url: string;
  /** A mic's `deviceId` ("default" for the system's), or null for none. */
  mic: string | null;
  camera: boolean;
  pageAudio: boolean;
  scale: 1 | 2;
  fps: 30 | 60;
  /** Seconds. */
  countdown: number;
}

/** What the panel and the pill are told. */
export interface SessionSnapshot {
  id: string;
  state: SessionState;
  /** The tab recorded now (the one in front: it follows the person). */
  tabId: string;
  title: string;
  /** Media time recorded so far (pauses left out). */
  elapsedMs: number;
  /** Seconds left of the countdown while counting. */
  countdown: number | null;
  mic: boolean;
  camera: boolean;
  /** The four-bar mic meter, `▁▃▅▂`, or "" without a mic. */
  meter: string;
  /** Epoch ms of t = 0 once recording. */
  startedAt: number | null;
}

export interface SessionOutcome {
  state: "done" | "discarded" | "failed";
  /** For the person: why it stopped or failed. */
  message: string | null;
  durationMs: number;
}

export interface SessionHooks {
  /** The state, the clock or the meter changed. */
  changed?(session: RecordingSession): void;
  /** Over: holds released, the pill cleared, the files final (or removed). */
  ended?(session: RecordingSession, outcome: SessionOutcome): void;
}

export interface MediaAccess {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
}

/**
 * A tab's feed: its capture, its input subscription and its hold — what the
 * recording is of while the tab is in front.
 */
export interface Feed {
  tab: FollowTarget;
  stream: MediaStream;
  video: MediaStreamTrack;
  pump: TrackPump<VideoFrame> | null;
  subscription: Pistachio.InputSubscription | null;
  /** The hold on the tab, once taken. */
  release: Unsubscribe | null;
  /** Resolved at its first frame: it shows. */
  shown: { promise: Promise<void>; resolve: () => void };
  closed: boolean;
}

/** ~10 Mbps for a 1080p view at 2× (3840×2160), by area; mostly static text needs little, motion is capped. */
export function screenBitrate(width: number, height: number): number {
  const scaled = (10e6 * width * height) / (3840 * 2160);
  return Math.round(Math.min(25e6, Math.max(2e6, scaled)));
}

export const MIC_BITRATE = 160e3;
export const CAMERA_BITRATE = 3e6;
export const CAMERA_FPS = 30;
/**
 * Unchunked: mediabunny flushes once a fragment (≥ 1 s) is complete, so each file gets one append a
 * second and a crash loses about a second (R2). `{ chunked: true, chunkSize: 4 << 20 }` (§3's sketch)
 * holds 4 MiB in memory first — at screen content's real bitrates (0.6–3 Mbps measured) that is
 * 10–50 s that never reached the disk, and the probe saw nothing written after 3 s.
 */
const TARGET_OPTIONS = { chunked: false } as const;
/** With no countdown at 2×, the page's switch to the new ratio is let pass before t0. */
const SETTLE_MS = 600;
/** How long the meta line waits for the mic's and the camera's first samples (their offsets). */
const META_WAIT_MS = 1500;
/** How long a new feed is given to show its first frame before it counts as open (a fresh sink gets one in ~4 ms — measured). */
export const FEED_FIRST_FRAME_MS = 3000;
const STATUS_TITLE_MAX = 28;

/**
 * `project.json` for a fresh recording: the solver's defaults over the media's
 * length (the zooms from the clicks, the speed plan sparing speech), exported
 * at the frame rate it was recorded at. Should the solver ever throw, the
 * default look over the whole recording, so the editor still opens.
 */
export function projectFor(raw: Recording, levels: Float32Array | null, durationS: number, log?: (message: string) => void): Project {
  // (The writer's events as they came, the window resized or not: in the first view's units, as the editor reads the log.)
  const recording: Recording = { meta: raw.meta, events: inViewUnits(raw.events, raw.meta.view) };
  let project: Project;
  try {
    project = solveDefaults(recording, levels, durationS);
  } catch (error) {
    log?.(`recorder: solveDefaults failed (${error instanceof Error ? error.message : String(error)}); writing the default project`);
    project = defaultProject();
    if (durationS > 0) project.cuts = [{ in: 0, out: Math.round(durationS * 1000) / 1000 }];
  }
  if (recording.meta.fps === 30) project.export.fps = 30;
  return project;
}

/**
 * Hardware H.264 when the Mac has it for this size (it does to 4K60 on an M4 — measured), else whatever
 * Chromium picks: left to itself with `latencyMode: "realtime"` it chose OpenH264, in software, which
 * also ignores the bitrate (probe-engine, 2026-10-30).
 */
export async function videoAcceleration(width: number, height: number, bitrate: number, frameRate: number): Promise<"prefer-hardware" | "no-preference"> {
  try {
    const hardware = await canEncodeVideo("avc", { width, height, quality: new Quality({ bitrate }), frameRate, hardwareAcceleration: "prefer-hardware", latencyMode: "realtime" });
    return hardware ? "prefer-hardware" : "no-preference";
  } catch {
    return "no-preference";
  }
}

/** Whether a tab the person brought in front is one the recording follows: a web page (a shell page or an extension's is never recorded). */
export function followable(tab: Pick<Pistachio.Tab, "kind" | "url">): boolean {
  return tab.kind === "page" && /^https?:/i.test(tab.url);
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

/**
 * The meta line (R7): the capture's pixels, and the view the events' coordinates are in — as the input subscription
 * reported it (`box`), since the capture is not always the scale times the view: main caps a capture at 3840 on its
 * long side, so a 2560×1440 view at 2× is captured at 3840×2160, 1.5×. `dpr` is what it came to. With no box
 * (input.subscribe failed) the view is taken as the capture over the scale asked.
 */
export function metaFor(options: Pick<RecordOptions, "tabId" | "title" | "url" | "scale" | "fps">, size: Size, view: Size | null, offsets: NonNullable<MetaEvent["offsets"]>, t0: number): Omit<MetaEvent, "t" | "k"> {
  const known = view !== null && view.w > 0 && view.h > 0;
  const dpr = known ? Math.round((size.w / view.w) * 1000) / 1000 : options.scale;
  const meta: Omit<MetaEvent, "t" | "k"> = {
    source: { kind: "tab", tabId: options.tabId, title: options.title, url: options.url },
    capture: { w: size.w, h: size.h, dpr },
    view: known ? { w: view.w, h: view.h } : { w: Math.round(size.w / options.scale), h: Math.round(size.h / options.scale) },
    fps: options.fps,
    startedAt: Math.round(t0),
    // Chromium draws the system cursor into a tab capture (R5): only Natural can cover it.
    cursorBaked: true,
  };
  if (Object.keys(offsets).length > 0) meta.offsets = offsets;
  return meta;
}

interface Encoding {
  kind: "screen" | "mic" | "camera";
  output: Output;
  sources: { pause(): void; resume(): void }[];
  written: WriteCounter;
}

/** mediabunny's zero for an output: when its first MediaStream sample arrived (performance.now() seconds). Internal to 1.61.6, read when there. */
function firstMediaStreamTime(output: Output): number | null {
  const value = (output as unknown as { _firstMediaStreamTimestamp?: unknown })._firstMediaStreamTimestamp;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export class RecordingSession {
  readonly id: string;
  readonly options: RecordOptions;
  readonly files: RecordingFiles;
  readonly #api: RecorderApi;
  readonly #hooks: SessionHooks;
  readonly #media: MediaAccess;
  #state: SessionState = "counting";
  #countdownLeft: number | null = null;
  #starting = false;
  readonly #releases: Unsubscribe[] = [];
  #mic: MediaStream | null = null;
  #camera: MediaStream | null = null;
  /** The session ended: a mic or camera that opens now is stopped at once. */
  #devicesClosed = false;
  #ready: Promise<void> | null = null;
  /** The feeds: the one in front is current; one being opened shows at its first frame. */
  readonly #follow: Follow<Feed>;
  #opening: Feed | null = null;
  /** The feed whose picture is in the file (the current one, or the opening one from its first frame on). */
  #shown: Feed | null = null;
  #screen: ScreenEncoder | null = null;
  #levelWatch: LevelWatch | null = null;
  /** The view's size as the input subscription reports it (its `box`): what the events' coordinates are in. */
  #viewBox: Size | null = null;
  readonly #encodings: Encoding[] = [];
  readonly #writer: EventsWriter;
  readonly #levels = new LevelList();
  #levelsLog: AppendLog | null = null;
  readonly #still = new Still(480);
  #stillAtSecond = false;
  readonly #firstAt: Partial<Record<Encoding["kind"], number>> = {};
  #metaTimer: ReturnType<typeof setTimeout> | null = null;
  #ticker: ReturnType<typeof setInterval> | null = null;
  #diskTimer: ReturnType<typeof setInterval> | null = null;
  #finishing: Promise<void> | null = null;
  #endMessage: string | null = null;
  #durationMs = 0;
  #warned = new Set<string>();

  constructor(api: RecorderApi, id: string, options: RecordOptions, hooks: SessionHooks = {}, media?: MediaAccess) {
    this.#api = api;
    this.id = id;
    this.options = options;
    this.#hooks = hooks;
    this.#media = media ?? { getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints) };
    this.files = recordingFiles(id, { mic: options.mic !== null, camera: options.camera });
    this.#writer = new EventsWriter(async () => appendSink(await api.files.data.open(this.files.events, { append: true })), {
      now: () => api.runtime.now(),
      onError: (error) => this.#warnOnce("events", `recorder: events.jsonl: ${messageOf(error)}`),
    });
    this.#follow = new Follow<Feed>({
      open: (target) => this.#openFeed(target),
      close: (feed) => this.#closeFeed(feed),
      switched: (feed, previous) => this.#switched(feed, previous),
      failed: (target, error) => {
        this.#api.runtime.log("warn", `recorder: could not record ${target.url}: ${messageOf(error)}`);
        if (this.#state === "counting") void this.#failStart(error);
        else void this.#api.ui.toast({ title: `Could not record ${target.title || target.url}`, body: `${messageOf(error)} The recording stays on the last page.` }).catch(() => undefined);
      },
    });
  }

  get state(): SessionState {
    return this.#state;
  }

  /** The recording so far, the events as written (complete once ended; `projectFor` puts them in the first view's units). */
  get recording(): Recording | null {
    const meta = this.#writer.meta;
    return meta === null ? null : { meta, events: this.#writer.events };
  }

  get levels(): Float32Array {
    return this.#levels.toArray();
  }

  /** Bytes the encoders wrote, per file. */
  get written(): Record<string, number> {
    return Object.fromEntries(this.#encodings.map((encoding) => [encoding.kind, encoding.written.bytes]));
  }

  get elapsedMs(): number {
    if (isOver(this.#state) || this.#state === "finalizing") return this.#durationMs;
    return this.#writer.t0 === null ? 0 : this.#writer.mediaTime(this.#api.runtime.now());
  }

  /** The tab recorded now: the feed in front, else the one opening, else the one the session began on. */
  get tab(): FollowTarget {
    return this.#follow.current?.tab ?? this.#opening?.tab ?? { id: this.options.tabId, title: this.options.title, url: this.options.url };
  }

  snapshot(): SessionSnapshot {
    const tab = this.tab;
    return {
      id: this.id,
      state: this.#state,
      tabId: tab.id,
      title: tab.title,
      elapsedMs: Math.round(this.elapsedMs),
      countdown: this.#state === "counting" ? this.#countdownLeft : null,
      mic: this.#mic !== null,
      camera: this.#camera !== null,
      meter: this.#mic !== null ? meterBars(this.#levels.view()) : "",
      startedAt: this.#writer.t0 === null ? null : Math.round(this.#writer.t0),
    };
  }

  /**
   * Start: the holds, the first feed and the countdown at once. Resolves
   * once the tab's stream is live (rejects, the session failed, when it is
   * not); the countdown runs on and encoding begins when it ends. From here
   * the tab in front is followed.
   */
  async begin(): Promise<void> {
    const { options } = this;
    this.#countdownLeft = options.countdown > 0 ? options.countdown : null;
    this.#status();
    this.#changed();
    this.#hold(this.#api.runtime.keepAlive("recording"), "runtime.keepAlive");
    this.#hold(this.#api.power.preventSleep(), "power.preventSleep");

    const first = this.#openFeed({ id: options.tabId, title: options.title, url: options.url });
    const devices = Promise.all([
      this.#adopt(options.mic === null ? Promise.resolve(null) : this.#openMic(options.mic), "mic"),
      this.#adopt(options.camera ? this.#openCamera() : Promise.resolve(null), "camera"),
    ]);
    const ready = (async () => {
      let feed: Feed;
      try {
        feed = await first;
      } catch (error) {
        // (Cancelled while counting: the feed closed itself on the way out, and there is nothing to fail.)
        if (isOver(this.#state)) return;
        throw error;
      }
      if (!isLive(this.#state)) {
        this.#closeFeed(feed);
        return;
      }
      this.#follow.adopt(feed);
      try {
        const releases = [this.#api.tabs.onActivated((tabId) => void this.#activated(tabId)), this.#api.tabs.onUpdated((tab, changed) => this.#updated(tab, changed))];
        if (isOver(this.#state)) for (const release of releases) release();
        else this.#releases.push(...releases);
      } catch (error) {
        this.#api.runtime.log("warn", `recorder: tabs.onActivated failed, the recording stays on this window: ${messageOf(error)}`);
      }
      await devices;
    })();
    this.#ready = ready;
    void this.#count();
    try {
      await ready;
    } catch (error) {
      await this.#failStart(error);
      throw error;
    }
  }

  pause(): void {
    // (Not before the first frame: there is nothing to pause yet, and t0 is what a pause is measured from.)
    if (this.#writer.t0 === null || !this.#move("pause")) return;
    const at = this.#api.runtime.now();
    for (const encoding of this.#encodings) for (const source of encoding.sources) source.pause();
    this.#writer.pause(at);
    this.#levelWatch?.reset();
    this.#status();
    this.#changed();
  }

  resume(): void {
    if (!this.#move("resume")) return;
    const at = this.#api.runtime.now();
    for (const encoding of this.#encodings) for (const source of encoding.sources) source.resume();
    this.#writer.resume(at);
    this.#status();
    this.#changed();
  }

  /** Stop and save (a cancel while counting). Resolves once the files are final. */
  stop(): Promise<void> {
    if (this.#state === "counting") return this.discard();
    if (!this.#move("stop")) return this.#finishing ?? Promise.resolve();
    this.#finishing = this.#finalize();
    return this.#finishing;
  }

  /** Throw it away: the encoders cancelled, the folder removed. */
  async discard(): Promise<void> {
    if (!this.#move("discard")) return this.#finishing ?? undefined;
    this.#finishing = (async () => {
      this.#stopTimers();
      this.#durationMs = 0;
      await this.#teardown(false);
      await this.#writer.abandon();
      await this.#levelsLog?.abandon();
      await this.#api.files.data.remove(this.files.dir).catch(() => undefined);
      this.#end({ state: "discarded", message: null, durationMs: 0 });
    })();
    return this.#finishing;
  }

  // ── Feeds: the tab in front ────────────────────────────────────────────

  /** The tab in front changed: a web page is followed; a shell page, an extension's, or none leaves the picture where it is. */
  async #activated(tabId: string | null): Promise<void> {
    if (!isLive(this.#state) || tabId === null || tabId === this.#follow.wanted?.id) return;
    let tab: Pistachio.Tab;
    try {
      tab = await this.#api.tabs.get(tabId);
    } catch {
      return;
    }
    if (!isLive(this.#state) || !followable(tab)) return;
    this.#follow.want({ id: tab.id, title: tab.title || tab.url, url: tab.url });
  }

  /** A tab's title or address changed: a feed of it (in front, or opening) is named after it from here — the pill, the panel. */
  #updated(tab: Pistachio.Tab, changed: readonly string[]): void {
    if (!changed.includes("title") && !changed.includes("url")) return;
    let named = false;
    for (const feed of [this.#follow.current, this.#opening]) {
      if (feed === null || feed.closed || feed.tab.id !== tab.id) continue;
      feed.tab.title = tab.title || tab.url;
      feed.tab.url = tab.url;
      named = true;
    }
    if (!named) return;
    this.#status();
    this.#changed();
  }

  /**
   * A tab's feed: its hold and its capture at once, then its input, then
   * its first frame (or FEED_FIRST_FRAME_MS). The feed is the opening one
   * meanwhile — its first frame takes the picture over (`#onFrame`).
   */
  async #openFeed(target: FollowTarget): Promise<Feed> {
    const api = this.#api;
    const { options } = this;
    const feed: Feed = { tab: { ...target }, stream: null as unknown as MediaStream, video: null as unknown as MediaStreamTrack, pump: null, subscription: null, release: null, shown: deferred(), closed: false };
    // (The opening one from the first moment: a title that arrives while its capture starts is its — `#updated`.)
    this.#opening = feed;
    const holding = api.capture.hold(target.id).then(
      (release) => {
        if (feed.closed || isOver(this.#state)) release();
        else feed.release = release;
      },
      (error: unknown) => api.runtime.log("warn", `recorder: capture.hold failed: ${messageOf(error)}`),
    );
    let stream: MediaStream;
    try {
      stream = await api.capture.tab(target.id, { audio: options.pageAudio, scale: options.scale, frameRate: options.fps });
    } catch (error) {
      await holding;
      this.#closeFeed(feed);
      throw error;
    }
    feed.stream = stream;
    const video = stream.getVideoTracks()[0];
    if (video === undefined || isOver(this.#state)) {
      stopAll(stream);
      await holding;
      this.#closeFeed(feed);
      throw new Error(video === undefined ? "the capture has no video" : "the recording ended");
    }
    feed.video = video;
    feed.pump = new TrackPump<VideoFrame>(video, () => api.runtime.now(), (frame, at) => this.#onFrame(feed, frame, at));
    video.addEventListener("ended", () => this.#lost(feed));
    if (!feed.pump.watching) {
      this.#warnOnce("frames", "recorder: MediaStreamTrackProcessor is missing; nothing can be recorded");
      feed.shown.resolve();
    }
    try {
      const subscription = await api.input.subscribe(target.id);
      if (feed.closed) void subscription.stop().catch(() => undefined);
      else {
        feed.subscription = subscription;
        subscription.onEvent((event) => this.#onInput(feed, event));
      }
    } catch (error) {
      api.runtime.log("warn", `recorder: input.subscribe failed: ${messageOf(error)}`);
      void api.ui.toast({ title: "Recording without clicks and keys", body: "Automatic zoom needs them; the picture is still recorded." }).catch(() => undefined);
    }
    await Promise.race([feed.shown.promise, sleep(FEED_FIRST_FRAME_MS)]);
    await holding;
    if (this.#opening === feed) this.#opening = null;
    if (feed.closed) throw new Error("the feed ended before it showed");
    return feed;
  }

  /** A feed let go: its frames stop, its tracks, its input and its hold. */
  #closeFeed(feed: Feed): void {
    if (feed.closed) return;
    feed.closed = true;
    if (this.#opening === feed) this.#opening = null;
    feed.shown.resolve();
    feed.pump?.stop();
    stopAll(feed.stream);
    const subscription = feed.subscription;
    feed.subscription = null;
    if (subscription !== null) void subscription.stop().catch(() => undefined);
    const release = feed.release;
    feed.release = null;
    if (release !== null) {
      try {
        release();
      } catch {
        // (A release that throws has nothing left to release.)
      }
    }
  }

  /** The feed in front changed: the pill names it, by the tab's name now (a page activated as it opened was "New tab" then). Its picture and sound took over at its first frame. */
  #switched(feed: Feed, previous: Feed | null): void {
    if (previous !== null) this.#api.runtime.log("info", `recorder: now recording ${feed.tab.url}`);
    this.#status();
    this.#changed();
    void this.#api.tabs
      .get(feed.tab.id)
      .then((tab) => this.#updated(tab, ["title", "url"]))
      .catch(() => undefined);
  }

  /** A feed's capture ended under it: while counting the start failed; recording, the follow opens the tab again if it is still in front. */
  #lost(feed: Feed): void {
    if (feed.closed || isOver(this.#state)) return;
    if (this.#state === "counting" && this.#follow.current === feed) {
      void this.#failStart(new Error("the window's capture ended before recording began"));
      return;
    }
    if (this.#shown === feed) this.#shown = null;
    this.#follow.lost(feed);
  }

  #onInput(feed: Feed, event: Pistachio.InputEvent): void {
    // (The feed in front's events, and the opening one's from the moment it opens: the person is looking at that one.)
    if (feed.closed || (feed !== this.#follow.current && feed !== this.#opening) || (this.#opening !== null && feed !== this.#opening)) return;
    if (event.k === "box" && this.#viewBox === null) this.#viewBox = { w: event.view.w, h: event.view.h };
    this.#writer.add(event as unknown as StampedEvent);
  }

  // ── Counting and going ─────────────────────────────────────────────────

  async #count(): Promise<void> {
    for (let left = this.options.countdown; left > 0; left -= 1) {
      if (this.#state !== "counting") return;
      this.#countdownLeft = left;
      this.#status();
      this.#changed();
      await sleep(1000);
    }
    if (this.#state !== "counting") return;
    this.#countdownLeft = null;
    try {
      await this.#ready;
    } catch {
      return;
    }
    if (this.options.countdown <= 0 && this.options.scale === 2) {
      this.#starting = true;
      this.#status();
      await sleep(SETTLE_MS);
      this.#starting = false;
    }
    if (this.#state !== "counting") return;
    await this.#go();
  }

  async #go(): Promise<void> {
    const feed = this.#shown ?? this.#follow.current;
    const video = feed?.video;
    if (feed === null || feed === undefined || video === undefined || video.readyState === "ended") {
      await this.#failStart(new Error("the window's capture ended before recording began"));
      return;
    }
    if (!this.#move("go")) return;
    const { options, files } = this;
    const settings = video.getSettings();
    const size = feed.pump?.size ?? { w: settings.width ?? 1920, h: settings.height ?? 1080 };
    const broke = (error: unknown): void => this.#sourceEnded(`The recording stopped: ${messageOf(error)}`);
    try {
      const cameraTrack = this.#camera?.getVideoTracks()[0];
      const cameraSettings = cameraTrack?.getSettings();
      const bitrate = screenBitrate(size.w, size.h);
      const [screenAcceleration, cameraAcceleration] = await Promise.all([
        videoAcceleration(size.w, size.h, bitrate, options.fps),
        cameraTrack === undefined ? ("no-preference" as const) : videoAcceleration(cameraSettings?.width ?? 1280, cameraSettings?.height ?? 720, CAMERA_BITRATE, CAMERA_FPS),
      ]);
      if (this.#state !== "recording") return;

      // The screen: the pages' pixels, and their sound when asked — fed from whichever tab is in front.
      const screenOut = this.#encoding("screen", files.screen);
      const screen = new ScreenEncoder(
        screenOut.output,
        { fps: options.fps, bitrate, acceleration: screenAcceleration, pageAudio: options.pageAudio },
        {
          now: () => this.#api.runtime.now(),
          mediaTime: (at) => {
            const t = this.#writer.rel(at);
            return t === null || t < 0 ? null : t;
          },
          firstSample: (at) => this.#firstScreenSample(at),
          broke,
          warn: (message) => this.#warnOnce(message, message),
        },
      );
      this.#screen = screen;
      screenOut.sources.push(screen);

      // The mic: its own file, and its levels.
      const micTrack = this.#mic?.getAudioTracks()[0];
      if (micTrack !== undefined && files.mic !== null && files.micLevels !== null) {
        const micOut = this.#encoding("mic", files.mic);
        const micSource = new MediaStreamAudioTrackSource(micTrack, {
          codec: "aac",
          quality: new Quality({ bitrate: MIC_BITRATE }),
          onEncodedSample: () => this.#firstSample("mic", micOut.output),
        });
        micSource.errorPromise.catch((error: unknown) => this.#warnOnce("mic", `recorder: the mic's encoder failed: ${messageOf(error)}`));
        micOut.output.addAudioTrack(micSource);
        micOut.sources.push(micSource);
        const levelsPath = files.micLevels;
        this.#levelsLog = new AppendLog(async () => appendSink(await this.#api.files.data.open(levelsPath, { append: true })), (error) =>
          this.#warnOnce("levels", `recorder: mic.levels: ${messageOf(error)}`),
        );
        this.#levelsLog.every(250);
        this.#levelWatch = new LevelWatch(micTrack, (levels) => {
          if (this.#state !== "recording") return;
          this.#levels.push(levels);
          this.#levelsLog?.append(levelBytes(levels));
        });
      }

      // The camera: its own file.
      if (cameraTrack !== undefined && files.camera !== null) {
        const cameraOut = this.#encoding("camera", files.camera);
        const cameraSource = new MediaStreamVideoTrackSource(
          cameraTrack,
          {
            codec: "avc",
            quality: new Quality({ bitrate: CAMERA_BITRATE }),
            keyFrameInterval: 1,
            latencyMode: "realtime",
            hardwareAcceleration: cameraAcceleration,
            sizeChangeBehavior: "contain",
            onEncodedSample: () => this.#firstSample("camera", cameraOut.output),
          },
          { frameRate: CAMERA_FPS },
        );
        cameraSource.errorPromise.catch((error: unknown) => this.#warnOnce("camera", `recorder: the camera's encoder failed: ${messageOf(error)}`));
        cameraOut.output.addVideoTrack(cameraSource, { frameRate: CAMERA_FPS });
        cameraOut.sources.push(cameraSource);
      }

      await Promise.all(this.#encodings.map((encoding) => encoding.output.start()));
      if (this.#state === "recording" || this.#state === "paused") {
        screen.start();
        screen.setAudio(this.#shown?.stream.getAudioTracks()[0] ?? null);
      }
    } catch (error) {
      this.#api.runtime.log("error", `recorder: the encoders did not start: ${messageOf(error)}`);
      this.#endMessage = `The recording could not start: ${messageOf(error)}`;
      if (this.#move("fail")) this.#finishing = this.#finalize();
      return;
    }
    if (this.#state !== "recording" && this.#state !== "paused") return;
    this.#ticker = setInterval(() => {
      this.#status();
      this.#changed();
    }, 1000);
    this.#diskTimer = setInterval(() => void this.#checkDisk(), DISK_CHECK_MS);
    this.#status();
    this.#changed();
  }

  #encoding(kind: Encoding["kind"], path: string): Encoding {
    const written: WriteCounter = { bytes: 0, chunks: 0 };
    const writable = dataWritableStream(() => this.#api.files.data.open(path), written);
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: "fragmented" }),
      target: new StreamTarget(writable as unknown as WritableStream<{ type: "write"; data: Uint8Array<ArrayBuffer>; position: number }>, TARGET_OPTIONS),
    });
    const encoding: Encoding = { kind, output, sources: [], written };
    this.#encodings.push(encoding);
    return encoding;
  }

  /**
   * The screen's first sample (a frame or a chunk, arrived at `at`): t0 is
   * its arrival less one frame (the capture's latency), so a click lands on
   * the frame that shows it.
   */
  #firstScreenSample(at: number): void {
    if (this.#firstAt.screen !== undefined) return;
    this.#firstAt.screen = at;
    this.#writer.start(at - 1000 / this.options.fps);
    this.#maybeMeta(false);
  }

  /**
   * The mic's or the camera's first sample: its zero on the clock, into the
   * meta line as an `offset` (ms from t0), so the editor can line them up.
   */
  #firstSample(kind: "mic" | "camera", output: Output): void {
    if (this.#firstAt[kind] !== undefined) return;
    const now = this.#api.runtime.now();
    const zero = firstMediaStreamTime(output);
    // (mediabunny's zero is performance.now() seconds; moved onto runtime.now()'s clock.)
    this.#firstAt[kind] = zero === null ? now : now - performance.now() + zero * 1000;
    this.#maybeMeta(false);
  }

  #maybeMeta(force: boolean): void {
    const t0 = this.#writer.t0;
    if (t0 === null || this.#writer.meta !== null) return;
    const waitingMic = this.#encodings.some((encoding) => encoding.kind === "mic") && this.#firstAt.mic === undefined;
    const waitingCamera = this.#encodings.some((encoding) => encoding.kind === "camera") && this.#firstAt.camera === undefined;
    if ((waitingMic || waitingCamera) && !force) {
      this.#metaTimer ??= setTimeout(() => this.#maybeMeta(true), META_WAIT_MS);
      return;
    }
    if (this.#metaTimer !== null) clearTimeout(this.#metaTimer);
    this.#metaTimer = null;
    const { options } = this;
    const feed = this.#shown ?? this.#follow.current;
    const size = feed?.pump?.size ?? (() => {
      const settings = feed?.video.getSettings();
      return { w: settings?.width ?? 0, h: settings?.height ?? 0 };
    })();
    const offsets: NonNullable<MetaEvent["offsets"]> = {};
    if (this.#firstAt.mic !== undefined) offsets.mic = Math.round((this.#firstAt.mic - t0) * 10) / 10;
    if (this.#firstAt.camera !== undefined) offsets.camera = Math.round((this.#firstAt.camera - 1000 / CAMERA_FPS - t0) * 10) / 10;
    this.#writer.setMeta(metaFor(options, size, this.#viewBox, offsets, t0));
  }

  /**
   * A frame of a feed: the shown feed's go to the encoder; the opening
   * feed's first takes the picture over (and its sound the mixer) — from
   * then on the old feed's are dropped; any other's are dropped.
   */
  #onFrame(feed: Feed, frame: VideoFrame, at: number): boolean {
    if (feed.closed || isOver(this.#state)) return false;
    let keyFrame = false;
    if (feed !== this.#shown) {
      if (feed !== this.#opening && this.#shown !== null) return false;
      this.#shown = feed;
      keyFrame = true;
      feed.shown.resolve();
      this.#screen?.setAudio(feed.stream.getAudioTracks()[0] ?? null);
    }
    if (this.#state !== "recording") {
      // (Counting, or paused: the picture is kept as the last one, nothing is encoded.)
      this.#screen?.addFrame(frame, at, keyFrame);
      return this.#screen !== null;
    }
    // (The frame was captured about a frame before it arrived: its line sits where the file shows it.)
    this.#writer.add({ t: at - 1000 / this.options.fps, k: "frame" });
    if (this.#writer.t0 !== null) {
      const t = this.#writer.mediaTime(at);
      if (!this.#still.taken) this.#still.take(frame);
      else if (!this.#stillAtSecond && t >= 1000) {
        this.#still.take(frame);
        this.#stillAtSecond = true;
      }
    }
    const screen = this.#screen;
    if (screen === null) return false;
    screen.addFrame(frame, at, keyFrame);
    return true;
  }

  // ── Streams ────────────────────────────────────────────────────────────

  async #openMic(deviceId: string): Promise<MediaStream | null> {
    const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (deviceId !== "default" && deviceId !== "") audio.deviceId = { exact: deviceId };
    try {
      return await this.#media.getUserMedia({ audio });
    } catch (error) {
      void this.#api.ui.toast({ title: "Recording without the microphone", body: messageOf(error) }).catch(() => undefined);
      return null;
    }
  }

  async #openCamera(): Promise<MediaStream | null> {
    try {
      return await this.#media.getUserMedia({ video: { width: 1280, height: 720, frameRate: CAMERA_FPS } });
    } catch (error) {
      void this.#api.ui.toast({ title: "Recording without the camera", body: messageOf(error) }).catch(() => undefined);
      return null;
    }
  }

  /**
   * A mic or camera stream is the session's the moment it opens, so whatever
   * ends the session stops it with the rest (`#teardown`) — a capture that
   * failed, a cancel while counting, as much as a stop. One that opens only
   * after the end (a slow device, macOS's question still up) is stopped as it
   * arrives: the Mac's mic and camera light never outlives the session. The
   * end does not wait for it: an unanswered question must not hold the engine.
   */
  async #adopt(opening: Promise<MediaStream | null>, kind: "mic" | "camera"): Promise<void> {
    const stream = await opening.catch(() => null);
    if (stream === null) return;
    if (this.#devicesClosed) stopAll(stream);
    else if (kind === "mic") this.#mic = stream;
    else this.#camera = stream;
  }

  #hold(acquire: Promise<Unsubscribe>, what: string): void {
    acquire.then(
      (release) => {
        if (isOver(this.#state)) release();
        else this.#releases.push(release);
      },
      (error: unknown) => this.#api.runtime.log("warn", `recorder: ${what} failed: ${messageOf(error)}`),
    );
  }

  // ── Watching ───────────────────────────────────────────────────────────

  async #checkDisk(): Promise<void> {
    if (this.#state !== "recording" && this.#state !== "paused") return;
    let free: number;
    try {
      free = await this.#api.files.data.freeSpace();
    } catch {
      return;
    }
    if (watchVerdict(free) === "stop") this.#sourceEnded(`The disk is almost full (${formatBytes(free)} left), so the recording stopped.`);
  }

  /** Something ended the recording under it: save what there is (fail it while counting). */
  #sourceEnded(message: string): void {
    if (this.#state === "counting") {
      void this.#failStart(new Error(message));
      return;
    }
    if (!this.#move("end")) return;
    this.#endMessage = message;
    this.#finishing = this.#finalize();
  }

  // ── Finishing ──────────────────────────────────────────────────────────

  async #finalize(): Promise<void> {
    this.#stopTimers();
    this.#durationMs = this.#writer.t0 === null ? 0 : this.#writer.mediaTime(this.#api.runtime.now());
    void this.#api.ui.setStatus({ text: `Saving ${formatClock(this.#durationMs)}…` }).catch(() => undefined);
    this.#changed();
    const failures = await this.#teardown(true);
    this.#maybeMeta(true);
    await this.#writer.close();
    await this.#levelsLog?.close();
    const { files } = this;
    const recording = this.recording;
    if (recording === null || failures.includes("screen")) {
      const message = recording === null ? "Nothing was recorded: the window never drew a frame." : (this.#endMessage ?? "The recording could not be saved.");
      if (recording === null) await this.#api.files.data.remove(files.dir).catch(() => undefined);
      this.#move("fail");
      this.#end({ state: "failed", message, durationMs: this.#durationMs });
      return;
    }
    try {
      const jpeg = await this.#still.jpeg();
      if (jpeg !== null) await this.#api.files.data.write(files.thumb ?? `${files.dir}/thumb.jpg`, jpeg);
    } catch (error) {
      this.#api.runtime.log("warn", `recorder: thumb.jpg: ${messageOf(error)}`);
    }
    try {
      const levels = this.#encodings.some((encoding) => encoding.kind === "mic") ? this.#levels.toArray() : null;
      const project = projectFor(recording, levels, this.#durationMs / 1000, (message) => this.#api.runtime.log("warn", message));
      await this.#api.files.data.write(files.project, writeProject(project));
    } catch (error) {
      this.#api.runtime.log("error", `recorder: project.json: ${messageOf(error)}`);
    }
    this.#move("finish");
    this.#end({ state: "done", message: this.#endMessage, durationMs: this.#durationMs });
  }

  /** Everything live stopped; the outputs finalized (`save`) or cancelled. Answers the kinds that failed to finalize. */
  async #teardown(save: boolean): Promise<Encoding["kind"][]> {
    // (From here a device that opens late is stopped as it arrives: #adopt.)
    this.#devicesClosed = true;
    if (this.#metaTimer !== null) clearTimeout(this.#metaTimer);
    this.#metaTimer = null;
    // (The feeds first — no frame or chunk reaches the encoders past here — then the encoders.)
    this.#follow.stop();
    const opening = this.#opening;
    this.#opening = null;
    if (opening !== null) this.#closeFeed(opening);
    this.#shown = null;
    this.#screen?.stop();
    this.#levelWatch?.stop();
    const failed: Encoding["kind"][] = [];
    await Promise.all(
      this.#encodings.map(async (encoding) => {
        const { output } = encoding;
        try {
          if (save && output.state === "started") await output.finalize();
          else if (output.state === "pending" || output.state === "started") await output.cancel();
        } catch (error) {
          this.#api.runtime.log("error", `recorder: ${encoding.kind} did not finalize: ${messageOf(error)}`);
          failed.push(encoding.kind);
          await output.cancel().catch(() => undefined);
        }
      }),
    );
    if (save && !this.#encodings.some((encoding) => encoding.kind === "screen")) failed.push("screen");
    stopAll(this.#mic);
    stopAll(this.#camera);
    return failed;
  }

  async #failStart(error: unknown): Promise<void> {
    if (!this.#move("fail")) return;
    this.#stopTimers();
    await this.#teardown(false);
    await this.#writer.abandon();
    await this.#levelsLog?.abandon();
    await this.#api.files.data.remove(this.files.dir).catch(() => undefined);
    this.#end({ state: "failed", message: `The recording could not start: ${messageOf(error)}`, durationMs: 0 });
  }

  #end(outcome: SessionOutcome): void {
    this.#stopTimers();
    for (const release of this.#releases.splice(0)) {
      try {
        release();
      } catch {
        // (A release that throws has nothing left to release.)
      }
    }
    void this.#api.ui.setStatus(null).catch(() => undefined);
    this.#changed();
    this.#hooks.ended?.(this, outcome);
  }

  #stopTimers(): void {
    if (this.#ticker !== null) clearInterval(this.#ticker);
    if (this.#diskTimer !== null) clearInterval(this.#diskTimer);
    this.#ticker = null;
    this.#diskTimer = null;
  }

  #move(action: SessionAction): boolean {
    const to = next(this.#state, action);
    if (to === null) return false;
    this.#state = to;
    return true;
  }

  // ── The pill ───────────────────────────────────────────────────────────

  /** `● 0:42 ▁▃▅▂ · Linear` with ⏸ ■ Discard; `3 · 2 · 1` while counting. Names the tab in front. Never in the capture: the shell draws it. */
  #status(): void {
    const name = this.tab.title;
    const title = name.length > STATUS_TITLE_MAX ? `${name.slice(0, STATUS_TITLE_MAX - 1)}…` : name;
    let status: { text: string; actions?: { id: string; title: string }[] } | null = null;
    switch (this.#state) {
      case "counting": {
        const total = this.options.countdown;
        const left = this.#countdownLeft;
        const count = left === null ? "" : Array.from({ length: total - left + 1 }, (_, index) => String(total - index)).join(" · ");
        status = { text: this.#starting || left === null ? `● Starting · ${title}` : `${count} · ${title}`, actions: [{ id: "discard", title: "Cancel" }] };
        break;
      }
      case "recording": {
        const meter = this.#mic !== null ? ` ${meterBars(this.#levels.view())}` : "";
        status = { text: `● ${formatClock(this.elapsedMs)}${meter} · ${title}`, actions: [{ id: "pause", title: "⏸" }, { id: "stop", title: "■" }, { id: "discard", title: "Discard" }] };
        break;
      }
      case "paused":
        status = { text: `❚❚ ${formatClock(this.elapsedMs)} Paused · ${title}`, actions: [{ id: "resume", title: "▶" }, { id: "stop", title: "■" }, { id: "discard", title: "Discard" }] };
        break;
      default:
        return;
    }
    void this.#api.ui.setStatus(status).catch((error: unknown) => this.#warnOnce("status", `recorder: ui.setStatus: ${messageOf(error)}`));
  }

  #changed(): void {
    try {
      this.#hooks.changed?.(this);
    } catch {
      // (A listener's failure is not the recording's.)
    }
  }

  #warnOnce(key: string, message: string): void {
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    this.#api.runtime.log("warn", message);
  }
}

function stopAll(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}
