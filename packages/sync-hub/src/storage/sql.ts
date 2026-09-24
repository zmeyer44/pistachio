/**
 * HubStorage over the control plane's `hub_kv` table
 * (docs/cloud-sync-design.md §4, §7.1):
 *
 *   hub_kv(user_id uuid not null, key text collate "C" not null,
 *          value jsonb not null, primary key (user_id, key))
 *
 * One storage per user; every method is a single autocommit statement and
 * never opens a transaction. The per-user chain in the host serializes
 * callers, so read-modify-write sequences in HubCore stay consistent.
 *
 * `list` is a range scan under `COLLATE "C"` (byte order of the
 * UTF-8 encoding), which is what makes `hist:` keys — which embed
 * `encodeHlc` — come back oldest-first. The upper bound replaces the last
 * code point of the prefix with its successor; the `|| '￿'` idiom is not
 * used because U+FFFF is neither the largest code point nor a character.
 */

import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { TablesRelationalConfig } from "drizzle-orm";
import type { HubStorage } from "../hub-core.js";

const MAX_CODE_POINT = 0x10ffff;
const isSurrogate = (cp: number): boolean => cp >= 0xd800 && cp <= 0xdfff;

/**
 * Smallest string greater than every string starting with `prefix`, under
 * byte (UTF-8) or code-unit order alike: the prefix with its last code point
 * replaced by the next one. Throws for an empty prefix, a prefix ending in a
 * lone surrogate, and a prefix ending in U+10FFFF (no successor exists).
 */
export function prefixUpperBound(prefix: string): string {
  if (prefix.length === 0) {
    throw new Error("prefixUpperBound: empty prefix has no upper bound");
  }
  let start = prefix.length - 1;
  const lastUnit = prefix.charCodeAt(start);
  if (lastUnit >= 0xdc00 && lastUnit <= 0xdfff && start > 0) {
    const previous = prefix.charCodeAt(start - 1);
    if (previous >= 0xd800 && previous <= 0xdbff) start -= 1;
  }
  const last = prefix.codePointAt(start);
  if (last === undefined || isSurrogate(last)) {
    throw new Error("prefixUpperBound: prefix ends in a lone surrogate");
  }
  let next = last + 1;
  // Skip the surrogate block: those code points are not encodable, and
  // U+E000 is the next code point that sorts above everything below it.
  if (isSurrogate(next)) next = 0xe000;
  if (next > MAX_CODE_POINT) {
    throw new Error("prefixUpperBound: prefix ends in U+10FFFF");
  }
  return prefix.slice(0, start) + String.fromCodePoint(next);
}

type Row = Record<string, unknown>;

/** Drivers disagree on `execute`'s shape: postgres-js resolves to an array
 * of rows, PGlite and node-postgres to `{rows}`. */
function rowsOf(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  if (
    typeof result === "object" &&
    result !== null &&
    Array.isArray((result as { rows?: unknown }).rows)
  ) {
    return (result as { rows: Row[] }).rows;
  }
  throw new Error("SqlHubStorage: unrecognised query result shape");
}

export class SqlHubStorage<
  TResult extends PgQueryResultHKT = PgQueryResultHKT,
  TFullSchema extends Record<string, unknown> = Record<string, unknown>,
  TSchema extends TablesRelationalConfig = TablesRelationalConfig,
> implements HubStorage
{
  constructor(
    private readonly db: PgDatabase<TResult, TFullSchema, TSchema>,
    private readonly userId: string,
  ) {}

  private async run(query: ReturnType<typeof sql>): Promise<Row[]> {
    const result: unknown = await this.db.execute(query);
    return rowsOf(result);
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const rows = await this.run(
      sql`SELECT value FROM hub_kv WHERE user_id = ${this.userId} AND key = ${key} LIMIT 1`,
    );
    const row = rows[0];
    return row === undefined ? undefined : (row.value as T);
  }

  async put<T>(key: string, value: T): Promise<void> {
    // The parameter travels as text and is cast server-side, so no driver
    // applies its own JSON serializer to an already-encoded document.
    const encoded = JSON.stringify(value);
    await this.run(
      sql`INSERT INTO hub_kv (user_id, key, value) VALUES (${this.userId}, ${key}, ${encoded}::text::jsonb) ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value`,
    );
  }

  async delete(key: string): Promise<boolean> {
    const rows = await this.run(
      sql`DELETE FROM hub_kv WHERE user_id = ${this.userId} AND key = ${key} RETURNING key`,
    );
    return rows.length > 0;
  }

  async list<T = unknown>(options: {
    prefix: string;
    limit?: number;
  }): Promise<Map<string, T>> {
    const { prefix, limit } = options;
    const out = new Map<string, T>();
    if (limit !== undefined && limit <= 0) return out;
    // `LIMIT ALL` is Postgres for "no cap", so the bounded and unbounded
    // shapes stay one statement instead of two.
    const cap = limit === undefined ? sql`ALL` : sql`${Math.floor(limit)}`;
    const rows =
      prefix.length === 0
        ? await this.run(
            sql`SELECT key, value FROM hub_kv WHERE user_id = ${this.userId} ORDER BY key COLLATE "C" LIMIT ${cap}`,
          )
        : await this.run(
            sql`SELECT key, value FROM hub_kv WHERE user_id = ${this.userId} AND key >= ${prefix} COLLATE "C" AND key < ${prefixUpperBound(prefix)} COLLATE "C" ORDER BY key COLLATE "C" LIMIT ${cap}`,
          );
    for (const row of rows) out.set(row.key as string, row.value as T);
    return out;
  }
}
