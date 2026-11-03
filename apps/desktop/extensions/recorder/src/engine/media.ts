/**
 * What the engine reads off live tracks besides encoding them: each captured
 * frame's arrival (the `frame` lines, the meta's capture size, the thumbnail)
 * and the mic's PCM (the level log). Both read a *clone* of the track through
 * `MediaStreamTrackProcessor` (present in Electron 43's windows — measured), so
 * the encoder's own reader is untouched; a frame costs a read and a close.
 */
import { LevelMeter, rms } from "./levels.js";

type TrackProcessor<T> = new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<T> };

function processorOf<T>(): TrackProcessor<T> | null {
  const ctor = (globalThis as { MediaStreamTrackProcessor?: TrackProcessor<T> }).MediaStreamTrackProcessor;
  return typeof ctor === "function" ? ctor : null;
}

export function canWatchTracks(): boolean {
  return processorOf() !== null;
}

/** Every frame of a video track as it arrives, with the clock's time of arrival. The callback must not keep the frame. */
export class FrameWatch {
  readonly #track: MediaStreamTrack;
  readonly #now: () => number;
  readonly #onFrame: (frame: VideoFrame, at: number) => void;
  #reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  #stopped = false;
  /** The last frame's size (display pixels). */
  size: { w: number; h: number } | null = null;
  frames = 0;

  constructor(track: MediaStreamTrack, now: () => number, onFrame: (frame: VideoFrame, at: number) => void) {
    this.#track = track.clone();
    this.#now = now;
    this.#onFrame = onFrame;
    const Processor = processorOf<VideoFrame>();
    if (Processor === null) return;
    this.#reader = new Processor({ track: this.#track }).readable.getReader();
    void this.#pump();
  }

  get watching(): boolean {
    return this.#reader !== null && !this.#stopped;
  }

  async #pump(): Promise<void> {
    const reader = this.#reader;
    if (reader === null) return;
    for (;;) {
      let result: ReadableStreamReadResult<VideoFrame>;
      try {
        result = await reader.read();
      } catch {
        return;
      }
      if (result.done) return;
      const frame = result.value;
      const at = this.#now();
      try {
        this.size = { w: frame.displayWidth, h: frame.displayHeight };
        this.frames += 1;
        if (!this.#stopped) this.#onFrame(frame, at);
      } finally {
        frame.close();
      }
    }
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#reader?.cancel().catch(() => undefined);
    this.#track.stop();
  }
}

/**
 * The mic's levels: PCM from a clone of the track through the level meter,
 * 50 a second. Without `MediaStreamTrackProcessor`, an `AnalyserNode` read on
 * a 20 ms timer stands in (the last 20 ms of samples each time).
 */
export class LevelWatch {
  readonly #track: MediaStreamTrack;
  readonly #onLevels: (levels: number[]) => void;
  #reader: ReadableStreamDefaultReader<AudioData> | null = null;
  #meter: LevelMeter | null = null;
  #context: AudioContext | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #stopped = false;

  constructor(track: MediaStreamTrack, onLevels: (levels: number[]) => void) {
    this.#track = track.clone();
    this.#onLevels = onLevels;
    const Processor = processorOf<AudioData>();
    if (Processor !== null) {
      this.#reader = new Processor({ track: this.#track }).readable.getReader();
      void this.#pump();
    } else {
      this.#analyse();
    }
  }

  /** A partial 20 ms window is dropped (a pause). */
  reset(): void {
    this.#meter?.reset();
  }

  async #pump(): Promise<void> {
    const reader = this.#reader;
    if (reader === null) return;
    let planes: Float32Array[] = [];
    for (;;) {
      let result: ReadableStreamReadResult<AudioData>;
      try {
        result = await reader.read();
      } catch {
        return;
      }
      if (result.done) return;
      const data = result.value;
      try {
        if (this.#stopped) continue;
        if (this.#meter === null || this.#meter.sampleRate !== data.sampleRate) this.#meter = new LevelMeter(data.sampleRate);
        const frames = data.numberOfFrames;
        if (planes.length !== data.numberOfChannels || (planes[0]?.length ?? 0) < frames) {
          planes = Array.from({ length: data.numberOfChannels }, () => new Float32Array(frames));
        }
        const views = planes.map((plane, index) => {
          const view = plane.subarray(0, frames);
          data.copyTo(view, { planeIndex: index, format: "f32-planar" });
          return view;
        });
        const levels = this.#meter.push(views);
        if (levels.length > 0) this.#onLevels(levels);
      } finally {
        data.close();
      }
    }
  }

  #analyse(): void {
    try {
      const context = new AudioContext();
      this.#context = context;
      void context.resume();
      const source = context.createMediaStreamSource(new MediaStream([this.#track]));
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const window = Math.min(samples.length, Math.round(context.sampleRate / 50));
      this.#timer = setInterval(() => {
        if (this.#stopped) return;
        analyser.getFloatTimeDomainData(samples);
        this.#onLevels([rms(samples, samples.length - window, samples.length)]);
      }, 20);
    } catch {
      // (No levels: the meter stays flat and the speed plan hears no speech.)
    }
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#reader?.cancel().catch(() => undefined);
    if (this.#timer !== null) clearInterval(this.#timer);
    void this.#context?.close().catch(() => undefined);
    this.#track.stop();
  }
}

/** A still of a frame `width` px wide, kept for `thumb.jpg`. */
export class Still {
  readonly width: number;
  #canvas: OffscreenCanvas | null = null;

  constructor(width = 480) {
    this.width = width;
  }

  get taken(): boolean {
    return this.#canvas !== null;
  }

  take(frame: CanvasImageSource & { displayWidth: number; displayHeight: number }): void {
    if (typeof OffscreenCanvas === "undefined" || frame.displayWidth === 0) return;
    const height = Math.max(1, Math.round((this.width * frame.displayHeight) / frame.displayWidth));
    const canvas = this.#canvas !== null && this.#canvas.height === height ? this.#canvas : new OffscreenCanvas(this.width, height);
    const context = canvas.getContext("2d");
    if (context === null) return;
    context.drawImage(frame, 0, 0, this.width, height);
    this.#canvas = canvas;
  }

  async jpeg(quality = 0.82): Promise<Blob | null> {
    return this.#canvas === null ? null : this.#canvas.convertToBlob({ type: "image/jpeg", quality });
  }
}
