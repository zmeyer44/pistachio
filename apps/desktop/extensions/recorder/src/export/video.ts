/**
 * The encoder and the container (docs/recorder.md §2 "Export", §5): a codec
 * per format with a fallback ladder checked by `isConfigSupported` (through
 * mediabunny's `canEncodeVideo`), a bitrate by size × fps × quality, and the
 * mediabunny `Output` whose bytes reach the page as protocol chunks.
 *
 * Measured on the M4 (ideas §1): H.264 and HEVC encode in hardware to 4K60;
 * VP8, VP9 and AV1 only in software; AAC and Opus both encode.
 */
import {
  AudioSampleSource,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  WebMOutputFormat,
  canEncodeAudio,
  canEncodeVideo,
} from "mediabunny";
import type { ExportSpec, Size } from "../lib/types.js";
import { AppendChunker, CHUNK_BYTES, type ChunkWindow, OpfsStage } from "./writer.js";

export type VideoFormat = Exclude<ExportSpec["format"], "gif">;
export type EncoderCodec = "avc" | "hevc" | "vp9" | "vp8";
export type Acceleration = "prefer-hardware" | "prefer-software" | "no-preference";

export interface EncoderRung {
  codec: EncoderCodec;
  acceleration: Acceleration;
}

export interface EncoderChoice extends EncoderRung {
  bitrate: number;
  /** True when the format's first choice was refused and a later rung is used. */
  fellBack: boolean;
}

/**
 * Bits per pixel per frame at 30 fps for H.264 (the brief's 0.07 / 0.12 / 0.2).
 * "High" lands on YouTube's upload advice: 7.5 Mbps at 1080p30, 12.5 at 1080p60, 50 at 4K60.
 */
export const BITS_PER_PIXEL: Record<ExportSpec["quality"], number> = { standard: 0.07, high: 0.12, studio: 0.2 };
/** Bits each codec needs for the same picture, against H.264. */
export const CODEC_EFFICIENCY: Record<EncoderCodec, number> = { avc: 1, hevc: 0.6, vp9: 0.65, vp8: 1.2 };
/**
 * Frames past 30 a second cost less than their share (each is mostly the one
 * before): the bitrate grows as fps^0.75, so 60 fps asks 1.68× of 30, not 2×.
 */
export const FPS_EXPONENT = 0.75;
export const MIN_VIDEO_BITRATE = 1_000_000;
export const MAX_VIDEO_BITRATE = 150_000_000;

/** The target bitrate, bits per second, rounded to a kilobit. */
export function videoBitrate(size: Size, fps: number, quality: ExportSpec["quality"], codec: EncoderCodec): number {
  const perSecond = BITS_PER_PIXEL[quality] * size.w * size.h * 30 * Math.pow(fps / 30, FPS_EXPONENT) * CODEC_EFFICIENCY[codec];
  return Math.round(Math.min(MAX_VIDEO_BITRATE, Math.max(MIN_VIDEO_BITRATE, perSecond)) / 1000) * 1000;
}

/** The encoders to try, first choice first (HEVC falls back to H.264; H.264 to software; WebM to VP8). */
export function encoderLadder(format: VideoFormat): EncoderRung[] {
  switch (format) {
    case "mp4-hevc":
      return [
        { codec: "hevc", acceleration: "prefer-hardware" },
        { codec: "avc", acceleration: "prefer-hardware" },
        { codec: "avc", acceleration: "prefer-software" },
      ];
    case "mp4-h264":
      return [
        { codec: "avc", acceleration: "prefer-hardware" },
        { codec: "avc", acceleration: "prefer-software" },
      ];
    case "webm":
      return [
        { codec: "vp9", acceleration: "no-preference" },
        { codec: "vp8", acceleration: "no-preference" },
      ];
  }
}

export type CanEncode = (codec: EncoderCodec, options: { width: number; height: number; frameRate: number; quality: Quality; hardwareAcceleration: Acceleration }) => Promise<boolean>;

/** The first rung the platform accepts at this size, fps and bitrate; an error naming the format when none does. */
export async function chooseEncoder(format: VideoFormat, size: Size, fps: number, quality: ExportSpec["quality"], canEncode: CanEncode = canEncodeVideo): Promise<EncoderChoice> {
  const ladder = encoderLadder(format);
  for (const [index, rung] of ladder.entries()) {
    const bitrate = videoBitrate(size, fps, quality, rung.codec);
    const ok = await canEncode(rung.codec, { width: size.w, height: size.h, frameRate: fps, quality: new Quality({ bitrate }), hardwareAcceleration: rung.acceleration }).catch(() => false);
    if (ok) return { ...rung, bitrate, fellBack: index > 0 };
  }
  throw new Error(`No encoder here can make ${formatName(format)} at ${String(size.w)}×${String(size.h)} ${String(fps)} fps.`);
}

function formatName(format: VideoFormat): string {
  return format === "mp4-hevc" ? "an HEVC MP4" : format === "mp4-h264" ? "an H.264 MP4" : "a WebM";
}

export type Container = "mp4" | "webm";

export function containerOf(format: VideoFormat): Container {
  return format === "webm" ? "webm" : "mp4";
}

export const AUDIO_SAMPLE_RATE = 48_000;
export const AUDIO_CHANNELS = 2;

export interface AudioChoice {
  codec: "aac" | "opus";
  bitrate: number;
}

/** AAC in an MP4, Opus in a WebM; null when the platform encodes neither (the export goes silent rather than failing). */
export async function chooseAudio(container: Container): Promise<AudioChoice | null> {
  const choice: AudioChoice = container === "mp4" ? { codec: "aac", bitrate: 192_000 } : { codec: "opus", bitrate: 160_000 };
  const ok = await canEncodeAudio(choice.codec, { numberOfChannels: AUDIO_CHANNELS, sampleRate: AUDIO_SAMPLE_RATE, quality: new Quality({ bitrate: choice.bitrate }) }).catch(() => false);
  return ok ? choice : null;
}

export interface OutputPlan {
  container: Container;
  video: EncoderChoice;
  audio: AudioChoice | null;
  fps: number;
  frames: number;
  /** Output seconds. */
  duration: number;
}

/**
 * The bytes a plan may need, with room for a VBR overshoot: the staging file
 * is used only where the origin's quota holds this.
 */
export function outputEstimate(plan: OutputPlan): number {
  return Math.ceil((((plan.video.bitrate + (plan.audio?.bitrate ?? 0)) * plan.duration) / 8) * 1.5) + (16 << 20);
}

export interface OpenOutput {
  output: Output;
  video: CanvasSource;
  audio: AudioSampleSource | null;
  /** True when the muxer writes a staged file (fast-start MP4, seekable WebM); false when it streams in order. */
  staged: boolean;
  /** Finalizes the file and sends what is left; `onSend` reports the staged file's bytes going out (0..1). */
  finish(onSend: (fraction: number) => void): Promise<void>;
  cancel(): Promise<void>;
}

/**
 * The `Output`. With a staging file: MP4 `fastStart: "reserve"` (the moov
 * up front, written last into space kept for it) or a WebM with its cues and
 * duration. Without one, a muxer mode that only appends: a fragmented MP4
 * (2 s fragments, one per keyframe) or an append-only WebM.
 */
export async function openOutput(plan: OutputPlan, canvas: OffscreenCanvas, window: ChunkWindow): Promise<OpenOutput> {
  const stage = await OpfsStage.open(outputEstimate(plan));
  const chunker = stage === null ? new AppendChunker(window) : null;
  const writable = stage !== null ? stage.writable() : (chunker as AppendChunker).writable();
  const format =
    plan.container === "mp4"
      ? new Mp4OutputFormat({ fastStart: stage !== null ? "reserve" : "fragmented", minimumFragmentDuration: 2 })
      : new WebMOutputFormat({ appendOnly: stage === null });
  const output = new Output({ format, target: new StreamTarget(writable, { chunked: true, chunkSize: CHUNK_BYTES }) });
  const video = new CanvasSource(canvas, {
    codec: plan.video.codec,
    quality: new Quality({ bitrate: plan.video.bitrate, bitrateMode: "variable" }),
    keyFrameInterval: 2,
    hardwareAcceleration: plan.video.acceleration,
    latencyMode: "quality",
  });
  output.addVideoTrack(video, { frameRate: plan.fps, maximumPacketCount: plan.frames + 8 });
  let audio: AudioSampleSource | null = null;
  if (plan.audio !== null) {
    audio = new AudioSampleSource({ codec: plan.audio.codec, quality: new Quality({ bitrate: plan.audio.bitrate }) });
    // AAC packs 1024 samples a packet, Opus 960 (20 ms): count by the smaller, with a margin for priming.
    output.addAudioTrack(audio, { maximumPacketCount: Math.ceil(((plan.duration * AUDIO_SAMPLE_RATE) / 960) * 1.1) + 64 });
  }
  let settled = false;
  return {
    output,
    video,
    audio,
    staged: stage !== null,
    async finish(onSend) {
      try {
        await output.finalize();
        if (stage !== null) await stage.send(window, (sent) => onSend(stage.size > 0 ? sent / stage.size : 1));
        else await (chunker as AppendChunker).end();
        await window.drain();
      } finally {
        settled = true;
        await stage?.dispose();
      }
    },
    async cancel() {
      if (settled) return;
      settled = true;
      if (output.state === "pending" || output.state === "started" || output.state === "finalizing") await output.cancel().catch(() => undefined);
      await stage?.dispose();
    },
  };
}
