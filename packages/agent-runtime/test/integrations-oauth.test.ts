/**
 * The OAuth helpers every integration shares: the consent URL with PKCE,
 * the code exchange and refresh against a fake token endpoint, revocation,
 * and the cached access token that refreshes single-flight.
 */

import { describe, expect, it, vi } from "vitest";
import { INTEGRATION_CATALOG } from "@pistachio/protocol";
import {
  ACCESS_TOKEN_SKEW_MS,
  OAuthError,
  authorizationUrl,
  cachedAccessToken,
  createPkce,
  createState,
  exchangeAuthorizationCode,
  readAuthorizationCallback,
  refreshAccessToken,
  revokeToken,
} from "../src/integrations/index.js";

const gmail = INTEGRATION_CATALOG.gmail;
const client = { id: "gmail" as const, clientId: "client-1.apps.googleusercontent.com", clientSecret: "not-a-secret" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("authorization request", () => {
  it("builds the consent URL with PKCE, the provider's extra parameters, and the level's scopes", () => {
    const pkce = createPkce();
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{43,}$/u);
    expect(pkce.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(createState()).not.toBe(createState());
    const url = new URL(
      authorizationUrl(gmail, {
        client,
        redirectUri: "http://127.0.0.1:4242/callback",
        scopes: gmail.accessLevels[0]!.scopes,
        state: "state-1",
        codeChallenge: pkce.challenge,
        loginHint: "alex@example.com",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(client.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:4242/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
    expect(url.searchParams.get("code_challenge")).toBe(pkce.challenge);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("login_hint")).toBe("alex@example.com");
    expect(url.searchParams.get("state")).toBe("state-1");
  });

  it("reads the callback's code, state, and error", () => {
    expect(readAuthorizationCallback(new URL("http://127.0.0.1:1/callback?code=abc&state=s"))).toEqual({ code: "abc", state: "s", error: null });
    expect(readAuthorizationCallback(new URL("http://127.0.0.1:1/callback?error=access_denied&state=s"))).toEqual({ code: null, state: "s", error: "access_denied" });
  });
});

describe("token endpoint", () => {
  it("exchanges the code with the verifier and reports the grant's scopes and expiry", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const params = new URLSearchParams(String(init?.body));
      expect(params.get("grant_type")).toBe("authorization_code");
      expect(params.get("code")).toBe("code-1");
      expect(params.get("code_verifier")).toBe("verifier-1");
      expect(params.get("redirect_uri")).toBe("http://127.0.0.1:4242/callback");
      expect(params.get("client_id")).toBe(client.clientId);
      expect(params.get("client_secret")).toBe("not-a-secret");
      return jsonResponse({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3599, scope: "https://www.googleapis.com/auth/gmail.modify", token_type: "Bearer" });
    });
    const now = () => new Date("2026-09-06T12:00:00Z");
    const grant = await exchangeAuthorizationCode(
      gmail,
      { client, code: "code-1", codeVerifier: "verifier-1", redirectUri: "http://127.0.0.1:4242/callback", requestedScopes: ["x"] },
      fetchImpl,
      now,
    );
    expect(grant).toEqual({
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: "2026-09-06T12:59:59.000Z",
      scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://oauth2.googleapis.com/token");
  });

  it("falls back to the requested scopes when the provider omits them, and omits the secret when there is none", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new URLSearchParams(String(init?.body)).has("client_secret")).toBe(false);
      return jsonResponse({ access_token: "at-2", expires_in: 100 });
    });
    const grant = await exchangeAuthorizationCode(
      gmail,
      { client: { ...client, clientSecret: null }, code: "c", codeVerifier: "v", redirectUri: "r", requestedScopes: ["a", "b"] },
      fetchImpl,
    );
    expect(grant.scopes).toEqual(["a", "b"]);
    expect(grant.refreshToken).toBeNull();
  });

  it("refreshes, and names a dead grant so the caller asks the person to reconnect", async () => {
    const ok = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ access_token: "at-3", expires_in: 3600, scope: "s" }));
    const refreshed = await refreshAccessToken(gmail, { client, refreshToken: "rt-1" }, ok);
    expect(refreshed.accessToken).toBe("at-3");
    expect(new URLSearchParams(String(ok.mock.calls[0]?.[1]?.body)).get("grant_type")).toBe("refresh_token");

    const dead = vi.fn(async () => jsonResponse({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400));
    const failure = await refreshAccessToken(gmail, { client, refreshToken: "rt-1" }, dead).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OAuthError);
    expect((failure as OAuthError).needsReconnect).toBe(true);
    expect((failure as OAuthError).message).toBe("Token has been expired or revoked.");

    const outage = vi.fn(async () => new Response("bad gateway", { status: 502 }));
    const transient = await refreshAccessToken(gmail, { client, refreshToken: "rt-1" }, outage).catch((error: unknown) => error);
    expect((transient as OAuthError).needsReconnect).toBe(false);
    expect((transient as OAuthError).status).toBe(502);

    // The operator's client, not the person's grant: a misconfigured secret
    // must not make every connection ask for a reconnect.
    const misconfigured = vi.fn(async () => jsonResponse({ error: "invalid_client", error_description: "Unauthorized" }, 401));
    const clientError = await refreshAccessToken(gmail, { client, refreshToken: "rt-1" }, misconfigured).catch((error: unknown) => error);
    expect((clientError as OAuthError).needsReconnect).toBe(false);
    expect((clientError as OAuthError).code).toBe("invalid_client");
    const bare = vi.fn(async () => new Response("", { status: 401 }));
    const unexplained = await refreshAccessToken(gmail, { client, refreshToken: "rt-1" }, bare).catch((error: unknown) => error);
    expect((unexplained as OAuthError).needsReconnect).toBe(false);
  });

  it("revokes best effort", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://oauth2.googleapis.com/revoke");
      expect(new URLSearchParams(String(init?.body)).get("token")).toBe("rt-1");
      return new Response("", { status: 200 });
    });
    expect(await revokeToken(gmail, "rt-1", fetchImpl)).toBe(true);
    expect(await revokeToken(gmail, "rt-1", vi.fn(async () => { throw new Error("offline"); }))).toBe(false);
    expect(await revokeToken({ ...gmail, oauth: { ...gmail.oauth, revocationUrl: null } }, "rt-1", fetchImpl)).toBe(false);
  });
});

describe("cached access token", () => {
  it("mints once, shares one in-flight refresh, and refreshes again near expiry or on demand", async () => {
    let clock = Date.parse("2026-09-06T12:00:00Z");
    const now = () => new Date(clock);
    let minted = 0;
    const refresh = vi.fn(async () => {
      minted += 1;
      return { accessToken: `at-${String(minted)}`, expiresAt: new Date(clock + 3_600_000).toISOString() };
    });
    const token = cachedAccessToken(refresh, now);
    const [a, b] = await Promise.all([token(), token()]);
    expect(a).toBe("at-1");
    expect(b).toBe("at-1");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await token()).toBe("at-1");
    clock += 3_600_000 - ACCESS_TOKEN_SKEW_MS + 1;
    expect(await token()).toBe("at-2");
    expect(await token({ fresh: true })).toBe("at-3");
  });

  it("does not poison the cache when a refresh fails", async () => {
    let attempts = 0;
    const refresh = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new OAuthError(502, null, "down");
      return { accessToken: "at-ok", expiresAt: new Date(Date.now() + 60_000 * 10).toISOString() };
    });
    const token = cachedAccessToken(refresh);
    await expect(token()).rejects.toBeInstanceOf(OAuthError);
    expect(await token()).toBe("at-ok");
  });
});
