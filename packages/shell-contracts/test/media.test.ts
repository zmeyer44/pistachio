import { describe, expect, it } from "vitest";
import { isMediaControl, normalizeTabMediaReport } from "../src/media.js";

const validReport = {
  title: "A very good track",
  artist: "Pistachio Radio",
  album: "Workspace Mix",
  artworkUrl: "https://example.com/cover.png",
  kind: "audio",
  hasVideo: false,
  playing: true,
  elementMuted: false,
  position: 12.5,
  duration: 180,
  playbackRate: 1,
  seekable: true,
  canPrevious: true,
  canNext: true,
  canPictureInPicture: false,
  canSetRate: true,
  stream: false,
  presenting: false,
};

describe("media IPC data", () => {
  it("normalizes a valid tab report without trusting its identity", () => {
    expect(normalizeTabMediaReport(validReport)).toEqual(validReport);
  });

  it("bounds page-owned metadata and timing", () => {
    const normalized = normalizeTabMediaReport({
      ...validReport,
      title: `  title\u0000${"x".repeat(500)}  `,
      position: 400,
      duration: 100,
      playbackRate: 99,
      artworkUrl: "javascript:alert(1)",
    });
    expect(normalized).toMatchObject({
      position: 100,
      duration: 100,
      playbackRate: 16,
      artworkUrl: null,
    });
    expect(normalized?.title.startsWith("title ")).toBe(true);
    expect(normalized?.title.length).toBeLessThanOrEqual(300);
  });

  it("rejects malformed reports and controls", () => {
    expect(normalizeTabMediaReport({ ...validReport, playing: "yes" })).toBeNull();
    expect(normalizeTabMediaReport({ ...validReport, hasVideo: "yes" })).toBeNull();
    expect(normalizeTabMediaReport({ ...validReport, duration: Number.NaN })).toBeNull();
    expect(isMediaControl({ type: "seek", position: 25 })).toBe(true);
    expect(isMediaControl({ type: "seek", position: Number.NaN })).toBe(false);
    expect(isMediaControl({ type: "pause" })).toBe(true);
    expect(isMediaControl({ type: "eraseEverything" })).toBe(false);
    expect(isMediaControl({ type: "setRate", rate: 1.5 })).toBe(true);
    expect(isMediaControl({ type: "setRate", rate: 0 })).toBe(false);
    expect(isMediaControl({ type: "setRate", rate: 9 })).toBe(false);
    expect(isMediaControl({ type: "followText", enabled: true })).toBe(true);
    expect(isMediaControl({ type: "followText", enabled: "yes" })).toBe(false);
    expect(normalizeTabMediaReport({ ...validReport, canSetRate: "yes" })).toBeNull();
    expect(normalizeTabMediaReport({ ...validReport, stream: undefined })).toBeNull();
  });
});
