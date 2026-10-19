/**
 * Captures of tab pages handed to a renderer as media source ids — the
 * shell's live picture of a covered desk window (BrowserController
 * .deskLiveSource), the live share's window streaming a shared one
 * (liveTabSource, docs/live-share.md §6.1). Electron asks the captured page's
 * session whether such a capture may start, and a tab's session grants
 * nothing to a contents not its tab's: so each is granted here, to the origin
 * it was handed to, once, for as long as Chromium's id lasts, and only as the
 * page's picture — never a camera, a microphone or the page's sound. One page
 * may be handed to both at once (the shell drawing a covered window live
 * while the share streams it): each gets its own grant.
 */
export class PageCaptureGrants {
  readonly #grants = new Map<number, Array<{ origin: string; until: number }>>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(ttlMs: number, now: () => number = Date.now) {
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  /** A capture of the page `capturedId` was handed to `origin`. */
  grant(capturedId: number, origin: string): void {
    const now = this.#now();
    const grants = (this.#grants.get(capturedId) ?? []).filter((grant) => grant.until >= now);
    grants.push({ origin, until: now + this.#ttlMs });
    this.#grants.set(capturedId, grants);
  }

  /** The page's own session asks whether `origin` may capture it now, for `mediaTypes`: yes, once, for a picture alone. */
  take(capturedId: number, origin: string | null, mediaTypes: readonly string[]): boolean {
    const grants = this.#grants.get(capturedId);
    if (grants === undefined || origin === null || mediaTypes.length > 0) return false;
    const at = grants.findIndex((grant) => grant.origin === origin);
    if (at === -1) return false;
    const [grant] = grants.splice(at, 1);
    if (grants.length === 0) this.#grants.delete(capturedId);
    return grant !== undefined && this.#now() <= grant.until;
  }
}
