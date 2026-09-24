/**
 * The OAuth 2.0 authorization-code flow with PKCE, as every dedicated
 * integration uses it: the device builds the consent URL and later
 * exchanges the code, mints access tokens from the refresh token as runs
 * need them, and revokes the grant when the person disconnects. Pure over
 * `fetch` and the provider's catalog entry, so the desktop and the cloud
 * runner share one implementation and tests run against a fake endpoint.
 */

import { createHash, randomBytes } from "node:crypto";
import type { IntegrationCatalogEntry, IntegrationProviderConfig } from "@pistachio/protocol";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** A failed token endpoint call, with the provider's own error code when it gave one. */
export class OAuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    description: string | null,
  ) {
    super(description ?? (code === null ? `the token endpoint answered ${String(status)}` : `${code} (${String(status)})`));
    this.name = "OAuthError";
  }

  /**
   * Whether the grant itself is dead — revoked by the person at the
   * provider, expired, or the app's consent withdrawn — so no retry can
   * help and the person has to connect again. Only the grant-specific
   * OAuth error says so: a 401 with `invalid_client` is the operator's
   * client credentials, and a bare 401 or 5xx is the provider's day, and
   * neither is a reason to make the person consent again.
   */
  get needsReconnect(): boolean {
    return this.code === "invalid_grant";
  }
}

export function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** A PKCE verifier and its S256 challenge (RFC 7636). */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(48));
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** An unguessable `state` for the authorization request. */
export function createState(): string {
  return base64Url(randomBytes(24));
}

export interface AuthorizationRequest {
  client: Pick<IntegrationProviderConfig, "clientId">;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  codeChallenge: string;
  /** A hint to the provider's account chooser — the account already connected, on a reconnect. */
  loginHint?: string;
}

/** The consent page to open for the person. */
export function authorizationUrl(entry: IntegrationCatalogEntry, request: AuthorizationRequest): string {
  const url = new URL(entry.oauth.authorizationUrl);
  url.searchParams.set("client_id", request.client.clientId);
  url.searchParams.set("redirect_uri", request.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", request.scopes.join(" "));
  url.searchParams.set("state", request.state);
  url.searchParams.set("code_challenge", request.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  for (const [key, value] of Object.entries(entry.oauth.authorizationParams)) url.searchParams.set(key, value);
  if (request.loginHint !== undefined) url.searchParams.set("login_hint", request.loginHint);
  return url.toString();
}

/** What the provider's redirect carried back. */
export interface AuthorizationCallback {
  code: string | null;
  state: string | null;
  error: string | null;
}

export function readAuthorizationCallback(url: URL): AuthorizationCallback {
  return {
    code: url.searchParams.get("code"),
    state: url.searchParams.get("state"),
    error: url.searchParams.get("error"),
  };
}

export interface TokenGrant {
  accessToken: string;
  /** ISO instant the access token stops working. */
  expiresAt: string;
  /** Absent from a refresh unless the provider rotated it. */
  refreshToken: string | null;
  /** What the provider says it granted; the request's scopes when it said nothing. */
  scopes: string[];
}

interface TokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  scope?: unknown;
  error?: unknown;
  error_description?: unknown;
}

const DEFAULT_TOKEN_LIFETIME_SECONDS = 3_600;

async function tokenRequest(
  entry: IntegrationCatalogEntry,
  params: Record<string, string>,
  fetchImpl: FetchLike,
  now: () => Date,
): Promise<TokenGrant & { raw: TokenResponse }> {
  const response = await fetchImpl(entry.oauth.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(params).toString(),
  });
  let payload: TokenResponse = {};
  try {
    payload = (await response.json()) as TokenResponse;
  } catch {
    payload = {};
  }
  if (!response.ok || typeof payload.access_token !== "string") {
    throw new OAuthError(
      response.status,
      typeof payload.error === "string" ? payload.error : null,
      typeof payload.error_description === "string" ? payload.error_description : null,
    );
  }
  const lifetime = typeof payload.expires_in === "number" && payload.expires_in > 0 ? payload.expires_in : DEFAULT_TOKEN_LIFETIME_SECONDS;
  return {
    accessToken: payload.access_token,
    expiresAt: new Date(now().getTime() + lifetime * 1_000).toISOString(),
    refreshToken: typeof payload.refresh_token === "string" && payload.refresh_token !== "" ? payload.refresh_token : null,
    scopes: typeof payload.scope === "string" ? payload.scope.split(/\s+/u).filter((scope) => scope !== "") : [],
    raw: payload,
  };
}

function clientParams(client: IntegrationProviderConfig): Record<string, string> {
  return { client_id: client.clientId, ...(client.clientSecret === null ? {} : { client_secret: client.clientSecret }) };
}

export interface ExchangeRequest {
  client: IntegrationProviderConfig;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  /** What was asked for, reported back when the provider omits `scope`. */
  requestedScopes: readonly string[];
}

/** Trade the authorization code for the grant. A grant with no refresh token cannot outlive its access token. */
export async function exchangeAuthorizationCode(
  entry: IntegrationCatalogEntry,
  request: ExchangeRequest,
  fetchImpl: FetchLike = fetch,
  now: () => Date = () => new Date(),
): Promise<TokenGrant> {
  const grant = await tokenRequest(
    entry,
    {
      grant_type: "authorization_code",
      code: request.code,
      code_verifier: request.codeVerifier,
      redirect_uri: request.redirectUri,
      ...clientParams(request.client),
    },
    fetchImpl,
    now,
  );
  return {
    accessToken: grant.accessToken,
    expiresAt: grant.expiresAt,
    refreshToken: grant.refreshToken,
    scopes: grant.scopes.length === 0 ? [...request.requestedScopes] : grant.scopes,
  };
}

/** Mint a fresh access token from the refresh token. */
export async function refreshAccessToken(
  entry: IntegrationCatalogEntry,
  request: { client: IntegrationProviderConfig; refreshToken: string },
  fetchImpl: FetchLike = fetch,
  now: () => Date = () => new Date(),
): Promise<TokenGrant> {
  const grant = await tokenRequest(
    entry,
    { grant_type: "refresh_token", refresh_token: request.refreshToken, ...clientParams(request.client) },
    fetchImpl,
    now,
  );
  return { accessToken: grant.accessToken, expiresAt: grant.expiresAt, refreshToken: grant.refreshToken, scopes: grant.scopes };
}

/**
 * Tell the provider the grant is over. Best effort: a provider with no
 * revocation endpoint, or one that answers with an error because the grant
 * was already gone, does not stop a disconnect.
 */
export async function revokeToken(entry: IntegrationCatalogEntry, token: string, fetchImpl: FetchLike = fetch): Promise<boolean> {
  const url = entry.oauth.revocationUrl;
  if (url === null) return false;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** How long before an access token's expiry a cached one is considered stale. */
export const ACCESS_TOKEN_SKEW_MS = 60_000;

/**
 * An access token minted on demand and reused until shortly before it
 * expires. `refresh` is single-flight: two tool calls in the same step do
 * not each spend a refresh. `fresh` throws the cached token away first —
 * what a client does after the API answered 401 to it.
 */
export function cachedAccessToken(
  refresh: () => Promise<Pick<TokenGrant, "accessToken" | "expiresAt">>,
  now: () => Date = () => new Date(),
): (options?: { fresh?: boolean }) => Promise<string> {
  let cached: { accessToken: string; expiresAt: number } | null = null;
  let inflight: Promise<string> | null = null;
  return async (options = {}) => {
    if (options.fresh === true) cached = null;
    if (cached !== null && cached.expiresAt - ACCESS_TOKEN_SKEW_MS > now().getTime()) return cached.accessToken;
    if (inflight === null) {
      inflight = refresh()
        .then((grant) => {
          cached = { accessToken: grant.accessToken, expiresAt: Date.parse(grant.expiresAt) };
          return grant.accessToken;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  };
}
