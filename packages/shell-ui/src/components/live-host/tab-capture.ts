/**
 * A tab's page as a video track, the way Chromium hands one to a renderer
 * that main gave a source id to (docs/live-share.md §2; as
 * components/desk/DeskLivePicture.tsx captures a covered window's page).
 * The legacy tab source takes its id and size as `mandatory` constraints and
 * gives frames of exactly that size, so the size asked for is the page box's
 * own shape (capture-size.ts).
 */

import type { PixelSize } from "./capture-size";

/** Open a capture of the tab `sourceId` names, the picture only, at `size`, at most `fps`. */
export async function openTabCapture(sourceId: string, size: PixelSize, fps: number): Promise<MediaStreamTrack> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: sourceId, maxWidth: size.width, maxHeight: size.height, maxFrameRate: fps },
    } as unknown as MediaTrackConstraints,
  });
  const [video] = stream.getVideoTracks();
  for (const track of stream.getTracks()) if (track !== video) track.stop();
  if (video === undefined) throw new Error("the capture has no picture");
  return video;
}

/** Chromium's frame reader over a track (WebCodecs' MediaStreamTrackProcessor), as far as this uses it. */
interface FrameReader {
  read(): Promise<{ done: boolean; value?: { close(): void } }>;
  cancel(): Promise<void>;
}
type FrameProcessor = new (init: { track: MediaStreamTrack }) => { readable: { getReader(): FrameReader } };

/**
 * Whether `track` brings a frame within `ms`. Read from a clone, so the
 * track itself is untouched; a browser without the frame reader says yes
 * (nothing to judge by). A tab capture brings its first frame at once from a
 * page that has been laid out — none from one that never was.
 */
export async function firstFrame(track: MediaStreamTrack, ms: number): Promise<boolean> {
  const Processor = (globalThis as { MediaStreamTrackProcessor?: FrameProcessor }).MediaStreamTrackProcessor;
  if (Processor === undefined) return true;
  const clone = track.clone();
  const reader = new Processor({ track: clone }).readable.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([reader.read(), new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)))]);
    result?.value?.close();
    return result !== null && result.value !== undefined;
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
    clone.stop();
  }
}
