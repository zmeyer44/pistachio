/**
 * Typed fetch wrapper over every control route the runner calls
 * (docs/cloud-sync-design.md §7.3): the `/internal/*` family with the
 * service bearer, the public device-auth routes, and the handful of device
 * bearer routes a cloud device is allowed to call. Every call has a 10 s
 * timeout (the command long-poll gets its wait on top); `fetch` is injected
 * so tests run against an in-process fake.
 */

import type { HostedRunRecord as RuntimeHostedRunRecord } from "@pistachio/runtime";
import type {
  AgentAttachment,
  AgentQuestion,
  CredentialAutocomplete,
  DurablePause,
  IntegrationConnection,
  IntegrationConnectionStatus,
  IntegrationProviderConfig,
  RunControlEvent,
  RunEventInput,
  StoredRunEvent,
  TaskStatus,
  ThreadListItem,
  VaultEntry,
  VaultEntryField,
} from "@pistachio/protocol";

export const CONTROL_TIMEOUT_MS = 10_000;
const IMESSAGE_LINK_CACHE_MS = 30_000;
const MAX_IMESSAGE_LINK_CACHE_ENTRIES = 1_024;

export class ControlError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly method: string,
    readonly path: string,
  ) {
    super(`control: ${String(status)}${code === null ? "" : ` ${code}`} (${method} ${path})`);
    this.name = "ControlError";
  }
}

/**
 * The kinds of device control knows (control's `DevicePlatform`). `web` is
 * here because the account web app watches live views too (§8.5) — it
 * introspects like any other device.
 */
export type DevicePlatform = "macos" | "web" | "cloud";

export interface ControlDevice {
  id: string;
  name: string;
  platform: DevicePlatform;
  /** base64 raw 32 B Ed25519 public key. */
  devicePublicKey: string;
  /** base64 raw 32 B X25519 public key. */
  agreementPublicKey: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export interface TokenResponse {
  token: string;
  /** Epoch seconds. */
  exp: number;
}

export interface WrapperRow {
  spaceId: string;
  kind: string;
  credentialId: string;
  salt: string;
  wrapped: string;
  senderDeviceId: string | null;
  signature: string | null;
  createdAt: string;
}

/**
 * A browser session as control describes it on the wire
 * (docs/web-browser-design.md §4.2). The lease token is not part of it: it
 * reaches only the worker that claimed the session.
 */
export interface BrowserSessionView {
  id: string;
  spaceId: string;
  state: "ready" | "live" | "suspended" | "ended";
  control: { holder: "human" | "agent"; generation: number };
  activeRunId: string | null;
  worker: { id: string; until: string } | null;
  lastAttachedAt: string | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

/** What spending a shell socket ticket tells the worker (§6.4). */
export interface SessionTicketRedemption {
  userId: string;
  deviceId: string;
  platform: DevicePlatform;
  spaceId: string;
  /** The worker holding the session, or null when nobody does — then claim it here. */
  workerUrl: string | null;
}

/** A claim (or a renewal) of a session's lease. */
export interface ClaimedSession {
  session: BrowserSessionView;
  leaseToken: string;
}

/**
 * Where a session is, for a worker that has to decide between claiming it and
 * relaying to whoever holds it (§6.4).
 */
export interface SessionPlacement {
  session: BrowserSessionView;
  /** The holder's private address while its lease is live; null otherwise. */
  workerUrl: string | null;
}

/** Why control refused a session claim, in the words §4.3 gives them. */
export type SessionClaimRefusal = "held_elsewhere" | "session_ended" | "not_found";

/** The commands the shell's console can issue on a run of its session (§8). */
export type SessionRunCommand =
  | "message"
  | "answer"
  | "interrupt"
  | "release"
  | "revoke"
  | "approve"
  | "reject";

/** What starting a run in a session answers: the run, and its first event. */
export interface SessionRunStarted {
  runId: string;
  at: string;
  /** `[{t:'run.created', run}]` — the control-class projection, ready to fold. */
  events: RunControlEvent[];
}

/** What a command answers: the run's new status and the events it appended. */
export interface SessionRunTransition {
  ok: true;
  status: TaskStatus;
  seqs: number[];
  at: string;
  events: RunControlEvent[];
}

/** The session's Space's threads, control-class, with any sealed whole-thread snapshot. */
export interface SessionRunList {
  runs: ThreadListItem[];
  threads: Array<{ runId: string; spaceId: string; sealed: string }>;
}

/** What spending a live ticket tells the runner (§8.5). */
export interface LiveTicketRedemption {
  userId: string;
  deviceId: string;
  platform: DevicePlatform;
  spaceId: string;
  /** The worker holding the run, or null when nothing holds it. */
  workerUrl: string | null;
}

export interface Introspection {
  userId: string;
  deviceId: string | null;
  platform: DevicePlatform | null;
}

export interface DeviceLookup {
  userId: string;
  platform: DevicePlatform;
  revokedAt: string | null;
}

export interface EgressCredential {
  username: string;
  password: string;
  expiresAt: string;
  credentialId: string;
}

export interface EgressGateway {
  host: string;
  port: number;
}

export interface MeResponse {
  userId: string;
  email: string;
  hubUrl: string;
  cloudBrowserUrl: string | null;
  /** The browser app's public address (docs/web-browser-design.md §15). */
  browserUrl: string;
  egress: EgressGateway | null;
  /** `'sync'`, `'cloud-browser'`, `'egress'` as control enables them. */
  features: string[];
}

export interface EnrollCloudDeviceBody {
  userId: string;
  nonce: string;
  deviceId: string;
  devicePublicKey: string;
  agreementPublicKey: string;
  challenge: string;
  signature: string;
}

/**
 * The hosted run record as `POST /internal/runs/claim` returns it, narrowed
 * to the fields the runner reads. Picked from the runtime's own type so a
 * renamed or retyped field fails here instead of silently drifting.
 */
export type HostedRunRecord = Pick<
  RuntimeHostedRunRecord,
  | "id"
  | "taskId"
  | "sponsorId"
  | "userId"
  | "spaceId"
  | "purpose"
  | "intent"
  | "attachments"
  | "origin"
  | "executor"
  | "startUrl"
  | "sessionId"
  | "status"
  | "revision"
  | "createdAt"
  | "updatedAt"
  | "completedAt"
>;

export interface ClaimedRunResponse {
  run: HostedRunRecord;
  leaseToken: string;
  /** The last encrypted execution checkpoint, if this is a resumed claim. */
  thread: SealedThread | null;
  /**
   * The browser session the run attached to, claimed in the same transaction
   * (§4.3): after this answer THIS worker holds the session's lease too, and
   * is the one that must heartbeat and release it. `generation` is the fence
   * control moved to `agent` in the same transaction, so the host can raise
   * its own without waiting a heartbeat to hear what already happened.
   */
  session?: { id: string; leaseToken: string; generation: number };
}

export interface CommandsResponse {
  events: StoredRunEvent[];
  since: number;
}

export interface SealedThread {
  spaceId: string;
  sealed: string;
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

export interface CredentialCaptureView {
  id: string;
  runId: string;
  siteName: string;
  siteOrigin: string;
  encryptionPublicKey: string;
  fields: Array<{
    id: string;
    label: string;
    type: "text" | "email" | "password" | "otp";
    autocomplete?: CredentialAutocomplete;
  }>;
  expiresAt: string;
  status: "pending" | "submitted" | "consumed" | "expired";
}

export interface ConsumedCredentialCapture {
  sealedPayload: string;
  tabId: string;
  siteName: string;
  siteOrigin: string;
  fields: Array<{
    id: string;
    target: string;
    label: string;
    type: "text" | "email" | "password" | "otp";
    autocomplete?: CredentialAutocomplete;
  }>;
}

export interface SaveVaultEntryInput {
  leaseToken: string;
  id: string;
  siteOrigin: string;
  siteName: string;
  fields: VaultEntryField[];
  sealedPayload: string;
}

export interface ControlClientOptions {
  baseUrl: string;
  serviceToken: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * The header a session lease travels in on a route that has no body.
 *
 * NEVER a query parameter: the lease authorises starting, steering, revoking
 * and reading every run in that person's Space, and control logs `url.search`
 * on every request — so a lease in the query string is a lease in the clear in
 * the log of every thread-list refresh and every replay.
 */
export const SESSION_LEASE_HEADER = "x-pistachio-session-lease";

interface RequestOptions {
  bearer: string | null;
  /** Extra request headers (the session lease on a GET). */
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /** Aborts the request early (the command long-poll when its run ends). */
  signal?: AbortSignal;
}

export class ControlClient {
  readonly baseUrl: string;
  readonly #serviceToken: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #imessageLinks = new Map<string, { expiresAt: number; value: Promise<boolean> }>();

  constructor(options: ControlClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/u, "");
    this.#serviceToken = options.serviceToken;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? CONTROL_TIMEOUT_MS;
  }

  /* ------------------------------ service bearer ------------------------------ */

  async enrollCloudDevice(body: EnrollCloudDeviceBody): Promise<ControlDevice> {
    const out = await this.#json<{ device: ControlDevice }>("POST", "/v1/internal/cloud/devices/enroll", {
      bearer: this.#serviceToken,
      body,
    });
    return out.device;
  }

  /** Null when the token is not accepted (401). */
  async introspect(token: string): Promise<Introspection | null> {
    return this.#optional<Introspection>("POST", "/v1/internal/auth/introspect", {
      bearer: this.#serviceToken,
      body: { token },
    }, [401]);
  }

  /** Null when the device does not exist (404). */
  async getDevice(deviceId: string): Promise<DeviceLookup | null> {
    return this.#optional<DeviceLookup>("GET", `/v1/internal/devices/${encodeURIComponent(deviceId)}`, {
      bearer: this.#serviceToken,
    }, [404]);
  }

  /** Null when nothing is claimable (204). */
  /**
   * `workerUrl` is this worker's own address ON THE PRIVATE NETWORK, recorded
   * on the lease so a live view arriving at any worker can be handed to the
   * one whose memory the run lives in (§8.5). Never a public address: the
   * fleet has one of those, in front of all of them.
   */
  /* --------------------------- browser sessions (§4.3) --------------------------- */

  /**
   * Take (or renew) a session's lease for this worker. A session is claimed
   * ON DEMAND — when a shell ticket lands here (§6.4) — so a session
   * suspended on one worker comes back on whichever worker the next viewer
   * reaches. Answers a refusal instead of throwing for the three outcomes a
   * caller must act on: another worker holds it, it has ended, it is gone.
   */
  async claimSession(
    sessionId: string,
    workerId: string,
    workerUrl?: string | null,
  ): Promise<ClaimedSession | { refused: SessionClaimRefusal }> {
    try {
      return await this.#json<ClaimedSession>(
        "POST",
        `/v1/internal/browser-sessions/${encodeURIComponent(sessionId)}/claim`,
        {
          bearer: this.#serviceToken,
          body: { workerId, ...(workerUrl == null || workerUrl === "" ? {} : { workerUrl }) },
        },
      );
    } catch (error) {
      const refusal = sessionRefusal(error);
      if (refusal === null) throw error;
      return { refused: refusal };
    }
  }

  /**
   * Renew the lease. `false` means control no longer accepts it — the session
   * moved to another worker or ended — and every viewer here has to go.
   */
  async heartbeatSession(sessionId: string, leaseToken: string): Promise<BrowserSessionView | null> {
    const out = await this.#optional<{ session: BrowserSessionView }>(
      "POST",
      `/v1/internal/browser-sessions/${encodeURIComponent(sessionId)}/heartbeat`,
      { bearer: this.#serviceToken, body: { leaseToken } },
      [404, 409, 410],
    );
    return out?.session ?? null;
  }

  /**
   * Read a session as the fleet sees it: its state, and which worker holds
   * it right now (§6.4). This is what turns a lost claim race into a relay
   * rather than a refusal — without it the worker can only answer `409` and
   * make the client dial again with a fresh ticket.
   */
  async readSession(sessionId: string): Promise<SessionPlacement | null> {
    return this.#optional<SessionPlacement>(
      "GET",
      `/v1/internal/browser-sessions/${encodeURIComponent(sessionId)}`,
      { bearer: this.#serviceToken },
      [404],
    );
  }

  /** Let go of a suspended session (idle, §6.4). Ending one stays the person's decision. */
  async releaseSession(sessionId: string, leaseToken: string): Promise<void> {
    await this.#request("POST", `/v1/internal/browser-sessions/${encodeURIComponent(sessionId)}/release`, {
      bearer: this.#serviceToken,
      body: { leaseToken, state: "suspended" },
    });
  }

  /* ------------------ the session's runs (web-browser-design.md §8) ------------------ */

  /**
   * A run started from the shell, on the session's own tabs. Control forbids
   * a `cloud` device from `POST /runs`, so what authorises this is the
   * service bearer plus the session's lease — which this worker only holds
   * because control handed it the session, which a viewer only reached by
   * proving that Space's key. `viewerDeviceId` is the audit actor.
   */
  async startSessionRun(
    sessionId: string,
    input: {
      leaseToken: string;
      viewerDeviceId: string;
      intent: string;
      attachments?: AgentAttachment[];
      startUrl?: string;
    },
  ): Promise<SessionRunStarted> {
    return this.#json<SessionRunStarted>(
      "POST",
      `/v1/internal/browser-sessions/${encodeURIComponent(sessionId)}/runs`,
      { bearer: this.#serviceToken, body: input },
    );
  }

  /**
   * One of the person's commands on a run of this session. The answer carries
   * the events control appended, so the host folds the transition — and the
   * control generation it moved — without waiting to be told again.
   */
  async sessionRunCommand(
    sessionId: string,
    runId: string,
    command: SessionRunCommand,
    input: {
      leaseToken: string;
      viewerDeviceId: string;
      text?: string;
      attachments?: AgentAttachment[];
      questionId?: string;
      value?: string;
      approvalId?: string;
    },
  ): Promise<SessionRunTransition> {
    return this.#json<SessionRunTransition>(
      "POST",
      `/v1/internal/browser-sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/${command}`,
      { bearer: this.#serviceToken, body: input },
    );
  }

  /** The session's Space's threads, and the sealed snapshots a desktop run mirrored. */
  async listSessionRuns(sessionId: string, leaseToken: string): Promise<SessionRunList> {
    return this.#json<SessionRunList>(
      "GET",
      `/v1/internal/browser-sessions/${encodeURIComponent(sessionId)}/runs`,
      { bearer: this.#serviceToken, headers: { [SESSION_LEASE_HEADER]: leaseToken } },
    );
  }

  /**
   * One run's stored events, for reopening a conversation the cloud drove: a
   * cloud run's sealed `thread` is the runner's execution checkpoint, not a
   * `RunSummary`, so a thread is rebuilt by replaying and folding the stream
   * — the desktop's own path, without the SSE a `cloud` device may not
   * subscribe to.
   */
  async listSessionRunEvents(
    sessionId: string,
    runId: string,
    leaseToken: string,
    since = 0,
  ): Promise<StoredRunEvent[]> {
    const query = `?since=${encodeURIComponent(String(since))}`;
    const out = await this.#json<{ events: StoredRunEvent[] }>(
      "GET",
      `/v1/internal/browser-sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/events${query}`,
      { bearer: this.#serviceToken, headers: { [SESSION_LEASE_HEADER]: leaseToken } },
    );
    return out.events;
  }

  /**
   * Forget a conversation (§11's `deleteThread`). Control hides the run from
   * the session's list; the events stay for the audit trail, because a person
   * clearing their console is not an account deleting its history.
   */
  async deleteSessionRun(
    sessionId: string,
    runId: string,
    actor: { leaseToken: string; viewerDeviceId: string },
  ): Promise<void> {
    await this.#request(
      "DELETE",
      `/v1/internal/browser-sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}`,
      { bearer: this.#serviceToken, body: actor },
    );
  }

  /**
   * Spend a shell socket ticket (§5). As with a live ticket, the single
   * `DELETE … RETURNING` behind this IS the authentication, and the answer
   * both names the viewer and says which worker (if any) holds the session.
   */
  async redeemSessionTicket(ticket: string, sessionId: string): Promise<SessionTicketRedemption | null> {
    return this.#optional<SessionTicketRedemption>("POST", "/v1/internal/session-tickets/redeem", {
      bearer: this.#serviceToken,
      body: { ticket, sessionId },
    }, [401, 404]);
  }

  /**
   * Spend a live view ticket (§8.5). One round trip answers both questions a
   * live upgrade asks: who is this, and which worker holds the run. Null when
   * the ticket is unknown, expired, already spent, or the device is revoked.
   */
  async redeemLiveTicket(ticket: string, runId: string): Promise<LiveTicketRedemption | null> {
    return this.#optional<LiveTicketRedemption>("POST", "/v1/internal/live-tickets/redeem", {
      bearer: this.#serviceToken,
      body: { ticket, runId },
    }, [401, 404]);
  }

  async claimRun(workerId: string, workerUrl?: string | null): Promise<ClaimedRunResponse | null> {
    return this.#optional<ClaimedRunResponse>("POST", "/v1/internal/runs/claim", {
      bearer: this.#serviceToken,
      body: { workerId, ...(workerUrl == null || workerUrl === "" ? {} : { workerUrl }) },
    }, []);
  }

  async heartbeat(runId: string, leaseToken: string): Promise<void> {
    await this.#request("POST", `/v1/internal/runs/${encodeURIComponent(runId)}/heartbeat`, {
      bearer: this.#serviceToken,
      body: { leaseToken },
    });
  }

  async createCredentialCapture(
    runId: string,
    input: {
      leaseToken: string;
      tabId: string;
      siteName: string;
      siteOrigin: string;
      fields: Array<{
        label: string;
        type: "text" | "email" | "password" | "otp";
        target: string;
        autocomplete?: CredentialAutocomplete;
      }>;
    },
  ): Promise<CredentialCaptureView> {
    const out = await this.#json<{ capture: CredentialCaptureView }>(
      "POST",
      `/v1/internal/runs/${encodeURIComponent(runId)}/credential-captures`,
      { bearer: this.#serviceToken, body: input },
    );
    return out.capture;
  }

  async consumeCredentialCapture(
    runId: string,
    captureId: string,
    leaseToken: string,
  ): Promise<ConsumedCredentialCapture> {
    return this.#json<ConsumedCredentialCapture>(
      "POST",
      `/v1/internal/runs/${encodeURIComponent(runId)}/credential-captures/${encodeURIComponent(captureId)}/consume`,
      { bearer: this.#serviceToken, body: { leaseToken } },
    );
  }

  /** The run's Space's vault entries for one site origin, ciphertext included. */
  async lookupVault(runId: string, leaseToken: string, siteOrigin: string): Promise<VaultEntry[]> {
    const out = await this.#json<{ entries: VaultEntry[] }>(
      "POST",
      `/v1/internal/runs/${encodeURIComponent(runId)}/vault/lookup`,
      { bearer: this.#serviceToken, body: { leaseToken, siteOrigin } },
    );
    return out.entries;
  }

  async saveVaultEntry(runId: string, input: SaveVaultEntryInput): Promise<{ entry: VaultEntry; replaced: number }> {
    return this.#json<{ entry: VaultEntry; replaced: number }>(
      "POST",
      `/v1/internal/runs/${encodeURIComponent(runId)}/vault/entries`,
      { bearer: this.#serviceToken, body: input },
    );
  }

  async markVaultEntryUsed(runId: string, entryId: string, leaseToken: string): Promise<void> {
    await this.#request(
      "POST",
      `/v1/internal/runs/${encodeURIComponent(runId)}/vault/entries/${encodeURIComponent(entryId)}/used`,
      { bearer: this.#serviceToken, body: { leaseToken } },
    );
  }

  /* ------------------------------ integrations (D29) ------------------------------ */

  /** The OAuth clients control was configured with; a provider absent here is not connectable. */
  async listIntegrationProviders(): Promise<IntegrationProviderConfig[]> {
    const out = await this.#json<{ providers: IntegrationProviderConfig[] }>("GET", "/v1/internal/integrations/providers", {
      bearer: this.#serviceToken,
    });
    return out.providers;
  }

  /** The run's Space's connected integrations, ciphertext included. */
  async lookupIntegrations(runId: string, leaseToken: string): Promise<IntegrationConnection[]> {
    const out = await this.#json<{ connections: IntegrationConnection[] }>(
      "POST",
      `/v1/internal/runs/${encodeURIComponent(runId)}/integrations/lookup`,
      { bearer: this.#serviceToken, body: { leaseToken } },
    );
    return out.connections;
  }

  async markIntegrationUsed(runId: string, connectionId: string, leaseToken: string): Promise<void> {
    await this.#request(
      "POST",
      `/v1/internal/runs/${encodeURIComponent(runId)}/integrations/${encodeURIComponent(connectionId)}/used`,
      { bearer: this.#serviceToken, body: { leaseToken } },
    );
  }

  /** The provider refused the grant for good: control marks the row so Settings asks for a reconnect. Exact id; 404 when the row is gone. */
  async setIntegrationStatus(runId: string, connectionId: string, leaseToken: string, status: Extract<IntegrationConnectionStatus, "reconnect_required">): Promise<void> {
    await this.#request(
      "POST",
      `/v1/internal/runs/${encodeURIComponent(runId)}/integrations/${encodeURIComponent(connectionId)}/status`,
      { bearer: this.#serviceToken, body: { leaseToken, status } },
    );
  }

  /** This device revoked a tombstoned grant at the provider; control drops the row. */
  async deleteRevokedIntegration(runId: string, connectionId: string, leaseToken: string): Promise<void> {
    await this.#request(
      "POST",
      `/v1/internal/runs/${encodeURIComponent(runId)}/integrations/${encodeURIComponent(connectionId)}/revoked`,
      { bearer: this.#serviceToken, body: { leaseToken } },
    );
  }

  async appendEvents(runId: string, leaseToken: string, events: RunEventInput[]): Promise<{ seqs: number[] }> {
    return this.#json<{ seqs: number[] }>("POST", `/v1/internal/runs/${encodeURIComponent(runId)}/events`, {
      bearer: this.#serviceToken,
      body: { leaseToken, events },
    });
  }

  async pauseRun(
    runId: string,
    leaseToken: string,
    pause: DurablePause,
    events?: RunEventInput[],
    imessageQuestion?: AgentQuestion,
    imessageCredentialCapture?: { captureId: string },
  ): Promise<void> {
    await this.#request("POST", `/v1/internal/runs/${encodeURIComponent(runId)}/pause`, {
      bearer: this.#serviceToken,
      body: {
        leaseToken,
        pause,
        ...(events === undefined ? {} : { events }),
        ...(imessageQuestion === undefined ? {} : { imessageQuestion }),
        ...(imessageCredentialCapture === undefined ? {} : { imessageCredentialCapture }),
      },
    });
  }

  async completeRun(
    runId: string,
    leaseToken: string,
    events?: RunEventInput[],
    imessageCompletion?: { text: string; completionId: string },
  ): Promise<void> {
    await this.#request("POST", `/v1/internal/runs/${encodeURIComponent(runId)}/complete`, {
      bearer: this.#serviceToken,
      body: {
        leaseToken,
        ...(events === undefined ? {} : { events }),
        ...(imessageCompletion === undefined ? {} : { imessageCompletion }),
      },
    });
  }

  async imessageLinked(userId: string): Promise<boolean> {
    const cached = this.#imessageLinks.get(userId);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value;
    if (this.#imessageLinks.size >= MAX_IMESSAGE_LINK_CACHE_ENTRIES) this.#imessageLinks.clear();
    const value = this.#json<{ available: boolean; linked: boolean }>(
      "GET",
      `/v1/internal/users/${encodeURIComponent(userId)}/imessage-link`,
      { bearer: this.#serviceToken },
    ).then((out) => out.available && out.linked);
    this.#imessageLinks.set(userId, { expiresAt: Date.now() + IMESSAGE_LINK_CACHE_MS, value });
    try {
      return await value;
    } catch (error) {
      if (this.#imessageLinks.get(userId)?.value === value) this.#imessageLinks.delete(userId);
      throw error;
    }
  }

  async failRun(runId: string, leaseToken: string, reason: string, events?: RunEventInput[]): Promise<void> {
    await this.#request("POST", `/v1/internal/runs/${encodeURIComponent(runId)}/fail`, {
      bearer: this.#serviceToken,
      body: { leaseToken, reason, ...(events === undefined ? {} : { events }) },
    });
  }

  async putThread(runId: string, leaseToken: string, thread: SealedThread): Promise<void> {
    await this.#request("PUT", `/v1/internal/runs/${encodeURIComponent(runId)}/thread`, {
      bearer: this.#serviceToken,
      body: { leaseToken, thread },
    });
  }

  /**
   * Long-poll: returns immediately when non-empty, else after `waitSeconds`
   * with `[]`. `signal` cuts the wait short (the run ended).
   */
  async pollCommands(runId: string, since: number, waitSeconds: number, signal?: AbortSignal): Promise<CommandsResponse> {
    const query = `?since=${encodeURIComponent(String(since))}&wait=${encodeURIComponent(String(waitSeconds))}`;
    return this.#json<CommandsResponse>("GET", `/v1/internal/runs/${encodeURIComponent(runId)}/commands${query}`, {
      bearer: this.#serviceToken,
      timeoutMs: this.#timeoutMs + waitSeconds * 1000,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /** The runner is shutting down mid-run: control marks it `interrupted` (reopened by the next message). */
  async interruptRun(runId: string, leaseToken: string, events?: RunEventInput[]): Promise<void> {
    await this.#request("POST", `/v1/internal/runs/${encodeURIComponent(runId)}/interrupt`, {
      bearer: this.#serviceToken,
      body: { leaseToken, ...(events === undefined ? {} : { events }) },
    });
  }

  /**
   * The egress credential for one holder of a Space's browser: a run, or the
   * persistent browser session itself (§4.3). Exactly one of the two, because
   * control revokes by whichever id minted it — a session's credential dies
   * with the session, a run's with the run.
   */
  async egressCredential(
    userId: string,
    deviceId: string,
    holder: { runId: string } | { sessionId: string },
  ): Promise<EgressCredential> {
    const scope =
      "runId" in holder
        ? `runId=${encodeURIComponent(holder.runId)}`
        : `sessionId=${encodeURIComponent(holder.sessionId)}`;
    const query = `?deviceId=${encodeURIComponent(deviceId)}&${scope}`;
    return this.#json<EgressCredential>("GET", `/v1/internal/users/${encodeURIComponent(userId)}/egress-credential${query}`, {
      bearer: this.#serviceToken,
    });
  }

  /** Hosting state only; no private HTML crosses this lookup. */
  async artifactPublishing(userId: string, artifactId: string): Promise<HostedArtifact | null> {
    const out = await this.#optional<{ artifact: HostedArtifact }>(
      "GET",
      `/v1/internal/users/${encodeURIComponent(userId)}/artifacts/${encodeURIComponent(artifactId)}`,
      { bearer: this.#serviceToken },
      [404],
    );
    return out?.artifact ?? null;
  }

  async putArtifactRevision(
    userId: string,
    artifactId: string,
    input: { revision: number; html: string },
  ): Promise<boolean> {
    const out = await this.#json<{ published: boolean }>(
      "PUT",
      `/v1/internal/users/${encodeURIComponent(userId)}/artifacts/${encodeURIComponent(artifactId)}/revision`,
      { bearer: this.#serviceToken, body: input },
    );
    return out.published;
  }

  /* ------------------------------ public routes ------------------------------ */

  async deviceChallenge(deviceId: string): Promise<string> {
    const out = await this.#json<{ challenge: string }>("POST", "/v1/auth/device-challenge", {
      bearer: null,
      body: { deviceId },
    });
    return out.challenge;
  }

  async deviceLogin(deviceId: string, challenge: string, signature: string): Promise<TokenResponse> {
    return this.#json<TokenResponse>("POST", "/v1/auth/device-login", {
      bearer: null,
      body: { deviceId, challenge, signature },
    });
  }

  async refreshToken(token: string): Promise<TokenResponse> {
    return this.#json<TokenResponse>("POST", "/v1/auth/token/refresh", { bearer: token, body: {} });
  }

  /* ------------------------------ device bearer ------------------------------ */

  async me(token: string): Promise<MeResponse> {
    return this.#json<MeResponse>("GET", "/v1/me", { bearer: token });
  }

  async listDevices(token: string): Promise<ControlDevice[]> {
    const out = await this.#json<{ devices: ControlDevice[] }>("GET", "/v1/devices", { bearer: token });
    return out.devices;
  }

  async listWrappers(token: string, spaceId: string): Promise<WrapperRow[]> {
    const out = await this.#json<{ wrappers: WrapperRow[] }>("GET", `/v1/spaces/${encodeURIComponent(spaceId)}/wrappers`, {
      bearer: token,
    });
    return out.wrappers;
  }

  /* ------------------------------ internals ------------------------------ */

  async #json<T>(method: string, path: string, options: RequestOptions): Promise<T> {
    const response = await this.#request(method, path, options);
    return (await response.json()) as T;
  }

  /** Like `#json`, but a status in `nullStatuses` (or a 204) resolves null. */
  async #optional<T>(method: string, path: string, options: RequestOptions, nullStatuses: number[]): Promise<T | null> {
    const response = await this.#send(method, path, options);
    if (response.status === 204 || nullStatuses.includes(response.status)) return null;
    if (!response.ok) throw await controlError(response, method, path);
    return (await response.json()) as T;
  }

  async #request(method: string, path: string, options: RequestOptions): Promise<Response> {
    const response = await this.#send(method, path, options);
    if (!response.ok) throw await controlError(response, method, path);
    return response;
  }

  async #send(method: string, path: string, options: RequestOptions): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json", ...options.headers };
    if (options.bearer !== null) headers["authorization"] = `Bearer ${options.bearer}`;
    if (options.body !== undefined) headers["content-type"] = "application/json";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("control request timed out")), options.timeoutMs ?? this.#timeoutMs);
    timer.unref();
    const outer = options.signal;
    const onOuterAbort = (): void => controller.abort(outer?.reason instanceof Error ? outer.reason : new Error("control request aborted"));
    if (outer !== undefined) {
      if (outer.aborted) onOuterAbort();
      else outer.addEventListener("abort", onOuterAbort, { once: true });
    }
    try {
      return await this.#fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: options.body === undefined ? null : JSON.stringify(options.body),
        signal: controller.signal,
        redirect: "error",
      });
    } catch (error) {
      throw new Error(`control plane unreachable at ${this.baseUrl} (${method} ${path}): ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuterAbort);
    }
  }
}

async function controlError(response: Response, method: string, path: string): Promise<ControlError> {
  let code: string | null = null;
  try {
    const parsed = (await response.json()) as { error?: unknown };
    if (typeof parsed.error === "string") code = parsed.error;
  } catch {
    // A non-JSON error body: the status alone is the message.
  }
  return new ControlError(response.status, code, method, path);
}

/**
 * True for the control statuses that mean "this device is no longer valid"
 * (§8.2): 401 and 410 always; `also` widens it where a path treats a
 * forbidden or missing device the same way.
 */
/** The refusal codes `POST /internal/browser-sessions/:id/claim` answers with. */
function sessionRefusal(error: unknown): SessionClaimRefusal | null {
  if (!(error instanceof ControlError)) return null;
  if (error.status === 409) return "held_elsewhere";
  if (error.status === 410) return "session_ended";
  if (error.status === 404) return "not_found";
  return null;
}

export function isDeviceRejection(error: unknown, also: readonly number[] = []): boolean {
  return error instanceof ControlError && (error.status === 401 || error.status === 410 || also.includes(error.status));
}
