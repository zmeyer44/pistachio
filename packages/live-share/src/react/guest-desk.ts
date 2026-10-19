/**
 * Which of the host's word on the desk a guest goes by (docs/live-share.md §4
 * `lv.desk`, `lv.sync`, `lv.grant`).
 *
 * Main numbers desk frames once per share, across the host app's reconnects
 * (`LiveDeskFrames`), so a frame — on its own or inside a sync — is shown
 * only when it is newer than the one up; nothing resets that count while the
 * share lasts. A sync can arrive after frames sent later than it (it is
 * compressed before it goes, they are not), so its desk is no exception.
 *
 * Grants likewise: a sync carries who used which window when the host
 * answered, after the guest asked, and any `lv.grant` heard since the guest
 * asked is no older than that — the host sends them in order, the sync
 * behind those sent before it — so it stays over the sync's word. That
 * holds for every answer to one asking: an answer to an earlier hello can
 * come after a later one's.
 */

import type { LiveDeskFrame, LiveGrant, LiveSync } from "../protocol.js";

export class GuestDesk {
  #seq = -1;
  #grants = new Map<string, string>();
  /** Grants heard since this asking for the room began (or since joining, before any), each window's newest. */
  #sinceAsked = new Map<string, string | null>();

  /** Whether `frame` is newer than the one shown; when it is, it is the one shown from now on. */
  take(frame: LiveDeskFrame): boolean {
    if (frame.seq <= this.#seq) return false;
    this.#seq = frame.seq;
    return true;
  }

  /**
   * An asking for the room began (joined, back from a reconnect, the host
   * back): every sync answering it is newer than what was heard before, and
   * older than grants heard from now on.
   */
  asked(): void {
    this.#sinceAsked = new Map();
  }

  /** Who uses which window now (window id → identity). */
  grants(): ReadonlyMap<string, string> {
    return this.#grants;
  }

  /** An `lv.grant`; returns the grants now. */
  grant(grant: LiveGrant): ReadonlyMap<string, string> {
    this.#sinceAsked.set(grant.w, grant.user);
    this.#grants = withGrant(this.#grants, grant.w, grant.user);
    return this.#grants;
  }

  /** A sync's grants, with any heard since it was asked for over them; returns the grants now. */
  synced(grants: LiveSync["grants"]): ReadonlyMap<string, string> {
    let next = new Map(grants.map((grant) => [grant.w, grant.user]));
    for (const [w, user] of this.#sinceAsked) next = withGrant(next, w, user);
    this.#grants = next;
    return next;
  }
}

function withGrant(grants: ReadonlyMap<string, string>, w: string, user: string | null): Map<string, string> {
  const next = new Map(grants);
  if (user === null) next.delete(w);
  else next.set(w, user);
  return next;
}
