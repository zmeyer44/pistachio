/**
 * The mic's level log (`mic.levels`, docs/recorder.md R7): one Float32 RMS
 * (linear, 0..1) every 20 ms of the mic's own timeline, computed from the PCM
 * the mic track delivers — the speed plan reads speech from it (> −40 dBFS),
 * the editor draws the waveform from it, the pill draws its meter. Pure.
 */

export const LEVEL_HZ = 50;

/** Root mean square of `samples[from, to)`. */
export function rms(samples: ArrayLike<number>, from = 0, to = samples.length): number {
  const n = to - from;
  if (n <= 0) return 0;
  let sum = 0;
  for (let index = from; index < to; index += 1) {
    const value = samples[index] as number;
    sum += value * value;
  }
  return Math.sqrt(sum / n);
}

export function toDbfs(level: number): number {
  return 20 * Math.log10(Math.max(level, 1e-9));
}

/**
 * PCM in, one level per 1/50 s out. Channels are averaged in power (the RMS
 * over every sample of every channel in the window). A window spans
 * `round(sampleRate / 50)` frames and carries over between chunks.
 */
export class LevelMeter {
  readonly sampleRate: number;
  readonly window: number;
  #sum = 0;
  #count = 0;
  #frames = 0;

  constructor(sampleRate: number) {
    if (!(sampleRate > 0)) throw new RangeError("sampleRate must be positive");
    this.sampleRate = sampleRate;
    this.window = Math.max(1, Math.round(sampleRate / LEVEL_HZ));
  }

  /** One chunk: a buffer per channel, all the same length. Answers the levels it completed. */
  push(channels: readonly ArrayLike<number>[]): number[] {
    const out: number[] = [];
    const frames = channels.reduce((min, channel) => Math.min(min, channel.length), Infinity);
    if (channels.length === 0 || !Number.isFinite(frames)) return out;
    for (let frame = 0; frame < frames; frame += 1) {
      for (const channel of channels) {
        const value = channel[frame] as number;
        this.#sum += value * value;
        this.#count += 1;
      }
      this.#frames += 1;
      if (this.#frames === this.window) {
        out.push(Math.sqrt(this.#sum / this.#count));
        this.#sum = 0;
        this.#count = 0;
        this.#frames = 0;
      }
    }
    return out;
  }

  /** Drop a partial window (a pause: the next level starts fresh, as the file's audio does). */
  reset(): void {
    this.#sum = 0;
    this.#count = 0;
    this.#frames = 0;
  }
}

const BARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
/** The meter's floor: quieter than this draws the lowest bar. */
export const METER_FLOOR_DB = -60;

/** One bar for a level: −60 dBFS and under is ▁, 0 dBFS is █. */
export function barFor(level: number): string {
  const db = toDbfs(level);
  const unit = Math.min(1, Math.max(0, (db - METER_FLOOR_DB) / -METER_FLOOR_DB));
  return BARS[Math.min(BARS.length - 1, Math.floor(unit * BARS.length))] as string;
}

/**
 * The pill's four-bar meter (`▁▃▅▂`): the last second of levels in `bars`
 * equal slices, each drawn at its peak. Fewer levels than bars pad with ▁.
 */
export function meterBars(levels: ArrayLike<number>, bars = 4, span = LEVEL_HZ): string {
  const end = levels.length;
  const start = Math.max(0, end - span);
  const per = Math.max(1, Math.ceil((end - start) / bars));
  let text = "";
  for (let bar = 0; bar < bars; bar += 1) {
    const from = start + bar * per;
    let peak = 0;
    for (let index = from; index < Math.min(end, from + per); index += 1) peak = Math.max(peak, levels[index] as number);
    text += barFor(peak);
  }
  return text;
}

/** A growable Float32 list (an hour at 50 Hz is 180 000 levels, 720 KB). */
export class LevelList {
  #data = new Float32Array(1024);
  #length = 0;

  get length(): number {
    return this.#length;
  }

  push(values: readonly number[]): void {
    if (this.#length + values.length > this.#data.length) {
      const grown = new Float32Array(Math.max(this.#data.length * 2, this.#length + values.length));
      grown.set(this.#data.subarray(0, this.#length));
      this.#data = grown;
    }
    this.#data.set(values, this.#length);
    this.#length += values.length;
  }

  /** A view of the levels so far (valid until the next push). */
  view(): Float32Array {
    return this.#data.subarray(0, this.#length);
  }

  /** A copy, for the solver. */
  toArray(): Float32Array {
    return this.#data.slice(0, this.#length);
  }
}

/** Little-endian Float32 bytes, as `mic.levels` holds them. */
export function levelBytes(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return bytes;
}
