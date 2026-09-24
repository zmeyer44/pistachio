/**
 * This browser's device identity.
 *
 * The web app enrols as a device of its own, exactly as a Mac does: it mints an
 * Ed25519 signing key and an X25519 agreement key, proves possession of the
 * signing key against a server challenge, and from then on authenticates with a
 * device token. The private keys are generated NON-EXTRACTABLE and stored as
 * `CryptoKey` handles in IndexedDB, so script on this origin can sign with them
 * but cannot read them out or copy them anywhere.
 *
 * A browser is a weaker vault than the Mac's keychain, which is why revoking a
 * web device is one click in Devices, and why the account's Space keys are only
 * kept here when the reader has explicitly asked to stay unlocked (see
 * `vault.ts`).
 */

import {
  deviceLoginSigningBytes,
  exportPublicKeyRaw,
  toBase64,
} from "@pistachio/sync-protocol";
import { DEVICE_STORE, withStore } from "./idb";

const RECORD_KEY = "identity";

export interface DeviceIdentity {
  deviceId: string;
  userId: string;
  signingKey: CryptoKey;
  signingPublicKey: CryptoKey;
  agreementKey: CryptoKey;
  agreementPublicKey: CryptoKey;
}

interface StoredIdentity {
  deviceId: string;
  userId: string;
  signingKey: CryptoKey;
  signingPublicKey: CryptoKey;
  agreementKey: CryptoKey;
  agreementPublicKey: CryptoKey;
}

/** The identity this browser already holds, or null on a machine that has never signed in. */
export async function loadIdentity(): Promise<DeviceIdentity | null> {
  try {
    const stored = await withStore<StoredIdentity | undefined>(DEVICE_STORE, "readonly", (store) => store.get(RECORD_KEY));
    return stored ?? null;
  } catch {
    return null; // private windows and blocked storage: sign in fresh.
  }
}

export async function forgetIdentity(): Promise<void> {
  try {
    await withStore(DEVICE_STORE, "readwrite", (store) => store.delete(RECORD_KEY));
  } catch {
    // Nothing to forget.
  }
}

/**
 * Mint a fresh identity. The private halves are non-extractable: they can sign
 * and derive, and nothing — including this code — can read their bytes.
 */
export async function createIdentity(userId: string): Promise<DeviceIdentity> {
  const signing = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
  const agreement = (await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
  return {
    deviceId: crypto.randomUUID(),
    userId,
    signingKey: signing.privateKey,
    signingPublicKey: signing.publicKey,
    agreementKey: agreement.privateKey,
    agreementPublicKey: agreement.publicKey,
  };
}

export async function saveIdentity(identity: DeviceIdentity): Promise<void> {
  await withStore(DEVICE_STORE, "readwrite", (store) => store.put(identity, RECORD_KEY));
}

/** Sign a server challenge, proving this browser holds the enrolled key. */
export async function signChallenge(identity: DeviceIdentity, challenge: string): Promise<string> {
  const bytes = deviceLoginSigningBytes(identity.deviceId, challenge);
  const signature = await crypto.subtle.sign("Ed25519", identity.signingKey, bytes as BufferSource);
  return toBase64(new Uint8Array(signature));
}

export const publicKeys = async (identity: DeviceIdentity): Promise<{ devicePublicKey: string; agreementPublicKey: string }> => ({
  devicePublicKey: toBase64(await exportPublicKeyRaw(identity.signingPublicKey)),
  agreementPublicKey: toBase64(await exportPublicKeyRaw(identity.agreementPublicKey)),
});

/**
 * Which site this device is: the dashboard (`Web`) or the browser app
 * (`Browser`). Each is enrolled separately because device keys live in the
 * origin's IndexedDB, and the Devices page has to be able to tell them apart
 * (docs/web-browser-design.md §15).
 */
export type WebDeviceName = "Browser" | "Web";

/**
 * A name the Devices list can show without the person having to type one:
 * which of the two sites this is, and then the browser it is running in.
 */
export function deviceLabel(kind: WebDeviceName): string {
  return `${kind} \u2014 ${browserName()}`;
}

/** The browser and platform, as the user agent describes them. */
export function browserName(): string {
  const agent = navigator.userAgent;
  const browser = /Firefox\//.test(agent)
    ? "Firefox"
    : /Edg\//.test(agent)
      ? "Edge"
      : /Chrome\//.test(agent)
        ? "Chrome"
        : /Safari\//.test(agent)
          ? "Safari"
          : "Browser";
  const platform = /Mac/.test(agent) ? "Mac" : /Windows/.test(agent) ? "Windows" : /Linux/.test(agent) ? "Linux" : "";
  return platform === "" ? browser : `${browser} on ${platform}`;
}
