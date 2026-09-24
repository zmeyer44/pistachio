/**
 * ElectronCookieApplier — applies engine-accepted records to a Space
 * session's cookie store (§10.2 hydration/apply path). The engine calls this
 * only for records that won conflict resolution.
 */

import type { Session } from "electron";
import {
  removeTargetFor,
  setDetailsForPlain,
  type Cause,
  type CookieIdentity,
  type CookiePlain,
} from "@pistachio/sync-protocol";
import type { CookieApplier } from "@pistachio/sync-engine";
import { collateralFor, lostCollateral, restoreDetailsFor } from "./collateral";

/** The slice of an Electron session the applier touches; a fake in tests. */
export type CookieJar = Pick<Session["cookies"], "get" | "set" | "remove">;

export class ElectronCookieApplier implements CookieApplier {
  readonly #jar: CookieJar;
  readonly #disabled: (host: string, name: string) => boolean;

  constructor(
    session: { cookies: CookieJar },
    disabled: (host: string, name: string) => boolean = () => false,
  ) {
    this.#jar = session.cookies;
    this.#disabled = disabled;
  }

  canApply(plain: CookiePlain): boolean {
    return !this.#disabled(plain.identity.hostKey, plain.identity.name);
  }

  async apply(plain: CookiePlain, _cause: Cause): Promise<void> {
    if (!this.canApply(plain)) return;
    if (plain.deleted || plain.attributes === null) {
      await this.#removeSurgically(plain.identity);
      return;
    }
    const details = setDetailsForPlain(plain);
    try {
      await this.#jar.set(details);
    } catch (err) {
      // Chromium silently refuses cookies whose reconstructed url/attributes
      // don't satisfy its rules (__Host-/__Secure- prefixes, SameSite=None
      // without Secure, domain/url mismatch). That refusal is exactly a
      // logged-out site on this device, so surface it instead of swallowing.
      console.warn(
        `[sync] could not set ${plain.identity.hostKey} ${plain.identity.name} ` +
          `(url=${details.url} secure=${String(details.secure)} sameSite=${details.sameSite}): ${String(err)}`,
      );
      throw err;
    }
  }

  /**
   * cookies.remove(url, name) cannot disambiguate cookies sharing a name
   * across host-only vs domain scope or across paths, so it may take out
   * siblings of the tombstoned cookie. Snapshot the name's cookies first,
   * remove, then re-set any non-target cookie that disappeared.
   */
  async #removeSurgically(identity: CookieIdentity): Promise<void> {
    const target = removeTargetFor(identity);
    const before = await this.#jar.get({ name: identity.name });
    const collateral = collateralFor(identity, before);
    await this.#jar.remove(target.url, target.name);
    if (collateral.length === 0) return;
    const after = await this.#jar.get({ name: identity.name });
    for (const lost of lostCollateral(collateral, after)) {
      await this.#jar.set(restoreDetailsFor(identity.spaceId, lost));
    }
  }
}
