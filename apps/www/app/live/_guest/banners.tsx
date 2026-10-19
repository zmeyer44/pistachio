/**
 * What changed in the room, said in a line at the top (docs/live-share.md §1
 * In the room): the host left the space or came back, gave a window over or
 * took it back, turned drawing off, the connection is coming back, the tab's
 * sound is off, a background did not go on, the camera or microphone did not
 * come back after the connection dropped. Some last while they are true; the
 * rest go after a few seconds.
 *
 * One line at a time — the one that began last, news that just came or a
 * state that just began (the host left), so a state that lasts (the sound
 * is off) never hides what happened since — in a place the room keeps for
 * it: inside the top bar, or, where the bar is too narrow, in a row under it
 * that the stage starts below. A banner never lies over a window's label.
 */

import { Hand, ImageOff, LoaderCircle, LogIn, MicOff, Moon, PenLine, PenOff, VideoOff, Volume2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export type BannerIcon = "away" | "back" | "background" | "camera-off" | "hand" | "drawing-off" | "drawing-on" | "mic-off" | "reconnecting" | "sound";

export interface Banner {
  id: string;
  icon: BannerIcon;
  text: ReactNode;
  action?: { label: string; run(): void };
  /** Shown while something is true (the host away, reconnecting): no close button. */
  persistent?: boolean;
  /** When it was given (`performance.now()`), for news that comes again under the same id; a lasting state begins when first seen. */
  at?: number;
}

const ICONS: Readonly<Record<BannerIcon, ReactNode>> = {
  away: <Moon aria-hidden="true" />,
  back: <LogIn aria-hidden="true" />,
  background: <ImageOff aria-hidden="true" />,
  "camera-off": <VideoOff aria-hidden="true" />,
  hand: <Hand aria-hidden="true" />,
  "drawing-off": <PenOff aria-hidden="true" />,
  "drawing-on": <PenLine aria-hidden="true" />,
  "mic-off": <MicOff aria-hidden="true" />,
  reconnecting: <LoaderCircle aria-hidden="true" className="lv-spin" />,
  sound: <Volume2 aria-hidden="true" />,
};

const SHOW_MS = 4_200;

/** Banners that go by themselves: `push` one, and it leaves after a few seconds (or when dismissed). */
export function useTransientBanners(): { banners: Banner[]; push(banner: Banner): void; dismiss(id: string): void } {
  const [banners, setBanners] = useState<Banner[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.current.delete(id);
    setBanners((current) => current.filter((banner) => banner.id !== id));
  }, []);

  const push = useCallback(
    (banner: Banner) => {
      // The same news again replaces itself (and its timer) rather than stacking.
      const existing = timers.current.get(banner.id);
      if (existing !== undefined) clearTimeout(existing);
      const given = { ...banner, at: performance.now() };
      setBanners((current) => [...current.filter((each) => each.id !== banner.id), given].slice(-3));
      timers.current.set(
        banner.id,
        setTimeout(() => dismiss(banner.id), SHOW_MS),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const all = timers.current;
    return () => {
      for (const timer of all.values()) clearTimeout(timer);
      all.clear();
    };
  }, []);

  return { banners, push, dismiss };
}

/** The banner that began last: news when it was given (again), a lasting state when it was first seen; ties go to the later in the list. */
function useNewest(banners: Banner[]): Banner | null {
  const firstSeen = useRef(new Map<string, number>());
  const ids = new Set(banners.map((banner) => banner.id));
  for (const id of firstSeen.current.keys()) if (!ids.has(id)) firstSeen.current.delete(id);
  const now = performance.now();
  let newest: { banner: Banner; began: number } | null = null;
  for (const banner of banners) {
    if (!firstSeen.current.has(banner.id)) firstSeen.current.set(banner.id, now);
    const began = banner.at ?? firstSeen.current.get(banner.id) ?? now;
    if (newest === null || began >= newest.began) newest = { banner, began };
  }
  return newest?.banner ?? null;
}

export function Banners({ banners, onDismiss }: { banners: Banner[]; onDismiss(id: string): void }) {
  const newest = useNewest(banners);
  return (
    <div className="lvg-banners" role="status" aria-live="polite">
      {(newest === null ? [] : [newest]).map((banner) => (
        <div key={banner.id} className="lvg-banner" data-icon={banner.icon}>
          <span className="lvg-banner-icon">{ICONS[banner.icon]}</span>
          <span className="lvg-banner-text">{banner.text}</span>
          {banner.action === undefined ? null : (
            <button type="button" className="lvg-banner-action" onClick={banner.action.run}>
              {banner.action.label}
            </button>
          )}
          {banner.action === undefined && banner.persistent !== true ? (
            <button type="button" className="lvg-banner-close" aria-label="Dismiss" onClick={() => onDismiss(banner.id)}>
              <X aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
