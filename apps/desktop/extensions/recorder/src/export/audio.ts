/**
 * The export's sound (docs/recorder.md §5): the mic (`mic.m4a`) and the
 * page's sound (the screen file's audio track), decoded, carried through the
 * time map, mixed with the project's gains, and handed out as 48 kHz stereo
 * blocks for the AAC (MP4) or Opus (WebM) encoder.
 *
 * Every output sample reads its source at `toSource(tOut)`, interpolated
 * linearly, which also resamples 44.1 kHz page sound to 48 kHz. Then:
 *
 * - **Cuts** cut both the mic and the page's sound.
 * - **Sped-up stretches** follow `audio.muteSpedUp` (*Mute while sped up*,
 *   `soundPlan`), for the mic as for the page's sound, as the editor's preview
 *   plays them. On (the default), both are DROPPED there, never played on at
 *   1× past the picture: the speed planner never speeds up a stretch where the
 *   mic hears speech, so what the mic loses is room tone, and a person who
 *   sped up their own speech by hand hears silence rather than chipmunks.
 *   Off, both play sped up in step with the picture, resampled naively (the
 *   pitch rises with the rate; the preview keeps it).
 * - Every silence and every cut is entered and left with a 30 ms raised-cosine
 *   fade, so nothing clicks.
 */
import type { AudioSampleSink, InputAudioTrack } from "mediabunny";
import { AudioSampleSink as Sink } from "mediabunny";
import type { Project, TimeMap } from "../lib/types.js";
import { AUDIO_CHANNELS, AUDIO_SAMPLE_RATE } from "./video.js";

export const FADE_SECONDS = 0.03;
/** A rate above this counts as sped up. */
export const SPED_UP = 1.001;
/** Source time advancing faster than this against output time is a cut (speed segments stop at 16×). */
export const CUT_RATE = 32;
/** The resolution the time map is scanned at for sped-up stretches and cuts, seconds. */
export const SCAN_STEP = 0.001;
export const BLOCK_FRAMES = 2048;

/** Where the output's sound must fall silent, in output seconds. */
export interface SilentZones {
  /** Stretches where the time map runs faster than real time. */
  spedUp: [number, number][];
  /** Instants where the source jumps (a cut). */
  cuts: number[];
}

/** Scans the time map at 1 ms for the stretches it speeds up and the instants it cuts. */
export function silentZones(map: Pick<TimeMap, "toSource" | "rateAt" | "duration">, step = SCAN_STEP): SilentZones {
  const spedUp: [number, number][] = [];
  const cuts: number[] = [];
  let openAt: number | null = null;
  let previous = map.toSource(0);
  const steps = Math.ceil(map.duration / step);
  for (let k = 0; k <= steps; k++) {
    const t = Math.min(map.duration, k * step);
    const rate = map.rateAt(t);
    const fast = !(rate <= SPED_UP); // NaN and Infinity count as fast
    if (fast && openAt === null) openAt = t;
    if (!fast && openAt !== null) {
      spedUp.push([openAt, t]);
      openAt = null;
    }
    if (k > 0) {
      const source = map.toSource(t);
      if (source - previous > step * CUT_RATE) cuts.push(t - step / 2);
      previous = source;
    }
  }
  if (openAt !== null) spedUp.push([openAt, map.duration]);
  return { spedUp, cuts };
}

/** The intervals one source is silent over: cuts always, sped-up stretches when `muteSpedUp`. Sorted and merged. */
export function silentIntervals(zones: SilentZones, muteSpedUp: boolean): [number, number][] {
  const all: [number, number][] = zones.cuts.map((t) => [t, t] as [number, number]);
  if (muteSpedUp) all.push(...zones.spedUp.map(([a, b]) => [a, b] as [number, number]));
  all.sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const [a, b] of all) {
    const last = merged[merged.length - 1];
    if (last !== undefined && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

/** A source's place in the mix: its gain and the output intervals it is silent over. */
export interface SoundPlan {
  gain: number;
  silences: [number, number][];
}

/**
 * The mic's and the page's places in the mix from the project's `audio`: both
 * follow *Mute while sped up* — silent over a speed-up when it is on, read
 * through the map (sped up in step) when it is off, as the editor's preview
 * plays them — and both are cut where the map cuts. A source at gain 0 is
 * left out (null).
 */
export function soundPlan(audio: Pick<Project["audio"], "mic" | "page" | "muteSpedUp">, zones: SilentZones): { mic: SoundPlan | null; page: SoundPlan | null } {
  const silences = silentIntervals(zones, audio.muteSpedUp);
  return {
    mic: audio.mic > 0 ? { gain: audio.mic, silences } : null,
    page: audio.page > 0 ? { gain: audio.page, silences } : null,
  };
}

/** The gain at `t`: 0 inside an interval, a raised-cosine ramp over `fade` on each side, 1 elsewhere. */
export class Envelope {
  #index = 0;
  readonly intervals: [number, number][];
  readonly fade: number;

  constructor(intervals: [number, number][], fade = FADE_SECONDS) {
    this.intervals = intervals;
    this.fade = fade;
  }

  /** Fastest when `t` only grows between calls (a moving index); still right when it does not. */
  at(t: number): number {
    const list = this.intervals;
    if (list.length === 0) return 1;
    // The first interval that ends after `t − fade`: the only one that can reach `t`.
    if (this.#index > 0 && (list[this.#index - 1] as [number, number])[1] > t - this.fade) this.#index = 0;
    while (this.#index < list.length && (list[this.#index] as [number, number])[1] <= t - this.fade) this.#index++;
    let gain = 1;
    for (let i = Math.max(0, this.#index - 1); i < list.length; i++) {
      const [a, b] = list[i] as [number, number];
      if (a - this.fade >= t) break;
      const distance = t < a ? a - t : t > b ? t - b : 0;
      gain = Math.min(gain, ramp(distance / this.fade));
    }
    return gain;
  }

  /** True when the whole span `[t0, t1]` is silent. */
  silentOver(t0: number, t1: number): boolean {
    for (const [a, b] of this.intervals) if (a <= t0 && b >= t1) return true;
    return false;
  }
}

function ramp(x: number): number {
  return x >= 1 ? 1 : x <= 0 ? 0 : 0.5 - 0.5 * Math.cos(Math.PI * x);
}

/** Decoded sound: a start time, a rate, one or two channels. */
export interface PcmBlock {
  timestamp: number;
  sampleRate: number;
  channels: Float32Array[];
}

/** Opens a forward stream of decoded blocks from about `from` (source seconds). */
export type PcmOpener = (from: number) => AsyncIterator<PcmBlock>;

/**
 * A forward window over a decoded source: `cover` decodes up to a time
 * (seeking instead when the time lies far ahead, as after a cut) and drops
 * what lies behind; `read` interpolates at any time inside it.
 */
export class PcmReader {
  #blocks: PcmBlock[] = [];
  #iterator: AsyncIterator<PcmBlock> | null = null;
  /** Where the stream was last opened from. */
  #origin = 0;
  #decodedTo = -Infinity;
  #ended = false;
  #cursor = 0;
  readonly open: PcmOpener;
  /** Seconds ahead of what was decoded past which `cover` seeks instead of decoding through. */
  readonly seekGap: number;

  constructor(open: PcmOpener, seekGap = 2) {
    this.open = open;
    this.seekGap = seekGap;
  }

  async cover(from: number, to: number): Promise<void> {
    const backward = from < this.#origin;
    const farAhead = !this.#ended && from > this.#decodedTo + this.seekGap;
    if (this.#iterator === null || backward || farAhead) await this.#seek(from);
    while (!this.#ended && this.#decodedTo < to) {
      const next = await (this.#iterator as AsyncIterator<PcmBlock>).next();
      if (next.done === true) {
        this.#ended = true;
        break;
      }
      const block = next.value;
      this.#blocks.push(block);
      this.#decodedTo = block.timestamp + (block.channels[0]?.length ?? 0) / block.sampleRate;
    }
    // Keep a little behind `from`: interpolation reads one sample back.
    let drop = 0;
    while (drop < this.#blocks.length - 1 && blockEnd(this.#blocks[drop] as PcmBlock) < from - 0.05) drop++;
    if (drop > 0) {
      this.#blocks.splice(0, drop);
      this.#cursor = 0;
    }
  }

  /** The source at `t` into `out[0]` (left) and `out[1]` (right); a mono source fills both; silence outside what was decoded. */
  read(t: number, out: Float32Array): void {
    const blocks = this.#blocks;
    if (this.#cursor >= blocks.length || (blocks[this.#cursor] as PcmBlock).timestamp > t) this.#cursor = 0;
    while (this.#cursor < blocks.length - 1 && blockEnd(blocks[this.#cursor] as PcmBlock) <= t) this.#cursor++;
    const block = blocks[this.#cursor];
    if (block === undefined || t < block.timestamp || t >= blockEnd(block)) {
      out[0] = 0;
      out[1] = 0;
      return;
    }
    const position = (t - block.timestamp) * block.sampleRate;
    const i = Math.floor(position);
    const frac = position - i;
    let following = blocks[this.#cursor + 1];
    if (following !== undefined && Math.abs(following.timestamp - blockEnd(block)) >= 1 / block.sampleRate) following = undefined;
    for (let c = 0; c < 2; c++) {
      const channel = (block.channels[c] ?? block.channels[0]) as Float32Array;
      const a = channel[i] ?? 0;
      const b = i + 1 < channel.length ? (channel[i + 1] as number) : (following?.channels[c] ?? following?.channels[0])?.[0] ?? a;
      out[c] = a + (b - a) * frac;
    }
  }

  async close(): Promise<void> {
    const iterator = this.#iterator;
    this.#iterator = null;
    this.#blocks = [];
    await iterator?.return?.();
  }

  async #seek(from: number): Promise<void> {
    await this.#iterator?.return?.();
    this.#blocks = [];
    this.#cursor = 0;
    this.#ended = false;
    this.#decodedTo = -Infinity;
    this.#origin = Math.max(0, from - 0.05);
    this.#iterator = this.open(this.#origin);
  }
}

function blockEnd(block: PcmBlock): number {
  return block.timestamp + (block.channels[0]?.length ?? 0) / block.sampleRate;
}

export interface MixSource {
  reader: PcmReader;
  gain: number;
  envelope: Envelope;
}

/** One block of the mix: 48 kHz, stereo, planar (left then right). */
export interface MixBlock {
  timestamp: number;
  frames: number;
  data: Float32Array;
}

/**
 * The mix, block after block, over the whole output. Each block is split
 * where the source jumps (a cut) so a reader never decodes the part left out;
 * a span a source is silent over is not read at all.
 */
export class AudioMixer {
  readonly total: number;
  #written = 0;
  readonly #positions = new Float64Array(BLOCK_FRAMES);
  readonly #sample = new Float32Array(2);

  readonly map: Pick<TimeMap, "toSource">;
  readonly sources: MixSource[];
  readonly sampleRate: number;

  /** `duration` is the output's, in seconds: the video's frame count over its fps, so both tracks end together. */
  constructor(map: Pick<TimeMap, "toSource">, sources: MixSource[], duration: number, sampleRate = AUDIO_SAMPLE_RATE) {
    this.map = map;
    this.sources = sources;
    this.sampleRate = sampleRate;
    this.total = Math.round(duration * sampleRate);
  }

  /** Output seconds mixed so far. */
  get time(): number {
    return this.#written / this.sampleRate;
  }

  get done(): boolean {
    return this.#written >= this.total;
  }

  async next(): Promise<MixBlock | null> {
    if (this.done) return null;
    const frames = Math.min(BLOCK_FRAMES, this.total - this.#written);
    const first = this.#written;
    const data = new Float32Array(frames * AUDIO_CHANNELS);
    const positions = this.#positions;
    for (let i = 0; i < frames; i++) positions[i] = this.map.toSource((first + i) / this.sampleRate);
    // Spans where the source runs on without a jump.
    const jump = (CUT_RATE * 4) / this.sampleRate;
    let spanStart = 0;
    for (let i = 1; i <= frames; i++) {
      if (i < frames && (positions[i] as number) - (positions[i - 1] as number) <= jump && (positions[i] as number) >= (positions[i - 1] as number)) continue;
      await this.#mixSpan(data, frames, first, spanStart, i);
      spanStart = i;
    }
    for (let i = 0; i < data.length; i++) {
      const v = data[i] as number;
      data[i] = v > 1 ? 1 : v < -1 ? -1 : v;
    }
    this.#written += frames;
    return { timestamp: first / this.sampleRate, frames, data };
  }

  async close(): Promise<void> {
    for (const source of this.sources) await source.reader.close();
  }

  async #mixSpan(data: Float32Array, frames: number, first: number, from: number, to: number): Promise<void> {
    const positions = this.#positions;
    const t0 = (first + from) / this.sampleRate;
    const t1 = (first + to - 1) / this.sampleRate;
    const p0 = positions[from] as number;
    const p1 = positions[to - 1] as number;
    for (const source of this.sources) {
      if (source.envelope.silentOver(t0, t1)) continue;
      await source.reader.cover(p0, p1 + 2 / this.sampleRate);
      for (let i = from; i < to; i++) {
        const gain = source.gain * source.envelope.at((first + i) / this.sampleRate);
        if (gain === 0) continue;
        source.reader.read(positions[i] as number, this.#sample);
        data[i] = (data[i] as number) + (this.#sample[0] as number) * gain;
        data[frames + i] = (data[frames + i] as number) + (this.#sample[1] as number) * gain;
      }
    }
  }
}

/**
 * A `PcmOpener` over a decoded mediabunny track: each `AudioSample` copied out
 * as float planes, then closed. A file that starts `offset` seconds into the
 * source (the mic's, the meta line's `offsets`) has its blocks moved onto the
 * source clock, so the reader is asked in source seconds.
 */
export function trackOpener(track: InputAudioTrack, offset = 0): PcmOpener {
  const sink: AudioSampleSink = new Sink(track);
  return (from) => {
    const samples = sink.samples(Math.max(0, from - offset));
    return {
      async next(): Promise<IteratorResult<PcmBlock>> {
        const result = await samples.next();
        if (result.done === true) return { done: true, value: undefined };
        const sample = result.value;
        try {
          const channels: Float32Array[] = [];
          for (let c = 0; c < Math.min(2, sample.numberOfChannels); c++) {
            const plane = new Float32Array(sample.numberOfFrames);
            sample.copyTo(plane, { planeIndex: c, format: "f32-planar" });
            channels.push(plane);
          }
          return { done: false, value: { timestamp: sample.timestamp + offset, sampleRate: sample.sampleRate, channels } };
        } finally {
          sample.close();
        }
      },
      async return(): Promise<IteratorResult<PcmBlock>> {
        await samples.return(undefined);
        return { done: true, value: undefined };
      },
    };
  };
}
