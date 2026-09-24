/**
 * Cookie capture — subscribes a Space session's cookies-'changed' stream
 * into the sync engine (docs/cloud-sync-design.md §10.2).
 *
 * Capture is skipped entirely while the Space is hydrating or a bulk writer
 * (a fork's cookie copy, a browser import) is filling the jar: bulk `set()`
 * calls must never be re-published as user mutations. The engine's
 * per-record echo tags cover any echoes that land after hydration ends.
 * Agent partitions never reach here — the service attaches capture to
 * human sessions only.
 */

import type { Cookie, Session } from "electron";
import type { SpaceSyncEngine } from "@pistachio/sync-engine";
import {
  attributesForCookie,
  identityForCookie,
  portableCookieFromElectron,
} from "@pistachio/sync-protocol";

export interface CookieCapture {
  /** Stop observing new Chromium mutations. Already-observed work still drains. */
  detach(): void;
  /** Wait until every cookie event observed before this call has been sealed and
   * handed to the transport (or its offline queue). */
  drain(): Promise<void>;
}

/** The engine surface capture needs; a fake in tests, the real engine in main. */
export type CaptureEngine = Pick<SpaceSyncEngine, "localChange">;

export function attachCookieCapture(
  ses: Session,
  spaceId: string,
  engine: CaptureEngine,
  isHydrating: () => boolean,
  onError: (err: unknown) => void,
  isDisabled: (cookie: Cookie) => boolean = () => false,
): CookieCapture {
  // Chromium commonly emits a whole Set-Cookie response as a burst. The sync
  // engine's rotating-auth lease is per origin, so processing that burst in
  // parallel lets same-origin lease requests race (and used to strand all but
  // one promise until timeout). One queue per Space preserves browser order,
  // coalesces naturally behind the first lease grant, and gives workspace
  // sync a real drain barrier to await before it publishes a restore point.
  let queue: Promise<void> = Promise.resolve();
  const listener = (
    _event: unknown,
    cookie: Cookie,
    cause: string,
    removed: boolean,
  ): void => {
    if (isHydrating() || isDisabled(cookie)) return;
    const portable = portableCookieFromElectron(cookie);
    const identity = identityForCookie(spaceId, portable);
    // Partitioned cookies are not synced in v1 (§2); Electron never reports
    // one, but the mapping's contract is honoured anyway.
    if (identity === null) return;
    const attrs = removed ? null : attributesForCookie(portable);
    // Chromium's cause string passes through untouched — causeForChange in
    // the engine maps it (overwrite-removal halves produce no record).
    queue = queue
      .then(async () => {
        await engine.localChange(identity, attrs, removed, cause);
      })
      .catch((err: unknown) => {
        // Keep the queue usable after one malformed/unpublishable cookie.
        onError(err);
      });
  };
  ses.cookies.on("changed", listener);
  return {
    detach: () => {
      ses.cookies.removeListener("changed", listener);
    },
    drain: async () => {
      await queue;
    },
  };
}
