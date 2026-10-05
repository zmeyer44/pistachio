/**
 * A covered desk window's page, live (docs/desk.md, "Live and drawn"). A
 * window with anything over it is drawn by the shell, its still, since its
 * page's native view would paint over the window above it
 * (geometry.uncoveredWindows). One whose page plays a video would stand
 * still on that picture while the video went on under it, so it is drawn
 * from a capture of its page instead: main hands over a tab capture of the
 * page (deskLiveSource), the picture only (its sound plays on as it was),
 * drawn over the still once its first frame comes, and let go the moment
 * the window is live again or the video stops (DeskWindow unmounts this).
 */

import { useEffect, useRef, useState } from "react";
import { nativeApi } from "../../api";

/** No more frames than a page's video has, and no more pixels than the window shows (at most twice its size). */
const LIVE_FPS = 30;
const MAX_SCALE = 2;

export function DeskLivePicture({ tabId }: { tabId: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const video = ref.current;
    const api = nativeApi();
    if (video === null || api === null || typeof navigator.mediaDevices?.getUserMedia !== "function") return;
    let stream: MediaStream | null = null;
    let gone = false;
    const stop = (): void => {
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
    };
    void (async () => {
      const id = await api.deskLiveSource(tabId).catch(() => null);
      if (gone || id === null) return;
      // At the page's own shape: a capture of another is letterboxed into it.
      const scale = Math.min(MAX_SCALE, window.devicePixelRatio || 1);
      const width = Math.max(1, Math.round(video.offsetWidth * scale));
      const height = Math.max(1, Math.round(video.offsetHeight * scale));
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          // Chromium's tab source takes its id and size the legacy way.
          video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: id, maxWidth: width, maxHeight: height, maxFrameRate: LIVE_FPS } } as unknown as MediaTrackConstraints,
        });
      } catch {
        // No capture: the still stays, as it was before there was this.
        return;
      }
      if (gone) {
        stop();
        return;
      }
      video.srcObject = stream;
      video.requestVideoFrameCallback(() => {
        if (!gone) setShown(true);
      });
      void video.play().catch(() => undefined);
    })();
    return () => {
      gone = true;
      stop();
      video.srcObject = null;
    };
  }, [tabId]);

  return (
    <video
      ref={ref}
      aria-hidden="true"
      muted
      playsInline
      data-testid="desk-live-picture"
      data-shown={shown ? "" : undefined}
      // Laid over the still as the still is laid in the page box; the page box takes the pointer, as it does over the still.
      className="pointer-events-none absolute inset-0 size-full object-cover object-left-top opacity-0 data-[shown]:opacity-100"
    />
  );
}
