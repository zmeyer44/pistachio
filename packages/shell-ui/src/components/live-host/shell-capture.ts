/**
 * The browser's pieces of the shell-drawn windows' pictures (shell-crops.ts,
 * docs/live-share.md §6.6): the shell's own page captured as a tab and read
 * frame by frame (WebCodecs' `MediaStreamTrackProcessor`), a window's
 * picture cut out of a frame (`new VideoFrame(frame, { visibleRect })`, which
 * copies nothing), and a track of its own to write those to
 * (`MediaStreamTrackGenerator`). Probed in Electron 43: the live-host window
 * captures the browser window's page at the size asked (frames in I420), a
 * crop of one goes out on the Mac's hardware encoder (VideoToolbox) at its
 * own size, or at a smaller display size, scaled; a crop must start on an
 * even pixel; the generator closes each frame written to it, and says the
 * size of the last in its settings (what the room reads for the bitrate). A
 * held window's last crop is copied out of the capture's frame
 * (`copyFrame`), so it keeps nothing of the capture's while it is held.
 * A capture brings a frame only when its page repaints — and when a reader
 * more starts on it (Chromium asks the source for the page as it is for a
 * new sink, and every reader of it gets that frame): `refresh` is one. The
 * report each frame was painted under is read off the few pixels its mark
 * lies in (`readShellMark`).
 */

import { MARK_BOX, readMark, type MarkReading } from "../../lib/live/marker";
import type { PixelSize } from "./capture-size";
import type { CropGenerator, FrameRect, ShellCapture } from "./shell-crops";
import { openTabCapture } from "./tab-capture";

type FrameReader = ReadableStreamDefaultReader<VideoFrame>;
type FrameProcessor = new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> };
type FrameGenerator = new (init: { kind: "video" }) => MediaStreamTrack & { writable: WritableStream<VideoFrame> };

/** How long a refresh's own reader waits for its frame before it is let go. */
const REFRESH_WAIT_MS = 1_000;

/** The shell's page captured at `size` (at most `fps`), read a frame at a time. */
export async function openShellCapture(sourceId: string, size: PixelSize, fps: number): Promise<ShellCapture<VideoFrame>> {
  const Processor = (globalThis as { MediaStreamTrackProcessor?: FrameProcessor }).MediaStreamTrackProcessor;
  if (Processor === undefined) throw new Error("this renderer cannot read a capture's frames");
  const track = await openTabCapture(sourceId, size, fps);
  const reader: FrameReader = new Processor({ track }).readable.getReader();
  let stopped = false;
  return {
    async read() {
      if (stopped) return null;
      const next = await reader.read();
      if (next.done || next.value === undefined) return null;
      return next.value;
    },
    resize: (to) => track.applyConstraints({ width: to.width, height: to.height }),
    refresh() {
      if (stopped) return;
      // A reader more on a clone of the track: the source sends the page as it is to every reader, this one's too.
      const clone = track.clone();
      const peek = new Processor({ track: clone }).readable.getReader();
      const done = (): void => {
        clearTimeout(timer);
        void peek.cancel().catch(() => undefined);
        clone.stop();
      };
      const timer = setTimeout(done, REFRESH_WAIT_MS);
      void peek.read().then(
        (next) => {
          next.value?.close();
          done();
        },
        done,
      );
    },
    stop() {
      if (stopped) return;
      stopped = true;
      void reader.cancel().catch(() => undefined);
      track.stop();
    },
  };
}

/** A window's picture track: frames written to it go out as a video track's. */
export function frameGenerator(): CropGenerator<MediaStreamTrack, VideoFrame> {
  const Generator = (globalThis as { MediaStreamTrackGenerator?: FrameGenerator }).MediaStreamTrackGenerator;
  if (Generator === undefined) throw new Error("this renderer cannot make a track of frames");
  const track = new Generator({ kind: "video" });
  const writer = track.writable.getWriter();
  return {
    track,
    write(frame) {
      // (Still taking the last one: this frame is dropped, the next one goes.)
      if (writer.desiredSize !== null && writer.desiredSize <= 0) return null;
      return writer.write(frame);
    },
    stop() {
      void writer.close().catch(() => undefined);
      track.stop();
    },
  };
}

/** `rect` of `frame` as a frame of its own (no pixels copied), shown at `size`. */
export function cutFrame(frame: VideoFrame, rect: FrameRect, size: PixelSize): VideoFrame {
  return new VideoFrame(frame, { visibleRect: rect, displayWidth: size.width, displayHeight: size.height });
}

/**
 * A crop's pixels — its visible rect, in the frame's own format and colours —
 * in a frame of their own, shown at the crop's display size: nothing of the
 * capture's whole frame, nor of the buffer it lies in, is kept with it.
 */
export async function copyFrame(frame: VideoFrame): Promise<VideoFrame> {
  const { format, visibleRect } = frame;
  if (format === null || visibleRect === null) throw new Error("this frame's pixels cannot be read");
  const rect = { x: visibleRect.x, y: visibleRect.y, width: visibleRect.width, height: visibleRect.height };
  const data = new Uint8Array(frame.allocationSize({ rect }));
  const layout = await frame.copyTo(data, { rect });
  return new VideoFrame(data, {
    format,
    codedWidth: rect.width,
    codedHeight: rect.height,
    layout,
    timestamp: frame.timestamp,
    displayWidth: frame.displayWidth,
    displayHeight: frame.displayHeight,
    colorSpace: frame.colorSpace.toJSON(),
  });
}

/**
 * The shell's mark painted in `frame` (lib/live/marker.ts: its report's
 * number, fresh or stale), its content's corner at `origin` at `scale`
 * frame px a CSS px: the luma of the mark's box alone copied out of the
 * frame — the Y plane comes first in every format a capture gives (I420,
 * NV12), a byte a pixel — and read. Probed, Electron 43: a copy of so few
 * pixels takes 0.1–0.2 ms.
 */
export async function readShellMark(frame: VideoFrame, origin: { x: number; y: number }, scale: number): Promise<MarkReading | null> {
  if (frame.format !== "I420" && frame.format !== "I420A" && frame.format !== "NV12") return null;
  // (A copy's rect starts on an even pixel and is of even sides: the chroma planes are a sample for two.)
  const x = Math.floor(origin.x / 2) * 2;
  const y = Math.floor(origin.y / 2) * 2;
  const rect = { x, y, width: Math.ceil((origin.x - x + MARK_BOX.w * scale) / 2) * 2, height: Math.ceil((origin.y - y + MARK_BOX.h * scale) / 2) * 2 };
  const visible = frame.visibleRect;
  if (visible === null || rect.x + rect.width > visible.x + visible.width || rect.y + rect.height > visible.y + visible.height) return null;
  const buffer = new Uint8Array(frame.allocationSize({ rect }));
  const [plane] = await frame.copyTo(buffer, { rect });
  if (plane === undefined) return null;
  return readMark((px, py) => buffer[plane.offset + (py - rect.y) * plane.stride + (px - rect.x)]!, origin, scale);
}
