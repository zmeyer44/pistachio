import type { BrowserMediaInfo } from "@pistachio/shell-contracts/media";

/** `75` → "1:15", an hour on → "1:01:15". */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3_600);
  const minutes = Math.floor((whole % 3_600) / 60);
  const remainder = whole % 60;
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${remainder.toString().padStart(2, "0")}`
    : `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

/** Where the playhead is now, moved on from the last report at its rate while playing. */
export function projectedPosition(
  media: Pick<BrowserMediaInfo, "playing" | "updatedAt" | "playbackRate" | "duration" | "position">,
  now: number,
): number {
  const elapsed = media.playing
    ? (Math.max(0, now - media.updatedAt) / 1_000) * media.playbackRate
    : 0;
  return Math.min(
    media.duration ?? Number.POSITIVE_INFINITY,
    Math.max(0, media.position + elapsed),
  );
}

/** How many cards the sidebar stack shows; the rest wait behind it, unseen. */
export const MAX_MEDIA_CARDS = 3;

/**
 * Put the stack's cards in the order they are drawn: front first.
 *
 * `background` arrives newest-active first (an item is active again when
 * it starts playing). What is playing leads: the live picture goes with the
 * video that is playing — main keeps that to one in the background, and
 * only the front card draws it — so that card comes first whatever its age;
 * failing one, the most recently started of whatever else is playing (Read
 * aloud started over a paused video comes in front of it). With nothing
 * playing the newest-active order stands, so pausing the front card leaves
 * it where it is; a paused video is no longer pulled ahead of newer audio,
 * and the front is where its picture returns when it plays again. The pick
 * happens before the cut to `MAX_MEDIA_CARDS`, so what is playing is never
 * the fourth-newest card dropped from the stack.
 */
export function orderMediaStack(background: readonly BrowserMediaInfo[]): BrowserMediaInfo[] {
  const video = background.findIndex((item) => item.hasVideo && item.playing);
  const lead = video === -1 ? background.findIndex((item) => item.playing) : video;
  const ordered = lead <= 0
    ? [...background]
    : [background[lead]!, ...background.filter((_, index) => index !== lead)];
  return ordered.slice(0, MAX_MEDIA_CARDS);
}

/** The page that plays a "Read aloud" clip; its tab is unlisted and exists only for its card. */
const READ_ALOUD_URL_PREFIX = "pistachio://read-aloud/";

/** How long a finished "Read aloud" card stays once nobody is looking at the stack. */
export const READ_ALOUD_LINGER_MS = 5_000;

/** A clip is at its end when this close to its duration: `ended` reports land on it exactly. */
const END_TOLERANCE_S = 0.25;

export function isReadAloudPlayer(media: Pick<BrowserMediaInfo, "tabUrl">): boolean {
  return media.tabUrl.startsWith(READ_ALOUD_URL_PREFIX);
}

/**
 * Whether a "Read aloud" clip has played to its end: stopped, at its last
 * moment. A card in that state is a finished toast, not a player anyone is
 * using, so it leaves on its own after `READ_ALOUD_LINGER_MS` unless the
 * stack is being hovered or holds keyboard focus. Playing it again or
 * seeking back takes it out of this state, and the countdown with it.
 */
export function readAloudFinished(
  media: Pick<BrowserMediaInfo, "tabUrl" | "playing" | "position" | "duration">,
): boolean {
  return (
    isReadAloudPlayer(media) &&
    !media.playing &&
    media.duration !== null &&
    media.duration > 0 &&
    media.position >= media.duration - END_TOLERANCE_S
  );
}
