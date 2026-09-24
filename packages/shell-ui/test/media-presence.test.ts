import { describe, expect, it } from "vitest";
import type { BrowserMediaInfo } from "@pistachio/shell-contracts/media";
import {
  MEDIA_EXIT_MS,
  reconcileMediaPresence,
} from "../src/lib/media-presence";

function item(
  tabId: string,
  overrides: Partial<BrowserMediaInfo> = {},
): BrowserMediaInfo {
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

describe("media card presence", () => {
  it("retains a removed video until its exit completes without changing survivor identity", () => {
    const video = item("video", { hasVideo: true });
    const audio = item("audio");
    const previous = reconcileMediaPresence([], [video, audio], 0, false);
    const removing = reconcileMediaPresence(previous, [audio], 100, false);
    expect(removing.map((entry) => entry.media.tabId)).toEqual([
      "video",
      "audio",
    ]);
    expect(removing[0]).toMatchObject({
      showVideo: true,
      exitAt: 100 + MEDIA_EXIT_MS,
    });
    expect(removing[1]?.media).toBe(audio);
    expect(
      reconcileMediaPresence(removing, [audio], 349, false)[0]?.exitAt,
    ).toBe(350);
    expect(
      reconcileMediaPresence(removing, [audio], 350, false).map(
        (entry) => entry.media.tabId,
      ),
    ).toEqual(["audio"]);
  });
  it("cancels an exit if its source returns and uses the latest playback state", () => {
    const audio = item("audio");
    const closing = reconcileMediaPresence(
      reconcileMediaPresence([], [audio], 0, false),
      [],
      10,
      false,
    );
    const resumed = { ...audio, playbackRate: 1.75 };
    expect(reconcileMediaPresence(closing, [resumed], 20, false)).toEqual([
      { media: resumed, showVideo: false, exitAt: null },
    ]);
  });
  it("hands the native preview to the playing front video on reorder", () => {
    const a = item("a", { hasVideo: true });
    const b = item("b", { hasVideo: true });
    const next = reconcileMediaPresence(
      reconcileMediaPresence([], [a, b], 0, false),
      [b, a],
      10,
      false,
    );
    expect(next.map((entry) => [entry.media.tabId, entry.showVideo])).toEqual([
      ["b", true],
      ["a", false],
    ]);
  });
  it("handles simultaneous exits and insertion without duplicate keys or restarted clocks", () => {
    const a = item("a"),
      b = item("b"),
      c = item("c"),
      d = item("d");
    const closing = reconcileMediaPresence(
      reconcileMediaPresence([], [a, b, c], 0, false),
      [c, d],
      10,
      false,
    );
    const next = reconcileMediaPresence(closing, [c, d], 50, false);
    expect(new Set(next.map((entry) => entry.media.tabId)).size).toBe(4);
    expect(
      next
        .filter((entry) => entry.exitAt !== null)
        .map((entry) => entry.exitAt),
    ).toEqual([260, 260]);
    expect(
      reconcileMediaPresence(next, [c, d], 260, false).map(
        (entry) => entry.media.tabId,
      ),
    ).toEqual(["c", "d"]);
  });
  it("removes exiting cards immediately when reduced motion is enabled", () => {
    const a = item("a");
    const closing = reconcileMediaPresence(
      reconcileMediaPresence([], [a], 0, false),
      [],
      10,
      false,
    );
    expect(reconcileMediaPresence(closing, [], 11, true)).toEqual([]);
  });
});
