/**
 * The export pipeline (docs/recorder.md R3, §5): decode → render → encode →
 * mux, in the Worker, with no DOM (OffscreenCanvas only).
 *
 * For each output frame `i` at `tOut = i / fps`: `tSrc = timeMap.toSource(tOut)`,
 * the screen frame in force at `tSrc` (a forward `samples()` iterator per kept
 * range, the last frame held across sped-up stretches), the camera's likewise,
 * the one `render(tOut)` the editor's preview uses, then the encoder, which
 * awaits for backpressure. The sound is mixed alongside, a little ahead of
 * the picture, so the muxer interleaves without holding packets back.
 */
import { AudioSample, type AudioSampleSource, type Input, type InputVideoTrack, type UrlSource, type VideoSample, VideoSampleSink } from "mediabunny";
import { createRenderer, outputSize, parseEvents, renderStateFor, streamOffset, timeMap, type Renderer, type TimeMap } from "../lib/index.js";
import type { MetaEvent, Project, Size } from "../lib/types.js";
import { AudioMixer, Envelope, type MixSource, PcmReader, silentZones, soundPlan, trackOpener } from "./audio.js";
import { GifWriter, buildPalette, paletteFrameIndices } from "./gif.js";
import type { ExportRequest } from "./protocol.js";
import { type FrameSchedule, GIF_FPS, GIF_MAX_SECONDS, PROGRESS_EVERY, Progress, frameSchedule, gifSize } from "./schedule.js";
import { fetchText, openInput } from "./sources.js";
import { AUDIO_CHANNELS, AUDIO_SAMPLE_RATE, type OutputPlan, type VideoFormat, chooseAudio, chooseEncoder, containerOf, openOutput } from "./video.js";
import { Cancelled, type ChunkWindow } from "./writer.js";

export interface ExportControl {
  signal: AbortSignal;
  window: ChunkWindow;
  progress(fraction: number, etaSeconds: number | null, frames: number): void;
  /** Hands the shell the running output's cancel, so a `cancel` stops the encoder at once. */
  onCancel(cancel: () => Promise<void>): void;
}

export interface ExportResult {
  bytes: number;
  /** The output's length, seconds. */
  durationSeconds: number;
  frames: number;
}

/** A frame whose timestamp is this close past `tSrc` still counts as in force (float noise). */
const FRAME_EPSILON = 0.001;

/**
 * The decoded frame in force at each scheduled output frame, read forward:
 * one `samples(start)` iterator per range of the schedule (a cut opens the
 * next range's), the last frame held where the source has none newer. A file
 * that starts `offset` seconds into the source (the camera's, the meta line's
 * `offsets`) is read at `tSrc - offset`.
 */
export class FrameCursor {
  #range = -1;
  #iterator: AsyncGenerator<VideoSample, void, unknown> | null = null;
  #current: VideoSample | null = null;
  #next: VideoSample | null = null;
  #frame: VideoFrame | null = null;
  readonly sink: VideoSampleSink;
  readonly schedule: FrameSchedule;
  readonly offset: number;

  constructor(sink: VideoSampleSink, schedule: FrameSchedule, offset = 0) {
    this.sink = sink;
    this.schedule = schedule;
    this.offset = offset;
  }

  /** The frame for output frame `i` (ascending `i`); valid until the next call or `close`. */
  async at(i: number): Promise<VideoFrame | null> {
    const ranges = this.schedule.ranges;
    let r = Math.max(0, this.#range);
    while (r < ranges.length - 1 && (ranges[r] as { last: number }).last < i) r++;
    if (r !== this.#range) {
      await this.#open(Math.max(0, (ranges[r] as { start: number }).start - this.offset));
      this.#range = r;
    }
    const t = (this.schedule.tSrc[i] as number) - this.offset;
    while (this.#next !== null && (this.#current === null || this.#next.timestamp <= t + FRAME_EPSILON)) {
      this.#hold(this.#next);
      this.#next = await this.#pull();
    }
    if (this.#current === null) return null;
    this.#frame ??= this.#current.toVideoFrame();
    return this.#frame;
  }

  async close(): Promise<void> {
    const iterator = this.#iterator;
    this.#iterator = null;
    this.#next?.close();
    this.#next = null;
    this.#hold(null);
    await iterator?.return(undefined);
  }

  async #open(start: number): Promise<void> {
    await this.#iterator?.return(undefined);
    this.#next?.close();
    // Starts at the frame showing at `start` (the last at or before it); the frame held so far stays until it arrives.
    this.#iterator = this.sink.samples(start);
    this.#next = await this.#pull();
  }

  async #pull(): Promise<VideoSample | null> {
    if (this.#iterator === null) return null;
    const result = await this.#iterator.next();
    return result.done === true ? null : result.value;
  }

  #hold(sample: VideoSample | null): void {
    this.#frame?.close();
    this.#frame = null;
    this.#current?.close();
    this.#current = sample;
  }
}

interface Job {
  request: ExportRequest;
  project: Project;
  meta: MetaEvent;
  control: ExportControl;
  check(): void;
  screen: Input<UrlSource>;
  screenTrack: InputVideoTrack;
  cameraTrack: InputVideoTrack | null;
  map: TimeMap;
  schedule: FrameSchedule;
  size: Size;
  fps: number;
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
  renderer: Renderer;
  closers: (() => unknown)[];
}

export async function runExport(request: ExportRequest, control: ExportControl): Promise<ExportResult> {
  const { project, meta, urls } = request;
  const closers: (() => unknown)[] = [];
  const check = (): void => {
    if (control.signal.aborted) throw new Cancelled();
  };
  try {
    const screen = openInput(urls.screen);
    closers.push(() => screen.dispose());
    const [eventsText, screenTrack] = await Promise.all([fetchText(urls.events), screen.getPrimaryVideoTrack()]);
    if (screenTrack === null) throw new Error("The recording has no picture.");
    if (!(await screenTrack.canDecode())) throw new Error("This Mac cannot decode the recording.");
    const sourceDuration = await screenTrack.computeDuration();
    check();
    const gif = project.export.format === "gif";
    const map = timeMap(project.cuts, project.speed, sourceDuration);
    if (gif && map.duration > GIF_MAX_SECONDS + 0.5) {
      throw new Error(`A GIF holds at most ${String(GIF_MAX_SECONDS)} seconds and this edit runs ${String(Math.round(map.duration))}: export an MP4, or cut it shorter.`);
    }
    const fps = gif ? GIF_FPS : project.export.fps;
    // The lib's output size (the preview's shape too): the export height names the shorter side.
    const size = gif ? gifSize(project.look, meta.view) : outputSize(project.look, meta.view, project.export.height);
    const schedule = frameSchedule(map, fps);
    let cameraTrack: InputVideoTrack | null = null;
    if (urls.camera !== null) {
      const camera = openInput(urls.camera);
      closers.push(() => camera.dispose());
      cameraTrack = await camera.getPrimaryVideoTrack();
      if (cameraTrack === null || !(await cameraTrack.canDecode())) throw new Error("The camera recording cannot be read.");
    }
    const recording = parseEvents(eventsText);
    // The one render state (the editor's preview builds the same): the camera, the cursor, the chapters, the chips.
    const renderer = createRenderer(renderStateFor(project, { meta, events: recording.events }, size, { duration: sourceDuration }), map);
    const canvas = new OffscreenCanvas(size.w, size.h);
    const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: gif });
    if (ctx === null) throw new Error("This Worker has no 2D canvas.");
    const job: Job = { request, project, meta, control, check, screen, screenTrack, cameraTrack, map, schedule, size, fps, canvas, ctx, renderer, closers };
    return gif ? await exportGif(job) : await exportVideo(job);
  } finally {
    for (const close of closers.reverse()) {
      try {
        await close();
      } catch {
        // closing what failed already
      }
    }
  }
}

/** The screen and camera cursors over the schedule, closed with the job. */
function cursors(job: Job): { screen: FrameCursor; camera: FrameCursor | null } {
  const screen = new FrameCursor(new VideoSampleSink(job.screenTrack), job.schedule);
  const camera = job.cameraTrack !== null ? new FrameCursor(new VideoSampleSink(job.cameraTrack), job.schedule, streamOffset(job.meta, "camera")) : null;
  job.closers.push(() => screen.close(), () => camera?.close());
  return { screen, camera };
}

async function drawFrame(job: Job, i: number, frames: { screen: FrameCursor; camera: FrameCursor | null }): Promise<void> {
  const screen = await frames.screen.at(i);
  const camera = frames.camera !== null ? await frames.camera.at(i) : null;
  job.renderer.render(job.ctx, i / job.fps, { screen, camera });
}

async function exportVideo(job: Job): Promise<ExportResult> {
  const { project, control, schedule, fps, size } = job;
  const format = project.export.format as VideoFormat;
  const container = containerOf(format);
  const video = await chooseEncoder(format, size, fps, project.export.quality);
  const duration = schedule.count / fps;
  const mixSources = await soundSources(job);
  const audio = mixSources.length > 0 ? await chooseAudio(container) : null;
  const mixer = audio !== null ? new AudioMixer(job.map, mixSources, duration) : null;
  if (mixer !== null) job.closers.push(() => mixer.close());
  const plan: OutputPlan = { container, video, audio, fps, frames: schedule.count, duration };
  job.check();
  const out = await openOutput(plan, job.canvas, control.window);
  control.onCancel(() => out.cancel());
  const frames = cursors(job);
  const progress = new Progress();
  // A staged file still has to go out to the page after the muxer finishes: the last 3% of the bar.
  const share = out.staged ? 0.97 : 1;
  const report = (fraction: number, done: number): void => {
    const at = progress.at(fraction);
    control.progress(at.fraction, at.etaSeconds, done);
  };
  console.info(`[recorder export] ${video.codec} (${video.acceleration}) ${String(size.w)}×${String(size.h)}@${String(fps)} ${String(Math.round(video.bitrate / 1000))} kbps, ${audio?.codec ?? "no sound"}, ${out.staged ? "staged" : "streamed"}`);
  let finished = false;
  try {
    await out.output.start();
    for (let i = 0; i < schedule.count; i++) {
      job.check();
      await drawFrame(job, i, frames);
      await out.video.add(i / fps, 1 / fps);
      if (mixer !== null && out.audio !== null) await pumpSound(job, mixer, out.audio, (i + 1) / fps + 0.25);
      if ((i + 1) % PROGRESS_EVERY === 0) report(((i + 1) / schedule.count) * share, i + 1);
    }
    if (mixer !== null && out.audio !== null) await pumpSound(job, mixer, out.audio, Infinity);
    job.check();
    await frames.screen.close();
    await frames.camera?.close();
    await out.finish((sent) => report(share + (1 - share) * sent, schedule.count));
    finished = true;
  } finally {
    if (!finished) await out.cancel();
  }
  report(1, schedule.count);
  return { bytes: control.window.bytes, durationSeconds: duration, frames: schedule.count };
}

/** The mic and the page's sound, each with the silences the time map and *Mute while sped up* ask of it (`soundPlan`). */
async function soundSources(job: Job): Promise<MixSource[]> {
  const { project, request } = job;
  const plan = soundPlan(project.audio, silentZones(job.map));
  const sources: MixSource[] = [];
  if (request.urls.mic !== null && plan.mic !== null) {
    const mic = openInput(request.urls.mic);
    job.closers.push(() => mic.dispose());
    const track = await mic.getPrimaryAudioTrack();
    if (track === null || !(await track.canDecode())) throw new Error("The mic recording cannot be read.");
    sources.push({ reader: new PcmReader(trackOpener(track, streamOffset(job.meta, "mic"))), gain: plan.mic.gain, envelope: new Envelope(plan.mic.silences) });
  }
  if (plan.page !== null) {
    const track = await job.screen.getPrimaryAudioTrack();
    if (track !== null && (await track.canDecode())) {
      sources.push({ reader: new PcmReader(trackOpener(track)), gain: plan.page.gain, envelope: new Envelope(plan.page.silences) });
    }
  }
  return sources;
}

async function pumpSound(job: Job, mixer: AudioMixer, source: AudioSampleSource, until: number): Promise<void> {
  while (!mixer.done && mixer.time < until) {
    job.check();
    const block = await mixer.next();
    if (block === null) break;
    const sample = new AudioSample({ data: block.data, format: "f32-planar", numberOfChannels: AUDIO_CHANNELS, sampleRate: AUDIO_SAMPLE_RATE, timestamp: block.timestamp });
    try {
      await source.add(sample);
    } finally {
      sample.close();
    }
  }
}

async function exportGif(job: Job): Promise<ExportResult> {
  const { control, schedule, size, fps, ctx } = job;
  control.onCancel(async () => undefined);
  const progress = new Progress();
  const report = (done: number): void => {
    const at = progress.at(done / schedule.count);
    control.progress(at.fraction, at.etaSeconds, done);
  };
  // The palette: twelve frames across the clip, each found by seeking.
  const screenSink = new VideoSampleSink(job.screenTrack);
  const cameraSink = job.cameraTrack !== null ? new VideoSampleSink(job.cameraTrack) : null;
  const firstScreen = await job.screenTrack.getFirstTimestamp();
  const firstCamera = job.cameraTrack !== null ? await job.cameraTrack.getFirstTimestamp() : 0;
  const cameraOffset = streamOffset(job.meta, "camera");
  const samples: Uint8ClampedArray[] = [];
  for (const i of paletteFrameIndices(schedule.count)) {
    job.check();
    const t = schedule.tSrc[i] as number;
    const screen = await screenSink.getSample(Math.max(t, firstScreen));
    const camera = cameraSink !== null ? await cameraSink.getSample(Math.max(t - cameraOffset, firstCamera)) : null;
    const screenFrame = screen?.toVideoFrame() ?? null;
    const cameraFrame = camera?.toVideoFrame() ?? null;
    try {
      job.renderer.render(ctx, i / fps, { screen: screenFrame, camera: cameraFrame });
      samples.push(ctx.getImageData(0, 0, size.w, size.h).data);
    } finally {
      screenFrame?.close();
      cameraFrame?.close();
      screen?.close();
      camera?.close();
    }
  }
  const writer = new GifWriter(control.window, size, fps, buildPalette(samples));
  samples.length = 0;
  const frames = cursors(job);
  for (let i = 0; i < schedule.count; i++) {
    job.check();
    await drawFrame(job, i, frames);
    await writer.frame(ctx.getImageData(0, 0, size.w, size.h).data);
    if ((i + 1) % PROGRESS_EVERY === 0) report(i + 1);
  }
  await writer.end();
  await control.window.drain();
  report(schedule.count);
  return { bytes: control.window.bytes, durationSeconds: schedule.count / fps, frames: schedule.count };
}
