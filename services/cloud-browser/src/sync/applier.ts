/**
 * Applies engine-accepted records to the context's cookie jar
 * (docs/cloud-sync-design.md §8.3). A live record becomes
 * `context.addCookies([playwrightCookieForPlain(plain)])` followed by a raw
 * CDP read-back; when Chromium silently refused the cookie (SameSite=None
 * without Secure, a `__Host-` prefix rule, …) the record stays uncommitted
 * behind `CookieRejectedError`, exactly as Electron's rejection does. A
 * tombstone is `context.clearCookies({name, domain, path})` — exact string
 * matches, so siblings under other scopes and paths are untouched. The
 * capture's baseline is updated from the read-back before returning, so the
 * next diff sees no change and nothing is published twice.
 */

import {
  computeRecordIdHex,
  playwrightCookieForPlain,
  type Cause,
  type CookieIdentity,
  type CookiePlain,
  type PlaywrightSetCookie,
} from "@pistachio/sync-protocol";
import type { CookieApplier } from "@pistachio/sync-engine";
import { projectCdpCookie, type CookieJarReader, type PlaywrightCookieCapture } from "./capture.js";

export class CookieRejectedError extends Error {
  constructor(readonly identity: CookieIdentity) {
    super(`cookie rejected by the browser: ${identity.hostKey} ${identity.name} ${identity.path}`);
    this.name = "CookieRejectedError";
  }
}

/** The slice of `BrowserContext` the applier writes through. */
export interface CookieStore {
  addCookies(cookies: PlaywrightSetCookie[]): Promise<void>;
  clearCookies(filter: { name: string; domain: string; path: string }): Promise<void>;
}

export interface PlaywrightCookieApplierOptions {
  store: CookieStore;
  jar: CookieJarReader;
  capture: PlaywrightCookieCapture;
  spaceId: string;
  idKey: CryptoKey;
}

export class PlaywrightCookieApplier implements CookieApplier {
  readonly #store: CookieStore;
  readonly #jar: CookieJarReader;
  readonly #capture: PlaywrightCookieCapture;
  readonly #spaceId: string;
  readonly #idKey: CryptoKey;

  constructor(options: PlaywrightCookieApplierOptions) {
    this.#store = options.store;
    this.#jar = options.jar;
    this.#capture = options.capture;
    this.#spaceId = options.spaceId;
    this.#idKey = options.idKey;
  }

  apply(plain: CookiePlain, _cause: Cause): Promise<void> {
    return this.#capture.run(async () => {
      const identity = plain.identity;
      const recordId = await computeRecordIdHex(this.#idKey, identity);
      if (plain.deleted || plain.attributes === null) {
        await this.#store.clearCookies({ name: identity.name, domain: identity.hostKey, path: identity.path });
        this.#capture.deleteBaseline(recordId);
        return;
      }
      await this.#store.addCookies([playwrightCookieForPlain(plain)]);
      const match = (await this.#jar.read()).find(
        (cookie) => cookie.name === identity.name && cookie.domain === identity.hostKey && cookie.path === identity.path,
      );
      // Playwright does not throw when Chromium refuses a write, so an
      // UPDATE to a cookie that already exists (SameSite=None without Secure,
      // a `__Host-`/`__Secure-` rule) leaves the stale one standing and
      // matching on name/domain/path alone. Committing the record then hides
      // the divergence: the value the account believes is set is not the one
      // the jar holds, and no later diff notices because the baseline is set
      // from the stale read-back too.
      if (match === undefined || match.value !== plain.attributes.value) {
        throw new CookieRejectedError(identity);
      }
      const projected = projectCdpCookie(this.#spaceId, match);
      if (projected === null) throw new CookieRejectedError(identity);
      this.#capture.setBaseline(recordId, { identity: projected.identity, projection: projected.projection });
    });
  }
}
