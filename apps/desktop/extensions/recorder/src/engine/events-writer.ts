/**
 * `events.jsonl` as it is recorded (docs/recorder.md §3, R7): the meta line
 * first, then what the person did and the engine's own `frame` lines, one
 * object a line, appended in 250 ms batches. Pure but for its timer; the sink
 * is whatever `open` gives (a `files.data.open(path, { append: true })`).
 *
 * The clock. Events arrive stamped with `runtime.now()` (epoch ms); a line's
 * `t` is ms of *media time* from `t0`: paused spans are taken out, as
 * mediabunny's `pause()` takes them out of the files, so `t` and the files'
 * timestamps are one axis. A `pause` line and its `resume` line carry the
 * same `t` — the seam. Whatever the page did while paused is not recorded,
 * but the last `nav`, `box`, `cursor`, `load` and `focus` of a pause are
 * written at the seam so the state after it is known. Events before `t0`
 * (the first frame) are dropped — but for the last of each of those same
 * kinds, written at t = 0: the subscription says where the view is and what
 * page it shows when it begins, which is during the countdown, and the
 * recording starts in that state.
 *
 * Order. Main delivers input in batches, a little late; frames come as they
 * arrive. Each batch is sorted by `t`, and lines younger than 300 ms of media
 * time wait for the next batch, so the file reads in order.
 */
import type { MetaEvent, RecordedEvent } from "../lib/types.js";

export interface AppendSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export const FLUSH_MS = 250;
export const REORDER_MS = 300;
/** Kept from a pause and written at its seam (the latest of each). */
const HELD_KINDS = new Set(["nav", "box", "cursor", "load", "focus"]);
/** Events that arrive before `t0` is known wait, up to this many. */
const EARLY_MAX = 4096;

/** An event as the host stamps it: `t` in epoch ms. */
export interface StampedEvent {
  t: number;
  k: string;
  [key: string]: unknown;
}

const encoder = new TextEncoder();

function concat(parts: readonly Uint8Array[], total: number): Uint8Array {
  if (parts.length === 1) return parts[0] as Uint8Array;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/**
 * Bytes appended to one file: `append` gathers, `flush` writes what was
 * gathered as one chunk (opening the file on the first), writes in order, one
 * at a time. A failed open or write goes to `onError` and is not retried.
 */
export class AppendLog {
  readonly #open: () => Promise<AppendSink>;
  readonly #onError: (error: unknown) => void;
  #sink: Promise<AppendSink> | null = null;
  #parts: Uint8Array[] = [];
  #bytes = 0;
  #tail: Promise<void> = Promise.resolve();
  #timer: ReturnType<typeof setInterval> | null = null;
  #closed = false;
  /** Bytes and chunks written so far. */
  written = 0;
  writes = 0;

  constructor(open: () => Promise<AppendSink>, onError: (error: unknown) => void = () => undefined) {
    this.#open = open;
    this.#onError = onError;
  }

  get closed(): boolean {
    return this.#closed;
  }

  append(bytes: Uint8Array): void {
    if (this.#closed || bytes.byteLength === 0) return;
    this.#parts.push(bytes);
    this.#bytes += bytes.byteLength;
  }

  /** Flush on a timer until closed. */
  every(ms: number): void {
    if (this.#timer !== null || this.#closed || ms <= 0) return;
    this.#timer = setInterval(() => void this.flush(), ms);
  }

  flush(): Promise<void> {
    if (this.#bytes === 0) return this.#tail;
    const chunk = concat(this.#parts, this.#bytes);
    this.#parts = [];
    this.#bytes = 0;
    this.#tail = this.#tail
      .then(async () => {
        this.#sink ??= this.#open();
        const sink = await this.#sink;
        await sink.write(chunk);
        this.written += chunk.byteLength;
        this.writes += 1;
      })
      .catch((error: unknown) => this.#onError(error));
    return this.#tail;
  }

  /** The last flush, then the file closed. */
  async close(): Promise<void> {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    await this.flush();
    if (this.#closed) return;
    this.#closed = true;
    if (this.#sink === null) return;
    try {
      await (await this.#sink).close();
    } catch (error) {
      this.#onError(error);
    }
  }

  /** Stop without writing what is gathered (a discard). */
  async abandon(): Promise<void> {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    this.#parts = [];
    this.#bytes = 0;
    this.#closed = true;
    await this.#tail;
    if (this.#sink !== null) await this.#sink.then((sink) => sink.close()).catch(() => undefined);
  }
}

const round = (ms: number): number => Math.round(ms * 10) / 10;

export interface EventsWriterOptions {
  /** `runtime.now()`: the clock events are stamped with. */
  now: () => number;
  /** 0 flushes only when asked. */
  flushMs?: number;
  reorderMs?: number;
  onError?: (error: unknown) => void;
}

export class EventsWriter {
  readonly log: AppendLog;
  /** Every line written after the meta, in order: what the solvers get at the end. */
  readonly events: RecordedEvent[] = [];
  readonly #now: () => number;
  readonly #flushMs: number;
  readonly #reorderMs: number;
  #t0: number | null = null;
  #meta: MetaEvent | null = null;
  #metaWritten = false;
  #early: StampedEvent[] = [];
  #pending: RecordedEvent[] = [];
  /** Paused spans so far, epoch ms [from, to). */
  readonly #spans: [number, number][] = [];
  #pausedAt: number | null = null;
  #pausedTotal = 0;
  readonly #held = new Map<string, StampedEvent>();
  /** The state before t0 (the latest of each held kind), written at t = 0. */
  readonly #before = new Map<string, StampedEvent>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #closed = false;

  constructor(open: () => Promise<AppendSink>, options: EventsWriterOptions) {
    this.#now = options.now;
    this.#flushMs = options.flushMs ?? FLUSH_MS;
    this.#reorderMs = options.reorderMs ?? REORDER_MS;
    this.log = new AppendLog(open, options.onError);
  }

  /** Epoch ms of t = 0, once the first frame set it. */
  get t0(): number | null {
    return this.#t0;
  }

  get meta(): MetaEvent | null {
    return this.#meta;
  }

  get paused(): boolean {
    return this.#pausedAt !== null;
  }

  /** Media ms at epoch `at`: from t0, paused spans (and a pause under way) taken out. */
  mediaTime(at: number): number {
    if (this.#t0 === null) return 0;
    const pausing = this.#pausedAt === null ? 0 : Math.max(0, at - this.#pausedAt);
    return Math.max(0, at - this.#t0 - this.#pausedTotal - pausing);
  }

  /** `t` for an epoch, or null when it fell inside a pause. Negative before t0. */
  rel(epoch: number): number | null {
    if (this.#t0 === null) return null;
    if (this.#pausedAt !== null && epoch >= this.#pausedAt) return null;
    let paused = 0;
    for (const [from, to] of this.#spans) {
      if (epoch >= to) paused += to - from;
      else if (epoch >= from) return null;
    }
    return round(epoch - this.#t0 - paused);
  }

  /** Set t = 0 (epoch ms): what waited is placed, and the batches begin. */
  start(t0: number): void {
    if (this.#t0 !== null || this.#closed) return;
    this.#t0 = t0;
    const early = this.#early;
    this.#early = [];
    for (const event of early) this.add(event);
    if (this.#flushMs > 0) this.#timer = setInterval(() => void this.flush(), this.#flushMs);
  }

  /** The meta line, written first (nothing is written before it is set). */
  setMeta(meta: Omit<MetaEvent, "t" | "k">): void {
    if (this.#metaWritten) return;
    this.#meta = { t: 0, k: "meta", ...meta } as MetaEvent;
  }

  /** An input event or the engine's own (`{ t: epoch, k: "frame" }`). */
  add(event: StampedEvent): void {
    if (this.#closed || typeof event.t !== "number" || !Number.isFinite(event.t)) return;
    if (this.#t0 === null) {
      if (this.#early.length < EARLY_MAX) this.#early.push(event);
      return;
    }
    const t = this.rel(event.t);
    if (t === null) {
      if (HELD_KINDS.has(event.k)) this.#held.set(event.k, event);
      return;
    }
    if (t < 0) {
      // (The page, the view's box, the cursor, a load, the focus as they stood when recording began: at t = 0.)
      const kept = this.#before.get(event.k);
      if (HELD_KINDS.has(event.k) && (kept === undefined || kept.t <= event.t)) this.#before.set(event.k, event);
      return;
    }
    this.#pending.push({ ...event, t } as RecordedEvent);
  }

  pause(at: number): void {
    if (this.#t0 === null || this.#pausedAt !== null || this.#closed) return;
    const t = this.rel(at);
    this.#pausedAt = at;
    if (t !== null && t >= 0) this.#pending.push({ t, k: "pause" });
  }

  resume(at: number): void {
    if (this.#pausedAt === null || this.#closed) return;
    const from = this.#pausedAt;
    const to = Math.max(from, at);
    this.#spans.push([from, to]);
    this.#pausedTotal += to - from;
    this.#pausedAt = null;
    const seam = this.rel(to);
    if (seam === null || seam < 0) return;
    this.#pending.push({ t: seam, k: "resume" });
    for (const event of this.#held.values()) this.#pending.push({ ...event, t: seam } as RecordedEvent);
    this.#held.clear();
  }

  /** Write a batch: the meta line if not yet, then the pending lines old enough (all of them when `final`). */
  flush(final = false): Promise<void> {
    if (this.#meta === null) return this.log.flush();
    if (!this.#metaWritten) {
      this.log.append(encoder.encode(JSON.stringify(this.#meta) + "\n"));
      this.#metaWritten = true;
    }
    if (this.#before.size > 0) {
      // (Ahead of anything else at t = 0: the sort below is stable.)
      this.#pending.unshift(...[...this.#before.values()].sort((a, b) => a.t - b.t).map((event) => ({ ...event, t: 0 }) as RecordedEvent));
      this.#before.clear();
    }
    if (this.#pending.length > 0) {
      // (Stable: lines of one `t` keep the order they came in.)
      this.#pending.sort((a, b) => a.t - b.t);
      const horizon = final ? Infinity : this.mediaTime(this.#now()) - this.#reorderMs;
      let count = 0;
      while (count < this.#pending.length && (this.#pending[count] as RecordedEvent).t <= horizon) count += 1;
      if (count > 0) {
        const ready = this.#pending.splice(0, count);
        let text = "";
        for (const event of ready) {
          text += JSON.stringify(event) + "\n";
          this.events.push(event);
        }
        this.log.append(encoder.encode(text));
      }
    }
    return this.log.flush();
  }

  /** Everything written and the file closed. Without a meta line (no frame ever came) nothing is. */
  async close(): Promise<void> {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    if (this.#closed) return;
    await this.flush(true);
    this.#closed = true;
    await this.log.close();
    this.events.sort((a, b) => a.t - b.t);
  }

  async abandon(): Promise<void> {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    this.#closed = true;
    this.#pending = [];
    await this.log.abandon();
  }
}
