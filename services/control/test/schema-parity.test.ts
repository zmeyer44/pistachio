/**
 * `migrate.ts` is the sole runtime DDL; `schema.ts` must describe exactly
 * the columns it creates. For every exported pgTable, the Drizzle column
 * set equals `information_schema.columns` on PGlite.
 */

import { getTableColumns, getTableName, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { beforeAll, describe, expect, it } from "vitest";
import { rowsOf } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { makeDb } from "./helpers.js";
import type { Db } from "../src/db/client.js";

let db: Db;

beforeAll(async () => {
  db = await makeDb();
});

const tables: Array<[string, PgTable]> = [];
for (const [name, value] of Object.entries(schema)) {
  if (value instanceof PgTable) tables.push([name, value]);
}

describe("schema parity", () => {
  it("exports every §7.1 table", () => {
    const names = tables.map(([, table]) => getTableName(table)).sort();
    expect(names).toEqual(
      [
        "users",
        "auth_accounts",
        "auth_verifications",
        "auth_sessions",
        "devices",
        "spaces",
        "key_wrappers",
        "cloud_enrollments",
        "hub_kv",
        "egress_gateways",
        "egress_credentials",
        "egress_revocations",
        "hosted_runs",
        "hosted_artifacts",
        "note_shares",
        "shared_notes",
        "browser_sessions",
        "session_tickets",
        "live_tickets",
        "run_events",
        "run_sponsor_commands",
        "credential_captures",
        "vault_entries",
        "integration_connections",
        "channel_links",
        "channel_messages",
        "imessage_links",
        "imessage_challenges",
        "imessage_onboarding_links",
        "imessage_pending_questions",
        "imessage_inbound_messages",
        "notification_occurrences",
        "audit_events",
        "account_links",
        "ai_usage",
        "ai_budgets",
        "sync_policy_overrides",
      ].sort(),
    );
  });

  for (const [exportName, table] of tables) {
    it(`${exportName} matches ${getTableName(table)} after ensureSchema`, async () => {
      const expected = Object.values(getTableColumns(table))
        .map((column) => column.name)
        .sort();
      const result = await db.execute(
        sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${getTableName(table)}`,
      );
      const actual = rowsOf(result)
        .map((row) => row["column_name"] as string)
        .sort();
      expect(actual).toEqual(expected);
    });
  }

  it("declares the partial unique index for one live cloud device per user", async () => {
    const result = await db.execute(
      sql`SELECT indexdef FROM pg_indexes WHERE tablename = 'devices' AND indexname = 'devices_one_live_cloud_per_user_idx'`,
    );
    const def = rowsOf(result)[0]?.["indexdef"] as string;
    expect(def).toContain("UNIQUE");
    expect(def.toLowerCase()).toContain("where");
    expect(def.toLowerCase()).toContain("revoked_at is null");
  });

  it("declares the partial unique index for one live browser session per Space", async () => {
    const result = await db.execute(
      sql`SELECT indexdef FROM pg_indexes WHERE tablename = 'browser_sessions' AND indexname = 'browser_sessions_one_live_per_space_idx'`,
    );
    const def = rowsOf(result)[0]?.["indexdef"] as string;
    expect(def).toContain("UNIQUE");
    expect(def).toContain("user_id");
    expect(def).toContain("space_id");
    expect(def.toLowerCase()).toContain("where");
    expect(def.toLowerCase()).toContain("'ended'");
  });

  it("converges a database that predates browser sessions", async () => {
    const { ensureSchema } = await import("../src/db/migrate.js");
    const legacy = await makeDb();
    for (const statement of [
      "ALTER TABLE hosted_runs DROP CONSTRAINT hosted_runs_session_fk",
      "ALTER TABLE hosted_runs DROP COLUMN session_id",
      "ALTER TABLE egress_credentials DROP COLUMN session_id",
      "DROP TABLE session_tickets",
      "DROP TABLE browser_sessions",
    ]) {
      await legacy.execute(sql.raw(statement));
    }
    await legacy.execute(sql`DELETE FROM schema_state`);
    await ensureSchema(legacy);
    const columns = await legacy.execute(
      sql`SELECT table_name, column_name FROM information_schema.columns
          WHERE column_name = 'session_id' AND table_name in ('hosted_runs', 'egress_credentials')`,
    );
    expect(rowsOf(columns)).toHaveLength(2);
    const fk = await legacy.execute(
      sql`SELECT confdeltype FROM pg_constraint WHERE conname = 'hosted_runs_session_fk'`,
    );
    // `ON DELETE SET NULL`: a session that ends and is swept away must not
    // take the run's history with it.
    expect(rowsOf(fk)).toEqual([expect.objectContaining({ confdeltype: "n" })]);
    const tables = await legacy.execute(
      sql`SELECT table_name FROM information_schema.tables WHERE table_name in ('browser_sessions', 'session_tickets')`,
    );
    expect(rowsOf(tables)).toHaveLength(2);
  });

  it("is idempotent", async () => {
    const { ensureSchema } = await import("../src/db/migrate.js");
    await expect(ensureSchema(db)).resolves.toBeUndefined();
  });

  it("converges a database that predates the cascade FKs and the revocation marker", async () => {
    const { ensureSchema } = await import("../src/db/migrate.js");
    const legacy = await makeDb();
    for (const statement of [
      "ALTER TABLE devices DROP COLUMN revocation_completed_at",
      "ALTER TABLE credential_captures DROP COLUMN encryption_public_key",
      "ALTER TABLE devices DROP CONSTRAINT devices_platform_check",
      "ALTER TABLE devices ADD CONSTRAINT devices_platform_check CHECK (platform in ('macos', 'cloud'))",
      "ALTER TABLE hosted_runs DROP CONSTRAINT hosted_runs_space_fk",
      "ALTER TABLE hosted_runs ADD CONSTRAINT hosted_runs_space_fk FOREIGN KEY (user_id, space_id) REFERENCES spaces(user_id, id)",
      "ALTER TABLE channel_links DROP CONSTRAINT channel_links_space_fk",
      "ALTER TABLE channel_links ADD CONSTRAINT channel_links_space_fk FOREIGN KEY (user_id, space_id) REFERENCES spaces(user_id, id)",
    ]) {
      await legacy.execute(sql.raw(statement));
    }
    // A database written by an older build carries that build's DDL hash, or
    // none at all — dropping the marker is part of simulating one.
    await legacy.execute(sql`DELETE FROM schema_state`);
    await ensureSchema(legacy);
    const column = await legacy.execute(
      sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'devices' AND column_name = 'revocation_completed_at'`,
    );
    expect(rowsOf(column)).toHaveLength(1);
    const captureKeyColumn = await legacy.execute(
      sql`SELECT is_nullable FROM information_schema.columns WHERE table_name = 'credential_captures' AND column_name = 'encryption_public_key'`,
    );
    expect(rowsOf(captureKeyColumn)).toEqual([expect.objectContaining({ is_nullable: "NO" })]);
    const constraints = await legacy.execute(
      sql`SELECT conname, confdeltype FROM pg_constraint WHERE conname in ('hosted_runs_space_fk', 'channel_links_space_fk')`,
    );
    const rules = rowsOf(constraints);
    expect(rules).toHaveLength(2);
    expect(rules.every((row) => row["confdeltype"] === "c")).toBe(true);
    const platform = await legacy.execute(
      sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'devices_platform_check'`,
    );
    expect(rowsOf(platform)[0]?.["def"]).toContain("'web'");
  });

  it("does not replay the DDL against a database already at this schema", async () => {
    const { ensureSchema } = await import("../src/db/migrate.js");
    const fresh = await makeDb();
    const first = rowsOf(await fresh.execute(sql`SELECT applied_at FROM schema_state WHERE id = 1`));
    expect(first).toHaveLength(1);

    await ensureSchema(fresh);

    // The change path rewrites `applied_at`; an untouched value means the
    // boot took the skip and issued no DDL.
    const second = rowsOf(await fresh.execute(sql`SELECT applied_at FROM schema_state WHERE id = 1`));
    expect(String(second[0]?.["applied_at"])).toEqual(String(first[0]?.["applied_at"]));
  });

  it("accepts every platform of the enum and refuses anything else", async () => {
    const fresh = await makeDb();
    await fresh.execute(sql.raw("INSERT INTO users (id, email) VALUES ('11111111-1111-1111-1111-111111111111', 'p@example.com')"));
    const insert = (id: string, platform: string): string =>
      `INSERT INTO devices (id, user_id, name, platform, device_public_key, agreement_public_key)
       VALUES ('${id}', '11111111-1111-1111-1111-111111111111', 'd', '${platform}', 'k-${platform}', 'a')`;
    await fresh.execute(sql.raw(insert("22222222-2222-2222-2222-222222222222", "macos")));
    await fresh.execute(sql.raw(insert("33333333-3333-3333-3333-333333333333", "web")));
    await fresh.execute(sql.raw(insert("44444444-4444-4444-4444-444444444444", "cloud")));
    await expect(
      fresh.execute(sql.raw(insert("55555555-5555-5555-5555-555555555555", "linux"))),
    ).rejects.toThrow();
  });
});
