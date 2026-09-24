/**
 * "Read aloud" for selected page text.
 *
 * Audio is synthesized by a speech model through the AI SDK when this Mac
 * is signed in, otherwise by the operating system's own voice — in pieces,
 * so the first sentences play while the rest is still being spoken. A clip
 * is exposed at `pistachio://read-aloud/<id>`: a small page whose `<audio>`
 * element streams the pieces through Media Source Extensions as they land
 * (or, for a format MSE cannot take, waits for the whole clip the way it
 * used to). That page opens as a background tab, so the existing tab media
 * observer reports it and the sidebar media stack shows the ordinary card
 * (play/pause, seek, dismiss) without a second player implementation.
 *
 * Each piece's audio is measured here, so the card's source page can light
 * the words as the voice reaches them (@pistachio/shell-contracts/read-aloud).
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSpeech, type SpeechModel } from "ai";
import type { ReadAloudPieceTiming } from "@pistachio/shell-contracts/read-aloud";
import { configuredSpeechModel } from "./model-provider";

/**
 * One synthesis request. The first piece is short so the voice starts within
 * a breath or two; the rest are longer, though still small enough that the
 * word timing inferred from them stays close (a piece re-anchors it).
 */
export const READ_ALOUD_CHUNK_CHARS = 1_500;
export const READ_ALOUD_FIRST_CHUNK_CHARS = 300;
/** Reader view speaks a whole article; this is where even that stops. */
export const READ_ALOUD_MAX_ARTICLE_CHARS = 60_000;
const DEFAULT_VOICE = "alloy";
/** Clips kept in memory; the oldest goes when a new one arrives. */
const CLIP_LIMIT = 8;
const REMOTE_TIMEOUT_MS = 60_000;
const LOCAL_TIMEOUT_MS = 120_000;
/** A piece that fails is tried once more after this, then the clip stops early. */
const RETRY_DELAY_MS = 1_000;
/** A page waiting for the next piece is answered "not yet" after this long, and asks again. */
const WAIT_LIMIT_MS = 20_000;
/** Spoken characters per second, for a piece whose audio cannot be measured. */
const FALLBACK_CHARS_PER_SECOND = 15;

export interface ReadAloudRequest {
  text: string;
  /** Where the text came from, shown on the media card. */
  sourceTitle: string;
  sourceUrl: string;
  faviconUrl: string | null;
  /**
   * Optional total text limit. Selections are read in full by default;
   * reader view opts into READ_ALOUD_MAX_ARTICLE_CHARS.
   */
  maxChars?: number;
}

/** One spoken piece of a clip: its audio, the text span it speaks, and how long it plays. */
export interface ReadAloudPiece extends ReadAloudPieceTiming {
  audio: Uint8Array;
}

export interface ReadAloudClip {
  id: string;
  mediaType: string;
  /** "model" when a speech model produced the audio, "device" for the OS voice. */
  engine: "model" | "device";
  /** The request, its `text` prepared (whitespace collapsed, limit applied). */
  request: ReadAloudRequest;
  /** The pieces spoken so far, in order. */
  pieces: ReadAloudPiece[];
  /** No more pieces are coming: every one was spoken, or synthesis stopped with `error`. */
  done: boolean;
  error: string | null;
}

export interface SpeechSynthesizer {
  synthesize(text: string, signal: AbortSignal): Promise<{ audio: Uint8Array; mediaType: string }>;
}

/** Speech via the AI SDK, or null when this Mac is not signed in. */
export function modelSynthesizer(
  env: NodeJS.ProcessEnv = process.env,
  speechModel: () => SpeechModel | null = configuredSpeechModel,
): SpeechSynthesizer | null {
  // E2E runs stay offline unless they opt into live agents, like the memory embedder.
  if (env["PISTACHIO_E2E"] === "1" && env["PISTACHIO_AGENT_LIVE"] !== "1") return null;
  const model = speechModel();
  if (model === null) return null;
  const voice = env["PISTACHIO_TTS_VOICE"]?.trim() || DEFAULT_VOICE;
  return {
    async synthesize(text, signal) {
      const result = await generateSpeech({
        model,
        text,
        voice,
        outputFormat: "mp3",
        abortSignal: signal,
      });
      return {
        audio: result.audio.uint8Array,
        mediaType: result.audio.mediaType || "audio/mpeg",
      };
    },
  };
}

/**
 * Speech via the operating system's own synthesizer. macOS writes AAC in an
 * ADTS stream, which the player can stream piece by piece; the others write
 * WAV, which it plays once the clip is whole.
 */
export function deviceSynthesizer(platform: NodeJS.Platform = process.platform): SpeechSynthesizer {
  return {
    async synthesize(text, signal) {
      const dir = await mkdtemp(join(tmpdir(), "pistachio-read-aloud-"));
      const aac = platform === "darwin";
      const output = join(dir, aac ? "speech.aac" : "speech.wav");
      try {
        await runDeviceVoice(platform, text, output, signal);
        return { audio: new Uint8Array(await readFile(output)), mediaType: aac ? "audio/aac" : "audio/wav" };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

async function runDeviceVoice(
  platform: NodeJS.Platform,
  text: string,
  output: string,
  signal: AbortSignal,
): Promise<void> {
  // Text always travels through stdin, never as an argument.
  if (platform === "darwin") {
    await runWithStdin("say", ["-o", output, "--file-format=adts", "--data-format=aac", "-f", "-"], text, signal);
    return;
  }
  if (platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Speech",
      "$text = [Console]::In.ReadToEnd()",
      "$speech = New-Object System.Speech.Synthesis.SpeechSynthesizer",
      `$speech.SetOutputToWaveFile('${output.replace(/'/gu, "''")}')`,
      "$speech.Speak($text)",
      "$speech.Dispose()",
    ].join("; ");
    await runWithStdin("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], text, signal);
    return;
  }
  for (const binary of ["espeak-ng", "espeak"]) {
    try {
      await runWithStdin(binary, ["-w", output, "--stdin"], text, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error("No on-device speech synthesizer was found (install espeak-ng).");
}

function runWithStdin(command: string, args: string[], input: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { signal, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}`));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/**
 * Collapse runs of whitespace, limiting length only when explicitly requested.
 * Paragraph breaks survive as a single newline: the splitter uses them as its
 * best seam, and a synthesizer reads them as a pause.
 */
export function prepareReadAloudText(raw: string, limit?: number): string {
  const text = raw
    .replace(/\r\n?/gu, "\n")
    .replace(/[^\S\n]+/gu, " ")
    .replace(/ ?\n[ \n]*/gu, "\n")
    .trim();
  if (limit === undefined || text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const boundary = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"));
  return boundary > limit / 2 ? cut.slice(0, boundary + 1) : cut;
}

/** A piece of the text to speak, as a character span of it. */
export interface SpeechSpan {
  start: number;
  end: number;
}

/**
 * Break prepared text into spans no longer than `limit` (the first no longer
 * than `firstLimit`), preferring a paragraph break, then a sentence end, then
 * a word gap. A span is never cut mid-word, so the joined clip has no clipped
 * syllable at a seam. Spans are trimmed: whitespace between them belongs to
 * neither.
 */
export function splitForSpeechSpans(
  text: string,
  limit: number = READ_ALOUD_CHUNK_CHARS,
  firstLimit: number = limit,
): SpeechSpan[] {
  const spans: SpeechSpan[] = [];
  const push = (start: number, end: number): void => {
    let from = start;
    let to = end;
    while (from < to && /\s/u.test(text[from] ?? "")) from += 1;
    while (to > from && /\s/u.test(text[to - 1] ?? "")) to -= 1;
    if (to > from) spans.push({ start: from, end: to });
  };
  let cursor = 0;
  while (cursor < text.length && /\s/u.test(text[cursor] ?? "")) cursor += 1;
  while (cursor < text.length) {
    const cap = Math.max(1, spans.length === 0 ? Math.min(firstLimit, limit) : limit);
    if (text.length - cursor <= cap) {
      push(cursor, text.length);
      break;
    }
    const window = text.slice(cursor, cursor + cap);
    const seam = [
      window.lastIndexOf("\n"),
      Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? ")) + 1,
      window.lastIndexOf(" "),
    ].find((index) => index > cap / 3);
    const cut = seam === undefined || seam <= 0 ? cap : seam;
    push(cursor, cursor + cut);
    cursor += cut;
    while (cursor < text.length && /\s/u.test(text[cursor] ?? "")) cursor += 1;
  }
  return spans;
}

/** The pieces of `splitForSpeechSpans`, as text. */
export function splitForSpeech(text: string, limit: number = READ_ALOUD_CHUNK_CHARS, firstLimit: number = limit): string[] {
  return splitForSpeechSpans(text, limit, firstLimit).map((span) => text.slice(span.start, span.end));
}

/* ------------------------------------------------------------------ */
/* Reading the audio                                                   */
/* ------------------------------------------------------------------ */

function readAscii(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset] ?? 0, bytes[offset + 1] ?? 0, bytes[offset + 2] ?? 0, bytes[offset + 3] ?? 0);
}

/** The `fmt ` and `data` payloads of a RIFF/WAVE file, or null if it is not one. */
function wavParts(bytes: Uint8Array): { format: Uint8Array; data: Uint8Array } | null {
  if (bytes.byteLength < 12 || readAscii(bytes, 0) !== "RIFF" || readAscii(bytes, 8) !== "WAVE") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format: Uint8Array | null = null;
  let data: Uint8Array | null = null;
  for (let offset = 12; offset + 8 <= bytes.byteLength; ) {
    const id = readAscii(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + size > bytes.byteLength) break;
    if (id === "fmt ") format = bytes.subarray(start, start + size);
    if (id === "data") data = bytes.subarray(start, start + size);
    // Chunks are word-aligned: an odd size carries a pad byte.
    offset = start + size + (size % 2);
  }
  return format === null || data === null ? null : { format, data };
}

/** One WAV file from several that share a format. */
function joinWav(parts: Uint8Array[]): Uint8Array | null {
  const parsed = parts.map(wavParts);
  if (parsed.some((part) => part === null)) return null;
  const pieces = parsed as Array<{ format: Uint8Array; data: Uint8Array }>;
  const first = pieces[0];
  if (first === undefined) return null;
  const sameFormat = pieces.every(
    (piece) =>
      piece.format.byteLength === first.format.byteLength &&
      piece.format.every((byte, index) => byte === first.format[index]),
  );
  if (!sameFormat) return null;
  const dataLength = pieces.reduce((total, piece) => total + piece.data.byteLength, 0);
  const formatLength = first.format.byteLength;
  const out = new Uint8Array(12 + 8 + formatLength + 8 + dataLength);
  const view = new DataView(out.buffer);
  const write = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) out[offset + index] = text.charCodeAt(index);
  };
  write(0, "RIFF");
  view.setUint32(4, 4 + 8 + formatLength + 8 + dataLength, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, formatLength, true);
  out.set(first.format, 20);
  write(20 + formatLength, "data");
  view.setUint32(24 + formatLength, dataLength, true);
  let cursor = 28 + formatLength;
  for (const piece of pieces) {
    out.set(piece.data, cursor);
    cursor += piece.data.byteLength;
  }
  return out;
}

/** Bytes of an MP3 without its ID3v2 header or ID3v1 trailer. */
function mp3Frames(bytes: Uint8Array): Uint8Array {
  let start = 0;
  if (bytes.byteLength > 10 && readAscii(bytes, 0).startsWith("ID3")) {
    // A synchsafe 28-bit size in the four bytes at offset 6.
    const size =
      ((bytes[6] ?? 0) & 0x7f) * 0x200000 +
      ((bytes[7] ?? 0) & 0x7f) * 0x4000 +
      ((bytes[8] ?? 0) & 0x7f) * 0x80 +
      ((bytes[9] ?? 0) & 0x7f);
    start = Math.min(bytes.byteLength, 10 + size);
  }
  let end = bytes.byteLength;
  if (end - start >= 128 && readAscii(bytes, end - 128).startsWith("TAG")) end -= 128;
  return bytes.subarray(start, end);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.byteLength;
  }
  return out;
}

/** kbit/s by MPEG version (1, 2, 2.5), layer (1, 2, 3) and bitrate index. */
const MP3_BITRATES: Record<string, number[]> = {
  "1-1": [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  "1-2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  "1-3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  "2-1": [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  "2-2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  "2-3": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_SAMPLE_RATES: Record<string, number[]> = {
  "1": [44_100, 48_000, 32_000],
  "2": [22_050, 24_000, 16_000],
  "2.5": [11_025, 12_000, 8_000],
};
const AAC_SAMPLE_RATES = [96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8_000, 7_350];

/** Seconds of audio in an MPEG audio stream, walking its frame headers. */
function mp3Seconds(bytes: Uint8Array): number | null {
  const frames = mp3Frames(bytes);
  let seconds = 0;
  let counted = 0;
  for (let offset = 0; offset + 4 <= frames.byteLength; ) {
    const b1 = frames[offset] ?? 0;
    const b2 = frames[offset + 1] ?? 0;
    const b3 = frames[offset + 2] ?? 0;
    if (b1 !== 0xff || (b2 & 0xe0) !== 0xe0) {
      offset += 1;
      continue;
    }
    const versionBits = (b2 >> 3) & 0x03;
    const layerBits = (b2 >> 1) & 0x03;
    const bitrateIndex = (b3 >> 4) & 0x0f;
    const rateIndex = (b3 >> 2) & 0x03;
    const padding = (b3 >> 1) & 0x01;
    const version = versionBits === 3 ? "1" : versionBits === 2 ? "2" : versionBits === 0 ? "2.5" : null;
    const layer = layerBits === 3 ? 1 : layerBits === 2 ? 2 : layerBits === 1 ? 3 : null;
    if (version === null || layer === null || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) {
      offset += 1;
      continue;
    }
    const bitrate = (MP3_BITRATES[`${version === "1" ? "1" : "2"}-${String(layer)}`]?.[bitrateIndex] ?? 0) * 1_000;
    const sampleRate = MP3_SAMPLE_RATES[version]?.[rateIndex] ?? 0;
    if (bitrate === 0 || sampleRate === 0) {
      offset += 1;
      continue;
    }
    const samples = layer === 1 ? 384 : layer === 2 || version === "1" ? 1_152 : 576;
    const length =
      layer === 1
        ? Math.floor((12 * bitrate) / sampleRate + padding) * 4
        : Math.floor((samples / 8) * bitrate / sampleRate + padding);
    if (length <= 4) {
      offset += 1;
      continue;
    }
    seconds += samples / sampleRate;
    counted += 1;
    offset += length;
  }
  return counted === 0 ? null : seconds;
}

/** Seconds of audio in an AAC ADTS stream. */
function aacSeconds(bytes: Uint8Array): number | null {
  let seconds = 0;
  let counted = 0;
  for (let offset = 0; offset + 7 <= bytes.byteLength; ) {
    const b1 = bytes[offset] ?? 0;
    const b2 = bytes[offset + 1] ?? 0;
    if (b1 !== 0xff || (b2 & 0xf6) !== 0xf0) {
      offset += 1;
      continue;
    }
    const b3 = bytes[offset + 2] ?? 0;
    const b4 = bytes[offset + 3] ?? 0;
    const b5 = bytes[offset + 4] ?? 0;
    const b6 = bytes[offset + 5] ?? 0;
    const b7 = bytes[offset + 6] ?? 0;
    const sampleRate = AAC_SAMPLE_RATES[(b3 >> 2) & 0x0f] ?? 0;
    const length = ((b4 & 0x03) << 11) | (b5 << 3) | (b6 >> 5);
    const blocks = (b7 & 0x03) + 1;
    if (sampleRate === 0 || length < 7) {
      offset += 1;
      continue;
    }
    seconds += (1_024 * blocks) / sampleRate;
    counted += 1;
    offset += length;
  }
  return counted === 0 ? null : seconds;
}

/** Seconds of audio in a WAV file: its data over its byte rate. */
function wavSeconds(bytes: Uint8Array): number | null {
  const parts = wavParts(bytes);
  if (parts === null || parts.format.byteLength < 16) return null;
  const view = new DataView(parts.format.buffer, parts.format.byteOffset, parts.format.byteLength);
  const byteRate = view.getUint32(8, true);
  return byteRate === 0 ? null : parts.data.byteLength / byteRate;
}

/**
 * How long a piece plays, read from its own bytes. Null for a format this
 * cannot read; the caller then estimates from the text.
 */
export function audioDurationSeconds(bytes: Uint8Array, mediaType: string): number | null {
  if (/wav/iu.test(mediaType)) return wavSeconds(bytes);
  if (/mpeg|mp3/iu.test(mediaType)) return mp3Seconds(bytes);
  if (/aac/iu.test(mediaType)) return aacSeconds(bytes);
  return null;
}

/**
 * Join the pieces of one clip into a single file. WAV is rebuilt around one
 * header; MPEG frames and ADTS frames concatenate directly once each piece's
 * ID3 tags are dropped. One file means one duration, so a player that takes
 * the clip whole keeps its seek bar and speed control.
 */
export function joinSpeechAudio(parts: Array<{ audio: Uint8Array; mediaType: string }>): {
  audio: Uint8Array;
  mediaType: string;
} {
  const first = parts[0];
  if (first === undefined) throw new Error("Nothing was synthesized.");
  if (parts.length === 1) return { audio: first.audio, mediaType: first.mediaType };
  const mediaType = first.mediaType;
  const bytes = parts.map((part) => part.audio);
  if (/wav/iu.test(mediaType)) {
    const joined = joinWav(bytes);
    // A file we cannot parse is left to the caller's first piece rather than corrupted.
    if (joined !== null) return { audio: joined, mediaType };
    return { audio: first.audio, mediaType };
  }
  if (/mpeg|mp3/iu.test(mediaType)) {
    return { audio: concatBytes(bytes.map(mp3Frames)), mediaType };
  }
  return { audio: concatBytes(bytes), mediaType };
}

/** The bytes of one piece as a media source buffer takes them: frames only, no tags. */
function streamablePiece(piece: ReadAloudPiece, mediaType: string): Uint8Array {
  return /mpeg|mp3/iu.test(mediaType) ? mp3Frames(piece.audio) : piece.audio;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

/* ------------------------------------------------------------------ */
/* The service                                                         */
/* ------------------------------------------------------------------ */

interface ClipRun {
  clip: ReadAloudClip;
  abort: AbortController;
  /** Pages waiting for the next piece (or the end). */
  waiters: Set<() => void>;
  /** The whole clip as one file, once it is done. */
  joined: { audio: Uint8Array; mediaType: string } | null;
}

export class ReadAloudService {
  readonly #runs = new Map<string, ClipRun>();
  readonly #model: () => SpeechSynthesizer | null;
  readonly #device: SpeechSynthesizer;
  readonly #progress = new Set<(clip: ReadAloudClip) => void>();
  readonly #retryDelayMs: number;

  constructor(
    options: {
      model?: () => SpeechSynthesizer | null;
      device?: SpeechSynthesizer;
      retryDelayMs?: number;
    } = {},
  ) {
    this.#model =
      options.model ??
      (() => modelSynthesizer());
    this.#device = options.device ?? deviceSynthesizer();
    this.#retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  }

  /** Told after every piece a clip gains, and when it is done. */
  onProgress(listener: (clip: ReadAloudClip) => void): () => void {
    this.#progress.add(listener);
    return () => this.#progress.delete(listener);
  }

  /**
   * Speak the first piece and remember the clip; resolves — with the page
   * URL that plays it — as soon as that piece exists, while the rest of the
   * text goes on being spoken in the background. `settled` resolves once no
   * more pieces are coming; it never rejects, and `clip(id)?.error` says
   * whether the clip stopped early.
   */
  async speak(
    request: ReadAloudRequest,
    signal?: AbortSignal,
  ): Promise<{ id: string; url: string; engine: ReadAloudClip["engine"]; settled: Promise<void> }> {
    const text = prepareReadAloudText(request.text, request.maxChars);
    if (text === "") throw new Error("Nothing to read aloud.");
    const spans = splitForSpeechSpans(text, READ_ALOUD_CHUNK_CHARS, READ_ALOUD_FIRST_CHUNK_CHARS);
    const first = spans[0];
    if (first === undefined) throw new Error("Nothing to read aloud.");

    const abort = new AbortController();
    const onOuterAbort = (): void => abort.abort(signal?.reason);
    if (signal?.aborted === true) throw new Error("Read aloud was cancelled.");
    signal?.addEventListener("abort", onOuterAbort, { once: true });

    const { synthesizer, engine, timeoutMs, audio, mediaType } = await this.#speakFirst(
      text.slice(first.start, first.end),
      abort.signal,
    );
    const id = randomUUID();
    const clip: ReadAloudClip = {
      id,
      mediaType,
      engine,
      request: { ...request, text },
      pieces: [pieceOf(audio, mediaType, first)],
      done: spans.length === 1,
      error: null,
    };
    const run: ClipRun = { clip, abort, waiters: new Set(), joined: null };
    this.#runs.set(id, run);
    while (this.#runs.size > CLIP_LIMIT) {
      const oldest = this.#runs.keys().next().value;
      if (oldest === undefined) break;
      this.abandon(oldest);
    }
    this.#notify(run);
    // Once the clip plays, only dismissing its card stops it (abandon).
    signal?.removeEventListener("abort", onOuterAbort);
    const settled = clip.done
      ? Promise.resolve()
      : this.#speakRest(run, synthesizer, timeoutMs, text, spans.slice(1));
    return { id, url: pageUrl(id), engine, settled };
  }

  clip(id: string): ReadAloudClip | null {
    return this.#runs.get(id)?.clip ?? null;
  }

  /** Stop speaking a clip and forget it: its card was dismissed, or it aged out. */
  abandon(id: string): void {
    const run = this.#runs.get(id);
    if (run === undefined) return;
    this.#runs.delete(id);
    run.abort.abort(new Error("Read aloud was dismissed."));
    if (!run.clip.done) {
      run.clip.done = true;
      run.clip.error ??= "Read aloud was dismissed.";
    }
    for (const waiter of run.waiters) waiter();
    run.waiters.clear();
  }

  /**
   * Serve `pistachio://read-aloud/...`: the player page, one piece of a clip
   * (waiting for it if it is still being spoken), the clip's state, or the
   * whole clip as one file.
   */
  respond(url: URL, headers?: Headers): Response | Promise<Response> | null {
    if (url.host !== "read-aloud") return null;
    const match = /^\/([0-9a-f-]{36})(?:\/(audio|state|piece\/(\d+)))?$/u.exec(url.pathname);
    const run = match === null ? undefined : this.#runs.get(match[1] ?? "");
    if (run === undefined) return new Response("Not found", { status: 404 });
    const kind = match?.[2];
    if (kind === undefined) {
      return new Response(readAloudPageHtml(run.clip), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (kind === "audio") return audioResponse(this.#joined(run), headers?.get("range") ?? null);
    if (kind === "state") {
      const after = Number(url.searchParams.get("after") ?? "-1");
      return this.#whenPast(run, Number.isFinite(after) ? after : -1, () => stateResponse(run.clip));
    }
    const index = Number(match?.[3] ?? "");
    return this.#whenPast(run, index, () => pieceResponse(run.clip, index));
  }

  /** Answer once `run` has more than `count` pieces or is done — or, after a while, "not yet". */
  #whenPast(run: ClipRun, count: number, answer: () => Response): Response | Promise<Response> {
    if (run.clip.pieces.length > count || run.clip.done) return answer();
    return new Promise<Response>((resolve) => {
      const waiter = (): void => {
        clearTimeout(timer);
        run.waiters.delete(waiter);
        resolve(this.#runs.get(run.clip.id) === run ? answer() : new Response("Not found", { status: 404 }));
      };
      const timer = setTimeout(() => {
        run.waiters.delete(waiter);
        resolve(new Response(null, { status: 202, headers: { "cache-control": "no-store" } }));
      }, WAIT_LIMIT_MS);
      timer.unref();
      run.waiters.add(waiter);
    });
  }

  #joined(run: ClipRun): { audio: Uint8Array; mediaType: string } {
    if (run.joined !== null) return run.joined;
    const joined = joinSpeechAudio(run.clip.pieces.map((piece) => ({ audio: piece.audio, mediaType: run.clip.mediaType })));
    if (run.clip.done) run.joined = joined;
    return joined;
  }

  #notify(run: ClipRun): void {
    for (const waiter of [...run.waiters]) waiter();
    for (const listener of [...this.#progress]) listener(run.clip);
  }

  /**
   * Speak the first piece, choosing the engine for the whole clip: the model
   * when it answers, else the device voice. A clip that switched engines
   * halfway would splice two voices — and two audio formats — into one stream.
   */
  async #speakFirst(
    text: string,
    signal: AbortSignal,
  ): Promise<{
    synthesizer: SpeechSynthesizer;
    engine: ReadAloudClip["engine"];
    timeoutMs: number;
    audio: Uint8Array;
    mediaType: string;
  }> {
    const model = this.#model();
    if (model !== null) {
      try {
        const spoken = await speakOne(model, text, signal, REMOTE_TIMEOUT_MS);
        return { synthesizer: model, engine: "model", timeoutMs: REMOTE_TIMEOUT_MS, ...spoken };
      } catch (error) {
        // A cancel is the user's call; only provider trouble falls through to the device voice.
        if (signal.aborted) throw error;
        console.warn("[read-aloud] speech model failed; using the device voice", error);
      }
    }
    const spoken = await speakOne(this.#device, text, signal, LOCAL_TIMEOUT_MS);
    return { synthesizer: this.#device, engine: "device", timeoutMs: LOCAL_TIMEOUT_MS, ...spoken };
  }

  /**
   * Speak the remaining pieces in order, one at a time — a provider's rate
   * limit is easier to respect than to recover from. A piece that fails is
   * tried once more; a second failure ends the clip where it is, with the
   * reason on the clip for the shell to show.
   */
  async #speakRest(
    run: ClipRun,
    synthesizer: SpeechSynthesizer,
    timeoutMs: number,
    text: string,
    spans: SpeechSpan[],
  ): Promise<void> {
    const { clip, abort } = run;
    try {
      for (const span of spans) {
        if (abort.signal.aborted) return;
        const piece = text.slice(span.start, span.end);
        let spoken: { audio: Uint8Array; mediaType: string };
        try {
          spoken = await speakOne(synthesizer, piece, abort.signal, timeoutMs);
        } catch (error) {
          if (abort.signal.aborted) return;
          console.warn("[read-aloud] a piece failed; trying once more", error);
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, this.#retryDelayMs);
            timer.unref();
          });
          if (abort.signal.aborted) return;
          spoken = await speakOne(synthesizer, piece, abort.signal, timeoutMs);
        }
        if (abort.signal.aborted) return;
        clip.pieces.push(pieceOf(spoken.audio, clip.mediaType, span));
        this.#notify(run);
      }
      clip.done = true;
    } catch (error) {
      if (abort.signal.aborted) return;
      console.error("[read-aloud] stopped early", error);
      clip.done = true;
      clip.error = error instanceof Error && error.message !== "" ? error.message : "The rest could not be spoken.";
    }
    this.#notify(run);
  }
}

async function speakOne(
  synthesizer: SpeechSynthesizer,
  text: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ audio: Uint8Array; mediaType: string }> {
  if (signal.aborted) throw new Error("Read aloud was cancelled.");
  return synthesizer.synthesize(text, AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]));
}

function pieceOf(audio: Uint8Array, mediaType: string, span: SpeechSpan): ReadAloudPiece {
  const measured = audioDurationSeconds(audio, mediaType);
  return {
    audio,
    charStart: span.start,
    charEnd: span.end,
    seconds: measured ?? (span.end - span.start) / FALLBACK_CHARS_PER_SECOND,
  };
}

/** What a clip's page can read of it: the pieces so far, and whether more are coming. */
export function clipState(clip: ReadAloudClip): {
  done: boolean;
  error: string | null;
  totalChars: number;
  pieces: ReadAloudPieceTiming[];
} {
  return {
    done: clip.done,
    error: clip.error,
    totalChars: clip.request.text.length,
    pieces: clip.pieces.map(({ charStart, charEnd, seconds }) => ({ charStart, charEnd, seconds })),
  };
}

function stateResponse(clip: ReadAloudClip): Response {
  return new Response(JSON.stringify(clipState(clip)), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** One piece for the player's source buffer; 204 once the clip has no more. */
function pieceResponse(clip: ReadAloudClip, index: number): Response {
  const piece = clip.pieces[index];
  if (piece === undefined) {
    return new Response(null, {
      status: 204,
      headers: {
        "cache-control": "no-store",
        ...(clip.error === null ? {} : { "x-read-aloud-error": encodeURIComponent(clip.error) }),
      },
    });
  }
  const bytes = streamablePiece(piece, clip.mediaType);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Response(new Blob([copy], { type: clip.mediaType }), {
    status: 200,
    headers: {
      "content-type": clip.mediaType,
      "content-length": String(copy.byteLength),
      "cache-control": "no-store",
      "x-read-aloud-chars": String(piece.charEnd),
      "x-read-aloud-total-chars": String(clip.request.text.length),
    },
  });
}

/**
 * A byte range from a `Range` header, or null when there is none. `invalid` is
 * a range the client asked for that this clip cannot satisfy (a 416).
 */
export function parseByteRange(header: string | null, size: number): { start: number; end: number } | null | "invalid" {
  if (header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (match === null) return "invalid";
  const [, rawStart = "", rawEnd = ""] = match;
  if (rawStart === "" && rawEnd === "") return "invalid";
  // "bytes=-500" is the last 500 bytes.
  const start = rawStart === "" ? Math.max(0, size - Number(rawEnd)) : Number(rawStart);
  const end = rawStart === "" ? size - 1 : rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isFinite(start) || start >= size || end < start) return "invalid";
  return { start, end };
}

/**
 * The clip's bytes, with the length and range support Chromium's media
 * pipeline needs. Without them it treats the response as an endless stream:
 * the duration reads as infinite, so the sidebar card shows "Live stream" and
 * offers neither seeking nor a playback speed.
 */
function audioResponse(clip: { audio: Uint8Array; mediaType: string }, rangeHeader: string | null): Response {
  const size = clip.audio.byteLength;
  const range = parseByteRange(rangeHeader, size);
  if (range === "invalid") {
    return new Response("Range not satisfiable", {
      status: 416,
      headers: { "content-range": `bytes */${size}`, "accept-ranges": "bytes", "cache-control": "no-store" },
    });
  }
  const start = range === null ? 0 : range.start;
  const end = range === null ? size - 1 : range.end;
  const length = size === 0 ? 0 : end - start + 1;
  // Copy into a plain ArrayBuffer so the Blob never aliases a shared buffer.
  const bytes = new Uint8Array(length);
  bytes.set(clip.audio.subarray(start, start + length));
  return new Response(new Blob([bytes], { type: clip.mediaType }), {
    status: range === null ? 200 : 206,
    headers: {
      "content-type": clip.mediaType,
      "content-length": String(length),
      "accept-ranges": "bytes",
      "cache-control": "no-store",
      ...(range === null ? {} : { "content-range": `bytes ${start}-${end}/${size}` }),
    },
  });
}

function pageUrl(id: string): string {
  return `pistachio://read-aloud/${id}`;
}

function preview(text: string): string {
  return text.length > 160 ? `${text.slice(0, 157).trimEnd()}…` : text;
}

/** Inline JSON must not be able to close the <script> that carries it. */
function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * The tab that plays a clip: an autoplaying `<audio>` fed piece by piece
 * through Media Source Extensions, plus Media Session metadata for the card.
 *
 * While pieces are still arriving the media source's duration is an
 * estimate — the spoken characters so far, scaled to the whole text — so the
 * card shows a seek bar and a speed control from the first second rather
 * than "Live stream"; the end of the stream settles it exactly. A format the
 * source buffer cannot take (WAV, from the Windows and Linux voices) plays
 * as one file once the clip is done, as every clip used to.
 */
export function readAloudPageHtml(clip: ReadAloudClip): string {
  const { request } = clip;
  let host = "";
  try {
    host = new URL(request.sourceUrl).host;
  } catch {
    host = "";
  }
  const title = `Read aloud · ${request.sourceTitle || host || "Selection"}`;
  const artwork = request.faviconUrl === null ? "" : `<link rel="icon" href="${escapeHtml(request.faviconUrl)}" />`;
  const metadata = inlineJson({
    title: "Read aloud",
    artist: request.sourceTitle || host,
    album: host,
    artwork: request.faviconUrl === null ? [] : [{ src: request.faviconUrl }],
  });
  const config = inlineJson({
    base: pageUrl(clip.id),
    mediaType: clip.mediaType,
    totalChars: request.text.length,
  });
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self' pistachio:; media-src 'self' pistachio: blob:; img-src 'self' pistachio: data: https:; style-src 'unsafe-inline'; script-src 'unsafe-inline'" />
    ${artwork}
    <title>${escapeHtml(title)}</title>
    <style>
      :root { color-scheme: light dark; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 15px/1.5 "Avenir Next", Avenir, system-ui, sans-serif; background: #f8f8f3; color: #17201b; }
      @media (prefers-color-scheme: dark) { body { background: #202225; color: #eceee9; } }
      main { max-width: 560px; padding: 32px; }
      h1 { margin: 0 0 6px; font-size: 20px; letter-spacing: -.02em; }
      .source { margin: 0 0 18px; opacity: .65; font-size: 13px; }
      audio { width: 100%; }
      .status { margin: 10px 0 0; min-height: 1.5em; font-size: 13px; opacity: .75; }
      blockquote { margin: 18px 0 0; padding-left: 14px; border-left: 3px solid rgba(127,127,127,.35); opacity: .8; }
    </style>
  </head>
  <body>
    <main>
      <h1>Read aloud</h1>
      <p class="source">${escapeHtml(request.sourceTitle || host)}</p>
      <audio id="player" controls autoplay data-engine="${clip.engine}" data-media-type="${escapeHtml(clip.mediaType)}"></audio>
      <p class="status" id="status"></p>
      <blockquote>${escapeHtml(preview(request.text))}</blockquote>
    </main>
    <script>
      if ("mediaSession" in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata(${metadata});
      }
      (function () {
        var config = ${config};
        var player = document.getElementById("player");
        var status = document.getElementById("status");
        var say = function (message) { status.textContent = message || ""; };
        var stoppedEarly = function (response) {
          var reason = response.headers.get("x-read-aloud-error");
          if (reason) say("The rest could not be spoken: " + decodeURIComponent(reason));
        };
        var canStream = typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(config.mediaType);
        if (!canStream) {
          waitForWholeClip();
          return;
        }
        streamPieces().catch(function (error) {
          console.warn("[read-aloud] streaming failed; playing the clip whole", error);
          waitForWholeClip();
        });

        function fetchPiece(index) {
          return fetch(config.base + "/piece/" + index).then(function (response) {
            // 202: still being spoken; ask again.
            return response.status === 202 ? fetchPiece(index) : response;
          });
        }
        function append(buffer, bytes) {
          return new Promise(function (resolve, reject) {
            var done = function () {
              buffer.removeEventListener("updateend", done);
              buffer.removeEventListener("error", failed);
              resolve();
            };
            var failed = function () {
              buffer.removeEventListener("updateend", done);
              buffer.removeEventListener("error", failed);
              reject(new Error("append failed"));
            };
            buffer.addEventListener("updateend", done);
            buffer.addEventListener("error", failed);
            buffer.appendBuffer(bytes);
          });
        }
        function bufferedEnd(buffer) {
          var ranges = buffer.buffered;
          return ranges.length === 0 ? 0 : ranges.end(ranges.length - 1);
        }
        async function streamPieces() {
          var source = new MediaSource();
          player.src = URL.createObjectURL(source);
          await new Promise(function (resolve) { source.addEventListener("sourceopen", resolve, { once: true }); });
          var buffer = source.addSourceBuffer(config.mediaType);
          // Each piece is its own stream starting at zero; play them back to back.
          buffer.mode = "sequence";
          for (var index = 0; ; index += 1) {
            var response = await fetchPiece(index);
            if (response.status === 204) { stoppedEarly(response); break; }
            if (!response.ok) throw new Error("piece " + index + " answered " + response.status);
            var bytes = await response.arrayBuffer();
            var spokenChars = Number(response.headers.get("x-read-aloud-chars")) || 0;
            if (source.readyState !== "open") return;
            await append(buffer, bytes);
            var end = bufferedEnd(buffer);
            if (spokenChars > 0 && spokenChars < config.totalChars && !buffer.updating) {
              // A guess at the whole, so the card has a seek bar from the start.
              var estimate = (end * config.totalChars) / spokenChars;
              if (estimate > end) { try { source.duration = estimate; } catch (error) {} }
            }
          }
          if (source.readyState === "open") {
            if (buffer.updating) await new Promise(function (resolve) { buffer.addEventListener("updateend", resolve, { once: true }); });
            source.endOfStream();
          }
        }
        function waitForWholeClip() {
          say("Preparing…");
          var poll = function (after) {
            return fetch(config.base + "/state?after=" + after).then(function (response) {
              if (response.status === 202) return poll(after);
              return response.json();
            }).then(function (state) {
              if (!state.done) return poll(state.pieces.length);
              say("");
              if (state.error) say("The rest could not be spoken: " + state.error);
              player.src = config.base + "/audio";
            });
          };
          poll(-1).catch(function () { say("The clip could not be loaded."); });
        }
      })();
    </script>
  </body>
</html>`;
}
