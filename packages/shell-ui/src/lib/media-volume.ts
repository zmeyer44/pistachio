/**
 * A player's own volume, as a media card and the desk's floating player set
 * it: the page's element alone (`setVolume`), whatever the system's or
 * another player's, so a video and Read aloud playing together are each
 * turned up or down on their own.
 */

import { useCallback, useRef, useState } from "react";
import type { BrowserMediaInfo, MediaControl } from "@pistachio/shell-contracts/media";

export interface MediaVolume {
  /** What the slider shows: its draft while it is held, else what is heard (0 while muted). */
  volume: number;
  /** A slider is being moved. */
  held: boolean;
  /** The slider is taken up: let go all the way down, unmuting comes back to where it was taken from. */
  take(): void;
  set(volume: number): void;
  /** The slider is let go; what it shows is what the page reports again. The same function throughout. */
  release(): void;
  /** Muted, heard again (from silence: at the volume before it); heard, muted. */
  toggleMute(): void;
}

export function useMediaVolume(media: Pick<BrowserMediaInfo, "volume" | "muted">, send: (control: MediaControl) => void): MediaVolume {
  const [draft, setDraft] = useState<number | null>(null);
  // Where the slider was taken from: turned all the way down, the page's player is muted there (not silenced), so
  // Unmute brings it back from any control — this card, another, the floating player in its own view.
  const taken = useRef<number | null>(null);
  const volume = draft ?? (media.muted ? 0 : media.volume);
  const release = useCallback(() => setDraft(null), []);
  const take = () => {
    // While muted the player still reports its level: the one it is heard at again.
    if (media.volume > 0) taken.current = media.volume;
  };
  return {
    volume,
    held: draft !== null,
    take,
    set: (next) => {
      // A move with nothing held takes it up anew: the keyboard on a slider the pointer let go keeps its focus.
      if (draft === null) take();
      setDraft(next);
      send(next === 0 && taken.current !== null ? { type: "setVolume", volume: 0, restore: taken.current } : { type: "setVolume", volume: next });
    },
    release,
    toggleMute: () => {
      // The slider shows what the page reports from here: a value it was moved to by the keyboard is still held
      // while it keeps focus, and the mute is the newer word.
      setDraft(null);
      // Heard again at its own level, muted page-wide or in its player (from silence the page set itself: full).
      if (media.muted) send({ type: "setVolume", volume: media.volume > 0 ? media.volume : 1 });
      else send({ type: "mute" });
    },
  };
}

/** `0.7` → "70%". */
export function formatVolume(volume: number): string {
  return `${String(Math.round(volume * 100))}%`;
}
