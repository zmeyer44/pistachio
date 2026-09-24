/**
 * The control-plane client, in the browser.
 *
 * The web app is a device like any other: it holds its own key pair and calls
 * the same routes the Mac does with its own device token. Nothing here runs on
 * the Next server, so the server never sees a token, a password, or a key.
 */

import type { CredentialCapture, ControlDevice, DevicePlatform, IntegrationConnection, IntegrationProviderConfig, ThreadListItem, VaultEntry, VaultEntryField } from "@pistachio/protocol";

export type { CredentialCapture, ControlDevice, DevicePlatform, IntegrationConnection, IntegrationProviderConfig, VaultEntry, VaultEntryField };

/**
 * Where the control plane lives, for everything in this app that talks to it —
 * the client here and the artifact proxy route. A trailing slash is stripped so
 * a configured value with one still composes `${CONTROL_URL}/v1/...`.
 */
export const CONTROL_URL = (
  process.env["NEXT_PUBLIC_PISTACHIO_CONTROL_URL"] ??
  (process.env.NODE_ENV === "production" ? "https://api.pistachio.run" : "http://localhost:8787")
).replace(/\/+$/u, "");

/**
 * What a refusal from control means to the person reading the screen, by the
 * code control sent. Anything not listed here falls back to a sentence for
 * its status class; the wire form (`control answered 503 cloud_unavailable`)
 * is kept on `detail` for a diagnostics disclosure, never for the headline.
 */
const PLAIN_BY_CODE: Readonly<Record<string, string>> = {
  cloud_unavailable: "The hosted browser is temporarily unavailable. Try again in a moment.",
  no_cloud_browser: "This Space has no cloud browser yet. Turn it on from the Agent page.",
  space_not_cloud_enabled: "This Space has no cloud browser yet. Turn it on from the Agent page.",
  egress_unavailable: "The private network gateway is temporarily unavailable. Try again in a moment.",
  imessage_unavailable: "iMessage delivery is temporarily unavailable. Try again in a moment.",
  upstream_unreachable: "A service Pistachio depends on could not be reached. Try again in a moment.",
  unavailable: "That service is temporarily unavailable. Try again in a moment.",
  not_ready: "That is still being set up. Try again in a moment.",
  internal: "Something went wrong on our side. Try again in a moment.",
  rate_limited: "Too many attempts. Wait a moment and try again.",
  unauthorized: "Your session has ended. Sign in again to continue.",
  forbidden: "Your account is not allowed to do that.",
  not_found: "That is no longer there.",
  invalid_credentials: "That email and password do not match.",
  email_taken: "An account already uses that email.",
  device_id_taken: "This browser is already enrolled. Reload and try again.",
  device_already_enrolled: "This device is already enrolled.",
  device_required: "This has to be done from a device that holds your keys, like your Mac.",
  already_provisioned: "This account's keys were already set up on another device.",
  onboarding_link_invalid: "This secure link has expired or was already used.",
  phone_already_linked: "That number was connected to another account just now.",
  invalid_phone: "That does not look like a phone number.",
  invalid_code: "That code is not right.",
  expired: "That has expired.",
  invalid_body: "Something in that request was not filled in correctly.",
  invalid_query: "Something in that request was not filled in correctly.",
  payload_too_large: "That is too large to send.",
  thread_too_large: "That conversation is too large to send.",
  stale_revision: "Someone else changed this first. Reload and try again.",
  stale_lease: "Another device took over that session. Reload and try again.",
  spaces_changed: "Your Spaces changed on another device. Reload and try again.",
  run_ended: "That run has already ended.",
  not_running: "That run is not running.",
  paused: "That run is paused and waiting for you.",
  revoke_pending: "That device is still being revoked. Try again in a moment.",
  outbound_url_rejected: "That address cannot be used for a channel.",
  signup_rejected: "Sign-ups are not open for that email yet.",
  password_reset_unavailable: "Password reset is not available for this account.",
  otp_delivery_failed: "The code could not be sent. Check the number and try again.",
  onboarding_delivery_failed: "The secure link could not be sent. Try again in a moment.",
  platform_not_allowed: "That kind of device cannot be enrolled here.",
};

function plainByStatus(status: number): string {
  if (status === 401) return "Your session has ended. Sign in again to continue.";
  if (status === 403) return "Your account is not allowed to do that.";
  if (status === 404) return "That is no longer there.";
  if (status === 409) return "That could not be done in its current state. Reload and try again.";
  if (status === 429) return "Too many attempts. Wait a moment and try again.";
  if (status === 503 || status === 502 || status === 504) return "That service is temporarily unavailable. Try again in a moment.";
  if (status >= 500) return "Something went wrong on our side. Try again in a moment.";
  if (status >= 400) return "That request could not be completed as entered.";
  return "Something went wrong.";
}

/**
 * Codes whose attached sentence IS the explanation. Control's run coordinator
 * answers these with the reason in words ("cannot release control: the run is
 * not paused"), and no fixed sentence for the code says as much.
 */
const EXPLAINED_BY_SERVER = new Set(["invalid_state", "stale_lease", "not_found"]);

/** Sentence-case a server reason so it reads like the rest of the page. */
function sentence(text: string): string {
  const trimmed = text.trim();
  const capitalised = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/u.test(capitalised) ? capitalised : `${capitalised}.`;
}

/**
 * The sentence a person should read for a refusal with this status and code.
 * A server-authored reason wins for the codes where it carries the meaning;
 * everywhere else the fixed sentence does, and the reason stays on `detail`.
 */
export function describeControlError(status: number, code: string, serverMessage?: string): string {
  if (serverMessage !== undefined && serverMessage.trim() !== "" && EXPLAINED_BY_SERVER.has(code)) {
    return sentence(serverMessage);
  }
  return PLAIN_BY_CODE[code] ?? plainByStatus(status);
}

export class ControlError extends Error {
  /**
   * The wire form — status, code, and whatever sentence control attached —
   * for a diagnostics disclosure. `message` is always the plain-language
   * description so a screen that shows `error.message` reads well by default.
   */
  readonly detail: string;
  /** The sentence control sent with the refusal, when it sent one. */
  readonly serverMessage: string | null;

  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(describeControlError(status, code, message));
    this.name = "ControlError";
    this.serverMessage = message ?? null;
    this.detail = `control answered ${String(status)} ${code}${message === undefined ? "" : `: ${message}`}`;
  }
}

/** The diagnostics line for an error, if it carries one worth disclosing. */
export function errorDetailOf(error: unknown): string | null {
  return error instanceof ControlError ? error.detail : null;
}

export interface ControlSpace {
  id: string;
  name: string;
  createdAt: string;
  cloudEnabled: boolean;
}

export interface ControlWrapper {
  spaceId: string;
  kind: string;
  credentialId: string;
  salt: string;
  wrapped: string;
  senderDeviceId: string | null;
  signature: string | null;
  createdAt: string;
}

export interface ControlMe {
  userId: string;
  email: string;
  onboardingCompletedAt: string | null;
  hubUrl: string | null;
  cloudBrowserUrl: string | null;
  egress: { host: string; port: number } | null;
  features: string[];
}

export interface ControlChannel {
  id?: string;
  linkId?: string;
  name: string;
  spaceId: string;
  outboundUrl: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface HostedArtifact {
  artifactId: string;
  shareId: string;
  revision: number;
  visibility: "private" | "public";
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

/**
 * A note's hosting row (docs/notes.md §8). The same table and routes an
 * artifact's uses, with `kind = 'note'`; only the id it carries is named for
 * what it is.
 */
export interface HostedNote {
  noteId: string;
  shareId: string;
  revision: number;
  visibility: "private" | "public";
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

export interface IMessageLinkStatus {
  available: boolean;
  linked: boolean;
  phone: string | null;
  verifiedAt: string | null;
}

export interface IMessageLinkChallenge {
  challengeId: string;
  phone: string;
  expiresAt: string;
}

/**
 * The account's model meter (`GET /v1/ai-usage`): what its devices have
 * spent through control's model proxy. Tokens are what the answers reported;
 * the cost is the gateway's own USD figure, a decimal string so nothing is
 * rounded before it is shown. The cap is the account's own ceiling.
 */
export interface AiUsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: string;
}

export interface AiUsageModelTotals extends AiUsageTotals {
  kind: string;
  modelId: string | null;
}

export interface AiUsageCap {
  /** USD per calendar month (UTC), as a decimal string; null is no cap. */
  monthlyUsd: string | null;
  /** The month's cost has reached the cap: model calls are being refused. */
  reached: boolean;
}

export interface AiUsageSummary {
  day: AiUsageTotals;
  month: AiUsageTotals;
  models: AiUsageModelTotals[];
  since: { day: string; month: string };
  cap: AiUsageCap;
}


const TIMEOUT_MS = 15_000;

/** Replace a device token control has just refused; null when it cannot be. */
type TokenRecovery = (rejected: string) => Promise<string | null>;

let recoverToken: TokenRecovery | null = null;

/**
 * How this client answers a 401.
 *
 * Device tokens live ten minutes, so a tab left open outlives its bearer. The
 * session owns the device key and hands over a way to mint a new token; every
 * call then costs at most one silent re-mint and one retry instead of a
 * reload. Returns the undo, so a session that ends stops recovering for
 * whatever the next one holds.
 */
export function setTokenRecovery(recover: TokenRecovery): () => void {
  recoverToken = recover;
  return () => {
    if (recoverToken === recover) recoverToken = null;
  };
}

async function request<T>(
  path: string,
  init: RequestInit & { token?: string | null; recover?: boolean; controlUrl?: string } = {},
): Promise<T> {
  const { token, headers, recover = true, controlUrl = CONTROL_URL, ...rest } = init;
  const response = await fetch(`${controlUrl.replace(/\/+$/u, "")}/v1${path}`, {
    ...rest,
    headers: {
      ...(rest.body === undefined ? {} : { "content-type": "application/json" }),
      ...(token == null ? {} : { authorization: `Bearer ${token}` }),
      ...headers,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((error: unknown) => {
    throw new Error(
      `Could not reach the control plane at ${CONTROL_URL}. ${error instanceof Error ? error.message : ""}`.trim(),
    );
  });
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  const body: unknown = text === "" ? null : JSON.parse(text);
  if (response.status === 401 && recover && token != null && recoverToken !== null) {
    // The token expired under a tab that stayed open. One re-mint, one retry,
    // never a loop: a fresh token that is refused too raises the 401.
    const fresh = await recoverToken(token);
    if (fresh !== null && fresh !== token) return request<T>(path, { ...init, token: fresh, recover: false });
  }
  if (!response.ok) {
    const record = (body ?? {}) as Record<string, unknown>;
    throw new ControlError(
      response.status,
      typeof record["error"] === "string" ? record["error"] : "unknown",
      typeof record["message"] === "string" ? record["message"] : undefined,
    );
  }
  return body as T;
}

/* --------------------------------- account -------------------------------- */

export const signUp = (email: string, password: string): Promise<{ userId: string; bootstrapToken: string }> =>
  request("/accounts", { method: "POST", body: JSON.stringify({ email, password }) });

export const passwordLogin = (email: string, password: string): Promise<{ userId: string; bootstrapToken: string }> =>
  request("/auth/password-login", { method: "POST", body: JSON.stringify({ email, password }) });

export const deviceChallenge = (deviceId: string): Promise<{ challenge: string }> =>
  request("/auth/device-challenge", { method: "POST", body: JSON.stringify({ deviceId }) });

export const deviceLogin = (
  deviceId: string,
  challenge: string,
  signature: string,
): Promise<{ token: string; exp: number }> =>
  request("/auth/device-login", { method: "POST", body: JSON.stringify({ deviceId, challenge, signature }) });

/**
 * Silently re-mint a still-valid device token. Cheaper than a device-login
 * proof and enough for an ordinary refresh; only a token control has already
 * let expire needs the key again.
 */
export const refreshDeviceToken = (token: string): Promise<{ token: string; exp: number }> =>
  request("/auth/token/refresh", { method: "POST", token, recover: false });

export const enrollDevice = (
  token: string,
  body: {
    deviceId: string;
    name: string;
    platform: "web";
    devicePublicKey: string;
    agreementPublicKey: string;
    challenge: string;
    signature: string;
  },
): Promise<{ device: ControlDevice; token: string; exp: number }> =>
  request("/devices/enroll", { method: "POST", token, body: JSON.stringify(body) });

export const provisionAccount = (
  token: string,
  wrappers: Array<{ spaceId: string; salt: string; wrapped: string }>,
): Promise<{ provisioned: true }> =>
  request("/account/provision", { method: "POST", token, body: JSON.stringify({ wrappers }) });

export const me = (token: string): Promise<ControlMe> => request("/me", { token, cache: "no-store" });

export const completeAccountOnboarding = (token: string): Promise<{ onboardingCompletedAt: string }> =>
  request("/me/onboarding/complete", { method: "POST", token });

export const changePassword = (token: string, currentPassword: string, newPassword: string): Promise<{ ok: true }> =>
  request("/auth/password", { method: "POST", token, body: JSON.stringify({ currentPassword, newPassword }) });

/* --------------------------------- models --------------------------------- */

export const getAiUsage = (token: string): Promise<AiUsageSummary> => request("/ai-usage", { token });

/** A decimal string in USD, or null to remove the cap. Answers the refreshed summary. */
export const setAiUsageCap = (token: string, monthlyUsd: string | null): Promise<AiUsageSummary> =>
  request("/ai-usage/cap", { method: "PUT", token, body: JSON.stringify({ monthlyUsd }) });

export const listSpaces = (token: string): Promise<{ spaces: ControlSpace[] }> => request("/spaces", { token });

/**
 * Rename a Space in control's own row. The NAME people see comes from the
 * sealed `space:<id>` record the host publishes; this is the plaintext copy
 * control keeps so its own listings — the Space picker on this side, the
 * device pages — agree with it (docs/web-browser-design.md §14).
 */
export const renameSpace = (
  token: string,
  spaceId: string,
  name: string,
): Promise<{ space: { id: string; name: string; createdAt: string } }> =>
  request(`/spaces/${encodeURIComponent(spaceId)}`, {
    method: "PUT",
    token,
    body: JSON.stringify({ name }),
  });

export const listWrappers = (token: string, spaceId: string): Promise<{ wrappers: ControlWrapper[] }> =>
  request(`/spaces/${encodeURIComponent(spaceId)}/wrappers`, { token });

export const putWrappers = (
  token: string,
  spaceId: string,
  wrappers: Array<{
    kind: string;
    credentialId: string;
    salt: string;
    wrapped: string;
    senderDeviceId?: string;
    signature?: string;
  }>,
): Promise<{ wrappers: ControlWrapper[] }> =>
  request(`/spaces/${encodeURIComponent(spaceId)}/wrappers`, {
    method: "PUT",
    token,
    body: JSON.stringify({ wrappers }),
  });

export const listDevices = (token: string): Promise<{ devices: ControlDevice[] }> => request("/devices", { token });

export const renameDevice = (token: string, id: string, name: string): Promise<{ device: ControlDevice }> =>
  request(`/devices/${id}`, { method: "PATCH", token, body: JSON.stringify({ name }) });

export const revokeDevice = (
  token: string,
  id: string,
): Promise<{ revoked: boolean; affectedOrigins: Array<{ domain: string; label: string; remoteLogoutUrl?: string }> }> =>
  request(`/devices/${id}/revoke`, { method: "POST", token });

/* ----------------------------------- runs --------------------------------- */

export const listRuns = (token: string, spaceId: string): Promise<{ runs: ThreadListItem[] }> =>
  request(`/runs?spaceId=${encodeURIComponent(spaceId)}`, { token });

/** The hosted record, which is where a run's Space id lives. */
export const getRun = (token: string, runId: string): Promise<{
  run: { id: string; spaceId: string; status: string; executor: { kind: "desktop" | "cloud" } };
  thread: { spaceId: string; sealed: string } | null;
}> =>
  request(`/runs/${runId}`, { token });

export const createRun = (
  token: string,
  body: { spaceId: string; intent: string; startUrl?: string },
): Promise<{ runId: string }> => request("/runs", { method: "POST", token, body: JSON.stringify(body) });

export const runCommand = (
  token: string,
  runId: string,
  command: "message" | "answer" | "interrupt" | "release" | "revoke",
  body: Record<string, unknown> = {},
): Promise<{ ok: boolean; status: string }> =>
  request(`/runs/${runId}/${command}`, { method: "POST", token, body: JSON.stringify(body) });

/**
 * A one-minute credential for the run's live view (§8.5). The runner
 * authenticates the WebSocket upgrade with it, and `url` is the runner to
 * dial. Fetched fresh for every dial — never the tab's own device token,
 * which would then be sitting in a URL.
 */
export const runLiveTicket = (
  token: string,
  runId: string,
): Promise<{ url: string; ticket: string; expiresAt: string }> =>
  request(`/runs/${runId}/live-ticket`, { method: "POST", token });

/** The SSE URL for a run's events; read it with `fetch` so the token can ride in a header. */
export const runEventsUrl = (runId: string, since = 0): string =>
  `${CONTROL_URL}/v1/runs/${runId}/events?since=${String(since)}`;

/* ----------------------------- browser sessions --------------------------- */

/**
 * A browser session (docs/web-browser-design.md §4.2, W4): the durable object
 * per account and Space that the cloud browser's tabs belong to. It exists
 * before, during and after any conversation; a viewer — one web tab attached
 * to it over the shell socket — comes and goes without ending it.
 */
export interface BrowserSession {
  id: string;
  spaceId: string;
  state: "ready" | "live" | "suspended" | "ended";
  /** Who may act in the session's tabs, and under which generation (W7). */
  control: { holder: "human" | "agent"; generation: number };
  activeRunId: string | null;
  /** The worker holding the lease, while one does. The lease token never leaves control. */
  worker: { id: string; until: string } | null;
  lastAttachedAt: string | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

/**
 * Create-or-resume: `201` with a fresh session, `200` with the one this Space
 * already has. Two tabs opening the same Space therefore land on ONE session
 * rather than racing two Chromium contexts over one sealed record.
 */
export const createBrowserSession = (token: string, spaceId: string): Promise<{ session: BrowserSession }> =>
  request("/browser-sessions", { method: "POST", token, body: JSON.stringify({ spaceId }) });

export const listBrowserSessions = (token: string, spaceId?: string): Promise<{ sessions: BrowserSession[] }> =>
  request(`/browser-sessions${spaceId === undefined ? "" : `?spaceId=${encodeURIComponent(spaceId)}`}`, { token });

export const getBrowserSession = (token: string, sessionId: string): Promise<{ session: BrowserSession }> =>
  request(`/browser-sessions/${sessionId}`, { token });

/**
 * The shell socket's twin of the live view's ticket (§5): one session, one
 * redemption, one minute. Minted whether or not the session is leased — the
 * worker that redeems it claims the session on demand — and fetched fresh for
 * every dial, reconnects included, so a re-claimed session is followed to its
 * new worker.
 */
export const browserSessionTicket = (
  token: string,
  sessionId: string,
): Promise<{ url: string; ticket: string; expiresAt: string }> =>
  request(`/browser-sessions/${sessionId}/ticket`, { method: "POST", token });

/** End the session and everything attached to it. The tabs do not come back. */
export const endBrowserSession = (token: string, sessionId: string): Promise<void> =>
  request(`/browser-sessions/${sessionId}/end`, { method: "POST", token });

/* ------------------------------ credential vault ------------------------------ */

/** What a device sends to file or update an entry: metadata plus the ciphertext it sealed. */
export interface VaultEntryInput {
  siteOrigin: string;
  siteName: string;
  fields: VaultEntryField[];
  sealedPayload: string;
}

export const listVaultEntries = (token: string, spaceId: string): Promise<{ entries: VaultEntry[] }> =>
  request(`/spaces/${encodeURIComponent(spaceId)}/vault`, { token, cache: "no-store" });

export const putVaultEntry = (
  token: string,
  spaceId: string,
  entryId: string,
  input: VaultEntryInput,
): Promise<{ entry: VaultEntry }> =>
  request(`/spaces/${encodeURIComponent(spaceId)}/vault/${encodeURIComponent(entryId)}`, {
    method: "PUT",
    token,
    cache: "no-store",
    body: JSON.stringify(input),
  });

export const deleteVaultEntry = (token: string, spaceId: string, entryId: string): Promise<{ ok: true }> =>
  request(`/spaces/${encodeURIComponent(spaceId)}/vault/${encodeURIComponent(entryId)}`, { method: "DELETE", token });

/* ------------------------------ integrations (D29) ------------------------------ */

/** The OAuth clients this server offers; a provider absent here cannot be connected anywhere. */
export const listIntegrationProviders = (token: string): Promise<{ providers: IntegrationProviderConfig[] }> =>
  request("/integrations/providers", { token, cache: "no-store" });

export const listIntegrations = (token: string, spaceId: string): Promise<{ connections: IntegrationConnection[] }> =>
  request(`/spaces/${encodeURIComponent(spaceId)}/integrations`, { token, cache: "no-store" });

/**
 * Ask for a disconnect from here. The browser holds no key that opens the
 * grant, so the row becomes a tombstone the agent may no longer use; the
 * Mac or the cloud browser revokes it at the provider and drops the row.
 */
export const disconnectIntegration = (token: string, spaceId: string, connectionId: string): Promise<{ connection: IntegrationConnection }> =>
  request(`/spaces/${encodeURIComponent(spaceId)}/integrations/${encodeURIComponent(connectionId)}/disconnect`, { method: "POST", token });

export const getCredentialCapture = (
  captureId: string,
  controlUrl?: string,
): Promise<{ capture: CredentialCapture }> =>
  request(`/credential-captures/${encodeURIComponent(captureId)}`, {
    controlUrl,
    cache: "no-store",
  });

export const submitCredentialCapture = (
  captureId: string,
  sealedPayload: string,
  controlUrl?: string,
): Promise<{ ok: true }> =>
  request(`/credential-captures/${encodeURIComponent(captureId)}/submit`, {
    controlUrl,
    method: "POST",
    cache: "no-store",
    body: JSON.stringify({ sealedPayload }),
  });

/* -------------------------------- artifacts ------------------------------- */

export const listHostedArtifacts = (token: string): Promise<{ artifacts: HostedArtifact[] }> =>
  request("/artifacts", { token });

export const setArtifactVisibility = (
  token: string,
  artifactId: string,
  body: { revision: number; visibility: "private" | "public"; html?: string },
): Promise<{ artifact: HostedArtifact }> =>
  request(`/artifacts/${encodeURIComponent(artifactId)}/visibility`, {
    method: "PUT",
    token,
    body: JSON.stringify(body),
  });

export const putArtifactRevision = (
  token: string,
  artifactId: string,
  body: { revision: number; html: string },
): Promise<{ published: boolean; artifact?: HostedArtifact }> =>
  request(`/artifacts/${encodeURIComponent(artifactId)}/revision`, {
    method: "PUT",
    token,
    body: JSON.stringify(body),
  });

/* ---------------------------------- notes ---------------------------------- */

export const listHostedNotes = (token: string): Promise<{ notes: HostedNote[] }> => request("/notes", { token });

export const setNoteVisibility = (
  token: string,
  noteId: string,
  body: { revision: number; visibility: "private" | "public"; html?: string },
): Promise<{ note: HostedNote }> =>
  request(`/notes/${encodeURIComponent(noteId)}/visibility`, {
    method: "PUT",
    token,
    body: JSON.stringify(body),
  });

export const putNoteRevision = (
  token: string,
  noteId: string,
  body: { revision: number; html: string },
): Promise<{ published: boolean; note?: HostedNote }> =>
  request(`/notes/${encodeURIComponent(noteId)}/revision`, {
    method: "PUT",
    token,
    body: JSON.stringify(body),
  });

/* ------------------------------ shared notes ------------------------------- */

/**
 * A note someone else shared with this account (docs/notes.md §9). Unlike
 * everything else the web app reads, its body is NOT end-to-end encrypted:
 * a share is the owner's deliberate decision to keep this one note's text
 * in plaintext on the server so the people they named can read it.
 */
export interface SharedNoteListItem {
  ownerId: string;
  ownerEmail: string;
  noteId: string;
  /** Null until the owner's device has pushed the body once. */
  title: string | null;
  role: "viewer" | "editor";
  revision: number | null;
  updatedAt: string | null;
}

export interface SharedNoteBody {
  title: string;
  markdown: string;
  revision: number;
  updatedAt: string;
  updatedByUserId: string | null;
}

/** Everything shared with me. Read by recipient, so it names only this account. */
export const listSharedNotes = (token: string): Promise<{ notes: SharedNoteListItem[] }> =>
  request("/shared-notes", { token });

export const getSharedNote = (
  token: string,
  ownerId: string,
  noteId: string,
): Promise<{ role: "owner" | "viewer" | "editor"; note: SharedNoteBody | null }> =>
  request(`/shared-notes/${encodeURIComponent(ownerId)}/${encodeURIComponent(noteId)}`, { token });

/**
 * An editor's save. `revision` must be above what the server holds, so a
 * page that was left open while someone else saved gets `stale_revision`
 * rather than quietly overwriting them.
 */
export const putSharedNote = (
  token: string,
  ownerId: string,
  noteId: string,
  body: { title: string; markdown: string; revision: number },
): Promise<{ note: SharedNoteBody }> =>
  request(`/shared-notes/${encodeURIComponent(ownerId)}/${encodeURIComponent(noteId)}`, {
    method: "PUT",
    token,
    body: JSON.stringify(body),
  });

/** One note of the owner's own: who it is shared with, and what they may do. */
export interface NoteShareRow {
  id: string;
  email: string;
  role: "viewer" | "editor";
  createdAt: string;
}

export const listNoteShares = (token: string, noteId: string): Promise<{ shares: NoteShareRow[] }> =>
  request(`/notes/${encodeURIComponent(noteId)}/shares`, { token });

/* --------------------------------- channels -------------------------------- */

export const listChannels = (token: string): Promise<{ channels: ControlChannel[] }> => request("/channels", { token });

export const createChannel = (
  token: string,
  body: { name: string; spaceId: string; outboundUrl?: string },
): Promise<{ linkId: string; secret: string }> =>
  request("/channels", { method: "POST", token, body: JSON.stringify(body) });

export const deleteChannel = (token: string, id: string): Promise<void> =>
  request(`/channels/${id}`, { method: "DELETE", token });

/* -------------------------------- iMessage -------------------------------- */

export const getIMessageLink = (token: string): Promise<IMessageLinkStatus> =>
  request("/imessage/link", { token });

export const startIMessageLink = (token: string, phone: string): Promise<IMessageLinkChallenge> =>
  request("/imessage/link/start", { method: "POST", token, body: JSON.stringify({ phone }) });

export const verifyIMessageLink = (
  token: string,
  challengeId: string,
  code: string,
): Promise<IMessageLinkStatus> =>
  request("/imessage/link/verify", { method: "POST", token, body: JSON.stringify({ challengeId, code }) });

export const unlinkIMessage = (token: string): Promise<void> =>
  request("/imessage/link", { method: "DELETE", token });

export const getIMessageOnboarding = (
  onboardingToken: string,
): Promise<{ phone: string; expiresAt: string }> =>
  request(`/imessage/onboarding/${encodeURIComponent(onboardingToken)}`, { cache: "no-store" });

export const claimIMessageOnboarding = (
  token: string,
  onboardingToken: string,
): Promise<{ linked: true; phone: string; verifiedAt: string }> =>
  request(`/imessage/onboarding/${encodeURIComponent(onboardingToken)}/claim`, { method: "POST", token });

/* ---------------------------------- cloud --------------------------------- */

export const enableCloud = (
  token: string,
  spaceId: string,
): Promise<{ device: ControlDevice }> =>
  request("/cloud/enable", { method: "POST", token, body: JSON.stringify({ spaceId }) });
