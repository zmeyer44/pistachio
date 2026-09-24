import { describe, expect, it } from "vitest";
import {
  AUTH_CALLBACK_COOKIE_WAIT_MS,
  AUTH_COOKIE_COMMIT_DELAY_MS,
  AUTH_SCRIPT_SIGNAL_SETTLE_MS,
  AUTH_SERVER_SIGNAL_SETTLE_MS,
  AUTH_SESSION_SETTLE_MS,
  authenticationRefreshPlan,
  cookieDomainMatchesHostname,
  isAuthenticationNavigation,
  shouldPreserveAuthenticationPopup,
} from "../src/auth-popup.js";

describe("authentication popup routing", () => {
  it("recognizes identity-provider and relying-party sign-in routes", () => {
    expect(
      isAuthenticationNavigation(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id=x",
      ),
    ).toBe(true);
    expect(
      isAuthenticationNavigation(
        "https://www.youtube.com/signin?action_handle_signin=true",
      ),
    ).toBe(true);
    expect(
      isAuthenticationNavigation(
        "https://x.com/i/oauth2/authorize?client_id=x",
      ),
    ).toBe(true);
    expect(isAuthenticationNavigation("https://github.com/openai/codex")).toBe(
      false,
    );
    expect(
      isAuthenticationNavigation(
        "https://example.com/articles/authentication-design",
      ),
    ).toBe(false);
  });

  it("recognizes relying-party sign-out routes as identity transitions", () => {
    expect(isAuthenticationNavigation("https://x.com/logout")).toBe(true);
    expect(isAuthenticationNavigation("https://x.com/i/flow/sign_out")).toBe(
      true,
    );
    expect(
      isAuthenticationNavigation(
        "https://example.com/account/log-out?confirm=true",
      ),
    ).toBe(true);
  });

  it("preserves about:blank and indirect OAuth windows when popup intent is explicit", () => {
    expect(
      shouldPreserveAuthenticationPopup({
        url: "about:blank",
        frameName: "google-oauth",
        features: "popup=yes,width=520,height=680",
      }),
    ).toBe(true);
    expect(
      shouldPreserveAuthenticationPopup({
        url: "about:blank",
        frameName: "oauthWindow",
        features: "",
      }),
    ).toBe(true);
    expect(
      shouldPreserveAuthenticationPopup({
        url: "about:blank",
        frameName: "signOutWindow",
        features: "",
      }),
    ).toBe(true);
    expect(
      shouldPreserveAuthenticationPopup({
        url: "https://example.com/docs",
        frameName: "_blank",
        features: "",
      }),
    ).toBe(false);
  });

  it("matches only cookies that can affect the relying-party hostname", () => {
    expect(cookieDomainMatchesHostname(".x.com", "x.com")).toBe(true);
    expect(cookieDomainMatchesHostname(".x.com", "mobile.x.com")).toBe(true);
    expect(cookieDomainMatchesHostname("auth.x.com", "auth.x.com")).toBe(true);
    expect(cookieDomainMatchesHostname("x.com", "notx.com")).toBe(false);
    expect(cookieDomainMatchesHostname(".google.com", "x.com")).toBe(false);
    expect(cookieDomainMatchesHostname(undefined, "x.com")).toBe(false);
  });
});

describe("owner refresh after an authentication popup", () => {
  const closedAt = 10_000;
  const base = {
    closedAt,
    returnedToOwnerOrigin: false,
    lastCookieChangeAt: null,
    serverCookieChanged: false,
    ownerNavigated: false,
  };

  it("never reloads a page that navigated itself after the popup closed", () => {
    // Dribbble: the Google Identity Services credential is exchanged over
    // fetch in the opener, which then sets location.href itself.
    expect(
      authenticationRefreshPlan({
        ...base,
        now: closedAt + 600,
        lastCookieChangeAt: closedAt + 400,
        serverCookieChanged: true,
        ownerNavigated: true,
      }),
    ).toEqual({ action: "skip" });
    expect(
      authenticationRefreshPlan({
        ...base,
        now: closedAt + 2_000,
        returnedToOwnerOrigin: true,
        ownerNavigated: true,
      }),
    ).toEqual({ action: "skip" });
  });

  it("refreshes soon after a server-set cookie when the page stays put", () => {
    // X: the opener exchanges the result over fetch and waits for the browser.
    expect(
      authenticationRefreshPlan({
        ...base,
        now: closedAt + 260,
        lastCookieChangeAt: closedAt + 250,
        serverCookieChanged: true,
      }),
    ).toEqual({ action: "wait", until: closedAt + AUTH_SERVER_SIGNAL_SETTLE_MS });
    expect(
      authenticationRefreshPlan({
        ...base,
        now: closedAt + AUTH_SERVER_SIGNAL_SETTLE_MS,
        lastCookieChangeAt: closedAt + 250,
        serverCookieChanged: true,
      }),
    ).toEqual({ action: "refresh" });
    // A late Set-Cookie burst still gets its commit window.
    expect(
      authenticationRefreshPlan({
        ...base,
        now: closedAt + 900,
        lastCookieChangeAt: closedAt + 800,
        serverCookieChanged: true,
      }),
    ).toEqual({ action: "wait", until: closedAt + 800 + AUTH_COOKIE_COMMIT_DELAY_MS });
  });

  it("gives a page whose only cookie change is script-visible time to finish on its own", () => {
    // Analytics rewrite their cookies on every click; that alone must not
    // fire a reload into the middle of the page's credential exchange.
    expect(
      authenticationRefreshPlan({
        ...base,
        now: closedAt + 300,
        lastCookieChangeAt: closedAt - 200,
      }),
    ).toEqual({ action: "wait", until: closedAt + AUTH_SCRIPT_SIGNAL_SETTLE_MS });
    expect(
      authenticationRefreshPlan({
        ...base,
        now: closedAt + AUTH_SCRIPT_SIGNAL_SETTLE_MS,
        lastCookieChangeAt: closedAt - 200,
      }),
    ).toEqual({ action: "refresh" });
  });

  it("refreshes after a callback page on the owner's origin, cookies or not", () => {
    // YouTube-style noopener handoff: the callback lands on the relying party
    // and closes; the original tab has no message to react to.
    expect(
      authenticationRefreshPlan({
        ...base,
        now: closedAt + 100,
        returnedToOwnerOrigin: true,
      }),
    ).toEqual({ action: "wait", until: closedAt + AUTH_CALLBACK_COOKIE_WAIT_MS });
    expect(
      authenticationRefreshPlan({
        ...base,
        now: closedAt + AUTH_CALLBACK_COOKIE_WAIT_MS,
        returnedToOwnerOrigin: true,
      }),
    ).toEqual({ action: "refresh" });
    expect(
      authenticationRefreshPlan({
        ...base,
        now: closedAt + AUTH_SERVER_SIGNAL_SETTLE_MS,
        returnedToOwnerOrigin: true,
        lastCookieChangeAt: closedAt + 50,
      }),
    ).toEqual({ action: "refresh" });
  });

  it("falls back to comparing cookies when nothing was observed", () => {
    expect(
      authenticationRefreshPlan({ ...base, now: closedAt + 4_000 }),
    ).toEqual({ action: "wait", until: closedAt + AUTH_SESSION_SETTLE_MS });
    expect(
      authenticationRefreshPlan({ ...base, now: closedAt + AUTH_SESSION_SETTLE_MS }),
    ).toEqual({ action: "compare" });
  });
});
