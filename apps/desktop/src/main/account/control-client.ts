/**
 * ControlClient — a typed fetch wrapper over the control plane
 * (docs/cloud-sync-design.md §7.3), trimmed to the routes the desktop calls.
 *
 * Token model (§7.2): control mints EdDSA device JWTs. A bootstrap token
 * (`did === sub`) comes from sign-up and password login and may only list
 * Spaces and wrappers and enroll; the signed device token comes from enroll
 * or a device-login proof. The client holds the current token, refreshes it
 * single-flight at `exp − 60 s`, and on a 401 proves possession of the device
 * key ONCE (the injected `reauth`, which AuthService builds from
 * `store.deviceId` and the signing key) and retries the request once. Only a
 * proof that ANSWERS `null` — control refused this key — means the device was
 * revoked; a proof that rejects (offline, 5xx, 429, an expired challenge)
 * could not be completed, so it keeps the token and retries later.
 *
 * Every request carries a 10 s timeout. `fetch` is injectable for tests.
 */

import type {
  AgentAttachment,
  CredentialCapture,
  CredentialCaptureReply,
  AgentQuestion,
  IntegrationAccess,
  IntegrationConnection,
  IntegrationConnectionStatus,
  IntegrationProvider,
  IntegrationProviderConfig,
  ThreadListItem,
  VaultEntry,
  VaultEntryField,
} from "@pistachio/protocol";
import type { HostedRunRecord } from "@pistachio/runtime";
import type { KeyWrapperKind, OriginPolicy } from "@pistachio/sync-protocol";
import type { AiUsageSummary, DevicePlatform } from "@pistachio/shell-contracts/ipc";
import { refreshDelayMs, shouldRefreshToken, tokenExpSeconds } from "./auth-token";

/** The dev control plane (`pnpm --filter @pistachio/control dev`). */
export const DEFAULT_CONTROL_URL = "http://localhost:8787";

/**
 * The hosted control plane packaged builds talk to. A `.app` launched from
 * Finder inherits no shell environment, so PISTACHIO_CONTROL_URL is never set
 * there; it still wins when it IS set, so dev runs are unaffected.
 */
// The deployed control plane (Railway, custom domain). `control.pistachio.run`
// exists in DNS but answers 404; a packaged build with no configured URL must
// land on the same host the web app and the runner use.
export const PROD_CONTROL_URL = "https://api.pistachio.run";
export const DEFAULT_WEB_URL = "http://localhost:3000";
export const PROD_WEB_URL = "https://www.pistachio.run";

export const CONTROL_TIMEOUT_MS = 10_000;

/**
 * How long a refresh waits before trying again when the device-login proof
 * could not be completed at all (the control plane was unreachable, or
 * answered 5xx/429). The token is still held; this is what keeps a sleeping
 * Mac from waking to a dead enrollment.
 */
export const REAUTH_RETRY_MS = 60_000;

/** `PISTACHIO_CONTROL_URL` when set; the production host when packaged; the dev default otherwise. */
export function resolveControlUrl(env: NodeJS.ProcessEnv, packaged: boolean): string {
  const configured = env["PISTACHIO_CONTROL_URL"]?.trim() ?? "";
  const chosen = configured !== "" ? configured : packaged ? PROD_CONTROL_URL : DEFAULT_CONTROL_URL;
  return chosen.replace(/\/+$/, "");
}

/** `PISTACHIO_WEB_URL` when set; otherwise the matching packaged/dev web app. */
export function resolveWebUrl(env: NodeJS.ProcessEnv, packaged: boolean): string {
  const configured = env["PISTACHIO_WEB_URL"]?.trim() ?? "";
  return (configured !== "" ? configured : packaged ? PROD_WEB_URL : DEFAULT_WEB_URL).replace(/\/+$/, "");
}

/* ------------------------------- wire shapes ------------------------------- */

export interface ControlDevice {
  id: string;
  name: string;
  platform: DevicePlatform;
  /** base64 raw 32 B Ed25519. */
  devicePublicKey: string;
  /** base64 raw 32 B X25519. */
  agreementPublicKey: string;
  createdAt: string | null;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export interface ControlTokenResponse {
  token: string;
  exp: number;
}

export interface ControlBootstrapResponse {
  userId: string;
  bootstrapToken: string;
  exp: number;
}

export interface ControlSpace {
  id: string;
  name: string;
}

export interface ControlWrapperRow {
  spaceId: string;
  kind: KeyWrapperKind;
  credentialId: string;
  salt: string;
  wrapped: string;
  senderDeviceId: string | null;
  signature: string | null;
  createdAt: string | null;
}

export interface ControlWrapperInput {
  kind: KeyWrapperKind;
  credentialId: string;
  salt: string;
  wrapped: string;
  senderDeviceId?: string;
  signature?: string;
}

export interface ControlMe {
  userId: string;
  /** Null for an anonymous account (docs/anonymous-accounts.md). */
  email: string | null;
  anonymous?: boolean;
  hubUrl: string | null;
  cloudBrowserUrl: string | null;
  egress: { host: string; port: number } | null;
  /** The names control publishes for this account, e.g. `["sync"]`. */
  features: string[];
}

export interface ControlEgressCredential {
  username: string;
  password: string;
  expiresAt: string;
  credentialId: string;
}

export interface ControlEgressGateway {
  host: string;
  port: number;
  egressIp: string | null;
  region: string | null;
  state: string | null;
}

export interface ControlEgressResponse {
  gateway: ControlEgressGateway | null;
  credential: ControlEgressCredential | null;
  policy: {
    mediaBypass: string[];
    hostileSeed: string[];
    checkoutRules: unknown[];
  };
}

export interface ControlSyncPolicy {
  version: number;
  origins: OriginPolicy[];
  /** host → mode, as `PUT /sync/policy/overrides/:host {mode}` recorded it. */
  overrides: Record<string, string>;
}

export interface ControlRevokeResponse {
  revoked: boolean;
  affectedOrigins: string[];
}

export interface ControlCreateRunInput {
  spaceId: string;
  intent: string;
  attachments?: unknown[];
  startUrl?: string;
  origin?: unknown;
}

export interface ControlChannel {
  linkId: string;
  name: string;
  spaceId: string;
  outboundUrl: string | null;
  createdAt: string | null;
  revokedAt: string | null;
}

export interface ControlHostedArtifact {
  artifactId: string;
  shareId: string;
  revision: number;
  visibility: "private" | "public";
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

/**
 * A note's hosting row (docs/notes.md §8). The same table behind the same
 * routes as an artifact's, with `kind = 'note'`; only the name of the id it
 * carries differs, so the caller never has to read `artifactId` to learn
 * which note it asked about.
 */
export interface ControlHostedNote {
  noteId: string;
  shareId: string;
  revision: number;
  visibility: "private" | "public";
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

/**
 * One account the owner has named on a note (docs/notes.md §9). The email is
 * how the share was made and how it is shown; control resolved it to an
 * account when the share was created, and there are no invites to strangers.
 */
export interface ControlNoteShare {
  id: string;
  email: string;
  role: "viewer" | "editor";
  createdAt: string;
}

/**
 * The plaintext body every share reads. A deliberate departure from
 * end-to-end encryption for exactly the notes the person chose to share —
 * the same trade a published note's HTML already makes (§9).
 */
export interface ControlSharedNote {
  title: string;
  markdown: string;
  revision: number;
  updatedAt: string;
  /** The editor who last wrote it back, or null while only this Mac has. */
  updatedByUserId: string | null;
}

export interface ControlIMessageLink {
  available: boolean;
  linked: boolean;
  phone: string | null;
  verifiedAt: string | null;
}

export interface ControlIMessageChallenge {
  challengeId: string;
  phone: string;
  expiresAt: string;
}

/** A non-2xx answer, with control's error code when it sent one. */
export class ControlError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly method: string;
  readonly path: string;

  constructor(status: number, code: string | null, method: string, path: string, detail?: string) {
    super(`control: ${detail ?? (code === null ? String(status) : `${String(status)} ${code}`)} (${method} ${path})`);
    this.name = "ControlError";
    this.status = status;
    this.code = code;
    this.method = method;
    this.path = path;
  }
}

export interface ControlClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** A 401 that no proof could clear: the token is gone. */
  onUnauthorized?: () => void;
  /** Every token change, so the owner can persist a silent refresh. */
  onTokenChanged?: (token: string | null) => void;
  now?: () => number;
}

export class ControlClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #onUnauthorized: (() => void) | undefined;
  readonly #onTokenChanged: ((token: string | null) => void) | undefined;
  readonly #now: () => number;
  #token: string | null = null;
  #refreshTimer: NodeJS.Timeout | null = null;
  #refreshInFlight: Promise<void> | null = null;
  /** The device-login proof, set by AuthService once the device is enrolled. */
  #reauth: (() => Promise<string | null>) | null = null;
  /** In flight, so concurrent 401s share one proof. */
  #reauthInFlight: Promise<string | null> | null = null;

  constructor(baseUrl: string, options: ControlClientOptions = {}) {
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? CONTROL_TIMEOUT_MS;
    this.#onUnauthorized = options.onUnauthorized;
    this.#onTokenChanged = options.onTokenChanged;
    this.#now = options.now ?? (() => Date.now());
  }

  get url(): string {
    return this.#baseUrl;
  }

  setReauth(proof: (() => Promise<string | null>) | null): void {
    this.#reauth = proof;
  }

  setToken(token: string | null): void {
    const changed = token !== this.#token;
    this.#token = token;
    this.#scheduleRefresh();
    if (changed) this.#onTokenChanged?.(token);
  }

  /** The current token without refreshing. */
  token(): string | null {
    return this.#token;
  }

  /** The current token, refreshed first when it is due (hub dials, SSE). */
  async getToken(): Promise<string | null> {
    const token = this.#token;
    if (token !== null) {
      const exp = tokenExpSeconds(token);
      if (exp !== null && shouldRefreshToken(exp, this.#now() / 1000)) await this.refresh();
    }
    return this.#token;
  }

  /** Headers for a request the caller makes itself (an event stream). */
  async authorizedHeaders(): Promise<Record<string, string>> {
    const token = await this.getToken();
    return token === null ? {} : { authorization: `Bearer ${token}` };
  }

  dispose(): void {
    if (this.#refreshTimer !== null) clearTimeout(this.#refreshTimer);
    this.#refreshTimer = null;
  }

  /* ------------------------------ public routes ------------------------------ */

  async signUp(email: string, password: string): Promise<ControlBootstrapResponse> {
    const out = await this.#requestNoReauth<ControlBootstrapResponse>("POST", "/v1/accounts", {
      email,
      password,
    });
    this.setToken(out.bootstrapToken);
    return out;
  }

  /**
   * An account for a Mac nobody signed in on (docs/anonymous-accounts.md):
   * the device proof is the whole sign-up, and the answer is a device token.
   */
  async createAnonymousAccount(args: {
    deviceId: string;
    name: string;
    platform: "macos";
    devicePublicKey: string;
    agreementPublicKey: string;
    challenge: string;
    signature: string;
  }): Promise<{ userId: string; device: ControlDevice; token: string; exp: number }> {
    const out = await this.#requestNoReauth<{ userId: string; device: ControlDevice; token: string; exp: number }>(
      "POST",
      "/v1/accounts/anonymous",
      args,
    );
    this.setToken(out.token);
    return out;
  }

  async passwordLogin(email: string, password: string): Promise<ControlBootstrapResponse> {
    const out = await this.#requestNoReauth<ControlBootstrapResponse>(
      "POST",
      "/v1/auth/password-login",
      { email, password },
    );
    this.setToken(out.bootstrapToken);
    return out;
  }

  async requestPasswordReset(email: string): Promise<void> {
    await this.#requestNoReauth("POST", "/v1/auth/password-reset/request", { email });
  }

  async confirmPasswordReset(args: { email: string; code: string; password: string }): Promise<void> {
    await this.#requestNoReauth("POST", "/v1/auth/password-reset/confirm", args);
  }

  /** A one-time challenge for a device-login proof; works for ids not yet enrolled. */
  async deviceChallenge(deviceId: string): Promise<string> {
    const out = await this.#requestNoReauth<{ challenge: string }>("POST", "/v1/auth/device-challenge", {
      deviceId,
    });
    return out.challenge;
  }

  /** Prove possession of the enrolled key and mint a signed device token. */
  async deviceLogin(args: {
    deviceId: string;
    challenge: string;
    signature: string;
  }): Promise<ControlTokenResponse> {
    return this.#requestNoReauth<ControlTokenResponse>("POST", "/v1/auth/device-login", args);
  }

  /* --------------------------- bootstrap or device --------------------------- */

  async enrollDevice(args: {
    deviceId: string;
    name: string;
    platform: "macos";
    devicePublicKey: string;
    agreementPublicKey: string;
    challenge: string;
    signature: string;
  }): Promise<{ device: ControlDevice; token: string; exp: number }> {
    const out = await this.#requestNoReauth<{ device: ControlDevice; token: string; exp: number }>(
      "POST",
      "/v1/devices/enroll",
      args,
    );
    this.setToken(out.token);
    return out;
  }

  /** The anonymous account this Mac holds becomes a real one, in place; the token stays good. */
  upgradeAccount(email: string, password: string): Promise<{ userId: string; email: string }> {
    return this.#request("POST", "/v1/account/upgrade", { email, password });
  }

  /**
   * Fold this Mac's anonymous account into the one just signed in to (the
   * bearer is that account's bootstrap token). The device moves with it, so
   * the answer is its token under the new account.
   */
  async linkAnonymousAccount(anonymousToken: string): Promise<{ device: ControlDevice; token: string; exp: number }> {
    const out = await this.#requestNoReauth<{ device: ControlDevice; token: string; exp: number }>(
      "POST",
      "/v1/account/link",
      { anonymousToken },
    );
    this.setToken(out.token);
    return out;
  }

  me(): Promise<ControlMe> {
    return this.#request<ControlMe>("GET", "/v1/me");
  }

  createBrowserSession(spaceId: string): Promise<{ session: { id: string; spaceId: string } }> {
    return this.#request("POST", "/v1/browser-sessions", { spaceId });
  }

  browserSessionTicket(sessionId: string): Promise<{ url: string; ticket: string }> {
    return this.#request("POST", `/v1/browser-sessions/${encodeURIComponent(sessionId)}/ticket`);
  }

  completeOnboarding(): Promise<{ onboardingCompletedAt: string }> {
    return this.#request("POST", "/v1/me/onboarding/complete");
  }

  async listSpaces(): Promise<ControlSpace[]> {
    return (await this.#request<{ spaces: ControlSpace[] }>("GET", "/v1/spaces")).spaces;
  }

  async listWrappers(spaceId: string): Promise<ControlWrapperRow[]> {
    return (
      await this.#request<{ wrappers: ControlWrapperRow[] }>(
        "GET",
        `/v1/spaces/${encodeURIComponent(spaceId)}/wrappers`,
      )
    ).wrappers;
  }

  /* ------------------------------ credential vault ------------------------------ */

  async listVault(spaceId: string): Promise<VaultEntry[]> {
    return (await this.#request<{ entries: VaultEntry[] }>("GET", `/v1/spaces/${encodeURIComponent(spaceId)}/vault`)).entries;
  }

  async putVaultEntry(
    spaceId: string,
    entryId: string,
    input: { siteOrigin: string; siteName: string; fields: VaultEntryField[]; sealedPayload: string },
  ): Promise<VaultEntry> {
    return (
      await this.#request<{ entry: VaultEntry }>(
        "PUT",
        `/v1/spaces/${encodeURIComponent(spaceId)}/vault/${encodeURIComponent(entryId)}`,
        input,
      )
    ).entry;
  }

  async deleteVaultEntry(spaceId: string, entryId: string): Promise<void> {
    await this.#request("DELETE", `/v1/spaces/${encodeURIComponent(spaceId)}/vault/${encodeURIComponent(entryId)}`);
  }

  /* ------------------------------ integrations (D29) ------------------------------ */

  /** The OAuth clients control was configured with; a provider absent here cannot be connected. */
  async listIntegrationProviders(): Promise<IntegrationProviderConfig[]> {
    return (await this.#request<{ providers: IntegrationProviderConfig[] }>("GET", "/v1/integrations/providers")).providers;
  }

  async listIntegrations(spaceId: string): Promise<IntegrationConnection[]> {
    return (await this.#request<{ connections: IntegrationConnection[] }>("GET", `/v1/spaces/${encodeURIComponent(spaceId)}/integrations`)).connections;
  }

  async putIntegration(
    spaceId: string,
    connectionId: string,
    input: {
      provider: IntegrationProvider;
      accountLabel: string;
      access: IntegrationAccess;
      scopes: string[];
      sealedPayload: string;
    },
  ): Promise<IntegrationConnection> {
    return (
      await this.#request<{ connection: IntegrationConnection }>(
        "PUT",
        `/v1/spaces/${encodeURIComponent(spaceId)}/integrations/${encodeURIComponent(connectionId)}`,
        input,
      )
    ).connection;
  }

  async markIntegrationUsed(spaceId: string, connectionId: string): Promise<void> {
    await this.#request("POST", `/v1/spaces/${encodeURIComponent(spaceId)}/integrations/${encodeURIComponent(connectionId)}/used`);
  }

  /** The provider refused the grant for good. Exact id: a row already replaced answers 404 rather than coming back to life. */
  async setIntegrationStatus(spaceId: string, connectionId: string, status: Extract<IntegrationConnectionStatus, "reconnect_required">): Promise<void> {
    await this.#request("POST", `/v1/spaces/${encodeURIComponent(spaceId)}/integrations/${encodeURIComponent(connectionId)}/status`, { status });
  }

  async deleteIntegration(spaceId: string, connectionId: string): Promise<void> {
    await this.#request("DELETE", `/v1/spaces/${encodeURIComponent(spaceId)}/integrations/${encodeURIComponent(connectionId)}`);
  }

  /* ------------------------------ device bearer ------------------------------ */

  async changePassword(args: { currentPassword: string; newPassword: string }): Promise<void> {
    await this.#request<{ ok: true }>("POST", "/v1/auth/password", args);
  }

  async listDevices(): Promise<ControlDevice[]> {
    return (await this.#request<{ devices: ControlDevice[] }>("GET", "/v1/devices")).devices;
  }

  async renameDevice(deviceId: string, name: string): Promise<ControlDevice> {
    return (
      await this.#request<{ device: ControlDevice }>(
        "PATCH",
        `/v1/devices/${encodeURIComponent(deviceId)}`,
        { name },
      )
    ).device;
  }

  revokeDevice(deviceId: string): Promise<ControlRevokeResponse> {
    return this.#request<ControlRevokeResponse>(
      "POST",
      `/v1/devices/${encodeURIComponent(deviceId)}/revoke`,
      {},
    );
  }

  async putSpace(spaceId: string, name: string): Promise<void> {
    await this.#request("PUT", `/v1/spaces/${encodeURIComponent(spaceId)}`, { name });
  }

  async deleteSpace(spaceId: string): Promise<void> {
    await this.#request("DELETE", `/v1/spaces/${encodeURIComponent(spaceId)}`);
  }

  async putWrappers(spaceId: string, wrappers: ControlWrapperInput[]): Promise<ControlWrapperRow[]> {
    return (
      await this.#request<{ wrappers: ControlWrapperRow[] }>(
        "PUT",
        `/v1/spaces/${encodeURIComponent(spaceId)}/wrappers`,
        { wrappers },
      )
    ).wrappers;
  }

  async deleteWrapper(spaceId: string, kind: KeyWrapperKind, credentialId: string): Promise<void> {
    await this.#request(
      "DELETE",
      `/v1/spaces/${encodeURIComponent(spaceId)}/wrappers/${encodeURIComponent(kind)}/${encodeURIComponent(credentialId)}`,
    );
  }

  syncPolicy(): Promise<ControlSyncPolicy> {
    return this.#request<ControlSyncPolicy>("GET", "/v1/sync/policy");
  }

  async setSyncPolicyOverride(host: string, mode: "sync" | "never"): Promise<void> {
    await this.#request("PUT", `/v1/sync/policy/overrides/${encodeURIComponent(host)}`, { mode });
  }

  /** Back to the corpus policy for `host` (control's `DELETE /sync/policy/overrides/:host`). */
  async deleteSyncPolicyOverride(host: string): Promise<void> {
    await this.#request("DELETE", `/v1/sync/policy/overrides/${encodeURIComponent(host)}`);
  }

  egress(): Promise<ControlEgressResponse> {
    return this.#request<ControlEgressResponse>("GET", "/v1/egress");
  }

  async provisionEgress(): Promise<void> {
    await this.#request("POST", "/v1/egress/provision", {});
  }

  /* ---------------------------------- runs ---------------------------------- */

  createRun(input: ControlCreateRunInput): Promise<{ runId: string }> {
    return this.#request<{ runId: string }>("POST", "/v1/runs", input);
  }

  createDesktopRun(input: {
    runId: string;
    taskId: string;
    spaceId: string;
    intent: string;
    attachments?: AgentAttachment[];
    startUrl?: string;
    startedAt: string;
  }): Promise<{ runId: string }> {
    return this.#request<{ runId: string }>("POST", "/v1/runs/desktop", input);
  }

  async putDesktopRunSnapshot(
    runId: string,
    input: {
      summary: ThreadListItem;
      completedAt: string | null;
      thread: { spaceId: string; sealed: string };
    },
  ): Promise<void> {
    await this.#request("PUT", `/v1/runs/${encodeURIComponent(runId)}/desktop-snapshot`, input);
  }

  async listRuns(spaceId: string): Promise<ThreadListItem[]> {
    return (
      await this.#request<{ runs: ThreadListItem[] }>(
        "GET",
        `/v1/runs?spaceId=${encodeURIComponent(spaceId)}`,
      )
    ).runs;
  }

  getRun(runId: string): Promise<{
    run: HostedRunRecord;
    summary: ThreadListItem;
    thread: { spaceId: string; sealed: string } | null;
  }> {
    return this.#request<{
      run: HostedRunRecord;
      summary: ThreadListItem;
      thread: { spaceId: string; sealed: string } | null;
    }>(
      "GET",
      `/v1/runs/${encodeURIComponent(runId)}`,
    );
  }

  /**
   * A live view ticket (§8.5): the worker holding this run, and a one-minute
   * credential to dial it with. 409 when the run is not running in the cloud
   * right now, which is not an error worth surfacing as one.
   */
  async runLiveTicket(runId: string): Promise<{ url: string; ticket: string; expiresAt: string } | null> {
    try {
      return await this.#request<{ url: string; ticket: string; expiresAt: string }>(
        "POST",
        `/v1/runs/${encodeURIComponent(runId)}/live-ticket`,
        {},
      );
    } catch (error) {
      if (error instanceof ControlError && [403, 404, 409, 503].includes(error.status)) return null;
      throw error;
    }
  }

  /** The SSE address for a run's events (§7.8); dial it with `authorizedHeaders()`. */
  runEventsUrl(runId: string, since?: number): string {
    const query = since === undefined ? "" : `?since=${String(since)}`;
    return `${this.#baseUrl}/v1/runs/${encodeURIComponent(runId)}/events${query}`;
  }

  async runMessage(runId: string, body: { text: string; attachments?: unknown[] }): Promise<void> {
    await this.#request("POST", `/v1/runs/${encodeURIComponent(runId)}/message`, body);
  }

  async runAnswer(runId: string, body: { questionId: string; value: string }): Promise<void> {
    await this.#request("POST", `/v1/runs/${encodeURIComponent(runId)}/answer`, body);
  }

  async runInterrupt(runId: string): Promise<void> {
    await this.#request("POST", `/v1/runs/${encodeURIComponent(runId)}/interrupt`, {});
  }

  async runRelease(runId: string): Promise<void> {
    await this.#request("POST", `/v1/runs/${encodeURIComponent(runId)}/release`, {});
  }

  async runRevoke(runId: string): Promise<void> {
    await this.#request("POST", `/v1/runs/${encodeURIComponent(runId)}/revoke`, {});
  }

  /* --------------------------------- models --------------------------------- */

  /** The account's model meter: what its devices spent through `/v1/ai/*`. */
  aiUsage(): Promise<AiUsageSummary> {
    return this.#request<AiUsageSummary>("GET", "/v1/ai-usage");
  }

  /* -------------------------------- iMessage -------------------------------- */

  imessageLink(): Promise<ControlIMessageLink> {
    return this.#request<ControlIMessageLink>("GET", "/v1/imessage/link");
  }

  startIMessageLink(phone: string): Promise<ControlIMessageChallenge> {
    return this.#request<ControlIMessageChallenge>("POST", "/v1/imessage/link/start", { phone });
  }

  verifyIMessageLink(challengeId: string, code: string): Promise<ControlIMessageLink> {
    return this.#request<ControlIMessageLink>("POST", "/v1/imessage/link/verify", { challengeId, code });
  }

  async unlinkIMessage(): Promise<void> {
    await this.#request("DELETE", "/v1/imessage/link");
  }

  async deliverIMessage(
    runId: string,
    input:
      | { kind: "question"; question: AgentQuestion }
      | { kind: "completion"; text: string; completionId: string }
      | { kind: "resolved"; questionId?: string },
  ): Promise<boolean> {
    return (
      await this.#request<{ delivered: boolean }>(
        "POST",
        `/v1/runs/${encodeURIComponent(runId)}/imessage`,
        input,
      )
    ).delivered;
  }

  /* -------------------------------- artifacts ------------------------------- */

  async artifactPublishing(artifactId: string): Promise<ControlHostedArtifact | null> {
    try {
      return (
        await this.#request<{ artifact: ControlHostedArtifact }>(
          "GET",
          `/v1/artifacts/${encodeURIComponent(artifactId)}`,
        )
      ).artifact;
    } catch (error) {
      if (error instanceof ControlError && error.status === 404) return null;
      throw error;
    }
  }

  async putArtifactRevision(
    artifactId: string,
    input: { revision: number; html: string },
  ): Promise<boolean> {
    return (
      await this.#request<{ published: boolean }>(
        "PUT",
        `/v1/artifacts/${encodeURIComponent(artifactId)}/revision`,
        input,
      )
    ).published;
  }

  /* ---------------------------------- notes --------------------------------- */

  /** Where this note is published, or null for one that has never been hosted. */
  async notePublishing(noteId: string): Promise<ControlHostedNote | null> {
    try {
      return (
        await this.#request<{ note: ControlHostedNote }>("GET", `/v1/notes/${encodeURIComponent(noteId)}`)
      ).note;
    } catch (error) {
      if (error instanceof ControlError && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * Publish or revoke. `html` is the finished document this device rendered
   * (N9: control never learns markdown) and is required to publish; making a
   * note private clears the plaintext copy control holds.
   */
  async setNoteVisibility(
    noteId: string,
    input: { revision: number; visibility: "private" | "public"; html?: string },
  ): Promise<ControlHostedNote> {
    return (
      await this.#request<{ note: ControlHostedNote }>(
        "PUT",
        `/v1/notes/${encodeURIComponent(noteId)}/visibility`,
        input,
      )
    ).note;
  }

  async putNoteRevision(noteId: string, input: { revision: number; html: string }): Promise<boolean> {
    return (
      await this.#request<{ published: boolean }>(
        "PUT",
        `/v1/notes/${encodeURIComponent(noteId)}/revision`,
        input,
      )
    ).published;
  }

  /* ----------------------------- shared notes ------------------------------- */

  /**
   * Every live grant this account has made, over all its notes. One request,
   * so a Mac holding five hundred notes learns which two it has to keep a
   * shared body current for without asking about each one.
   */
  async myNoteShares(): Promise<Array<ControlNoteShare & { noteId: string }>> {
    return (
      await this.#request<{ shares: Array<ControlNoteShare & { noteId: string }> }>("GET", "/v1/note-shares")
    ).shares;
  }

  /** Who this note is shared with, live grants only. */
  async noteShares(noteId: string): Promise<ControlNoteShare[]> {
    return (
      await this.#request<{ shares: ControlNoteShare[] }>(
        "GET",
        `/v1/notes/${encodeURIComponent(noteId)}/shares`,
      )
    ).shares;
  }

  /**
   * Share with an account named by its exact email, or change what an
   * existing share may do. `share` is null when no Pistachio account holds
   * that email — control answers 200 either way, so an address cannot be
   * probed for existence here, and the caller is the one that says so.
   */
  async shareNote(
    noteId: string,
    input: { email: string; role: "viewer" | "editor" },
  ): Promise<{ share: ControlNoteShare | null; shares: ControlNoteShare[] }> {
    return this.#request<{ share: ControlNoteShare | null; shares: ControlNoteShare[] }>(
      "POST",
      `/v1/notes/${encodeURIComponent(noteId)}/shares`,
      input,
    );
  }

  /** Revoke one share; answers the ones still standing. */
  async unshareNote(noteId: string, shareId: string): Promise<ControlNoteShare[]> {
    return (
      await this.#request<{ shares: ControlNoteShare[] }>(
        "DELETE",
        `/v1/notes/${encodeURIComponent(noteId)}/shares/${encodeURIComponent(shareId)}`,
      )
    ).shares;
  }

  /**
   * Push the body the shares read. `stale` means another device pushed a
   * later revision; 404 means this note has no live share any more, and the
   * plaintext control held has been deleted with it.
   */
  async putSharedNote(
    noteId: string,
    input: { title: string; markdown: string; revision: number },
  ): Promise<{ stale: boolean; note?: ControlSharedNote }> {
    try {
      return await this.#request<{ stale: boolean; note?: ControlSharedNote }>(
        "PUT",
        `/v1/notes/${encodeURIComponent(noteId)}/shared`,
        input,
      );
    } catch (error) {
      if (error instanceof ControlError && error.status === 404) return { stale: true };
      throw error;
    }
  }

  /** Read the shared body back — what an editor may have written into it. */
  async sharedNote(noteId: string): Promise<ControlSharedNote | null> {
    return (
      await this.#request<{ note: ControlSharedNote | null }>(
        "GET",
        `/v1/notes/${encodeURIComponent(noteId)}/shared`,
      )
    ).note;
  }

  /* -------------------------------- channels -------------------------------- */

  createChannel(input: {
    name: string;
    spaceId: string;
    outboundUrl?: string;
  }): Promise<{ linkId: string; secret: string }> {
    return this.#request<{ linkId: string; secret: string }>("POST", "/v1/channels", input);
  }

  async listChannels(): Promise<ControlChannel[]> {
    const out = await this.#request<{ channels: Array<Record<string, unknown>> }>("GET", "/v1/channels");
    return out.channels.map(channelRow);
  }

  async deleteChannel(linkId: string): Promise<void> {
    await this.#request("DELETE", `/v1/channels/${encodeURIComponent(linkId)}`);
  }

  /* ---------------------------------- cloud --------------------------------- */

  async enableCloud(spaceId: string): Promise<ControlDevice> {
    return (await this.#request<{ device: ControlDevice }>("POST", "/v1/cloud/enable", { spaceId })).device;
  }

  async disableCloud(spaceId: string): Promise<void> {
    await this.#request("POST", "/v1/cloud/disable", { spaceId });
  }

  /* -------------------------------- internals -------------------------------- */

  #scheduleRefresh(): void {
    if (this.#refreshTimer !== null) {
      clearTimeout(this.#refreshTimer);
      this.#refreshTimer = null;
    }
    const token = this.#token;
    if (token === null) return;
    const exp = tokenExpSeconds(token);
    if (exp === null) return;
    this.#refreshTimer = setTimeout(
      () => {
        this.#refreshTimer = null;
        void this.refresh();
      },
      refreshDelayMs(exp, this.#now()),
    );
    this.#refreshTimer.unref();
  }

  /**
   * Re-mint the token ahead of exp: `POST /auth/token/refresh` with the
   * current bearer, falling back to the device-login proof when that is
   * rejected. Single-flight: a burst of callers shares one refresh. Only a
   * failed proof clears the token; a network error keeps it.
   */
  refresh(): Promise<void> {
    if (this.#refreshInFlight !== null) return this.#refreshInFlight;
    const attempt = this.#refreshOnce().finally(() => {
      if (this.#refreshInFlight === attempt) this.#refreshInFlight = null;
    });
    this.#refreshInFlight = attempt;
    return attempt;
  }

  async #refreshOnce(): Promise<void> {
    const token = this.#token;
    if (token === null) return;
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/v1/auth/token/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: "{}",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      // Network error: keep the token; the hub transport handles offline.
      return;
    }
    if (response.ok) {
      const out = (await response.json()) as ControlTokenResponse;
      if (typeof out.token === "string" && out.token !== "") this.setToken(out.token);
      return;
    }
    if (response.status === 401 || response.status === 403) {
      let fresh: string | null;
      try {
        fresh = await this.#reauthOnce();
      } catch {
        // The proof could not be COMPLETED — offline, 5xx, 429, a challenge
        // control forgot — which is not control refusing this key. Keeping
        // the token is the whole point of the rule above; a short retry
        // takes the next attempt without a sign-in.
        this.#armRetry();
        return;
      }
      if (fresh !== null) {
        this.setToken(fresh);
        return;
      }
      if (this.#reauth !== null) {
        this.setToken(null);
        this.#onUnauthorized?.();
      }
    }
    // Any other status: keep the current token and try again next cycle.
  }

  /** A refresh that could not run: try again shortly rather than never. */
  #armRetry(): void {
    if (this.#refreshTimer !== null) return;
    const timer = setTimeout(() => {
      this.#refreshTimer = null;
      void this.refresh();
    }, REAUTH_RETRY_MS);
    timer.unref();
    this.#refreshTimer = timer;
  }

  /**
   * One device-login proof at a time, shared by every caller waiting on it.
   * A proof that REJECTS is passed on as it is: only `null` means control
   * refused the key, and the callers tell those two apart.
   */
  async #reauthOnce(): Promise<string | null> {
    const proof = this.#reauth;
    if (proof === null) return null;
    if (this.#reauthInFlight === null) {
      const attempt = proof();
      this.#reauthInFlight = attempt;
      // The shared promise is awaited by everyone who wants it; this arm
      // exists so a rejection with no awaiter yet is not "unhandled".
      void attempt
        .catch(() => undefined)
        .finally(() => {
          if (this.#reauthInFlight === attempt) this.#reauthInFlight = null;
        });
    }
    return this.#reauthInFlight;
  }

  /** No plaintext crosses the native bridge or reaches the account client. */
  async getCredentialCapture(captureId: string): Promise<CredentialCaptureReply<CredentialCapture>> {
    try {
      const { capture } = await this.#requestNoReauth<{ capture: CredentialCapture }>(
        "GET", `/v1/credential-captures/${encodeURIComponent(captureId)}`,
      );
      return { ok: true, value: capture };
    } catch (error) {
      if (error instanceof ControlError) return { ok: false, status: error.status, code: error.code ?? "unknown" };
      throw error;
    }
  }

  async submitCredentialCapture(captureId: string, sealedPayload: string): Promise<CredentialCaptureReply<null>> {
    try {
      await this.#requestNoReauth("POST", `/v1/credential-captures/${encodeURIComponent(captureId)}/submit`, { sealedPayload });
      return { ok: true, value: null };
    } catch (error) {
      if (error instanceof ControlError) return { ok: false, status: error.status, code: error.code ?? "unknown" };
      throw error;
    }
  }

  #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.#send<T>(method, path, body, true);
  }

  /** The auth primitives the proof itself is made of never re-authenticate. */
  #requestNoReauth<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.#send<T>(method, path, body, false);
  }

  async #send<T>(method: string, path: string, body: unknown, allowReauth: boolean): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    // Captured so the 401 branch can tell "THIS token was rejected" from a
    // stale response racing a fresh sign-in: a request sent with a token
    // that was since replaced must never invalidate the current one.
    const sentToken = this.#token;
    if (sentToken !== null) headers["authorization"] = `Bearer ${sentToken}`;
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? null : JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new Error(`control plane unreachable at ${this.#baseUrl} (${describe(error)})`);
    }
    if (response.status === 401) {
      if (sentToken !== this.#token) throw new ControlError(401, "unauthorized", method, path);
      if (allowReauth && this.#reauth !== null) {
        // A proof that REJECTS could not be completed (offline, 5xx, 429):
        // it says nothing about this key, so it propagates untouched and the
        // token stays. Only `null` below is control refusing the key.
        const fresh = await this.#reauthOnce();
        if (fresh !== null) {
          this.setToken(fresh);
          // One retry, never a loop.
          return this.#send<T>(method, path, body, false);
        }
      }
      // Control's reason for the 401 (`challenge_expired`, `device_revoked`,
      // …), which is what tells a refusal of the key from a challenge that
      // simply went stale.
      const reason = await reasonOf(response);
      // Only a request that may re-authenticate can conclude the enrollment
      // is gone; the proof's own primitives (`#requestNoReauth`) must never
      // tear down the token they exist to renew.
      if (sentToken !== null && allowReauth) {
        this.setToken(null);
        this.#onUnauthorized?.();
      }
      throw new ControlError(401, reason, method, path);
    }
    if (!response.ok) {
      let code: string | null = null;
      let detail: string | undefined;
      try {
        const parsed = (await response.json()) as { error?: unknown; explanation?: unknown };
        if (typeof parsed.error === "string") code = parsed.error;
        if (typeof parsed.explanation === "string") detail = parsed.explanation;
      } catch {
        // A non-JSON error body: the status is enough.
      }
      throw new ControlError(response.status, code, method, path, detail);
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (text === "") return undefined as T;
    return JSON.parse(text) as T;
  }
}

function channelRow(raw: Record<string, unknown>): ControlChannel {
  const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
  return {
    linkId: str(raw["linkId"]) ?? str(raw["id"]) ?? "",
    name: str(raw["name"]) ?? "",
    spaceId: str(raw["spaceId"]) ?? "",
    outboundUrl: str(raw["outboundUrl"]),
    createdAt: str(raw["createdAt"]),
    revokedAt: str(raw["revokedAt"]),
  };
}

/** Control's stated reason for a 401 (`{error, reason}`), or a bare "unauthorized". */
async function reasonOf(response: Response): Promise<string> {
  try {
    const parsed = (await response.json()) as { error?: unknown; reason?: unknown };
    if (typeof parsed.reason === "string" && parsed.reason !== "") return parsed.reason;
    if (typeof parsed.error === "string" && parsed.error !== "") return parsed.error;
  } catch {
    // A non-JSON 401 body: the status is enough.
  }
  return "unauthorized";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
