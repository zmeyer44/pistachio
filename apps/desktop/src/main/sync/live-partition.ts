/**
 * Live-record partition for Spaces that have already hydrated (§10.2).
 *
 * After first hydration, remote cookie records are normally staged behind the
 * explicit Pull/Merge control so a broadcast can't disturb a site mid-use.
 * Two kinds of record invert that trade-off and are applied the moment they
 * arrive:
 *
 *  - Rotating-auth origins: the server retires the previous cookie
 *    generation on every rotation, so a staged record means this device is
 *    now holding dead credentials and will be signed out on its next request.
 *  - Records authored by the cloud browser: it drives the Space under an
 *    exclusive lease while this desktop defers (D10), so what it wrote is the
 *    live session, not a competing one.
 *
 * Everything else keeps the stage-for-explicit-Pull behaviour.
 */

import type { CookieRecordWire } from "@pistachio/sync-protocol";
import type { SpaceSyncEngine } from "@pistachio/sync-engine";

export type LivePartitionEngine = Pick<
  SpaceSyncEngine,
  "inspectRemoteIdentity" | "getOriginPolicyFor"
>;

export interface LivePartition {
  /** Rotating-auth and cloud-authored records — apply now. */
  autoApply: CookieRecordWire[];
  /** Everything else — stage for the explicit Pull/Merge control. */
  stage: CookieRecordWire[];
}

export async function partitionLiveRecords(
  engine: LivePartitionEngine,
  records: readonly CookieRecordWire[],
  isCloudDevice: (deviceId: string) => boolean = () => false,
): Promise<LivePartition> {
  const autoApply: CookieRecordWire[] = [];
  const stage: CookieRecordWire[] = [];
  for (const record of records) {
    // Sealed records don't reveal their origin; inspection decrypts the
    // identity without mutating engine or browser state. A record this device
    // cannot open or verify is staged — the pull path will judge it again.
    const identity = await engine.inspectRemoteIdentity(record);
    if (identity !== null) {
      const view = engine.getOriginPolicyFor(identity.hostKey);
      if (view.synced && (view.policy.rotatingAuth || isCloudDevice(record.hlc.deviceId))) {
        autoApply.push(record);
        continue;
      }
    }
    stage.push(record);
  }
  return { autoApply, stage };
}
