/**
 * The enrolled-device registry behind the sync engines' `reject` verifier
 * (D15, §10.2): every non-revoked row of `GET /devices` keyed by its one id
 * (D24), plus this Mac's own key from the store. Refreshed on start, on
 * `devices:updated`, and — once per unknown device id, throttled — when a
 * record arrives from a device the registry does not know, so a peer
 * enrolled a moment ago verifies without waiting for the next refresh.
 *
 * It also answers which devices are the cloud browser, for the live-record
 * auto-apply rule (live-partition.ts), and verifies the workspace lane's
 * device signatures — the cookie lane's verifier only knows cookie records,
 * so `verifyWorkspace` re-uses the same keys over the workspace layout.
 */

import { DeviceRegistryVerifier, type RecordVerifier } from "@pistachio/sync-engine";
import {
  fromBase64,
  importPublicKeyRaw,
  workspaceSigningBytes,
  type CookieRecordWire,
  type WorkspaceRecordWire,
} from "@pistachio/sync-protocol";
import type { DevicePlatform } from "@pistachio/shell-contracts/ipc";

/** How long an unknown device id is left alone after a refresh failed to add it. */
const UNKNOWN_RETRY_MS = 60_000;

/** The `GET /devices` row fields the registry reads (§7.3 `Device`). */
export interface DeviceRegistryRow {
  id: string;
  platform: DevicePlatform;
  /** base64 raw Ed25519 public key. */
  devicePublicKey: string;
  revokedAt: string | null;
}

export interface DeviceRegistryDeps {
  local: { deviceId: string; publicKey: CryptoKey };
  /** `GET /devices` (the raw ControlClient call, so a refresh never republishes the device list); rejects when control is unreachable. */
  fetchDevices(): Promise<DeviceRegistryRow[]>;
  now?(): number;
}

export class DeviceRegistry implements RecordVerifier {
  readonly #deps: DeviceRegistryDeps;
  readonly #verifier = new DeviceRegistryVerifier("reject");
  /** The same keys the verifier holds, for the lanes it cannot verify itself. */
  readonly #keys = new Map<string, CryptoKey>();
  readonly #cloud = new Set<string>();
  readonly #unknownSeenAt = new Map<string, number>();
  #knownIds = new Set<string>();
  #refreshing: Promise<void> | null = null;

  constructor(deps: DeviceRegistryDeps) {
    this.#deps = deps;
    this.#addKey(deps.local.deviceId, deps.local.publicKey);
  }

  hasDevice(deviceId: string): boolean {
    return this.#verifier.hasDevice(deviceId);
  }

  isCloudDevice(deviceId: string): boolean {
    return this.#cloud.has(deviceId);
  }

  /** Re-read the registry; single-flight. Control being away keeps the current one. */
  refresh(): Promise<void> {
    if (this.#refreshing !== null) return this.#refreshing;
    const run = this.#refreshOnce().finally(() => {
      if (this.#refreshing === run) this.#refreshing = null;
    });
    this.#refreshing = run;
    return run;
  }

  async verify(record: CookieRecordWire): Promise<boolean> {
    await this.#ensureDevice(record.hlc.deviceId);
    return this.#verifier.verify(record);
  }

  /**
   * The workspace lane's counterpart to `verify` (§10.2, D15): a doc whose
   * signature does not check out under an enrolled device's key never reaches
   * the HLC clock, the seal, or SpaceStore — otherwise a hub that keeps the
   * ciphertext could re-serve an old `space:` doc under a fabricated newer
   * HLC and roll a Space's settings back.
   */
  async verifyWorkspace(wire: WorkspaceRecordWire): Promise<boolean> {
    await this.#ensureDevice(wire.hlc.deviceId);
    const publicKey = this.#keys.get(wire.hlc.deviceId);
    if (publicKey === undefined) return false; // unknown or revoked device
    try {
      return await crypto.subtle.verify(
        "Ed25519",
        publicKey,
        fromBase64(wire.deviceSig) as BufferSource,
        workspaceSigningBytes(wire.key, wire.sealedValue, wire.hlc) as BufferSource,
      );
    } catch {
      return false;
    }
  }

  /** One throttled refresh per unknown device id, so a peer enrolled a moment ago still verifies. */
  async #ensureDevice(deviceId: string): Promise<void> {
    if (this.#verifier.hasDevice(deviceId)) return;
    const now = this.#deps.now?.() ?? Date.now();
    const last = this.#unknownSeenAt.get(deviceId);
    if (last !== undefined && now - last < UNKNOWN_RETRY_MS) return;
    this.#unknownSeenAt.set(deviceId, now);
    await this.refresh();
  }

  async #refreshOnce(): Promise<void> {
    let devices: DeviceRegistryRow[];
    try {
      devices = await this.#deps.fetchDevices();
    } catch {
      return;
    }
    const keep = new Set<string>([this.#deps.local.deviceId]);
    const cloud = new Set<string>();
    for (const device of devices) {
      if (device.revokedAt !== null || device.id === this.#deps.local.deviceId) continue;
      try {
        this.#addKey(device.id, await importPublicKeyRaw(fromBase64(device.devicePublicKey)));
      } catch {
        continue; // a malformed key never verifies anything
      }
      keep.add(device.id);
      if (device.platform === "cloud") cloud.add(device.id);
      this.#unknownSeenAt.delete(device.id);
    }
    // Revoked or vanished devices stop verifying at once (§10.2).
    for (const deviceId of this.#known()) {
      if (!keep.has(deviceId)) this.#removeKey(deviceId);
    }
    this.#cloud.clear();
    for (const deviceId of cloud) this.#cloud.add(deviceId);
    this.#knownIds = keep;
  }

  #addKey(deviceId: string, publicKey: CryptoKey): void {
    this.#verifier.addDevice(deviceId, publicKey);
    this.#keys.set(deviceId, publicKey);
  }

  #removeKey(deviceId: string): void {
    this.#verifier.removeDevice(deviceId);
    this.#keys.delete(deviceId);
  }

  #known(): string[] {
    return [...this.#knownIds];
  }
}
