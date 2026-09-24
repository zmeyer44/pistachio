/**
 * Control-plane HTTP API (docs/cloud-sync-design.md §7). Hono app factory;
 * the database handle is injected so tests run the same app against PGlite.
 *
 * Route families never cross (§7.2): `/v1/internal/*` accepts only the
 * cloud-browser service token; the gateway routes only the egress gateway
 * token; channel ingress and credential-capture URLs are narrow bearer
 * capabilities; everything else only accepts device/bootstrap JWTs, with the
 * bootstrap allowlist and cloud-device gate applied before any handler runs.
 */

import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import type { Server as HttpServer } from "node:http";
import { createHash, createHmac, randomBytes, randomInt, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { z } from "zod";
import { APIError } from "better-auth/api";
import {
  DEVICE_TOKEN_TTL_SECONDS,
  HOSTED_CHECKOUT_RULES,
  MEDIA_BYPASS_DOMAINS,
  SEEDED_HOSTILE_DOMAINS,
  SEED_CORPUS,
  WORKSPACE_PSEUDO_SPACE_ID,
  deviceLoginSigningBytes,
  deviceWrapperSigningBytes,
  fromBase64,
  importPublicKeyRaw,
  signDeviceToken,
  verifyDeviceToken,
} from "@pistachio/sync-protocol";
import type { HubHost } from "@pistachio/sync-hub";
import {
  HostedRunCoordinator,
  type HostedRunRecord,
  type RunEventSink,
} from "@pistachio/runtime";
import { CREDENTIAL_AUTOCOMPLETE_VALUES, CREDENTIAL_FIELD_TYPES, INTEGRATION_ACCESS_LEVELS, INTEGRATION_PROVIDERS, MAX_INTEGRATION_ACCOUNT_LABEL, MAX_INTEGRATION_PAYLOAD_BYTES, MAX_INTEGRATION_SCOPES, MAX_VAULT_ENTRY_FIELDS, TASK_STATUSES, integrationScopesCover, isVaultStorableField, vaultEntrySuperseded, type AgentAttachment, type AgentQuestion, type IMessageRoutingEvent, type IMessageThreadRouteRequest, type IntegrationConnection, type IntegrationProviderConfig, type RunEvent, type RunEventInput, type RunOrigin, type StoredRunEvent, type ThreadListItem, type VaultEntry } from "@pistachio/protocol";
import type { NotificationDispatcher } from "@pistachio/notifications";
import { aiProxyHandler } from "./ai-proxy.js";
import { AI_BUDGET_EXCEEDED, AI_USAGE_RETENTION_DAYS, aiAllowanceReached, aiCapReached, aiUsageSummary, parseMonthlyCap, recordAiUsage, setAiMonthlyCap } from "./ai-usage.js";
import {
  ACCOUNT_LINK_RETENTION_MS,
  ACCOUNT_REQUIRED,
  ANONYMOUS_BUDGET_EXCEEDED,
  ANONYMOUS_RATE_LIMITED,
  ANONYMOUS_RETENTION_MS,
  AnonymousAiLimiter,
  anonymousAiPolicy,
  anonymousAllowed,
  anonymousSignupLimiter,
} from "./anonymous.js";
import { authenticateToken, bearerService, bearerToken, secretEquals, UUID_RE } from "./auth.js";
import {
  PASSWORD_RESET_REQUEST_LIMIT,
  PasswordAttemptLimiter,
  channelInboundLimiter,
} from "./abuse.js";
import { CHALLENGE_TTL_MS, ChallengeStore } from "./challenges.js";
import {
  OutboundUrlError,
  createChannelDispatcher,
  notificationFor,
  vetOutboundUrl,
  type LookupFn,
} from "./channels.js";
import type { Db } from "./db/client.js";
import {
  accountLinks,
  aiUsage,
  auditEvents,
  authAccounts,
  authSessions,
  browserSessions,
  channelLinks,
  channelMessages,
  cloudEnrollments,
  credentialCaptures,
  devices,
  egressCredentials,
  egressGateways,
  egressRevocations,
  hostedArtifacts,
  hostedRuns,
  hubKv,
  imessageChallenges,
  imessageInboundMessages,
  imessageLinks,
  imessageOnboardingLinks,
  imessagePendingQuestions,
  integrationConnections,
  keyWrappers,
  liveTickets,
  vaultEntries,
  noteShares,
  notificationOccurrences,
  runEvents,
  runSponsorCommands,
  sessionTickets,
  sharedNotes,
  spaces,
  syncPolicyOverrides,
  users,
  type ControlHolder,
  type DevicePlatform,
  type HostedArtifactKind,
  type NoteShareRole,
} from "./db/schema.js";
import { EGRESS_DISABLED, gatewaySecretFor, mintCredential, CREDENTIAL_TTL_SECONDS, type EgressOptions, type MintedCredential } from "./egress.js";
import type { AppEnv } from "./env.js";
import { bearerGateway } from "./gateway.js";
import { createHubBinding, type HubBinding } from "./hub.js";
import { CREDENTIAL_ISSUER, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, createIdp } from "./idp.js";
import type { SigningKeys } from "./keys-provider.js";
import { MAILER_DISABLED, type MailerOptions } from "./mailer.js";
import {
  BlueBubblesConnector,
  IMESSAGE_ONBOARDING_TTL_MS,
  IMESSAGE_OTP_MAX_ATTEMPTS,
  IMESSAGE_PENDING_QUESTION_TTL_MS,
  IMESSAGE_OTP_TTL_MS,
  blueBubblesOptionsFromEnv,
  maskPhoneNumber,
  normalizePhoneNumber,
  parseIMessageQuestionAnswer,
  type BlueBubblesOptions,
} from "./imessage.js";
import { RunnerResponseError, SteerOutbox, type RunnerClient, type SteerBody } from "./outbox.js";
import {
  PostgresRunEventSink,
  RunEventBus,
  RunEventError,
  TERMINAL_STATUSES,
  controlRunSummary,
  durablePauseSchema,
  isCommandEvent,
  listRunEvents,
  runEventInputSchema,
  type AppendedBatch,
} from "./runs/events.js";
import { ControlAuthorityRevoker } from "./runs/revoker.js";
import { PostgresHostedRunStore, rowToRecord } from "./runs/store.js";
import {
  base64String,
  body,
  param,
  query,
  spaceIdSchema,
  spaceOrWorkspaceIdSchema,
  validate,
  validateParam,
  validateQuery,
} from "./validate.js";

const ED25519_PUBLIC_KEY_BYTES = 32;
const X25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;
const DAY_MS = 86_400_000;
const RUN_EVENT_RETENTION_MS = 30 * DAY_MS;
const NOTIFICATION_RETENTION_MS = 7 * DAY_MS;
const IMESSAGE_INBOUND_RETENTION_MS = 30 * DAY_MS;
const IMESSAGE_ROUTING_MAX_EVENTS = 200;
const IMESSAGE_ROUTING_MAX_BYTES = 384 * 1024;
/** How many of the phone's most recent threads a text is classified against. */
const IMESSAGE_ROUTING_MAX_CANDIDATES = 3;
/** A thread idle for longer is never continued by a text, however it reads. */
const IMESSAGE_ROUTING_MAX_AGE_MS = 7 * DAY_MS;
/**
 * A revoke or rejection is the person's explicit decision to end the run;
 * a text must never restore its authority the way a web follow-up would.
 * A run waiting for a browser step or a capability approval cannot take a
 * message either (`/runs/:id/message` answers 409 there); every other
 * status accepts one.
 */
const IMESSAGE_UNROUTABLE_STATUSES = new Set<string>(["revoked", "rejected", "waiting_for_step_up", "waiting_for_approval"]);
/** Steer bodies above this ride the runner's long-poll instead; its steer cap is 64 KiB. */
const MAX_STEER_BYTES = 56 * 1024;
const MAX_ARTIFACT_HTML_BYTES = 1_500_000;
/**
 * The shared body's ceiling (docs/notes.md N4 `MAX_NOTE_MARKDOWN_BYTES`, N4
 * `MAX_NOTE_TITLE`). Restated here rather than imported, as the artifact cap
 * above is: control depends on no client package, and a cap that drifts
 * upward on a device must not silently widen what the server accepts.
 */
const MAX_NOTE_MARKDOWN_BYTES = 262_144;
const MAX_NOTE_TITLE = 200;
/**
 * Hard ceiling on any request body, enforced before a handler buffers it.
 * Route schemas cap their own fields far lower; this only bounds heap for
 * unauthenticated routes (accounts, credential capture) and the largest
 * legitimate body, a run created with attachments.
 */
const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;
/** Device challenges a single client address may mint per TTL window. */
const DEVICE_CHALLENGES_PER_IP = 120;
/** OTP verifications a user may attempt per OTP window, across challenges. */
const IMESSAGE_VERIFIES_PER_USER = 20;
/**
 * How long a row of `egress_revocations` stays in the feed the gateway
 * drains. 30 days, matching `TOMBSTONE_RETENTION_MS`: a credential lives at
 * most 24 h, so a row this old names something long expired, and the margin
 * covers any plausible gateway downtime. The newest row is never pruned so
 * `min(id)` stays a true floor for the feed's staleness check below.
 */
const EGRESS_REVOCATION_RETENTION_MS = 30 * DAY_MS;
const AI_USAGE_RETENTION_MS = AI_USAGE_RETENTION_DAYS * DAY_MS;
const MAX_THREAD_BYTES = 2 * 1024 * 1024;
const CREDENTIAL_CAPTURE_TTL_MS = 15 * 60 * 1000;
const MAX_CREDENTIAL_PAYLOAD_BYTES = 64 * 1024;
const RUN_LEASE_MS = 30_000;
/**
 * How long a worker's claim on a browser session lasts before maintenance
 * takes it back (web-browser-design.md §4.3). Longer than a run lease: a
 * session is idle most of the time — a person reading a page produces no
 * heartbeat-worthy work — and re-claiming one is expensive (a Chromium
 * context and a restored state doc), so it is renewed at a third of this.
 */
const SESSION_LEASE_MS = 60_000;
/** How long a suspended session is kept before it is ended for good (§4.3). */
const SESSION_RETENTION_MS = 7 * DAY_MS;
const SSE_PING_MS = 15_000;
const MAX_LONG_POLL_SECONDS = 25;
/** Opaque client retry key for sponsor commands; anything else is ignored. */
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** The caller's `Idempotency-Key`, or undefined when absent or malformed. */
function idempotencyKeyOf(c: Context<AppEnv>): string | undefined {
  const raw = c.req.header("Idempotency-Key");
  return raw !== undefined && IDEMPOTENCY_KEY_RE.test(raw) ? raw : undefined;
}

export const DEFAULT_SPACE_ID = "work";
export const DEFAULT_SPACE_NAME = "Operations";
export const WORKSPACE_SPACE_NAME = "Workspace";

/* ------------------------------------------------------------------ *
 * Options
 * ------------------------------------------------------------------ */

export interface CreateAppOptions {
  signing: SigningKeys;
  /** An already-attached (or fake) hub host; otherwise `hub.attach(server)` later. */
  hub?: HubHost;
  /** Cloud-browser runner client; absent ⇒ `/cloud/enable` answers 503. */
  runner?: RunnerClient;
  mailer?: MailerOptions;
  egress?: EgressOptions;
  now?: () => number;
  /**
   * Environment for per-request secrets and public URLs:
   * CLOUD_BROWSER_SERVICE_TOKEN, EGRESS_GATEWAY_TOKEN, AI_GATEWAY_API_KEY,
   * AI_GATEWAY_URL, HUB_PUBLIC_URL,
   * CLOUD_BROWSER_PUBLIC_URL, CONTROL_PUBLIC_URL,
   * PISTACHIO_WEB_URL (`www`: credential-capture and iMessage-onboarding
   * links), PISTACHIO_BROWSER_URL (the browser app, advertised on `/me` so a
   * client can find it; §15),
   * CONTROL_ALLOWED_ORIGINS (both web apps' origins),
   * BETTER_AUTH_SECRET, NODE_ENV.
   */
  env?: Record<string, string | undefined>;
  /** Request log sink (`METHOD /path?query` with `access_token` removed). */
  log?: (line: string) => void;
  channels?: { lookup?: LookupFn; timeoutMs?: number };
  /** BlueBubbles is optional; null explicitly disables environment discovery. */
  imessage?: BlueBubblesOptions | null;
  sse?: { pingMs?: number };
  /** The `/v1/ai/*` model proxy (ai-proxy.ts): an injectable fetch for tests. */
  ai?: { fetchImpl?: typeof fetch; timeoutMs?: number };
}

export interface MaintenanceResult {
  expiredSessions: number;
  /** Browser sessions whose worker lease lapsed (§4.3). */
  suspendedBrowserSessions: number;
  /** Suspended browser sessions past `SESSION_RETENTION_MS`. */
  endedBrowserSessions: number;
  retiredRuns: number;
  prunedNotifications: number;
  prunedRevocations: number;
  /** Model-meter rows past their retention. */
  prunedAiUsage: number;
  /** Anonymous accounts whose Mac stopped calling (src/anonymous.ts). */
  prunedAnonymousAccounts: number;
  /** Paused runs whose deadline passed, swept to a terminal state. */
  expiredPauses: number;
  steersDelivered: number;
  notificationsDelivered: number;
}

export interface ControlApp {
  app: Hono<AppEnv>;
  hub: HubBinding;
  outbox: SteerOutbox;
  bus: RunEventBus;
  dispatcher: NotificationDispatcher;
  /** The hourly job (§7.4): hub gc, session expiry, run-event retention, outbox, notifications. */
  runMaintenance(now?: number): Promise<MaintenanceResult>;
  /** Deliver due channel notifications now; resolves the count delivered. */
  dispatchNotifications(now?: number): Promise<number>;
  /** Settle background work started by requests (tests). */
  idle(): Promise<void>;
}

/* ------------------------------------------------------------------ *
 * Schemas
 * ------------------------------------------------------------------ */

const emailSchema = z.email().max(320);
/** D24: device ids are lowercase uuids everywhere, compared as strings. */
const deviceIdSchema = z.string().regex(UUID_RE);
const passwordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

const signupSchema = z.object({ email: emailSchema, password: passwordSchema });
/** A device token is a compact JWS; 4 KB is far more than one ever is. */
const accountLinkSchema = z.object({ anonymousToken: z.string().min(1).max(4096) });
const aiCapSchema = z.object({ monthlyUsd: z.union([z.string().max(32), z.number(), z.null()]) });
const passwordLoginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: passwordSchema,
});
const passwordResetRequestSchema = z.object({ email: emailSchema });
const passwordResetConfirmSchema = z.object({
  email: emailSchema,
  code: z.string().min(4).max(16),
  password: passwordSchema,
});
const deviceChallengeSchema = z.object({ deviceId: deviceIdSchema });
const deviceLoginSchema = z.object({
  deviceId: deviceIdSchema,
  challenge: z.string().min(1).max(256),
  signature: base64String(ED25519_SIGNATURE_BYTES, 512),
});
/**
 * Platforms a user may enroll through the public route: the desktop app and
 * the browser, both first-class user devices (§7.2). `cloud` is created only
 * by the runner through `POST /internal/cloud/devices/enroll`. The field
 * stays a plain string in the schema so an unsupported value answers 400
 * `platform_not_allowed` rather than a generic `invalid_body`.
 */
const ENROLLABLE_PLATFORMS: ReadonlySet<string> = new Set<DevicePlatform>(["macos", "web"]);

const enrollSchema = z.object({
  deviceId: deviceIdSchema,
  name: z.string().trim().min(1).max(200),
  platform: z.string().min(1).max(64),
  devicePublicKey: base64String(ED25519_PUBLIC_KEY_BYTES, 512),
  agreementPublicKey: base64String(X25519_PUBLIC_KEY_BYTES, 512),
  challenge: z.string().min(1).max(256),
  signature: base64String(ED25519_SIGNATURE_BYTES, 512),
});
const cloudEnrollSchema = z.object({
  userId: z.uuid(),
  nonce: z.string().min(1).max(256),
  deviceId: deviceIdSchema,
  devicePublicKey: base64String(ED25519_PUBLIC_KEY_BYTES, 512),
  agreementPublicKey: base64String(X25519_PUBLIC_KEY_BYTES, 512),
  challenge: z.string().min(1).max(256),
  signature: base64String(ED25519_SIGNATURE_BYTES, 512),
});
const renameDeviceSchema = z.object({ name: z.string().trim().min(1).max(200) });
const idParamSchema = z.object({ id: z.uuid() });
const artifactIdSchema = z.string().regex(/^[a-f0-9]{12}$/u);
const artifactParamSchema = z.object({ artifactId: artifactIdSchema });
const shareParamSchema = z.object({ shareId: z.string().regex(/^[A-Za-z0-9_-]{24}$/u) });
const internalArtifactParamSchema = z.object({ userId: z.uuid(), artifactId: artifactIdSchema });
// A note id is minted by the same generator (docs/notes.md N6), so it is the
// same twelve hex characters an artifact id is.
const noteParamSchema = z.object({ noteId: artifactIdSchema });
const internalNoteParamSchema = z.object({ userId: z.uuid(), noteId: artifactIdSchema });
// Sharing one note with named accounts (docs/notes.md §9).
const noteShareParamSchema = z.object({ noteId: artifactIdSchema, shareId: z.uuid() });
const sharedNoteParamSchema = z.object({ ownerId: z.uuid(), noteId: artifactIdSchema });
const noteShareRoleSchema = z.enum(["viewer", "editor"]);
const noteShareBodySchema = z.object({ email: emailSchema, role: noteShareRoleSchema });
const sharedNoteBodySchema = z.object({
  title: z.string().max(MAX_NOTE_TITLE),
  markdown: z.string().max(MAX_NOTE_MARKDOWN_BYTES),
  revision: z.number().int().positive(),
});
const artifactRevisionSchema = z.object({
  revision: z.number().int().positive(),
  html: z.string().min(1).max(MAX_ARTIFACT_HTML_BYTES),
});
const artifactVisibilitySchema = artifactRevisionSchema.extend({
  visibility: z.enum(["private", "public"]),
  html: z.string().min(1).max(MAX_ARTIFACT_HTML_BYTES).optional(),
}).superRefine((value, ctx) => {
  if (value.visibility === "public" && value.html === undefined) {
    ctx.addIssue({ code: "custom", path: ["html"], message: "public artifacts require html" });
  }
});
const spaceParamSchema = z.object({ id: spaceOrWorkspaceIdSchema });
const spaceBodySchema = z.object({ name: z.string().trim().min(1).max(200) });
const wrapperKindSchema = z.enum([
  "password",
  "recovery-code",
  "device-x25519",
  "passkey-prf",
  "hardware-key",
  "kms",
  "enrollment-code",
]);
const wrapperSchema = z.object({
  kind: wrapperKindSchema,
  credentialId: z.string().min(1).max(512),
  salt: base64String(undefined, 1024).default(""),
  wrapped: base64String(undefined, 16384),
  senderDeviceId: deviceIdSchema.optional(),
  signature: base64String(ED25519_SIGNATURE_BYTES, 512).optional(),
});
const putWrappersSchema = z.object({ wrappers: z.array(wrapperSchema).min(1).max(64) });
const accountProvisionSchema = z.object({
  wrappers: z.array(z.object({
    spaceId: spaceOrWorkspaceIdSchema,
    salt: base64String(undefined, 1024),
    wrapped: base64String(undefined, 16384),
  }).strict()).min(1).max(64),
}).strict().superRefine((value, ctx) => {
  const ids = value.wrappers.map((wrapper) => wrapper.spaceId);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: "custom", path: ["wrappers"], message: "space ids must be unique" });
  }
});
const wrapperParamSchema = z.object({
  id: spaceOrWorkspaceIdSchema,
  kind: wrapperKindSchema,
  credentialId: z.string().min(1).max(512),
});
const overrideParamSchema = z.object({ host: z.string().trim().min(1).max(253) });
const overrideBodySchema = z.object({ mode: z.enum(["sync", "never"]) });
const attachmentSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().max(512),
  mediaType: z.string().max(128),
  url: z.string().max(8 * 1024 * 1024),
});
const runOriginSchema: z.ZodType<RunOrigin> = z.union([
  z.object({
    kind: z.literal("reminder"),
    reminderId: z.string(),
    occurrenceId: z.string(),
    title: z.string(),
    scheduledFor: z.string(),
  }),
  z.object({
    kind: z.literal("channel"),
    linkId: z.string(),
    deliveryId: z.string(),
    channelName: z.string(),
  }),
]);
const createRunSchema = z.object({
  spaceId: spaceIdSchema,
  intent: z.string().min(1).max(16384),
  attachments: z.array(attachmentSchema).max(16).optional(),
  startUrl: z.string().url().max(4096).optional(),
  origin: runOriginSchema.optional(),
  /** The browser session the run acts in (web-browser-design.md §4.3). */
  sessionId: z.uuid().optional(),
});
const createDesktopRunSchema = z.object({
  runId: z.uuid(),
  taskId: z.uuid(),
  spaceId: spaceIdSchema,
  intent: z.string().min(1).max(16384),
  attachments: z.array(attachmentSchema).max(16).optional(),
  startUrl: z.string().url().max(4096).optional(),
  startedAt: z.iso.datetime(),
});
const desktopThreadSummarySchema = z.object({
  runId: z.uuid(),
  title: z.string().min(1).max(1024),
  status: z.enum(TASK_STATUSES),
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  turns: z.number().int().nonnegative(),
  messageCount: z.number().int().nonnegative(),
  origin: runOriginSchema.optional(),
  executor: z.object({ kind: z.literal("desktop") }),
});
const desktopSnapshotSchema = z.object({
  summary: desktopThreadSummarySchema,
  completedAt: z.iso.datetime().nullable(),
  thread: z.object({ spaceId: spaceIdSchema, sealed: z.string().min(1) }),
});
const listRunsQuerySchema = z.object({ spaceId: spaceIdSchema.optional() });
const runMessageSchema = z.object({
  text: z.string().min(1).max(16384),
  attachments: z.array(attachmentSchema).max(16).optional(),
});
const runAnswerSchema = z.object({ questionId: z.string().min(1).max(128), value: z.string().max(16384) });
const credentialFieldSchema = z.object({
  label: z.string().min(1).max(120),
  type: z.enum(CREDENTIAL_FIELD_TYPES),
  target: z.string().min(1).max(2048),
  autocomplete: z.enum(CREDENTIAL_AUTOCOMPLETE_VALUES).optional(),
}).strict();
const createCredentialCaptureSchema = z.object({
  leaseToken: z.string().min(1).max(200),
  tabId: z.string().min(1).max(256),
  siteName: z.string().min(1).max(160),
  siteOrigin: z.string().url().max(2048).refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  }),
  fields: z.array(credentialFieldSchema).min(1).max(8),
}).strict();
const submitCredentialCaptureSchema = z.object({
  sealedPayload: base64String(undefined, MAX_CREDENTIAL_PAYLOAD_BYTES * 2).refine(
    (value) => {
      try {
        return fromBase64(value).byteLength <= MAX_CREDENTIAL_PAYLOAD_BYTES;
      } catch {
        return false;
      }
    },
    "credential payload is too large",
  ),
}).strict();
const credentialCaptureParamSchema = z.object({ captureId: z.uuid() });
const internalCredentialCaptureParamSchema = z.object({ id: z.uuid(), captureId: z.uuid() });
const MAX_VAULT_PAYLOAD_BYTES = 64 * 1024;
const siteOriginSchema = z.string().url().max(2048).refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "https:" || protocol === "http:";
});
const vaultFieldSchema = z.object({
  id: z.uuid(),
  label: z.string().min(1).max(120),
  type: z.enum(CREDENTIAL_FIELD_TYPES),
  autocomplete: z.enum(CREDENTIAL_AUTOCOMPLETE_VALUES).optional(),
}).strict();
const vaultFieldsSchema = z.array(vaultFieldSchema).min(1).max(MAX_VAULT_ENTRY_FIELDS).refine(
  (fields) => new Set(fields.map((field) => field.id)).size === fields.length,
  "vault field ids must be unique",
).refine((fields) => fields.every(isVaultStorableField), "one-time codes cannot be kept in the vault");
const sealedVaultPayloadSchema = base64String(undefined, MAX_VAULT_PAYLOAD_BYTES * 2).refine(
  (value) => {
    try {
      return fromBase64(value).byteLength <= MAX_VAULT_PAYLOAD_BYTES;
    } catch {
      return false;
    }
  },
  "vault payload is too large",
);
const putVaultEntrySchema = z.object({
  siteOrigin: siteOriginSchema,
  siteName: z.string().min(1).max(160),
  fields: vaultFieldsSchema,
  sealedPayload: sealedVaultPayloadSchema,
}).strict();
const vaultEntryParamSchema = z.object({ id: spaceIdSchema, entryId: z.uuid() });
const internalVaultLookupSchema = z.object({
  leaseToken: z.string().min(1).max(200),
  siteOrigin: siteOriginSchema,
}).strict();
const internalVaultSaveSchema = z.object({
  leaseToken: z.string().min(1).max(200),
  id: z.uuid(),
  siteOrigin: siteOriginSchema,
  siteName: z.string().min(1).max(160),
  fields: vaultFieldsSchema,
  sealedPayload: sealedVaultPayloadSchema,
}).strict();
const internalVaultEntryParamSchema = z.object({ id: z.uuid(), entryId: z.uuid() });
const sealedIntegrationPayloadSchema = base64String(undefined, MAX_INTEGRATION_PAYLOAD_BYTES * 2).refine(
  (value) => {
    try {
      return fromBase64(value).byteLength <= MAX_INTEGRATION_PAYLOAD_BYTES;
    } catch {
      return false;
    }
  },
  "integration payload is too large",
);
const integrationScopesSchema = z.array(z.string().min(1).max(256)).max(MAX_INTEGRATION_SCOPES);
const putIntegrationConnectionSchema = z.object({
  provider: z.enum(INTEGRATION_PROVIDERS),
  accountLabel: z.string().min(1).max(MAX_INTEGRATION_ACCOUNT_LABEL),
  access: z.enum(INTEGRATION_ACCESS_LEVELS),
  scopes: integrationScopesSchema,
  sealedPayload: sealedIntegrationPayloadSchema,
}).strict().refine(
  (input) => integrationScopesCover(input.provider, input.scopes, input.access),
  "the granted scopes do not cover the access level",
);
const integrationConnectionParamSchema = z.object({ id: spaceIdSchema, connectionId: z.uuid() });
const internalIntegrationConnectionParamSchema = z.object({ id: z.uuid(), connectionId: z.uuid() });
// The one status a device may set by hand: a grant the provider refused.
// `connected` comes only from filing a grant, `revoke_pending` only from a
// disconnect, so neither can be conjured onto a row by a stray write.
const integrationStatusSchema = z.object({ status: z.literal("reconnect_required") }).strict();
const internalIntegrationStatusSchema = z.object({
  leaseToken: z.string().min(1).max(200),
  status: z.literal("reconnect_required"),
}).strict();
const agentQuestionSchema: z.ZodType<AgentQuestion> = z.object({
  id: z.string().min(1).max(128),
  prompt: z.string().min(1).max(16384),
  description: z.string().max(16384),
  choices: z.array(z.object({
    value: z.string().min(1).max(4096),
    label: z.string().min(1).max(4096),
    description: z.string().max(4096),
  })).max(32),
  input: z.object({ type: z.literal("text"), placeholder: z.string().max(512) }).optional(),
}).refine((question) => question.choices.length > 0 || question.input !== undefined, {
  message: "a question needs choices or a text input, or no reply can answer it",
});
const imessageStartSchema = z.object({ phone: z.string().trim().min(1).max(64) }).strict();
const imessageVerifySchema = z.object({
  challengeId: z.uuid(),
  code: z.string().regex(/^\d{6}$/u),
}).strict();
const onboardingTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const imessageOnboardingParamSchema = z.object({ token: onboardingTokenSchema });
const imessageDeliverySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("question"), question: agentQuestionSchema }).strict(),
  z.object({
    kind: z.literal("completion"),
    text: z.string().max(64 * 1024),
    completionId: z.string().min(1).max(128),
  }).strict(),
  z.object({ kind: z.literal("resolved"), questionId: z.string().min(1).max(128).optional() }).strict(),
]);

/**
 * How long a live view ticket is good for. Long enough to dial the runner and
 * to re-dial once after a dropped socket; short enough that a token in a URL
 * is not a standing key to the person's screen.
 */
const LIVE_TICKET_TTL_SECONDS = 60;

const createBrowserSessionSchema = z.object({ spaceId: spaceIdSchema }).strict();
const listBrowserSessionsQuerySchema = z.object({ spaceId: spaceIdSchema.optional() });
const sessionClaimSchema = z.object({
  workerId: z.string().min(1).max(200),
  /** This worker's private address, so a sibling can relay a shell socket here (§6.4). */
  workerUrl: z.string().url().max(2048).optional(),
});
const sessionLeaseSchema = z.object({ leaseToken: z.string().min(1).max(200) });
const sessionReleaseSchema = z.object({
  leaseToken: z.string().min(1).max(200),
  // The only state a worker may hand a session back in: it is letting go, not
  // ending the session, which is the person's decision alone.
  state: z.literal("suspended"),
});
/**
 * The lease-authenticated run routes a worker's `ShellHost` uses
 * (web-browser-design.md §8, revision 2). Control forbids a `cloud` device
 * from every device-bearer route, so the host cannot be the person on
 * `POST /runs` or the sponsor routes. What stands in for the person here is
 * the pair the worker already holds: the service bearer, and the session's
 * `leaseToken` — which the worker only has because control handed it the
 * session, which a viewer only reached by proving that Space's key. The
 * `viewerDeviceId` is the audit actor, and must be an unrevoked device of
 * the session's own user.
 */
const sessionRunAuthSchema = {
  leaseToken: z.string().min(1).max(200),
  viewerDeviceId: z.uuid(),
};
const sessionRunCreateSchema = z.object({
  ...sessionRunAuthSchema,
  intent: z.string().min(1).max(16384),
  attachments: z.array(attachmentSchema).max(16).optional(),
  startUrl: z.string().url().max(4096).optional(),
});
/** One command body: the union of what the sponsor routes take, all optional. */
const sessionRunCommandSchema = z.object({
  ...sessionRunAuthSchema,
  text: z.string().min(1).max(16384).optional(),
  attachments: z.array(attachmentSchema).max(16).optional(),
  questionId: z.string().min(1).max(128).optional(),
  value: z.string().max(16384).optional(),
  approvalId: z.string().min(1).max(128).optional(),
});
const sessionRunCommandParamSchema = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  command: z.enum(["message", "answer", "interrupt", "release", "revoke", "approve", "reject"]),
});
const sessionRunParamSchema = z.object({ id: z.uuid(), runId: z.uuid() });
/** Lease plus audit actor, with nothing else: what `DELETE …/runs/:runId` needs. */
const sessionRunAuthBodySchema = z.object(sessionRunAuthSchema);
/**
 * The session lease on a route with no body. It is a HEADER, never a query
 * parameter: this token authorises starting, steering, revoking and reading
 * every run in that person's Space, and the request logger below writes
 * `url.search` on every request — so a lease in the query string is a lease
 * in the clear in the log of every thread-list refresh and every replay.
 * (The socket ticket is scrubbed off `request.url` for the same reason.)
 */
export const SESSION_LEASE_HEADER = "x-pistachio-session-lease";

/**
 * A lease token, compared without leaking where the two differ. `secretEquals`
 * is what every other bearer in this file is checked with; a lease is a bearer
 * that authorises acting as a person in their own Space.
 */
const leaseMatches = (stored: string | null, presented: string): boolean =>
  stored !== null && presented !== "" && secretEquals(stored, presented);

const sessionRunEventsQuerySchema = z.object({
  since: z.coerce.number().int().nonnegative().optional(),
});

/** The lease a service-bearer GET presented, or "" when it presented none. */
const sessionLeaseHeader = (c: { req: { header(name: string): string | undefined } }): string =>
  (c.req.header(SESSION_LEASE_HEADER) ?? "").trim();

const redeemSessionTicketSchema = z.object({
  // Generous on length for the same reason as the live ticket below: a
  // wrong-shaped secret must be refused with the same 401 as a wrong one.
  ticket: z.string().min(1).max(4096),
  sessionId: z.uuid(),
});

const redeemLiveTicketSchema = z.object({
  // Generous on length so anything token-shaped is looked up and refused with
  // the same 401 as a wrong one: a validation error here would tell a caller
  // that its credential was the wrong KIND, which is not its business.
  ticket: z.string().min(1).max(4096),
  runId: z.string().uuid(),
});
const sinceQuerySchema = z.object({ since: z.coerce.number().int().nonnegative().optional() });
const commandsQuerySchema = z.object({
  since: z.coerce.number().int().nonnegative().optional(),
  wait: z.coerce.number().int().min(0).max(MAX_LONG_POLL_SECONDS).optional(),
});
const createChannelSchema = z.object({
  name: z.string().trim().min(1).max(200),
  spaceId: spaceIdSchema,
  outboundUrl: z.string().max(2048).optional(),
});
const cloudSpaceSchema = z.object({ spaceId: spaceIdSchema });
const introspectSchema = z.object({ token: z.string().min(1).max(4096) });
const claimSchema = z.object({
  workerId: z.string().min(1).max(200),
  /**
   * Where this worker can be reached from outside, for the live view (§8.5).
   * A worker that does not advertise one simply cannot be watched; runs it
   * claims fall back to `CLOUD_BROWSER_PUBLIC_URL`.
   */
  workerUrl: z.string().url().max(2048).optional(),
});
const leaseSchema = z.object({ leaseToken: z.string().min(1).max(200) });
const eventsSchema = z.object({
  leaseToken: z.string().min(1).max(200),
  events: z.array(runEventInputSchema).min(1).max(256),
});
const trailingEventsSchema = z.array(runEventInputSchema).max(256).optional();
// The body and the trailing `{t:'pause'}` event share one shape, so a
// payload control refuses on the event stream cannot slip in as a body.
const pauseSchema = z.object({
  leaseToken: z.string().min(1).max(200),
  pause: durablePauseSchema,
  events: trailingEventsSchema,
  imessageQuestion: agentQuestionSchema.optional(),
  imessageCredentialCapture: z.object({ captureId: z.uuid() }).strict().optional(),
});
const completeSchema = z.object({
  leaseToken: z.string().min(1).max(200),
  events: trailingEventsSchema,
  imessageCompletion: z.object({ text: z.string().max(64 * 1024), completionId: z.string().min(1).max(128) }).optional(),
});
const failSchema = z.object({
  leaseToken: z.string().min(1).max(200),
  reason: z.string().min(1).max(512),
  events: trailingEventsSchema,
});
const threadSchema = z.object({
  leaseToken: z.string().min(1).max(200),
  thread: z.object({ spaceId: spaceOrWorkspaceIdSchema, sealed: z.string().min(1) }),
});
/**
 * `deviceId` plus exactly one holder: a run (§7.6) or a browser session
 * (web-browser-design.md §4.3). Both would be ambiguous about which
 * revocation cuts the credential; neither names nothing to scope it to.
 */
const egressCredentialQuerySchema = z
  .object({ deviceId: z.uuid(), runId: z.uuid().optional(), sessionId: z.uuid().optional() })
  .refine((q) => (q.runId === undefined) !== (q.sessionId === undefined), {
    message: "exactly one of runId or sessionId",
  });
const usageSchema = z.object({
  userId: z.uuid(),
  periodStart: z.number(),
  periodEnd: z.number().optional(),
  proxiedBytes: z.number().nonnegative(),
  bytesToTarget: z.number().nonnegative().optional(),
  bytesToClient: z.number().nonnegative().optional(),
  connections: z.number().nonnegative().optional(),
  activeMillis: z.number().nonnegative().optional(),
});
const revocationsQuerySchema = z.object({ since: z.coerce.number().int().nonnegative().optional() });
const limitsQuerySchema = z.object({ userId: z.uuid() });
const inboundSchema = z
  .object({ deliveryId: z.string().min(1).max(128), text: z.string().min(1).max(16384) })
  .strict();
const linkParamSchema = z.object({ linkId: z.uuid() });
const userParamSchema = z.object({ userId: z.uuid() });

/* ------------------------------------------------------------------ *
 * Route families (§7.2)
 * ------------------------------------------------------------------ */

const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  "POST /v1/accounts",
  "POST /v1/accounts/anonymous",
  "POST /v1/auth/password-login",
  "POST /v1/auth/password-reset/request",
  "POST /v1/auth/password-reset/confirm",
  "GET /v1/auth/jwks",
  "POST /v1/auth/device-challenge",
  "POST /v1/auth/device-login",
  "POST /v1/auth/token/refresh",
  "GET /v1/healthz",
]);

const GATEWAY_PATHS: ReadonlySet<string> = new Set([
  "/v1/usage/egress",
  "/v1/egress/revocations",
  "/v1/egress/limits",
]);

const WRAPPERS_PATH_RE = /^\/v1\/spaces\/[^/]+\/wrappers$/;
const CHANNEL_INBOUND_RE = /^\/v1\/channels\/[^/]+\/inbound$/;
const IMESSAGE_WEBHOOK_PATH = "/v1/imessage/webhook";
const IMESSAGE_ONBOARDING_RE = /^\/v1\/imessage\/onboarding\/[A-Za-z0-9_-]{43}$/u;
const PUBLIC_ARTIFACT_RE = /^\/v1\/public\/artifacts\/[A-Za-z0-9_-]{24}$/;
/** A published note reads like a published artifact: GET, no credential. */
const PUBLIC_NOTE_RE = /^\/v1\/public\/notes\/[A-Za-z0-9_-]{24}$/;
const PUBLIC_CREDENTIAL_CAPTURE_RE = /^\/v1\/credential-captures\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/submit)?$/u;
const CREDENTIAL_CAPTURE_ID_IN_PATH_RE = /(\/credential-captures\/)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u;

function publicCredentialCaptureRoute(method: string, path: string): boolean {
  if (!PUBLIC_CREDENTIAL_CAPTURE_RE.test(path)) return false;
  return method === (path.endsWith("/submit") ? "POST" : "GET");
}

function requestLogPath(path: string): string {
  return path
    .replace(CREDENTIAL_CAPTURE_ID_IN_PATH_RE, "$1:captureId")
    .replace(/(\/imessage\/onboarding\/)[A-Za-z0-9_-]{43}/u, "$1:token");
}

function bootstrapAllowed(method: string, path: string): boolean {
  // `/account/link` rides the bootstrap token a password login just minted:
  // the merge has to happen before this Mac's device can belong to the account.
  if (method === "POST") return path === "/v1/devices/enroll" || path === "/v1/account/link";
  if (method !== "GET") return false;
  return path === "/v1/me" || path === "/v1/spaces" || WRAPPERS_PATH_RE.test(path);
}

/* ------------------------------------------------------------------ *
 * CORS
 * ------------------------------------------------------------------ */

/**
 * The web app calls control cross-origin, usually with a device token in
 * `Authorization`; the credential capability submits without one. The
 * allowlist is exact origins from `CONTROL_ALLOWED_ORIGINS` (comma
 * separated); empty means no CORS headers at all, i.e. same-origin only.
 * There is deliberately no wildcard and no `Access-Control-Allow-Credentials`:
 * control has no cookie or session surface, and a browser device holds its
 * own bearer token.
 */
export const CORS_ALLOWED_HEADERS: readonly string[] = ["authorization", "content-type", "idempotency-key"];
/** Every method the API routes actually use. */
export const CORS_ALLOWED_METHODS: readonly string[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const CORS_MAX_AGE_SECONDS = 600;

/** Exact, lowercased origins; `*` and anything unparseable is dropped. */
/**
 * The two web apps (docs/web-browser-design.md §15): `www` is the site and
 * the account dashboard, the browser app is the shell on a stream surface.
 * They are separate origins on purpose, so these are two values and not one.
 */
export const DEFAULT_WEB_URL = "https://pistachio.run";
export const DEFAULT_BROWSER_URL = "https://app.pistachio.run";

/**
 * What a laptop runs: `www` on port 3000 and the browser app on 3001. Both
 * call control cross-origin with a device token, so `dev-server.ts` uses this
 * as the default `CONTROL_ALLOWED_ORIGINS`. Production sets the variable; an
 * unset one still means no browser origin is allowed at all.
 */
export const DEV_ALLOWED_ORIGINS = "http://localhost:3000,http://localhost:3001";

export function parseAllowedOrigins(raw: string | undefined): string[] {
  const seen = new Set<string>();
  for (const entry of (raw ?? "").split(",")) {
    const trimmed = entry.trim().replace(/\/+$/, "");
    if (trimmed === "" || trimmed === "*") continue;
    let origin: string;
    try {
      origin = new URL(trimmed).origin;
    } catch {
      continue;
    }
    if (origin === "null") continue;
    seen.add(origin.toLowerCase());
  }
  return [...seen];
}

function cloudAllowed(method: string, path: string): boolean {
  if (method !== "GET") return false;
  return (
    path === "/v1/me" ||
    path === "/v1/devices" ||
    path === "/v1/spaces" ||
    path === "/v1/sync/policy" ||
    path === "/v1/egress" ||
    WRAPPERS_PATH_RE.test(path)
  );
}

/* ------------------------------------------------------------------ *
 * Views
 * ------------------------------------------------------------------ */

type DeviceRow = typeof devices.$inferSelect;
type WrapperRow = typeof keyWrappers.$inferSelect;

export interface DeviceView {
  id: string;
  name: string;
  platform: DevicePlatform;
  devicePublicKey: string;
  agreementPublicKey: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export function deviceView(row: DeviceRow): DeviceView {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    devicePublicKey: row.devicePublicKey,
    agreementPublicKey: row.agreementPublicKey,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

export interface WrapperView {
  spaceId: string;
  kind: string;
  credentialId: string;
  salt: string;
  wrapped: string;
  senderDeviceId: string | null;
  signature: string | null;
  createdAt: string;
}

export function wrapperView(row: WrapperRow): WrapperView {
  return {
    spaceId: row.spaceId,
    kind: row.kind,
    credentialId: row.credentialId,
    salt: row.salt,
    wrapped: row.wrapped,
    senderDeviceId: row.senderDeviceId,
    signature: row.signature,
    createdAt: row.createdAt.toISOString(),
  };
}

type HostedArtifactRow = typeof hostedArtifacts.$inferSelect;

/**
 * What both hosted kinds say about themselves. Only the name of the id
 * differs between them, because a client asking about a note should not have
 * to read `artifactId` to learn which note it asked about.
 */
function hostedFields(row: HostedArtifactRow) {
  return {
    shareId: row.shareId,
    revision: row.revision,
    visibility: row.visibility,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    publishedAt: row.publishedAt?.toISOString() ?? null,
  };
}

function hostedArtifactView(row: HostedArtifactRow) {
  return { artifactId: row.artifactId, ...hostedFields(row) };
}

function hostedNoteView(row: HostedArtifactRow) {
  return { noteId: row.artifactId, ...hostedFields(row) };
}

/**
 * Generated pages execute on the web origin, so sandboxing is not optional:
 * without an opaque origin an inline script could read this browser device's
 * local account vault. User-activated links still work; network resources,
 * APIs, forms, frames, and external scripts do not.
 */
export const ARTIFACT_CONTENT_SECURITY_POLICY = [
  "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox",
  "default-src 'none'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'self'",
].join("; ");

function artifactHtmlResponse(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": ARTIFACT_CONTENT_SECURITY_POLICY,
      "cross-origin-opener-policy": "same-origin",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow, noarchive",
    },
  });
}

interface AffectedOrigin {
  domain: string;
  label: string;
  remoteLogoutUrl?: string;
}

const REMOTE_LOGOUT_URLS: Readonly<Record<string, string>> = {
  "github.com": "https://github.com/settings/sessions",
  "google.com": "https://myaccount.google.com/device-activity",
  "slack.com": "https://my.slack.com/account/settings#sessions",
};

/** Tier-1 synced origins — the sessions a stolen device may still hold. */
export function affectedOriginsOnRevoke(): AffectedOrigin[] {
  return SEED_CORPUS.filter((o) => o.syncTier === 1).map((o) => {
    const remoteLogoutUrl = REMOTE_LOGOUT_URLS[o.domain];
    return remoteLogoutUrl ? { domain: o.domain, label: o.label, remoteLogoutUrl } : { domain: o.domain, label: o.label };
  });
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function uniqueViolation(err: unknown): string | null {
  const message = errorMessage(err);
  const match = /duplicate key value violates unique constraint "([^"]+)"/.exec(message);
  return match?.[1] ?? null;
}

/**
 * Client address for abuse limits: the first hop of `X-Forwarded-For` behind
 * the edge proxy, else a shared bucket (a bare local listener).
 */
function clientAddress(c: Context<AppEnv>): string {
  const forwarded = c.req.header("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first !== undefined && first !== "" ? first : "direct";
}

/** Map a coordinator error to an HTTP status + code. */
/**
 * A run claim that could not take its browser session with it (§4.3). Thrown
 * inside the claim transaction so the run's lease rolls back with it: holding
 * a run whose session went to another worker would put the agent in a
 * Chromium context this process cannot reach.
 */
class SessionClaimLost extends Error {
  constructor() {
    super("browser session was taken before the run claim committed");
  }
}

function coordinatorFailure(err: unknown): { status: 404 | 409; error: string; message: string } {
  const message = errorMessage(err);
  if (message.startsWith("unknown run") || message.includes("does not belong to this sponsor")) {
    return { status: 404, error: "not_found", message };
  }
  // Word-bounded: "release" (as in "cannot release control") is not a lease error.
  if (/\blease\b/u.test(message)) return { status: 409, error: "stale_lease", message };
  return { status: 409, error: "invalid_state", message };
}

/* ------------------------------------------------------------------ *
 * App
 * ------------------------------------------------------------------ */

export function createApp(db: Db, options: CreateAppOptions): ControlApp {
  const signing = options.signing;
  const env = options.env ?? {};
  const now = options.now ?? ((): number => Date.now());
  const nowSeconds = (): number => Math.floor(now() / 1000);
  const mailer = options.mailer ?? MAILER_DISABLED;
  const egress = options.egress ?? EGRESS_DISABLED;
  const production = env["NODE_ENV"] === "production";
  const log = options.log ?? ((): void => undefined);
  const controlPublicUrl = env["CONTROL_PUBLIC_URL"] ?? "http://localhost:8787";
  const configuredWebUrl = new URL(env["PISTACHIO_WEB_URL"] ?? DEFAULT_WEB_URL);
  if (configuredWebUrl.protocol !== "https:" && configuredWebUrl.protocol !== "http:") {
    throw new Error("PISTACHIO_WEB_URL must be HTTP(S)");
  }
  const webPublicOrigin = configuredWebUrl.origin;
  // The browser app (docs/web-browser-design.md §15). Control links to `www`
  // and never to it — a credential-capture form and an iMessage onboarding
  // page are pages on the site, not the shell — but a signed-in client has
  // to be able to FIND it, so `/me` carries it beside `cloudBrowserUrl` the
  // same way it carries the hub's address.
  const configuredBrowserUrl = new URL(env["PISTACHIO_BROWSER_URL"] ?? DEFAULT_BROWSER_URL);
  if (configuredBrowserUrl.protocol !== "https:" && configuredBrowserUrl.protocol !== "http:") {
    throw new Error("PISTACHIO_BROWSER_URL must be HTTP(S)");
  }
  const browserPublicUrl = configuredBrowserUrl.href.replace(/\/$/u, "");
  const allowedOrigins = parseAllowedOrigins(env["CONTROL_ALLOWED_ORIGINS"]);
  const blueBubblesConfig = options.imessage === undefined ? blueBubblesOptionsFromEnv(env) : options.imessage;
  const imessage = blueBubblesConfig === null ? null : new BlueBubblesConnector(blueBubblesConfig);

  const app = new Hono<AppEnv>();
  const hub = createHubBinding({ db, signing, now, injected: options.hub, log: options.log });
  const runnerRef = { current: options.runner ?? null };
  const outbox = new SteerOutbox(() => runnerRef.current);
  const bus = new RunEventBus();
  const challenges = new ChallengeStore(now);
  const idp = createIdp(db, mailer, env["BETTER_AUTH_SECRET"]);
  const passwordAttempts = new PasswordAttemptLimiter(undefined, undefined, now);
  const passwordResetRequests = new PasswordAttemptLimiter(PASSWORD_RESET_REQUEST_LIMIT, undefined, now);
  const passwordResetConfirms = new PasswordAttemptLimiter(undefined, undefined, now);
  const imessageStartsByUser = new PasswordAttemptLimiter(5, IMESSAGE_OTP_TTL_MS, now);
  const imessageStartsByPhone = new PasswordAttemptLimiter(3, IMESSAGE_OTP_TTL_MS, now);
  const imessageVerifiesByUser = new PasswordAttemptLimiter(IMESSAGE_VERIFIES_PER_USER, IMESSAGE_OTP_TTL_MS, now);
  const deviceChallengesByIp = new PasswordAttemptLimiter(DEVICE_CHALLENGES_PER_IP, CHALLENGE_TTL_MS, now);
  const anonymousSignupsByIp = anonymousSignupLimiter(now);
  const anonymousAi = new AnonymousAiLimiter(undefined, now);
  const inboundLimiter = channelInboundLimiter(now);
  const { dispatcher, store: notificationStore } = createChannelDispatcher({
    db,
    now,
    webhook: { production, ...options.channels },
  });
  const userChains = new Map<string, Promise<unknown>>();
  const background = new Set<Promise<unknown>>();

  const track = (work: Promise<unknown>): void => {
    const settled = work.catch((err: unknown) => log(`background task failed: ${errorMessage(err)}`));
    background.add(settled);
    void settled.finally(() => background.delete(settled));
  };

  const dispatchNotifications = async (at: number = now()): Promise<number> =>
    dispatcher.fireDue({ workerId: "control", now: at, limit: 50 });

  /** Serialize work per user (cloud enable, revoke). */
  const chained = <T>(userId: string, task: () => Promise<T>): Promise<T> => {
    const previous = userChains.get(userId) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    userChains.set(userId, settled);
    void settled.then(() => {
      if (userChains.get(userId) === settled) userChains.delete(userId);
    });
    return run;
  };

  /* ---------------------------------------------------------------- *
   * Helpers
   * ---------------------------------------------------------------- */

  const mintToken = async (userId: string, deviceId: string): Promise<{ token: string; exp: number }> => {
    const iat = nowSeconds();
    const exp = iat + DEVICE_TOKEN_TTL_SECONDS;
    const token = await signDeviceToken(signing.signingKey, { sub: userId, did: deviceId, iat, exp, jti: randomUUID() });
    return { token, exp };
  };

  const audit = async (
    userId: string,
    kind: string,
    detail: Record<string, unknown>,
    actorDeviceId: string | null = null,
    handle: Db = db,
  ): Promise<void> => {
    await handle.insert(auditEvents).values({ userId, kind, detail, actorDeviceId, at: new Date(now()) });
  };

  const otpHash = (challengeId: string, code: string): string => {
    if (imessage === null) throw new Error("iMessage is not configured");
    return createHmac("sha256", imessage.otpSecret).update(`${challengeId}:${code}`, "utf8").digest("hex");
  };

  const imessageLinkFor = async (userId: string, handle: Db = db) => {
    const [link] = await handle.select().from(imessageLinks).where(eq(imessageLinks.userId, userId));
    return link;
  };

  /**
   * The runs this phone most recently addressed, newest first, rather than
   * unrelated web threads. Each is a separate classification, so a follow-up
   * to an older thread still finds it while a newer one is in progress.
   */
  const imessageCandidates = async (
    phoneE164: string,
    userId: string,
  ): Promise<IMessageThreadRouteRequest["candidate"][]> => {
    const lastAt = sql<Date>`max(${imessageInboundMessages.receivedAt})`.mapWith(imessageInboundMessages.receivedAt);
    const associations = await db
      .select({ runId: imessageInboundMessages.runId, lastAt })
      .from(imessageInboundMessages)
      .where(and(eq(imessageInboundMessages.phoneE164, phoneE164), isNotNull(imessageInboundMessages.runId)))
      .groupBy(imessageInboundMessages.runId)
      .orderBy(desc(lastAt), desc(imessageInboundMessages.runId))
      .limit(IMESSAGE_ROUTING_MAX_CANDIDATES);
    const lastIMessageAt = new Map<string, Date>();
    for (const association of associations) {
      if (association.runId !== null) lastIMessageAt.set(association.runId, association.lastAt);
    }
    if (lastIMessageAt.size === 0) return [];
    const rows = await db
      .select()
      .from(hostedRuns)
      .where(and(
        inArray(hostedRuns.id, [...lastIMessageAt.keys()]),
        eq(hostedRuns.userId, userId),
        eq(hostedRuns.spaceId, DEFAULT_SPACE_ID),
      ));
    const freshAfter = now() - IMESSAGE_ROUTING_MAX_AGE_MS;
    const candidates: IMessageThreadRouteRequest["candidate"][] = [];
    for (const row of rows) {
      const addressedAt = lastIMessageAt.get(row.id);
      if (addressedAt === undefined || row.executor.kind !== "cloud" || IMESSAGE_UNROUTABLE_STATUSES.has(row.status)) continue;
      const record = rowToRecord(row);
      if (Math.max(addressedAt.getTime(), Date.parse(record.updatedAt)) < freshAfter) continue;
      candidates.push({
        runId: record.id,
        userId: record.userId,
        spaceId: record.spaceId,
        intent: record.intent,
        status: record.status,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        completedAt: record.completedAt,
        lastIMessageAt: addressedAt.toISOString(),
      });
    }
    return candidates.sort((a, b) => Date.parse(b.lastIMessageAt) - Date.parse(a.lastIMessageAt));
  };

  /**
   * Newest conversation history that stays below the runner route's request
   * cap. Sealed rows carry a plaintext kind hint so tool detail and evidence,
   * which dominate a busy run, do not crowd the messages out of the window;
   * rows written before the hint existed are still shipped and the runner
   * discards them after opening.
   */
  const imessageRoutingEvents = async (runId: string): Promise<IMessageRoutingEvent[]> => {
    const rows = await db
      .select({ eventId: runEvents.eventId, at: runEvents.at, event: runEvents.event })
      .from(runEvents)
      .where(and(
        eq(runEvents.runId, runId),
        sql`(
          ${runEvents.event}->>'t' in ('cmd.message', 'cmd.answer')
          or (${runEvents.event}->>'t' = 'sealed' and coalesce(${runEvents.event}->>'kind', 'message') in ('message', 'question'))
        )`,
      ))
      .orderBy(desc(runEvents.seq))
      .limit(IMESSAGE_ROUTING_MAX_EVENTS);
    const selected: IMessageRoutingEvent[] = [];
    let bytes = 0;
    for (const row of rows) {
      const event = row.event as RunEvent;
      const routingEvent: IMessageRoutingEvent | null = event.t === "cmd.message"
        ? { eventId: row.eventId, at: row.at.toISOString(), event: { t: "cmd.message", text: event.text } }
        : event.t === "cmd.answer" || event.t === "sealed"
          ? { eventId: row.eventId, at: row.at.toISOString(), event }
          : null;
      if (routingEvent === null) continue;
      const size = Buffer.byteLength(JSON.stringify(routingEvent), "utf8");
      // Stop at the first row that does not fit: the history must stay
      // contiguous, or a command loses the sealed copy it is paired with.
      if (size > IMESSAGE_ROUTING_MAX_BYTES - bytes) break;
      selected.push(routingEvent);
      bytes += size;
    }
    return selected.reverse();
  };

  const deliverIMessageQuestion = async (userId: string, runId: string, question: AgentQuestion): Promise<boolean> => {
    if (imessage === null) return false;
    const link = await imessageLinkFor(userId);
    if (link === undefined) return false;
    await db.transaction(async (tx) => {
      await tx.delete(imessagePendingQuestions).where(eq(imessagePendingQuestions.runId, runId));
      await tx.insert(imessagePendingQuestions).values({
        runId,
        questionId: question.id,
        userId,
        question,
        createdAt: new Date(now()),
      });
    });
    try {
      await imessage.sendQuestion(link.phoneE164, runId, question);
    } catch (error) {
      await db
        .delete(imessagePendingQuestions)
        .where(and(eq(imessagePendingQuestions.runId, runId), eq(imessagePendingQuestions.questionId, question.id)));
      throw error;
    }
    return true;
  };

  const deliverIMessageCompletion = async (
    userId: string,
    runId: string,
    text: string,
    completionId: string,
  ): Promise<boolean> => {
    await db.delete(imessagePendingQuestions).where(eq(imessagePendingQuestions.runId, runId));
    if (imessage === null) return false;
    const link = await imessageLinkFor(userId);
    if (link === undefined) return false;
    await imessage.sendCompletion(link.phoneE164, runId, text, completionId);
    return true;
  };

  const deliverIMessageCredentialCapture = async (
    userId: string,
    runId: string,
    captureId: string,
  ): Promise<boolean> => {
    if (imessage === null) return false;
    const [link, capture] = await Promise.all([
      imessageLinkFor(userId),
      db.select().from(credentialCaptures).where(and(
        eq(credentialCaptures.id, captureId),
        eq(credentialCaptures.runId, runId),
        eq(credentialCaptures.userId, userId),
      )).then((rows) => rows[0]),
    ]);
    if (link === undefined || capture === undefined) return false;
    await imessage.sendCredentialRequest(link.phoneE164, runId, captureId, {
      siteOrigin: capture.siteOrigin,
      fieldLabels: capture.fields.map((field) => field.label),
      captureUrl: `${webPublicOrigin}/credential-capture/${encodeURIComponent(captureId)}`,
      expiresAt: capture.expiresAt.toISOString(),
    });
    return true;
  };

  /** Connector outages must never turn an already-committed run transition into an HTTP failure. */
  const tryDeliverIMessageQuestion = async (userId: string, runId: string, question: AgentQuestion): Promise<void> => {
    try {
      await deliverIMessageQuestion(userId, runId, question);
    } catch (error) {
      log(`iMessage question delivery failed for ${runId}: ${errorMessage(error)}`);
    }
  };

  const tryDeliverIMessageCompletion = async (
    userId: string,
    runId: string,
    text: string,
    completionId: string,
  ): Promise<void> => {
    try {
      await deliverIMessageCompletion(userId, runId, text, completionId);
    } catch (error) {
      log(`iMessage completion delivery failed for ${runId}: ${errorMessage(error)}`);
    }
  };

  const tryDeliverIMessageCredentialCapture = async (
    userId: string,
    runId: string,
    captureId: string,
  ): Promise<void> => {
    try {
      await deliverIMessageCredentialCapture(userId, runId, captureId);
    } catch (error) {
      log(`iMessage credential request delivery failed for ${runId}: ${errorMessage(error)}`);
    }
  };

  const liveCloudDevice = async (userId: string, handle: Db = db): Promise<DeviceRow | undefined> => {
    const [row] = await handle
      .select()
      .from(devices)
      .where(and(eq(devices.userId, userId), eq(devices.platform, "cloud"), isNull(devices.revokedAt)));
    return row;
  };

  const ownedSpace = async (userId: string, spaceId: string, handle: Db = db) => {
    const [row] = await handle
      .select()
      .from(spaces)
      .where(and(eq(spaces.userId, userId), eq(spaces.id, spaceId)));
    return row;
  };

  const spaceCloudEnabled = async (userId: string, spaceId: string, handle: Db = db): Promise<boolean> => {
    const cloud = await liveCloudDevice(userId, handle);
    if (cloud === undefined) return false;
    const [wrapper] = await handle
      .select({ kind: keyWrappers.kind })
      .from(keyWrappers)
      .where(
        and(
          eq(keyWrappers.userId, userId),
          eq(keyWrappers.spaceId, spaceId),
          eq(keyWrappers.kind, "device-x25519"),
          eq(keyWrappers.credentialId, cloud.id),
        ),
      );
    return wrapper !== undefined;
  };

  const verifySignature = async (
    publicKeyB64: string,
    signatureB64: string,
    message: Uint8Array,
  ): Promise<boolean> => {
    try {
      const key = await importPublicKeyRaw(fromBase64(publicKeyB64));
      return await crypto.subtle.verify(
        "Ed25519",
        key,
        fromBase64(signatureB64) as BufferSource,
        message as BufferSource,
      );
    } catch {
      return false;
    }
  };

  const mintEgressCredential = async (
    userId: string,
    deviceId: string,
    runId: string | null,
    /** The browser session the credential belongs to, when it is not a run's (§4.3). */
    sessionId: string | null = null,
  ): Promise<MintedCredential | null> => {
    if (egress.tokenSecretHex === null || egress.provider === null) return null;
    const expiresAtMs = now() + CREDENTIAL_TTL_SECONDS * 1000;
    const [row] = await db
      .insert(egressCredentials)
      .values({ userId, deviceId, runId, sessionId, expiresAt: new Date(expiresAtMs), createdAt: new Date(now()) })
      .returning({ id: egressCredentials.id });
    if (row === undefined) throw new Error("credential insert returned no row");
    return mintCredential({
      secretHex: gatewaySecretFor(egress.provider.kind, egress.tokenSecretHex, userId),
      userId,
      deviceId,
      credentialId: row.id,
      expiresAtMs,
    });
  };

  /**
   * Device revocation and every side effect (§7.3). Idempotent, and
   * *repairable*: the database effects commit in one transaction, the hub
   * call stays outside it (runs/revoker.ts explains why), and
   * `revocation_completed_at` is stamped only once every step has run. A
   * revoke that dies half way (a failing hub write, say) therefore replays
   * in full on the next call instead of short-circuiting on `revoked_at`.
   */
  const revokeDevice = async (
    userId: string,
    device: DeviceRow,
    actorDeviceId: string | null,
  ): Promise<void> => {
    const [state] = await db
      .select({ revokedAt: devices.revokedAt, completedAt: devices.revocationCompletedAt })
      .from(devices)
      .where(and(eq(devices.id, device.id), eq(devices.userId, userId)));
    if (state === undefined) return;
    if (state.revokedAt !== null && state.completedAt !== null) return; // fully revoked
    const first = state.revokedAt === null;
    await db.transaction(async (tx) => {
      if (first) {
        await tx
          .update(devices)
          .set({ revokedAt: new Date(now()) })
          .where(and(eq(devices.id, device.id), isNull(devices.revokedAt)));
      }
      const [feed] = await tx
        .select({ id: egressRevocations.id })
        .from(egressRevocations)
        .where(and(eq(egressRevocations.deviceId, device.id), isNull(egressRevocations.credentialId)));
      if (feed === undefined) {
        await tx.insert(egressRevocations).values({ deviceId: device.id, credentialId: null, at: new Date(now()) });
      }
      await tx
        .update(egressCredentials)
        .set({ revokedAt: new Date(now()) })
        .where(and(eq(egressCredentials.deviceId, device.id), isNull(egressCredentials.revokedAt)));
      await tx
        .delete(keyWrappers)
        .where(
          and(
            eq(keyWrappers.userId, userId),
            eq(keyWrappers.kind, "device-x25519"),
            sql`(${keyWrappers.credentialId} = ${device.id} or ${keyWrappers.senderDeviceId} = ${device.id})`,
          ),
        );
      if (first) {
        await audit(userId, "device.revoked", { deviceId: device.id, platform: device.platform }, actorDeviceId, tx);
      }
    });
    const host = hub.host;
    if (host !== null) await host.revokeDevice(userId, device.id);
    if (device.platform === "cloud") {
      await outbox.send({ kind: "device.revoked", userId, deviceId: device.id });
      await outbox.flush();
    }
    await db.update(devices).set({ revocationCompletedAt: new Date(now()) }).where(eq(devices.id, device.id));
  };

  /* ---------------------------------------------------------------- *
   * Hosted runs: transactional unit of work
   * ---------------------------------------------------------------- */

  interface Unit {
    tx: Db;
    coordinator: HostedRunCoordinator;
    store: PostgresHostedRunStore;
    sink: RunEventSink;
    after(task: () => Promise<void> | void): void;
  }

  const onAppended = (batch: AppendedBatch, after: Unit["after"]): void => {
    after(() => bus.wake(batch.runId, batch.stored));
    if (batch.origin?.kind !== "channel") return;
    const scheduled = batch.stored
      .map((event) =>
        notificationFor({
          runId: batch.runId,
          userId: batch.userId,
          eventId: event.eventId,
          event: event.event,
          controlPublicUrl,
          now: now(),
        }),
      )
      .filter((n) => n !== null);
    if (scheduled.length === 0) return;
    after(async () => {
      for (const notification of scheduled) await notificationStore.schedule(notification);
      track(dispatchNotifications());
    });
  };

  const withUnit = async <T>(fn: (unit: Unit) => Promise<T>): Promise<T> => {
    const tasks: Array<() => Promise<void> | void> = [];
    const after: Unit["after"] = (task) => {
      tasks.push(task);
    };
    const result = await db.transaction(async (tx) => {
      const store = new PostgresHostedRunStore(tx);
      const sink = new PostgresRunEventSink(tx, (batch) => onAppended(batch, after));
      const revoker = new ControlAuthorityRevoker({ db: tx, hub: () => hub.host, afterCommit: after });
      const coordinator = new HostedRunCoordinator(store, revoker, sink);
      return fn({ tx, coordinator, store, sink, after });
    });
    for (const task of tasks) await task();
    return result;
  };

  const createRun = async (
    unit: Unit,
    input: {
      userId: string;
      spaceId: string;
      intent: string;
      attachments: HostedRunRecord["attachments"];
      origin: RunOrigin | null;
      startUrl: string | null;
      sessionId?: string | null;
    },
  ): Promise<HostedRunRecord> => {
    const record = await unit.coordinator.create(input, now());
    const summary = controlRunSummary({
      runId: record.id,
      taskId: record.taskId,
      intent: input.intent,
      status: record.status,
      startedAt: record.createdAt,
      origin: input.origin,
      executor: record.executor,
    });
    await unit.sink.append(
      record.id,
      [{ eventId: `run.created:${record.id}`, at: record.createdAt, event: { t: "run.created", run: summary } }],
      { sponsorId: input.userId },
    );
    return record;
  };

  /**
   * Ids for a batch control appends itself. `token` scopes the batch: the
   * runner paths pass the revision the coordinator just bumped (so a retry
   * of the same transition is deduped by `(run_id, event_id)`), while the
   * sponsor paths pass the caller's `Idempotency-Key` or a fresh uuid --
   * a sponsor command must not collide with the previous one when the
   * transition left the revision untouched (§7.8).
   */
  const sponsorEvents = (runId: string, token: string, events: RunEvent[]): RunEventInput[] => {
    const at = new Date(now()).toISOString();
    return events.map((event, index) => ({
      eventId: `${event.t}:${runId}:${token}:${String(index)}`,
      at,
      event,
    }));
  };

  const statusEvent = (run: HostedRunRecord): RunEvent => ({
    t: "status",
    status: run.status,
    completedAt: run.completedAt,
  });

  const runEventsBatchHasStatus = (events: RunEventInput[] | undefined, status: string): boolean =>
    (events ?? []).some((e) => e.event.t === "status" && e.event.status === status);

  const steerCommand = (runId: string, command: RunEvent, seq: number): void => {
    const body: SteerBody = { kind: "run.command", runId, command: { ...command, seq } };
    // The runner refuses oversized steers with 413 and the outbox would retry
    // the same body twenty times; the long-poll delivers it regardless.
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_STEER_BYTES) return;
    track(outbox.send(body));
  };

  /** Live-steer every `cmd.*` of an append, each with its own allocated seq. */
  const steerCommands = (runId: string, result: { events: RunEvent[]; seqs: number[] }): void => {
    result.events.forEach((event, index) => {
      if (isCommandEvent(event)) steerCommand(runId, event, result.seqs[index] ?? 0);
    });
  };

  /* ---------------------------------------------------------------- *
   * Request logging and error mapping
   * ---------------------------------------------------------------- */

  // First of all: refuse an oversized body from the Content-Length or the
  // stream itself before any handler can buffer it.
  app.use(
    "*",
    bodyLimit({
      maxSize: MAX_REQUEST_BODY_BYTES,
      onError: (c) => c.json({ error: "payload_too_large" }, 413),
    }),
  );
  // Ahead of the logger and of every auth family: a preflight carries no
  // credentials and must be answered before `v1`'s bearer check runs.
  if (allowedOrigins.length > 0) {
    app.use(
      "*",
      cors({
        origin: (origin) => (allowedOrigins.includes(origin.toLowerCase()) ? origin : null),
        allowMethods: [...CORS_ALLOWED_METHODS],
        allowHeaders: [...CORS_ALLOWED_HEADERS],
        maxAge: CORS_MAX_AGE_SECONDS,
        credentials: false,
      }),
    );
  }

  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    // Everything that authorises anything. A parameter added to a route
    // without being added here is a credential in the log of every request
    // that carries it.
    url.searchParams.delete("access_token");
    url.searchParams.delete("secret");
    url.searchParams.delete("leaseToken");
    url.searchParams.delete("ticket");
    log(`${c.req.method} ${requestLogPath(url.pathname)}${url.search}`);
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof RunEventError) {
      const status = err.code === "unknown_run" ? 404 : err.code === "event_too_large" ? 413 : 409;
      return c.json({ error: err.code }, status);
    }
    log(`unhandled error on ${c.req.method} ${requestLogPath(c.req.path)}: ${errorMessage(err)}`);
    return c.json({ error: "internal" }, 500);
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  const v1 = new Hono<AppEnv>();
  const serviceAuth = bearerService(() => env["CLOUD_BROWSER_SERVICE_TOKEN"], "service_auth_unconfigured");
  const gatewayAuth = bearerGateway(env);

  v1.use("*", async (c, next) => {
    const method = c.req.method;
    const path = c.req.path;
    if (
      PUBLIC_ROUTES.has(`${method} ${path}`) ||
      (method === "GET" && PUBLIC_ARTIFACT_RE.test(path)) ||
      (method === "GET" && PUBLIC_NOTE_RE.test(path)) ||
      (method === "GET" && IMESSAGE_ONBOARDING_RE.test(path)) ||
      publicCredentialCaptureRoute(method, path)
    ) return next();
    if (path.startsWith("/v1/internal/")) return serviceAuth(c, next);
    if (GATEWAY_PATHS.has(path)) return gatewayAuth(c, next);
    // The link secret is checked by the route itself (it needs the row).
    if (method === "POST" && CHANNEL_INBOUND_RE.test(path)) return next();
    if (method === "POST" && path === IMESSAGE_WEBHOOK_PATH) return next();
    const token = bearerToken(c.req.header("Authorization"));
    if (token === null) return c.json({ error: "unauthorized" }, 401);
    const identity = await authenticateToken(db, signing, token, nowSeconds());
    if (identity === null) return c.json({ error: "unauthorized" }, 401);
    if (identity.revoked) return c.json({ error: "unauthorized", reason: "device_revoked" }, 401);
    c.set("userId", identity.userId);
    c.set("deviceId", identity.deviceId);
    c.set("platform", identity.platform);
    c.set("anonymous", identity.anonymous);
    // An allow-list, so a route added later is closed to an anonymous
    // account until someone decides otherwise (src/anonymous.ts).
    if (identity.anonymous && !anonymousAllowed(method, path)) {
      return c.json(ACCOUNT_REQUIRED, 403);
    }
    if (identity.deviceId === null && !bootstrapAllowed(method, path)) {
      return c.json({ error: "device_required" }, 403);
    }
    if (identity.platform === "cloud" && !cloudAllowed(method, path)) {
      return c.json({ error: "cloud_device_forbidden" }, 403);
    }
    return next();
  });

  v1.get("/healthz", (c) => c.json({ ok: true }));

  /* ---------------------------------------------------------------- *
   * Public: accounts and auth
   * ---------------------------------------------------------------- */

  v1.post("/accounts", validate(signupSchema), async (c) => {
    const input = body(c, signupSchema);
    const email = input.email.toLowerCase();
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (existing) return c.json({ error: "email_taken" }, 409);
    try {
      await idp.api.signUpEmail({ body: { email, password: input.password, name: email.split("@")[0] ?? email } });
    } catch (err) {
      if (err instanceof APIError) {
        const taken = /exist/i.test(err.message);
        return c.json(
          taken ? { error: "email_taken" } : { error: "signup_rejected", explanation: err.message },
          taken ? 409 : 400,
        );
      }
      throw err;
    }
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (!user) return c.json({ error: "internal" }, 500);
    await db.insert(spaces).values([
      { userId: user.id, id: DEFAULT_SPACE_ID, name: DEFAULT_SPACE_NAME, createdAt: new Date(now()) },
      { userId: user.id, id: WORKSPACE_PSEUDO_SPACE_ID, name: WORKSPACE_SPACE_NAME, createdAt: new Date(now()) },
    ]);
    await audit(user.id, "account.created", { email });
    const boot = await mintToken(user.id, user.id);
    return c.json({ userId: user.id, bootstrapToken: boot.token, exp: boot.exp }, 201);
  });

  /**
   * The proof every enrollment makes: a fresh challenge signed by the key
   * being enrolled, for an id and a key control has never seen. Answers the
   * refusal, or null when the device may be inserted.
   */
  const refuseEnrollment = async (c: Context<AppEnv>, input: z.infer<typeof enrollSchema>): Promise<Response | null> => {
    if (!challenges.take(input.deviceId, input.challenge)) {
      return c.json({ error: "unauthorized", reason: "challenge_expired" }, 401);
    }
    const valid = await verifySignature(
      input.devicePublicKey,
      input.signature,
      deviceLoginSigningBytes(input.deviceId, input.challenge),
    );
    if (!valid) return c.json({ error: "unauthorized", reason: "bad_signature" }, 401);
    const [byId] = await db.select({ id: devices.id }).from(devices).where(eq(devices.id, input.deviceId));
    if (byId) return c.json({ error: "device_id_taken" }, 409);
    const [byKey] = await db
      .select({ revokedAt: devices.revokedAt })
      .from(devices)
      .where(eq(devices.devicePublicKey, input.devicePublicKey));
    if (byKey) return c.json({ error: byKey.revokedAt !== null ? "device_revoked" : "device_already_enrolled" }, 409);
    return null;
  };

  /**
   * An account for a Mac nobody signed in on (docs/anonymous-accounts.md):
   * the user row, its two Spaces, and this device, in one transaction and
   * one round trip — there is no credential to exchange for a bootstrap
   * token, so the device proof IS the sign-up. The answer is a device token.
   *
   * A fresh account is a fresh model allowance, so minting is bounded per
   * client address; the desktop only, since the web has no signed-out state.
   */
  v1.post("/accounts/anonymous", validate(enrollSchema), async (c) => {
    if (!anonymousSignupsByIp.allow(clientAddress(c))) return c.json({ error: "rate_limited" }, 429);
    const input = body(c, enrollSchema);
    if (input.platform !== "macos") return c.json({ error: "platform_not_allowed" }, 400);
    const refused = await refuseEnrollment(c, input);
    if (refused !== null) return refused;
    const createdAt = new Date(now());
    let created: { userId: string; device: DeviceRow } | null;
    try {
      created = await db.transaction(async (tx) => {
        const [user] = await tx
          .insert(users)
          .values({ email: null, isAnonymous: true, createdAt, updatedAt: createdAt })
          .returning({ id: users.id });
        if (!user) return null;
        await tx.insert(spaces).values([
          { userId: user.id, id: DEFAULT_SPACE_ID, name: DEFAULT_SPACE_NAME, createdAt },
          { userId: user.id, id: WORKSPACE_PSEUDO_SPACE_ID, name: WORKSPACE_SPACE_NAME, createdAt },
        ]);
        const [device] = await tx
          .insert(devices)
          .values({
            id: input.deviceId,
            userId: user.id,
            name: input.name,
            platform: "macos",
            devicePublicKey: input.devicePublicKey,
            agreementPublicKey: input.agreementPublicKey,
            createdAt,
            lastSeenAt: createdAt,
          })
          .returning();
        if (!device) return null;
        await audit(user.id, "account.created", { anonymous: true, deviceId: device.id }, device.id, tx);
        return { userId: user.id, device };
      });
    } catch (err) {
      const constraint = uniqueViolation(err);
      if (constraint === "devices_pkey") return c.json({ error: "device_id_taken" }, 409);
      if (constraint !== null) return c.json({ error: "device_already_enrolled" }, 409);
      throw err;
    }
    if (created === null) return c.json({ error: "internal" }, 500);
    const token = await mintToken(created.userId, created.device.id);
    return c.json({ userId: created.userId, device: deviceView(created.device), ...token }, 201);
  });

  v1.post("/auth/password-login", validate(passwordLoginSchema), async (c) => {
    const input = body(c, passwordLoginSchema);
    const email = input.email.toLowerCase();
    if (!passwordAttempts.allow(email)) return c.json({ error: "rate_limited" }, 429);
    try {
      await idp.api.signInEmail({ body: { email, password: input.password } });
    } catch (err) {
      if (err instanceof APIError) return c.json({ error: "invalid_credentials" }, 403);
      throw err;
    }
    passwordAttempts.reset(email);
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (!user) return c.json({ error: "invalid_credentials" }, 403);
    const boot = await mintToken(user.id, user.id);
    await audit(user.id, "auth.password_login", {});
    return c.json({ userId: user.id, bootstrapToken: boot.token, exp: boot.exp });
  });

  v1.post("/auth/password-reset/request", validate(passwordResetRequestSchema), async (c) => {
    if (mailer.sendAuthOtp === null) {
      return c.json({ error: "password_reset_unavailable", explanation: "no email transport configured (MAILER)" }, 503);
    }
    const email = body(c, passwordResetRequestSchema).email.toLowerCase();
    if (!passwordResetRequests.allow(email)) return c.json({ error: "rate_limited" }, 429);
    await idp.api.requestPasswordResetEmailOTP({ body: { email } });
    return c.body(null, 202);
  });

  v1.post("/auth/password-reset/confirm", validate(passwordResetConfirmSchema), async (c) => {
    const input = body(c, passwordResetConfirmSchema);
    const email = input.email.toLowerCase();
    if (!passwordResetConfirms.allow(email)) return c.json({ error: "rate_limited" }, 429);
    try {
      await idp.api.resetPasswordEmailOTP({ body: { email, otp: input.code, password: input.password } });
    } catch (err) {
      if (err instanceof APIError) return c.json({ error: "invalid_code" }, 403);
      throw err;
    }
    passwordResetConfirms.reset(email);
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (user) {
      await db.delete(keyWrappers).where(and(eq(keyWrappers.userId, user.id), eq(keyWrappers.kind, "password")));
      await audit(user.id, "auth.password_reset", {});
    }
    return c.body(null, 204);
  });

  v1.get("/auth/jwks", (c) =>
    c.json({ alg: "EdDSA", format: "raw-ed25519-base64", publicKey: signing.publicKeyBase64() }),
  );

  // Issued without a device lookup so callers cannot probe enrollment. The
  // route is public and the store is global, so one address is bounded
  // before it can fill the store and lock every real device out.
  v1.post("/auth/device-challenge", validate(deviceChallengeSchema), (c) => {
    if (!deviceChallengesByIp.allow(clientAddress(c))) return c.json({ error: "rate_limited" }, 429);
    const challenge = challenges.issue(body(c, deviceChallengeSchema).deviceId);
    if (challenge === null) return c.json({ error: "rate_limited" }, 429);
    return c.json({ challenge });
  });

  v1.post("/auth/device-login", validate(deviceLoginSchema), async (c) => {
    const input = body(c, deviceLoginSchema);
    if (!challenges.take(input.deviceId, input.challenge)) {
      return c.json({ error: "unauthorized", reason: "challenge_expired" }, 401);
    }
    const [device] = await db.select().from(devices).where(eq(devices.id, input.deviceId));
    if (!device) return c.json({ error: "unauthorized", reason: "unknown_device" }, 401);
    if (device.revokedAt !== null) return c.json({ error: "unauthorized", reason: "device_revoked" }, 401);
    const valid = await verifySignature(
      device.devicePublicKey,
      input.signature,
      deviceLoginSigningBytes(input.deviceId, input.challenge),
    );
    if (!valid) return c.json({ error: "unauthorized", reason: "bad_signature" }, 401);
    await db.update(devices).set({ lastSeenAt: new Date(now()) }).where(eq(devices.id, device.id));
    return c.json(await mintToken(device.userId, device.id));
  });

  // Silent re-mint: a still-valid bootstrap (until the first device enrolls)
  // or device token, including cloud-platform tokens.
  v1.post("/auth/token/refresh", async (c) => {
    const bearer = bearerToken(c.req.header("Authorization"));
    if (bearer === null || bearer.split(".").length !== 3) {
      return c.json({ error: "unauthorized", reason: "missing_credentials" }, 401);
    }
    const result = await verifyDeviceToken(signing.verifyKey, bearer, nowSeconds());
    if (!result.ok) return c.json({ error: "unauthorized", reason: result.reason }, 401);
    const { sub, did } = result.claims;
    if (!UUID_RE.test(sub) || !UUID_RE.test(did)) return c.json({ error: "unauthorized", reason: "malformed" }, 401);
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, sub));
    if (!user) return c.json({ error: "unauthorized", reason: "unknown_user" }, 401);
    if (did === sub) {
      const [enrolled] = await db
        .select({ id: devices.id })
        .from(devices)
        .where(and(eq(devices.userId, sub), isNull(devices.revokedAt)))
        .limit(1);
      if (enrolled) return c.json({ error: "unauthorized", reason: "bootstrap_consumed" }, 401);
      return c.json(await mintToken(sub, sub));
    }
    const [device] = await db
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.id, did), eq(devices.userId, sub), isNull(devices.revokedAt)));
    if (!device) return c.json({ error: "unauthorized", reason: "device_not_active" }, 401);
    await db.update(devices).set({ lastSeenAt: new Date(now()) }).where(eq(devices.id, did));
    return c.json(await mintToken(sub, did));
  });

  /* ---------------------------------------------------------------- *
   * Bootstrap or device bearer
   * ---------------------------------------------------------------- */

  v1.post("/devices/enroll", validate(enrollSchema), async (c) => {
    const userId = c.get("userId");
    if (c.get("deviceId") !== null) return c.json({ error: "bootstrap_required" }, 403);
    const input = body(c, enrollSchema);
    if (!ENROLLABLE_PLATFORMS.has(input.platform)) return c.json({ error: "platform_not_allowed" }, 400);
    const platform = input.platform as DevicePlatform;
    const refused = await refuseEnrollment(c, input);
    if (refused !== null) return refused;
    let device: DeviceRow | undefined;
    try {
      [device] = await db
        .insert(devices)
        .values({
          id: input.deviceId,
          userId,
          name: input.name,
          platform,
          devicePublicKey: input.devicePublicKey,
          agreementPublicKey: input.agreementPublicKey,
          createdAt: new Date(now()),
          lastSeenAt: new Date(now()),
        })
        .returning();
    } catch (err) {
      const constraint = uniqueViolation(err);
      if (constraint === "devices_pkey") return c.json({ error: "device_id_taken" }, 409);
      if (constraint !== null) return c.json({ error: "device_already_enrolled" }, 409);
      throw err;
    }
    if (!device) return c.json({ error: "internal" }, 500);
    await audit(userId, "device.enrolled", { deviceId: device.id, name: device.name, platform }, device.id);
    const token = await mintToken(userId, device.id);
    return c.json({ device: deviceView(device), ...token }, 201);
  });

  /**
   * First-device key bootstrap. The browser generates every root secret and
   * password wrapper locally, then commits the complete set in one database
   * transaction. Control sees ciphertext only and never accepts a partial
   * account that could strand the remaining Spaces.
   */
  v1.post("/account/provision", validate(accountProvisionSchema), async (c) => {
    const userId = c.get("userId");
    const input = body(c, accountProvisionSchema);
    const result = await db.transaction(async (tx) => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
      const [existing] = await tx
        .select({ spaceId: keyWrappers.spaceId })
        .from(keyWrappers)
        .where(and(
          eq(keyWrappers.userId, userId),
          eq(keyWrappers.kind, "password"),
          eq(keyWrappers.credentialId, "password"),
        ))
        .limit(1);
      if (existing !== undefined) return { error: "already_provisioned" as const };

      const owned = await tx.select({ id: spaces.id }).from(spaces).where(eq(spaces.userId, userId));
      const expected = owned.map((space) => space.id).sort();
      const supplied = input.wrappers.map((wrapper) => wrapper.spaceId).sort();
      if (expected.length !== supplied.length || expected.some((id, index) => id !== supplied[index])) {
        return { error: "spaces_changed" as const };
      }

      const createdAt = new Date(now());
      await tx.insert(keyWrappers).values(input.wrappers.map((wrapper) => ({
        userId,
        spaceId: wrapper.spaceId,
        kind: "password",
        credentialId: "password",
        salt: wrapper.salt,
        wrapped: wrapper.wrapped,
        createdAt,
      })));
      await audit(
        userId,
        "keys.account_provisioned",
        { spaces: input.wrappers.map((wrapper) => wrapper.spaceId) },
        c.get("deviceId"),
        tx,
      );
      return { created: true as const };
    });
    if ("error" in result) {
      return c.json({ error: result.error }, result.error === "already_provisioned" ? 409 : 400);
    }
    return c.json({ provisioned: true }, 201);
  });

  /**
   * An anonymous account becomes a real one IN PLACE: the same user id, the
   * same device, the same meter — so there is nothing to move and nothing to
   * lose. It gains an email and a credential row exactly as `signUpEmail`
   * would have written them, in one transaction, and from then on BetterAuth
   * knows it like any other. The device's token stays good throughout.
   */
  v1.post("/account/upgrade", validate(signupSchema), async (c) => {
    const userId = c.get("userId");
    if (!c.get("anonymous")) return c.json({ error: "not_anonymous" }, 409);
    if (c.get("deviceId") === null) return c.json({ error: "device_required" }, 403);
    const input = body(c, signupSchema);
    const email = input.email.toLowerCase();
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (existing) return c.json({ error: "email_taken" }, 409);
    const hash = await (await idp.$context).password.hash(input.password);
    const at = new Date(now());
    try {
      const upgraded = await db.transaction(async (tx) => {
        const [user] = await tx
          .update(users)
          .set({ email, name: email.split("@")[0] ?? email, isAnonymous: false, updatedAt: at })
          .where(and(eq(users.id, userId), eq(users.isAnonymous, true)))
          .returning({ id: users.id });
        if (!user) return false;
        await tx.insert(authAccounts).values({
          id: randomUUID(),
          userId,
          accountId: userId,
          providerId: "credential",
          issuer: CREDENTIAL_ISSUER,
          password: hash,
          createdAt: at,
          updatedAt: at,
        });
        await audit(userId, "account.upgraded", { email }, c.get("deviceId"), tx);
        return true;
      });
      // Two upgrades raced and the other one won.
      if (!upgraded) return c.json({ error: "not_anonymous" }, 409);
    } catch (err) {
      if (uniqueViolation(err) !== null) return c.json({ error: "email_taken" }, 409);
      throw err;
    }
    return c.json({ userId, email });
  });

  /**
   * Signing in to an EXISTING account from a Mac that has an anonymous one:
   * the anonymous account is folded into the real one and deleted. The
   * caller proves both — the bearer is the real account's (a password login
   * a moment ago), `anonymousToken` is the anonymous device's own.
   *
   * What moves is everything an anonymous account can have: its meter (so
   * the month's spend is still the person's, under their own cap), its
   * audit trail, a recorded onboarding, and the device itself — re-parented
   * rather than re-enrolled, so this Mac keeps its one id (D24) and the
   * answer is its new token. The anonymous account's Spaces hold nothing
   * (its allow-list never let it write one) and go with the row.
   */
  v1.post("/account/link", validate(accountLinkSchema), async (c) => {
    const userId = c.get("userId");
    if (c.get("anonymous")) return c.json({ error: "account_required" }, 403);
    const from = await authenticateToken(db, signing, body(c, accountLinkSchema).anonymousToken, nowSeconds());
    if (from === null || from.revoked || from.deviceId === null) {
      return c.json({ error: "invalid_anonymous_token" }, 403);
    }
    if (!from.anonymous || from.userId === userId) return c.json({ error: "not_anonymous" }, 409);
    const fromDeviceId = from.deviceId;
    const moved = await db.transaction(async (tx) => {
      // Lock the row and re-read the flag: an upgrade may have raced this.
      const [source] = await tx
        .select({ isAnonymous: users.isAnonymous, onboardingCompletedAt: users.onboardingCompletedAt })
        .from(users)
        .where(eq(users.id, from.userId))
        .for("update");
      if (!source?.isAnonymous) return null;
      const usage = await tx
        .update(aiUsage)
        .set({ userId })
        .where(eq(aiUsage.userId, from.userId))
        .returning({ id: aiUsage.id });
      await tx.update(auditEvents).set({ userId }).where(eq(auditEvents.userId, from.userId));
      await tx.update(devices).set({ userId, lastSeenAt: new Date(now()) }).where(eq(devices.id, fromDeviceId));
      if (source.onboardingCompletedAt !== null) {
        await tx
          .update(users)
          .set({ onboardingCompletedAt: sql`coalesce(${users.onboardingCompletedAt}, ${source.onboardingCompletedAt.toISOString()}::timestamptz)` })
          .where(eq(users.id, userId));
      }
      // A model answer this account started may still be streaming: its
      // meter row lands after the user is gone, and follows this to `userId`
      // (`recordAiUsage`), so the spend still counts toward the cap.
      await tx
        .insert(accountLinks)
        .values({ fromUserId: from.userId, toUserId: userId, linkedAt: new Date(now()) })
        .onConflictDoUpdate({ target: accountLinks.fromUserId, set: { toUserId: userId, linkedAt: new Date(now()) } });
      await tx.delete(users).where(eq(users.id, from.userId));
      await audit(
        userId,
        "account.linked",
        { anonymousUserId: from.userId, deviceId: fromDeviceId, usageRows: usage.length },
        fromDeviceId,
        tx,
      );
      return { usageRows: usage.length };
    });
    if (moved === null) return c.json({ error: "not_anonymous" }, 409);
    const [device] = await db.select().from(devices).where(eq(devices.id, fromDeviceId));
    if (!device) return c.json({ error: "internal" }, 500);
    const token = await mintToken(userId, fromDeviceId);
    return c.json({ linked: true, usageRows: moved.usageRows, device: deviceView(device), ...token });
  });

  v1.get("/me", async (c) => {
    const userId = c.get("userId");
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) return c.json({ error: "not_found" }, 404);
    const [gateway] = await db.select().from(egressGateways).where(eq(egressGateways.userId, userId));
    const requestUrl = new URL(c.req.url);
    const forwardedProto = c.req.header("x-forwarded-proto");
    const secure = forwardedProto === "https" || requestUrl.protocol === "https:";
    const hubUrl = env["HUB_PUBLIC_URL"] ?? `${secure ? "wss" : "ws"}://${c.req.header("host") ?? requestUrl.host}/v1/hub/ws`;
    const features: string[] = ["sync"];
    if (runnerRef.current !== null) features.push("cloud-browser");
    if (egress.provider !== null) features.push("egress");
    if (imessage !== null) features.push("imessage");
    return c.json({
      userId: user.id,
      email: user.email,
      anonymous: user.isAnonymous,
      onboardingCompletedAt: user.onboardingCompletedAt?.toISOString() ?? null,
      hubUrl,
      cloudBrowserUrl: env["CLOUD_BROWSER_PUBLIC_URL"] ?? null,
      browserUrl: browserPublicUrl,
      egress: gateway ? { host: gateway.host, port: gateway.port } : null,
      features,
    });
  });

  // Account-wide, device-authenticated, and safe to retry after a lost reply.
  // Never accept a user id or timestamp supplied by the caller.
  v1.post("/me/onboarding/complete", async (c) => {
    const [user] = await db
      .update(users)
      .set({ onboardingCompletedAt: sql`coalesce(${users.onboardingCompletedAt}, ${new Date(now()).toISOString()}::timestamptz)` })
      .where(eq(users.id, c.get("userId")))
      .returning({ onboardingCompletedAt: users.onboardingCompletedAt });
    if (!user) return c.json({ error: "not_found" }, 404);
    return c.json({ onboardingCompletedAt: user.onboardingCompletedAt!.toISOString() });
  });

  /* ---------------------------------------------------------------- *
   * Models: the desktop's AI SDK calls, under the operator's gateway key
   * ---------------------------------------------------------------- */

  // Device-only by the tier above (a bootstrap token gets `device_required`,
  // a cloud device `cloud_device_forbidden`); the handler swaps the
  // credential and streams the gateway's answer back. Every request lands a
  // meter row once its answer has ended (ai-usage.ts).
  v1.all(
    "/ai/*",
    aiProxyHandler({
      env,
      ...options.ai,
      now,
      onUsage: (sample) => track(recordAiUsage(db, sample)),
      // The account's own monthly cap (ai-usage.ts): reached, nothing is
      // forwarded and nothing is spent.
      guard: async (c) => {
        const userId = c.get("userId");
        if (!c.get("anonymous")) return (await aiCapReached(db, userId, now())) ? c.json(AI_BUDGET_EXCEEDED, 403) : null;
        // An anonymous account (src/anonymous.ts): an allowance it cannot
        // raise, and a pace — tighter for the models the operator named.
        const policy = anonymousAiPolicy(env);
        if (await aiAllowanceReached(db, userId, now(), policy.monthlyUsd)) return c.json(ANONYMOUS_BUDGET_EXCEEDED, 403);
        const modelId = c.req.header("ai-model-id")?.trim().toLowerCase() ?? "";
        const retryAfter =
          anonymousAi.take(userId, policy.requestsPerMinute) ??
          (policy.slowModels.has(modelId) ? anonymousAi.take(`${userId}:${modelId}`, policy.slowRequestsPerMinute) : null);
        if (retryAfter === null) return null;
        return c.json(ANONYMOUS_RATE_LIMITED, 429, { "retry-after": String(retryAfter) });
      },
    }),
  );

  /** The account's model spend: today and this month, the month by model, and its cap. */
  v1.get("/ai-usage", async (c) =>
    c.json(
      await aiUsageSummary(
        db,
        c.get("userId"),
        now(),
        c.get("anonymous") ? anonymousAiPolicy(env).monthlyUsd : undefined,
      ),
    ),
  );

  /** The account's monthly spend cap, in USD; null removes it. */
  v1.put("/ai-usage/cap", validate(aiCapSchema), async (c) => {
    const userId = c.get("userId");
    const cap = parseMonthlyCap(body(c, aiCapSchema).monthlyUsd);
    if (cap === undefined) return c.json({ error: "invalid_cap" }, 400);
    await setAiMonthlyCap(db, userId, cap, now());
    await audit(userId, "ai.cap", { monthlyUsd: cap }, c.get("deviceId"));
    return c.json(await aiUsageSummary(db, userId, now()));
  });

  /* ---------------------------------------------------------------- *
   * iMessage account link
   * ---------------------------------------------------------------- */

  v1.get(
    "/imessage/onboarding/:token",
    validateParam(imessageOnboardingParamSchema),
    async (c) => {
      c.header("cache-control", "private, no-store, max-age=0");
      if (imessage === null) return c.json({ error: "imessage_unavailable" }, 503);
      const { token } = param(c, imessageOnboardingParamSchema);
      const [invitation] = await db
        .select()
        .from(imessageOnboardingLinks)
        .where(eq(imessageOnboardingLinks.secretHash, sha256Hex(token)));
      if (invitation === undefined || invitation.consumedAt !== null || invitation.expiresAt.getTime() <= now()) {
        return c.json({ error: "onboarding_link_invalid" }, 410);
      }
      const [linked] = await db
        .select({ userId: imessageLinks.userId })
        .from(imessageLinks)
        .where(eq(imessageLinks.phoneE164, invitation.phoneE164));
      if (linked !== undefined) return c.json({ error: "onboarding_link_invalid" }, 410);
      return c.json({
        phone: maskPhoneNumber(invitation.phoneE164),
        expiresAt: invitation.expiresAt.toISOString(),
      });
    },
  );

  v1.post(
    "/imessage/onboarding/:token/claim",
    validateParam(imessageOnboardingParamSchema),
    async (c) => {
      if (imessage === null) return c.json({ error: "imessage_unavailable" }, 503);
      const userId = c.get("userId");
      const { token } = param(c, imessageOnboardingParamSchema);
      const consumedAt = new Date(now());
      try {
        const result = await db.transaction(async (tx) => {
          const [invitation] = await tx
            .select()
            .from(imessageOnboardingLinks)
            .where(eq(imessageOnboardingLinks.secretHash, sha256Hex(token)))
            .for("update");
          if (
            invitation === undefined ||
            invitation.consumedAt !== null ||
            invitation.expiresAt.getTime() <= now()
          ) return { error: "onboarding_link_invalid" as const };

          const [owner] = await tx
            .select({ userId: imessageLinks.userId })
            .from(imessageLinks)
            .where(eq(imessageLinks.phoneE164, invitation.phoneE164));
          if (owner !== undefined && owner.userId !== userId) {
            return { error: "phone_already_linked" as const };
          }

          await tx
            .insert(imessageLinks)
            .values({
              userId,
              phoneE164: invitation.phoneE164,
              verifiedAt: consumedAt,
              createdAt: consumedAt,
              updatedAt: consumedAt,
            })
            .onConflictDoUpdate({
              target: imessageLinks.userId,
              set: { phoneE164: invitation.phoneE164, verifiedAt: consumedAt, updatedAt: consumedAt },
            });
          // Consuming one invitation invalidates every outstanding link sent
          // to this number, including links created by later messages.
          await tx
            .update(imessageOnboardingLinks)
            .set({ consumedAt })
            .where(and(
              eq(imessageOnboardingLinks.phoneE164, invitation.phoneE164),
              isNull(imessageOnboardingLinks.consumedAt),
            ));
          await tx.delete(imessageChallenges).where(eq(imessageChallenges.userId, userId));
          await audit(
            userId,
            "imessage.onboarding_claimed",
            { phone: maskPhoneNumber(invitation.phoneE164) },
            c.get("deviceId"),
            tx,
          );
          return { phone: maskPhoneNumber(invitation.phoneE164) };
        });
        if ("error" in result) {
          return c.json(
            { error: result.error },
            result.error === "phone_already_linked" ? 409 : 410,
          );
        }
        return c.json({ linked: true, phone: result.phone, verifiedAt: consumedAt.toISOString() });
      } catch (error) {
        if (uniqueViolation(error) !== null) return c.json({ error: "phone_already_linked" }, 409);
        throw error;
      }
    },
  );

  v1.get("/imessage/link", async (c) => {
    const link = await imessageLinkFor(c.get("userId"));
    return c.json({
      available: imessage !== null,
      linked: link !== undefined,
      phone: link === undefined ? null : maskPhoneNumber(link.phoneE164),
      verifiedAt: link?.verifiedAt.toISOString() ?? null,
    });
  });

  v1.post("/imessage/link/start", validate(imessageStartSchema), async (c) => {
    if (imessage === null) return c.json({ error: "imessage_unavailable" }, 503);
    const userId = c.get("userId");
    const phoneE164 = normalizePhoneNumber(body(c, imessageStartSchema).phone);
    if (phoneE164 === null) return c.json({ error: "invalid_phone" }, 400);
    if (!imessageStartsByUser.allow(userId) || !imessageStartsByPhone.allow(phoneE164)) {
      return c.json({ error: "rate_limited" }, 429);
    }
    const challengeId = randomUUID();
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const createdAt = new Date(now());
    const expiresAt = new Date(createdAt.getTime() + IMESSAGE_OTP_TTL_MS);
    await db.transaction(async (tx) => {
      await tx.delete(imessageChallenges).where(eq(imessageChallenges.userId, userId));
      await tx.insert(imessageChallenges).values({
        id: challengeId,
        userId,
        phoneE164,
        codeHash: otpHash(challengeId, code),
        attempts: 0,
        expiresAt,
        createdAt,
      });
    });
    try {
      await imessage.sendOtp(phoneE164, code, challengeId);
    } catch (error) {
      await db.delete(imessageChallenges).where(eq(imessageChallenges.id, challengeId));
      log(`iMessage OTP delivery failed: ${errorMessage(error)}`);
      return c.json({ error: "otp_delivery_failed" }, 502);
    }
    await audit(userId, "imessage.otp_sent", { phone: maskPhoneNumber(phoneE164) }, c.get("deviceId"));
    return c.json({ challengeId, phone: maskPhoneNumber(phoneE164), expiresAt: expiresAt.toISOString() }, 202);
  });

  v1.post("/imessage/link/verify", validate(imessageVerifySchema), async (c) => {
    if (imessage === null) return c.json({ error: "imessage_unavailable" }, 503);
    const userId = c.get("userId");
    const input = body(c, imessageVerifySchema);
    if (!imessageVerifiesByUser.allow(userId)) return c.json({ error: "rate_limited" }, 429);
    // Claim the attempt atomically in SQL: concurrent guesses each consume
    // one of the five, so the budget cannot be multiplied by firing them in
    // parallel. A row past its budget or its TTL is removed rather than
    // left for a later guess.
    const [challenge] = await db
      .update(imessageChallenges)
      .set({ attempts: sql`${imessageChallenges.attempts} + 1` })
      .where(and(
        eq(imessageChallenges.id, input.challengeId),
        eq(imessageChallenges.userId, userId),
        lt(imessageChallenges.attempts, IMESSAGE_OTP_MAX_ATTEMPTS),
      ))
      .returning();
    if (challenge === undefined || challenge.expiresAt.getTime() <= now()) {
      await db
        .delete(imessageChallenges)
        .where(and(eq(imessageChallenges.id, input.challengeId), eq(imessageChallenges.userId, userId)));
      return c.json({ error: "invalid_code" }, 403);
    }
    if (!secretEquals(otpHash(challenge.id, input.code), challenge.codeHash)) {
      if (challenge.attempts >= IMESSAGE_OTP_MAX_ATTEMPTS) {
        await db.delete(imessageChallenges).where(eq(imessageChallenges.id, challenge.id));
      }
      return c.json({ error: "invalid_code" }, 403);
    }
    const verifiedAt = new Date(now());
    try {
      await db.transaction(async (tx) => {
        await tx
          .insert(imessageLinks)
          .values({ userId, phoneE164: challenge.phoneE164, verifiedAt, createdAt: verifiedAt, updatedAt: verifiedAt })
          .onConflictDoUpdate({
            target: imessageLinks.userId,
            set: { phoneE164: challenge.phoneE164, verifiedAt, updatedAt: verifiedAt },
          });
        await tx.delete(imessageChallenges).where(eq(imessageChallenges.id, challenge.id));
      });
    } catch (error) {
      if (uniqueViolation(error) !== null) return c.json({ error: "phone_already_linked" }, 409);
      throw error;
    }
    await audit(userId, "imessage.linked", { phone: maskPhoneNumber(challenge.phoneE164) }, c.get("deviceId"));
    return c.json({ available: true, linked: true, phone: maskPhoneNumber(challenge.phoneE164), verifiedAt: verifiedAt.toISOString() });
  });

  v1.delete("/imessage/link", async (c) => {
    const userId = c.get("userId");
    await db.transaction(async (tx) => {
      await tx.delete(imessagePendingQuestions).where(eq(imessagePendingQuestions.userId, userId));
      await tx.delete(imessageChallenges).where(eq(imessageChallenges.userId, userId));
      await tx.delete(imessageLinks).where(eq(imessageLinks.userId, userId));
    });
    await audit(userId, "imessage.unlinked", {}, c.get("deviceId"));
    return c.body(null, 204);
  });

  v1.get("/internal/users/:userId/imessage-link", validateParam(userParamSchema), async (c) => {
    const link = await imessageLinkFor(param(c, userParamSchema).userId);
    return c.json({ available: imessage !== null, linked: imessage !== null && link !== undefined });
  });

  /* ---------------------------------------------------------------- *
   * Hosted artifacts and notes
   *
   * One table, one share-id space, one publish path, one public CSP
   * (docs/notes.md N9). `kind` is what tells the two apart, and every helper
   * below takes it: a note's share id must not answer at the artifact route,
   * and an artifact's must not answer at the note route, even though a share
   * id is unique across both.
   * ---------------------------------------------------------------- */

  const ownedHosted = async (userId: string, id: string, kind: HostedArtifactKind) => {
    const [row] = await db
      .select()
      .from(hostedArtifacts)
      .where(and(
        eq(hostedArtifacts.userId, userId),
        eq(hostedArtifacts.artifactId, id),
        eq(hostedArtifacts.kind, kind),
      ));
    return row;
  };

  /** The row under this id whatever it holds — the one place kinds could collide. */
  const hostedOfAnyKind = async (userId: string, id: string) => {
    const [row] = await db
      .select()
      .from(hostedArtifacts)
      .where(and(eq(hostedArtifacts.userId, userId), eq(hostedArtifacts.artifactId, id)));
    return row;
  };

  const publishHostedRevision = async (
    userId: string,
    id: string,
    input: z.infer<typeof artifactRevisionSchema>,
    kind: HostedArtifactKind,
  ): Promise<HostedArtifactRow | null> => {
    if (Buffer.byteLength(input.html, "utf8") > MAX_ARTIFACT_HTML_BYTES) return null;
    const held = await ownedHosted(userId, id, kind);
    if (held === undefined || held.visibility !== "public" || input.revision < held.revision) return null;
    const [updated] = await db
      .update(hostedArtifacts)
      .set({
        revision: input.revision,
        publicHtml: input.html,
        updatedAt: new Date(now()),
      })
      .where(
        and(
          eq(hostedArtifacts.userId, userId),
          eq(hostedArtifacts.artifactId, id),
          eq(hostedArtifacts.kind, kind),
          eq(hostedArtifacts.visibility, "public"),
          lte(hostedArtifacts.revision, input.revision),
        ),
      )
      .returning();
    return updated ?? null;
  };

  /** The published body of one share id, or 404 — never the other kind's. */
  const publicHosted = async (shareId: string, kind: HostedArtifactKind): Promise<string | null> => {
    const [row] = await db
      .select({ html: hostedArtifacts.publicHtml })
      .from(hostedArtifacts)
      .where(and(
        eq(hostedArtifacts.shareId, shareId),
        eq(hostedArtifacts.kind, kind),
        eq(hostedArtifacts.visibility, "public"),
      ));
    return row?.html ?? null;
  };

  const listHosted = async (userId: string, kind: HostedArtifactKind) =>
    db
      .select()
      .from(hostedArtifacts)
      .where(and(eq(hostedArtifacts.userId, userId), eq(hostedArtifacts.kind, kind)))
      .orderBy(desc(hostedArtifacts.updatedAt), desc(hostedArtifacts.artifactId));

  /**
   * Publish or revoke one row. The refusals are returned rather than thrown so
   * both routes answer in the same words; `null` means the row is in hand.
   */
  const setHostedVisibility = async (
    c: Context<AppEnv>,
    userId: string,
    id: string,
    input: z.infer<typeof artifactVisibilitySchema>,
    kind: HostedArtifactKind,
  ): Promise<{ row: HostedArtifactRow } | { error: Response }> => {
    const existing = await hostedOfAnyKind(userId, id);
    // A 12-hex id is minted once per account, so this is a bug rather than a
    // collision — but answering it plainly beats overwriting the other kind.
    if (existing !== undefined && existing.kind !== kind) {
      return { error: c.json({ error: "id_in_use" }, 409) };
    }
    const held = existing;
    if (input.visibility === "public") {
      if (input.html === undefined || Buffer.byteLength(input.html, "utf8") > MAX_ARTIFACT_HTML_BYTES) {
        return { error: c.json({ error: "artifact_too_large" }, 413) };
      }
      if (held !== undefined && input.revision < held.revision) {
        return { error: c.json({ error: "stale_revision" }, 409) };
      }
    }
    const at = new Date(now());
    const revision = input.visibility === "private" && held !== undefined
      ? Math.max(held.revision, input.revision)
      : input.revision;
    const [row] = await db
      .insert(hostedArtifacts)
      .values({
        userId,
        artifactId: id,
        shareId: randomBytes(18).toString("base64url"),
        revision,
        kind,
        visibility: input.visibility,
        publicHtml: input.visibility === "public" ? input.html : null,
        createdAt: held?.createdAt ?? at,
        updatedAt: at,
        publishedAt: input.visibility === "public" ? at : null,
      })
      .onConflictDoUpdate({
        target: [hostedArtifacts.userId, hostedArtifacts.artifactId],
        set: {
          revision,
          visibility: input.visibility,
          publicHtml: input.visibility === "public" ? input.html : null,
          updatedAt: at,
          publishedAt: input.visibility === "public" ? (held?.publishedAt ?? at) : null,
        },
        // The earlier read makes the normal stale request cheap to reject;
        // this database-side guard also closes the race between two
        // publishers that started from the same observed revision, and keeps
        // a row of the other kind out of reach whichever way the race went.
        setWhere: input.visibility === "public"
          ? and(eq(hostedArtifacts.kind, kind), lte(hostedArtifacts.revision, input.revision))
          : eq(hostedArtifacts.kind, kind),
      })
      .returning();
    if (row === undefined) {
      const current = await hostedOfAnyKind(userId, id);
      if (current !== undefined && current.kind !== kind) return { error: c.json({ error: "id_in_use" }, 409) };
      if (input.visibility === "public" && current !== undefined && current.revision > input.revision) {
        return { error: c.json({ error: "stale_revision" }, 409) };
      }
      return { error: c.json({ error: "internal" }, 500) };
    }
    await audit(
      userId,
      `${kind}.${input.visibility === "public" ? "published" : "unpublished"}`,
      { [kind === "note" ? "noteId" : "artifactId"]: id, revision },
      c.get("deviceId"),
    );
    return { row };
  };

  v1.get("/public/artifacts/:shareId", validateParam(shareParamSchema), async (c) => {
    const html = await publicHosted(param(c, shareParamSchema).shareId, "artifact");
    return html === null ? c.json({ error: "not_found" }, 404) : artifactHtmlResponse(html);
  });

  v1.get("/artifacts", async (c) => {
    const rows = await listHosted(c.get("userId"), "artifact");
    return c.json({ artifacts: rows.map(hostedArtifactView) });
  });

  v1.get("/artifacts/:artifactId", validateParam(artifactParamSchema), async (c) => {
    const artifact = await ownedHosted(c.get("userId"), param(c, artifactParamSchema).artifactId, "artifact");
    return artifact === undefined
      ? c.json({ error: "not_found" }, 404)
      : c.json({ artifact: hostedArtifactView(artifact) });
  });

  v1.put(
    "/artifacts/:artifactId/visibility",
    validateParam(artifactParamSchema),
    validate(artifactVisibilitySchema),
    async (c) => {
      const outcome = await setHostedVisibility(
        c,
        c.get("userId"),
        param(c, artifactParamSchema).artifactId,
        body(c, artifactVisibilitySchema),
        "artifact",
      );
      return "error" in outcome ? outcome.error : c.json({ artifact: hostedArtifactView(outcome.row) });
    },
  );

  v1.put(
    "/artifacts/:artifactId/revision",
    validateParam(artifactParamSchema),
    validate(artifactRevisionSchema),
    async (c) => {
      const artifact = await publishHostedRevision(
        c.get("userId"),
        param(c, artifactParamSchema).artifactId,
        body(c, artifactRevisionSchema),
        "artifact",
      );
      return artifact === null
        ? c.json({ published: false })
        : c.json({ published: true, artifact: hostedArtifactView(artifact) });
    },
  );

  /* ------------------------------ notes ---------------------------- */

  v1.get("/public/notes/:shareId", validateParam(shareParamSchema), async (c) => {
    const html = await publicHosted(param(c, shareParamSchema).shareId, "note");
    return html === null ? c.json({ error: "not_found" }, 404) : artifactHtmlResponse(html);
  });

  v1.get("/notes", async (c) => {
    const rows = await listHosted(c.get("userId"), "note");
    return c.json({ notes: rows.map(hostedNoteView) });
  });

  v1.get("/notes/:noteId", validateParam(noteParamSchema), async (c) => {
    const note = await ownedHosted(c.get("userId"), param(c, noteParamSchema).noteId, "note");
    return note === undefined
      ? c.json({ error: "not_found" }, 404)
      : c.json({ note: hostedNoteView(note) });
  });

  v1.put(
    "/notes/:noteId/visibility",
    validateParam(noteParamSchema),
    validate(artifactVisibilitySchema),
    async (c) => {
      const outcome = await setHostedVisibility(
        c,
        c.get("userId"),
        param(c, noteParamSchema).noteId,
        body(c, artifactVisibilitySchema),
        "note",
      );
      return "error" in outcome ? outcome.error : c.json({ note: hostedNoteView(outcome.row) });
    },
  );

  v1.put(
    "/notes/:noteId/revision",
    validateParam(noteParamSchema),
    validate(artifactRevisionSchema),
    async (c) => {
      const note = await publishHostedRevision(
        c.get("userId"),
        param(c, noteParamSchema).noteId,
        body(c, artifactRevisionSchema),
        "note",
      );
      return note === null
        ? c.json({ published: false })
        : c.json({ published: true, note: hostedNoteView(note) });
    },
  );

  /* ---------------------------------------------------------------- *
   * Shared notes (docs/notes.md §9)
   *
   * The first cross-account authorisation control holds. Two tables: the
   * grant (`note_shares`, never deleted — revoked) and the plaintext body
   * the grant exists for (`shared_notes`), which is a deliberate departure
   * from end-to-end encryption, said plainly in the UI, and which is
   * deleted the moment the last live grant on its note goes.
   *
   * There is no invite step: a share names an account that already exists,
   * by exact email, and it is live from the moment it is made.
   * ---------------------------------------------------------------- */

  /**
   * THE ONE HELPER ALLOWED TO READ A ROW WHOSE OWNER IS NOT THE CALLER.
   *
   * Everywhere else in this file the predicate is `eq(<table>.userId,
   * c.get("userId"))` and authorisation is structural. Here the caller may
   * legitimately be someone the owner named, so the decision is made once,
   * in one place, and every shared-note route starts by calling it. A
   * revoked grant answers `null`, which the routes turn into 404: a
   * recipient whose access ended learns only that there is nothing there.
   */
  const noteAccess = async (
    userId: string,
    ownerId: string,
    noteId: string,
  ): Promise<"owner" | NoteShareRole | null> => {
    if (userId === ownerId) return "owner";
    const [row] = await db
      .select({ role: noteShares.role })
      .from(noteShares)
      .where(and(
        eq(noteShares.ownerUserId, ownerId),
        eq(noteShares.noteId, noteId),
        eq(noteShares.recipientUserId, userId),
        isNull(noteShares.revokedAt),
      ));
    return row?.role ?? null;
  };

  /** The live shares on one of the caller's own notes, oldest first. */
  const ownedShares = async (ownerId: string, noteId: string, handle: Db = db) =>
    handle
      .select({
        id: noteShares.id,
        email: users.email,
        role: noteShares.role,
        createdAt: noteShares.createdAt,
      })
      .from(noteShares)
      .innerJoin(users, eq(users.id, noteShares.recipientUserId))
      .where(and(
        eq(noteShares.ownerUserId, ownerId),
        eq(noteShares.noteId, noteId),
        isNull(noteShares.revokedAt),
      ))
      .orderBy(asc(noteShares.createdAt), asc(noteShares.id));

  const shareView = (row: { id: string; email: string | null; role: NoteShareRole; createdAt: Date }) => ({
    id: row.id,
    // Never null in practice: an anonymous account has no email, and one
    // cannot be resolved as a recipient (see the POST below).
    email: row.email ?? "",
    role: row.role,
    createdAt: row.createdAt.toISOString(),
  });

  /**
   * The plaintext must not outlive its reason to exist — the rule
   * `public_html` already follows when a note is made private. Called after
   * every revocation: no live grant left, no stored body.
   */
  const dropSharedBodyIfUnshared = async (ownerId: string, noteId: string, handle: Db = db): Promise<void> => {
    const [live] = await handle
      .select({ id: noteShares.id })
      .from(noteShares)
      .where(and(
        eq(noteShares.ownerUserId, ownerId),
        eq(noteShares.noteId, noteId),
        isNull(noteShares.revokedAt),
      ))
      .limit(1);
    if (live !== undefined) return;
    await handle
      .delete(sharedNotes)
      .where(and(eq(sharedNotes.ownerUserId, ownerId), eq(sharedNotes.noteId, noteId)));
  };

  const sharedNoteView = (row: typeof sharedNotes.$inferSelect) => ({
    title: row.title,
    markdown: row.markdown,
    revision: row.revision,
    updatedAt: row.updatedAt.toISOString(),
    updatedByUserId: row.updatedByUserId,
  });

  /* ------------------------------ the owner ------------------------------ */

  /**
   * Every grant this account has made, over all its notes. One request, so
   * the owner's Mac learns which of five hundred notes it has to keep a
   * shared body current for without asking about each one in turn. Its own
   * path, not `/notes/shares`: that would shadow a note id.
   */
  v1.get("/note-shares", async (c) => {
    const rows = await db
      .select({
        id: noteShares.id,
        noteId: noteShares.noteId,
        email: users.email,
        role: noteShares.role,
        createdAt: noteShares.createdAt,
      })
      .from(noteShares)
      .innerJoin(users, eq(users.id, noteShares.recipientUserId))
      .where(and(eq(noteShares.ownerUserId, c.get("userId")), isNull(noteShares.revokedAt)))
      .orderBy(asc(noteShares.noteId), asc(noteShares.createdAt));
    return c.json({ shares: rows.map((row) => ({ noteId: row.noteId, ...shareView(row) })) });
  });

  v1.get("/notes/:noteId/shares", validateParam(noteParamSchema), async (c) => {
    const rows = await ownedShares(c.get("userId"), param(c, noteParamSchema).noteId);
    return c.json({ shares: rows.map(shareView) });
  });

  v1.post(
    "/notes/:noteId/shares",
    validateParam(noteParamSchema),
    validate(noteShareBodySchema),
    async (c) => {
      const userId = c.get("userId");
      const { noteId } = param(c, noteParamSchema);
      const input = body(c, noteShareBodySchema);
      const email = input.email.toLowerCase();
      const [recipient] = await db
        .select({ id: users.id, isAnonymous: users.isAnonymous })
        .from(users)
        .where(eq(users.email, email));
      if (recipient !== undefined && recipient.id === userId) {
        return c.json({ error: "cannot_share_with_self" }, 400);
      }
      // No existence oracle: an email nobody here holds — and an anonymous
      // account, which holds no email at all and could not read a share —
      // gets the same 200 a real one does, with nothing in it. The owner's
      // UI says "no Pistachio account with that email"; a stranger
      // enumerating addresses learns the same thing either way.
      if (recipient === undefined || recipient.isAnonymous) {
        return c.json({ share: null, shares: (await ownedShares(userId, noteId)).map(shareView) });
      }
      const at = new Date(now());
      const [row] = await db
        .insert(noteShares)
        .values({
          ownerUserId: userId,
          noteId,
          recipientUserId: recipient.id,
          role: input.role,
          createdAt: at,
          revokedAt: null,
        })
        // Sharing again with someone already named is how a role is changed,
        // and how a revoked grant is restored.
        .onConflictDoUpdate({
          target: [noteShares.ownerUserId, noteShares.noteId, noteShares.recipientUserId],
          set: { role: input.role, revokedAt: null },
        })
        .returning();
      if (row === undefined) return c.json({ error: "internal" }, 500);
      await audit(userId, "note.shared", { noteId, shareId: row.id, role: row.role }, c.get("deviceId"));
      return c.json({
        share: shareView({ ...row, email }),
        shares: (await ownedShares(userId, noteId)).map(shareView),
      });
    },
  );

  v1.delete("/notes/:noteId/shares/:shareId", validateParam(noteShareParamSchema), async (c) => {
    const userId = c.get("userId");
    const { noteId, shareId } = param(c, noteShareParamSchema);
    const [revoked] = await db
      .update(noteShares)
      .set({ revokedAt: new Date(now()) })
      .where(and(
        eq(noteShares.id, shareId),
        eq(noteShares.ownerUserId, userId),
        eq(noteShares.noteId, noteId),
        isNull(noteShares.revokedAt),
      ))
      .returning();
    if (revoked === undefined) return c.json({ error: "not_found" }, 404);
    await audit(userId, "note.share_revoked", { noteId, shareId }, c.get("deviceId"));
    await dropSharedBodyIfUnshared(userId, noteId);
    return c.json({ shares: (await ownedShares(userId, noteId)).map(shareView) });
  });

  /**
   * The owner pushes the body every share reads. Sent by the owner's Mac
   * while a note has at least one live share; refused outright when it has
   * none, so a body is never stored without a grant behind it.
   */
  v1.put(
    "/notes/:noteId/shared",
    validateParam(noteParamSchema),
    validate(sharedNoteBodySchema),
    async (c) => {
      const userId = c.get("userId");
      const { noteId } = param(c, noteParamSchema);
      const input = body(c, sharedNoteBodySchema);
      if (Buffer.byteLength(input.markdown, "utf8") > MAX_NOTE_MARKDOWN_BYTES) {
        return c.json({ error: "note_too_large" }, 413);
      }
      const at = new Date(now());
      const outcome = await db.transaction(async (tx) => {
        const [live] = await tx
          .select({ id: noteShares.id })
          .from(noteShares)
          .where(and(
            eq(noteShares.ownerUserId, userId),
            eq(noteShares.noteId, noteId),
            isNull(noteShares.revokedAt),
          ))
          .limit(1);
        if (live === undefined) return "not_shared" as const;
        const [held] = await tx
          .select()
          .from(sharedNotes)
          .where(and(eq(sharedNotes.ownerUserId, userId), eq(sharedNotes.noteId, noteId)))
          .for("update");
        // The owner's revision is the sealed note's, which only ever climbs;
        // anything below what is held is a device that has not caught up.
        if (held !== undefined && input.revision < held.revision) return "stale" as const;
        const [row] = await tx
          .insert(sharedNotes)
          .values({
            ownerUserId: userId,
            noteId,
            title: input.title,
            markdown: input.markdown,
            revision: input.revision,
            updatedAt: at,
            updatedByUserId: null,
          })
          .onConflictDoUpdate({
            target: [sharedNotes.ownerUserId, sharedNotes.noteId],
            set: {
              title: input.title,
              markdown: input.markdown,
              revision: input.revision,
              updatedAt: at,
              updatedByUserId: null,
            },
          })
          .returning();
        return row ?? ("internal" as const);
      });
      if (outcome === "not_shared") return c.json({ error: "not_shared" }, 404);
      if (outcome === "stale") return c.json({ stale: true });
      if (outcome === "internal") return c.json({ error: "internal" }, 500);
      return c.json({ stale: false, note: sharedNoteView(outcome) });
    },
  );

  /** The owner reads back what an editor may have written. */
  v1.get("/notes/:noteId/shared", validateParam(noteParamSchema), async (c) => {
    const [row] = await db
      .select()
      .from(sharedNotes)
      .where(and(
        eq(sharedNotes.ownerUserId, c.get("userId")),
        eq(sharedNotes.noteId, param(c, noteParamSchema).noteId),
      ));
    return c.json({ note: row === undefined ? null : sharedNoteView(row) });
  });

  /* ---------------------------- the recipient ---------------------------- */

  /**
   * What has been shared with me. Read by `recipient_user_id = me`, so every
   * row this selects names the reader; `noteAccess` is what decides a read
   * keyed by someone else's (owner, note) pair.
   */
  v1.get("/shared-notes", async (c) => {
    const rows = await db
      .select({
        ownerId: noteShares.ownerUserId,
        ownerEmail: users.email,
        noteId: noteShares.noteId,
        role: noteShares.role,
        title: sharedNotes.title,
        revision: sharedNotes.revision,
        updatedAt: sharedNotes.updatedAt,
      })
      .from(noteShares)
      .innerJoin(users, eq(users.id, noteShares.ownerUserId))
      .leftJoin(
        sharedNotes,
        and(eq(sharedNotes.ownerUserId, noteShares.ownerUserId), eq(sharedNotes.noteId, noteShares.noteId)),
      )
      .where(and(eq(noteShares.recipientUserId, c.get("userId")), isNull(noteShares.revokedAt)))
      .orderBy(desc(noteShares.createdAt), asc(noteShares.noteId));
    return c.json({
      notes: rows.map((row) => ({
        ownerId: row.ownerId,
        ownerEmail: row.ownerEmail ?? "",
        noteId: row.noteId,
        // Null while the owner's device has not pushed the body yet.
        title: row.title,
        role: row.role,
        revision: row.revision,
        updatedAt: row.updatedAt?.toISOString() ?? null,
      })),
    });
  });

  v1.get("/shared-notes/:ownerId/:noteId", validateParam(sharedNoteParamSchema), async (c) => {
    const { ownerId, noteId } = param(c, sharedNoteParamSchema);
    const role = await noteAccess(c.get("userId"), ownerId, noteId);
    if (role === null) return c.json({ error: "not_found" }, 404);
    const [row] = await db
      .select()
      .from(sharedNotes)
      .where(and(eq(sharedNotes.ownerUserId, ownerId), eq(sharedNotes.noteId, noteId)));
    return c.json({ role, note: row === undefined ? null : sharedNoteView(row) });
  });

  v1.put(
    "/shared-notes/:ownerId/:noteId",
    validateParam(sharedNoteParamSchema),
    validate(sharedNoteBodySchema),
    async (c) => {
      const userId = c.get("userId");
      const { ownerId, noteId } = param(c, sharedNoteParamSchema);
      const input = body(c, sharedNoteBodySchema);
      if (Buffer.byteLength(input.markdown, "utf8") > MAX_NOTE_MARKDOWN_BYTES) {
        return c.json({ error: "note_too_large" }, 413);
      }
      const role = await noteAccess(userId, ownerId, noteId);
      // A viewer is told it is not there to write, not that it exists and is
      // refused; a revoked share is told nothing at all.
      if (role === null) return c.json({ error: "not_found" }, 404);
      if (role !== "editor") return c.json({ error: "forbidden" }, 403);
      const at = new Date(now());
      const outcome = await db.transaction(async (tx) => {
        const [held] = await tx
          .select()
          .from(sharedNotes)
          .where(and(eq(sharedNotes.ownerUserId, ownerId), eq(sharedNotes.noteId, noteId)))
          .for("update");
        // Nothing to edit until the owner's device has pushed the body once.
        if (held === undefined) return "not_found" as const;
        // An editor's save is a new revision on top of what it was shown;
        // anything not above what is held started from an older copy.
        if (input.revision <= held.revision) return "stale" as const;
        const [row] = await tx
          .update(sharedNotes)
          .set({
            title: input.title,
            markdown: input.markdown,
            revision: input.revision,
            updatedAt: at,
            updatedByUserId: userId,
          })
          .where(and(
            eq(sharedNotes.ownerUserId, ownerId),
            eq(sharedNotes.noteId, noteId),
            lt(sharedNotes.revision, input.revision),
          ))
          .returning();
        return row ?? ("stale" as const);
      });
      if (outcome === "not_found") return c.json({ error: "not_found" }, 404);
      if (outcome === "stale") return c.json({ error: "stale_revision" }, 409);
      return c.json({ note: sharedNoteView(outcome) });
    },
  );

  v1.get("/spaces", async (c) => {
    const userId = c.get("userId");
    const rows = await db
      .select()
      .from(spaces)
      .where(and(eq(spaces.userId, userId), ne(spaces.id, WORKSPACE_PSEUDO_SPACE_ID)))
      .orderBy(asc(spaces.createdAt), asc(spaces.id));
    const cloud = await liveCloudDevice(userId);
    const cloudSpaces = new Set<string>();
    if (cloud !== undefined) {
      const wrappers = await db
        .select({ spaceId: keyWrappers.spaceId })
        .from(keyWrappers)
        .where(and(
          eq(keyWrappers.userId, userId),
          eq(keyWrappers.kind, "device-x25519"),
          eq(keyWrappers.credentialId, cloud.id),
        ));
      for (const wrapper of wrappers) cloudSpaces.add(wrapper.spaceId);
    }
    return c.json({
      spaces: rows.map((s) => ({
        id: s.id,
        name: s.name,
        createdAt: s.createdAt.toISOString(),
        cloudEnabled: cloudSpaces.has(s.id),
      })),
    });
  });

  v1.get("/spaces/:id/wrappers", validateParam(spaceParamSchema), async (c) => {
    const userId = c.get("userId");
    const { id } = param(c, spaceParamSchema);
    const space = await ownedSpace(userId, id);
    if (!space) return c.json({ error: "not_found" }, 404);
    const conditions = [eq(keyWrappers.userId, userId), eq(keyWrappers.spaceId, id)];
    if (c.get("platform") === "cloud") {
      const did = c.get("deviceId") ?? "";
      conditions.push(eq(keyWrappers.kind, "device-x25519"), eq(keyWrappers.credentialId, did));
    }
    const rows = await db
      .select()
      .from(keyWrappers)
      .where(and(...conditions))
      .orderBy(asc(keyWrappers.createdAt), asc(keyWrappers.kind), asc(keyWrappers.credentialId));
    return c.json({ wrappers: rows.map(wrapperView) });
  });

  /* ---------------------------------------------------------------- *
   * Credential vault (D28)
   *
   * Entries are listed with their ciphertext so the person's own device can
   * open them with the Space seal key; control only ever files, lists, and
   * deletes. Cloud devices are kept out by the bearer gate — a runner reaches
   * the vault through the lease-scoped internal routes further down, for
   * the one Space its run belongs to.
   * ---------------------------------------------------------------- */

  type VaultEntryRow = typeof vaultEntries.$inferSelect;
  const vaultEntryView = (row: VaultEntryRow): VaultEntry => ({
    id: row.id,
    spaceId: row.spaceId,
    siteOrigin: row.siteOrigin,
    siteName: row.siteName,
    fields: row.fields,
    source: row.source,
    sealedPayload: row.sealedPayload,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  });

  v1.get("/spaces/:id/vault", validateParam(spaceParamSchema), async (c) => {
    const userId = c.get("userId");
    const { id } = param(c, spaceParamSchema);
    const space = await ownedSpace(userId, id);
    if (!space) return c.json({ error: "not_found" }, 404);
    const rows = await db
      .select()
      .from(vaultEntries)
      .where(and(eq(vaultEntries.userId, userId), eq(vaultEntries.spaceId, id)))
      .orderBy(asc(vaultEntries.siteOrigin), desc(vaultEntries.updatedAt));
    c.header("cache-control", "no-store");
    return c.json({ entries: rows.map(vaultEntryView) });
  });

  v1.put(
    "/spaces/:id/vault/:entryId",
    validateParam(vaultEntryParamSchema),
    validate(putVaultEntrySchema),
    async (c) => {
      const userId = c.get("userId");
      const { id, entryId } = param(c, vaultEntryParamSchema);
      const input = body(c, putVaultEntrySchema);
      const space = await ownedSpace(userId, id);
      if (!space) return c.json({ error: "not_found" }, 404);
      const at = new Date(now());
      const siteOrigin = new URL(input.siteOrigin).origin;
      const result = await db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(vaultEntries)
          .where(eq(vaultEntries.id, entryId))
          .for("update");
        if (existing !== undefined && (existing.userId !== userId || existing.spaceId !== id)) {
          return { error: "not_found" as const };
        }
        const values = {
          siteOrigin,
          siteName: input.siteName,
          fields: input.fields,
          sealedPayload: input.sealedPayload,
          updatedAt: at,
        };
        const [row] = existing === undefined
          ? await tx
            .insert(vaultEntries)
            .values({ id: entryId, userId, spaceId: id, source: "manual", createdAt: at, ...values })
            .returning()
          : await tx.update(vaultEntries).set(values).where(eq(vaultEntries.id, entryId)).returning();
        if (row === undefined) throw new Error("vault entry write returned no row");
        await audit(
          userId,
          existing === undefined ? "vault.entry_created" : "vault.entry_updated",
          { entryId, spaceId: id, siteOrigin, fieldCount: input.fields.length },
          c.get("deviceId"),
          tx,
        );
        return { row, created: existing === undefined };
      });
      if ("error" in result) return c.json({ error: result.error }, 404);
      c.header("cache-control", "no-store");
      return c.json({ entry: vaultEntryView(result.row) }, result.created ? 201 : 200);
    },
  );

  v1.delete("/spaces/:id/vault/:entryId", validateParam(vaultEntryParamSchema), async (c) => {
    const userId = c.get("userId");
    const { id, entryId } = param(c, vaultEntryParamSchema);
    const space = await ownedSpace(userId, id);
    if (!space) return c.json({ error: "not_found" }, 404);
    const deleted = await db
      .delete(vaultEntries)
      .where(and(eq(vaultEntries.id, entryId), eq(vaultEntries.userId, userId), eq(vaultEntries.spaceId, id)))
      .returning({ siteOrigin: vaultEntries.siteOrigin });
    if (deleted.length === 0) return c.json({ error: "not_found" }, 404);
    await audit(userId, "vault.entry_deleted", { entryId, spaceId: id, siteOrigin: deleted[0]?.siteOrigin }, c.get("deviceId"));
    return c.json({ ok: true });
  });

  /* ---------------------------------------------------------------- *
   * Dedicated integrations (D29)
   *
   * A connection is a vault entry's cousin: the person's device obtains
   * an OAuth grant, seals the refresh token under the Space seal key, and
   * files it here with the provider, account, and access level in the
   * clear. Control lists, files, and deletes; it never holds a key that
   * opens the grant. Cloud devices reach a run's connections through the
   * lease-scoped internal routes further down.
   *
   * The OAuth clients themselves are the operator's, configured on this
   * server (`INTEGRATION_<PROVIDER>_CLIENT_ID` / `_CLIENT_SECRET`) and
   * handed to enrolled devices, which run the consent flow and refresh
   * tokens against the provider directly.
   * ---------------------------------------------------------------- */

  type IntegrationConnectionRow = typeof integrationConnections.$inferSelect;
  const integrationConnectionView = (row: IntegrationConnectionRow): IntegrationConnection => ({
    id: row.id,
    spaceId: row.spaceId,
    provider: row.provider,
    accountLabel: row.accountLabel,
    access: row.access,
    scopes: row.scopes,
    status: row.status,
    sealedPayload: row.sealedPayload,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  });

  /** The providers this server has an OAuth client for; the others are not offered. */
  const integrationProviders = (): IntegrationProviderConfig[] => {
    const configured: IntegrationProviderConfig[] = [];
    for (const provider of INTEGRATION_PROVIDERS) {
      const prefix = `INTEGRATION_${provider.toUpperCase()}`;
      const clientId = env[`${prefix}_CLIENT_ID`]?.trim();
      if (clientId === undefined || clientId === "") continue;
      const clientSecret = env[`${prefix}_CLIENT_SECRET`]?.trim();
      configured.push({ id: provider, clientId, clientSecret: clientSecret === undefined || clientSecret === "" ? null : clientSecret });
    }
    return configured;
  };

  v1.get("/integrations/providers", (c) => {
    c.header("cache-control", "no-store");
    return c.json({ providers: integrationProviders() });
  });

  v1.get("/spaces/:id/integrations", validateParam(spaceParamSchema), async (c) => {
    const userId = c.get("userId");
    const { id } = param(c, spaceParamSchema);
    const space = await ownedSpace(userId, id);
    if (!space) return c.json({ error: "not_found" }, 404);
    const rows = await db
      .select()
      .from(integrationConnections)
      .where(and(eq(integrationConnections.userId, userId), eq(integrationConnections.spaceId, id)))
      .orderBy(asc(integrationConnections.provider));
    c.header("cache-control", "no-store");
    return c.json({ connections: rows.map(integrationConnectionView) });
  });

  v1.put(
    "/spaces/:id/integrations/:connectionId",
    validateParam(integrationConnectionParamSchema),
    validate(putIntegrationConnectionSchema),
    async (c) => {
      const userId = c.get("userId");
      const { id, connectionId } = param(c, integrationConnectionParamSchema);
      const input = body(c, putIntegrationConnectionSchema);
      const space = await ownedSpace(userId, id);
      if (!space) return c.json({ error: "not_found" }, 404);
      const at = new Date(now());
      const result = await db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(integrationConnections)
          .where(eq(integrationConnections.id, connectionId))
          .for("update");
        if (existing !== undefined && (existing.userId !== userId || existing.spaceId !== id || existing.provider !== input.provider)) {
          return { error: "not_found" as const };
        }
        // A tombstone is a grant still to be revoked: it is neither
        // overwritten nor swept aside by a new grant. The device that can
        // open it revokes it first (its sweep runs before a connect), and
        // only then may the provider's slot in this Space be taken again.
        if (existing?.status === "revoke_pending") return { error: "revoke_pending" as const };
        const siblings = existing === undefined
          ? await tx
            .select({ id: integrationConnections.id, status: integrationConnections.status })
            .from(integrationConnections)
            .where(and(
              eq(integrationConnections.userId, userId),
              eq(integrationConnections.spaceId, id),
              eq(integrationConnections.provider, input.provider),
            ))
          : [];
        if (siblings.some((row) => row.status === "revoke_pending")) return { error: "revoke_pending" as const };
        // One account per provider per Space: a reconnect under a new id
        // replaces the old grant rather than sitting beside it.
        const replaced = siblings.length === 0
          ? []
          : await tx
            .delete(integrationConnections)
            .where(inArray(integrationConnections.id, siblings.map((row) => row.id)))
            .returning({ id: integrationConnections.id });
        const values = {
          accountLabel: input.accountLabel,
          access: input.access,
          scopes: input.scopes,
          status: "connected" as const,
          sealedPayload: input.sealedPayload,
          updatedAt: at,
        };
        const [row] = existing === undefined
          ? await tx
            .insert(integrationConnections)
            .values({ id: connectionId, userId, spaceId: id, provider: input.provider, createdAt: at, ...values })
            .returning()
          : await tx.update(integrationConnections).set(values).where(eq(integrationConnections.id, connectionId)).returning();
        if (row === undefined) throw new Error("integration connection write returned no row");
        await audit(
          userId,
          existing === undefined ? "integration.connected" : "integration.updated",
          { connectionId, spaceId: id, provider: input.provider, access: input.access, status: values.status, replaced: replaced.length },
          c.get("deviceId"),
          tx,
        );
        return { row, created: existing === undefined, replaced: replaced.length };
      });
      if ("error" in result) return c.json({ error: result.error }, result.error === "revoke_pending" ? 409 : 404);
      c.header("cache-control", "no-store");
      return c.json({ connection: integrationConnectionView(result.row), replaced: result.replaced }, result.created ? 201 : 200);
    },
  );

  // A grant the provider refused for good, found by a run on this Mac.
  // Exact id, never an upsert: a row already replaced by a fresh grant is
  // 404, not a resurrected dead one.
  v1.post(
    "/spaces/:id/integrations/:connectionId/status",
    validateParam(integrationConnectionParamSchema),
    validate(integrationStatusSchema),
    async (c) => {
      const userId = c.get("userId");
      const { id, connectionId } = param(c, integrationConnectionParamSchema);
      const { status } = body(c, integrationStatusSchema);
      const [row] = await db
        .update(integrationConnections)
        .set({ status, updatedAt: new Date(now()) })
        .where(and(
          eq(integrationConnections.id, connectionId),
          eq(integrationConnections.userId, userId),
          eq(integrationConnections.spaceId, id),
          eq(integrationConnections.status, "connected"),
        ))
        .returning();
      if (row === undefined) return c.json({ error: "not_found" }, 404);
      await audit(userId, "integration.status", { connectionId, spaceId: id, provider: row.provider, status }, c.get("deviceId"));
      return c.json({ connection: integrationConnectionView(row) });
    },
  );

  // A disconnect from a device that holds no Space key (the web app): the
  // row becomes a tombstone — unusable from this moment, its ciphertext
  // kept — until a device that can open the grant revokes it at the
  // provider and deletes the row. Idempotent.
  v1.post("/spaces/:id/integrations/:connectionId/disconnect", validateParam(integrationConnectionParamSchema), async (c) => {
    const userId = c.get("userId");
    const { id, connectionId } = param(c, integrationConnectionParamSchema);
    const [row] = await db
      .update(integrationConnections)
      .set({ status: "revoke_pending", updatedAt: new Date(now()) })
      .where(and(eq(integrationConnections.id, connectionId), eq(integrationConnections.userId, userId), eq(integrationConnections.spaceId, id)))
      .returning();
    if (row === undefined) return c.json({ error: "not_found" }, 404);
    await audit(userId, "integration.disconnect_requested", { connectionId, spaceId: id, provider: row.provider }, c.get("deviceId"));
    return c.json({ connection: integrationConnectionView(row) });
  });

  // A desktop run used the connection: the same stamp the runner's route
  // makes, so Settings shows the last use whichever device made it.
  v1.post("/spaces/:id/integrations/:connectionId/used", validateParam(integrationConnectionParamSchema), async (c) => {
    const userId = c.get("userId");
    const { id, connectionId } = param(c, integrationConnectionParamSchema);
    const [row] = await db
      .update(integrationConnections)
      .set({ lastUsedAt: new Date(now()) })
      .where(and(eq(integrationConnections.id, connectionId), eq(integrationConnections.userId, userId), eq(integrationConnections.spaceId, id)))
      .returning();
    if (row === undefined) return c.json({ error: "not_found" }, 404);
    await audit(userId, "integration.used", { connectionId, spaceId: id, provider: row.provider }, c.get("deviceId"));
    return c.json({ connection: integrationConnectionView(row) });
  });

  v1.delete("/spaces/:id/integrations/:connectionId", validateParam(integrationConnectionParamSchema), async (c) => {
    const userId = c.get("userId");
    const { id, connectionId } = param(c, integrationConnectionParamSchema);
    const space = await ownedSpace(userId, id);
    if (!space) return c.json({ error: "not_found" }, 404);
    const deleted = await db
      .delete(integrationConnections)
      .where(and(eq(integrationConnections.id, connectionId), eq(integrationConnections.userId, userId), eq(integrationConnections.spaceId, id)))
      .returning({ provider: integrationConnections.provider });
    if (deleted.length === 0) return c.json({ error: "not_found" }, 404);
    // The device revoked the grant at the provider before asking for this.
    await audit(userId, "integration.disconnected", { connectionId, spaceId: id, provider: deleted[0]?.provider }, c.get("deviceId"));
    return c.json({ ok: true });
  });

  /* ---------------------------------------------------------------- *
   * Device bearer (desktop)
   * ---------------------------------------------------------------- */

  v1.post("/auth/password", validate(changePasswordSchema), async (c) => {
    const userId = c.get("userId");
    const input = body(c, changePasswordSchema);
    const [account] = await db
      .select()
      .from(authAccounts)
      .where(and(eq(authAccounts.userId, userId), eq(authAccounts.providerId, "credential")));
    if (!account || account.password === null) return c.json({ error: "invalid_credentials" }, 403);
    if (!passwordAttempts.allow(`change:${userId}`)) return c.json({ error: "rate_limited" }, 429);
    const ctx = await idp.$context;
    const valid = await ctx.password.verify({ hash: account.password, password: input.currentPassword });
    // 403, not 401: to the desktop a 401 means "this bearer is dead".
    if (!valid) return c.json({ error: "invalid_credentials" }, 403);
    passwordAttempts.reset(`change:${userId}`);
    const hash = await ctx.password.hash(input.newPassword);
    await ctx.internalAdapter.updatePassword(userId, hash);
    await audit(userId, "auth.password_changed", {}, c.get("deviceId"));
    return c.json({ ok: true });
  });

  v1.get("/devices", async (c) => {
    const rows = await db
      .select()
      .from(devices)
      .where(eq(devices.userId, c.get("userId")))
      .orderBy(asc(devices.createdAt), asc(devices.id));
    return c.json({ devices: rows.map(deviceView) });
  });

  v1.patch("/devices/:id", validateParam(idParamSchema), validate(renameDeviceSchema), async (c) => {
    const userId = c.get("userId");
    const { id } = param(c, idParamSchema);
    const { name } = body(c, renameDeviceSchema);
    const [device] = await db
      .update(devices)
      .set({ name })
      .where(and(eq(devices.id, id), eq(devices.userId, userId), isNull(devices.revokedAt)))
      .returning();
    if (!device) return c.json({ error: "not_found" }, 404);
    await audit(userId, "device.renamed", { deviceId: id, name }, c.get("deviceId"));
    return c.json({ device: deviceView(device) });
  });

  v1.post("/devices/:id/revoke", validateParam(idParamSchema), async (c) => {
    const userId = c.get("userId");
    const { id } = param(c, idParamSchema);
    const [device] = await db.select().from(devices).where(and(eq(devices.id, id), eq(devices.userId, userId)));
    if (!device) return c.json({ error: "not_found" }, 404);
    await chained(userId, () => revokeDevice(userId, device, c.get("deviceId")));
    return c.json({ revoked: true, affectedOrigins: affectedOriginsOnRevoke() });
  });

  v1.put("/spaces/:id", validateParam(spaceParamSchema), validate(spaceBodySchema), async (c) => {
    const userId = c.get("userId");
    const { id } = param(c, spaceParamSchema);
    if (id === WORKSPACE_PSEUDO_SPACE_ID) return c.json({ error: "reserved_space" }, 400);
    const { name } = body(c, spaceBodySchema);
    const [space] = await db
      .insert(spaces)
      .values({ userId, id, name, createdAt: new Date(now()) })
      .onConflictDoUpdate({ target: [spaces.userId, spaces.id], set: { name } })
      .returning();
    if (!space) return c.json({ error: "internal" }, 500);
    return c.json({ space: { id: space.id, name: space.name, createdAt: space.createdAt.toISOString() } });
  });

  v1.delete("/spaces/:id", validateParam(spaceParamSchema), async (c) => {
    const userId = c.get("userId");
    const { id } = param(c, spaceParamSchema);
    if (id === WORKSPACE_PSEUDO_SPACE_ID || id === DEFAULT_SPACE_ID) {
      return c.json({ error: "reserved_space" }, 400);
    }
    // Channel links, hosted runs and their key wrappers cascade with the
    // Space (§7.1); without that this delete failed on the foreign keys.
    const deleted = await db
      .delete(spaces)
      .where(and(eq(spaces.userId, userId), eq(spaces.id, id)))
      .returning({ id: spaces.id });
    if (deleted.length === 0) return c.json({ error: "not_found" }, 404);
    await audit(userId, "space.deleted", { spaceId: id }, c.get("deviceId"));
    return c.body(null, 204);
  });

  v1.put("/spaces/:id/wrappers", validateParam(spaceParamSchema), validate(putWrappersSchema), async (c) => {
    const userId = c.get("userId");
    const deviceId = c.get("deviceId") ?? "";
    const { id } = param(c, spaceParamSchema);
    const input = body(c, putWrappersSchema);
    const space = await ownedSpace(userId, id);
    if (!space) return c.json({ error: "not_found" }, 404);
    const [sender] = await db.select().from(devices).where(eq(devices.id, deviceId));
    for (const wrapper of input.wrappers) {
      if (wrapper.kind === "device-x25519") {
        // A user device that holds the decrypted root secret may introduce
        // the account's cloud browser. Web devices are first-class key
        // custodians now: the secret is still wrapped client-side and the
        // sender must prove its enrolled Ed25519 identity exactly as a Mac.
        if (
          (c.get("platform") !== "macos" && c.get("platform") !== "web") ||
          wrapper.senderDeviceId !== deviceId ||
          wrapper.signature === undefined
        ) {
          return c.json({ error: "wrapper_sender" }, 403);
        }
        const [recipient] = await db
          .select()
          .from(devices)
          .where(
            and(
              eq(devices.id, wrapper.credentialId),
              eq(devices.userId, userId),
              eq(devices.platform, "cloud"),
              isNull(devices.revokedAt),
            ),
          );
        if (!recipient) return c.json({ error: "wrapper_sender" }, 403);
        const valid =
          sender !== undefined &&
          (await verifySignature(
            sender.devicePublicKey,
            wrapper.signature,
            deviceWrapperSigningBytes(id, wrapper.credentialId, wrapper.salt, wrapper.wrapped),
          ));
        if (!valid) return c.json({ error: "wrapper_signature" }, 400);
      } else if (wrapper.senderDeviceId !== undefined || wrapper.signature !== undefined) {
        return c.json({ error: "invalid_body", reason: "sender_fields_not_allowed" }, 400);
      }
    }
    const rows: WrapperRow[] = [];
    for (const wrapper of input.wrappers) {
      const values = {
        userId,
        spaceId: id,
        kind: wrapper.kind,
        credentialId: wrapper.credentialId,
        salt: wrapper.salt,
        wrapped: wrapper.wrapped,
        senderDeviceId: wrapper.senderDeviceId ?? null,
        signature: wrapper.signature ?? null,
        createdAt: new Date(now()),
      };
      const [row] = await db
        .insert(keyWrappers)
        .values(values)
        .onConflictDoUpdate({
          target: [keyWrappers.userId, keyWrappers.spaceId, keyWrappers.kind, keyWrappers.credentialId],
          set: {
            salt: values.salt,
            wrapped: values.wrapped,
            senderDeviceId: values.senderDeviceId,
            signature: values.signature,
            createdAt: values.createdAt,
          },
        })
        .returning();
      if (row) rows.push(row);
    }
    await audit(
      userId,
      "keys.wrappers_put",
      { spaceId: id, kinds: input.wrappers.map((w) => `${w.kind}:${w.credentialId}`) },
      c.get("deviceId"),
    );
    return c.json({ wrappers: rows.map(wrapperView) });
  });

  v1.delete("/spaces/:id/wrappers/:kind/:credentialId", validateParam(wrapperParamSchema), async (c) => {
    const userId = c.get("userId");
    const { id, kind, credentialId } = param(c, wrapperParamSchema);
    const deleted = await db
      .delete(keyWrappers)
      .where(
        and(
          eq(keyWrappers.userId, userId),
          eq(keyWrappers.spaceId, id),
          eq(keyWrappers.kind, kind),
          eq(keyWrappers.credentialId, credentialId),
        ),
      )
      .returning({ kind: keyWrappers.kind });
    if (deleted.length === 0) return c.json({ error: "not_found" }, 404);
    await audit(userId, "keys.wrapper_removed", { spaceId: id, kind, credentialId }, c.get("deviceId"));
    return c.body(null, 204);
  });

  v1.get("/sync/policy", async (c) => {
    const rows = await db
      .select()
      .from(syncPolicyOverrides)
      .where(eq(syncPolicyOverrides.userId, c.get("userId")));
    const overrides: Record<string, string> = {};
    for (const row of rows) overrides[row.host] = row.mode;
    return c.json({ version: 1, origins: SEED_CORPUS, overrides });
  });

  v1.put(
    "/sync/policy/overrides/:host",
    validateParam(overrideParamSchema),
    validate(overrideBodySchema),
    async (c) => {
      const userId = c.get("userId");
      const host = param(c, overrideParamSchema).host.toLowerCase().replace(/^\./, "");
      const { mode } = body(c, overrideBodySchema);
      await db
        .insert(syncPolicyOverrides)
        .values({ userId, host, mode })
        .onConflictDoUpdate({ target: [syncPolicyOverrides.userId, syncPolicyOverrides.host], set: { mode } });
      return c.json({ host, mode });
    },
  );

  v1.delete("/sync/policy/overrides/:host", validateParam(overrideParamSchema), async (c) => {
    const host = param(c, overrideParamSchema).host.toLowerCase().replace(/^\./, "");
    await db
      .delete(syncPolicyOverrides)
      .where(and(eq(syncPolicyOverrides.userId, c.get("userId")), eq(syncPolicyOverrides.host, host)));
    return c.body(null, 204);
  });

  const gatewayView = (row: typeof egressGateways.$inferSelect) => ({
    host: row.host,
    port: row.port,
    egressIp: row.egressIpv4,
    region: row.region,
    state: row.state,
  });

  v1.get("/egress", async (c) => {
    const userId = c.get("userId");
    const deviceId = c.get("deviceId") ?? "";
    const [gateway] = await db.select().from(egressGateways).where(eq(egressGateways.userId, userId));
    // Only the desktop proxies through the identity gateway: the cloud
    // browser mints per-run credentials through the internal route, and a
    // `web` device has no proxy to point at one, so neither gets a
    // credential here.
    const credential =
      gateway && c.get("platform") === "macos"
        ? await mintEgressCredential(userId, deviceId, null)
        : null;
    return c.json({
      gateway: gateway ? gatewayView(gateway) : null,
      credential,
      policy: {
        mediaBypass: MEDIA_BYPASS_DOMAINS,
        hostileSeed: SEEDED_HOSTILE_DOMAINS,
        checkoutRules: HOSTED_CHECKOUT_RULES,
      },
    });
  });

  v1.post("/egress/provision", async (c) => {
    const userId = c.get("userId");
    const provider = egress.provider;
    if (provider === null) return c.json({ error: "egress_unavailable" }, 503);
    const [existing] = await db.select().from(egressGateways).where(eq(egressGateways.userId, userId));
    if (existing) return c.json({ gateway: gatewayView(existing) });
    let provisioned;
    try {
      provisioned = await provider.provision(userId, null);
    } catch (err) {
      log(`egress provision failed for ${userId}: ${errorMessage(err)}`);
      return c.json({ error: "egress_unavailable" }, 503);
    }
    const [gateway] = await db
      .insert(egressGateways)
      .values({
        userId,
        host: provisioned.host,
        port: provisioned.port,
        egressIpv4: provisioned.egressIp,
        region: provisioned.region,
        state: "ready",
        createdAt: new Date(now()),
      })
      .onConflictDoUpdate({
        target: egressGateways.userId,
        set: { host: provisioned.host, port: provisioned.port, egressIpv4: provisioned.egressIp, state: "ready" },
      })
      .returning();
    if (!gateway) return c.json({ error: "internal" }, 500);
    await audit(userId, "egress.provisioned", { host: gateway.host, port: gateway.port }, c.get("deviceId"));
    return c.json({ gateway: gatewayView(gateway) }, 201);
  });

  /* ---------------------------------------------------------------- *
   * Browser sessions (web-browser-design.md §4)
   * ---------------------------------------------------------------- */

  type BrowserSessionRow = typeof browserSessions.$inferSelect;

  /**
   * A session's wire shape (§4.2). The lease TOKEN never appears: it is a
   * worker credential, paired with the service bearer on the `/internal`
   * routes, so a device is told which worker holds the session and until
   * when, and not what the key is — the same rule `GET /runs/:id` follows.
   */
  const browserSessionView = (row: BrowserSessionRow, at: number): Record<string, unknown> => ({
    id: row.id,
    spaceId: row.spaceId,
    state: row.state,
    control: { holder: row.controlHolder, generation: row.controlGeneration },
    activeRunId: row.activeRunId,
    // A lapsed lease names a worker that has already let go; there is no
    // browser open anywhere, so the session reads as unheld.
    worker:
      row.leaseWorkerId !== null && row.leaseUntil !== null && row.leaseUntil.getTime() > at
        ? { id: row.leaseWorkerId, until: row.leaseUntil.toISOString() }
        : null,
    lastAttachedAt: row.lastAttachedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
  });

  const ownedSession = async (
    userId: string,
    sessionId: string,
    handle: Db = db,
  ): Promise<BrowserSessionRow | undefined> => {
    const [row] = await handle
      .select()
      .from(browserSessions)
      .where(and(eq(browserSessions.id, sessionId), eq(browserSessions.userId, userId)));
    return row;
  };

  const sessionLeaseLive = (row: BrowserSessionRow, at: number): boolean =>
    row.leaseUntil !== null && row.leaseUntil.getTime() > at;

  /** Every write to a session bumps its revision; the columns are otherwise the caller's. */
  const sessionUpdate = (
    changes: PgUpdateSetSource<typeof browserSessions>,
    at: number,
  ): PgUpdateSetSource<typeof browserSessions> => ({
    ...changes,
    revision: sql`${browserSessions.revision} + 1`,
    updatedAt: new Date(at),
  });

  const CLEAR_SESSION_LEASE = {
    leaseWorkerId: null,
    leaseWorkerUrl: null,
    leaseToken: null,
    leaseUntil: null,
  } as const;

  /**
   * Move a session's control fence (§4.3, W7). Every transition bumps the
   * generation, so an input or tool call issued under the previous holder is
   * stale by construction and the host drops it — the person never has to
   * race the agent for the keyboard. Answers the new generation, or null when
   * the session is gone or already ended.
   */
  const moveSessionControl = async (
    unit: Unit,
    sessionId: string,
    next: { holder: ControlHolder; activeRunId?: string | null },
  ): Promise<number | null> => {
    const [row] = await unit.tx
      .update(browserSessions)
      .set(
        sessionUpdate(
          {
            controlHolder: next.holder,
            controlGeneration: sql`${browserSessions.controlGeneration} + 1`,
            ...(next.activeRunId === undefined ? {} : { activeRunId: next.activeRunId }),
          },
          now(),
        ),
      )
      .where(and(eq(browserSessions.id, sessionId), ne(browserSessions.state, "ended")))
      .returning({ generation: browserSessions.controlGeneration });
    return row?.generation ?? null;
  };

  /** The `{t:'control'}` event carrying the generation the transition produced (§4.3). */
  const controlEvent = (holder: ControlHolder, generation: number | null): RunEvent =>
    generation === null
      ? { t: "control", control: holder }
      : { t: "control", control: holder, generation };

  /**
   * A run's session gives the wheel back to the person: the run reached a
   * terminal state, or interrupted and dropped its lease. "A session with no
   * run is always `human`" (§4.3), so `active_run_id` is cleared with it.
   */
  const releaseSessionForRun = async (unit: Unit, run: HostedRunRecord): Promise<number | null> =>
    run.sessionId === null
      ? null
      : moveSessionControl(unit, run.sessionId, { holder: "human", activeRunId: null });

  /** Append the control transition to the run's own stream, so every reader folds the same generation. */
  const appendControlEvent = async (
    unit: Unit,
    runId: string,
    holder: ControlHolder,
    generation: number,
    by: { leaseToken?: string; sponsorId?: string },
  ): Promise<void> => {
    await unit.sink.append(
      runId,
      [
        {
          eventId: `control:${runId}:${String(generation)}`,
          at: new Date(now()).toISOString(),
          event: controlEvent(holder, generation),
        },
      ],
      by,
    );
  };

  /**
   * Take (or renew) the session a claimed run acts in, and hand the wheel to
   * the agent: `holder = agent`, `generation += 1`, `active_run_id = runId`
   * (§4.3). Answers null when the session moved or ended under us, which
   * aborts the whole claim.
   */
  const attachRunSession = async (
    unit: Unit,
    run: HostedRunRecord,
    workerId: string,
    workerUrl: string | null,
    at: number,
  ): Promise<{ id: string; leaseToken: string; generation: number } | null> => {
    if (run.sessionId === null) return null;
    const [row] = await unit.tx.select().from(browserSessions).where(eq(browserSessions.id, run.sessionId));
    if (row === undefined || row.state === "ended") return null;
    const live = sessionLeaseLive(row, at);
    if (live && row.leaseWorkerId !== workerId) return null;
    const leaseToken = live && row.leaseWorkerId === workerId && row.leaseToken !== null ? row.leaseToken : randomUUID();
    const [claimed] = await unit.tx
      .update(browserSessions)
      .set(
        sessionUpdate(
          {
            state: "live",
            leaseWorkerId: workerId,
            leaseWorkerUrl: workerUrl,
            leaseToken,
            leaseUntil: new Date(at + SESSION_LEASE_MS),
            lastAttachedAt: new Date(at),
            controlHolder: "agent",
            controlGeneration: sql`${browserSessions.controlGeneration} + 1`,
            activeRunId: run.id,
          },
          at,
        ),
      )
      .where(and(eq(browserSessions.id, row.id), eq(browserSessions.revision, row.revision)))
      .returning({ generation: browserSessions.controlGeneration });
    if (claimed === undefined) return null;
    await appendControlEvent(unit, run.id, "agent", claimed.generation, { sponsorId: run.userId });
    return { id: row.id, leaseToken, generation: claimed.generation };
  };

  v1.post("/browser-sessions", validate(createBrowserSessionSchema), async (c) => {
    const userId = c.get("userId");
    const { spaceId } = body(c, createBrowserSessionSchema);
    const space = await ownedSpace(userId, spaceId);
    if (!space) return c.json({ error: "not_found" }, 404);
    // The same gate `POST /runs` uses: without a Space key wrapped to the
    // live cloud device the worker could open nothing in this Space.
    if (!(await spaceCloudEnabled(userId, spaceId))) {
      return c.json({ error: "space_not_cloud_enabled" }, 400);
    }
    if ((env["CLOUD_BROWSER_PUBLIC_URL"] ?? null) === null) {
      return c.json({ error: "no_cloud_browser" }, 503);
    }
    const at = new Date(now());
    // Create-or-resume. The partial unique index is the arbiter rather than a
    // read-then-write: two tabs opening the same Space at once must end up on
    // ONE session, or two Chromium contexts would race over one sealed
    // session record.
    const [created] = await db
      .insert(browserSessions)
      .values({ id: randomUUID(), userId, spaceId, createdAt: at, updatedAt: at })
      .onConflictDoNothing()
      .returning();
    if (created !== undefined) {
      await audit(userId, "session.created", { sessionId: created.id, spaceId }, c.get("deviceId"));
      return c.json({ session: browserSessionView(created, now()) }, 201);
    }
    const [existing] = await db
      .select()
      .from(browserSessions)
      .where(
        and(
          eq(browserSessions.userId, userId),
          eq(browserSessions.spaceId, spaceId),
          ne(browserSessions.state, "ended"),
        ),
      );
    if (existing === undefined) return c.json({ error: "conflict" }, 409);
    return c.json({ session: browserSessionView(existing, now()) });
  });

  v1.get("/browser-sessions", validateQuery(listBrowserSessionsQuerySchema), async (c) => {
    const userId = c.get("userId");
    const { spaceId } = query(c, listBrowserSessionsQuerySchema);
    const rows = await db
      .select()
      .from(browserSessions)
      .where(
        and(
          eq(browserSessions.userId, userId),
          ne(browserSessions.state, "ended"),
          spaceId === undefined ? undefined : eq(browserSessions.spaceId, spaceId),
        ),
      )
      .orderBy(desc(browserSessions.updatedAt), desc(browserSessions.id));
    const at = now();
    return c.json({ sessions: rows.map((row) => browserSessionView(row, at)) });
  });

  v1.get("/browser-sessions/:id", validateParam(idParamSchema), async (c) => {
    const row = await ownedSession(c.get("userId"), param(c, idParamSchema).id);
    if (row === undefined) return c.json({ error: "not_found" }, 404);
    return c.json({ session: browserSessionView(row, now()) });
  });

  /**
   * A shell socket ticket (§4.3, §5) — the session's twin of the live view's.
   * Minted whether or not the session is leased: the worker that redeems it
   * claims the session on demand (§6.4), so a suspended session comes back on
   * whichever worker the ticket happens to land on.
   */
  v1.post("/browser-sessions/:id/ticket", validateParam(idParamSchema), async (c) => {
    const userId = c.get("userId");
    const deviceId = c.get("deviceId");
    if (deviceId === null) return c.json({ error: "device_required" }, 403);
    const session = await ownedSession(userId, param(c, idParamSchema).id);
    if (session === undefined) return c.json({ error: "not_found" }, 404);
    if (session.state === "ended") return c.json({ error: "session_ended" }, 409);
    const url = env["CLOUD_BROWSER_PUBLIC_URL"] ?? null;
    if (url === null) return c.json({ error: "no_cloud_browser" }, 503);
    const ticket = `pst_${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(now() + LIVE_TICKET_TTL_SECONDS * 1000);
    await db.insert(sessionTickets).values({
      secretHash: sha256Hex(ticket),
      sessionId: session.id,
      userId,
      deviceId,
      createdAt: new Date(now()),
      expiresAt,
    });
    await audit(userId, "session.ticket", { sessionId: session.id }, deviceId);
    return c.json({ url, ticket, expiresAt: expiresAt.toISOString() });
  });

  v1.post("/browser-sessions/:id/end", validateParam(idParamSchema), async (c) => {
    const userId = c.get("userId");
    const deviceId = c.get("deviceId");
    const sessionId = param(c, idParamSchema).id;
    const outcome = await withUnit(async (unit) => {
      const row = await ownedSession(userId, sessionId, unit.tx);
      if (row === undefined) return "not_found" as const;
      if (row.state === "ended") return "already_ended" as const;
      const at = new Date(now());
      // Every run still attached to the session loses its authority with the
      // session: `active_run_id` names the claimed one, but a run created for
      // this session and not yet claimed is just as attached and would
      // otherwise sit claimable forever against a session that is gone.
      const attached = await unit.tx
        .select({ id: hostedRuns.id })
        .from(hostedRuns)
        .where(and(eq(hostedRuns.sessionId, sessionId), eq(hostedRuns.userId, userId)));
      for (const { id: runId } of attached) {
        const run = await unit.store.get(runId);
        if (run === null || run.authorityEnded || TERMINAL_STATUSES.has(run.status)) continue;
        const revoked = await unit.coordinator.revoke({ runId, sponsorId: userId, now: now() });
        await unit.sink.append(
          runId,
          sponsorEvents(runId, randomUUID(), [{ t: "cmd.revoke" }, statusEvent(revoked)]),
          { sponsorId: userId },
        );
      }
      await unit.tx
        .update(browserSessions)
        .set(
          sessionUpdate(
            {
              state: "ended",
              endedAt: at,
              activeRunId: null,
              controlHolder: "human",
              controlGeneration: sql`${browserSessions.controlGeneration} + 1`,
              ...CLEAR_SESSION_LEASE,
            },
            now(),
          ),
        )
        .where(eq(browserSessions.id, sessionId));
      // Unspent tickets for a session nobody may attach to any more.
      await unit.tx.delete(sessionTickets).where(eq(sessionTickets.sessionId, sessionId));
      // The session's egress identity ends with it, exactly as
      // `cutRuntimeEgress` ends a run's (§7.5).
      const cut = await unit.tx
        .update(egressCredentials)
        .set({ revokedAt: at })
        .where(and(eq(egressCredentials.sessionId, sessionId), isNull(egressCredentials.revokedAt)))
        .returning({ id: egressCredentials.id, deviceId: egressCredentials.deviceId });
      if (cut.length > 0) {
        await unit.tx
          .insert(egressRevocations)
          .values(cut.map((cred) => ({ deviceId: cred.deviceId, credentialId: cred.id, at })));
      }
      await audit(userId, "session.ended", { sessionId }, deviceId, unit.tx);
      // Best effort, outbox on failure — the same contract as a revoked
      // device's steer (§7.3): the worker holding the session tears it down
      // and closes every viewer, and learns late rather than never.
      unit.after(() => outbox.send({ kind: "session.ended", sessionId }).then(() => undefined));
      return "ended" as const;
    });
    if (outcome === "not_found") return c.json({ error: "not_found" }, 404);
    return c.body(null, 204);
  });

  /* ---------------------------------------------------------------- *
   * Runs (sponsor side)
   * ---------------------------------------------------------------- */

  v1.post("/runs", validate(createRunSchema), async (c) => {
    const userId = c.get("userId");
    const input = body(c, createRunSchema);
    const space = await ownedSpace(userId, input.spaceId);
    if (!space) return c.json({ error: "not_found" }, 404);
    if (!(await spaceCloudEnabled(userId, input.spaceId))) {
      return c.json({ error: "space_not_cloud_enabled" }, 400);
    }
    // A run may attach to a browser session (§4.3): it then acts in that
    // session's tabs, on the worker holding it, and drives its control
    // generation. An ended session is as good as none.
    let sessionId: string | null = null;
    if (input.sessionId !== undefined) {
      const session = await ownedSession(userId, input.sessionId);
      if (session === undefined || session.state === "ended") {
        return c.json({ error: "session_not_found" }, 404);
      }
      if (session.spaceId !== input.spaceId) {
        return c.json({ error: "session_space_mismatch" }, 409);
      }
      sessionId = session.id;
    }
    const record = await withUnit((unit) =>
      createRun(unit, {
        userId,
        spaceId: input.spaceId,
        intent: input.intent,
        attachments: input.attachments ?? [],
        origin: input.origin ?? null,
        // A run in a session acts in the tabs already open there; it opens one
        // of its own only when the caller names a start page.
        startUrl: input.startUrl ?? null,
        sessionId,
      }),
    );
    await audit(userId, "run.created", { runId: record.id, spaceId: input.spaceId, sessionId }, c.get("deviceId"));
    return c.json({ runId: record.id }, 201);
  });

  v1.post("/runs/desktop", validate(createDesktopRunSchema), async (c) => {
    if (c.get("platform") !== "macos") return c.json({ error: "forbidden" }, 403);
    const userId = c.get("userId");
    const input = body(c, createDesktopRunSchema);
    const space = await ownedSpace(userId, input.spaceId);
    if (!space) return c.json({ error: "not_found" }, 404);
    const existing = await db.select().from(hostedRuns).where(eq(hostedRuns.id, input.runId)).limit(1);
    if (existing[0] !== undefined) {
      const row = existing[0];
      if (row.userId !== userId || row.executor.kind !== "desktop") return c.json({ error: "run_id_taken" }, 409);
      return c.json({ runId: row.id });
    }
    const record = await withUnit(async (unit) => {
      const created = await unit.coordinator.createDesktop({
        ...input,
        userId,
        attachments: input.attachments ?? [],
        startUrl: input.startUrl ?? null,
      });
      const summary = controlRunSummary({
        runId: created.id,
        taskId: created.taskId,
        intent: created.intent,
        status: created.status,
        startedAt: created.createdAt,
        origin: null,
        executor: created.executor,
      });
      await unit.sink.append(
        created.id,
        [{ eventId: `run.created:${created.id}`, at: created.createdAt, event: { t: "run.created", run: summary } }],
        { sponsorId: userId },
      );
      return created;
    });
    await audit(userId, "run.desktop_registered", { runId: record.id, spaceId: input.spaceId }, c.get("deviceId"));
    return c.json({ runId: record.id }, 201);
  });

  v1.get("/runs", validateQuery(listRunsQuerySchema), async (c) => {
    const userId = c.get("userId");
    const { spaceId } = query(c, listRunsQuerySchema);
    const rows = await db
      .select({ summary: hostedRuns.summary })
      .from(hostedRuns)
      .where(
        spaceId === undefined
          ? and(eq(hostedRuns.userId, userId), isNull(hostedRuns.hiddenAt))
          : and(eq(hostedRuns.userId, userId), eq(hostedRuns.spaceId, spaceId), isNull(hostedRuns.hiddenAt)),
      )
      .orderBy(desc(hostedRuns.updatedAt), desc(hostedRuns.id));
    const runs: ThreadListItem[] = [];
    for (const row of rows) if (row.summary !== null) runs.push(row.summary);
    return c.json({ runs });
  });

  const ownedRun = async (userId: string, runId: string, handle: Db = db) => {
    const [row] = await handle
      .select()
      .from(hostedRuns)
      .where(and(eq(hostedRuns.id, runId), eq(hostedRuns.userId, userId)));
    return row;
  };

  v1.post("/runs/:id/imessage", validateParam(idParamSchema), validate(imessageDeliverySchema), async (c) => {
    if (c.get("platform") !== "macos") return c.json({ error: "forbidden" }, 403);
    const userId = c.get("userId");
    const runId = param(c, idParamSchema).id;
    const run = await ownedRun(userId, runId);
    if (run === undefined) return c.json({ error: "not_found" }, 404);
    if (run.executor.kind !== "desktop") return c.json({ error: "not_a_desktop_run" }, 409);
    const input = body(c, imessageDeliverySchema);
    if (input.kind === "resolved") {
      await db
        .delete(imessagePendingQuestions)
        .where(
          input.questionId === undefined
            ? eq(imessagePendingQuestions.runId, runId)
            : and(eq(imessagePendingQuestions.runId, runId), eq(imessagePendingQuestions.questionId, input.questionId)),
        );
      return c.json({ delivered: true }, 202);
    }
    try {
      const delivered = input.kind === "question"
        ? await deliverIMessageQuestion(userId, runId, input.question)
        : await deliverIMessageCompletion(userId, runId, input.text, input.completionId);
      return c.json({ delivered }, delivered ? 202 : 200);
    } catch (error) {
      log(`iMessage run delivery failed: ${errorMessage(error)}`);
      return c.json({ error: "imessage_delivery_failed" }, 502);
    }
  });

  v1.get("/runs/:id", validateParam(idParamSchema), async (c) => {
    const row = await ownedRun(c.get("userId"), param(c, idParamSchema).id);
    if (!row) return c.json({ error: "not_found" }, 404);
    // The lease's token is a worker credential (paired with the service
    // bearer on `/internal/runs/*`). No client reads it, so a device is told
    // that the run is leased and by whom, and not what the key is.
    const record = rowToRecord(row);
    const run =
      record.lease === null
        ? record
        : { ...record, lease: { ...record.lease, token: "" } };
    return c.json({ run, summary: row.summary, thread: row.thread });
  });

  /**
   * A live view ticket (§8.5).
   *
   * Neither Electron main nor a browser can set a header on a WebSocket, so
   * the credential has to ride in the URL — the worst place for one, reaching
   * `performance.getEntries()`, extensions, and every proxy in between. So
   * what goes there is not a token at all: it is an opaque secret that
   * authorises ONE thing, watching ONE run, ONCE, for a minute. It is not a
   * bearer for any other route (`authenticateToken` only ever sees JWTs, and
   * this is not one), it cannot be replayed onto the user's other concurrent
   * run, and redeeming it spends it.
   */
  v1.post("/runs/:id/live-ticket", validateParam(idParamSchema), async (c) => {
    const userId = c.get("userId");
    const deviceId = c.get("deviceId");
    // A bootstrap token has no device to mint for, and the runner would
    // reject it anyway.
    if (deviceId === null) return c.json({ error: "device_required" }, 403);
    const run = await ownedRun(userId, param(c, idParamSchema).id);
    if (!run) return c.json({ error: "not_found" }, 404);
    if (run.executor.kind !== "cloud") return c.json({ error: "not_a_cloud_run" }, 409);
    if (run.authorityEnded || TERMINAL_STATUSES.has(run.status)) return c.json({ error: "run_ended" }, 409);
    // A lease that has lapsed names a worker that has already let go: there
    // is no browser open anywhere to watch.
    const leased = run.leaseUntil !== null && run.leaseUntil.getTime() > now();
    if (!leased) return c.json({ error: "not_running" }, 409);
    // ONE public address for the whole fleet. Which worker holds the run is
    // answered at redemption, to the runner, over the private network — a
    // client is never told, and never needs to be (§8.5).
    const url = env["CLOUD_BROWSER_PUBLIC_URL"] ?? null;
    if (url === null) return c.json({ error: "no_cloud_browser" }, 503);
    const ticket = `plt_${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(now() + LIVE_TICKET_TTL_SECONDS * 1000);
    await db.insert(liveTickets).values({
      secretHash: sha256Hex(ticket),
      runId: run.id,
      userId,
      deviceId,
      createdAt: new Date(now()),
      expiresAt,
    });
    await audit(userId, "run.live_ticket", { runId: run.id }, deviceId);
    return c.json({ url, ticket, expiresAt: expiresAt.toISOString() });
  });

  v1.put("/runs/:id/desktop-snapshot", validateParam(idParamSchema), validate(desktopSnapshotSchema), async (c) => {
    if (c.get("platform") !== "macos") return c.json({ error: "forbidden" }, 403);
    const userId = c.get("userId");
    const runId = param(c, idParamSchema).id;
    const input = body(c, desktopSnapshotSchema);
    if (input.summary.runId !== runId) return c.json({ error: "run_mismatch" }, 400);
    if (Buffer.byteLength(input.thread.sealed, "base64") > MAX_THREAD_BYTES) {
      return c.json({ error: "thread_too_large" }, 413);
    }
    const result = await withUnit(async (unit) => {
      const row = await ownedRun(userId, runId, unit.tx);
      if (!row) return "not_found" as const;
      if (row.executor.kind !== "desktop" || row.spaceId !== input.thread.spaceId) return "invalid_run" as const;
      await unit.tx
        .update(hostedRuns)
        .set({
          status: input.summary.status,
          completedAt: input.completedAt === null ? null : new Date(input.completedAt),
          updatedAt: new Date(input.summary.updatedAt),
          summary: input.summary,
          thread: input.thread,
          authorityEnded: TERMINAL_STATUSES.has(input.summary.status),
        })
        .where(and(eq(hostedRuns.id, runId), eq(hostedRuns.userId, userId)));
      const at = input.summary.updatedAt;
      await unit.sink.append(
        runId,
        [{ eventId: `thread.updated:${randomUUID()}`, at, event: { t: "thread.updated" } }],
        { sponsorId: userId },
      );
      return "ok" as const;
    });
    if (result === "not_found") return c.json({ error: "not_found" }, 404);
    if (result === "invalid_run") return c.json({ error: "invalid_run" }, 409);
    return c.json({ ok: true });
  });

  v1.get("/runs/:id/events", validateParam(idParamSchema), validateQuery(sinceQuerySchema), async (c) => {
    const userId = c.get("userId");
    const runId = param(c, idParamSchema).id;
    const row = await ownedRun(userId, runId);
    if (!row) return c.json({ error: "not_found" }, 404);
    const lastEventId = c.req.header("last-event-id");
    const fromHeader = lastEventId === undefined ? Number.NaN : Number(lastEventId);
    const since = query(c, sinceQuerySchema).since ?? (Number.isInteger(fromHeader) && fromHeader >= 0 ? fromHeader : 0);
    return sseResponse(runId, since);
  });

  const sseResponse = (runId: string, since: number): Response => {
    const encoder = new TextEncoder();
    const pingMs = options.sse?.pingMs ?? SSE_PING_MS;
    let last = since;
    let closed = false;
    let chain: Promise<void> = Promise.resolve();
    let unsubscribe: () => void = () => undefined;
    let ping: NodeJS.Timeout | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const cleanup = (): void => {
          if (closed) return;
          closed = true;
          unsubscribe();
          if (ping !== null) clearInterval(ping);
        };
        const write = (text: string): void => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            cleanup();
          }
        };
        const end = (status: string): void => {
          write(`event: end\ndata: ${JSON.stringify({ status })}\n\n`);
          cleanup();
          try {
            controller.close();
          } catch {
            // already closed by the consumer
          }
        };
        const push = async (woken: StoredRunEvent[] = []): Promise<void> => {
          if (closed) return;
          // The wake carries the rows the append committed. When they follow
          // straight on from what this subscriber has sent, write them as they
          // are: no per-subscriber re-query of the run and its tail. A gap
          // (the first push, or a wake this stream missed) falls back to the
          // full read.
          const first = woken[0];
          if (first !== undefined && first.seq === last + 1) {
            let terminal: string | null = null;
            for (const event of woken) {
              write(`id: ${String(event.seq)}\nevent: run\ndata: ${JSON.stringify(event)}\n\n`);
              last = Math.max(last, event.seq);
              if (event.event.t === "status" && TERMINAL_STATUSES.has(event.event.status)) terminal = event.event.status;
            }
            if (terminal !== null) end(terminal);
            return;
          }
          // Status first: a terminal status commits together with the run's
          // final events, so reading it before listing guarantees the list
          // below includes everything up to the end.
          const [run] = await db.select({ status: hostedRuns.status }).from(hostedRuns).where(eq(hostedRuns.id, runId));
          const events = await listRunEvents(db, runId, last);
          for (const event of events) {
            write(`id: ${String(event.seq)}\nevent: run\ndata: ${JSON.stringify(event)}\n\n`);
            last = Math.max(last, event.seq);
          }
          if (run === undefined || TERMINAL_STATUSES.has(run.status)) end(run?.status ?? "deleted");
        };
        const schedule = (woken: StoredRunEvent[] = []): void => {
          chain = chain.then(() => push(woken)).catch((err: unknown) => {
            log(`sse push failed for run ${runId}: ${errorMessage(err)}`);
          });
        };
        unsubscribe = bus.subscribe(runId, schedule);
        ping = setInterval(() => write(": ping\n\n"), pingMs);
        ping.unref();
        schedule();
      },
      cancel() {
        closed = true;
        unsubscribe();
        if (ping !== null) clearInterval(ping);
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  };

  interface SponsorTransition {
    runId: string;
    userId: string;
    operation: string;
    /** Client retry key; absent means every call is a distinct command. */
    idempotencyKey?: string | undefined;
    /** Returns the events to append (after the transition), or an error. */
    apply(unit: Unit, run: HostedRunRecord): Promise<{ events: RunEvent[]; run: HostedRunRecord } | { error: string; status: 409 }>;
    /** Written in the same transaction as the transition and its cached response. */
    audit?: { kind: string; detail: Record<string, unknown>; actorDeviceId: string | null };
    /** Additional state committed atomically with a non-replayed command. */
    commit?: (unit: Unit, result: { events: RunEvent[]; run: HostedRunRecord; seqs: number[] }) => Promise<void>;
  }

  interface SponsorTransitionResult {
    seqs: number[];
    status: HostedRunRecord["status"];
    executor: HostedRunRecord["executor"];
    events: RunEvent[];
    replayed: boolean;
  }

  // Keep HTTP responses at the route boundary: the Node adapter replaces
  // global Response, so native Response.json results fail instanceof checks.
  interface SponsorTransitionError {
    error: string;
    message?: string;
    status: 404 | 409;
  }

  const sponsorTransition = async (t: SponsorTransition): Promise<SponsorTransitionError | SponsorTransitionResult> => {
    const result = await withUnit<SponsorTransitionResult | SponsorTransitionError>(async (unit) => {
      const run = await unit.store.get(t.runId);
      if (run === null || run.userId !== t.userId) return { status: 404 as const, error: "not_found" };
      const reservation =
        t.idempotencyKey === undefined
          ? null
          : and(
              eq(runSponsorCommands.runId, t.runId),
              eq(runSponsorCommands.operation, t.operation),
              eq(runSponsorCommands.idempotencyKey, t.idempotencyKey),
            );
      if (reservation !== null) {
        const [claimed] = await unit.tx
          .insert(runSponsorCommands)
          .values({
            runId: t.runId,
            operation: t.operation,
            idempotencyKey: t.idempotencyKey ?? "",
            response: null,
          })
          .onConflictDoNothing({
            target: [
              runSponsorCommands.runId,
              runSponsorCommands.operation,
              runSponsorCommands.idempotencyKey,
            ],
          })
          .returning({ runId: runSponsorCommands.runId });
        if (claimed === undefined) {
          const [existing] = await unit.tx
            .select({ response: runSponsorCommands.response })
            .from(runSponsorCommands)
            .where(reservation);
          if (existing?.response === null || existing?.response === undefined) {
            throw new Error("idempotency reservation has no completed response");
          }
          return { ...existing.response, executor: run.executor, events: [], replayed: true };
        }
      }
      const applied = await t.apply(unit, run);
      if ("error" in applied) {
        if (reservation !== null) {
          await unit.tx.delete(runSponsorCommands).where(reservation);
        }
        return applied;
      }
      const inputs = sponsorEvents(t.runId, t.idempotencyKey ?? randomUUID(), applied.events);
      const { seqs } = await unit.sink.append(t.runId, inputs, { sponsorId: t.userId });
      const response = { seqs, status: applied.run.status };
      if (reservation !== null) {
        await unit.tx
          .update(runSponsorCommands)
          .set({ response })
          .where(reservation);
      }
      // Commit the audit with the transition and its cached response. Written
      // afterwards it could be lost to a crash while the command stayed
      // durable, and the replay path would then skip it forever.
      if (t.audit !== undefined) {
        await audit(t.userId, t.audit.kind, t.audit.detail, t.audit.actorDeviceId, unit.tx);
      }
      if (t.commit !== undefined) {
        await t.commit(unit, { events: applied.events, run: applied.run, seqs });
      }
      return { ...response, executor: applied.run.executor, events: applied.events, replayed: false };
    });
    return result;
  };

  const passthrough: MiddlewareHandler<AppEnv> = (_c, next) => next();
  const sponsorRoute = (
    name: string,
    build: (c: Context<AppEnv>, run: HostedRunRecord, unit: Unit) => Promise<{ events: RunEvent[]; run: HostedRunRecord } | { error: string; status: 409 }>,
    bodySchema?: z.ZodType,
  ): void => {
    v1.post(`/runs/:id/${name}`, validateParam(idParamSchema), bodySchema === undefined ? passthrough : validate(bodySchema), async (c) => {
      const userId = c.get("userId");
      const runId = param(c, idParamSchema).id;
      let result: Awaited<ReturnType<typeof sponsorTransition>>;
      try {
        result = await sponsorTransition({
          runId,
          userId,
          operation: name,
          idempotencyKey: idempotencyKeyOf(c),
          apply: (unit, run) => build(c, run, unit),
          audit: { kind: `run.${name}`, detail: { runId }, actorDeviceId: c.get("deviceId") },
        });
      } catch (err) {
        const failure = coordinatorFailure(err);
        return c.json({ error: failure.error, message: failure.message }, failure.status);
      }
      if ("error" in result) return c.json({ error: result.error, message: result.message }, result.status);
      // The audit committed with the transition (see `sponsorTransition`).
      if (!result.replayed && result.executor.kind === "cloud") steerCommands(runId, result);
      return c.json({ ok: true, status: result.status, seqs: result.seqs }, 202);
    });
  };

  /**
   * The transitions the person's commands make, as pure applies over a run
   * (§7.5). Every one of them is reached from two places now: the device
   * bearer routes below, and the lease-authenticated session routes a
   * worker's `ShellHost` uses (web-browser-design.md §8). They are written
   * once so the two paths cannot drift into different behaviour or different
   * events for the same command.
   */
  type RunCommandOutcome = { events: RunEvent[]; run: HostedRunRecord } | { error: string; status: 409 };

  const messageApply = async (
    unit: Unit,
    run: HostedRunRecord,
    userId: string,
    input: { text: string; attachments?: AgentAttachment[] },
  ): Promise<RunCommandOutcome> => {
    const command: RunEvent = { t: "cmd.message", text: input.text, attachments: input.attachments ?? [] };
    switch (run.status) {
      case "waiting_for_step_up":
      case "waiting_for_approval":
        // The worker stops polling while paused and the pause has its own
        // exit (take control, approve, reject); a message appended here would
        // sit unread until the pause expired and revoked the run.
        return { error: "paused", status: 409 };
      case "waiting_for_judgment": {
        // The message is the person's reply to the open question: resume so
        // the run becomes claimable and the worker reads it on the next turn.
        const pause = run.pause;
        if (pause === null) return { events: [command], run };
        const resumed = await unit.coordinator.resume({
          runId: run.id,
          pauseId: pause.id,
          sponsorId: userId,
          now: now(),
          isCapabilityAllowed: () => Promise.resolve(true),
        });
        return { events: [command, { t: "resume" }, statusEvent(resumed)], run: resumed };
      }
      default: {
        if (run.status !== "interrupted" && !TERMINAL_STATUSES.has(run.status)) return { events: [command], run };
        const reopened = await unit.coordinator.reopen({ runId: run.id, sponsorId: userId, now: now() });
        return { events: [command, statusEvent(reopened)], run: reopened };
      }
    }
  };

  const answerApply = async (
    unit: Unit,
    run: HostedRunRecord,
    userId: string,
    input: { questionId: string; value: string },
  ): Promise<RunCommandOutcome> => {
    if (TERMINAL_STATUSES.has(run.status)) return { error: "run_ended", status: 409 };
    const command: RunEvent = { t: "cmd.answer", questionId: input.questionId, value: input.value };
    // A pause has its own lifecycle id; the question id is only the opaque
    // correlator in its payload. They intentionally differ.
    const pause = run.pause;
    if (pause === null || pause.kind !== "judgment" || pause.payload["questionId"] !== input.questionId) {
      return { events: [command], run };
    }
    const resumed = await unit.coordinator.resume({
      runId: run.id,
      pauseId: pause.id,
      sponsorId: userId,
      now: now(),
      isCapabilityAllowed: () => Promise.resolve(true),
    });
    return { events: [command, { t: "resume" }, statusEvent(resumed)], run: resumed };
  };

  const interruptApply = async (unit: Unit, run: HostedRunRecord, userId: string): Promise<RunCommandOutcome> => {
    // `waiting_for_step_up` means the agent asked for the wheel
    // (`request_takeover`); taking control is the answer, and the only exit
    // from that pause — `/release` needs `human_control` and `/answer` only
    // resumes a judgment.
    if (run.status !== "running" && run.status !== "interrupted" && run.status !== "waiting_for_step_up") {
      return { error: "invalid_state", status: 409 };
    }
    const next = await unit.coordinator.takeControl({ runId: run.id, sponsorId: userId, now: now() });
    // §4.3: `interrupt` hands the wheel to the person and bumps the session's
    // generation, so input forwarded from the page is accepted from here on
    // and the agent's in-flight tool calls are not. The run keeps its lease
    // and stays the session's active run.
    const generation =
      next.sessionId === null ? null : await moveSessionControl(unit, next.sessionId, { holder: "human" });
    return { events: [{ t: "cmd.interrupt" }, statusEvent(next), controlEvent("human", generation)], run: next };
  };

  const releaseApply = async (unit: Unit, run: HostedRunRecord, userId: string): Promise<RunCommandOutcome> => {
    if (run.status !== "human_control") return { error: "invalid_state", status: 409 };
    const next = await unit.coordinator.releaseControl({ runId: run.id, sponsorId: userId, now: now() });
    const generation =
      next.sessionId === null ? null : await moveSessionControl(unit, next.sessionId, { holder: "agent" });
    return { events: [{ t: "cmd.release" }, statusEvent(next), controlEvent("agent", generation)], run: next };
  };

  const revokeApply = async (unit: Unit, run: HostedRunRecord, userId: string): Promise<RunCommandOutcome> => {
    if (run.status === "revoked") return { events: [], run };
    if (TERMINAL_STATUSES.has(run.status)) return { error: "run_ended", status: 409 };
    const next = await unit.coordinator.revoke({ runId: run.id, sponsorId: userId, now: now() });
    unit.after(() => db.delete(imessagePendingQuestions).where(eq(imessagePendingQuestions.runId, run.id)).then(() => undefined));
    // A terminal run leaves its session to the person (§4.3).
    const generation = await releaseSessionForRun(unit, next);
    const events: RunEvent[] = [{ t: "cmd.revoke" }, statusEvent(next)];
    if (generation !== null) events.push(controlEvent("human", generation));
    return { events, run: next };
  };

  /**
   * The two halves of a pending approval. The desktop decides its own local
   * approvals in the renderer and never asks control; a run acting in a
   * browser session has no local half at all, so the shell's Approve and
   * Decline arrive here as the sponsor's decision on the run's own pause.
   */
  const approveApply = async (
    unit: Unit,
    run: HostedRunRecord,
    userId: string,
    input: { approvalId: string },
  ): Promise<RunCommandOutcome> => {
    const pause = run.pause;
    if (pause === null || pause.id !== input.approvalId) return { error: "pause_not_pending", status: 409 };
    const resumed = await unit.coordinator.resume({
      runId: run.id,
      pauseId: pause.id,
      sponsorId: userId,
      now: now(),
      approver: userId,
      isCapabilityAllowed: () => Promise.resolve(true),
    });
    return { events: [{ t: "resume" }, statusEvent(resumed)], run: resumed };
  };

  const rejectApply = async (
    unit: Unit,
    run: HostedRunRecord,
    userId: string,
    input: { approvalId: string },
  ): Promise<RunCommandOutcome> => {
    const pause = run.pause;
    if (pause === null || pause.id !== input.approvalId) return { error: "pause_not_pending", status: 409 };
    const next = await unit.coordinator.reject({
      runId: run.id,
      pauseId: pause.id,
      sponsorId: userId,
      now: now(),
    });
    const generation = await releaseSessionForRun(unit, next);
    const events: RunEvent[] = [statusEvent(next)];
    if (generation !== null) events.push(controlEvent("human", generation));
    return { events, run: next };
  };

  sponsorRoute("message", (c, run, unit) => messageApply(unit, run, c.get("userId"), body(c, runMessageSchema)), runMessageSchema);

  const answerRun = async (args: {
    userId: string;
    runId: string;
    questionId: string;
    value: string;
    idempotencyKey?: string;
    actorDeviceId: string | null;
    via: "device" | "imessage";
  }): Promise<SponsorTransitionError | SponsorTransitionResult> => {
    let result: Awaited<ReturnType<typeof sponsorTransition>>;
    try {
      result = await sponsorTransition({
        runId: args.runId,
        userId: args.userId,
        operation: "answer",
        idempotencyKey: args.idempotencyKey,
        apply: (unit, run) =>
          answerApply(unit, run, args.userId, { questionId: args.questionId, value: args.value }),
        audit: {
          kind: "run.answer",
          detail: { runId: args.runId, questionId: args.questionId, via: args.via },
          actorDeviceId: args.actorDeviceId,
        },
      });
    } catch (err) {
      const failure = coordinatorFailure(err);
      return failure;
    }
    if (!("error" in result) && !result.replayed && result.executor.kind === "cloud") steerCommands(args.runId, result);
    return result;
  };

  v1.post("/runs/:id/answer", validateParam(idParamSchema), validate(runAnswerSchema), async (c) => {
    const runId = param(c, idParamSchema).id;
    const input = body(c, runAnswerSchema);
    const result = await answerRun({
      userId: c.get("userId"),
      runId,
      questionId: input.questionId,
      value: input.value,
      idempotencyKey: idempotencyKeyOf(c),
      actorDeviceId: c.get("deviceId"),
      via: "device",
    });
    if ("error" in result) return c.json({ error: result.error, message: result.message }, result.status);
    await db
      .delete(imessagePendingQuestions)
      .where(and(eq(imessagePendingQuestions.runId, runId), eq(imessagePendingQuestions.questionId, input.questionId)));
    return c.json({ ok: true, status: result.status, seqs: result.seqs }, 202);
  });

  type CredentialCaptureRow = typeof credentialCaptures.$inferSelect;
  const credentialCaptureStatus = (capture: CredentialCaptureRow): "pending" | "submitted" | "consumed" | "expired" => {
    if (capture.consumedAt !== null) return "consumed";
    if (capture.submittedAt !== null) return "submitted";
    if (capture.expiresAt.getTime() <= now()) return "expired";
    return "pending";
  };
  const credentialCaptureView = (capture: CredentialCaptureRow) => ({
    id: capture.id,
    runId: capture.runId,
    siteName: capture.siteName,
    siteOrigin: capture.siteOrigin,
    encryptionPublicKey: capture.encryptionPublicKey,
    fields: capture.fields.map(({ id, label, type, autocomplete }) => ({
      id,
      label,
      type,
      ...(autocomplete === undefined ? {} : { autocomplete }),
    })),
    expiresAt: capture.expiresAt.toISOString(),
    status: credentialCaptureStatus(capture),
  });

  v1.get("/credential-captures/:captureId", validateParam(credentialCaptureParamSchema), async (c) => {
    const captureId = param(c, credentialCaptureParamSchema).captureId;
    const [capture] = await db
      .select()
      .from(credentialCaptures)
      .where(eq(credentialCaptures.id, captureId));
    if (capture === undefined) return c.json({ error: "not_found" }, 404);
    c.header("cache-control", "no-store");
    if (capture.submittedAt === null && capture.expiresAt.getTime() <= now()) {
      return c.json({ error: "expired" }, 410);
    }
    return c.json({ capture: credentialCaptureView(capture) });
  });

  v1.post(
    "/credential-captures/:captureId/submit",
    validateParam(credentialCaptureParamSchema),
    validate(submitCredentialCaptureSchema),
    async (c) => {
      const captureId = param(c, credentialCaptureParamSchema).captureId;
      const input = body(c, submitCredentialCaptureSchema);
      const result = await withUnit(async (unit) => {
        const [capture] = await unit.tx
          .select()
          .from(credentialCaptures)
          .where(eq(credentialCaptures.id, captureId))
          .for("update");
        if (capture === undefined) return { error: "not_found" as const, status: 404 as const };
        const userId = capture.userId;
        if (capture.submittedAt !== null || capture.consumedAt !== null) {
          return { error: "already_submitted" as const, status: 409 as const };
        }
        if (capture.expiresAt.getTime() <= now()) {
          await unit.tx
            .update(credentialCaptures)
            .set({ sealedPayload: null })
            .where(eq(credentialCaptures.id, capture.id));
          return { error: "expired" as const, status: 410 as const };
        }
        const run = await unit.store.get(capture.runId);
        if (run === null || run.userId !== userId) {
          return { error: "not_ready" as const, status: 409 as const };
        }
        const pause = run.pause;
        if (
          pause === null ||
          pause.kind !== "step_up" ||
          pause.payload["takeoverId"] !== capture.id
        ) {
          return { error: "not_ready" as const, status: 409 as const };
        }
        await unit.tx
          .update(credentialCaptures)
          .set({ sealedPayload: input.sealedPayload, submittedAt: new Date(now()) })
          .where(eq(credentialCaptures.id, capture.id));
        const resumed = await unit.coordinator.resume({
          runId: capture.runId,
          pauseId: pause.id,
          sponsorId: userId,
          now: now(),
          isCapabilityAllowed: () => Promise.resolve(true),
        });
        const events: RunEvent[] = [
          { t: "cmd.credentials", captureId: capture.id },
          { t: "resume" },
          statusEvent(resumed),
        ];
        const appended = await unit.sink.append(
          capture.runId,
          sponsorEvents(capture.runId, capture.id, events),
          { sponsorId: userId },
        );
        await audit(
          userId,
          "credential_capture.submitted",
          { captureId: capture.id, runId: capture.runId, fieldCount: capture.fields.length },
          null,
          unit.tx,
        );
        return { capture, events, seqs: appended.seqs, executor: resumed.executor };
      });
      if ("error" in result) return c.json({ error: result.error }, result.status);
      if (result.executor.kind === "cloud") {
        steerCommands(result.capture.runId, { events: result.events, seqs: result.seqs });
      }
      c.header("cache-control", "no-store");
      return c.json({ ok: true }, 202);
    },
  );

  v1.post("/imessage/webhook", async (c) => {
    if (imessage === null) return c.json({ error: "imessage_unavailable" }, 503);
    const supplied = c.req.header("x-bluebubbles-secret") ?? c.req.query("secret");
    if (!imessage.verifyWebhookSecret(supplied)) return c.json({ error: "unauthorized" }, 401);
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: "invalid_body" }, 400);
    }
    const inbound = imessage.parseWebhook(payload);
    if (inbound === null) return c.json({ accepted: true }, 202);
    const [link] = await db.select().from(imessageLinks).where(eq(imessageLinks.phoneE164, inbound.phoneE164));
    if (link === undefined) {
      // Possession of this high-entropy capability is the phone proof: it is
      // sent only into the iMessage conversation that initiated onboarding,
      // stored only as a digest, and never placed in the initial page request
      // or a referrer (the URL fragment stays in the browser until redemption).
      const secret = randomBytes(32).toString("base64url");
      const invitationId = randomUUID();
      const createdAt = new Date(now());
      const expiresAt = new Date(createdAt.getTime() + IMESSAGE_ONBOARDING_TTL_MS);
      const [reserved] = await db
        .insert(imessageOnboardingLinks)
        .values({
          id: invitationId,
          secretHash: sha256Hex(secret),
          deliveryId: inbound.deliveryId,
          phoneE164: inbound.phoneE164,
          expiresAt,
          createdAt,
        })
        .onConflictDoNothing({ target: imessageOnboardingLinks.deliveryId })
        .returning({ id: imessageOnboardingLinks.id });
      if (reserved === undefined) return c.json({ accepted: true, duplicate: true }, 202);
      const onboardingUrl = `${webPublicOrigin}/onboarding/imessage#${secret}`;
      try {
        await imessage.sendOnboardingLink(inbound.phoneE164, onboardingUrl, inbound.deliveryId);
      } catch (error) {
        await db.delete(imessageOnboardingLinks).where(eq(imessageOnboardingLinks.id, invitationId));
        log(`iMessage onboarding delivery failed: ${errorMessage(error)}`);
        return c.json({ error: "onboarding_delivery_failed" }, 502);
      }
      return c.json({ accepted: true }, 202);
    }
    const [reserved] = await db
      .insert(imessageInboundMessages)
      .values({ deliveryId: inbound.deliveryId, phoneE164: inbound.phoneE164, receivedAt: new Date(now()) })
      .onConflictDoNothing({ target: imessageInboundMessages.deliveryId })
      .returning({ deliveryId: imessageInboundMessages.deliveryId });
    if (reserved === undefined) return c.json({ accepted: true, duplicate: true }, 202);
    const [pending] = await db
      .select()
      .from(imessagePendingQuestions)
      .where(eq(imessagePendingQuestions.userId, link.userId))
      .orderBy(desc(imessagePendingQuestions.createdAt), desc(imessagePendingQuestions.runId))
      .limit(1);
    // A text with no open question is a task: a new thread, or a follow-up
    // routed to one the phone recently addressed.
    const startTask = async (): Promise<Response> => {
      if (!(await spaceCloudEnabled(link.userId, DEFAULT_SPACE_ID))) {
        track(imessage.sendCloudSetupRequired(link.phoneE164, `${webPublicOrigin}/app`, inbound.deliveryId));
        return c.json({ accepted: true }, 202);
      }
      // The webhook is authenticated, but its payload is still transport input.
      // Keep the iMessage path on the same contract as POST /runs rather than
      // letting an empty or oversized message bypass the public route schema.
      const intent = createRunSchema.shape.intent.safeParse(inbound.text);
      if (!intent.success) {
        track(imessage.sendInvalidTask(link.phoneE164, inbound.deliveryId));
        return c.json({ accepted: true, task: "invalid" }, 202);
      }
      let outcome: { kind: "started" | "continued"; runId: string };
      try {
        outcome = await chained(link.userId, async () => {
          const startNew = (): Promise<{ kind: "started"; runId: string }> => withUnit(async (unit) => {
            const created = await createRun(unit, {
              userId: link.userId,
              spaceId: DEFAULT_SPACE_ID,
              intent: intent.data,
              attachments: [],
              origin: null,
              startUrl: null,
            });
            await unit.tx
              .update(imessageInboundMessages)
              .set({ runId: created.id })
              .where(eq(imessageInboundMessages.deliveryId, inbound.deliveryId));
            await audit(
              link.userId,
              "run.created",
              { runId: created.id, spaceId: DEFAULT_SPACE_ID, via: "imessage" },
              null,
              unit.tx,
            );
            return { kind: "started", runId: created.id };
          });

          const candidates = await imessageCandidates(link.phoneE164, link.userId);
          const runner = runnerRef.current;
          if (candidates.length === 0 || runner === null) return startNew();
          const receivedAt = new Date(now()).toISOString();
          const routed = await Promise.all(candidates.map(async (candidate) => {
            try {
              const decision = await runner.routeIMessage({
                candidate,
                incoming: { text: intent.data, receivedAt },
                events: await imessageRoutingEvents(candidate.runId),
              });
              return { candidate, ...decision };
            } catch (error) {
              // Isolating the message in a new run is safer than attaching it
              // to the wrong conversation when routing is unavailable.
              log(`iMessage thread routing failed for ${candidate.runId}: ${errorMessage(error)}`);
              return null;
            }
          }));
          const continued = routed
            .filter((entry): entry is NonNullable<typeof entry> => entry !== null && entry.decision === "continue")
            .sort((a, b) => b.confidence - a.confidence);
          const candidate = continued[0]?.candidate;
          if (candidate === undefined) return startNew();

          const associate = (): Promise<unknown> => db
            .update(imessageInboundMessages)
            .set({ runId: candidate.runId })
            .where(eq(imessageInboundMessages.deliveryId, inbound.deliveryId));
          let result: Awaited<ReturnType<typeof sponsorTransition>>;
          try {
            result = await sponsorTransition({
              runId: candidate.runId,
              userId: link.userId,
              operation: "message",
              idempotencyKey: `imessage:${sha256Hex(inbound.deliveryId)}`,
              apply: async (unit, run) => {
                // Re-checked under the transaction: the run may have been
                // revoked between candidate selection and this commit.
                if (IMESSAGE_UNROUTABLE_STATUSES.has(run.status)) return { error: "run_ended", status: 409 };
                const command: RunEvent = { t: "cmd.message", text: intent.data, attachments: [] };
                if (run.status === "waiting_for_judgment" && run.pause !== null) {
                  const resumed = await unit.coordinator.resume({
                    runId: candidate.runId,
                    pauseId: run.pause.id,
                    sponsorId: link.userId,
                    now: now(),
                    isCapabilityAllowed: () => Promise.resolve(true),
                  });
                  return { events: [command, { t: "resume" }, statusEvent(resumed)], run: resumed };
                }
                if (run.status !== "interrupted" && !TERMINAL_STATUSES.has(run.status)) {
                  return { events: [command], run };
                }
                const reopened = await unit.coordinator.reopen({
                  runId: candidate.runId,
                  sponsorId: link.userId,
                  now: now(),
                });
                return { events: [command, statusEvent(reopened)], run: reopened };
              },
              audit: {
                kind: "run.message",
                detail: { runId: candidate.runId, via: "imessage" },
                actorDeviceId: null,
              },
              commit: async (unit) => {
                await unit.tx
                  .update(imessageInboundMessages)
                  .set({ runId: candidate.runId })
                  .where(eq(imessageInboundMessages.deliveryId, inbound.deliveryId));
              },
            });
          } catch (error) {
            // The same fallback the web path reports as 404/409: a run that
            // changed underneath the transition still gets the message, in
            // its own thread, instead of a retry storm at the webhook.
            log(`iMessage candidate ${candidate.runId} could not be continued (${coordinatorFailure(error).error}); starting a new thread`);
            return startNew();
          }
          if ("error" in result) {
            log(`iMessage candidate ${candidate.runId} could not be continued; starting a new thread`);
            return startNew();
          }
          if (result.replayed) {
            // A redelivery after the original command committed: the command
            // is already in the thread, so only the association is missing.
            await associate();
          } else if (result.executor.kind === "cloud") {
            steerCommands(candidate.runId, result);
          }
          return { kind: "continued", runId: candidate.runId };
        });
      } catch (error) {
        // Let BlueBubbles retry this delivery instead of allowing the
        // deduplication reservation to turn a transient failure into a loss.
        await db.delete(imessageInboundMessages).where(eq(imessageInboundMessages.deliveryId, inbound.deliveryId));
        throw error;
      }
      track(
        outcome.kind === "continued"
          ? imessage.sendTaskContinued(link.phoneE164, outcome.runId, inbound.deliveryId)
          : imessage.sendTaskStarted(link.phoneE164, outcome.runId, inbound.deliveryId),
      );
      return c.json({ accepted: true }, 202);
    };
    if (pending === undefined) return startTask();
    await db
      .update(imessageInboundMessages)
      .set({ runId: pending.runId, questionId: pending.questionId })
      .where(eq(imessageInboundMessages.deliveryId, inbound.deliveryId));
    const parsed = parseIMessageQuestionAnswer(pending.question, inbound.text);
    if (!parsed.ok) {
      if (pending.question.choices.length === 0 && pending.question.input === undefined) {
        // Nothing could ever answer this question; stop holding the number's
        // texts hostage to it and treat this one as the task it probably is.
        await db
          .delete(imessagePendingQuestions)
          .where(and(eq(imessagePendingQuestions.runId, pending.runId), eq(imessagePendingQuestions.questionId, pending.questionId)));
        return startTask();
      }
      track(imessage.sendInvalidAnswer(link.phoneE164, pending.runId, pending.question, inbound.deliveryId));
      return c.json({ accepted: true, answer: "invalid" }, 202);
    }
    const answerValue = runAnswerSchema.shape.value.safeParse(parsed.value);
    if (!answerValue.success) {
      track(imessage.sendInvalidAnswer(link.phoneE164, pending.runId, pending.question, inbound.deliveryId));
      return c.json({ accepted: true, answer: "invalid" }, 202);
    }
    const result = await answerRun({
      userId: link.userId,
      runId: pending.runId,
      questionId: pending.questionId,
      value: answerValue.data,
      idempotencyKey: `imessage:${sha256Hex(inbound.deliveryId)}`,
      actorDeviceId: null,
      via: "imessage",
    });
    if ("error" in result) {
      if (result.error === "run_ended" || result.error === "not_found") {
        // The question is gone with its run. The text was not an answer to
        // anything, so it becomes a task instead of being dropped.
        await db
          .delete(imessagePendingQuestions)
          .where(and(eq(imessagePendingQuestions.runId, pending.runId), eq(imessagePendingQuestions.questionId, pending.questionId)));
        await db
          .update(imessageInboundMessages)
          .set({ runId: null, questionId: null })
          .where(eq(imessageInboundMessages.deliveryId, inbound.deliveryId));
        return startTask();
      } else {
        // Keep the question available: a retry can succeed after a transient
        // coordinator or database failure.
        track(imessage.sendAnswerRetry(link.phoneE164, pending.runId, pending.question, inbound.deliveryId));
      }
      return c.json({ accepted: true }, 202);
    }
    await db
      .delete(imessagePendingQuestions)
      .where(and(eq(imessagePendingQuestions.runId, pending.runId), eq(imessagePendingQuestions.questionId, pending.questionId)));
    track(imessage.sendAnswerAccepted(link.phoneE164, pending.runId, pending.question, inbound.deliveryId));
    // Webhooks reveal neither account links nor run state to their caller.
    return c.json({ accepted: true }, 202);
  });

  sponsorRoute("interrupt", (c, run, unit) => interruptApply(unit, run, c.get("userId")));
  sponsorRoute("release", (c, run, unit) => releaseApply(unit, run, c.get("userId")));
  sponsorRoute("revoke", (c, run, unit) => revokeApply(unit, run, c.get("userId")));

  /* ---------------------------------------------------------------- *
   * Channels
   * ---------------------------------------------------------------- */

  v1.post("/channels", validate(createChannelSchema), async (c) => {
    const userId = c.get("userId");
    const input = body(c, createChannelSchema);
    const space = await ownedSpace(userId, input.spaceId);
    if (!space) return c.json({ error: "not_found" }, 404);
    let outboundUrl: string | null = null;
    if (input.outboundUrl !== undefined) {
      try {
        outboundUrl = vetOutboundUrl(input.outboundUrl, { production });
      } catch (err) {
        if (err instanceof OutboundUrlError) return c.json({ error: "outbound_url_rejected", reason: err.reason }, 400);
        throw err;
      }
    }
    const secret = `pch_${randomBytes(32).toString("base64url")}`;
    const [link] = await db
      .insert(channelLinks)
      .values({
        userId,
        spaceId: input.spaceId,
        name: input.name,
        secretHash: sha256Hex(secret),
        outboundUrl,
        createdAt: new Date(now()),
      })
      .returning({ id: channelLinks.id });
    if (!link) return c.json({ error: "internal" }, 500);
    await audit(userId, "channel.created", { linkId: link.id, spaceId: input.spaceId }, c.get("deviceId"));
    return c.json({ linkId: link.id, secret }, 201);
  });

  v1.get("/channels", async (c) => {
    const rows = await db
      .select()
      .from(channelLinks)
      .where(eq(channelLinks.userId, c.get("userId")))
      .orderBy(asc(channelLinks.createdAt), asc(channelLinks.id));
    return c.json({
      channels: rows.map((row) => ({
        id: row.id,
        name: row.name,
        spaceId: row.spaceId,
        outboundUrl: row.outboundUrl,
        createdAt: row.createdAt.toISOString(),
        revokedAt: row.revokedAt?.toISOString() ?? null,
      })),
    });
  });

  v1.delete("/channels/:id", validateParam(idParamSchema), async (c) => {
    const userId = c.get("userId");
    const { id } = param(c, idParamSchema);
    const updated = await db
      .update(channelLinks)
      .set({ revokedAt: new Date(now()) })
      .where(and(eq(channelLinks.id, id), eq(channelLinks.userId, userId), isNull(channelLinks.revokedAt)))
      .returning({ id: channelLinks.id });
    const [exists] = await db.select({ id: channelLinks.id }).from(channelLinks).where(and(eq(channelLinks.id, id), eq(channelLinks.userId, userId)));
    if (!exists) return c.json({ error: "not_found" }, 404);
    if (updated.length > 0) await audit(userId, "channel.revoked", { linkId: id }, c.get("deviceId"));
    return c.body(null, 204);
  });

  // Channel ingress: authenticated by the link secret only.
  v1.post("/channels/:linkId/inbound", validateParam(linkParamSchema), async (c) => {
    const { linkId } = param(c, linkParamSchema);
    const [link] = await db.select().from(channelLinks).where(eq(channelLinks.id, linkId));
    if (!link || link.revokedAt !== null) return c.json({ error: "not_found" }, 404);
    const presented = bearerToken(c.req.header("Authorization"));
    if (presented === null || !secretEquals(sha256Hex(presented), link.secretHash)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    if (!inboundLimiter.allow(link.id)) return c.json({ error: "rate_limited" }, 429);
    const parsed = inboundSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    const input = parsed.data;
    if (!(await spaceCloudEnabled(link.userId, link.spaceId))) {
      return c.json({ error: "space_not_cloud_enabled" }, 400);
    }
    const outcome = await withUnit(async (unit) => {
      const inserted = await unit.tx
        .insert(channelMessages)
        .values({
          linkId: link.id,
          deliveryId: input.deliveryId,
          body: { text: input.text },
          receivedAt: new Date(now()),
        })
        .onConflictDoNothing({ target: [channelMessages.linkId, channelMessages.deliveryId] })
        .returning({ id: channelMessages.id });
      const message = inserted[0];
      if (message === undefined) {
        const [existing] = await unit.tx
          .select({ runId: channelMessages.runId })
          .from(channelMessages)
          .where(and(eq(channelMessages.linkId, link.id), eq(channelMessages.deliveryId, input.deliveryId)));
        return { runId: existing?.runId ?? null, duplicate: true };
      }
      const record = await createRun(unit, {
        userId: link.userId,
        spaceId: link.spaceId,
        intent: input.text,
        attachments: [],
        origin: { kind: "channel", linkId: link.id, deliveryId: input.deliveryId, channelName: link.name },
        startUrl: null,
      });
      await unit.tx.update(channelMessages).set({ runId: record.id }).where(eq(channelMessages.id, message.id));
      return { runId: record.id, duplicate: false };
    });
    if (!outcome.duplicate) {
      await audit(link.userId, "run.created", { runId: outcome.runId, spaceId: link.spaceId, linkId: link.id });
    }
    return c.json(outcome, 202);
  });

  /* ---------------------------------------------------------------- *
   * Cloud device (desktop side)
   * ---------------------------------------------------------------- */

  v1.post("/cloud/enable", validate(cloudSpaceSchema), async (c) => {
    const userId = c.get("userId");
    const { spaceId } = body(c, cloudSpaceSchema);
    const space = await ownedSpace(userId, spaceId);
    if (!space) return c.json({ error: "not_found" }, 404);
    const device = await chained(userId, async (): Promise<DeviceRow | null> => {
      const existing = await liveCloudDevice(userId);
      if (existing !== undefined) return existing;
      const runner = runnerRef.current;
      if (runner === null) return null;
      const nonce = randomBytes(32).toString("base64url");
      await db
        .insert(cloudEnrollments)
        .values({ userId, nonce, createdAt: new Date(now()) })
        .onConflictDoUpdate({ target: cloudEnrollments.userId, set: { nonce, createdAt: new Date(now()) } });
      try {
        await runner.provision(userId, nonce);
      } catch (err) {
        // Another replica's enable won the race: the device is live now, so
        // this call succeeds on it rather than reporting the cloud as down.
        if (err instanceof RunnerResponseError && err.status === 409 && err.code === "cloud_device_exists") {
          const raced = await liveCloudDevice(userId);
          if (raced !== undefined) return raced;
        }
        log(`cloud provision failed for ${userId}: ${errorMessage(err)}`);
        return null;
      }
      return (await liveCloudDevice(userId)) ?? null;
    });
    if (device === null) return c.json({ error: "cloud_unavailable" }, 503);
    await audit(userId, "cloud.enabled", { spaceId, deviceId: device.id }, c.get("deviceId"));
    return c.json({ device: deviceView(device) });
  });

  v1.post("/cloud/disable", validate(cloudSpaceSchema), async (c) => {
    const userId = c.get("userId");
    const { spaceId } = body(c, cloudSpaceSchema);
    const space = await ownedSpace(userId, spaceId);
    if (!space) return c.json({ error: "not_found" }, 404);
    await chained(userId, async () => {
      const cloud = await liveCloudDevice(userId);
      if (cloud === undefined) return;
      await db
        .delete(keyWrappers)
        .where(
          and(
            eq(keyWrappers.userId, userId),
            eq(keyWrappers.spaceId, spaceId),
            eq(keyWrappers.kind, "device-x25519"),
            eq(keyWrappers.credentialId, cloud.id),
          ),
        );
      const [remaining] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(keyWrappers)
        .where(
          and(
            eq(keyWrappers.userId, userId),
            eq(keyWrappers.kind, "device-x25519"),
            eq(keyWrappers.credentialId, cloud.id),
            ne(keyWrappers.spaceId, WORKSPACE_PSEUDO_SPACE_ID),
          ),
        );
      if ((remaining?.n ?? 0) === 0) await revokeDevice(userId, cloud, c.get("deviceId"));
    });
    await audit(userId, "cloud.disabled", { spaceId }, c.get("deviceId"));
    return c.body(null, 204);
  });

  /* ---------------------------------------------------------------- *
   * Service bearer (runner)
   * ---------------------------------------------------------------- */

  v1.post("/internal/cloud/devices/enroll", validate(cloudEnrollSchema), async (c) => {
    const input = body(c, cloudEnrollSchema);
    const [enrollment] = await db
      .select()
      .from(cloudEnrollments)
      .where(and(eq(cloudEnrollments.userId, input.userId), eq(cloudEnrollments.nonce, input.nonce)));
    if (!enrollment || !secretEquals(enrollment.nonce, input.nonce)) return c.json({ error: "bad_nonce" }, 403);
    if (!challenges.take(input.deviceId, input.challenge)) {
      return c.json({ error: "unauthorized", reason: "challenge_expired" }, 401);
    }
    const valid = await verifySignature(
      input.devicePublicKey,
      input.signature,
      deviceLoginSigningBytes(input.deviceId, input.challenge),
    );
    if (!valid) return c.json({ error: "unauthorized", reason: "bad_signature" }, 401);
    if ((await liveCloudDevice(input.userId)) !== undefined) return c.json({ error: "cloud_device_exists" }, 409);
    const [byId] = await db.select({ id: devices.id }).from(devices).where(eq(devices.id, input.deviceId));
    if (byId) return c.json({ error: "device_id_taken" }, 409);
    const [byKey] = await db.select({ id: devices.id }).from(devices).where(eq(devices.devicePublicKey, input.devicePublicKey));
    if (byKey) return c.json({ error: "device_already_enrolled" }, 409);
    let device: DeviceRow | undefined;
    try {
      [device] = await db
        .insert(devices)
        .values({
          id: input.deviceId,
          userId: input.userId,
          name: "Cloud browser",
          platform: "cloud",
          devicePublicKey: input.devicePublicKey,
          agreementPublicKey: input.agreementPublicKey,
          createdAt: new Date(now()),
        })
        .returning();
    } catch (err) {
      const constraint = uniqueViolation(err);
      if (constraint === "devices_one_live_cloud_per_user_idx") return c.json({ error: "cloud_device_exists" }, 409);
      if (constraint === "devices_pkey") return c.json({ error: "device_id_taken" }, 409);
      if (constraint !== null) return c.json({ error: "device_already_enrolled" }, 409);
      throw err;
    }
    if (!device) return c.json({ error: "internal" }, 500);
    await db.delete(cloudEnrollments).where(eq(cloudEnrollments.userId, input.userId));
    await audit(input.userId, "device.enrolled", { deviceId: device.id, platform: "cloud" }, device.id);
    return c.json({ device: deviceView(device) }, 201);
  });

  v1.post("/internal/auth/introspect", validate(introspectSchema), async (c) => {
    const identity = await authenticateToken(db, signing, body(c, introspectSchema).token, nowSeconds());
    if (identity === null || identity.revoked) return c.json({ error: "unauthorized" }, 401);
    // The planes that introspect (the cloud browser) are closed to an anonymous account.
    if (identity.anonymous) return c.json(ACCOUNT_REQUIRED, 403);
    return c.json({ userId: identity.userId, deviceId: identity.deviceId, platform: identity.platform });
  });

  /**
   * Spend a live view ticket (§8.5). Service-authenticated, because only the
   * runner fleet redeems: the ticket names the viewer, and the answer also
   * names the worker whose memory the run lives in, so one round trip both
   * authenticates the socket and routes it.
   *
   * The DELETE is the authentication: one row, one redemption, and a race
   * between two sockets resolves to whichever the database serialises first.
   */
  v1.post("/internal/live-tickets/redeem", validate(redeemLiveTicketSchema), async (c) => {
    const input = body(c, redeemLiveTicketSchema);
    const [spent] = await db
      .delete(liveTickets)
      .where(and(eq(liveTickets.secretHash, sha256Hex(input.ticket)), eq(liveTickets.runId, input.runId)))
      .returning();
    if (!spent || spent.expiresAt.getTime() <= now()) return c.json({ error: "unauthorized" }, 401);
    const [device] = await db
      .select({ platform: devices.platform, revokedAt: devices.revokedAt, userId: devices.userId })
      .from(devices)
      .where(eq(devices.id, spent.deviceId));
    // A device revoked between issue and redemption does not get to watch.
    if (!device || device.revokedAt !== null || device.userId !== spent.userId) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const [run] = await db.select().from(hostedRuns).where(eq(hostedRuns.id, spent.runId));
    if (!run || run.userId !== spent.userId) return c.json({ error: "unauthorized" }, 401);
    const leased = run.leaseUntil !== null && run.leaseUntil.getTime() > now();
    return c.json({
      userId: spent.userId,
      deviceId: spent.deviceId,
      platform: device.platform,
      spaceId: run.spaceId,
      workerUrl: leased ? run.leaseWorkerUrl : null,
    });
  });

  v1.get("/internal/devices/:id", validateParam(idParamSchema), async (c) => {
    const [device] = await db.select().from(devices).where(eq(devices.id, param(c, idParamSchema).id));
    if (!device) return c.json({ error: "not_found" }, 404);
    return c.json({
      userId: device.userId,
      platform: device.platform,
      revokedAt: device.revokedAt?.toISOString() ?? null,
    });
  });

  v1.get(
    "/internal/users/:userId/artifacts/:artifactId",
    validateParam(internalArtifactParamSchema),
    async (c) => {
      const { userId, artifactId } = param(c, internalArtifactParamSchema);
      const artifact = await ownedHosted(userId, artifactId, "artifact");
      return artifact === undefined
        ? c.json({ error: "not_found" }, 404)
        : c.json({ artifact: hostedArtifactView(artifact) });
    },
  );

  v1.put(
    "/internal/users/:userId/artifacts/:artifactId/revision",
    validateParam(internalArtifactParamSchema),
    validate(artifactRevisionSchema),
    async (c) => {
      const { userId, artifactId } = param(c, internalArtifactParamSchema);
      const artifact = await publishHostedRevision(userId, artifactId, body(c, artifactRevisionSchema), "artifact");
      return artifact === null
        ? c.json({ published: false })
        : c.json({ published: true, artifact: hostedArtifactView(artifact) });
    },
  );

  // The cloud worker holds a note the same way it holds an artifact: it can
  // read the hosting row and keep a published note current, and nothing else.
  v1.get(
    "/internal/users/:userId/notes/:noteId",
    validateParam(internalNoteParamSchema),
    async (c) => {
      const { userId, noteId } = param(c, internalNoteParamSchema);
      const note = await ownedHosted(userId, noteId, "note");
      return note === undefined
        ? c.json({ error: "not_found" }, 404)
        : c.json({ note: hostedNoteView(note) });
    },
  );

  v1.put(
    "/internal/users/:userId/notes/:noteId/revision",
    validateParam(internalNoteParamSchema),
    validate(artifactRevisionSchema),
    async (c) => {
      const { userId, noteId } = param(c, internalNoteParamSchema);
      const note = await publishHostedRevision(userId, noteId, body(c, artifactRevisionSchema), "note");
      return note === null
        ? c.json({ published: false })
        : c.json({ published: true, note: hostedNoteView(note) });
    },
  );

  /* ---------------------------------------------------------------- *
   * Browser sessions: the worker side (§4.3)
   * ---------------------------------------------------------------- */

  /**
   * Claim a session for a worker, or renew the claim it already holds. Called
   * on demand when a shell ticket lands on a worker (§6.4), so a session
   * suspended on one worker comes back on whichever one the viewer reaches.
   */
  v1.post(
    "/internal/browser-sessions/:id/claim",
    validateParam(idParamSchema),
    validate(sessionClaimSchema),
    async (c) => {
      const sessionId = param(c, idParamSchema).id;
      const { workerId, workerUrl } = body(c, sessionClaimSchema);
      const at = now();
      const outcome = await db.transaction(async (tx) => {
        const [row] = await tx.select().from(browserSessions).where(eq(browserSessions.id, sessionId));
        if (row === undefined) return { error: "not_found", status: 404 as const };
        // 410, not 404: the session existed and is gone for good, which is
        // what tells the worker to close its viewers rather than retry.
        if (row.state === "ended") return { error: "session_ended", status: 410 as const };
        if (sessionLeaseLive(row, at) && row.leaseWorkerId !== workerId) {
          return { error: "held_elsewhere", status: 409 as const };
        }
        // Idempotent for the same worker: a renewal keeps the token the
        // worker is already heartbeating with.
        const leaseToken =
          row.leaseWorkerId === workerId && row.leaseToken !== null && sessionLeaseLive(row, at)
            ? row.leaseToken
            : randomUUID();
        const [claimed] = await tx
          .update(browserSessions)
          .set(
            sessionUpdate(
              {
                state: "live",
                leaseWorkerId: workerId,
                leaseWorkerUrl: workerUrl ?? null,
                leaseToken,
                leaseUntil: new Date(at + SESSION_LEASE_MS),
                lastAttachedAt: new Date(at),
              },
              at,
            ),
          )
          .where(and(eq(browserSessions.id, sessionId), eq(browserSessions.revision, row.revision)))
          .returning();
        // Another worker committed between the read and the write.
        if (claimed === undefined) return { error: "held_elsewhere", status: 409 as const };
        return { session: claimed, leaseToken };
      });
      if ("error" in outcome) return c.json({ error: outcome.error }, outcome.status);
      return c.json({ session: browserSessionView(outcome.session, at), leaseToken: outcome.leaseToken });
    },
  );

  v1.post(
    "/internal/browser-sessions/:id/heartbeat",
    validateParam(idParamSchema),
    validate(sessionLeaseSchema),
    async (c) => {
      const sessionId = param(c, idParamSchema).id;
      const { leaseToken } = body(c, sessionLeaseSchema);
      const at = now();
      const outcome = await db.transaction(async (tx) => {
        const [row] = await tx.select().from(browserSessions).where(eq(browserSessions.id, sessionId));
        if (row === undefined) return { error: "not_found", status: 404 as const };
        if (row.state === "ended") return { error: "session_ended", status: 410 as const };
        if (!leaseMatches(row.leaseToken, leaseToken) || !sessionLeaseLive(row, at)) {
          return { error: "stale_lease", status: 409 as const };
        }
        const [renewed] = await tx
          .update(browserSessions)
          .set(sessionUpdate({ leaseUntil: new Date(at + SESSION_LEASE_MS) }, at))
          .where(and(eq(browserSessions.id, sessionId), eq(browserSessions.leaseToken, leaseToken)))
          .returning();
        if (renewed === undefined) return { error: "stale_lease", status: 409 as const };
        return { session: renewed };
      });
      if ("error" in outcome) return c.json({ error: outcome.error }, outcome.status);
      return c.json({ session: browserSessionView(outcome.session, at) });
    },
  );

  /** The worker lets go (idle suspend, §6.4). Ending a session stays the person's decision. */
  v1.post(
    "/internal/browser-sessions/:id/release",
    validateParam(idParamSchema),
    validate(sessionReleaseSchema),
    async (c) => {
      const sessionId = param(c, idParamSchema).id;
      const { leaseToken, state } = body(c, sessionReleaseSchema);
      const at = now();
      const outcome = await db.transaction(async (tx) => {
        const [row] = await tx.select().from(browserSessions).where(eq(browserSessions.id, sessionId));
        if (row === undefined) return { error: "not_found", status: 404 as const };
        // Nothing left to release, and no reason to make the worker care.
        if (row.state === "ended") return { released: false };
        if (!leaseMatches(row.leaseToken, leaseToken)) return { error: "stale_lease", status: 409 as const };
        await tx
          .update(browserSessions)
          .set(sessionUpdate({ state, ...CLEAR_SESSION_LEASE }, at))
          .where(and(eq(browserSessions.id, sessionId), eq(browserSessions.leaseToken, leaseToken)));
        return { released: true };
      });
      if ("error" in outcome) return c.json({ error: outcome.error }, outcome.status);
      return c.body(null, 204);
    },
  );

  /**
   * Where a session is, for a worker deciding between claiming it and
   * relaying to whoever holds it (web-browser-design.md §6.4). Until S6 the
   * only answer a worker could give after losing a claim race was `409`, and
   * the client had to dial again with a fresh ticket whose redemption named
   * the new holder — one extra round trip through the person's browser for
   * something the fleet already knew. `workerUrl` is gated on a live lease,
   * exactly as the ticket redemption gates it, so a stale address is never
   * handed out as a live one.
   */
  v1.get("/internal/browser-sessions/:id", validateParam(idParamSchema), async (c) => {
    const sessionId = param(c, idParamSchema).id;
    const at = now();
    const [row] = await db.select().from(browserSessions).where(eq(browserSessions.id, sessionId));
    if (row === undefined) return c.json({ error: "not_found" }, 404);
    return c.json({
      session: browserSessionView(row, at),
      workerUrl: sessionLeaseLive(row, at) ? row.leaseWorkerUrl : null,
    });
  });

  /* ---------------------------------------------------------------- *
   * The session's runs: the worker side (web-browser-design.md §8)
   * ---------------------------------------------------------------- */

  /**
   * Why this family exists. Control forbids a `cloud` device from every
   * device-bearer route, so the worker's `ShellHost` — which acts for the
   * person sitting in front of the web shell — cannot call `POST /runs` or
   * the sponsor routes as itself. What authorises it instead is the pair it
   * already holds: the service bearer, and the SESSION's `leaseToken`. The
   * lease proves this worker holds this person's session, which a viewer
   * only reached by proving that Space's key (§5). The `viewerDeviceId` is
   * who the audit names, and has to be an unrevoked device of the session's
   * own user — a worker cannot invent an actor.
   *
   * Refusals: `409 stale_lease`, `404 not_found`, `403 viewer_device`,
   * `410 session_ended`.
   */
  interface LeasedSession {
    row: BrowserSessionRow;
    viewerDeviceId: string;
  }

  const leasedSession = async (
    sessionId: string,
    leaseToken: string,
    viewerDeviceId: string,
    handle: Db = db,
  ): Promise<LeasedSession | { error: string; status: 403 | 404 | 409 | 410 }> => {
    const [row] = await handle.select().from(browserSessions).where(eq(browserSessions.id, sessionId));
    if (row === undefined) return { error: "not_found", status: 404 };
    // 410, not 409: the session existed and is gone for good, which is what
    // tells the worker to close its viewers rather than retry (§6.4).
    if (row.state === "ended") return { error: "session_ended", status: 410 };
    if (!leaseMatches(row.leaseToken, leaseToken) || !sessionLeaseLive(row, now())) {
      return { error: "stale_lease", status: 409 };
    }
    const [device] = await handle
      .select({ userId: devices.userId, revokedAt: devices.revokedAt })
      .from(devices)
      .where(eq(devices.id, viewerDeviceId));
    if (device === undefined || device.revokedAt !== null || device.userId !== row.userId) {
      return { error: "viewer_device", status: 403 };
    }
    return { row, viewerDeviceId };
  };

  /**
   * Start a run in the session, exactly as `POST /runs {sessionId}` would:
   * same sponsor (the session's user), same row, same `run.created` event.
   * The answer carries that event so the host can fold the run at once
   * instead of waiting for it to come back around a stream it cannot read.
   */
  v1.post(
    "/internal/browser-sessions/:id/runs",
    validateParam(idParamSchema),
    validate(sessionRunCreateSchema),
    async (c) => {
      const sessionId = param(c, idParamSchema).id;
      const input = body(c, sessionRunCreateSchema);
      const session = await leasedSession(sessionId, input.leaseToken, input.viewerDeviceId);
      if ("error" in session) return c.json({ error: session.error }, session.status);
      const { row } = session;
      if (!(await spaceCloudEnabled(row.userId, row.spaceId))) {
        return c.json({ error: "space_not_cloud_enabled" }, 400);
      }
      const record = await withUnit((unit) =>
        createRun(unit, {
          userId: row.userId,
          spaceId: row.spaceId,
          intent: input.intent,
          attachments: input.attachments ?? [],
          origin: null,
          // A run in a session acts in the tabs already open there; it opens
          // one of its own only when the shell names a start page (§8).
          startUrl: input.startUrl ?? null,
          sessionId: row.id,
        }),
      );
      await audit(
        row.userId,
        "run.created",
        { runId: record.id, spaceId: row.spaceId, sessionId: row.id },
        input.viewerDeviceId,
      );
      return c.json(
        {
          runId: record.id,
          at: record.createdAt,
          events: [
            {
              t: "run.created",
              run: controlRunSummary({
                runId: record.id,
                taskId: record.taskId,
                intent: input.intent,
                status: record.status,
                startedAt: record.createdAt,
                origin: null,
                executor: record.executor,
              }),
            },
          ],
        },
        201,
      );
    },
  );

  /**
   * One sponsor command on a run of this session. Same applies, same events,
   * same steer as the device routes; the run must belong to the session, so
   * a lease is authority over the session's own conversation and nothing
   * else the account owns.
   */
  v1.post(
    "/internal/browser-sessions/:id/runs/:runId/:command",
    validateParam(sessionRunCommandParamSchema),
    validate(sessionRunCommandSchema),
    async (c) => {
      const { id: sessionId, runId, command } = param(c, sessionRunCommandParamSchema);
      const input = body(c, sessionRunCommandSchema);
      const session = await leasedSession(sessionId, input.leaseToken, input.viewerDeviceId);
      if ("error" in session) return c.json({ error: session.error }, session.status);
      const { row } = session;
      const [attached] = await db
        .select({ sessionId: hostedRuns.sessionId })
        .from(hostedRuns)
        .where(and(eq(hostedRuns.id, runId), eq(hostedRuns.userId, row.userId)));
      if (attached === undefined || attached.sessionId !== row.id) return c.json({ error: "not_found" }, 404);
      // What each command needs beyond the lease, checked before the
      // transaction opens: a `message` with no text is a malformed request,
      // not a run in the wrong state.
      const { text, questionId, value, approvalId } = input;
      const attachments = input.attachments ?? [];
      let apply: (unit: Unit, run: HostedRunRecord) => Promise<RunCommandOutcome>;
      switch (command) {
        case "message":
          if (text === undefined) return c.json({ error: "invalid_body", reason: "text" }, 400);
          apply = (unit, run) => messageApply(unit, run, row.userId, { text, attachments });
          break;
        case "answer":
          if (questionId === undefined || value === undefined) {
            return c.json({ error: "invalid_body", reason: "questionId" }, 400);
          }
          apply = (unit, run) => answerApply(unit, run, row.userId, { questionId, value });
          break;
        case "interrupt":
          apply = (unit, run) => interruptApply(unit, run, row.userId);
          break;
        case "release":
          apply = (unit, run) => releaseApply(unit, run, row.userId);
          break;
        case "revoke":
          apply = (unit, run) => revokeApply(unit, run, row.userId);
          break;
        case "approve":
          if (approvalId === undefined) return c.json({ error: "invalid_body", reason: "approvalId" }, 400);
          apply = (unit, run) => approveApply(unit, run, row.userId, { approvalId });
          break;
        case "reject":
          if (approvalId === undefined) return c.json({ error: "invalid_body", reason: "approvalId" }, 400);
          apply = (unit, run) => rejectApply(unit, run, row.userId, { approvalId });
          break;
      }
      let result: Awaited<ReturnType<typeof sponsorTransition>>;
      try {
        result = await sponsorTransition({
          runId,
          userId: row.userId,
          operation: command,
          idempotencyKey: idempotencyKeyOf(c),
          apply,
          audit: {
            kind: `run.${command}`,
            detail: { runId, sessionId: row.id },
            actorDeviceId: input.viewerDeviceId,
          },
        });
      } catch (err) {
        const failure = coordinatorFailure(err);
        return c.json({ error: failure.error, message: failure.message }, failure.status);
      }
      if ("error" in result) return c.json({ error: result.error, message: result.message }, result.status);
      if (!result.replayed && result.executor.kind === "cloud") steerCommands(runId, result);
      return c.json(
        {
          ok: true,
          status: result.status,
          seqs: result.seqs,
          at: new Date(now()).toISOString(),
          events: result.events,
        },
        202,
      );
    },
  );

  /**
   * The session's thread list: what `GET /runs?spaceId=` gives a device, plus
   * the sealed whole-thread snapshot `GET /runs/:id` carries, so the host can
   * open a conversation a desktop executor mirrored without a second round
   * trip per row. Only the session's own Space; the ciphertext is opened by
   * the worker with the Space key it already drives the session under.
   */
  v1.get(
    "/internal/browser-sessions/:id/runs",
    validateParam(idParamSchema),
    async (c) => {
      const sessionId = param(c, idParamSchema).id;
      const leaseToken = sessionLeaseHeader(c);
      const [row] = await db.select().from(browserSessions).where(eq(browserSessions.id, sessionId));
      if (row === undefined) return c.json({ error: "not_found" }, 404);
      if (row.state === "ended") return c.json({ error: "session_ended" }, 410);
      if (!leaseMatches(row.leaseToken, leaseToken) || !sessionLeaseLive(row, now())) {
        return c.json({ error: "stale_lease" }, 409);
      }
      const rows = await db
        .select({ id: hostedRuns.id, summary: hostedRuns.summary, thread: hostedRuns.thread })
        .from(hostedRuns)
        .where(
          and(eq(hostedRuns.userId, row.userId), eq(hostedRuns.spaceId, row.spaceId), isNull(hostedRuns.hiddenAt)),
        )
        .orderBy(desc(hostedRuns.updatedAt), desc(hostedRuns.id));
      const runs: ThreadListItem[] = [];
      const threads: Array<{ runId: string; spaceId: string; sealed: string }> = [];
      for (const item of rows) {
        if (item.summary !== null) runs.push(item.summary);
        if (item.thread !== null) threads.push({ runId: item.id, ...item.thread });
      }
      return c.json({ runs, threads });
    },
  );

  /**
   * Forget a conversation (web-browser-design.md §11, `deleteThread`).
   *
   * S5 could not answer this: the desktop's `deleteThread` only ever removed
   * a row from ITS OWN local thread store, and a session's thread list IS
   * control's list, so there was nothing local to forget and no route to ask.
   * This is that route, and it hides rather than deletes: the run leaves
   * every list the account can see, and its events, its evidence and its
   * audit trail stay exactly where they were. A person clearing their console
   * is not an account erasing its history.
   *
   * A run still acting is not forgotten out from under itself: revoke it
   * first, which is what the console's own "stop" already does.
   */
  v1.delete(
    "/internal/browser-sessions/:id/runs/:runId",
    validateParam(sessionRunParamSchema),
    validate(sessionRunAuthBodySchema),
    async (c) => {
      const { id: sessionId, runId } = param(c, sessionRunParamSchema);
      const input = body(c, sessionRunAuthBodySchema);
      const session = await leasedSession(sessionId, input.leaseToken, input.viewerDeviceId);
      if ("error" in session) return c.json({ error: session.error }, session.status);
      const { row } = session;
      const at = now();
      const outcome = await db.transaction(async (tx) => {
        const [run] = await tx
          .select({ status: hostedRuns.status, spaceId: hostedRuns.spaceId })
          .from(hostedRuns)
          .where(and(eq(hostedRuns.id, runId), eq(hostedRuns.userId, row.userId)));
        if (run === undefined || run.spaceId !== row.spaceId) return { error: "not_found", status: 404 as const };
        if (!TERMINAL_STATUSES.has(run.status)) return { error: "run_active", status: 409 as const };
        await tx
          .update(hostedRuns)
          .set({ hiddenAt: new Date(at), updatedAt: new Date(at) })
          .where(eq(hostedRuns.id, runId));
        return { hidden: true };
      });
      if ("error" in outcome) return c.json({ error: outcome.error }, outcome.status);
      await audit(row.userId, "run.forgotten", { runId, sessionId: row.id }, input.viewerDeviceId);
      return c.body(null, 204);
    },
  );

  /**
   * One run's stored events. A cloud run's sealed `thread` is the runner's
   * execution checkpoint, not a `RunSummary`, so a conversation the cloud
   * drove is reopened the way the desktop reopens one — by replaying the
   * stream and folding it — and this is that stream, without the SSE a
   * `cloud` device may not subscribe to.
   */
  v1.get(
    "/internal/browser-sessions/:id/runs/:runId/events",
    validateParam(sessionRunParamSchema),
    validateQuery(sessionRunEventsQuerySchema),
    async (c) => {
      const { id: sessionId, runId } = param(c, sessionRunParamSchema);
      const { since } = query(c, sessionRunEventsQuerySchema);
      const leaseToken = sessionLeaseHeader(c);
      const [row] = await db.select().from(browserSessions).where(eq(browserSessions.id, sessionId));
      if (row === undefined) return c.json({ error: "not_found" }, 404);
      if (row.state === "ended") return c.json({ error: "session_ended" }, 410);
      if (!leaseMatches(row.leaseToken, leaseToken) || !sessionLeaseLive(row, now())) {
        return c.json({ error: "stale_lease" }, 409);
      }
      const [run] = await db
        .select({ id: hostedRuns.id })
        .from(hostedRuns)
        .where(and(eq(hostedRuns.id, runId), eq(hostedRuns.userId, row.userId), eq(hostedRuns.spaceId, row.spaceId)));
      if (run === undefined) return c.json({ error: "not_found" }, 404);
      const events = await listRunEvents(db, runId, since ?? 0);
      return c.json({ events });
    },
  );

  /**
   * Spend a shell socket ticket (§4.3), the session twin of the live-view
   * redemption. The `DELETE … RETURNING` is the authentication: one row, one
   * redemption. The answer also names the worker holding the session, so one
   * round trip both authenticates the socket and routes it (§6.4).
   */
  v1.post("/internal/session-tickets/redeem", validate(redeemSessionTicketSchema), async (c) => {
    const input = body(c, redeemSessionTicketSchema);
    const [spent] = await db
      .delete(sessionTickets)
      .where(
        and(eq(sessionTickets.secretHash, sha256Hex(input.ticket)), eq(sessionTickets.sessionId, input.sessionId)),
      )
      .returning();
    if (!spent || spent.expiresAt.getTime() <= now()) return c.json({ error: "unauthorized" }, 401);
    const [device] = await db
      .select({ platform: devices.platform, revokedAt: devices.revokedAt, userId: devices.userId })
      .from(devices)
      .where(eq(devices.id, spent.deviceId));
    // A device revoked between issue and redemption does not get a shell.
    if (!device || device.revokedAt !== null || device.userId !== spent.userId) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const [session] = await db.select().from(browserSessions).where(eq(browserSessions.id, spent.sessionId));
    if (!session || session.userId !== spent.userId || session.state === "ended") {
      return c.json({ error: "unauthorized" }, 401);
    }
    return c.json({
      userId: spent.userId,
      deviceId: spent.deviceId,
      platform: device.platform,
      spaceId: session.spaceId,
      // Null means "nobody holds it": the redeeming worker claims it itself.
      workerUrl: sessionLeaseLive(session, now()) ? session.leaseWorkerUrl : null,
    });
  });

  v1.post("/internal/runs/claim", validate(claimSchema), async (c) => {
    const { workerId, workerUrl } = body(c, claimSchema);
    const at = now();
    let claimed: {
      run: HostedRunRecord;
      leaseToken: string;
      thread: { spaceId: string; sealed: string } | null;
      session?: { id: string; leaseToken: string; generation: number };
    } | null;
    try {
      claimed = await withUnit(async (unit) => {
        // Placement (§4.3). A run whose browser session another worker holds
        // under a live lease belongs to that worker: its tabs live in that
        // process's Chromium and this one could not act in them. A session
        // already ended is not somewhere to place a run either.
        const unavailable = await unit.tx
          .select({ id: browserSessions.id })
          .from(browserSessions)
          .where(
            or(
              eq(browserSessions.state, "ended"),
              and(
                ne(browserSessions.leaseWorkerId, workerId),
                gt(browserSessions.leaseUntil, new Date(at)),
              ),
            ),
          );
        const elsewhere = new Set(unavailable.map((row) => row.id));
        const claim = await unit.coordinator.claimNext(workerId, at, RUN_LEASE_MS, workerUrl ?? null, {
          eligible: (candidate) => candidate.sessionId === null || !elsewhere.has(candidate.sessionId),
        });
        if (claim === null) return null;
        let run = claim.run;
        if (run.executor.kind === "cloud" && run.executor.deviceId === null) {
          const cloud = await liveCloudDevice(run.userId, unit.tx);
          if (cloud !== undefined) {
            const next: HostedRunRecord = {
              ...run,
              executor: { ...run.executor, deviceId: cloud.id },
              revision: run.revision + 1,
            };
            if (await unit.store.compareAndSet(run.id, run.revision, next)) run = next;
          }
        }
        // A run with a session takes the session in the SAME transaction:
        // holding one without the other is a run with no browser or a
        // session two workers both believe they drive.
        let session: { id: string; leaseToken: string; generation: number } | undefined;
        if (run.sessionId !== null) {
          const attached = await attachRunSession(unit, run, workerId, workerUrl ?? null, at);
          if (attached === null) throw new SessionClaimLost();
          // The generation travels with the lease: the worker's host raises
          // its own fence to `agent` the moment it adopts the session, rather
          // than waiting a heartbeat to hear what control already decided.
          session = { id: attached.id, leaseToken: attached.leaseToken, generation: attached.generation };
        }
        const [snapshot] = await unit.tx
          .select({ thread: hostedRuns.thread })
          .from(hostedRuns)
          .where(eq(hostedRuns.id, run.id));
        return {
          run,
          leaseToken: claim.leaseToken,
          thread: snapshot?.thread ?? null,
          ...(session === undefined ? {} : { session }),
        };
      });
    } catch (err) {
      // The session moved under us; the whole claim rolled back and the run is
      // still there for whoever ends up holding its session.
      if (!(err instanceof SessionClaimLost)) throw err;
      return c.body(null, 204);
    }
    if (claimed === null) return c.body(null, 204);
    return c.json(claimed);
  });

  v1.post("/internal/runs/:id/heartbeat", validateParam(idParamSchema), validate(leaseSchema), async (c) => {
    const runId = param(c, idParamSchema).id;
    const { leaseToken } = body(c, leaseSchema);
    try {
      await withUnit((unit) => unit.coordinator.heartbeat(runId, leaseToken, now(), RUN_LEASE_MS));
    } catch (err) {
      const failure = coordinatorFailure(err);
      return c.json({ error: failure.error, message: failure.message }, failure.status);
    }
    return c.json({ ok: true });
  });

  const leasedRun = async (unit: Unit, runId: string, leaseToken: string): Promise<HostedRunRecord | { error: string; status: 404 | 409 }> => {
    const run = await unit.store.get(runId);
    if (run === null) return { error: "not_found", status: 404 };
    const lease = run.lease;
    if (lease === null || !leaseMatches(lease.token, leaseToken)) return { error: "stale_lease", status: 409 };
    if (new Date(lease.until).getTime() < now()) return { error: "stale_lease", status: 409 };
    return run;
  };

  v1.post(
    "/internal/runs/:id/credential-captures",
    validateParam(idParamSchema),
    validate(createCredentialCaptureSchema),
    async (c) => {
      const runId = param(c, idParamSchema).id;
      const input = body(c, createCredentialCaptureSchema);
      const result = await withUnit(async (unit) => {
        const run = await leasedRun(unit, runId, input.leaseToken);
        if ("error" in run) return run;
        if (run.executor.kind !== "cloud" || TERMINAL_STATUSES.has(run.status)) {
          return { error: "invalid_state", status: 409 as const };
        }
        if (run.executor.deviceId === null) {
          return { error: "invalid_state", status: 409 as const };
        }
        const [cloud] = await unit.tx
          .select({ agreementPublicKey: devices.agreementPublicKey })
          .from(devices)
          .where(and(
            eq(devices.id, run.executor.deviceId),
            eq(devices.userId, run.userId),
            eq(devices.platform, "cloud"),
            isNull(devices.revokedAt),
          ));
        if (cloud === undefined) return { error: "invalid_state", status: 409 as const };
        const at = new Date(now());
        await unit.tx
          .update(credentialCaptures)
          .set({ expiresAt: at, sealedPayload: null })
          .where(
            and(
              eq(credentialCaptures.runId, runId),
              isNull(credentialCaptures.submittedAt),
              isNull(credentialCaptures.consumedAt),
              gt(credentialCaptures.expiresAt, at),
            ),
          );
        const fields = input.fields.map((field) => ({ id: randomUUID(), ...field }));
        const [capture] = await unit.tx
          .insert(credentialCaptures)
          .values({
            id: randomUUID(),
            runId,
            userId: run.userId,
            spaceId: run.spaceId,
            tabId: input.tabId,
            siteName: input.siteName,
            siteOrigin: new URL(input.siteOrigin).origin,
            encryptionPublicKey: cloud.agreementPublicKey,
            fields,
            createdAt: at,
            expiresAt: new Date(at.getTime() + CREDENTIAL_CAPTURE_TTL_MS),
          })
          .returning();
        if (capture === undefined) throw new Error("credential capture insert returned no row");
        await audit(
          run.userId,
          "credential_capture.created",
          { captureId: capture.id, runId, fieldCount: fields.length },
          null,
          unit.tx,
        );
        return { capture };
      });
      if ("error" in result) return c.json({ error: result.error }, result.status);
      c.header("cache-control", "no-store");
      return c.json({ capture: credentialCaptureView(result.capture) }, 201);
    },
  );

  v1.post(
    "/internal/runs/:id/credential-captures/:captureId/consume",
    validateParam(internalCredentialCaptureParamSchema),
    validate(leaseSchema),
    async (c) => {
      const { id: runId, captureId } = param(c, internalCredentialCaptureParamSchema);
      const { leaseToken } = body(c, leaseSchema);
      const result = await withUnit(async (unit) => {
        const run = await leasedRun(unit, runId, leaseToken);
        if ("error" in run) return run;
        const [capture] = await unit.tx
          .select()
          .from(credentialCaptures)
          .where(and(eq(credentialCaptures.id, captureId), eq(credentialCaptures.runId, runId)))
          .for("update");
        if (capture === undefined || capture.userId !== run.userId || capture.spaceId !== run.spaceId) {
          return { error: "not_found", status: 404 as const };
        }
        if (capture.consumedAt !== null) return { error: "already_consumed", status: 409 as const };
        // Expiry is the deadline for accepting a submission. Once accepted,
        // the ciphertext remains available to the leased worker until its
        // bounded row-retention deadline or a successful one-time consume.
        if (capture.submittedAt === null || capture.sealedPayload === null) {
          if (capture.expiresAt.getTime() > now()) {
            return { error: "not_submitted", status: 409 as const };
          }
          await unit.tx
            .update(credentialCaptures)
            .set({ sealedPayload: null })
            .where(eq(credentialCaptures.id, capture.id));
          return { error: "expired", status: 409 as const };
        }
        const sealedPayload = capture.sealedPayload;
        await unit.tx
          .update(credentialCaptures)
          .set({ sealedPayload: null, consumedAt: new Date(now()) })
          .where(eq(credentialCaptures.id, capture.id));
        await audit(
          run.userId,
          "credential_capture.consumed",
          { captureId: capture.id, runId, fieldCount: capture.fields.length },
          null,
          unit.tx,
        );
        // Labels, types, and purposes ride along so the runner can file what
        // the person chose to keep in the vault without a second round trip.
        return {
          sealedPayload,
          tabId: capture.tabId,
          siteName: capture.siteName,
          siteOrigin: capture.siteOrigin,
          fields: capture.fields.map(({ id, target, label, type, autocomplete }) => ({
            id,
            target,
            label,
            type,
            ...(autocomplete === undefined ? {} : { autocomplete }),
          })),
        };
      });
      if ("error" in result) return c.json({ error: result.error }, result.status);
      c.header("cache-control", "no-store");
      return c.json(result);
    },
  );

  // The runner's side of the vault: everything is scoped to the leased run's
  // own user and Space, so a worker holding one run's lease can neither list
  // another Space's entries nor file one there.
  v1.post(
    "/internal/runs/:id/vault/lookup",
    validateParam(idParamSchema),
    validate(internalVaultLookupSchema),
    async (c) => {
      const runId = param(c, idParamSchema).id;
      const input = body(c, internalVaultLookupSchema);
      const result = await withUnit(async (unit) => {
        const run = await leasedRun(unit, runId, input.leaseToken);
        if ("error" in run) return run;
        const rows = await unit.tx
          .select()
          .from(vaultEntries)
          .where(and(
            eq(vaultEntries.userId, run.userId),
            eq(vaultEntries.spaceId, run.spaceId),
            eq(vaultEntries.siteOrigin, new URL(input.siteOrigin).origin),
          ))
          .orderBy(desc(vaultEntries.updatedAt));
        return { entries: rows.map(vaultEntryView) };
      });
      if ("error" in result) return c.json({ error: result.error }, result.status);
      c.header("cache-control", "no-store");
      return c.json(result);
    },
  );

  v1.post(
    "/internal/runs/:id/vault/entries",
    validateParam(idParamSchema),
    validate(internalVaultSaveSchema),
    async (c) => {
      const runId = param(c, idParamSchema).id;
      const input = body(c, internalVaultSaveSchema);
      const result = await withUnit(async (unit) => {
        const run = await leasedRun(unit, runId, input.leaseToken);
        if ("error" in run) return run;
        const siteOrigin = new URL(input.siteOrigin).origin;
        const at = new Date(now());
        const [taken] = await unit.tx.select({ id: vaultEntries.id }).from(vaultEntries).where(eq(vaultEntries.id, input.id));
        if (taken !== undefined) return { error: "conflict", status: 409 as const };
        // A fresh capture for the same purposes replaces what it covers: the
        // site's password changed, and the stale row would otherwise keep
        // matching first and keep failing.
        const siblings = await unit.tx
          .select()
          .from(vaultEntries)
          .where(and(
            eq(vaultEntries.userId, run.userId),
            eq(vaultEntries.spaceId, run.spaceId),
            eq(vaultEntries.siteOrigin, siteOrigin),
          ));
        const superseded = siblings.filter((row) => vaultEntrySuperseded(row, input)).map((row) => row.id);
        if (superseded.length > 0) await unit.tx.delete(vaultEntries).where(inArray(vaultEntries.id, superseded));
        const [row] = await unit.tx
          .insert(vaultEntries)
          .values({
            id: input.id,
            userId: run.userId,
            spaceId: run.spaceId,
            siteOrigin,
            siteName: input.siteName,
            fields: input.fields,
            sealedPayload: input.sealedPayload,
            source: "capture",
            createdAt: at,
            updatedAt: at,
            lastUsedAt: at,
          })
          .returning();
        if (row === undefined) throw new Error("vault entry insert returned no row");
        await audit(
          run.userId,
          "vault.entry_saved",
          { entryId: row.id, runId, spaceId: run.spaceId, siteOrigin, fieldCount: input.fields.length, replaced: superseded.length },
          null,
          unit.tx,
        );
        return { entry: vaultEntryView(row), replaced: superseded.length };
      });
      if ("error" in result) return c.json({ error: result.error }, result.status);
      c.header("cache-control", "no-store");
      return c.json(result, 201);
    },
  );

  v1.post(
    "/internal/runs/:id/vault/entries/:entryId/used",
    validateParam(internalVaultEntryParamSchema),
    validate(leaseSchema),
    async (c) => {
      const { id: runId, entryId } = param(c, internalVaultEntryParamSchema);
      const { leaseToken } = body(c, leaseSchema);
      const result = await withUnit(async (unit) => {
        const run = await leasedRun(unit, runId, leaseToken);
        if ("error" in run) return run;
        const [row] = await unit.tx
          .update(vaultEntries)
          .set({ lastUsedAt: new Date(now()) })
          .where(and(
            eq(vaultEntries.id, entryId),
            eq(vaultEntries.userId, run.userId),
            eq(vaultEntries.spaceId, run.spaceId),
          ))
          .returning();
        if (row === undefined) return { error: "not_found", status: 404 as const };
        await audit(
          run.userId,
          "vault.entry_used",
          { entryId, runId, spaceId: run.spaceId, siteOrigin: row.siteOrigin },
          null,
          unit.tx,
        );
        return { entry: vaultEntryView(row) };
      });
      if ("error" in result) return c.json({ error: result.error }, result.status);
      return c.json(result);
    },
  );

  // The runner's side of the integrations (D29): the OAuth clients it
  // refreshes tokens with, and — scoped to the leased run's own user and
  // Space — the sealed connections, a last-use stamp, and the status flip
  // when a grant turns out to be dead.
  v1.get("/internal/integrations/providers", (c) => {
    c.header("cache-control", "no-store");
    return c.json({ providers: integrationProviders() });
  });

  v1.post("/internal/runs/:id/integrations/lookup", validateParam(idParamSchema), validate(leaseSchema), async (c) => {
    const runId = param(c, idParamSchema).id;
    const { leaseToken } = body(c, leaseSchema);
    const result = await withUnit(async (unit) => {
      const run = await leasedRun(unit, runId, leaseToken);
      if ("error" in run) return run;
      const rows = await unit.tx
        .select()
        .from(integrationConnections)
        .where(and(eq(integrationConnections.userId, run.userId), eq(integrationConnections.spaceId, run.spaceId)))
        .orderBy(asc(integrationConnections.provider));
      return { connections: rows.map(integrationConnectionView) };
    });
    if ("error" in result) return c.json({ error: result.error }, result.status);
    c.header("cache-control", "no-store");
    return c.json(result);
  });

  v1.post(
    "/internal/runs/:id/integrations/:connectionId/used",
    validateParam(internalIntegrationConnectionParamSchema),
    validate(leaseSchema),
    async (c) => {
      const { id: runId, connectionId } = param(c, internalIntegrationConnectionParamSchema);
      const { leaseToken } = body(c, leaseSchema);
      const result = await withUnit(async (unit) => {
        const run = await leasedRun(unit, runId, leaseToken);
        if ("error" in run) return run;
        const [row] = await unit.tx
          .update(integrationConnections)
          .set({ lastUsedAt: new Date(now()) })
          .where(and(
            eq(integrationConnections.id, connectionId),
            eq(integrationConnections.userId, run.userId),
            eq(integrationConnections.spaceId, run.spaceId),
          ))
          .returning();
        if (row === undefined) return { error: "not_found", status: 404 as const };
        await audit(run.userId, "integration.used", { connectionId, runId, spaceId: run.spaceId, provider: row.provider }, null, unit.tx);
        return { connection: integrationConnectionView(row) };
      });
      if ("error" in result) return c.json({ error: result.error }, result.status);
      return c.json(result);
    },
  );

  v1.post(
    "/internal/runs/:id/integrations/:connectionId/status",
    validateParam(internalIntegrationConnectionParamSchema),
    validate(internalIntegrationStatusSchema),
    async (c) => {
      const { id: runId, connectionId } = param(c, internalIntegrationConnectionParamSchema);
      const input = body(c, internalIntegrationStatusSchema);
      const result = await withUnit(async (unit) => {
        const run = await leasedRun(unit, runId, input.leaseToken);
        if ("error" in run) return run;
        const [row] = await unit.tx
          .update(integrationConnections)
          .set({ status: input.status, updatedAt: new Date(now()) })
          .where(and(
            eq(integrationConnections.id, connectionId),
            eq(integrationConnections.userId, run.userId),
            eq(integrationConnections.spaceId, run.spaceId),
            eq(integrationConnections.status, "connected"),
          ))
          .returning();
        if (row === undefined) return { error: "not_found", status: 404 as const };
        await audit(run.userId, "integration.status", { connectionId, runId, spaceId: run.spaceId, provider: row.provider, status: input.status }, null, unit.tx);
        return { connection: integrationConnectionView(row) };
      });
      if ("error" in result) return c.json({ error: result.error }, result.status);
      return c.json(result);
    },
  );

  // The runner finished a disconnect the web app asked for: it opened the
  // tombstoned grant with the Space key and revoked it at the provider.
  v1.post(
    "/internal/runs/:id/integrations/:connectionId/revoked",
    validateParam(internalIntegrationConnectionParamSchema),
    validate(leaseSchema),
    async (c) => {
      const { id: runId, connectionId } = param(c, internalIntegrationConnectionParamSchema);
      const { leaseToken } = body(c, leaseSchema);
      const result = await withUnit(async (unit) => {
        const run = await leasedRun(unit, runId, leaseToken);
        if ("error" in run) return run;
        const deleted = await unit.tx
          .delete(integrationConnections)
          .where(and(
            eq(integrationConnections.id, connectionId),
            eq(integrationConnections.userId, run.userId),
            eq(integrationConnections.spaceId, run.spaceId),
            eq(integrationConnections.status, "revoke_pending"),
          ))
          .returning({ provider: integrationConnections.provider });
        if (deleted.length === 0) return { error: "not_found", status: 404 as const };
        await audit(run.userId, "integration.disconnected", { connectionId, runId, spaceId: run.spaceId, provider: deleted[0]?.provider }, null, unit.tx);
        return { ok: true as const };
      });
      if ("error" in result) return c.json({ error: result.error }, result.status);
      return c.json(result);
    },
  );

  v1.post("/internal/runs/:id/events", validateParam(idParamSchema), validate(eventsSchema), async (c) => {
    const runId = param(c, idParamSchema).id;
    const input = body(c, eventsSchema);
    if (input.events.some((e) => isCommandEvent(e.event))) {
      return c.json({ error: "invalid_body", reason: "command_events_are_sponsor_only" }, 400);
    }
    const result = await withUnit(async (unit) => {
      const run = await leasedRun(unit, runId, input.leaseToken);
      if ("error" in run) return run;
      return unit.sink.append(runId, input.events, { leaseToken: input.leaseToken });
    });
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json({ seqs: result.seqs });
  });

  const runnerTransition = async (
    c: Context<AppEnv>,
    runId: string,
    leaseToken: string,
    trailing: RunEventInput[] | undefined,
    transition: (unit: Unit, events: RunEventInput[]) => Promise<HostedRunRecord>,
    auditKind: string,
  ): Promise<Response> => {
    if ((trailing ?? []).some((e) => isCommandEvent(e.event))) {
      return c.json({ error: "invalid_body", reason: "command_events_are_sponsor_only" }, 400);
    }
    let run: HostedRunRecord;
    try {
      run = await withUnit(async (unit) => {
        const next = await transition(unit, trailing ?? []);
        // The coordinator records the transition; the stream must show it
        // too, so a status event is appended unless the runner sent one.
        if (!runEventsBatchHasStatus(trailing, next.status)) {
          await unit.sink.append(runId, sponsorEvents(runId, String(next.revision), [statusEvent(next)]), { leaseToken });
        }
        // §4.3: the run ended, or interrupted and dropped its lease. Either
        // way no agent is driving, and a session with no run is always
        // `human`. A pause keeps the wheel: the run is still the session's.
        if (next.sessionId !== null && (TERMINAL_STATUSES.has(next.status) || next.status === "interrupted")) {
          const generation = await releaseSessionForRun(unit, next);
          if (generation !== null) await appendControlEvent(unit, runId, "human", generation, { leaseToken });
        }
        return next;
      });
    } catch (err) {
      const failure = coordinatorFailure(err);
      return c.json({ error: failure.error, message: failure.message }, failure.status);
    }
    await audit(run.userId, auditKind, { runId, status: run.status });
    return c.json({ run });
  };

  v1.post("/internal/runs/:id/pause", validateParam(idParamSchema), validate(pauseSchema), (c) => {
    const runId = param(c, idParamSchema).id;
    const input = body(c, pauseSchema);
    if (
      input.imessageQuestion !== undefined &&
      (input.pause.kind !== "judgment" || input.pause.payload["questionId"] !== input.imessageQuestion.id)
    ) {
      return c.json({ error: "invalid_body", reason: "imessage_question_mismatch" }, 400);
    }
    if (
      input.imessageCredentialCapture !== undefined &&
      (input.pause.kind !== "step_up" ||
        input.pause.payload["takeoverId"] !== input.imessageCredentialCapture.captureId)
    ) {
      return c.json({ error: "invalid_body", reason: "imessage_credential_capture_mismatch" }, 400);
    }
    return runnerTransition(
      c,
      runId,
      input.leaseToken,
      input.events,
      async (unit, events) => {
        const next = await unit.coordinator.pause(runId, input.leaseToken, input.pause, now(), events);
        if (!events.some((e) => e.event.t === "pause")) {
          await unit.sink.append(runId, sponsorEvents(runId, String(next.revision), [{ t: "pause", pause: input.pause }]), {
            leaseToken: input.leaseToken,
          });
        }
        if (input.imessageQuestion !== undefined) {
          unit.after(() => tryDeliverIMessageQuestion(next.sponsorId, runId, input.imessageQuestion as AgentQuestion));
        }
        if (input.imessageCredentialCapture !== undefined) {
          const captureId = input.imessageCredentialCapture.captureId;
          unit.after(() => tryDeliverIMessageCredentialCapture(
            next.sponsorId,
            runId,
            captureId,
          ));
        }
        return next;
      },
      "run.paused",
    );
  });

  v1.post("/internal/runs/:id/complete", validateParam(idParamSchema), validate(completeSchema), (c) => {
    const runId = param(c, idParamSchema).id;
    const input = body(c, completeSchema);
    return runnerTransition(
      c,
      runId,
      input.leaseToken,
      input.events,
      async (unit, events) => {
        const next = await unit.coordinator.complete(runId, input.leaseToken, now(), events);
        if (input.imessageCompletion === undefined) {
          unit.after(() => db.delete(imessagePendingQuestions).where(eq(imessagePendingQuestions.runId, runId)).then(() => undefined));
        } else {
          unit.after(() => tryDeliverIMessageCompletion(
            next.sponsorId,
            runId,
            input.imessageCompletion?.text ?? "",
            input.imessageCompletion?.completionId ?? String(next.revision),
          ));
        }
        return next;
      },
      "run.completed",
    );
  });

  v1.post("/internal/runs/:id/fail", validateParam(idParamSchema), validate(failSchema), (c) => {
    const runId = param(c, idParamSchema).id;
    const input = body(c, failSchema);
    return runnerTransition(
      c,
      runId,
      input.leaseToken,
      input.events,
      async (unit, events) => {
        const next = await unit.coordinator.fail(runId, input.leaseToken, input.reason, now(), events);
        unit.after(() => db.delete(imessagePendingQuestions).where(eq(imessagePendingQuestions.runId, runId)).then(() => undefined));
        return next;
      },
      `run.failed:${input.reason}`,
    );
  });

  // The runner stopped at a clean point (a `cmd.interrupt` reached it): the
  // run becomes `interrupted` and a later sponsor message reopens it.
  v1.post("/internal/runs/:id/interrupt", validateParam(idParamSchema), validate(completeSchema), (c) => {
    const runId = param(c, idParamSchema).id;
    const input = body(c, completeSchema);
    return runnerTransition(
      c,
      runId,
      input.leaseToken,
      input.events,
      async (unit, events) => {
        const next = await unit.coordinator.interrupt(runId, input.leaseToken, now());
        if (events.length > 0) await unit.sink.append(runId, events, { leaseToken: input.leaseToken });
        // The question the pause carried is gone with the pause; a text that
        // arrives now must not be swallowed as its answer.
        unit.after(() => db.delete(imessagePendingQuestions).where(eq(imessagePendingQuestions.runId, runId)).then(() => undefined));
        return next;
      },
      "run.interrupted",
    );
  });

  v1.put("/internal/runs/:id/thread", validateParam(idParamSchema), validate(threadSchema), async (c) => {
    const runId = param(c, idParamSchema).id;
    const input = body(c, threadSchema);
    if (Buffer.byteLength(input.thread.sealed, "utf8") > MAX_THREAD_BYTES) {
      return c.json({ error: "thread_too_large" }, 413);
    }
    const result = await withUnit(async (unit) => {
      const run = await leasedRun(unit, runId, input.leaseToken);
      if ("error" in run) return run;
      await unit.tx.update(hostedRuns).set({ thread: input.thread }).where(eq(hostedRuns.id, runId));
      return { ok: true as const };
    });
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.body(null, 204);
  });

  v1.get("/internal/runs/:id/commands", validateParam(idParamSchema), validateQuery(commandsQuerySchema), async (c) => {
    const runId = param(c, idParamSchema).id;
    const q = query(c, commandsQuerySchema);
    const since = q.since ?? 0;
    const waitMs = (q.wait ?? MAX_LONG_POLL_SECONDS) * 1000;
    const [run] = await db.select({ nextSeq: hostedRuns.nextSeq }).from(hostedRuns).where(eq(hostedRuns.id, runId));
    if (!run) return c.json({ error: "not_found" }, 404);
    // Read the head before the first scan: with no command to report the
    // cursor still advances past the run's other events, so the runner does
    // not rescan the whole stream on every append.
    const head = Math.max(since, run.nextSeq - 1);
    const deadline = now() + waitMs;
    let events = await listRunEvents(db, runId, since, { commandsOnly: true });
    while (events.length === 0) {
      const remaining = deadline - now();
      if (remaining <= 0) break;
      const woken = await bus.wait(runId, remaining, c.req.raw.signal);
      if (!woken) break;
      events = await listRunEvents(db, runId, since, { commandsOnly: true });
    }
    return c.json({ events, since: events.at(-1)?.seq ?? head });
  });

  v1.get("/internal/users/:id/egress-credential", validateParam(idParamSchema), validateQuery(egressCredentialQuerySchema), async (c) => {
    const userId = param(c, idParamSchema).id;
    const { deviceId, runId, sessionId } = query(c, egressCredentialQuerySchema);
    const cloud = await liveCloudDevice(userId);
    if (cloud === undefined || cloud.id !== deviceId) return c.json({ error: "not_found" }, 404);
    if (sessionId !== undefined) {
      // A session holder mints its own credential (§6.2); a run attached to
      // the session reuses it rather than minting a second identity for the
      // same Chromium context. An ended session has been through the same
      // revocation pass a terminal run has.
      const session = await ownedSession(userId, sessionId);
      if (session === undefined || session.state === "ended") return c.json({ error: "not_found" }, 404);
      const credential = await mintEgressCredential(userId, deviceId, null, sessionId);
      if (credential === null) return c.json({ error: "egress_unavailable" }, 503);
      return c.json(credential);
    }
    if (runId === undefined) return c.json({ error: "not_found" }, 404);
    const [run] = await db.select({ status: hostedRuns.status }).from(hostedRuns).where(and(eq(hostedRuns.id, runId), eq(hostedRuns.userId, userId)));
    // A terminal run has already been through its revoker (§7.5), which cut
    // every credential carrying its `run_id`. One minted now would survive
    // that pass, so an ended run is as good as no run here.
    if (!run || TERMINAL_STATUSES.has(run.status)) return c.json({ error: "not_found" }, 404);
    const credential = await mintEgressCredential(userId, deviceId, runId);
    if (credential === null) return c.json({ error: "egress_unavailable" }, 503);
    return c.json(credential);
  });

  /* ---------------------------------------------------------------- *
   * Service bearer (gateway)
   * ---------------------------------------------------------------- */

  v1.post("/usage/egress", validate(usageSchema), async (c) => {
    const sample = body(c, usageSchema);
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, sample.userId));
    if (!user) return c.json({ error: "not_found" }, 404);
    await audit(sample.userId, "egress.usage", { ...sample, userId: undefined });
    return c.json({ ok: true }, 202);
  });

  v1.get("/egress/revocations", validateQuery(revocationsQuerySchema), async (c) => {
    const since = query(c, revocationsQuerySchema).since ?? 0;
    const rows = await db
      .select()
      .from(egressRevocations)
      .where(gt(egressRevocations.id, since))
      .orderBy(asc(egressRevocations.id))
      .limit(1000);
    // Retention prunes a prefix of the feed. A cursor below the oldest row
    // still held cannot be proved to have drained what was pruned, so the
    // gateway is told to drop its set and rebuild from a full snapshot
    // rather than silently miss a revocation.
    const [floor] = await db.select({ id: sql<number | null>`min(${egressRevocations.id})` }).from(egressRevocations);
    const oldest = floor?.id == null ? null : Number(floor.id);
    // Pruning keeps a contiguous suffix, so a cursor on the last pruned row
    // (oldest == since + 1) has missed nothing; only a gap forces a rebuild.
    const reset = since > 0 && oldest !== null && oldest > since + 1;
    const cursor = rows.at(-1)?.id ?? since;
    return c.json({
      revocations: rows.map((row) => ({
        id: row.id,
        deviceId: row.deviceId,
        credentialId: row.credentialId,
        at: row.at.toISOString(),
      })),
      cursor,
      reset,
    });
  });

  v1.get("/egress/limits", validateQuery(limitsQuerySchema), (c) => {
    const { userId } = query(c, limitsQuerySchema);
    return c.json({ userId, throttled: false });
  });

  app.route("/v1", v1);

  /* ---------------------------------------------------------------- *
   * Maintenance (§7.4 hourly job)
   * ---------------------------------------------------------------- */

  const runMaintenance = async (at: number = now()): Promise<MaintenanceResult> => {
    const host = hub.host;
    if (host !== null) {
      const userRows = await db.selectDistinct({ userId: hubKv.userId }).from(hubKv);
      await host.gc(at, userRows.map((row) => row.userId));
    }
    const expiredSessions = (
      await db.delete(authSessions).where(lt(authSessions.expiresAt, new Date(at))).returning({ id: authSessions.id })
    ).length;
    // Browser sessions (§4.3). A `live` session whose lease lapsed has no
    // worker behind it: its Chromium is gone with that process, so it reads
    // as suspended and the next viewer's ticket re-claims it anywhere. The
    // run its `active_run_id` names, if still leased, is the run sweeper's.
    const suspendedBrowserSessions = (
      await db
        .update(browserSessions)
        .set(sessionUpdate({ state: "suspended", ...CLEAR_SESSION_LEASE }, at))
        .where(
          and(
            eq(browserSessions.state, "live"),
            or(isNull(browserSessions.leaseUntil), lte(browserSessions.leaseUntil, new Date(at))),
          ),
        )
        .returning({ id: browserSessions.id })
    ).length;
    // Nobody came back for a week. The sealed session record is workspace
    // data and outlives this row; what ends here is the claim on the Space.
    const endedBrowserSessions = (
      await db
        .update(browserSessions)
        .set(sessionUpdate({ state: "ended", endedAt: new Date(at), activeRunId: null, ...CLEAR_SESSION_LEASE }, at))
        .where(
          and(
            eq(browserSessions.state, "suspended"),
            lt(browserSessions.updatedAt, new Date(at - SESSION_RETENTION_MS)),
          ),
        )
        .returning({ id: browserSessions.id })
    ).length;
    // Shell tickets are spent on redemption; these are the ones nobody used.
    await db.delete(sessionTickets).where(lt(sessionTickets.expiresAt, new Date(at)));
    // Live tickets are spent on redemption; these are the ones nobody used.
    await db.delete(liveTickets).where(lt(liveTickets.expiresAt, new Date(at)));
    await db
      .update(credentialCaptures)
      .set({ sealedPayload: null })
      .where(and(
        lt(credentialCaptures.expiresAt, new Date(at)),
        isNull(credentialCaptures.submittedAt),
        sql`${credentialCaptures.sealedPayload} is not null`,
      ));
    await db.delete(credentialCaptures).where(lt(credentialCaptures.expiresAt, new Date(at - DAY_MS)));
    await Promise.all([
      db.delete(imessageChallenges).where(lt(imessageChallenges.expiresAt, new Date(at))),
      db.delete(imessageOnboardingLinks).where(lt(imessageOnboardingLinks.expiresAt, new Date(at))),
      db.delete(imessageInboundMessages).where(lt(imessageInboundMessages.receivedAt, new Date(at - IMESSAGE_INBOUND_RETENTION_MS))),
      db.delete(imessagePendingQuestions).where(lt(imessagePendingQuestions.createdAt, new Date(at - IMESSAGE_PENDING_QUESTION_TTL_MS))),
    ]);
    const retired = await db
      .select({ id: hostedRuns.id })
      .from(hostedRuns)
      .where(and(lt(hostedRuns.completedAt, new Date(at - RUN_EVENT_RETENTION_MS)), sql`(${hostedRuns.thread} is not null or exists (select 1 from run_events where run_events.run_id = ${hostedRuns.id}))`));
    for (const run of retired) {
      await db.delete(runEvents).where(eq(runEvents.runId, run.id));
      await db.update(hostedRuns).set({ thread: null }).where(eq(hostedRuns.id, run.id));
    }
    const prunedNotifications = (
      await db
        .delete(notificationOccurrences)
        .where(
          and(
            sql`${notificationOccurrences.status} in ('sent', 'failed')`,
            lt(notificationOccurrences.fireAt, new Date(at - NOTIFICATION_RETENTION_MS)),
          ),
        )
        .returning({ id: notificationOccurrences.occurrenceId })
    ).length;
    // Keep the newest row whatever its age: it is the floor the feed's
    // staleness check reads, and one row is a bounded cost.
    const [head] = await db.select({ id: sql<number | null>`max(${egressRevocations.id})` }).from(egressRevocations);
    const headId = head?.id == null ? null : Number(head.id);
    const prunedRevocations =
      headId === null
        ? 0
        : (
            await db
              .delete(egressRevocations)
              .where(and(lt(egressRevocations.at, new Date(at - EGRESS_REVOCATION_RETENTION_MS)), lt(egressRevocations.id, headId)))
              .returning({ id: egressRevocations.id })
          ).length;
    const prunedAiUsage = (
      await db.delete(aiUsage).where(lt(aiUsage.at, new Date(at - AI_USAGE_RETENTION_MS))).returning({ id: aiUsage.id })
    ).length;
    await db.delete(accountLinks).where(lt(accountLinks.linkedAt, new Date(at - ACCOUNT_LINK_RETENTION_MS)));
    // Nobody can sign in to an anonymous account, so once its Mac stops
    // calling there is no way back to it; everything it owns cascades.
    const anonymousCutoff = new Date(at - ANONYMOUS_RETENTION_MS).toISOString();
    const prunedAnonymousAccounts = (
      await db
        .delete(users)
        .where(
          and(
            eq(users.isAnonymous, true),
            lt(users.createdAt, new Date(at - ANONYMOUS_RETENTION_MS)),
            sql`not exists (select 1 from devices where devices.user_id = ${users.id} and coalesce(devices.last_seen_at, devices.created_at) >= ${anonymousCutoff}::timestamptz)`,
          ),
        )
        .returning({ id: users.id })
    ).length;
    // Nothing else calls this. Without the sweep a run whose approval deadline
    // passed can never be resumed (`coordinator.resume` throws past the TTL),
    // never claimed and never terminal — so its authority is never cut and its
    // egress credentials live out their own expiry.
    const expiredPauses = await withUnit((unit) =>
      unit.coordinator.expirePauses({ workerId: "control-maintenance", now: at }),
    );
    // AFTER the terminal transitions of this same pass, not before them.
    //
    // `releaseSessionForRun` runs on the four paths a run ends through a
    // route, but `expirePauses` is a fifth: a pause that lapsed makes its run
    // terminal here, with nothing to move the session's fence back. This is
    // the repair — a session with no live run is always `human` (§4.3) — and
    // running it earlier in the pass, as it used to, left an expired pause's
    // session claiming the agent held the wheel for a whole hour: input
    // dropped, the agent's veil up, and no idle suspend.
    await db
      .update(browserSessions)
      .set(
        sessionUpdate(
          {
            controlHolder: "human",
            controlGeneration: sql`${browserSessions.controlGeneration} + 1`,
            activeRunId: null,
          },
          at,
        ),
      )
      .where(
        and(
          ne(browserSessions.state, "ended"),
          isNotNull(browserSessions.activeRunId),
          sql`not exists (select 1 from hosted_runs where hosted_runs.id = ${browserSessions.activeRunId} and hosted_runs.authority_ended = false)`,
        ),
      );
    // An expired or otherwise resolved pause leaves no question to answer.
    await db.delete(imessagePendingQuestions).where(
      inArray(
        imessagePendingQuestions.runId,
        db.select({ id: hostedRuns.id }).from(hostedRuns).where(ne(hostedRuns.status, "waiting_for_judgment")),
      ),
    );
    const steers = await outbox.flush();
    const notificationsDelivered = await dispatchNotifications(at);
    return {
      expiredSessions,
      suspendedBrowserSessions,
      endedBrowserSessions,
      retiredRuns: retired.length,
      prunedNotifications,
      prunedRevocations,
      prunedAiUsage,
      prunedAnonymousAccounts,
      expiredPauses,
      steersDelivered: steers.delivered,
      notificationsDelivered,
    };
  };

  const idle = async (): Promise<void> => {
    while (background.size > 0) await Promise.all([...background]);
  };

  return { app, hub, outbox, bus, dispatcher, runMaintenance, dispatchNotifications, idle };
}

export type { SteerBody, HubBinding, HubHost };
export function attachHub(control: ControlApp, server: HttpServer): HubHost {
  return control.hub.attach(server);
}
