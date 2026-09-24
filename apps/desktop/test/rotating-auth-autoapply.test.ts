/**
 * Live-record partition (docs/cloud-sync-design.md §10.2, live-partition.ts).
 *
 * Regression for the Mac-A-goes-stale incident: Mac A signed into Gmail,
 * linked Mac B, and B's use of the session rotated Google's cookies. The
 * rotated records reached A but were staged behind the explicit Pull, so A
 * kept presenting the retired generation and Google signed it out. Live
 * records for rotating-auth origins must be applied on arrival — and so must
 * records the cloud browser wrote while it drove the Space under its
 * exclusive lease (D10). Everything else keeps the stage-for-Pull behaviour.
 */

import { describe, expect, it } from "vitest";
import {
  deriveSpaceKeys,
  generateDeviceKeypair,
  SPACE_ROOT_SECRET_BYTES,
  type Cause,
  type CookieAttributes,
  type CookieIdentity,
  type CookiePlain,
  type CookieRecordWire,
  type DeviceKeypair,
  type SpaceKeys,
} from "@pistachio/sync-protocol";
import { SpaceSyncEngine, type CookieApplier, type LeaseOutcome, type SyncTransport } from "@pistachio/sync-engine";
import { partitionLiveRecords } from "../src/main/sync/live-partition";

class RecordingApplier implements CookieApplier {
  readonly applied: Array<{ plain: CookiePlain; cause: Cause }> = [];

  apply(plain: CookiePlain, cause: Cause): Promise<void> {
    this.applied.push({ plain, cause });
    return Promise.resolve();
  }
}

const GRANTED: LeaseOutcome = { granted: true, exclusive: false };

const grantingTransport: SyncTransport = {
  publish: () => undefined,
  acquireLease: () => Promise.resolve(GRANTED),
  releaseLease: () => undefined,
};

function identityFor(spaceId: string, hostKey: string, name: string): CookieIdentity {
  return { spaceId, hostKey, name, path: "/", partitionKey: "", sourceScheme: "secure" };
}

function attrsFor(value: string): CookieAttributes {
  return {
    value,
    expiresMs: null,
    persistent: false,
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    priority: "medium",
  };
}

interface Device {
  engine: SpaceSyncEngine;
  applier: RecordingApplier;
}

async function createDevice(spaceId: string, deviceId: string, keys: SpaceKeys, keypair: DeviceKeypair): Promise<Device> {
  const applier = new RecordingApplier();
  const engine = new SpaceSyncEngine(
    spaceId,
    keys,
    { deviceId, privateKey: keypair.privateKey },
    grantingTransport,
    applier,
    { deviceId, leaseKind: "desktop" },
  );
  return { engine, applier };
}

async function linked(spaceId: string): Promise<{ a: Device; b: Device; cloud: Device }> {
  const keys = await deriveSpaceKeys(spaceId, new Uint8Array(SPACE_ROOT_SECRET_BYTES).fill(7));
  const keypair = await generateDeviceKeypair();
  return {
    a: await createDevice(spaceId, "mac-a", keys, keypair),
    b: await createDevice(spaceId, "mac-b", keys, keypair),
    cloud: await createDevice(spaceId, "cloud-1", keys, keypair),
  };
}

function mustWire(wire: CookieRecordWire | null): CookieRecordWire {
  if (wire === null) throw new Error("expected a published record");
  return wire;
}

const isCloud = (deviceId: string): boolean => deviceId === "cloud-1";

describe("live-record partition (§10.2)", () => {
  it("partitions rotating-auth records to auto-apply and stages the rest", async () => {
    const spaceId = "space-live-partition";
    const { a, b } = await linked(spaceId);

    const rotated = mustWire(
      await b.engine.localChange(identityFor(spaceId, "gmail.com", "__Secure-1PSIDTS"), attrsFor("rotated-on-mac-b"), false, "overwrite"),
    );
    const portable = mustWire(
      await b.engine.localChange(identityFor(spaceId, "github.com", "user_session"), attrsFor("gh-session"), false, "explicit"),
    );

    const partition = await partitionLiveRecords(a.engine, [rotated, portable], isCloud);
    expect(partition.autoApply.map((r) => r.recordId)).toEqual([rotated.recordId]);
    expect(partition.stage.map((r) => r.recordId)).toEqual([portable.recordId]);
  });

  it("Mac A's jar picks up Mac B's rotation without a manual pull", async () => {
    const spaceId = "space-live-rotation";
    const { a, b } = await linked(spaceId);

    const rotated = mustWire(
      await b.engine.localChange(identityFor(spaceId, "gmail.com", "__Secure-1PSIDTS"), attrsFor("fresh-generation"), false, "overwrite"),
    );

    const { autoApply } = await partitionLiveRecords(a.engine, [rotated], isCloud);
    expect(await a.engine.applyRemote(autoApply)).toEqual(["applied"]);
    expect(a.applier.applied.at(-1)?.plain.attributes?.value).toBe("fresh-generation");
  });

  it("applies what the cloud browser wrote on arrival, even for a non-rotating origin (D10)", async () => {
    const spaceId = "space-live-cloud";
    const { a, cloud } = await linked(spaceId);

    const written = mustWire(
      await cloud.engine.localChange(identityFor(spaceId, "github.com", "user_session"), attrsFor("cloud-session"), false, "explicit"),
    );

    const partition = await partitionLiveRecords(a.engine, [written], isCloud);
    expect(partition.autoApply.map((r) => r.recordId)).toEqual([written.recordId]);
    expect(partition.stage).toHaveLength(0);
    expect(await a.engine.applyRemote(partition.autoApply)).toEqual(["applied"]);
    expect(a.applier.applied.at(-1)?.plain.attributes?.value).toBe("cloud-session");
  });

  it("without a registry every non-rotating record stays staged, whoever wrote it", async () => {
    const spaceId = "space-live-unknown";
    const { a, cloud } = await linked(spaceId);
    const written = mustWire(
      await cloud.engine.localChange(identityFor(spaceId, "github.com", "user_session"), attrsFor("cloud-session"), false, "explicit"),
    );
    const partition = await partitionLiveRecords(a.engine, [written]);
    expect(partition.autoApply).toHaveLength(0);
    expect(partition.stage.map((r) => r.recordId)).toEqual([written.recordId]);
  });

  it("a person's 'never sync' override keeps rotating-auth and cloud records staged", async () => {
    const spaceId = "space-live-never";
    const { a, b, cloud } = await linked(spaceId);
    a.engine.setOriginOverride("gmail.com", "never");
    a.engine.setOriginOverride("github.com", "never");

    const rotated = mustWire(
      await b.engine.localChange(identityFor(spaceId, "gmail.com", "__Secure-1PSIDTS"), attrsFor("rotated"), false, "overwrite"),
    );
    const written = mustWire(
      await cloud.engine.localChange(identityFor(spaceId, "github.com", "user_session"), attrsFor("cloud-session"), false, "explicit"),
    );

    const partition = await partitionLiveRecords(a.engine, [rotated, written], isCloud);
    expect(partition.autoApply).toHaveLength(0);
    expect(partition.stage.map((r) => r.recordId)).toEqual([rotated.recordId, written.recordId]);
  });

  it("stages a record it cannot open rather than applying it blind", async () => {
    const spaceId = "space-live-miskeyed";
    const { b } = await linked(spaceId);
    const foreignKeys = await deriveSpaceKeys(spaceId, new Uint8Array(SPACE_ROOT_SECRET_BYTES).fill(9));
    const keypair = await generateDeviceKeypair();
    const misKeyed = await createDevice(spaceId, "mac-miskeyed", foreignKeys, keypair);

    const rotated = mustWire(
      await b.engine.localChange(identityFor(spaceId, "gmail.com", "__Secure-1PSIDTS"), attrsFor("sealed-elsewhere"), false, "overwrite"),
    );

    const partition = await partitionLiveRecords(misKeyed.engine, [rotated], isCloud);
    expect(partition.autoApply).toHaveLength(0);
    expect(partition.stage.map((r) => r.recordId)).toEqual([rotated.recordId]);
  });
});
