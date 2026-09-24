import type { BrowserMediaInfo } from "@pistachio/shell-contracts/media";

/** How many cards the sidebar stack shows; the rest wait behind it, unseen. */
export const MAX_MEDIA_CARDS = 3;

/**
 * Put the stack's cards in the order they are drawn: front first.
 *
 * `background` arrives newest-active first, which is the order for the
 * audio cards. The live picture goes with the video that is playing — main
 * keeps that to one in the background — so that card comes to the front
 * whatever its age. Failing a playing one, the most recent video leads: a
 * paused picture is still the richer continuation, and the front is where
 * the picture returns when it resumes. The pick happens before the cut to
 * `MAX_MEDIA_CARDS`, so the video is never the fourth-newest card dropped
 * from the stack that exists to show it.
 */
export function orderMediaStack(background: readonly BrowserMediaInfo[]): BrowserMediaInfo[] {
  const playing = background.findIndex((item) => item.hasVideo && item.playing);
  const videoIndex = playing === -1 ? background.findIndex((item) => item.hasVideo) : playing;
  const ordered = videoIndex <= 0
    ? [...background]
    : [background[videoIndex]!, ...background.filter((_, index) => index !== videoIndex)];
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
