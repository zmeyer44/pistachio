/**
 * Pure mapping between browser cookie shapes and the protocol's cookie model
 * (PRD §8.3 "Cookie identity — corrected"). Platform-neutral: the desktop
 * feeds Electron cookies through `portableCookieFromElectron`, the cloud
 * browser feeds CDP cookies through `portableCookieFromCdp`, and both apply
 * synced plaintext through the matching `*ForPlain` builder. No Electron or
 * Playwright imports — the structural types below mirror their shapes.
 */

import {
  hostKeyIsHostOnly,
  normalizedHost,
  type CookieAttributes,
  type CookieIdentity,
  type CookiePlain,
  type SameSite,
} from "./cookie.js";

export { hostKeyIsHostOnly };

/** A cookie as observed by any backend, normalized to Chromium's vocabulary. */
export interface PortableCookie {
  name: string;
  value: string;
  /** Chromium domain attribute; a leading dot marks a domain cookie. */
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  session: boolean;
  /** Seconds since epoch; absent for session cookies. */
  expirationDate?: number;
  sameSite: SameSite;
  /** Explicit host-only flag (CDP); when absent the leading dot decides. */
  hostOnly?: boolean;
  /** CHIPS top-level site; non-empty cookies are not synced in v1. */
  partitionKey?: string;
}

/** Structural mirror of Electron.Cookie (the cookies-'changed' payload). */
export interface ElectronCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  session?: boolean;
  /** Seconds since epoch; absent for session cookies. */
  expirationDate?: number;
  sameSite?: string;
}

export type ChromiumSameSite = "unspecified" | "no_restriction" | "lax" | "strict";

/** Structural mirror of Electron.CookiesSetDetails. Electron only. */
export interface ElectronCookieSetDetails {
  url: string;
  name: string;
  value: string;
  domain?: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** Seconds since epoch; omitted for session cookies. */
  expirationDate?: number;
  sameSite: ChromiumSameSite;
}

export interface ElectronCookieRemoveTarget {
  url: string;
  name: string;
}

export type PlaywrightSameSite = "Strict" | "Lax" | "None";

/** Structural mirror of the cookie shape `BrowserContext.addCookies` accepts. */
export interface PlaywrightSetCookie {
  name: string;
  value: string;
  /** Passed as-is: dotless ⇒ host-only, leading dot ⇒ domain cookie. */
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** Seconds since epoch; -1 for session cookies. */
  expires: number;
  /** Omitted for `unspecified`. */
  sameSite?: PlaywrightSameSite;
}

/** Structural mirror of CDP `Network.Cookie` (the fields this mapping reads). */
export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Seconds since epoch; negative for session cookies. */
  expires: number;
  secure: boolean;
  httpOnly: boolean;
  session?: boolean;
  sameSite?: PlaywrightSameSite;
  partitionKey?: { topLevelSite: string; hasCrossSiteAncestor?: boolean };
}

const SAME_SITES: ReadonlySet<string> = new Set(["unspecified", "no_restriction", "lax", "strict"]);

export function sameSiteFromChromium(value: string | undefined): SameSite {
  return value !== undefined && SAME_SITES.has(value) ? (value as SameSite) : "unspecified";
}

export function sameSiteToChromium(value: SameSite): ChromiumSameSite {
  return value;
}

const SAME_SITE_TO_PLAYWRIGHT: Record<Exclude<SameSite, "unspecified">, PlaywrightSameSite> = {
  no_restriction: "None",
  lax: "Lax",
  strict: "Strict",
};

const SAME_SITE_FROM_PLAYWRIGHT: Record<PlaywrightSameSite, SameSite> = {
  None: "no_restriction",
  Lax: "lax",
  Strict: "strict",
};

/**
 * Normalize an Electron cookie. Electron exposes no partition key (every
 * observed cookie maps with `partitionKey: ""`) and no host-only flag, so the
 * leading dot of `domain` decides scope.
 */
export function portableCookieFromElectron(cookie: ElectronCookie): PortableCookie {
  const out: PortableCookie = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain ?? "",
    path: cookie.path ?? "/",
    secure: cookie.secure === true,
    httpOnly: cookie.httpOnly === true,
    session: cookie.session === true || cookie.expirationDate === undefined,
    sameSite: sameSiteFromChromium(cookie.sameSite),
    partitionKey: "",
  };
  if (cookie.expirationDate !== undefined) out.expirationDate = cookie.expirationDate;
  return out;
}

/**
 * Normalize a CDP cookie. Partitioned cookies are dropped (`null`) — the
 * cloud browser neither syncs nor applies CHIPS cookies in v1. CDP `priority`
 * and `sourceScheme` are ignored; the scheme is approximated from `secure`
 * exactly as on the Electron side so identities agree across backends.
 */
export function portableCookieFromCdp(c: CdpCookie): PortableCookie | null {
  const partitionKey = c.partitionKey?.topLevelSite ?? "";
  if (partitionKey !== "") return null;
  const session = c.session === true || c.expires < 0;
  const out: PortableCookie = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    session,
    sameSite: c.sameSite === undefined ? "unspecified" : SAME_SITE_FROM_PLAYWRIGHT[c.sameSite],
    hostOnly: !c.domain.startsWith("."),
    partitionKey,
  };
  if (c.expires >= 0) out.expirationDate = c.expires;
  return out;
}

/**
 * Identity from an observed cookie. Host-only when `hostOnly === true` or the
 * domain has no leading dot; hostKey keeps the leading dot for domain cookies
 * (§8.3). Returns null for partitioned cookies, which are not synced in v1.
 * sourceScheme is approximated from `secure`; partitionKey is always "".
 */
export function identityForCookie(spaceId: string, cookie: PortableCookie): CookieIdentity | null {
  if (cookie.partitionKey !== undefined && cookie.partitionKey !== "") return null;
  const hostOnly = cookie.hostOnly === true || !cookie.domain.startsWith(".");
  return {
    spaceId,
    hostKey: hostOnly ? cookie.domain.replace(/^\./, "") : cookie.domain,
    name: cookie.name,
    path: cookie.path,
    partitionKey: "",
    sourceScheme: cookie.secure ? "secure" : "nonsecure",
  };
}

export function attributesForCookie(cookie: PortableCookie): CookieAttributes {
  const expiresMs =
    !cookie.session && cookie.expirationDate !== undefined
      ? Math.round(cookie.expirationDate * 1000)
      : null;
  return {
    value: cookie.value,
    expiresMs,
    persistent: expiresMs !== null,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    // Neither backend round-trips Chromium's priority field.
    priority: "medium",
  };
}

/** URL Electron's cookies.set/remove expects, rebuilt from identity scope. */
export function cookieUrlFor(identity: CookieIdentity, secure: boolean): string {
  const scheme = secure || identity.sourceScheme === "secure" ? "https" : "http";
  return `${scheme}://${normalizedHost(identity.hostKey)}${identity.path}`;
}

/** Electron `cookies.set` details for a synced cookie. Electron only. */
export function setDetailsForPlain(plain: CookiePlain): ElectronCookieSetDetails {
  const { identity, attributes } = plain;
  if (attributes === null) throw new Error("cannot build set details for a tombstone");
  const details: ElectronCookieSetDetails = {
    url: cookieUrlFor(identity, attributes.secure),
    name: identity.name,
    value: attributes.value,
    path: identity.path,
    secure: attributes.secure,
    httpOnly: attributes.httpOnly,
    sameSite: sameSiteToChromium(attributes.sameSite),
  };
  // Domain omitted for host-only cookies — passing it would widen scope.
  if (!hostKeyIsHostOnly(identity.hostKey)) details.domain = identity.hostKey;
  if (attributes.expiresMs !== null) details.expirationDate = attributes.expiresMs / 1000;
  return details;
}

export function removeTargetFor(identity: CookieIdentity): ElectronCookieRemoveTarget {
  return { url: cookieUrlFor(identity, false), name: identity.name };
}

/**
 * Playwright `addCookies` entry for a synced cookie. The host key is passed
 * as the domain verbatim, so Chromium keeps host-only vs domain scope; never
 * `url` (it would force host-only) and never `expirationDate`.
 */
export function playwrightCookieForPlain(plain: CookiePlain): PlaywrightSetCookie {
  const { identity, attributes } = plain;
  if (attributes === null) throw new Error("cannot build a Playwright cookie for a tombstone");
  const cookie: PlaywrightSetCookie = {
    name: identity.name,
    value: attributes.value,
    domain: identity.hostKey,
    path: identity.path,
    secure: attributes.secure,
    httpOnly: attributes.httpOnly,
    expires: attributes.expiresMs === null ? -1 : attributes.expiresMs / 1000,
  };
  if (attributes.sameSite !== "unspecified") {
    cookie.sameSite = SAME_SITE_TO_PLAYWRIGHT[attributes.sameSite];
  }
  return cookie;
}
