/**
 * What a desk plays on without a window of its own (docs/desk.md, "Now
 * playing"). On a desk several pages are in view at once, so media does not
 * leave its window when another tab is chosen, as it leaves the pane: the
 * person sends it from its window's frame (Pop out), and the window goes
 * into its row. From there it plays on as background media does — in the
 * whole sidebar, the media stack's card; on the rail, a video as a floating
 * player over the desk and audio as a button in the rail.
 *
 * Kept here: which tabs were sent (they play on muted or not, which the
 * stack's own rule for a video leaving its pane would not keep), and where
 * the floating player was left (on this device).
 */

import { create } from "zustand";

/** The floating player's spot: its top-left corner, as fractions of the window's content box. */
export interface PipSpot {
  x: number;
  y: number;
}

interface NowPlayingState {
  /** The tabs whose media the person sent from their windows on a desk. */
  popped: readonly string[];
  /** Where the floating player was left, or null for its first place (beside the rail, at the desk's foot). */
  pip: PipSpot | null;
  pop(tabId: string): void;
  /** The tab is back in a window (or its media is gone): no longer sent. */
  forget(tabId: string): void;
  placePip(spot: PipSpot): void;
}

const PIP_KEY = "pistachio.desk.pip.v1";

function readPip(): PipSpot | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(PIP_KEY) ?? "null");
    if (typeof raw !== "object" || raw === null) return null;
    const { x, y } = raw as Record<string, unknown>;
    return typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  } catch {
    return null;
  }
}

export const useNowPlaying = create<NowPlayingState>((set, get) => ({
  popped: [],
  pip: readPip(),
  pop: (tabId) => {
    if (!get().popped.includes(tabId)) set({ popped: [...get().popped, tabId] });
  },
  forget: (tabId) => {
    if (get().popped.includes(tabId)) set({ popped: get().popped.filter((id) => id !== tabId) });
  },
  placePip: (spot) => {
    set({ pip: spot });
    try {
      localStorage.setItem(PIP_KEY, JSON.stringify(spot));
    } catch {
      // (Kept for this session only.)
    }
  },
}));
