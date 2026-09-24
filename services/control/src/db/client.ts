import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import postgres from "postgres";
import * as schema from "./schema.js";

/**
 * Driver-agnostic database handle: postgres-js in production, PGlite in
 * tests and local dev. A `PgTransaction` satisfies it too, so the hosted-run
 * store and event sink can be bound to a transaction (§7.5).
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * Notices `ensureSchema` is *designed* to produce. Every boot replays the
 * whole idempotent DDL, and Postgres announces each object it skips — one
 * NOTICE per table, index and constraint, on every start. postgres-js prints
 * notices to the console by default, so without this the log is dominated by
 * the migration working correctly. PGlite never surfaced them, which is why
 * this only appears on a real Postgres.
 *
 * Anything outside this set still reaches the log: a notice that is not the
 * expected cost of `IF NOT EXISTS` is worth reading.
 */
const IDEMPOTENT_DDL_NOTICES: ReadonlySet<string> = new Set([
  "42P07", // duplicate_table — relation (table or index) already exists
  "42710", // duplicate_object — constraint or type already exists
  "42P06", // duplicate_schema
  "42701", // duplicate_column
]);

export function createDb(url: string): PostgresJsDatabase<typeof schema> {
  const client = postgres(url, {
    // Pooled endpoints do not support prepared statements.
    prepare: false,
    onnotice: (notice) => {
      if (IDEMPOTENT_DDL_NOTICES.has(notice.code ?? "")) return;
      console.warn(`[db] ${notice.severity ?? "NOTICE"} ${notice.code ?? ""}: ${notice.message ?? ""}`.trim());
    },
  });
  return drizzle(client, { schema });
}

/** Local-dev PGlite data directory, relative to the service's working dir. */
const PGLITE_DEFAULT_DIR = ".pglite";

/**
 * Resolve `DATABASE_URL` to a handle. A Postgres URL goes to `createDb`; the
 * sentinel `pglite` (optionally `pglite:<dir>`) starts the embedded PGlite
 * the tests already run on. PGlite is a devDependency, so the import is
 * dynamic: a production boot never touches it.
 */
export async function createDbFromUrl(url: string): Promise<Db> {
  if (url !== "pglite" && !url.startsWith("pglite:")) return createDb(url);
  const dir = url === "pglite" ? PGLITE_DEFAULT_DIR : url.slice("pglite:".length);
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle: drizzlePglite } = await import("drizzle-orm/pglite");
  console.warn(
    `DATABASE_URL=${url}: running on embedded PGlite in ${dir}. Local dev only.`,
  );
  return drizzlePglite(new PGlite(dir), { schema });
}

type Row = Record<string, unknown>;

/**
 * Drivers disagree on `execute`'s shape: postgres-js resolves to an array of
 * rows, PGlite and node-postgres to `{rows}`.
 */
export function rowsOf(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  if (
    typeof result === "object" &&
    result !== null &&
    Array.isArray((result as { rows?: unknown }).rows)
  ) {
    return (result as { rows: Row[] }).rows;
  }
  throw new Error("unrecognised query result shape");
}
