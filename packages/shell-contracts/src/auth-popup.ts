/** The window-opening signals that require a real child browsing context. */
export interface WindowOpenIntent {
  url: string;
  frameName: string;
  features: string;
}

const IDENTITY_HOSTS = new Set([
  "accounts.google.com",
  "appleid.apple.com",
  "github.com",
  "login.live.com",
  "login.microsoftonline.com",
]);

const AUTH_PATH =
  /(?:^|[/_-])(auth|authorize|log[\s_-]?(?:in|out)|oauth|saml|sign[\s_-]?(?:in|out)|sso)(?:[/_?&=-]|$)/iu;
const POPUP_FEATURE =
  /(?:^|,)\s*(?:height|left|popup|screenx|screeny|top|width)\s*(?:=|,|$)/iu;
const AUTH_FRAME_NAME =
  /(auth|google|log[\s_-]?(?:in|out)|oauth|sign[\s_-]?(?:in|out)|sso)/iu;

/** True for a navigation that is likely to establish, change, or clear browser identity. */
export function isAuthenticationNavigation(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (IDENTITY_HOSTS.has(host)) {
      // github.com hosts plenty of ordinary pages; only its login/auth routes
      // should be promoted to a browser-owned authentication window.
      if (host !== "github.com" || AUTH_PATH.test(url.pathname)) return true;
    }
    return AUTH_PATH.test(`${url.pathname}${url.search}`);
  } catch {
    return false;
  }
}

/**
 * OAuth libraries often open `about:blank` first and navigate it later. Named
 * windows and popup geometry preserve that intent even before an auth URL is
 * visible, so they must retain a real `window.opener` relationship too.
 */
export function shouldPreserveAuthenticationPopup(
  intent: WindowOpenIntent,
): boolean {
  if (isAuthenticationNavigation(intent.url)) return true;
  if (POPUP_FEATURE.test(intent.features)) return true;
  const frameName = intent.frameName.trim();
  return (
    frameName !== "" &&
    frameName !== "_blank" &&
    AUTH_FRAME_NAME.test(frameName)
  );
}

/** True when a cookie can be sent to the given relying-party hostname. */
export function cookieDomainMatchesHostname(
  domain: string | undefined,
  hostname: string,
): boolean {
  const normalizedDomain = domain?.replace(/^\.+/u, "").toLowerCase() ?? "";
  const normalizedHostname = hostname.toLowerCase();
  return (
    normalizedDomain !== "" &&
    (normalizedHostname === normalizedDomain ||
      normalizedHostname.endsWith(`.${normalizedDomain}`))
  );
}

/* ------------------------- owner refresh after a popup ------------------------- */

/** How long to wait for a session cookie after a popup closes without a callback page. */
export const AUTH_SESSION_SETTLE_MS = 5_000;
/** How long to wait for a session cookie after a popup that ended on the owner's origin. */
export const AUTH_CALLBACK_COOKIE_WAIT_MS = 1_000;
/**
 * The least time since the popup closed before a refresh, when the signal is
 * one only a server could produce: a callback page on the owner's origin or
 * an HttpOnly cookie. The page's own script has had its turn by then.
 */
export const AUTH_SERVER_SIGNAL_SETTLE_MS = 500;
/**
 * The least time since the popup closed before a refresh, when the only
 * signal is a script-visible cookie. Analytics rewrite those on every click,
 * so this is as likely churn as identity; the page is given long enough to
 * finish its own credential exchange and move itself before the browser
 * steps in.
 */
export const AUTH_SCRIPT_SIGNAL_SETTLE_MS = 3_000;
/** A quiet period after the last cookie change so a Set-Cookie burst commits whole. */
export const AUTH_COOKIE_COMMIT_DELAY_MS = 250;

export interface AuthenticationRefreshSignals {
  /** When the popup window closed. */
  closedAt: number;
  now: number;
  /** The popup navigated back to the owner's origin (a callback page) before closing. */
  returnedToOwnerOrigin: boolean;
  /** When a cookie for the owner's host last changed, or null if none has since the popup opened. */
  lastCookieChangeAt: number | null;
  /** A changed cookie was HttpOnly, which only a server response can set. */
  serverCookieChanged: boolean;
  /**
   * The owner page started a cross-document navigation of its own (a script
   * redirect after its credential exchange, or an opener reload from the
   * callback page), or is still loading one.
   */
  ownerNavigated: boolean;
}

export type AuthenticationRefreshPlan =
  /** Not yet decided; plan again at `until`. */
  | { action: "wait"; until: number }
  /** The page handled its own transition; a reload now would only race it. */
  | { action: "skip" }
  /** Nothing observable changed; reload only if the owner's cookies differ from before. */
  | { action: "compare" }
  | { action: "refresh" };

/**
 * Decide whether the browser should reload a relying-party page after its
 * authentication popup closed. Sites that finish sign-in in the opener —
 * a Google Identity Services credential exchanged over fetch, then a script
 * redirect — need no help, and a reload issued into that redirect cancels
 * it: a browser-initiated navigation wins over a script one without a user
 * gesture, and the page is left on its stale sign-in document. Sites that
 * only set cookies and expect the opener to notice do need the reload.
 */
export function authenticationRefreshPlan(
  signals: AuthenticationRefreshSignals,
): AuthenticationRefreshPlan {
  if (signals.ownerNavigated) return { action: "skip" };
  const { closedAt, now, lastCookieChangeAt } = signals;
  if (lastCookieChangeAt === null) {
    const until =
      closedAt +
      (signals.returnedToOwnerOrigin
        ? AUTH_CALLBACK_COOKIE_WAIT_MS
        : AUTH_SESSION_SETTLE_MS);
    if (now < until) return { action: "wait", until };
    return signals.returnedToOwnerOrigin
      ? { action: "refresh" }
      : { action: "compare" };
  }
  const serverSignal =
    signals.returnedToOwnerOrigin || signals.serverCookieChanged;
  const until = Math.max(
    closedAt +
      (serverSignal
        ? AUTH_SERVER_SIGNAL_SETTLE_MS
        : AUTH_SCRIPT_SIGNAL_SETTLE_MS),
    lastCookieChangeAt + AUTH_COOKIE_COMMIT_DELAY_MS,
  );
  if (now < until) return { action: "wait", until };
  return { action: "refresh" };
}
