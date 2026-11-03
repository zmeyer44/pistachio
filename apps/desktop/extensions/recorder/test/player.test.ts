/**
 * The preview's player (src/editor/player.ts) on fake media: the clock hands over to the video once its metadata
 * arrives mid-play, and a play request cancelled by Pause is not retried as a refusal would be.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Player, type PlayerHost, type PlayerMedia } from "../src/editor/player.js";
import { timeMap } from "../src/lib/timemap.js";

type Deferred = { resolve: () => void; reject: (error: unknown) => void };

function fakeVideo() {
  const pending: Deferred[] = [];
  const video = {
    readyState: 0,
    error: null as unknown,
    paused: true,
    seeking: false,
    ended: false,
    currentTime: 0,
    duration: 10,
    playbackRate: 1,
    muted: false,
    volume: 1,
    preservesPitch: false,
    play: vi.fn(() => {
      video.paused = false;
      return new Promise<void>((resolve, reject) => pending.push({ resolve, reject }));
    }),
    pause: vi.fn(() => {
      video.paused = true;
    }),
  };
  return { video: video as unknown as HTMLVideoElement, pending, raw: video };
}

function host(duration: number, cuts: { in: number; out: number }[] = [{ in: 0, out: duration }]): PlayerHost & { frames: number[]; stops: number } {
  const map = timeMap(cuts, [], duration);
  const h = {
    frames: [] as number[],
    stops: 0,
    map: () => map,
    audio: () => ({ mic: 1, page: 0.6, muteSpedUp: true }),
    offsets: () => ({ mic: 0, camera: 0 }),
    frame: (tOut: number) => void h.frames.push(tOut),
    stopped: () => void (h.stops += 1),
  };
  return h;
}

describe("the player", () => {
  const frames: FrameRequestCallback[] = [];
  let now = 1000;
  beforeEach(() => {
    frames.length = 0;
    now = 1000;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal("performance", { now: () => now });
  });
  afterEach(() => vi.unstubAllGlobals());
  const tick = (ms: number): void => {
    now += ms;
    const callback = frames.pop();
    frames.length = 0;
    callback?.(now);
  };

  it("hands the clock to the video once its metadata arrives mid-play, starting it where the clock stands", () => {
    const { video, raw } = fakeVideo();
    const media: PlayerMedia = { screen: video, camera: null, mic: null };
    const h = host(10);
    const player = new Player(media, h);
    player.play(0);
    expect(raw.play).not.toHaveBeenCalled();
    // (The wall clock takes at most 0.1 s a frame: half a second in five.)
    for (let i = 0; i < 5; i++) tick(100);
    expect(h.frames.at(-1)).toBeCloseTo(0.5, 3);
    // Metadata: the video is the clock now — started, at the half second the wall clock reached.
    raw.readyState = 1;
    tick(16);
    expect(raw.play).toHaveBeenCalledTimes(1);
    expect(raw.currentTime).toBeCloseTo(0.5, 2);
    expect(player.playing).toBe(true);
    raw.currentTime = 0.7;
    tick(16);
    expect(h.frames.at(-1)).toBeCloseTo(0.7, 3);
    expect(raw.play).toHaveBeenCalledTimes(1);
  });

  it("crosses a cut at the kept clip's rate, never at the join's Infinity read as sixteen times", () => {
    const { video, raw } = fakeVideo();
    raw.readyState = 1;
    const h = host(10, [{ in: 0, out: 1 }, { in: 3, out: 5 }]);
    const player = new Player({ screen: video, camera: null, mic: null }, h);
    player.play(0);
    expect(raw.playbackRate).toBe(1);
    // The video reaches the end of the first clip: the map answers the join, the player seeks to the next clip.
    raw.currentTime = 1;
    tick(16);
    expect(raw.currentTime).toBeCloseTo(3, 6);
    expect(raw.playbackRate).toBe(1);
    expect(raw.muted).toBe(false);
  });

  it("never retries a play request Pause cancelled; a refusal with sound is retried muted while still playing", async () => {
    const { video, raw, pending } = fakeVideo();
    raw.readyState = 1;
    const player = new Player({ screen: video, camera: null, mic: null }, host(10));
    player.play(0);
    expect(raw.play).toHaveBeenCalledTimes(1);
    player.pause();
    pending.shift()!.reject(Object.assign(new Error("interrupted"), { name: "AbortError" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(raw.play).toHaveBeenCalledTimes(1);
    expect(raw.muted).toBe(false);
    expect(raw.paused).toBe(true);
    // Refused for sound while playing: once more, muted.
    player.play(0);
    expect(raw.play).toHaveBeenCalledTimes(2);
    pending.shift()!.reject(Object.assign(new Error("gesture"), { name: "NotAllowedError" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(raw.play).toHaveBeenCalledTimes(3);
    expect(raw.muted).toBe(true);
    // A refusal of a request a newer play() superseded is not retried.
    player.play(1);
    expect(raw.play).toHaveBeenCalledTimes(4);
    const stale = pending.shift()!;
    pending.shift();
    stale.reject(Object.assign(new Error("gesture"), { name: "NotAllowedError" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(raw.play).toHaveBeenCalledTimes(4);
  });
});
