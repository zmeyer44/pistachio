/**
 * `HostedRunStore` over `hosted_runs` (docs/cloud-sync-design.md §7.5).
 * Bind it to a transaction handle to make a coordinator transition and its
 * trailing events one unit; `compareAndSet` writes every column of the
 * record under `WHERE id = $1 AND revision = $2`.
 */

import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type {
  ClaimedRun,
  HostedRunRecord,
  HostedRunStore,
  RunLease,
} from "@pistachio/runtime";
import type { TaskStatus } from "@pistachio/protocol";
import type { Db } from "../db/client.js";
import { hostedRuns } from "../db/schema.js";

type Row = typeof hostedRuns.$inferSelect;

const CLAIMABLE: TaskStatus[] = ["ready", "running", "human_control"];
const WAITING: TaskStatus[] = ["waiting_for_approval", "waiting_for_judgment", "waiting_for_step_up"];

export function rowToRecord(row: Row): HostedRunRecord {
  const lease: RunLease | null =
    row.leaseWorkerId !== null && row.leaseToken !== null && row.leaseUntil !== null
      ? {
          workerId: row.leaseWorkerId,
          workerUrl: row.leaseWorkerUrl,
          token: row.leaseToken,
          until: row.leaseUntil.toISOString(),
        }
      : null;
  return {
    id: row.id,
    taskId: row.taskId,
    sponsorId: row.userId,
    userId: row.userId,
    spaceId: row.spaceId,
    capsuleId: row.capsule?.id ?? row.id,
    capsule: row.capsule ?? null,
    purpose: row.purpose,
    intent: row.intent,
    attachments: row.attachments,
    origin: row.origin ?? null,
    executor: row.executor,
    startUrl: row.startUrl,
    sessionId: row.sessionId,
    status: row.status as TaskStatus,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    lease,
    pause: row.pause ?? null,
    authorityEnded: row.authorityEnded,
    lastApprover: row.lastApprover,
  };
}

function recordToColumns(record: HostedRunRecord): Omit<typeof hostedRuns.$inferInsert, "id" | "nextSeq" | "thread" | "summary"> {
  return {
    userId: record.userId,
    spaceId: record.spaceId,
    taskId: record.taskId,
    revision: record.revision,
    status: record.status,
    purpose: record.purpose,
    intent: record.intent,
    attachments: record.attachments,
    origin: record.origin ?? null,
    executor: record.executor,
    capsule: record.capsule,
    startUrl: record.startUrl,
    sessionId: record.sessionId,
    leaseWorkerId: record.lease?.workerId ?? null,
    leaseWorkerUrl: record.lease?.workerUrl ?? null,
    leaseToken: record.lease?.token ?? null,
    leaseUntil: record.lease === null ? null : new Date(record.lease.until),
    pause: record.pause,
    completedAt: record.completedAt === null ? null : new Date(record.completedAt),
    authorityEnded: record.authorityEnded,
    lastApprover: record.lastApprover,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

export class PostgresHostedRunStore implements HostedRunStore {
  constructor(private readonly db: Db) {}

  async create(record: HostedRunRecord): Promise<void> {
    await this.db.insert(hostedRuns).values({ id: record.id, ...recordToColumns(record) });
  }

  async get(runId: string): Promise<HostedRunRecord | null> {
    const [row] = await this.db.select().from(hostedRuns).where(eq(hostedRuns.id, runId));
    return row === undefined ? null : rowToRecord(row);
  }

  async listClaimable(now: number, limit: number): Promise<HostedRunRecord[]> {
    const rows = await this.db
      .select()
      .from(hostedRuns)
      .where(
        and(
          sql`${hostedRuns.executor}->>'kind' = 'cloud'`,
          inArray(hostedRuns.status, CLAIMABLE),
          or(isNull(hostedRuns.leaseUntil), lt(hostedRuns.leaseUntil, new Date(now))),
        ),
      )
      .orderBy(asc(hostedRuns.createdAt), asc(hostedRuns.id))
      .limit(Math.max(0, limit));
    return rows.map(rowToRecord);
  }

  async claimExpiredPauses(options: {
    workerId: string;
    now: number;
    leaseMs: number;
    limit: number;
  }): Promise<ClaimedRun[]> {
    const now = new Date(options.now);
    const rows = await this.db
      .select()
      .from(hostedRuns)
      .where(
        and(
          inArray(hostedRuns.status, WAITING),
          sql`${hostedRuns.pause} is not null`,
          sql`(${hostedRuns.pause}->>'expiresAt')::timestamptz <= ${now}`,
          or(isNull(hostedRuns.leaseUntil), lt(hostedRuns.leaseUntil, now)),
        ),
      )
      .orderBy(asc(sql`${hostedRuns.pause}->>'expiresAt'`), asc(hostedRuns.id))
      .limit(Math.max(0, options.limit))
      .for("update", { skipLocked: true });
    const claimed: ClaimedRun[] = [];
    for (const row of rows) {
      const leaseToken = randomUUID();
      const [updated] = await this.db
        .update(hostedRuns)
        .set({
          leaseWorkerId: options.workerId,
          // Control's own pause sweep; no browser behind it to watch.
          leaseWorkerUrl: null,
          leaseToken,
          leaseUntil: new Date(options.now + options.leaseMs),
          revision: row.revision + 1,
          updatedAt: now,
        })
        .where(and(eq(hostedRuns.id, row.id), eq(hostedRuns.revision, row.revision)))
        .returning();
      if (updated !== undefined) claimed.push({ run: rowToRecord(updated), leaseToken });
    }
    return claimed;
  }

  async compareAndSet(
    runId: string,
    expectedRevision: number,
    next: HostedRunRecord,
  ): Promise<boolean> {
    if (next.id !== runId || next.revision !== expectedRevision + 1) {
      throw new Error("compareAndSet requires an unchanged id and incremented revision");
    }
    const updated = await this.db
      .update(hostedRuns)
      .set(recordToColumns(next))
      .where(and(eq(hostedRuns.id, runId), eq(hostedRuns.revision, expectedRevision)))
      .returning({ id: hostedRuns.id });
    return updated.length === 1;
  }
}
