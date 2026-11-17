/**
 * A Glance is the tab's it was opened from (docs/desk.md, "A Glance on the
 * desk"): up while that tab is the one in use, down while another is — its
 * page kept as it was, hidden, never closed — and back, as it was, when that
 * tab is in use again. One to a tab. Taken in (⤢, a tile), it is an ordinary
 * tab and none of this is about it. The browser controller holds the views
 * and does the hiding; this says which Glance goes down and which comes up.
 */

export interface ScopedGlance {
  /** The tab it was opened from. */
  ownerTabId: string;
  /**
   * Its close has been asked for (prepareGlanceClose, from the moment it is
   * asked, before its last frame is taken): it goes, never kept.
   */
  dismissed: boolean;
}

export interface GlanceMoves<G> {
  /** The Glance up whose tab is no longer in use: down, kept for its tab. */
  hide: G | null;
  /** The Glance up whose tab is no longer in use, already being dismissed: closed, not kept. */
  close: G | null;
  /** The Glance of the tab now in use, which was down: back up. */
  show: G | null;
}

/**
 * What the tab in use becoming `inUse` (null: none, an empty space in front)
 * does to the Glances: `up`, the one up, goes down unless it is that tab's,
 * and that tab's own (in `down`, by its tab's id) comes back.
 */
export function glanceMoves<G extends ScopedGlance>(up: G | null, down: ReadonlyMap<string, G>, inUse: string | null): GlanceMoves<G> {
  const leaving = up !== null && up.ownerTabId !== inUse ? up : null;
  const stays = leaving === null ? up : null;
  return {
    hide: leaving !== null && !leaving.dismissed ? leaving : null,
    close: leaving !== null && leaving.dismissed ? leaving : null,
    show: stays === null && inUse !== null ? (down.get(inUse) ?? null) : null,
  };
}

/**
 * A Glance back with its tab stands over its pages' pictures taken afresh
 * (BrowserController #settleBackdrop): those just taken, and for any page
 * it had a picture of that none could be taken of now (still waking, or
 * kept down by an overlay past the wait for it), the one it had. So it
 * never stands over nothing when it had a backdrop.
 */
export function freshenStills<S extends { tabId: string }>(had: readonly S[], fresh: readonly S[]): S[] {
  const taken = new Set(fresh.map((still) => still.tabId));
  return [...fresh, ...had.filter((still) => !taken.has(still.tabId))];
}
