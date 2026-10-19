import { sharedSpace } from "../../lib/live/entries";
import { useLiveShare } from "../../lib/live/store";

/**
 * The shared space's live mark (docs/live-share.md §1): a dot in the live
 * colour — the red that means other people can see this, as a screen share's
 * — with a soft pulse three times as it comes and as someone comes or goes,
 * then still (none with reduced motion). On the space's rail tile (or
 * Home's, for a Home tab shared) and beside its name in the card's head.
 */
export function LiveMark() {
  const guests = useLiveShare((state) => state.participants.length);
  // (A new key is a new dot, whose pulses start again.)
  return <span key={guests} aria-hidden="true" data-testid="live-mark" className="live-mark" />;
}

/** "Live · 2": what the mark's tooltip says, and its words for a screen reader. */
export function liveMarkLabel(guests: number): string {
  return `Live · ${String(guests)}`;
}

/** Whether `groupId`'s space is shared live (or being shared), and how many guests are in: the mark's facts. */
export function useLiveMarkFor(groupId: string | null): { live: boolean; guests: number } {
  const live = useLiveShare((state) => groupId !== null && sharedSpace(state) === groupId);
  const guests = useLiveShare((state) => (groupId !== null && sharedSpace(state) === groupId ? state.participants.length : 0));
  return { live, guests };
}
