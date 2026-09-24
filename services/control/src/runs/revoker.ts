/**
 * Control's `AuthorityRevoker` (docs/cloud-sync-design.md §7.5).
 *
 *   destroyCapsuleKey(_, run) → hub.releaseLeases(run.userId, {deviceId: <live
 *     cloud device>, spaceId: run.spaceId}) — the cloud device's exclusive
 *     leases for the run's Space are dropped so desktops can write again.
 *   cutRuntimeEgress(runId, run) → every credential minted for the run is
 *     revoked and fed to the gateway's revocation feed.
 *
 * Both are idempotent. The hub call is DEFERRED until the caller's
 * transaction commits: the hub's storage runs its own autocommit statements
 * on the same database, which cannot interleave with an open transaction on
 * a single-connection driver (PGlite), and a lease released for a
 * transition that then rolls back would be wrong anyway.
 */

import { and, eq, isNull } from "drizzle-orm";
import type { AuthorityRevoker, HostedRunRecord } from "@pistachio/runtime";
import type { HubHost } from "@pistachio/sync-hub";
import type { Db } from "../db/client.js";
import { devices, egressCredentials, egressRevocations } from "../db/schema.js";

export interface ControlRevokerDeps {
  db: Db;
  hub: () => HubHost | null;
  /** Queue work for after the surrounding transaction commits. */
  afterCommit: (task: () => Promise<void>) => void;
}

export class ControlAuthorityRevoker implements AuthorityRevoker {
  constructor(private readonly deps: ControlRevokerDeps) {}

  async destroyCapsuleKey(_capsuleId: string, run: HostedRunRecord): Promise<void> {
    const [cloud] = await this.deps.db
      .select({ id: devices.id })
      .from(devices)
      .where(
        and(eq(devices.userId, run.userId), eq(devices.platform, "cloud"), isNull(devices.revokedAt)),
      );
    const deviceId = run.executor.kind === "cloud" ? (run.executor.deviceId ?? cloud?.id ?? null) : null;
    if (deviceId === null) return;
    this.deps.afterCommit(async () => {
      const hub = this.deps.hub();
      if (hub === null) return;
      await hub.releaseLeases(run.userId, { deviceId, spaceId: run.spaceId });
    });
  }

  async cutRuntimeEgress(runId: string, _run: HostedRunRecord): Promise<void> {
    const revoked = await this.deps.db
      .update(egressCredentials)
      .set({ revokedAt: new Date() })
      .where(and(eq(egressCredentials.runId, runId), isNull(egressCredentials.revokedAt)))
      .returning({ id: egressCredentials.id, deviceId: egressCredentials.deviceId });
    if (revoked.length === 0) return;
    await this.deps.db
      .insert(egressRevocations)
      .values(revoked.map((row) => ({ deviceId: row.deviceId, credentialId: row.id })));
  }
}
