/**
 * Cookie capture for the cloud browser (docs/cloud-sync-design.md §8.3).
 * Chromium's jar is read through raw CDP `Storage.getCookies` on the
 * browser-level session — never `context.cookies()`, which rewrites an
 * absent SameSite to `Lax` — and diffed against a baseline of projections
 * built only from read-backs. Diffs run after every tool action and after
 * a response carrying `set-cookie`, serialized on one promise chain with
 * the applier, and are skipped while the space hydrates.
 */

import type { CDPSession, Page } from "playwright-core";
import {
  attributesForCookie,
  canonicalIdentityBytes,
  computeRecordIdHex,
  identityForCookie,
  portableCookieFromCdp,
  type CdpCookie,
  type CookieAttributes,
  type CookieIdentity,
  type SameSite,
  toHex,
} from "@pistachio/sync-protocol";
import { errorMessage, silentLogger, type Logger } from "../logger.js";

export interface CookieJarReader {
  read(): Promise<CdpCookie[]>;
}

/** `Storage.getCookies({browserContextId})` over the runner's browser session. */
export class CdpCookieJar implements CookieJarReader {
  constructor(
    private readonly session: CDPSession,
    private readonly browserContextId: string,
  ) {}

  async read(): Promise<CdpCookie[]> {
    const result = await this.session.send("Storage.getCookies", { browserContextId: this.browserContextId });
    return result.cookies as CdpCookie[];
  }
}

/** The context's `browserContextId`, from `Target.getTargetInfo` on a page session. */
export async function browserContextIdFor(page: Page): Promise<string> {
  const session = await page.context().newCDPSession(page);
  try {
    const { targetInfo } = await session.send("Target.getTargetInfo");
    const id = (targetInfo as { browserContextId?: string }).browserContextId;
    if (id === undefined || id === "") throw new Error("page target has no browserContextId");
    return id;
  } finally {
    await session.detach().catch(() => undefined);
  }
}

/** What a diff compares: the cookie's state as the jar reports it. */
export interface CookieProjection {
  value: string;
  expiresSec: number | null;
  persistent: boolean;
  secure: boolean;
  httpOnly: boolean;
  sameSite: SameSite;
}

export interface BaselineEntry {
  identity: CookieIdentity;
  projection: CookieProjection;
}

export interface ProjectedCookie {
  identity: CookieIdentity;
  attributes: CookieAttributes;
  projection: CookieProjection;
}

/** Map one CDP cookie into its sync identity, attributes, and projection; null for partitioned cookies. */
export function projectCdpCookie(spaceId: string, cookie: CdpCookie): ProjectedCookie | null {
  const portable = portableCookieFromCdp(cookie);
  if (portable === null) return null;
  const identity = identityForCookie(spaceId, portable);
  if (identity === null) return null;
  const attributes = attributesForCookie(portable);
  return {
    identity,
    attributes,
    projection: {
      value: attributes.value,
      expiresSec: portable.session || portable.expirationDate === undefined ? null : portable.expirationDate,
      persistent: attributes.persistent,
      secure: attributes.secure,
      httpOnly: attributes.httpOnly,
      sameSite: attributes.sameSite,
    },
  };
}

export function projectionsEqual(a: CookieProjection, b: CookieProjection): boolean {
  return (
    a.value === b.value &&
    a.expiresSec === b.expiresSec &&
    a.persistent === b.persistent &&
    a.secure === b.secure &&
    a.httpOnly === b.httpOnly &&
    a.sameSite === b.sameSite
  );
}

/** The engine surface the capture drives. */
export interface CaptureEngine {
  localChange(
    identity: CookieIdentity,
    attrs: CookieAttributes | null,
    removed: boolean,
    chromiumCause: string,
  ): Promise<unknown>;
}

export interface PlaywrightCookieCaptureOptions {
  spaceId: string;
  jar: CookieJarReader;
  /** The space id key, for `recordIdHex` baseline keys. */
  idKey: CryptoKey;
  engine?: CaptureEngine;
  now?: () => number;
  isHydrating?: () => boolean;
  log?: Logger;
}

export class PlaywrightCookieCapture {
  readonly baseline = new Map<string, BaselineEntry>();
  /** identity -> recordId: the HMAC is deterministic per id key, so pay it once per cookie. */
  readonly #recordIds = new Map<string, string>();
  readonly #spaceId: string;
  readonly #jar: CookieJarReader;
  readonly #idKey: CryptoKey;
  readonly #now: () => number;
  #isHydrating: () => boolean;
  readonly #log: Logger;
  #engine: CaptureEngine | null;
  #chain: Promise<void> = Promise.resolve();
  #diffPending = false;
  #detached = false;

  constructor(options: PlaywrightCookieCaptureOptions) {
    this.#spaceId = options.spaceId;
    this.#jar = options.jar;
    this.#idKey = options.idKey;
    this.#engine = options.engine ?? null;
    this.#now = options.now ?? ((): number => Date.now());
    this.#isHydrating = options.isHydrating ?? ((): boolean => false);
    this.#log = options.log ?? silentLogger;
  }

  /**
   * The engine is built after the applier (which needs this capture): bind
   * it, and the hydration gate, once they exist.
   */
  attach(engine: CaptureEngine, isHydrating?: () => boolean): void {
    this.#engine = engine;
    if (isHydrating !== undefined) this.#isHydrating = isHydrating;
  }

  /** Serialize an operation with every diff and apply. */
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#chain.then(operation);
    this.#chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Every cookie in the jar becomes the baseline; nothing is published. */
  seedBaseline(): Promise<void> {
    return this.run(async () => {
      this.baseline.clear();
      for (const cookie of await this.#jar.read()) {
        const projected = projectCdpCookie(this.#spaceId, cookie);
        if (projected === null) continue;
        const recordId = await this.#recordIdFor(projected.identity);
        this.baseline.set(recordId, { identity: projected.identity, projection: projected.projection });
      }
    });
  }

  /** Queue one diff; a diff already queued absorbs this request. */
  scheduleDiff(): void {
    if (this.#detached || this.#diffPending) return;
    this.#diffPending = true;
    void this.run(async () => {
      this.#diffPending = false;
      await this.#diffLocked();
    }).catch((error: unknown) => {
      this.#log.warn("cookie diff failed", { spaceId: this.#spaceId, error: errorMessage(error) });
    });
  }

  /** Run a diff now (serialized); resolves when it has been handed to the engine. */
  diff(): Promise<void> {
    return this.run(() => this.#diffLocked());
  }

  /** Wait for every queued diff and apply to finish. */
  async drain(): Promise<void> {
    await this.#chain;
  }

  setBaseline(recordId: string, entry: BaselineEntry): void {
    this.baseline.set(recordId, entry);
  }

  deleteBaseline(recordId: string): void {
    this.baseline.delete(recordId);
  }

  detach(): void {
    this.#detached = true;
  }

  async #recordIdFor(identity: CookieIdentity): Promise<string> {
    const key = toHex(canonicalIdentityBytes(identity));
    const cached = this.#recordIds.get(key);
    if (cached !== undefined) return cached;
    const recordId = await computeRecordIdHex(this.#idKey, identity);
    this.#recordIds.set(key, recordId);
    return recordId;
  }

  async #diffLocked(): Promise<void> {
    if (this.#detached || this.#isHydrating()) return;
    const engine = this.#engine;
    if (engine === null) return;
    const seen = new Set<string>();
    const now = this.#now();
    for (const cookie of await this.#jar.read()) {
      const projected = projectCdpCookie(this.#spaceId, cookie);
      if (projected === null) continue;
      const recordId = await this.#recordIdFor(projected.identity);
      seen.add(recordId);
      const current = this.baseline.get(recordId);
      if (current === undefined) {
        this.baseline.set(recordId, { identity: projected.identity, projection: projected.projection });
        await engine.localChange(projected.identity, projected.attributes, false, "explicit");
      } else if (!projectionsEqual(current.projection, projected.projection)) {
        this.baseline.set(recordId, { identity: projected.identity, projection: projected.projection });
        await engine.localChange(projected.identity, projected.attributes, false, "overwrite");
      }
    }
    for (const [recordId, entry] of [...this.baseline]) {
      if (seen.has(recordId)) continue;
      this.baseline.delete(recordId);
      const expired = entry.projection.expiresSec !== null && entry.projection.expiresSec * 1000 <= now;
      await engine.localChange(entry.identity, null, true, expired ? "expired" : "explicit");
    }
  }
}
