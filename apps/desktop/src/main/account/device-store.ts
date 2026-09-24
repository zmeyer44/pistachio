/**
 * This Mac's identity and every secret the account leaves here
 * (docs/cloud-sync-design.md §10.1, D20, D24): `<userData>/account.json`.
 *
 * One device id — a lowercase uuid v4 minted next to the Ed25519 signing key
 * and the X25519 agreement key, and never changed afterwards. Everything
 * secret in the file (both private keys, the control tokens, the per-Space
 * root secrets, the workspace secret) is sealed with Electron's
 * `safeStorage`, so the file on disk holds the OS keychain's ciphertext and
 * nothing a copy of the profile could use. When safeStorage cannot encrypt on
 * this Mac the store stays locked: nothing secret is written, and sign-in is
 * refused with a clear error rather than keeping keys in the clear.
 *
 * Written whole and atomically (temp + rename, mode 0600) on every change.
 * The cipher is injectable so the tests can stand in for the keychain.
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { safeStorage } from "electron";
import {
  exportPublicKeyRaw,
  fromBase64,
  generateAgreementKeypair,
  generateDeviceKeypair,
  importAgreementPublicKeyRaw,
  importPublicKeyRaw,
  toBase64,
  type KeyWrapperKind,
} from "@pistachio/sync-protocol";

export const ACCOUNT_FILE = "account.json";

/**
 * `anonymous`: nobody signed in, and this Mac is the one device of an
 * anonymous account control made for it (docs/anonymous-accounts.md) — it
 * holds a device token, for the models alone. `signed-up` carries a bootstrap
 * token, or — when it came from an anonymous account, upgraded or linked — the
 * device token this Mac already had, so `enroll` has nothing left to prove.
 */
export type EnrollmentStateKind = "unenrolled" | "anonymous" | "signed-up" | "enrolled";

/** Enrollment against the control plane, persisted across restarts. */
export interface EnrollmentState {
  state: EnrollmentStateKind;
  userId: string | null;
  email: string | null;
  controlUrl: string | null;
  /** The signed device token (`did` = this device): enrolled, or an anonymous account's. */
  token: string | null;
  /** The bootstrap token (`did === sub`) between sign-in/sign-up and enroll. */
  bootstrapToken: string | null;
}

/** The cloud browser's identity as pinned on first enable (D6, §10.1). */
export interface CloudDevicePinRecord {
  deviceId: string;
  /** base64 raw X25519 public key. */
  agreementPublicKey: string;
}

/**
 * A wrapper that could not be uploaded when it was made (offline mid
 * password change): ciphertext only, safe in the clear, retried at start.
 */
export interface PendingWrapper {
  spaceId: string;
  kind: KeyWrapperKind;
  credentialId: string;
  salt: string;
  wrapped: string;
}

/** The keys, imported and ready to use. */
export interface DeviceIdentity {
  deviceId: string;
  signingKey: CryptoKey;
  signingPublicKey: CryptoKey;
  devicePublicKeyRaw: Uint8Array;
  agreementPrivateKey: CryptoKey;
  agreementPublicKey: CryptoKey;
  agreementPublicKeyRaw: Uint8Array;
}

/** What seals the secret fields. Backed by safeStorage outside tests. */
export interface SecretCipher {
  available(): boolean;
  encrypt(plain: string): string;
  decrypt(sealed: string): string;
}

export function safeStorageCipher(): SecretCipher {
  return {
    available: () => {
      try {
        return safeStorage.isEncryptionAvailable();
      } catch {
        return false;
      }
    },
    encrypt: (plain) => safeStorage.encryptString(plain).toString("base64"),
    decrypt: (sealed) => safeStorage.decryptString(Buffer.from(sealed, "base64")),
  };
}

interface AccountFile {
  version: 1;
  deviceId: string;
  name: string;
  /** Sealed JWK JSON. */
  signingKey: string;
  /** Sealed JWK JSON. */
  agreementKey: string;
  /** base64 raw Ed25519 public key (public, in the clear). */
  devicePublicKey: string;
  /** base64 raw X25519 public key (public, in the clear). */
  agreementPublicKey: string;
  enrollment: {
    state: EnrollmentStateKind;
    userId: string | null;
    email: string | null;
    controlUrl: string | null;
    /** Sealed. */
    token: string | null;
    /** Sealed. */
    bootstrapToken: string | null;
  };
  /** spaceId → sealed base64 root secret. */
  spaceSecrets: Record<string, string>;
  /** Sealed base64 workspace secret. */
  workspaceSecret: string | null;
  cloudDevicePin: CloudDevicePinRecord | null;
  pendingWrappers: PendingWrapper[];
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UNENROLLED: AccountFile["enrollment"] = {
  state: "unenrolled",
  userId: null,
  email: null,
  controlUrl: null,
  token: null,
  bootstrapToken: null,
};

export interface DeviceStoreOptions {
  cipher?: SecretCipher;
  /** The name a fresh identity is given (this Mac's computer name). */
  deviceName?: string;
}

export class DeviceStore {
  readonly #path: string;
  readonly #cipher: SecretCipher;
  #file: AccountFile;
  #identity: DeviceIdentity | null;
  /** True once the file has been written (or read) with the cipher available. */
  readonly #available: boolean;

  private constructor(
    path: string,
    cipher: SecretCipher,
    file: AccountFile,
    identity: DeviceIdentity | null,
    available: boolean,
  ) {
    this.#path = path;
    this.#cipher = cipher;
    this.#file = file;
    this.#identity = identity;
    this.#available = available;
  }

  static async load(userDataDir: string, options: DeviceStoreOptions = {}): Promise<DeviceStore> {
    const cipher = options.cipher ?? safeStorageCipher();
    const path = join(userDataDir, ACCOUNT_FILE);
    const available = cipher.available();
    const existing = readAccountFile(path);
    if (existing !== null) {
      let identity: DeviceIdentity | null = null;
      if (available) {
        try {
          identity = await importIdentity(existing, cipher);
        } catch (error) {
          // A keychain that changed underneath the file: the identity is
          // unrecoverable, so it is minted again below, keys and id together.
          console.error("[account] stored keys could not be opened; minting a new identity", error);
        }
      }
      if (identity !== null || !available) {
        return new DeviceStore(path, cipher, existing, identity, available);
      }
    }
    const { file, identity } = await mintIdentity(cipher, available, options.deviceName ?? "This Mac");
    const store = new DeviceStore(path, cipher, file, identity, available);
    if (available) store.#persist();
    return store;
  }

  get path(): string {
    return this.#path;
  }

  /** The one device id (D24). */
  get deviceId(): string {
    return this.#file.deviceId;
  }

  get deviceName(): string {
    return this.#file.name;
  }

  setDeviceName(name: string): void {
    const trimmed = name.trim().slice(0, 80);
    if (trimmed === "" || trimmed === this.#file.name) return;
    this.#file.name = trimmed;
    this.#persist();
  }

  /** False when safeStorage cannot seal on this Mac: nothing secret is kept (D20). */
  get encryptionAvailable(): boolean {
    return this.#available;
  }

  /** The keys; throws while the store is locked. */
  identity(): DeviceIdentity {
    if (this.#identity === null) {
      throw new Error(
        "Pistachio can't protect account keys on this Mac: the system keychain is unavailable.",
      );
    }
    return this.#identity;
  }

  /** base64 raw Ed25519 public key. */
  devicePublicKey(): string {
    return this.#file.devicePublicKey;
  }

  /** base64 raw X25519 public key. */
  agreementPublicKey(): string {
    return this.#file.agreementPublicKey;
  }

  enrollment(): EnrollmentState {
    const e = this.#file.enrollment;
    return {
      state: e.state,
      userId: e.userId,
      email: e.email,
      controlUrl: e.controlUrl,
      token: this.#open(e.token),
      bootstrapToken: this.#open(e.bootstrapToken),
    };
  }

  setEnrollment(patch: Partial<EnrollmentState>): EnrollmentState {
    const current = this.#file.enrollment;
    this.#file.enrollment = {
      state: patch.state ?? current.state,
      userId: patch.userId === undefined ? current.userId : patch.userId,
      email: patch.email === undefined ? current.email : patch.email,
      controlUrl: patch.controlUrl === undefined ? current.controlUrl : patch.controlUrl,
      token: patch.token === undefined ? current.token : this.#seal(patch.token),
      bootstrapToken:
        patch.bootstrapToken === undefined
          ? current.bootstrapToken
          : this.#seal(patch.bootstrapToken),
    };
    this.#persist();
    return this.enrollment();
  }

  /** The Space's root secret, or null when this device does not hold it. */
  spaceSecret(spaceId: string): Uint8Array | null {
    const sealed = this.#file.spaceSecrets[spaceId];
    if (sealed === undefined) return null;
    const opened = this.#open(sealed);
    return opened === null ? null : fromBase64(opened);
  }

  setSpaceSecret(spaceId: string, secret: Uint8Array): void {
    const sealed = this.#seal(toBase64(secret));
    if (sealed === null) return;
    this.#file.spaceSecrets[spaceId] = sealed;
    this.#persist();
  }

  deleteSpaceSecret(spaceId: string): void {
    if (!(spaceId in this.#file.spaceSecrets)) return;
    delete this.#file.spaceSecrets[spaceId];
    this.#persist();
  }

  /** Every Space this device holds a secret for. */
  spaceSecretIds(): string[] {
    return Object.keys(this.#file.spaceSecrets);
  }

  workspaceSecret(): Uint8Array | null {
    const opened = this.#open(this.#file.workspaceSecret);
    return opened === null ? null : fromBase64(opened);
  }

  setWorkspaceSecret(secret: Uint8Array): void {
    const sealed = this.#seal(toBase64(secret));
    if (sealed === null) return;
    this.#file.workspaceSecret = sealed;
    this.#persist();
  }

  cloudDevicePin(): CloudDevicePinRecord | null {
    const pin = this.#file.cloudDevicePin;
    return pin === null ? null : { ...pin };
  }

  setCloudDevicePin(pin: CloudDevicePinRecord | null): void {
    this.#file.cloudDevicePin = pin === null ? null : { ...pin };
    this.#persist();
  }

  pendingWrappers(): PendingWrapper[] {
    return structuredClone(this.#file.pendingWrappers);
  }

  setPendingWrappers(wrappers: PendingWrapper[]): void {
    this.#file.pendingWrappers = structuredClone(wrappers);
    this.#persist();
  }

  /**
   * Sign-out: forget the account and every secret it left here, keeping the
   * device id and keys so the same device can enroll again (§10.1).
   */
  clearAccount(): void {
    this.#file.enrollment = { ...UNENROLLED };
    this.#file.spaceSecrets = {};
    this.#file.workspaceSecret = null;
    this.#file.cloudDevicePin = null;
    this.#file.pendingWrappers = [];
    this.#persist();
  }

  /**
   * Control already knows this id or key under another account (409 on
   * enroll): mint a new identity. The one time the device id changes — it is
   * not enrolled anywhere yet, so nothing refers to the old one.
   */
  async regenerateIdentity(): Promise<void> {
    const minted = await mintIdentity(this.#cipher, this.#available, this.#file.name);
    this.#file = {
      ...minted.file,
      enrollment: this.#file.enrollment,
      spaceSecrets: this.#file.spaceSecrets,
      workspaceSecret: this.#file.workspaceSecret,
      cloudDevicePin: this.#file.cloudDevicePin,
      pendingWrappers: this.#file.pendingWrappers,
    };
    this.#identity = minted.identity;
    this.#persist();
  }

  #seal(plain: string | null): string | null {
    if (plain === null) return null;
    if (!this.#available) return null;
    return this.#cipher.encrypt(plain);
  }

  #open(sealed: string | null): string | null {
    if (sealed === null || !this.#available) return null;
    try {
      return this.#cipher.decrypt(sealed);
    } catch {
      return null;
    }
  }

  #persist(): void {
    // Locked: the secret fields could not be sealed, so nothing is written.
    if (!this.#available) return;
    try {
      mkdirSync(join(this.#path, ".."), { recursive: true });
      const tmp = `${this.#path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.#file, null, 2), { mode: 0o600 });
      renameSync(tmp, this.#path);
      chmodSync(this.#path, 0o600);
    } catch (error) {
      console.error("[account] could not write account.json", error);
    }
  }
}

function readAccountFile(path: string): AccountFile | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (raw["version"] !== 1) return null;
    const deviceId = typeof raw["deviceId"] === "string" && UUID_V4.test(raw["deviceId"]) ? raw["deviceId"] : null;
    if (deviceId === null) return null;
    if (typeof raw["signingKey"] !== "string" || typeof raw["agreementKey"] !== "string") return null;
    if (typeof raw["devicePublicKey"] !== "string" || typeof raw["agreementPublicKey"] !== "string") return null;
    const enrollment = typeof raw["enrollment"] === "object" && raw["enrollment"] !== null
      ? (raw["enrollment"] as Record<string, unknown>)
      : {};
    const state = enrollment["state"];
    const secrets: Record<string, string> = {};
    if (typeof raw["spaceSecrets"] === "object" && raw["spaceSecrets"] !== null) {
      for (const [id, sealed] of Object.entries(raw["spaceSecrets"] as Record<string, unknown>)) {
        if (typeof sealed === "string") secrets[id] = sealed;
      }
    }
    const pin = raw["cloudDevicePin"];
    const cloudDevicePin =
      typeof pin === "object" &&
      pin !== null &&
      typeof (pin as Record<string, unknown>)["deviceId"] === "string" &&
      typeof (pin as Record<string, unknown>)["agreementPublicKey"] === "string"
        ? {
            deviceId: (pin as Record<string, string>)["deviceId"]!,
            agreementPublicKey: (pin as Record<string, string>)["agreementPublicKey"]!,
          }
        : null;
    const pendingWrappers = Array.isArray(raw["pendingWrappers"])
      ? raw["pendingWrappers"].filter(isPendingWrapper)
      : [];
    const nullableString = (value: unknown): string | null => (typeof value === "string" ? value : null);
    return {
      version: 1,
      deviceId,
      name: typeof raw["name"] === "string" && raw["name"].trim() !== "" ? raw["name"] : "This Mac",
      signingKey: raw["signingKey"],
      agreementKey: raw["agreementKey"],
      devicePublicKey: raw["devicePublicKey"],
      agreementPublicKey: raw["agreementPublicKey"],
      enrollment: {
        state: state === "anonymous" || state === "signed-up" || state === "enrolled" ? state : "unenrolled",
        userId: nullableString(enrollment["userId"]),
        email: nullableString(enrollment["email"]),
        controlUrl: nullableString(enrollment["controlUrl"]),
        token: nullableString(enrollment["token"]),
        bootstrapToken: nullableString(enrollment["bootstrapToken"]),
      },
      spaceSecrets: secrets,
      workspaceSecret: nullableString(raw["workspaceSecret"]),
      cloudDevicePin,
      pendingWrappers,
    };
  } catch {
    return null;
  }
}

function isPendingWrapper(value: unknown): value is PendingWrapper {
  if (typeof value !== "object" || value === null) return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw["spaceId"] === "string" &&
    typeof raw["kind"] === "string" &&
    typeof raw["credentialId"] === "string" &&
    typeof raw["salt"] === "string" &&
    typeof raw["wrapped"] === "string"
  );
}

async function importIdentity(file: AccountFile, cipher: SecretCipher): Promise<DeviceIdentity> {
  const signingJwk = JSON.parse(cipher.decrypt(file.signingKey)) as JsonWebKey;
  const agreementJwk = JSON.parse(cipher.decrypt(file.agreementKey)) as JsonWebKey;
  const signingKey = await crypto.subtle.importKey("jwk", signingJwk, "Ed25519", true, ["sign"]);
  // Extractable: unwrapRootSecretFromDevice recovers the public half from the
  // private JWK when the raw public key is not passed alongside (§14).
  const agreementPrivateKey = await crypto.subtle.importKey("jwk", agreementJwk, "X25519", true, [
    "deriveBits",
  ]);
  const devicePublicKeyRaw = fromBase64(file.devicePublicKey);
  const agreementPublicKeyRaw = fromBase64(file.agreementPublicKey);
  return {
    deviceId: file.deviceId,
    signingKey,
    signingPublicKey: await importPublicKeyRaw(devicePublicKeyRaw),
    devicePublicKeyRaw,
    agreementPrivateKey,
    agreementPublicKey: await importAgreementPublicKeyRaw(agreementPublicKeyRaw),
    agreementPublicKeyRaw,
  };
}

async function mintIdentity(
  cipher: SecretCipher,
  available: boolean,
  name: string,
): Promise<{ file: AccountFile; identity: DeviceIdentity }> {
  const signing = await generateDeviceKeypair();
  const agreement = await generateAgreementKeypair();
  const devicePublicKeyRaw = await exportPublicKeyRaw(signing.publicKey);
  const agreementPublicKeyRaw = await exportPublicKeyRaw(agreement.publicKey);
  const signingJwk = JSON.stringify(await crypto.subtle.exportKey("jwk", signing.privateKey));
  const agreementJwk = JSON.stringify(await crypto.subtle.exportKey("jwk", agreement.privateKey));
  const deviceId = randomUUID();
  const file: AccountFile = {
    version: 1,
    deviceId,
    name,
    // Locked stores never persist, so the unsealed placeholder never lands on disk.
    signingKey: available ? cipher.encrypt(signingJwk) : "",
    agreementKey: available ? cipher.encrypt(agreementJwk) : "",
    devicePublicKey: toBase64(devicePublicKeyRaw),
    agreementPublicKey: toBase64(agreementPublicKeyRaw),
    enrollment: { ...UNENROLLED },
    spaceSecrets: {},
    workspaceSecret: null,
    cloudDevicePin: null,
    pendingWrappers: [],
  };
  return {
    file,
    identity: {
      deviceId,
      signingKey: signing.privateKey,
      signingPublicKey: signing.publicKey,
      devicePublicKeyRaw,
      agreementPrivateKey: agreement.privateKey,
      agreementPublicKey: agreement.publicKey,
      agreementPublicKeyRaw,
    },
  };
}
