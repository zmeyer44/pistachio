import { describe, expect, it, vi } from "vitest";
import type { BrowserMediaInfo } from "@pistachio/shell-contracts/media";

// browser-controller.ts binds Electron at import time; the comparison under
// test is pure, so a stub module keeps the import from touching the runtime.
vi.mock("electron", () => {
  const stub: unknown = new Proxy(() => stub, { get: () => stub, apply: () => stub });
  const names = [
    "app", "BrowserWindow", "Menu", "WebContentsView", "clipboard", "dialog", "nativeTheme",
    "session", "shell", "webContents", "ipcMain", "net", "screen", "protocol", "nativeImage",
    "safeStorage", "systemPreferences", "powerMonitor",
  ];
  return Object.fromEntries([["default", stub], ...names.map((name) => [name, stub])]);
});

const { mediaInfoChanged } = await import("../src/main/browser-controller");

const base: BrowserMediaInfo = {
  title: "Track",
  artist: "Artist",
  album: "Album",
  artworkUrl: null,
  kind: "audio",
  hasVideo: false,
  playing: true,
  elementMuted: false,
  position: 10,
  duration: 300,
  playbackRate: 1,
  seekable: true,
  canPrevious: false,
  canNext: true,
  canPictureInPicture: false,
  canSetRate: true,
  stream: false,
  presenting: false,
  tabId: "tab",
  tabTitle: "Tab",
  tabUrl: "https://example.com/",
  faviconUrl: null,
  muted: false,
  audible: true,
  updatedAt: 100_000,
  lastActiveAt: 90_000,
  followText: null,
  call: false,
};

describe("mediaInfoChanged", () => {
  it("ignores a position the projection already predicts", () => {
    const next = { ...base, position: 12.4, updatedAt: base.updatedAt + 2_500 };
    expect(mediaInfoChanged(base, next)).toBe(false);
  });

  it("reports a position that drifted more than a second from the projection", () => {
    const stalled = { ...base, position: 10.2, updatedAt: base.updatedAt + 2_500 };
    expect(mediaInfoChanged(base, stalled)).toBe(true);
    const seeked = { ...base, position: 60, updatedAt: base.updatedAt + 500 };
    expect(mediaInfoChanged(base, seeked)).toBe(true);
  });

  it("projects with the playback rate and holds still while paused", () => {
    const fast = { ...base, playbackRate: 2 };
    expect(mediaInfoChanged(fast, { ...fast, position: 15, updatedAt: fast.updatedAt + 2_500 })).toBe(false);
    const paused = { ...base, playing: false };
    expect(mediaInfoChanged(paused, { ...paused, position: 10, updatedAt: paused.updatedAt + 30_000 })).toBe(false);
    expect(mediaInfoChanged(paused, { ...paused, position: 11.5, updatedAt: paused.updatedAt + 30_000 })).toBe(true);
  });

  it("reports any other field, and never treats updatedAt alone as news", () => {
    expect(mediaInfoChanged(base, { ...base, updatedAt: base.updatedAt + 1_000, position: 11 })).toBe(false);
    expect(mediaInfoChanged(base, { ...base, updatedAt: base.updatedAt + 1_000, position: 11, playing: false })).toBe(true);
    expect(mediaInfoChanged(base, { ...base, updatedAt: base.updatedAt + 1_000, position: 11, muted: true })).toBe(true);
    expect(mediaInfoChanged(base, { ...base, updatedAt: base.updatedAt + 1_000, position: 11, canNext: false })).toBe(true);
    expect(mediaInfoChanged(base, { ...base, updatedAt: base.updatedAt + 1_000, position: 11, title: "Other" })).toBe(true);
  });
});
