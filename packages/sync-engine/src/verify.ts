/**
 * Device-signature verification for remote records (PRD §8.3 "device-signed
 * mutations", §9 rogue-device threat). Keys come from the control plane's
 * enrolled-device registry; the engine consults the verifier before any
 * remote record touches state.
 */

import {
  fromBase64,
  verifyRecord,
  workspaceSigningBytes,
  type CookieRecordWire,
  type WorkspaceRecordWire,
} from "@pistachio/sync-protocol";
import type { RecordVerifier } from "./types.js";

/**
 * What to do with records signed by a device we have no public key for.
 * "reject" is the correct end state; "accept" exists for the v0 loopback
 * transport where the registry only knows the local device — using it MUST
 * be paired with the documented caveat in docs/security-model.md.
 */
export type UnknownDevicePolicy = "reject" | "accept";

export class DeviceRegistryVerifier implements RecordVerifier {
  private readonly keys = new Map<string, CryptoKey>();

  constructor(private readonly unknownDevicePolicy: UnknownDevicePolicy = "reject") {}

  addDevice(deviceId: string, publicKey: CryptoKey): void {
    this.keys.set(deviceId, publicKey);
  }

  removeDevice(deviceId: string): void {
    this.keys.delete(deviceId);
  }

  hasDevice(deviceId: string): boolean {
    return this.keys.has(deviceId);
  }

  async verify(record: CookieRecordWire): Promise<boolean> {
    const publicKey = this.keys.get(record.hlc.deviceId);
    if (!publicKey) return this.unknownDevicePolicy === "accept";
    const { deviceSig, ...fields } = record;
    try {
      return await verifyRecord(publicKey, fromBase64(deviceSig), fields);
    } catch {
      return false;
    }
  }

  async verifyWorkspace(record: WorkspaceRecordWire): Promise<boolean> {
    const publicKey = this.keys.get(record.hlc.deviceId);
    if (!publicKey) return this.unknownDevicePolicy === "accept";
    try {
      return await crypto.subtle.verify(
        "Ed25519",
        publicKey,
        fromBase64(record.deviceSig) as BufferSource,
        workspaceSigningBytes(record.key, record.sealedValue, record.hlc) as BufferSource,
      );
    } catch {
      return false;
    }
  }
}
