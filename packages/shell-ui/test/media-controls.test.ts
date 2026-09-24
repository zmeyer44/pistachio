import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  BrowserMediaInfo,
  ReadAloudStatus,
} from "@pistachio/shell-contracts/media";

const fixture = vi.hoisted(() => ({
  media: [] as BrowserMediaInfo[],
  readAloud: [] as ReadAloudStatus[],
  listed: true,
}));
vi.mock("../src/store", () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      media: fixture.media,
      readAloud: fixture.readAloud,
      snapshot: { activeTabId: "other", visibleTabIds: [] },
      sidebarWidth: 248,
      settings: { layout: { sidebar: "pinned" } },
      sidebarRevealed: true,
      footerMenusOpen: 0,
      overlay: null,
      onboardingOpen: false,
      controlMedia: vi.fn(),
      cancelReadAloud: vi.fn(),
    }),
}));
vi.mock("../src/chrome/tabs", () => ({
  useChromeTabs: () => (fixture.listed ? [{ id: "track" }] : []),
}));
vi.mock("../src/api", () => ({ nativeApi: () => null }));
const { MediaStack } = await import("../src/components/MediaStack");

function media(overrides: Partial<BrowserMediaInfo> = {}): BrowserMediaInfo {
  return {
    tabId: "track",
    tabTitle: "Source",
    tabUrl: "https://example.com",
    faviconUrl: null,
    title: "Track",
    artist: "Artist",
    album: "Album",
    artworkUrl: null,
    kind: "audio",
    hasVideo: false,
    playing: true,
    elementMuted: false,
    muted: false,
    audible: true,
    position: 10,
    duration: 100,
    playbackRate: 1,
    seekable: true,
    canPrevious: false,
    canNext: false,
    canPictureInPicture: false,
    canSetRate: true,
    stream: false,
    presenting: false,
    updatedAt: Date.now(),
    lastActiveAt: 1,
    followText: null,
    call: false,
    ...overrides,
  };
}
const render = () => renderToStaticMarkup(createElement(MediaStack));

beforeEach(() => {
  fixture.media = [media()];
  fixture.readAloud = [];
  fixture.listed = true;
});
describe("media control capability preservation", () => {
  it("keeps video PiP, return-to-tab, track navigation, mute, speed and seek controls", () => {
    fixture.media = [
      media({
        hasVideo: true,
        kind: "video",
        canPictureInPicture: true,
        canPrevious: true,
        canNext: true,
      }),
    ];
    const html = render();
    for (const label of [
      "Picture in Picture",
      "Show playing tab",
      "Previous track",
      "Back 15 seconds",
      "Forward 15 seconds",
      "Next track",
      "Mute",
      "Pause",
      "Playback speed: 1x",
      "Seek Track",
      "Dismiss media control",
    ]) {
      expect(html).toContain(`aria-label="${label}"`);
    }
    expect(html).toContain('data-testid="media-video-track"');
    expect(html).toContain("Artist");
  });
  it("offers 15-second seeks on audio and video alike, with track buttons only for a playlist", () => {
    for (const hasVideo of [false, true]) {
      fixture.media = [media({ hasVideo, kind: hasVideo ? "video" : "audio" })];
      const html = render();
      expect(html).toContain('aria-label="Back 15 seconds"');
      expect(html).toContain('aria-label="Forward 15 seconds"');
      expect(html).not.toContain('aria-label="Previous track"');
      expect(html).not.toContain("data-track-nav");
    }
    // One direction on offer still draws the pair, so the row stays symmetric.
    fixture.media = [media({ canNext: true })];
    const html = render();
    expect(html).toContain('data-track-nav="true"');
    expect(html).toMatch(/aria-label="Previous track"[^>]* disabled=""/);
    expect(html).not.toMatch(/aria-label="Next track"[^>]* disabled=""/);
    expect(html).not.toMatch(/aria-label="Forward 15 seconds"[^>]* disabled=""/);
  });
  it("keeps read-aloud follow toggles without exposing navigation to an unlisted player", () => {
    fixture.listed = false;
    fixture.media = [
      media({ tabUrl: "pistachio://read-aloud/clip", followText: "on" }),
    ];
    expect(render()).toContain(
      'aria-label="Stop following the text" aria-pressed="true"',
    );
    expect(render()).not.toContain('aria-label="Show playing tab"');
    fixture.media = [media({ followText: "off" })];
    expect(render()).toContain(
      'aria-label="Follow the text on the page" aria-pressed="false"',
    );
  });
  it("gives a call no card, but keeps one for a live stream that is not a call", () => {
    const live = { kind: "live" as const, duration: null, seekable: false, canSetRate: false, stream: true };
    fixture.media = [media({ ...live, call: true })];
    expect(render()).not.toContain('data-testid="media-card-track"');
    fixture.media = [media(live)];
    expect(render()).toContain('data-testid="media-card-track"');
  });
  it("does not offer seeking or speed for a live stream", () => {
    fixture.media = [
      media({
        kind: "live",
        duration: null,
        seekable: false,
        canSetRate: false,
        muted: true,
        playing: false,
      }),
    ];
    const html = render();
    expect(html).toContain('aria-label="Live playback"');
    expect(html).not.toContain('type="range"');
    expect(html).not.toContain('data-testid="media-rate-trigger"');
    expect(html).toMatch(/aria-label="Back 15 seconds"[^>]* disabled=""/);
    expect(html).toMatch(/aria-label="Forward 15 seconds"[^>]* disabled=""/);
    expect(html).toContain('aria-label="Unmute"');
    expect(html).toContain('aria-label="Play"');
  });
  it("retains generating/failed read-aloud toasts and their cancel/dismiss actions", () => {
    fixture.media = [];
    fixture.readAloud = [
      {
        id: "clip",
        phase: "generating",
        sourceTitle: "Article",
        excerpt: "Selected text",
        startedAt: 1,
        message: null,
      },
    ];
    expect(render()).toContain('aria-label="Cancel read aloud"');
    fixture.readAloud[0] = {
      ...fixture.readAloud[0]!,
      phase: "failed",
      message: "Try again",
    };
    expect(render()).toContain("Read aloud failed");
    expect(render()).toContain('aria-label="Dismiss"');
  });
});
