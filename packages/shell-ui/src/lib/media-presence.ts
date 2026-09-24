import type { BrowserMediaInfo } from "@pistachio/shell-contracts/media";

export const MEDIA_ENTER_MS = 350;
export const MEDIA_EXIT_MS = 250;
export interface MediaPresence {
  media: BrowserMediaInfo;
  showVideo: boolean;
  exitAt: number | null;
}

/** Retain departing cards while their slots collapse; preserve stable React keys. */
export function reconcileMediaPresence(
  previous: readonly MediaPresence[],
  media: readonly BrowserMediaInfo[],
  now: number,
  reducedMotion: boolean,
): MediaPresence[] {
  const next: MediaPresence[] = media.map((item, index) => ({
    media: item,
    showVideo: index === 0 && item.hasVideo,
    exitAt: null,
  }));
  if (!reducedMotion) {
    const ids = new Set(media.map((item) => item.tabId));
    previous.forEach((entry, index) => {
      if (
        !ids.has(entry.media.tabId) &&
        (entry.exitAt === null || entry.exitAt > now)
      ) {
        next.splice(Math.min(index, next.length), 0, {
          ...entry,
          exitAt: entry.exitAt ?? now + MEDIA_EXIT_MS,
        });
      }
    });
  }
  return next;
}
