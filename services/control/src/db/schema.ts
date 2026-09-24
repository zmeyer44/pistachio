/**
 * Control-plane schema (docs/cloud-sync-design.md §7.1). Accounts (BetterAuth),
 * devices, spaces, wrapped key material the server cannot open, the hub's
 * key/value store, egress gateways and credentials, hosted runs and their
 * event streams, channel links, notification occurrences, and the audit
 * trail.
 *
 * `migrate.ts` is the sole runtime DDL; this file must describe exactly the
 * columns it creates (`test/schema-parity.test.ts` checks that on PGlite).
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  AgentQuestion,
  AgentAttachment,
  DurablePause,
  IntegrationAccess,
  IntegrationConnectionStatus,
  IntegrationProvider,
  RunExecutor,
  RunOrigin,
  TaskCapsule,
  TaskStatus,
  ThreadListItem,
  VaultEntryField,
  VaultEntrySource,
} from "@pistachio/protocol";
import type { NotificationMessage } from "@pistachio/notifications";

const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });

// BetterAuth user model (src/idp.ts): `user: {modelName: "users"}` with NO
// field mapping, so every column key here is exactly BetterAuth's field name.
//
// An ANONYMOUS account (docs/anonymous-accounts.md) is a row with no email
// and `is_anonymous` set: made for a Mac nobody signed in on, so its model
// calls have an owner to meter. BetterAuth never reads one — it has no
// credential row, and every BetterAuth lookup is by email — until
// `POST /account/upgrade` gives it both and clears the flag, in place.
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Null only while `isAnonymous`; UNIQUE ignores nulls. */
  email: text("email").unique(),
  isAnonymous: boolean("is_anonymous").notNull().default(false),
  name: text("name"),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  /** Null until this account finishes the onboarding walkthrough. */
  onboardingCompletedAt: timestamptz("onboarding_completed_at"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
}, (t) => [
  // The hourly sweep of abandoned anonymous accounts reads only these rows.
  index("users_anonymous_created_idx").on(t.createdAt).where(sql`${t.isAnonymous}`),
]);

// BetterAuth core models: sessions (written by signInEmail on every login,
// never read; hourly gc deletes expired rows), sign-in accounts (the scrypt
// password hash lives in auth_accounts.password), verifications (OTP codes).
export const authSessions = pgTable("auth_sessions", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamptz("expires_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

export const authAccounts = pgTable(
  "auth_accounts",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    issuer: text("issuer").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamptz("access_token_expires_at"),
    refreshTokenExpiresAt: timestamptz("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("auth_accounts_issuer_account_idx").on(t.issuer, t.accountId),
    index("auth_accounts_user_idx").on(t.userId),
  ],
);

export const authVerifications = pgTable("auth_verifications", {
  id: uuid("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamptz("expires_at").notNull(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

/**
 * `macos` and `web` are first-class user devices (desktop app / browser);
 * `cloud` is the hosted cloud browser, creatable only through
 * `POST /internal/cloud/devices/enroll` and gated to a read-only route set
 * (§7.2). The CHECK below and the one in `migrate.ts` must agree.
 */
export type DevicePlatform = "macos" | "web" | "cloud";

// `id` is client-supplied (D24: the one device id) — no default. At most one
// live cloud device per user (partial unique index, migrate.ts).
export const devices = pgTable(
  "devices",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    platform: text("platform").$type<DevicePlatform>().notNull(),
    devicePublicKey: text("device_public_key").notNull().unique(),
    agreementPublicKey: text("agreement_public_key").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    lastSeenAt: timestamptz("last_seen_at"),
    revokedAt: timestamptz("revoked_at"),
    // Stamped once every revocation side effect has run; a row with
    // `revoked_at` but no `revocation_completed_at` is a partial revoke that
    // the next `POST /devices/:id/revoke` replays (§7.3).
    revocationCompletedAt: timestamptz("revocation_completed_at"),
  },
  (t) => [
    check("devices_platform_check", sql`${t.platform} in ('macos', 'web', 'cloud')`),
    uniqueIndex("devices_one_live_cloud_per_user_idx")
      .on(t.userId)
      .where(sql`${t.platform} = 'cloud' and ${t.revokedAt} is null`),
  ],
);

// Space ids are client-authoritative text (D8); `__workspace__` is the
// reserved pseudo-space holding the workspace root secret's wrappers.
export const spaces = pgTable(
  "spaces",
  {
    id: text("id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    check(
      "spaces_id_check",
      sql`${t.id} ~ '^[a-z0-9][a-z0-9-]{0,63}$' or ${t.id} = '__workspace__'`,
    ),
  ],
);

// Invariant I-1: ciphertext only. The upsert target is the full primary key.
export const keyWrappers = pgTable(
  "key_wrappers",
  {
    userId: uuid("user_id").notNull(),
    spaceId: text("space_id").notNull(),
    kind: text("kind").notNull(),
    credentialId: text("credential_id").notNull(),
    salt: text("salt").notNull().default(""),
    wrapped: text("wrapped").notNull(),
    senderDeviceId: uuid("sender_device_id"),
    signature: text("signature"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.spaceId, t.kind, t.credentialId] }),
    foreignKey({
      columns: [t.userId, t.spaceId],
      foreignColumns: [spaces.userId, spaces.id],
      name: "key_wrappers_space_fk",
    }).onDelete("cascade"),
  ],
);

// One pending cloud-device enrollment per user (§7.3 POST /cloud/enable).
export const cloudEnrollments = pgTable("cloud_enrollments", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  nonce: text("nonce").notNull(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

// Session-hub storage (@pistachio/sync-hub SqlHubStorage). The `key` column
// is `COLLATE "C"` — declared in migrate.ts raw DDL, which Drizzle's column
// builder cannot express; `test/hub.test.ts` asserts the collation.
export const hubKv = pgTable(
  "hub_kv",
  {
    userId: uuid("user_id").notNull(),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

export const egressGateways = pgTable("egress_gateways", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  host: text("host").notNull(),
  port: integer("port").notNull(),
  egressIpv4: text("egress_ipv4"),
  region: text("region"),
  state: text("state").notNull(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

export const egressCredentials = pgTable("egress_credentials", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  deviceId: uuid("device_id").notNull(),
  runId: uuid("run_id"),
  /** The browser session the credential was minted for (§4.3), beside `run_id`. */
  sessionId: uuid("session_id"),
  expiresAt: timestamptz("expires_at").notNull(),
  revokedAt: timestamptz("revoked_at"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

// The gateway's revocation feed (§9): `credential_id` null revokes the whole
// device. Serial ids are the feed cursor.
export const egressRevocations = pgTable("egress_revocations", {
  id: serial("id").primaryKey(),
  deviceId: uuid("device_id").notNull(),
  credentialId: uuid("credential_id"),
  at: timestamptz("at").notNull().defaultNow(),
});

export type BrowserSessionState = "ready" | "live" | "suspended" | "ended";
export type ControlHolder = "human" | "agent";

/**
 * A browser session (web-browser-design.md §4.1, W4): the durable object per
 * user and Space that exists before, during and after any conversation. Tabs
 * and shelf live in a sealed workspace record; this row holds only what
 * control has to arbitrate — which worker holds it, who holds the wheel, and
 * under which generation.
 *
 * The lease columns mirror `hosted_runs`: a worker claims the session, renews
 * it by heartbeat, and loses it to maintenance when it stops. `control_*` is
 * the fence of W7: every forwarded input and every agent tool call carries
 * the generation it was issued under, and the host drops anything older.
 */
export const browserSessions = pgTable(
  "browser_sessions",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    spaceId: text("space_id").notNull(),
    state: text("state").$type<BrowserSessionState>().notNull().default("ready"),
    revision: integer("revision").notNull().default(1),
    leaseWorkerId: text("lease_worker_id"),
    /** Where that worker can be reached in-fleet, so a sibling can relay (§6.4). */
    leaseWorkerUrl: text("lease_worker_url"),
    leaseToken: text("lease_token"),
    leaseUntil: timestamptz("lease_until"),
    controlHolder: text("control_holder").$type<ControlHolder>().notNull().default("human"),
    controlGeneration: integer("control_generation").notNull().default(0),
    activeRunId: uuid("active_run_id"),
    lastAttachedAt: timestamptz("last_attached_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    endedAt: timestamptz("ended_at"),
  },
  (t) => [
    foreignKey({
      columns: [t.userId, t.spaceId],
      foreignColumns: [spaces.userId, spaces.id],
      name: "browser_sessions_space_fk",
    }).onDelete("cascade"),
    check("browser_sessions_state_check", sql`${t.state} in ('ready', 'live', 'suspended', 'ended')`),
    check("browser_sessions_control_check", sql`${t.controlHolder} in ('human', 'agent')`),
    // One live session per Space per account (§4.1): create-or-resume depends
    // on it, and two sessions for one Space would mean two Chromium contexts
    // racing over the same sealed session record.
    uniqueIndex("browser_sessions_one_live_per_space_idx")
      .on(t.userId, t.spaceId)
      .where(sql`${t.state} <> 'ended'`),
  ],
);

/**
 * A shell socket ticket (§4.3, §5): the browser-session twin of
 * `live_tickets`. Same reasoning — a WebSocket credential rides in the URL,
 * so it authorises exactly one thing, one session, once, for a minute — and
 * the same redemption rule: the `DELETE … RETURNING` is the authentication.
 */
export const sessionTickets = pgTable(
  "session_tickets",
  {
    secretHash: text("secret_hash").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => browserSessions.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    expiresAt: timestamptz("expires_at").notNull(),
  },
  (t) => [index("session_tickets_expiry_idx").on(t.expiresAt)],
);

/** `hosted_runs.thread`: the runner's sealed conversation (§7.8). */
export interface SealedThread {
  spaceId: string;
  sealed: string;
}

export const hostedRuns = pgTable(
  "hosted_runs",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull(),
    spaceId: text("space_id").notNull(),
    taskId: uuid("task_id").notNull(),
    revision: integer("revision").notNull(),
    status: text("status").notNull(),
    purpose: text("purpose").notNull(),
    intent: text("intent").notNull(),
    attachments: jsonb("attachments").$type<AgentAttachment[]>().notNull(),
    origin: jsonb("origin").$type<RunOrigin>(),
    executor: jsonb("executor").$type<RunExecutor>().notNull(),
    capsule: jsonb("capsule").$type<TaskCapsule>(),
    startUrl: text("start_url"),
    /** The browser session the run acts in (§4.3); null for a standalone run. */
    sessionId: uuid("session_id").references(() => browserSessions.id, { onDelete: "set null" }),
    leaseWorkerId: text("lease_worker_id"),
    /** Where that worker can be reached for a live view (§8.5). */
    leaseWorkerUrl: text("lease_worker_url"),
    leaseToken: text("lease_token"),
    leaseUntil: timestamptz("lease_until"),
    pause: jsonb("pause").$type<DurablePause>(),
    thread: jsonb("thread").$type<SealedThread>(),
    summary: jsonb("summary").$type<ThreadListItem>(),
    nextSeq: integer("next_seq").notNull().default(1),
    completedAt: timestamptz("completed_at"),
    authorityEnded: boolean("authority_ended").notNull().default(false),
    /**
     * When the person forgot this conversation from a shell
     * (docs/web-browser-design.md §11, `deleteThread`). It is a SOFT delete:
     * the run leaves every thread list, and its events stay, because a person
     * clearing their console is not an account deleting its audit trail.
     */
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
    lastApprover: text("last_approver"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.userId, t.spaceId],
      foreignColumns: [spaces.userId, spaces.id],
      name: "hosted_runs_space_fk",
    }).onDelete("cascade"),
    index("hosted_runs_user_space_idx").on(t.userId, t.spaceId),
  ],
);

export type ArtifactVisibility = "private" | "public";

/**
 * What a hosted row holds: a generated page, or a note the person wrote
 * (docs/notes.md N9). The pipeline is identical — the owner's device renders
 * finished HTML and publishes it — so the table is one table, and `kind` is
 * what each route filters on.
 */
export type HostedArtifactKind = "artifact" | "note";

/**
 * Hosting metadata for generated pages. Private page contents stay solely in
 * the encrypted workspace; `public_html` exists only after the owner makes an
 * explicit public copy, and is cleared again when sharing is revoked.
 */
export const hostedArtifacts = pgTable(
  "hosted_artifacts",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    artifactId: text("artifact_id").notNull(),
    shareId: text("share_id").notNull().unique(),
    revision: integer("revision").notNull(),
    kind: text("kind").$type<HostedArtifactKind>().notNull().default("artifact"),
    visibility: text("visibility").$type<ArtifactVisibility>().notNull().default("private"),
    publicHtml: text("public_html"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    publishedAt: timestamptz("published_at"),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.artifactId] }),
    check("hosted_artifacts_id_check", sql`${t.artifactId} ~ '^[a-f0-9]{12}$'`),
    check("hosted_artifacts_visibility_check", sql`${t.visibility} in ('private', 'public')`),
    check("hosted_artifacts_kind_check", sql`${t.kind} in ('artifact', 'note')`),
    check(
      "hosted_artifacts_public_html_check",
      sql`(${t.visibility} = 'private' and ${t.publicHtml} is null) or (${t.visibility} = 'public' and ${t.publicHtml} is not null)`,
    ),
  ],
);

/**
 * Sharing a note with named accounts (docs/notes.md §9). The first
 * cross-account authorisation control holds: every other table here is read
 * only by the account that owns its rows.
 *
 * `note_shares` is the grant — who may read one note, and whether they may
 * write it back. It is never deleted: revoking stamps `revoked_at` so the
 * audit trail keeps what was granted, and every read filters on it.
 */
export type NoteShareRole = "viewer" | "editor";

export const noteShares = pgTable(
  "note_shares",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    noteId: text("note_id").notNull(),
    /**
     * Always an existing account: a share is only ever made by resolving an
     * email that is already here (§9 — there are no invites to strangers).
     */
    recipientUserId: uuid("recipient_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<NoteShareRole>().notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    /** Set rather than deleted; a revoked row answers nothing, anywhere. */
    revokedAt: timestamptz("revoked_at"),
  },
  (t) => [
    uniqueIndex("note_shares_owner_note_recipient_idx").on(t.ownerUserId, t.noteId, t.recipientUserId),
    // The recipient's own listing ("shared with me") reads by this alone.
    index("note_shares_recipient_idx").on(t.recipientUserId),
    check("note_shares_note_id_check", sql`${t.noteId} ~ '^[a-f0-9]{12}$'`),
    check("note_shares_role_check", sql`${t.role} in ('viewer', 'editor')`),
    check("note_shares_not_self_check", sql`${t.ownerUserId} <> ${t.recipientUserId}`),
  ],
);

/**
 * The shared body, in plaintext — the deliberate departure from E2EE that
 * §9 names out loud, and the same trade `hosted_artifacts.public_html`
 * already makes. It exists only while a note has at least one live share:
 * revoking the last one deletes the row, so the plaintext never outlives
 * its reason to exist.
 */
export const sharedNotes = pgTable(
  "shared_notes",
  {
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    noteId: text("note_id").notNull(),
    title: text("title").notNull(),
    markdown: text("markdown").notNull(),
    revision: integer("revision").notNull(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    /** The editor who last wrote it back, or null while only the owner has. */
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    primaryKey({ columns: [t.ownerUserId, t.noteId] }),
    check("shared_notes_note_id_check", sql`${t.noteId} ~ '^[a-f0-9]{12}$'`),
  ],
);

export const runEvents = pgTable(
  "run_events",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => hostedRuns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    eventId: text("event_id").notNull(),
    at: timestamptz("at").notNull(),
    event: jsonb("event").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.seq] }),
    uniqueIndex("run_events_run_event_idx").on(t.runId, t.eventId),
  ],
);

export interface SponsorCommandResponse {
  status: TaskStatus;
  seqs: number[];
}

/** Transactional idempotency reservation and cached response for sponsor commands. */
export const runSponsorCommands = pgTable(
  "run_sponsor_commands",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => hostedRuns.id, { onDelete: "cascade" }),
    operation: text("operation").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    response: jsonb("response").$type<SponsorCommandResponse>(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.operation, t.idempotencyKey] })],
);

export type CredentialCaptureFieldType = "text" | "email" | "password" | "otp";

export interface CredentialCaptureField {
  id: string;
  label: string;
  type: CredentialCaptureFieldType;
  target: string;
  autocomplete?: string;
}

/** Short-lived ciphertext relay for model-blind credential injection. */
export const credentialCaptures = pgTable(
  "credential_captures",
  {
    id: uuid("id").primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => hostedRuns.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    spaceId: text("space_id").notNull(),
    tabId: text("tab_id").notNull(),
    siteName: text("site_name").notNull(),
    siteOrigin: text("site_origin").notNull(),
    /** Raw base64 X25519 key of the cloud device assigned to the run. */
    encryptionPublicKey: text("encryption_public_key").notNull(),
    fields: jsonb("fields").$type<CredentialCaptureField[]>().notNull(),
    sealedPayload: text("sealed_payload"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    expiresAt: timestamptz("expires_at").notNull(),
    submittedAt: timestamptz("submitted_at"),
    consumedAt: timestamptz("consumed_at"),
  },
  (t) => [
    index("credential_captures_run_idx").on(t.runId),
    index("credential_captures_expiry_idx").on(t.expiresAt),
  ],
);

/**
 * The credential vault (docs/cloud-sync-design.md D28): values a person
 * handed to a cloud run once and chose to keep for the next run on the same
 * site. `fields` names what an entry holds; `sealed_payload` is the values,
 * sealed under the Space seal key by a device (the capturing cloud device or
 * the person's own browser or Mac). Control never holds a key that opens it.
 */
export const vaultEntries = pgTable(
  "vault_entries",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull(),
    spaceId: text("space_id").notNull(),
    siteOrigin: text("site_origin").notNull(),
    siteName: text("site_name").notNull(),
    fields: jsonb("fields").$type<VaultEntryField[]>().notNull(),
    sealedPayload: text("sealed_payload").notNull(),
    source: text("source").$type<VaultEntrySource>().notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    lastUsedAt: timestamptz("last_used_at"),
  },
  (t) => [
    foreignKey({
      columns: [t.userId, t.spaceId],
      foreignColumns: [spaces.userId, spaces.id],
      name: "vault_entries_space_fk",
    }).onDelete("cascade"),
    index("vault_entries_space_origin_idx").on(t.userId, t.spaceId, t.siteOrigin),
  ],
);

/**
 * Dedicated integrations (D29): one connected account per provider per
 * Space, its refresh token sealed under the Space seal key by the device
 * that obtained it. Control keeps the provider, the account's name, the
 * access level and granted scopes, and the ciphertext; it can neither open
 * the grant nor use it.
 */
export const integrationConnections = pgTable(
  "integration_connections",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull(),
    spaceId: text("space_id").notNull(),
    provider: text("provider").$type<IntegrationProvider>().notNull(),
    accountLabel: text("account_label").notNull(),
    access: text("access").$type<IntegrationAccess>().notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    status: text("status").$type<IntegrationConnectionStatus>().notNull(),
    sealedPayload: text("sealed_payload").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    lastUsedAt: timestamptz("last_used_at"),
  },
  (t) => [
    foreignKey({
      columns: [t.userId, t.spaceId],
      foreignColumns: [spaces.userId, spaces.id],
      name: "integration_connections_space_fk",
    }).onDelete("cascade"),
    uniqueIndex("integration_connections_provider_idx").on(t.userId, t.spaceId, t.provider),
  ],
);

/**
 * Live view tickets (§8.5).
 *
 * Deliberately NOT a token: a device JWT with a short expiry would still be
 * a device JWT, accepted by every route that takes one, for as long as it
 * lived. This is an opaque secret that means one thing — "let this device
 * watch THIS run, once" — stored as a hash, spent on redemption, and
 * useless anywhere else.
 */
export const liveTickets = pgTable("live_tickets", {
  secretHash: text("secret_hash").primaryKey(),
  runId: uuid("run_id")
    .notNull()
    .references(() => hostedRuns.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  deviceId: uuid("device_id").notNull(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  expiresAt: timestamptz("expires_at").notNull(),
});

export const channelLinks = pgTable(
  "channel_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    spaceId: text("space_id").notNull(),
    name: text("name").notNull(),
    secretHash: text("secret_hash").notNull(),
    outboundUrl: text("outbound_url"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    revokedAt: timestamptz("revoked_at"),
  },
  (t) => [
    foreignKey({
      columns: [t.userId, t.spaceId],
      foreignColumns: [spaces.userId, spaces.id],
      name: "channel_links_space_fk",
    }).onDelete("cascade"),
  ],
);

export const channelMessages = pgTable(
  "channel_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    linkId: uuid("link_id")
      .notNull()
      .references(() => channelLinks.id, { onDelete: "cascade" }),
    deliveryId: text("delivery_id").notNull(),
    body: jsonb("body").notNull(),
    receivedAt: timestamptz("received_at").notNull().defaultNow(),
    runId: uuid("run_id"),
  },
  (t) => [
    uniqueIndex("channel_messages_link_delivery_idx").on(t.linkId, t.deliveryId),
  ],
);

/** One verified iMessage destination per account; phone numbers cannot be shared. */
export const imessageLinks = pgTable("imessage_links", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  phoneE164: text("phone_e164").notNull().unique(),
  verifiedAt: timestamptz("verified_at").notNull(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

/** Short-lived OTP proof. Only a keyed digest of the six-digit code is stored. */
export const imessageChallenges = pgTable(
  "imessage_challenges",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    phoneE164: text("phone_e164").notNull(),
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("imessage_challenges_user_idx").on(t.userId)],
);

/**
 * One-time capabilities sent to phone numbers that have not linked an
 * account yet. The secret itself exists only in the outgoing iMessage; the
 * database keeps its digest so a database read cannot redeem an invitation.
 */
export const imessageOnboardingLinks = pgTable(
  "imessage_onboarding_links",
  {
    id: uuid("id").primaryKey(),
    secretHash: text("secret_hash").notNull().unique(),
    deliveryId: text("delivery_id").notNull().unique(),
    phoneE164: text("phone_e164").notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    consumedAt: timestamptz("consumed_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [index("imessage_onboarding_phone_idx").on(t.phoneE164, t.createdAt)],
);

/**
 * Connector-only copy of a currently answerable question. It is deliberately
 * plaintext: this exact content was opted into iMessage delivery. No other
 * run message or trace is copied here.
 */
export const imessagePendingQuestions = pgTable(
  "imessage_pending_questions",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => hostedRuns.id, { onDelete: "cascade" }),
    questionId: text("question_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    question: jsonb("question").$type<AgentQuestion>().notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.questionId] }), index("imessage_pending_user_at_idx").on(t.userId, t.createdAt)],
);

/** BlueBubbles message GUIDs already accepted, so webhook retries are harmless. */
export const imessageInboundMessages = pgTable(
  "imessage_inbound_messages",
  {
    deliveryId: text("delivery_id").primaryKey(),
    phoneE164: text("phone_e164").notNull(),
    receivedAt: timestamptz("received_at").notNull().defaultNow(),
    runId: uuid("run_id"),
    questionId: text("question_id"),
  },
  (t) => [index("imessage_inbound_phone_at_idx").on(t.phoneE164, t.receivedAt)],
);

export type NotificationOccurrenceStatus = "pending" | "leased" | "sent" | "failed";

export const notificationOccurrences = pgTable("notification_occurrences", {
  occurrenceId: text("occurrence_id").primaryKey(),
  userId: uuid("user_id").notNull(),
  fireAt: timestamptz("fire_at").notNull(),
  message: jsonb("message").$type<NotificationMessage>().notNull(),
  status: text("status").$type<NotificationOccurrenceStatus>().notNull(),
  leaseOwner: text("lease_owner"),
  leaseToken: text("lease_token"),
  leaseUntil: timestamptz("lease_until"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
});

/**
 * The model meter (src/ai-usage.ts): one row per `/v1/ai/*` request, spent
 * on `user_id`'s behalf under the operator's gateway key. Tokens and cost
 * are null when the answer carried none (speech, an error); bytes and time
 * always land. Pruned after AI_USAGE_RETENTION_DAYS.
 */
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id").notNull(),
    /** `language-model`, `embedding-model`, `speech-model`, `transcription-model`, … */
    kind: text("kind").notNull(),
    modelId: text("model_id"),
    /** The upstream status; 0 when the gateway could not be reached. */
    status: integer("status").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    /** The gateway's own USD figure for the call. */
    costUsd: numeric("cost_usd", { precision: 14, scale: 8 }),
    requestBytes: integer("request_bytes").notNull(),
    responseBytes: integer("response_bytes").notNull(),
    durationMs: integer("duration_ms").notNull(),
    at: timestamptz("at").notNull().defaultNow(),
  },
  (t) => [index("ai_usage_user_at_idx").on(t.userId, t.at)],
);

/**
 * The account's own ceiling on the meter: once the month's `ai_usage` cost
 * reaches `monthly_cap_usd`, `/v1/ai/*` refuses until the month turns or
 * the cap is raised. Null (or no row) is no cap.
 */
export const aiBudgets = pgTable("ai_budgets", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  monthlyCapUsd: numeric("monthly_cap_usd", { precision: 14, scale: 8 }),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

/**
 * Where a folded-in anonymous account went (`POST /account/link`,
 * docs/anonymous-accounts.md). The anonymous user row is deleted by the
 * link, but a model answer it started may still be streaming: its meter row
 * lands afterwards, and `recordAiUsage` follows this to the account that now
 * owns the spend. `from_user_id` has no foreign key — that user is gone.
 * Pruned by the hourly job once no answer can still be in flight.
 */
export const accountLinks = pgTable("account_links", {
  fromUserId: uuid("from_user_id").primaryKey(),
  toUserId: uuid("to_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  linkedAt: timestamptz("linked_at").notNull().defaultNow(),
});

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    actorDeviceId: uuid("actor_device_id"),
    kind: text("kind").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    at: timestamptz("at").notNull().defaultNow(),
  },
  (t) => [index("audit_events_user_at_idx").on(t.userId, t.at)],
);

export const syncPolicyOverrides = pgTable(
  "sync_policy_overrides",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    host: text("host").notNull(),
    mode: text("mode").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.host] })],
);
