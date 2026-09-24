import { describe, expect, it } from "vitest";
import type { BrowserMediaInfo } from "@pistachio/shell-contracts/media";
import { isReadAloudPlayer, MAX_MEDIA_CARDS, orderMediaStack, READ_ALOUD_LINGER_MS, readAloudFinished } from "../src/lib/media-stack";

function item(tabId: string, overrides: Partial<BrowserMediaInfo> = {}): BrowserMediaInfo {
  return {
    tabId,
    tabTitle: tabId,
    tabUrl: `https://${tabId}.example`,
    faviconUrl: null,
    title: tabId,
    artist: "",
    album: "",
    artworkUrl: null,
    kind: "audio",
    hasVideo: false,
    playing: true,
    elementMuted: false,
    muted: false,
    audible: true,
    position: 0,
    duration: 100,
    playbackRate: 1,
    seekable: true,
    canPrevious: false,
    canNext: false,
    canPictureInPicture: false,
    canSetRate: true,
    stream: false,
    presenting: false,
    updatedAt: 0,
    lastActiveAt: 0,
    followText: null,
    call: false,
    ...overrides,
  };
}

const ids = (media: BrowserMediaInfo[]): string[] => media.map((entry) => entry.tabId);

describe("orderMediaStack", () => {
  it("keeps newest-first order for audio", () => {
    expect(ids(orderMediaStack([item("a"), item("b"), item("c")]))).toEqual(["a", "b", "c"]);
  });

  it("brings the playing video to the front over newer audio and paused videos", () => {
    const stack = orderMediaStack([
      item("podcast"),
      item("paused", { hasVideo: true, kind: "video", playing: false }),
      item("watching", { hasVideo: true, kind: "video" }),
    ]);
    expect(ids(stack)).toEqual(["watching", "podcast", "paused"]);
  });

  it("leads with the most recent video when none is playing", () => {
    const stack = orderMediaStack([
      item("podcast"),
      item("clip", { hasVideo: true, kind: "video", playing: false }),
    ]);
    expect(ids(stack)).toEqual(["clip", "podcast"]);
  });

  it("never drops the playing video for being old", () => {
    const stack = orderMediaStack([
      item("a"),
      item("b"),
      item("c"),
      item("video", { hasVideo: true, kind: "video" }),
    ]);
    expect(stack).toHaveLength(MAX_MEDIA_CARDS);
    expect(ids(stack)).toEqual(["video", "a", "b"]);
  });
});

describe("readAloudFinished", () => {
  const clip = (overrides: Partial<BrowserMediaInfo> = {}): BrowserMediaInfo =>
    item("speech", { tabUrl: "pistachio://read-aloud/0f7a9c5e-1b2d-4c3e-8f90-123456789abc", ...overrides });

  it("names the read-aloud player by its page", () => {
    expect(isReadAloudPlayer(clip())).toBe(true);
    expect(isReadAloudPlayer(item("podcast"))).toBe(false);
  });

  it("is finished once the clip stops at its end", () => {
    expect(readAloudFinished(clip({ playing: false, position: 100 }))).toBe(true);
    // `ended` lands on the duration exactly; a hair short still counts.
    expect(readAloudFinished(clip({ playing: false, position: 99.9 }))).toBe(true);
  });

  it("is not finished while playing, paused mid-way, or without a duration", () => {
    expect(readAloudFinished(clip({ playing: true, position: 100 }))).toBe(false);
    expect(readAloudFinished(clip({ playing: false, position: 40 }))).toBe(false);
    expect(readAloudFinished(clip({ playing: false, position: 0, duration: null }))).toBe(false);
    expect(readAloudFinished(clip({ playing: false, position: 0, duration: 0 }))).toBe(false);
  });

  it("leaves a page's own media alone even when it has ended", () => {
    expect(readAloudFinished(item("podcast", { playing: false, position: 100 }))).toBe(false);
  });

  it("lingers briefly, like a toast", () => {
    expect(READ_ALOUD_LINGER_MS).toBe(5_000);
  });
});
