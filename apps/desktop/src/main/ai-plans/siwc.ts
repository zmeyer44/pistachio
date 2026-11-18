/**
 * Sign in with ChatGPT, with ChatGPT plan usage (docs/ai-plans.md §2) — the
 * OAuth half, as OpenAI documents it for open-source and locally run apps
 * (developers.openai.com/siwc, "ChatGPT plan usage"): a public client with
 * PKCE, registered for the person as they first sign in.
 *
 * - **First sign-in** asks with `client_id=dynamic_agent_client`, the app's
 *   name (`agent_name_hint`) and this install's host id (`ext_agent_host_id`);
 *   the callback hands back the client id OpenAI issued (`oaiapp_…`), which is
 *   the one kept and used from then on. A later sign-in asks with that id, the
 *   retained ID token as `id_token_hint` and the email as `login_hint`.
 * - **The callback** is a loopback address on `127.0.0.1` — only its port may
 *   vary, the path is `/auth/callback`, and the same address goes in the code
 *   exchange.
 * - **Tokens**: an access token good for an hour, a refresh token that
 *   rotates with every use, an ID token whose signature, issuer, audience
 *   (the issued client id), expiry and nonce are checked here before anything
 *   is kept. Plan usage is granted only when the token response's scopes hold
 *   `chatgpt.tokens.use.direct`: a valid sign-in alone is not it.
 *
 * No Electron and no state here: every function takes the endpoints and the
 * fetch it uses, so the whole flow is unit-tested against a stand-in for
 * OpenAI (test/ai-plans-siwc.test.ts), and the e2e points it at one.
 */

import { createHash, createPublicKey, randomBytes, randomUUID, verify as verifySignature, type JsonWebKey } from "node:crypto";

/** Where OpenAI's side of the flow is. Fixed in production; a stand-in's under test. */
export interface SiwcEndpoints {
  /** The `iss` an ID token must carry. */
  issuer: string;
  authorize: string;
  token: string;
  /** The published signing keys. */
  jwks: string;
  /** Null when the discovery document names none: sign-out is then local, and said to be. */
  revocation: string | null;
  /** The Responses API's base, and the `resource` every grant is for. */
  api: string;
}

export const OPENAI_ISSUER = "https://auth.openai.com";
export const OPENAI_DISCOVERY = `${OPENAI_ISSUER}/.well-known/openid-configuration`;
export const OPENAI_API = "https://api.openai.com/v1";
/** Where the person reviews what each app has used of their plan, and sets its limits. */
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";

/** OpenAI's endpoints as its docs give them; `jwks` and `revocation` are read from discovery (`discover`). */
export const OPENAI_ENDPOINTS: Omit<SiwcEndpoints, "jwks" | "revocation"> = {
  issuer: OPENAI_ISSUER,
  authorize: `${OPENAI_ISSUER}/api/accounts/authorize`,
  token: `${OPENAI_ISSUER}/api/accounts/oauth/token`,
  api: OPENAI_API,
};

/** The first-time registration entrypoint: never the id that is kept or used at the token endpoint. */
export const REGISTRATION_CLIENT_ID = "dynamic_agent_client";
/** The app's name, the same on every install. */
export const AGENT_NAME = "Pistachio";
export const IDENTITY_SCOPES = ["openid", "profile", "email"] as const;
export const PLAN_SCOPES = ["offline_access", "resource.invoke", "chatgpt.tokens.use.direct"] as const;
/** The scope that IS plan usage: without it in the grant, no request is sent. */
export const PLAN_USE_SCOPE = "chatgpt.tokens.use.direct";
export const CALLBACK_PATH = "/auth/callback";

/** What went wrong, for the person: the kind picks what the app offers next. */
export type SiwcFailure =
  /** They said no on OpenAI's page. */
  | "declined"
  /** The callback was not this attempt's (its `state`), or was malformed. */
  | "mismatch"
  /** OpenAI answered with something this flow cannot use: a sentence says what. */
  | "rejected"
  /** The network, or OpenAI being down: nothing to conclude, try again. */
  | "unreachable"
  /** The saved sign-in can no longer be renewed: sign in again. */
  | "expired";

export class SiwcError extends Error {
  readonly kind: SiwcFailure;
  /** OpenAI's machine-readable code, when it sent one. */
  readonly code: string | null;
  constructor(kind: SiwcFailure, message: string, code: string | null = null) {
    super(message);
    this.name = "SiwcError";
    this.kind = kind;
    this.code = code;
  }
}

/* ------------------------------ an attempt ------------------------------ */

/** A stable, opaque id for this install (`urn:uuid:…`): made once, before the first sign-in, and reused for good. */
export function newHostId(): string {
  return `urn:uuid:${randomUUID()}`;
}

const base64url = (bytes: Buffer): string => bytes.toString("base64url");

/** One sign-in attempt's secrets: fresh for each, kept until its callback is in. */
export interface SiwcAttempt {
  state: string;
  nonce: string;
  verifier: string;
  challenge: string;
  /** The exact loopback address: in the request and again in the exchange. */
  redirectUri: string;
}

export function newAttempt(port: number): SiwcAttempt {
  const verifier = base64url(randomBytes(48));
  return {
    state: base64url(randomBytes(24)),
    nonce: base64url(randomBytes(24)),
    verifier,
    challenge: base64url(createHash("sha256").update(verifier).digest()),
    redirectUri: `http://127.0.0.1:${String(port)}${CALLBACK_PATH}`,
  };
}

/** The registration a returning sign-in is for: its issued client id, and the hints that skip the account chooser. */
export interface SiwcReturning {
  clientId: string;
  idToken: string | null;
  email: string | null;
}

/** The page the browser is sent to: a first registration (`returning` null), or a sign-in to one already made. */
export function authorizeUrl(endpoints: Pick<SiwcEndpoints, "authorize" | "api">, attempt: SiwcAttempt, hostId: string, returning: SiwcReturning | null, options: { consent?: boolean } = {}): string {
  const url = new URL(endpoints.authorize);
  const params: Record<string, string> = {
    client_id: returning?.clientId ?? REGISTRATION_CLIENT_ID,
    // (The app's name goes only with a first registration; the person may edit it on OpenAI's page.)
    ...(returning === null ? { agent_name_hint: AGENT_NAME } : {}),
    ext_agent_host_id: hostId,
    ...(returning?.idToken ? { id_token_hint: returning.idToken } : {}),
    ...(returning?.email ? { login_hint: returning.email } : {}),
    response_type: "code",
    redirect_uri: attempt.redirectUri,
    scope: [...IDENTITY_SCOPES, ...PLAN_SCOPES].join(" "),
    resource: endpoints.api,
    state: attempt.state,
    nonce: attempt.nonce,
    code_challenge_method: "S256",
    code_challenge: attempt.challenge,
    // Asked only when the person chose plan usage after a sign-in that came back without it: never on an ordinary one.
    ...(options.consent === true ? { prompt: "consent" } : {}),
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/**
 * The callback as the browser came back with it: the code to exchange, and
 * the client id it is exchanged under — the one OpenAI just issued, for a
 * first registration; the saved one, for a returning sign-in (a callback that
 * names another is refused rather than let replace it).
 */
export function readCallback(search: URLSearchParams, attempt: SiwcAttempt, returning: SiwcReturning | null): { code: string; clientId: string } {
  if (search.get("state") !== attempt.state) throw new SiwcError("mismatch", "That sign-in page was not the one Pistachio opened. Start again from Settings.");
  const error = search.get("error");
  if (error === "access_denied") throw new SiwcError("declined", "ChatGPT sign-in was cancelled.", error);
  // (The query is whatever reached the loopback port: only a plain code is repeated.)
  if (error !== null) throw new SiwcError("rejected", /^[a-z_]{1,48}$/.test(error) ? `ChatGPT did not complete the sign-in (${error}).` : "ChatGPT did not complete the sign-in.", error);
  const code = search.get("code");
  if (code === null || code === "") throw new SiwcError("mismatch", "ChatGPT's answer had no sign-in code. Start again from Settings.");
  const issued = search.get("client_id");
  if (returning === null) {
    // A new registration is not one until OpenAI has issued its id.
    if (issued === null || issued === "" || issued === REGISTRATION_CLIENT_ID) throw new SiwcError("rejected", "ChatGPT did not finish registering Pistachio. Start again from Settings.");
    return { code, clientId: issued };
  }
  if (issued !== null && issued !== returning.clientId) throw new SiwcError("mismatch", "ChatGPT answered for another registration than the one being signed in to. Start again from Settings.");
  return { code, clientId: returning.clientId };
}

/* ------------------------------ tokens ------------------------------ */

/** A token response, read: what is kept (docs/ai-plans.md §2, the credential record). */
export interface SiwcTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  /** When the access token lapses, ms since 1970. */
  expiresAt: number;
  scopes: string[];
}

function readTokens(body: unknown, now: number, previous: { idToken: string | null; scopes: string[] } | null): SiwcTokens {
  const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const text = (key: string): string | null => (typeof fields[key] === "string" && fields[key] !== "" ? (fields[key] as string) : null);
  const accessToken = text("access_token");
  const refreshToken = text("refresh_token");
  if (accessToken === null || refreshToken === null) throw new SiwcError("rejected", "ChatGPT's answer held no usable sign-in. Start again from Settings.");
  const expiresIn = typeof fields["expires_in"] === "number" && Number.isFinite(fields["expires_in"]) ? fields["expires_in"] : 3600;
  const scope = text("scope");
  return {
    accessToken,
    refreshToken,
    // (A refresh may answer without an ID token, or without the scopes: what was granted stands.)
    idToken: text("id_token") ?? previous?.idToken ?? null,
    expiresAt: now + Math.max(0, expiresIn) * 1000,
    scopes: scope === null ? (previous?.scopes ?? []) : scope.split(/\s+/).filter(Boolean),
  };
}

/** The refresh errors that mean this sign-in is over, by OpenAI's codes: clear the tokens and sign in again with the saved client id. */
const SPENT_REFRESH = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"]);

async function tokenRequest(fetchImpl: typeof fetch, endpoint: string, form: Record<string, string>, now: number, previous: { idToken: string | null; scopes: string[] } | null): Promise<SiwcTokens> {
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
    });
  } catch {
    throw new SiwcError("unreachable", "ChatGPT's sign-in service could not be reached. Check the connection and try again.");
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (response.ok) return readTokens(body, now, previous);
  const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const code = typeof fields["error"] === "string" ? fields["error"] : typeof (fields["error"] as { code?: unknown } | undefined)?.code === "string" ? ((fields["error"] as { code: string }).code) : null;
  if (response.status >= 500) throw new SiwcError("unreachable", "ChatGPT's sign-in service is not answering right now. Try again in a moment.", code);
  if (code !== null && SPENT_REFRESH.has(code)) throw new SiwcError("expired", "Your ChatGPT connection expired or was disconnected. Sign in again.", code);
  throw new SiwcError("rejected", `ChatGPT refused the sign-in${code !== null && /^[a-z_]{1,48}$/.test(code) ? ` (${code})` : ""}.`, code);
}

/** The authorization code for tokens: under the issued client id, with the attempt's verifier and its exact callback address. */
export function exchangeCode(fetchImpl: typeof fetch, endpoints: Pick<SiwcEndpoints, "token" | "api">, input: { clientId: string; code: string; attempt: SiwcAttempt }, now: number): Promise<SiwcTokens> {
  return tokenRequest(
    fetchImpl,
    endpoints.token,
    { grant_type: "authorization_code", client_id: input.clientId, code: input.code, code_verifier: input.attempt.verifier, redirect_uri: input.attempt.redirectUri, resource: endpoints.api },
    now,
    null,
  );
}

/** A new access token, and the refresh token that replaces the one just spent. `scope` is left out: the grant stands. */
export function refreshTokens(fetchImpl: typeof fetch, endpoints: Pick<SiwcEndpoints, "token" | "api">, input: { clientId: string; refreshToken: string; idToken: string | null; scopes: string[] }, now: number): Promise<SiwcTokens> {
  return tokenRequest(
    fetchImpl,
    endpoints.token,
    { grant_type: "refresh_token", client_id: input.clientId, refresh_token: input.refreshToken, resource: endpoints.api },
    now,
    { idToken: input.idToken, scopes: input.scopes },
  );
}

/** End the renewable session at OpenAI: true once it answered 200 (it does for a token already dead, too). */
export async function revokeSession(fetchImpl: typeof fetch, endpoints: Pick<SiwcEndpoints, "revocation">, input: { clientId: string; refreshToken: string }): Promise<boolean> {
  if (endpoints.revocation === null) return false;
  try {
    const response = await fetchImpl(endpoints.revocation, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: input.refreshToken, token_type_hint: "refresh_token", client_id: input.clientId }).toString(),
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

/** Whether a grant lets requests use the person's plan. */
export function grantsPlanUse(scopes: readonly string[]): boolean {
  return scopes.includes(PLAN_USE_SCOPE);
}

/* ------------------------------ the ID token ------------------------------ */

/** Who signed in, once their ID token has been checked. */
export interface SiwcIdentity {
  /** The account's identity, within this registration. */
  subject: string;
  email: string | null;
}

function decodePart(part: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
  return parsed as Record<string, unknown>;
}

/**
 * Check an ID token and read who it names: its signature against OpenAI's
 * published keys, its issuer, its audience (the issued client id), that it
 * has not lapsed, and that it answers this attempt (`nonce`). Anything amiss
 * is `rejected`: nothing of an unverified token is kept or shown.
 */
export function verifyIdToken(idToken: string, expected: { issuer: string; clientId: string; nonce: string | null; keys: readonly JsonWebKey[]; now: number }): SiwcIdentity {
  const bad = (why: string): never => {
    throw new SiwcError("rejected", `ChatGPT's sign-in could not be verified (${why}). Start again from Settings.`);
  };
  const parts = idToken.split(".");
  if (parts.length !== 3) return bad("it is not a signed token");
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = decodePart(parts[0]!);
    claims = decodePart(parts[1]!);
  } catch {
    return bad("it cannot be read");
  }
  const alg = header["alg"];
  if (alg !== "RS256" && alg !== "ES256") return bad("its signature is of a kind Pistachio does not accept");
  const kid = typeof header["kid"] === "string" ? header["kid"] : null;
  const candidates = expected.keys.filter((key) => (kid === null || (key as { kid?: unknown }).kid === kid) && (alg === "RS256" ? key.kty === "RSA" : key.kty === "EC"));
  const signed = Buffer.from(`${parts[0]!}.${parts[1]!}`);
  const signature = Buffer.from(parts[2]!, "base64url");
  const valid = candidates.some((jwk) => {
    try {
      const key = createPublicKey({ key: jwk, format: "jwk" });
      return alg === "RS256" ? verifySignature("RSA-SHA256", signed, key, signature) : verifySignature("SHA256", signed, { key, dsaEncoding: "ieee-p1363" }, signature);
    } catch {
      return false;
    }
  });
  if (!valid) return bad("its signature does not match OpenAI's keys");
  if (claims["iss"] !== expected.issuer) return bad("it was not issued by OpenAI");
  const audience = claims["aud"];
  if (!(audience === expected.clientId || (Array.isArray(audience) && audience.includes(expected.clientId)))) return bad("it was issued for another app");
  const expires = claims["exp"];
  // (A minute's grace for a clock that runs a little ahead.)
  if (typeof expires !== "number" || expires * 1000 + 60_000 < expected.now) return bad("it has lapsed");
  if (expected.nonce !== null && claims["nonce"] !== expected.nonce) return bad("it answers another sign-in");
  const subject = claims["sub"];
  if (typeof subject !== "string" || subject === "") return bad("it names nobody");
  return { subject, email: typeof claims["email"] === "string" && claims["email"] !== "" ? claims["email"] : null };
}

/* ------------------------------ discovery ------------------------------ */

/**
 * OpenAI's signing keys and revocation endpoint, from its discovery document.
 * Only addresses on the issuer's own origin are taken from it: the document
 * is fetched over the network, and a key set from elsewhere would let whoever
 * served it sign anything.
 */
export async function discover(fetchImpl: typeof fetch, base: Omit<SiwcEndpoints, "jwks" | "revocation">, discoveryUrl: string = OPENAI_DISCOVERY): Promise<SiwcEndpoints> {
  let document: Record<string, unknown>;
  try {
    const response = await fetchImpl(discoveryUrl, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(String(response.status));
    document = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new SiwcError("unreachable", "ChatGPT's sign-in service could not be reached. Check the connection and try again.");
  }
  const origin = new URL(base.issuer).origin;
  const own = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    try {
      return new URL(value).origin === origin ? value : null;
    } catch {
      return null;
    }
  };
  const jwks = own(document["jwks_uri"]);
  if (jwks === null) throw new SiwcError("rejected", "ChatGPT's sign-in service did not say where its signing keys are.");
  return { ...base, jwks, revocation: own(document["revocation_endpoint"]) };
}

/** The key set at `jwks`. */
export async function fetchKeys(fetchImpl: typeof fetch, jwks: string): Promise<JsonWebKey[]> {
  try {
    const response = await fetchImpl(jwks, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(String(response.status));
    const body = (await response.json()) as { keys?: unknown };
    return Array.isArray(body.keys) ? (body.keys.filter((key) => typeof key === "object" && key !== null) as JsonWebKey[]) : [];
  } catch {
    throw new SiwcError("unreachable", "ChatGPT's signing keys could not be read. Check the connection and try again.");
  }
}
