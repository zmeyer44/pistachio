/**
 * Playback for the preview (docs/recorder.md §5): the screen `<video>` is the clock.
 * The time map sets its `playbackRate` per speed segment (≤ 16×, pitch kept) and
 * turns cuts into seeks; the camera follows it; the mic plays at 1× and rests in
 * sped-up stretches when "mute while sped up" is on. Without playable media (the
 * `?fake=1` run, or reverse shuttling) a wall clock drives the output time instead.
 * The mic's and the camera's files each start a little after the screen's (the
 * meta line's `offsets`): source second `s` is their `s - offset`.
 */
import type { AudioSpec, TimeMap } from "../lib/types.js";
import { clamp } from "./model.js";

export interface PlayerMedia {
  screen: HTMLVideoElement | null;
  camera: HTMLVideoElement | null;
  mic: HTMLAudioElement | null;
}

export interface PlayerHost {
  map(): TimeMap;
  audio(): AudioSpec;
  /** Where the mic's and the camera's files start on the source clock (seconds). */
  offsets(): { mic: number; camera: number };
  /** Playback moved the output time. */
  frame(tOut: number): void;
  /** Playback stopped on its own (the end). */
  stopped(): void;
}

const MAX_RATE = 16;

export class Player {
  playing = false;
  /** J/L's multiplier on top of the speed plan. */
  shuttleRate = 1;
  direction: 1 | -1 = 1;
  private readonly media: PlayerMedia;
  private readonly host: PlayerHost;
  private raf = 0;
  private wallLast = 0;
  private clock = 0;
  private lastSeekAt = 0;
  /** Whether the screen video drives the output time now (else the wall clock does, until the video can). */
  private mediaDriven = false;
  /** The play() this request belongs to: a refusal of an older one, or of one Pause cancelled, is not retried. */
  private playToken = 0;

  constructor(media: PlayerMedia, host: PlayerHost) {
    this.media = media;
    this.host = host;
    for (const el of [media.screen, media.camera, media.mic]) {
      if (el === null) continue;
      el.preservesPitch = true;
    }
  }

  /** The screen video can be the clock. */
  get mediaReady(): boolean {
    const video = this.media.screen;
    return video !== null && video.readyState >= 1 && video.error === null;
  }

  play(fromOut: number, direction: 1 | -1 = 1, shuttleRate = 1): void {
    const map = this.host.map();
    let t = clamp(fromOut, 0, map.duration);
    if (direction > 0 && t >= map.duration - 1e-3) t = 0;
    if (direction < 0 && t <= 1e-3) t = map.duration;
    this.clock = t;
    this.direction = direction;
    this.shuttleRate = shuttleRate;
    this.playing = true;
    this.wallLast = performance.now();
    this.mediaDriven = false;
    if (this.mediaReady && direction > 0) this.startMedia(map, t);
    else this.pauseMedia();
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.tick);
  }

  pause(): void {
    this.playing = false;
    this.mediaDriven = false;
    this.playToken += 1;
    cancelAnimationFrame(this.raf);
    this.pauseMedia();
  }

  /** The screen video (and the camera) started at output time `tOut`: the video is the clock from here. */
  private startMedia(map: TimeMap, tOut: number): void {
    const tSrc = map.toSource(tOut);
    this.seekMedia(tSrc);
    const rate = map.rateAt(tOut);
    this.applyRates(rate);
    this.syncAudio(tSrc, rate);
    this.mediaDriven = true;
    const screen = this.media.screen!;
    const token = ++this.playToken;
    screen.play().catch((error: unknown) => {
      // Refused with sound (autoplay): play muted rather than not at all — but only this request, still wanted: a
      // request Pause cut short is rejected too (AbortError), and starting then would run the video behind a paused preview.
      const refused = error instanceof Error ? error.name === "NotAllowedError" : false;
      if (!refused || token !== this.playToken || !this.playing) return;
      screen.muted = true;
      void screen.play().catch(() => undefined);
    });
    if (this.media.camera !== null) void this.media.camera.play().catch(() => undefined);
  }

  /** Move to an output time (paused or playing). */
  seek(tOut: number): void {
    const map = this.host.map();
    this.clock = clamp(tOut, 0, map.duration);
    if (this.mediaReady) this.seekMedia(map.toSource(this.clock));
  }

  private pauseMedia(): void {
    for (const el of [this.media.screen, this.media.camera, this.media.mic]) if (el !== null && !el.paused) el.pause();
  }

  private seekMedia(tSrc: number): void {
    this.lastSeekAt = performance.now();
    const offsets = this.host.offsets();
    const { screen, camera, mic } = this.media;
    for (const [el, offset] of [
      [screen, 0],
      [camera, offsets.camera],
      [mic, offsets.mic],
    ] as const) {
      if (el === null || el.readyState < 1) continue;
      const t = tSrc - offset;
      const end = Number.isFinite(el.duration) ? el.duration : Math.max(0, t);
      el.currentTime = clamp(t, 0, end);
    }
  }

  private applyRates(rate: number): void {
    const playbackRate = clamp((Number.isFinite(rate) ? rate : MAX_RATE) * this.shuttleRate, 0.0625, MAX_RATE);
    for (const el of [this.media.screen, this.media.camera]) {
      if (el !== null && el.playbackRate !== playbackRate) el.playbackRate = playbackRate;
    }
  }

  private syncAudio(tSrc: number, rate: number): void {
    const audio = this.host.audio();
    const effective = (Number.isFinite(rate) ? rate : MAX_RATE) * this.shuttleRate;
    const sped = effective > 1.001;
    const screen = this.media.screen;
    if (screen !== null) {
      screen.volume = clamp(audio.page, 0, 1);
      screen.muted = audio.page <= 0 || (audio.muteSpedUp && sped);
    }
    const offsets = this.host.offsets();
    const mic = this.media.mic;
    if (mic !== null && mic.readyState >= 1) {
      mic.volume = clamp(audio.mic, 0, 1);
      const micT = tSrc - offsets.mic;
      const resting = audio.mic <= 0 || (audio.muteSpedUp && sped) || micT < 0 || (Number.isFinite(mic.duration) && micT >= mic.duration);
      if (resting) {
        if (!mic.paused) mic.pause();
      } else {
        // At 1× the mic plays as recorded; over a speed-up it is heard only when Mute while sped up is off, in step (the export's soundPlan does the same).
        const micRate = clamp(effective, 0.0625, MAX_RATE);
        if (mic.playbackRate !== micRate) mic.playbackRate = micRate;
        if (Math.abs(mic.currentTime - micT) > 0.15) mic.currentTime = micT;
        if (mic.paused) void mic.play().catch(() => undefined);
      }
    }
    const camera = this.media.camera;
    const cameraT = Math.max(0, tSrc - offsets.camera);
    if (camera !== null && camera.readyState >= 1 && Math.abs(camera.currentTime - cameraT) > 0.2) camera.currentTime = cameraT;
  }

  private finish(tOut: number): void {
    this.pause();
    this.host.frame(tOut);
    this.host.stopped();
  }

  private readonly tick = (now: number): void => {
    if (!this.playing) return;
    const map = this.host.map();
    let tOut: number;
    if (this.mediaReady && this.direction > 0) {
      // The video can be the clock now and was not yet (its metadata came mid-play): started where the wall clock stands.
      if (!this.mediaDriven) this.startMedia(map, this.clock);
      const screen = this.media.screen!;
      let tSrc = screen.currentTime;
      tOut = map.toOutput(tSrc);
      // Inside a cut-away range the map answers the next kept time: jump there.
      const want = map.toSource(tOut);
      if (want - tSrc > 0.03 && !screen.seeking) {
        this.seekMedia(want);
        tSrc = want;
      }
      // At a join the map says Infinity (a cut, not a speed): the rate is the kept clip's just past it.
      const at = map.rateAt(tOut);
      const rate = Number.isFinite(at) ? at : map.rateAt(Math.min(map.duration, tOut + 1e-6));
      this.applyRates(rate);
      this.syncAudio(tSrc, rate);
      if (screen.ended || tOut >= map.duration - 0.005) {
        this.finish(map.duration);
        return;
      }
    } else {
      const dt = Math.min(0.1, (now - this.wallLast) / 1000);
      this.wallLast = now;
      this.clock += dt * this.shuttleRate * this.direction;
      if (this.clock >= map.duration) {
        this.finish(map.duration);
        return;
      }
      if (this.clock <= 0) {
        this.finish(0);
        return;
      }
      tOut = this.clock;
      // Shuttling back: seek the frames along, no faster than the decoder keeps up.
      if (this.mediaReady && !this.media.screen!.seeking && now - this.lastSeekAt > 50) this.seekMedia(map.toSource(tOut));
    }
    this.clock = tOut;
    this.host.frame(tOut);
    this.raf = requestAnimationFrame(this.tick);
  };
}
