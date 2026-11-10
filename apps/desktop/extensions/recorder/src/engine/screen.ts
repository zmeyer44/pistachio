/**
 * The screen's encoder (docs/recorder.md §3): one H.264 track and one AAC
 * track in `screen.mp4` for the whole recording, fed by the engine from
 * whichever tab is in front — mediabunny's sample sources, stamped on the
 * recording's own clock (the events writer's media time, pauses taken out),
 * so a switch of tabs is a switch of what is fed and nothing else.
 *
 * - **Frames** come from the current feed's pump (`addFrame`), each stamped
 *   with its arrival less one frame (the capture's latency: a click lands on
 *   the frame that shows it) and closed once encoded; a frame that arrives
 *   while the encoder's queue is deep is dropped. A tab paints only when it
 *   changes, so the file is kept at a constant frame rate the way mediabunny's
 *   track source keeps it: a 250 Hz tick re-adds the last picture whenever a
 *   frame's time has passed with no new one (a zero-copy `VideoFrame` of it).
 *   The first frame of a new tab is a keyframe.
 * - **Sound**: the tabs' audio tracks are mixed through one `AudioContext`
 *   into a destination whose track lives for the whole recording — a switch
 *   connects the new tab's track and drops the old — and that track's chunks
 *   are stamped from the first's arrival on, by the track's own clock
 *   (gapless), anchored again after a pause.
 * - `pause` / `resume`: frames and chunks are dropped meanwhile; the media
 *   time they are stamped with leaves the paused span out.
 *
 * `firstSample` is told once, at the first frame or chunk encoded: the
 * session sets t0 from it. Errors from either encoder go to `broke`.
 */
import { AudioSample, AudioSampleSource, Quality, VideoSample, VideoSampleSource, type Output } from "mediabunny";
import { canWatchTracks, TrackPump } from "./media.js";

export interface ScreenClock {
  /** `runtime.now()`. */
  now(): number;
  /** Media ms at epoch `at` (from t0, paused spans out), or null before t0 and while paused. */
  mediaTime(at: number): number | null;
  /** The first frame or chunk is being encoded, which arrived at `at`: t0 is its arrival less one frame. */
  firstSample(at: number): void;
  broke(error: unknown): void;
  warn(message: string): void;
}

export interface ScreenConfig {
  fps: 30 | 60;
  bitrate: number;
  acceleration: "prefer-hardware" | "no-preference";
  /** Encode the tabs' sound (the capture asked for it). */
  pageAudio: boolean;
}

/** Frames waiting on the encoder past this many are dropped (mediabunny's own limit for a track source). */
const MAX_QUEUE = 8;
/** The tick that keeps the frame rate constant (mediabunny's track source runs at 250 Hz too). */
const TICK_MS = 4;
/** A chunk whose clock sits this far from the recording's is anchored again (the audio context stalled). */
const AUDIO_REANCHOR_S = 0.25;
export const PAGE_AUDIO_BITRATE = 192e3;
export const AUDIO_SAMPLE_RATE = 48_000;

export class ScreenEncoder {
  readonly #clock: ScreenClock;
  readonly #config: ScreenConfig;
  readonly #video: VideoSampleSource;
  readonly #audio: AudioSampleSource | null;
  #context: AudioContext | null = null;
  #destination: MediaStreamAudioDestinationNode | null = null;
  #audioSource: MediaStreamAudioSourceNode | null = null;
  #audioPump: TrackPump<AudioData> | null = null;
  #audioAnchor: { file: number; ts: number } | null = null;
  #lastAudioStamp = -1;
  /** The last picture, for the tick. */
  #last: VideoFrame | null = null;
  #lastAt: number | null = null;
  #lastStamp = -1;
  #inflight = 0;
  #ticker: ReturnType<typeof setInterval> | null = null;
  #active = false;
  #paused = false;
  #started = false;
  #stopped = false;
  /** Frames dropped for a deep queue, and chunks dropped before the first frame. */
  dropped = 0;
  /** Frames encoded (the tick's included). */
  encoded = 0;

  constructor(output: Output, config: ScreenConfig, clock: ScreenClock) {
    this.#clock = clock;
    this.#config = config;
    this.#video = new VideoSampleSource({
      codec: "avc",
      quality: new Quality({ bitrate: config.bitrate }),
      keyFrameInterval: 1,
      latencyMode: "realtime",
      hardwareAcceleration: config.acceleration,
      sizeChangeBehavior: "contain",
    });
    output.addVideoTrack(this.#video, { frameRate: config.fps });
    this.#audio = config.pageAudio ? new AudioSampleSource({ codec: "aac", quality: new Quality({ bitrate: PAGE_AUDIO_BITRATE }) }) : null;
    if (this.#audio !== null) output.addAudioTrack(this.#audio);
  }

  get paused(): boolean {
    return this.#paused;
  }

  /** Encoding begins (the output started): frames from now on, and the tick. */
  start(): void {
    if (this.#stopped || this.#active) return;
    this.#active = true;
    this.#ticker = setInterval(() => this.#tick(), TICK_MS);
    if (this.#audio !== null) this.#openMixer();
  }

  #openMixer(): void {
    if (!canWatchTracks()) {
      this.#clock.warn("recorder: MediaStreamTrackProcessor is missing; the page's sound is not recorded");
      return;
    }
    try {
      const context = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE });
      this.#context = context;
      void context.resume().catch(() => undefined);
      const destination = context.createMediaStreamDestination();
      this.#destination = destination;
      const track = destination.stream.getAudioTracks()[0];
      if (track === undefined) throw new Error("the mixer has no track");
      this.#audioPump = new TrackPump<AudioData>(track, () => this.#clock.now(), (data, at) => this.#addChunk(data, at));
    } catch (error) {
      this.#clock.warn(`recorder: the page's sound is not recorded: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The tab in front's sound (its capture's audio track), or none: what the mixer hears from now on. */
  setAudio(track: MediaStreamTrack | null): void {
    const context = this.#context;
    const destination = this.#destination;
    if (context === null || destination === null) return;
    this.#audioSource?.disconnect();
    this.#audioSource = null;
    if (track === null || track.readyState === "ended") return;
    try {
      const source = context.createMediaStreamSource(new MediaStream([track]));
      source.connect(destination);
      this.#audioSource = source;
    } catch (error) {
      this.#clock.warn(`recorder: the tab's sound could not be mixed in: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * A frame of the tab in front, arrived at `at` (the frame is the encoder's
   * from here). Before the output started, or while paused, it is kept as
   * the last picture only. `keyFrame` for the first of a new tab.
   */
  addFrame(frame: VideoFrame, at: number, keyFrame = false): void {
    if (this.#stopped) {
      frame.close();
      return;
    }
    this.#last?.close();
    this.#last = frame.clone();
    if (!this.#active || this.#paused) {
      frame.close();
      return;
    }
    if (!this.#started) {
      this.#started = true;
      this.#clock.firstSample(at);
    }
    let stamp = this.#fileTime(at);
    if (stamp === null) {
      frame.close();
      this.dropped += 1;
      return;
    }
    if (stamp <= this.#lastStamp) stamp = this.#lastStamp + 1e-4;
    this.#lastAt = at;
    this.#lastStamp = stamp;
    this.#encode(frame, stamp, keyFrame);
  }

  #tick(): void {
    if (!this.#active || this.#paused || this.#last === null || this.#lastAt === null) return;
    const period = 1000 / this.#config.fps;
    const now = this.#clock.now();
    while (now - this.#lastAt > period) {
      this.#lastAt += period;
      const stamp = this.#fileTime(this.#lastAt);
      if (stamp === null || stamp <= this.#lastStamp) continue;
      if (this.#inflight >= MAX_QUEUE) continue;
      let again: VideoFrame;
      try {
        again = new VideoFrame(this.#last, { timestamp: Math.round(stamp * 1e6), duration: Math.round(1e6 / this.#config.fps) });
      } catch {
        return;
      }
      this.#lastStamp = stamp;
      this.#encode(again, stamp, false);
    }
  }

  #encode(frame: VideoFrame, stamp: number, keyFrame: boolean): void {
    if (this.#inflight >= MAX_QUEUE) {
      frame.close();
      this.dropped += 1;
      return;
    }
    let sample: VideoSample;
    try {
      sample = new VideoSample(frame, { timestamp: stamp, duration: 1 / this.#config.fps });
    } catch (error) {
      frame.close();
      this.#clock.broke(error);
      return;
    }
    this.#inflight += 1;
    this.encoded += 1;
    this.#video
      .add(sample, keyFrame ? { keyFrame: true } : undefined)
      .catch((error: unknown) => this.#clock.broke(error))
      .finally(() => {
        this.#inflight -= 1;
        sample.close();
      });
  }

  #addChunk(data: AudioData, at: number): boolean {
    const audio = this.#audio;
    if (audio === null || !this.#active || this.#paused || this.#stopped) return false;
    if (!this.#started) {
      this.#started = true;
      this.#clock.firstSample(at);
    }
    const file = this.#fileTime(at);
    if (file === null) return false;
    let stamp: number;
    const anchor = this.#audioAnchor;
    if (anchor === null || Math.abs(anchor.file + (data.timestamp - anchor.ts) / 1e6 - file) > AUDIO_REANCHOR_S) {
      this.#audioAnchor = { file, ts: data.timestamp };
      stamp = file;
    } else {
      stamp = anchor.file + (data.timestamp - anchor.ts) / 1e6;
    }
    if (stamp <= this.#lastAudioStamp) return false;
    this.#lastAudioStamp = stamp;
    let sample: AudioSample;
    try {
      sample = new AudioSample(data);
      sample.setTimestamp(stamp);
    } catch (error) {
      this.#clock.broke(error);
      return false;
    }
    audio
      .add(sample)
      .catch((error: unknown) => this.#clock.broke(error))
      .finally(() => sample.close());
    return true;
  }

  /** Media seconds of a frame or chunk that arrived at `at`: its media time less one frame, never negative. */
  #fileTime(at: number): number | null {
    const t = this.#clock.mediaTime(at);
    return t === null ? null : Math.max(0, t - 1000 / this.#config.fps) / 1000;
  }

  pause(): void {
    this.#paused = true;
  }

  resume(): void {
    if (!this.#paused) return;
    this.#paused = false;
    // (The tick counts from here: nothing fills the paused span, and the chunks are anchored again.)
    this.#lastAt = this.#clock.now();
    this.#audioAnchor = null;
  }

  /** Nothing more is encoded (the output is the session's to finalize). */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#active = false;
    if (this.#ticker !== null) clearInterval(this.#ticker);
    this.#ticker = null;
    this.#audioPump?.stop();
    this.#audioPump = null;
    this.#audioSource?.disconnect();
    this.#audioSource = null;
    void this.#context?.close().catch(() => undefined);
    this.#context = null;
    this.#destination = null;
    this.#last?.close();
    this.#last = null;
  }
}
