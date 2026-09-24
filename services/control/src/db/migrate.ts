/**
 * Boot-time schema bootstrap: idempotent DDL matching src/db/schema.ts
 * exactly (docs/cloud-sync-design.md §7.1). Tests run this against PGlite;
 * the server runs it on boot. This file is the sole runtime DDL.
 *
 * The statements stay idempotent — that is what lets any older database
 * converge — but they are not replayed for their own sake. `schema_state`
 * records the hash of the DDL that was last applied, so a boot against an
 * already-current database does one SELECT and stops. Replaying all of it
 * every time is not free: it takes an ACCESS EXCLUSIVE lock per `ALTER
 * TABLE` even when the alteration is a no-op, and Postgres announces every
 * object it skips.
 */

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { rowsOf, type Db } from "./client.js";

const STATEMENTS: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text UNIQUE,
    is_anonymous boolean NOT NULL DEFAULT false,
    name text,
    email_verified boolean NOT NULL DEFAULT false,
    image text,
    onboarding_completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  // Existing accounts start incomplete too. Adding the column seeds NULL
  // once; later schema upgrades must preserve recorded completions.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz`,
  // Anonymous accounts (docs/anonymous-accounts.md): no email until upgraded.
  // Every account that predates the column is a real one.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_anonymous boolean NOT NULL DEFAULT false`,
  `ALTER TABLE users ALTER COLUMN email DROP NOT NULL`,
  `CREATE INDEX IF NOT EXISTS users_anonymous_created_idx ON users (created_at) WHERE is_anonymous`,
  `CREATE TABLE IF NOT EXISTS auth_sessions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token text NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    ip_address text,
    user_agent text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS auth_accounts (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id text NOT NULL,
    provider_id text NOT NULL,
    issuer text NOT NULL,
    access_token text,
    refresh_token text,
    id_token text,
    access_token_expires_at timestamptz,
    refresh_token_expires_at timestamptz,
    scope text,
    password text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS auth_accounts_issuer_account_idx
    ON auth_accounts (issuer, account_id)`,
  `CREATE INDEX IF NOT EXISTS auth_accounts_user_idx ON auth_accounts (user_id)`,
  `CREATE TABLE IF NOT EXISTS auth_verifications (
    id uuid PRIMARY KEY,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS devices (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    platform text NOT NULL,
    device_public_key text NOT NULL UNIQUE,
    agreement_public_key text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz,
    revoked_at timestamptz,
    revocation_completed_at timestamptz,
    CONSTRAINT devices_platform_check CHECK (platform in ('macos', 'web', 'cloud'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS devices_one_live_cloud_per_user_idx
    ON devices (user_id) WHERE platform = 'cloud' AND revoked_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS spaces (
    id text NOT NULL,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, id),
    CONSTRAINT spaces_id_check CHECK (id ~ '^[a-z0-9][a-z0-9-]{0,63}$' OR id = '__workspace__')
  )`,
  `CREATE TABLE IF NOT EXISTS key_wrappers (
    user_id uuid NOT NULL,
    space_id text NOT NULL,
    kind text NOT NULL,
    credential_id text NOT NULL,
    salt text NOT NULL DEFAULT '',
    wrapped text NOT NULL,
    sender_device_id uuid,
    signature text,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, space_id, kind, credential_id),
    CONSTRAINT key_wrappers_space_fk FOREIGN KEY (user_id, space_id)
      REFERENCES spaces(user_id, id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_enrollments (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    nonce text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  // The hub's key order is byte order (§4): COLLATE "C" is what makes
  // `hist:` keys come back oldest-first and prefix scans bounded.
  `CREATE TABLE IF NOT EXISTS hub_kv (
    user_id uuid NOT NULL,
    key text COLLATE "C" NOT NULL,
    value jsonb NOT NULL,
    PRIMARY KEY (user_id, key)
  )`,
  `CREATE TABLE IF NOT EXISTS egress_gateways (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    host text NOT NULL,
    port integer NOT NULL,
    egress_ipv4 text,
    region text,
    state text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS egress_credentials (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id uuid NOT NULL,
    run_id uuid,
    session_id uuid,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS egress_revocations (
    id serial PRIMARY KEY,
    device_id uuid NOT NULL,
    credential_id uuid,
    at timestamptz NOT NULL DEFAULT now()
  )`,
  // A browser session outlives every viewer and every run (§4.1); `hosted_runs`
  // references it, so it is created first.
  `CREATE TABLE IF NOT EXISTS browser_sessions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    space_id text NOT NULL,
    state text NOT NULL DEFAULT 'ready',
    revision integer NOT NULL DEFAULT 1,
    lease_worker_id text,
    lease_worker_url text,
    lease_token text,
    lease_until timestamptz,
    control_holder text NOT NULL DEFAULT 'human',
    control_generation integer NOT NULL DEFAULT 0,
    active_run_id uuid,
    last_attached_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz,
    CONSTRAINT browser_sessions_space_fk FOREIGN KEY (user_id, space_id)
      REFERENCES spaces(user_id, id) ON DELETE CASCADE,
    CONSTRAINT browser_sessions_state_check CHECK (state in ('ready', 'live', 'suspended', 'ended')),
    CONSTRAINT browser_sessions_control_check CHECK (control_holder in ('human', 'agent'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS browser_sessions_one_live_per_space_idx
    ON browser_sessions (user_id, space_id) WHERE state <> 'ended'`,
  `CREATE TABLE IF NOT EXISTS session_tickets (
    secret_hash text PRIMARY KEY,
    session_id uuid NOT NULL REFERENCES browser_sessions(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS session_tickets_expiry_idx ON session_tickets (expires_at)`,
  `CREATE TABLE IF NOT EXISTS hosted_runs (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    space_id text NOT NULL,
    task_id uuid NOT NULL,
    revision integer NOT NULL,
    status text NOT NULL,
    purpose text NOT NULL,
    intent text NOT NULL,
    attachments jsonb NOT NULL,
    origin jsonb,
    executor jsonb NOT NULL,
    capsule jsonb,
    start_url text,
    session_id uuid,
    lease_worker_id text,
    lease_worker_url text,
    lease_token text,
    lease_until timestamptz,
    pause jsonb,
    thread jsonb,
    summary jsonb,
    next_seq integer NOT NULL DEFAULT 1,
    completed_at timestamptz,
    authority_ended boolean NOT NULL DEFAULT false,
    hidden_at timestamptz,
    last_approver text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT hosted_runs_space_fk FOREIGN KEY (user_id, space_id)
      REFERENCES spaces(user_id, id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS hosted_runs_user_space_idx ON hosted_runs (user_id, space_id)`,
  `CREATE TABLE IF NOT EXISTS hosted_artifacts (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    artifact_id text NOT NULL,
    share_id text NOT NULL UNIQUE,
    revision integer NOT NULL,
    visibility text NOT NULL DEFAULT 'private',
    public_html text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz,
    PRIMARY KEY (user_id, artifact_id),
    CONSTRAINT hosted_artifacts_id_check CHECK (artifact_id ~ '^[a-f0-9]{12}$'),
    CONSTRAINT hosted_artifacts_visibility_check CHECK (visibility in ('private', 'public')),
    CONSTRAINT hosted_artifacts_public_html_check CHECK (
      (visibility = 'private' AND public_html IS NULL) OR
      (visibility = 'public' AND public_html IS NOT NULL)
    )
  )`,
  `CREATE TABLE IF NOT EXISTS run_events (
    run_id uuid NOT NULL REFERENCES hosted_runs(id) ON DELETE CASCADE,
    seq integer NOT NULL,
    event_id text NOT NULL,
    at timestamptz NOT NULL,
    event jsonb NOT NULL,
    PRIMARY KEY (run_id, seq)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS run_events_run_event_idx ON run_events (run_id, event_id)`,
  `CREATE TABLE IF NOT EXISTS run_sponsor_commands (
    run_id uuid NOT NULL REFERENCES hosted_runs(id) ON DELETE CASCADE,
    operation text NOT NULL,
    idempotency_key text NOT NULL,
    response jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, operation, idempotency_key)
  )`,
  `CREATE TABLE IF NOT EXISTS credential_captures (
    id uuid PRIMARY KEY,
    run_id uuid NOT NULL REFERENCES hosted_runs(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    space_id text NOT NULL,
    tab_id text NOT NULL,
    site_name text NOT NULL,
    site_origin text NOT NULL,
    encryption_public_key text NOT NULL,
    fields jsonb NOT NULL,
    sealed_payload text,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    submitted_at timestamptz,
    consumed_at timestamptz
  )`,
  `CREATE INDEX IF NOT EXISTS credential_captures_run_idx ON credential_captures (run_id)`,
  `CREATE INDEX IF NOT EXISTS credential_captures_expiry_idx ON credential_captures (expires_at)`,
  `CREATE TABLE IF NOT EXISTS vault_entries (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    space_id text NOT NULL,
    site_origin text NOT NULL,
    site_name text NOT NULL,
    fields jsonb NOT NULL,
    sealed_payload text NOT NULL,
    source text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    CONSTRAINT vault_entries_space_fk FOREIGN KEY (user_id, space_id)
      REFERENCES spaces(user_id, id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS vault_entries_space_origin_idx ON vault_entries (user_id, space_id, site_origin)`,
  `CREATE TABLE IF NOT EXISTS integration_connections (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    space_id text NOT NULL,
    provider text NOT NULL,
    account_label text NOT NULL,
    access text NOT NULL,
    scopes jsonb NOT NULL,
    status text NOT NULL,
    sealed_payload text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    CONSTRAINT integration_connections_space_fk FOREIGN KEY (user_id, space_id)
      REFERENCES spaces(user_id, id) ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS integration_connections_provider_idx ON integration_connections (user_id, space_id, provider)`,
  `CREATE TABLE IF NOT EXISTS channel_links (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    space_id text NOT NULL,
    name text NOT NULL,
    secret_hash text NOT NULL,
    outbound_url text,
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    CONSTRAINT channel_links_space_fk FOREIGN KEY (user_id, space_id)
      REFERENCES spaces(user_id, id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS channel_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    link_id uuid NOT NULL REFERENCES channel_links(id) ON DELETE CASCADE,
    delivery_id text NOT NULL,
    body jsonb NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    run_id uuid
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS channel_messages_link_delivery_idx
    ON channel_messages (link_id, delivery_id)`,
  `CREATE TABLE IF NOT EXISTS imessage_links (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    phone_e164 text NOT NULL UNIQUE,
    verified_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS imessage_challenges (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    phone_e164 text NOT NULL,
    code_hash text NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS imessage_challenges_user_idx ON imessage_challenges (user_id)`,
  `CREATE TABLE IF NOT EXISTS imessage_onboarding_links (
    id uuid PRIMARY KEY,
    secret_hash text NOT NULL UNIQUE,
    delivery_id text NOT NULL UNIQUE,
    phone_e164 text NOT NULL,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS imessage_onboarding_phone_idx
    ON imessage_onboarding_links (phone_e164, created_at)`,
  `CREATE TABLE IF NOT EXISTS imessage_pending_questions (
    run_id uuid NOT NULL REFERENCES hosted_runs(id) ON DELETE CASCADE,
    question_id text NOT NULL,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    question jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, question_id)
  )`,
  `CREATE INDEX IF NOT EXISTS imessage_pending_user_at_idx ON imessage_pending_questions (user_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS imessage_inbound_messages (
    delivery_id text PRIMARY KEY,
    phone_e164 text NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    run_id uuid,
    question_id text
  )`,
  `CREATE INDEX IF NOT EXISTS imessage_inbound_phone_at_idx ON imessage_inbound_messages (phone_e164, received_at)`,
  `CREATE TABLE IF NOT EXISTS notification_occurrences (
    occurrence_id text PRIMARY KEY,
    user_id uuid NOT NULL,
    fire_at timestamptz NOT NULL,
    message jsonb NOT NULL,
    status text NOT NULL,
    lease_owner text,
    lease_token text,
    lease_until timestamptz,
    attempts integer NOT NULL DEFAULT 0,
    last_error text
  )`,
  `CREATE TABLE IF NOT EXISTS audit_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_device_id uuid,
    kind text NOT NULL,
    detail jsonb,
    at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS audit_events_user_at_idx ON audit_events (user_id, at)`,
  `CREATE TABLE IF NOT EXISTS ai_usage (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id uuid NOT NULL,
    kind text NOT NULL,
    model_id text,
    status integer NOT NULL,
    input_tokens integer,
    output_tokens integer,
    cost_usd numeric(14, 8),
    request_bytes integer NOT NULL,
    response_bytes integer NOT NULL,
    duration_ms integer NOT NULL,
    at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS ai_usage_user_at_idx ON ai_usage (user_id, at)`,
  `CREATE TABLE IF NOT EXISTS ai_budgets (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    monthly_cap_usd numeric(14, 8),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS account_links (
    from_user_id uuid PRIMARY KEY,
    to_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    linked_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS sync_policy_overrides (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    host text NOT NULL,
    mode text NOT NULL,
    PRIMARY KEY (user_id, host)
  )`,
  // Convergence for databases created before these existed: `CREATE TABLE IF
  // NOT EXISTS` never revisits a table, and this file is the sole runtime DDL.
  `ALTER TABLE devices ADD COLUMN IF NOT EXISTS revocation_completed_at timestamptz`,
  `ALTER TABLE credential_captures ADD COLUMN IF NOT EXISTS encryption_public_key text`,
  `UPDATE credential_captures AS capture
    SET encryption_public_key = device.agreement_public_key
    FROM hosted_runs AS hosted, devices AS device
    WHERE capture.encryption_public_key IS NULL
      AND capture.run_id = hosted.id
      AND device.id::text = hosted.executor->>'deviceId'`,
  `UPDATE credential_captures SET encryption_public_key = '' WHERE encryption_public_key IS NULL`,
  `ALTER TABLE credential_captures ALTER COLUMN encryption_public_key SET NOT NULL`,
  // The live view has to reach the worker that actually holds the run (§8.5).
  `ALTER TABLE hosted_runs ADD COLUMN IF NOT EXISTS lease_worker_url text`,
  `CREATE TABLE IF NOT EXISTS live_tickets (
    secret_hash text PRIMARY KEY,
    run_id uuid NOT NULL REFERENCES hosted_runs(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS live_tickets_expiry_idx ON live_tickets (expires_at)`,
  // Browser sessions (web-browser-design.md §4.1) joined after the first
  // databases were created; the FK is added separately because `ADD COLUMN IF
  // NOT EXISTS` cannot carry one and `ADD CONSTRAINT` is not idempotent.
  `ALTER TABLE hosted_runs ADD COLUMN IF NOT EXISTS session_id uuid`,
  // A conversation the person forgot from a shell (§11): hidden from every
  // list, its events kept.
  `ALTER TABLE hosted_runs ADD COLUMN IF NOT EXISTS hidden_at timestamptz`,
  `ALTER TABLE egress_credentials ADD COLUMN IF NOT EXISTS session_id uuid`,
  `DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hosted_runs_session_fk') THEN
      ALTER TABLE hosted_runs ADD CONSTRAINT hosted_runs_session_fk
        FOREIGN KEY (session_id) REFERENCES browser_sessions(id) ON DELETE SET NULL;
    END IF;
  END $$`,
  // Drop the short-lived prototype column: private hosting metadata must not
  // retain a page title after its public HTML is revoked.
  `ALTER TABLE hosted_artifacts DROP COLUMN IF EXISTS title`,
  // `web` joined the platform enum after the first databases were created.
  `DO $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'devices_platform_check'
        AND pg_get_constraintdef(oid) NOT LIKE '%''web''%'
    ) THEN
      ALTER TABLE devices DROP CONSTRAINT devices_platform_check;
      ALTER TABLE devices ADD CONSTRAINT devices_platform_check
        CHECK (platform in ('macos', 'web', 'cloud'));
    END IF;
  END $$`,
  `DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hosted_runs_space_fk' AND confdeltype <> 'c') THEN
      ALTER TABLE hosted_runs DROP CONSTRAINT hosted_runs_space_fk;
      ALTER TABLE hosted_runs ADD CONSTRAINT hosted_runs_space_fk
        FOREIGN KEY (user_id, space_id) REFERENCES spaces(user_id, id) ON DELETE CASCADE;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'channel_links_space_fk' AND confdeltype <> 'c') THEN
      ALTER TABLE channel_links DROP CONSTRAINT channel_links_space_fk;
      ALTER TABLE channel_links ADD CONSTRAINT channel_links_space_fk
        FOREIGN KEY (user_id, space_id) REFERENCES spaces(user_id, id) ON DELETE CASCADE;
    END IF;
  END $$`,
  // Notes share the artifact hosting table (docs/notes.md N9): one share id
  // space, one publish path, one public CSP. `kind` is what the routes filter
  // on, and what keeps a note's share id from answering at `/public/artifacts`.
  // Every row that predates this column is an artifact, which is the default.
  `ALTER TABLE hosted_artifacts ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'artifact'`,
  `DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hosted_artifacts_kind_check') THEN
      ALTER TABLE hosted_artifacts ADD CONSTRAINT hosted_artifacts_kind_check
        CHECK (kind in ('artifact', 'note'));
    END IF;
  END $$`,
  // Sharing a note with named accounts (docs/notes.md §9): the grant, and
  // the plaintext body the grant exists for. The grant is never deleted —
  // `revoked_at` is stamped — and the body is deleted the moment the last
  // live grant on its note goes, which is the `public_html` rule again.
  `CREATE TABLE IF NOT EXISTS note_shares (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    note_id text NOT NULL,
    recipient_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    CONSTRAINT note_shares_note_id_check CHECK (note_id ~ '^[a-f0-9]{12}$'),
    CONSTRAINT note_shares_role_check CHECK (role in ('viewer', 'editor')),
    CONSTRAINT note_shares_not_self_check CHECK (owner_user_id <> recipient_user_id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS note_shares_owner_note_recipient_idx
    ON note_shares (owner_user_id, note_id, recipient_user_id)`,
  `CREATE INDEX IF NOT EXISTS note_shares_recipient_idx ON note_shares (recipient_user_id)`,
  `CREATE TABLE IF NOT EXISTS shared_notes (
    owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    note_id text NOT NULL,
    title text NOT NULL,
    markdown text NOT NULL,
    revision integer NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    PRIMARY KEY (owner_user_id, note_id),
    CONSTRAINT shared_notes_note_id_check CHECK (note_id ~ '^[a-f0-9]{12}$')
  )`,
];

/**
 * Where the applied-DDL marker lives. Deliberately not in `schema.ts`: it
 * describes the migration, not the domain, and the parity test is a
 * statement about domain tables.
 */
const SCHEMA_STATE = `CREATE TABLE IF NOT EXISTS schema_state (
    id integer PRIMARY KEY CHECK (id = 1),
    ddl_hash text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;

/** Identifies this statement list; any edit to any statement changes it. */
const DDL_HASH = createHash("sha256").update(STATEMENTS.join("\n;\n")).digest("hex");

/**
 * Advisory-lock key, so two instances booting together do not interleave
 * `DROP CONSTRAINT` with `ADD CONSTRAINT`. Held for the transaction and
 * released with it.
 */
const MIGRATION_LOCK_KEY = 0x7069_7374;

async function appliedHash(db: Db): Promise<string | null> {
  const rows = rowsOf(await db.execute(sql`SELECT ddl_hash FROM schema_state WHERE id = 1`));
  const hash = rows[0]?.["ddl_hash"];
  return typeof hash === "string" ? hash : null;
}

/**
 * Bring the database up to this build's schema. A no-op when it is already
 * there; otherwise every statement runs, in one transaction, under a lock.
 * A database written by an older build carries an older hash — or none —
 * so it still converges.
 */
export async function ensureSchema(db: Db): Promise<void> {
  await db.execute(sql.raw(SCHEMA_STATE));
  if ((await appliedHash(db)) === DDL_HASH) return;

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`);
    // Another instance may have applied it while we waited for the lock.
    if ((await appliedHash(tx as Db)) === DDL_HASH) return;
    for (const statement of STATEMENTS) {
      await tx.execute(sql.raw(statement));
    }
    await tx.execute(sql`
      INSERT INTO schema_state (id, ddl_hash, applied_at) VALUES (1, ${DDL_HASH}, now())
      ON CONFLICT (id) DO UPDATE SET ddl_hash = excluded.ddl_hash, applied_at = excluded.applied_at`);
  });
}
