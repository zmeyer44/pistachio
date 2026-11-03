import { describe, expect, it } from "vitest";
import { type CanEncode, chooseEncoder, encoderLadder, outputEstimate, videoBitrate } from "../src/export/video.js";

const p1080 = { w: 1920, h: 1080 };
const p2160 = { w: 3840, h: 2160 };

describe("the bitrate ladder", () => {
  it("is bits per pixel per frame at 30 fps, by quality", () => {
    expect(videoBitrate(p1080, 30, "standard", "avc")).toBe(4_355_000);
    expect(videoBitrate(p1080, 30, "high", "avc")).toBe(7_465_000);
    expect(videoBitrate(p1080, 30, "studio", "avc")).toBe(12_442_000);
  });

  it("grows as fps^0.75: 60 fps asks 1.68× of 30", () => {
    expect(videoBitrate(p1080, 60, "high", "avc")).toBe(12_555_000);
    expect(videoBitrate(p2160, 60, "high", "avc")).toBe(50_218_000);
    expect(videoBitrate(p1080, 60, "high", "avc") / videoBitrate(p1080, 30, "high", "avc")).toBeCloseTo(2 ** 0.75, 2);
  });

  it("asks less of HEVC and VP9 for the same picture", () => {
    expect(videoBitrate(p1080, 60, "high", "hevc")).toBe(7_533_000);
    expect(videoBitrate(p1080, 30, "high", "vp9")).toBe(4_852_000);
  });

  it("stays between 1 and 150 Mbps", () => {
    expect(videoBitrate({ w: 320, h: 180 }, 30, "standard", "avc")).toBe(1_000_000);
    expect(videoBitrate({ w: 7680, h: 4320 }, 60, "studio", "avc")).toBe(150_000_000);
  });
});

describe("the encoder ladder", () => {
  it("falls from HEVC to H.264 in hardware, then in software", () => {
    expect(encoderLadder("mp4-hevc")).toEqual([
      { codec: "hevc", acceleration: "prefer-hardware" },
      { codec: "avc", acceleration: "prefer-hardware" },
      { codec: "avc", acceleration: "prefer-software" },
    ]);
    expect(encoderLadder("mp4-h264").map((rung) => rung.codec)).toEqual(["avc", "avc"]);
    expect(encoderLadder("webm").map((rung) => rung.codec)).toEqual(["vp9", "vp8"]);
  });

  it("takes the first rung the platform accepts, with its own bitrate", async () => {
    const asked: string[] = [];
    const canEncode: CanEncode = async (codec, options) => {
      asked.push(`${codec}/${options.hardwareAcceleration}`);
      return codec === "avc" && options.hardwareAcceleration === "prefer-software";
    };
    const choice = await chooseEncoder("mp4-hevc", p1080, 60, "high", canEncode);
    expect(asked).toEqual(["hevc/prefer-hardware", "avc/prefer-hardware", "avc/prefer-software"]);
    expect(choice).toEqual({ codec: "avc", acceleration: "prefer-software", bitrate: 12_555_000, fellBack: true });
  });

  it("names the format when no encoder takes it", async () => {
    const never: CanEncode = async () => false;
    await expect(chooseEncoder("mp4-h264", p2160, 60, "studio", never)).rejects.toThrow("No encoder here can make an H.264 MP4 at 3840×2160 60 fps.");
    const throws: CanEncode = async () => {
      throw new Error("VideoEncoder is not defined");
    };
    await expect(chooseEncoder("webm", p1080, 30, "high", throws)).rejects.toThrow(/a WebM/);
  });
});

describe("the size estimate", () => {
  it("allows half again the target bitrate over the clip, plus 16 MiB", () => {
    const estimate = outputEstimate({ container: "mp4", video: { codec: "avc", acceleration: "prefer-hardware", bitrate: 8_000_000, fellBack: false }, audio: { codec: "aac", bitrate: 192_000 }, fps: 30, frames: 3600, duration: 120 });
    expect(estimate).toBe(Math.ceil(((8_192_000 * 120) / 8) * 1.5) + (16 << 20));
  });
});
