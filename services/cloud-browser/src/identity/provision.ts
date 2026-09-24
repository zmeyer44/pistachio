/**
 * Device identity for one cloud device per user (docs/cloud-sync-design.md
 * §8.2): push-driven provisioning, proof-of-possession tokens refreshed at
 * `exp − 60 s`, Space root secrets recovered from sender-signed
 * `device-x25519` wrappers, the enrolled-device verifier, and revocation
 * teardown. Everything secret lives in memory only; `device.json` on disk
 * is the one persisted artefact.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import {
  deriveSpaceKeys,
  deviceLoginSigningBytes,
  fromBase64,
  importPublicKeyRaw,
  toBase64,
  unwrapRootSecretFromDevice,
  type KeyWrapper,
  type SpaceKeys,
} from "@pistachio/sync-protocol";
import { DeviceRegistryVerifier } from "@pistachio/sync-engine";
import { ControlError, isDeviceRejection, type ControlClient, type ControlDevice, type TokenResponse } from "../control-client.js";
import { errorMessage, silentLogger, type Logger } from "../logger.js";
import {
  generateStoredDevice,
  importDeviceIdentity,
  type DeviceIdentity,
  type DeviceStore,
} from "./device-store.js";

/** Refresh the device token this long before it expires. */
export const TOKEN_REFRESH_LEAD_SECONDS = 60;
/** How long the `GET /devices` registry is trusted before it is re-read. */
export const DEVICES_CACHE_MS = 60_000;

export class DeviceUnavailableError extends Error {
  constructor(readonly reason: "cloud_device_missing") {
    super(reason);
    this.name = "DeviceUnavailableError";
  }
}

export type WrapperRejection = "no_wrapper" | "sender_unknown" | "sender_invalid" | "unwrap_failed";

export class WrapperRejectedError extends Error {
  constructor(
    readonly spaceId: string,
    readonly credentialId: string,
    readonly senderDeviceId: string | null,
    readonly reason: WrapperRejection,
  ) {
    super(`wrapper rejected for space ${spaceId}: ${reason}`);
    this.name = "WrapperRejectedError";
  }
}

export type ProvisionResult =
  | { status: 200 | 201; device: ControlDevice }
  | { status: 409; error: "cloud_device_exists" };

export interface DeviceIdentityServiceOptions {
  control: ControlClient;
  store: DeviceStore;
  now?: () => number;
  log?: Logger;
  devicesCacheMs?: number;
}

export type DeviceRevokedListener = (userId: string, identity: DeviceIdentity) => Promise<void> | void;

interface UserState {
  identity: DeviceIdentity;
  token: TokenResponse | null;
  tokenInFlight: Promise<string> | null;
  devices: { at: number; list: ControlDevice[] } | null;
  verifier: DeviceRegistryVerifier | null;
  spaceKeys: Map<string, SpaceKeys>;
  rootSecrets: Map<string, Uint8Array>;
}

export class DeviceIdentityService {
  readonly #control: ControlClient;
  readonly #store: DeviceStore;
  readonly #now: () => number;
  readonly #log: Logger;
  readonly #devicesCacheMs: number;
  readonly #users = new Map<string, UserState>();
  readonly #chains = new Map<string, Promise<unknown>>();
  /** User ids whose chain the CURRENT async context already holds. */
  readonly #held = new AsyncLocalStorage<ReadonlySet<string>>();
  readonly #listeners: DeviceRevokedListener[] = [];
  /** Identities torn down in this process; never reused (§8.2). */
  readonly #retired = new Set<string>();

  constructor(options: DeviceIdentityServiceOptions) {
    this.#control = options.control;
    this.#store = options.store;
    this.#now = options.now ?? ((): number => Date.now());
    this.#log = options.log ?? silentLogger;
    this.#devicesCacheMs = options.devicesCacheMs ?? DEVICES_CACHE_MS;
  }

  /** Register teardown work for `onDeviceRevoked`; listeners run in registration order. */
  onDeviceRevoked(listener: DeviceRevokedListener): () => void {
    this.#listeners.push(listener);
    return () => {
      const index = this.#listeners.indexOf(listener);
      if (index !== -1) this.#listeners.splice(index, 1);
    };
  }

  /**
   * `POST /v1/devices/provision`: return the stored device when it still
   * authenticates, otherwise mint a fresh identity and enroll it.
   */
  provision(userId: string, nonce: string): Promise<ProvisionResult> {
    return this.#serialize(userId, async () => {
      const existing = await this.#loadLocked(userId);
      if (existing !== null) {
        try {
          const token = await this.#ensureToken(userId, existing);
          const row = (await this.#control.listDevices(token)).find((device) => device.id === existing.identity.deviceId);
          if (row !== undefined && row.revokedAt === null) return { status: 200, device: row };
          // Control no longer knows this device: it was revoked behind our back.
          await this.#teardownLocked(userId, existing);
        } catch (error) {
          if (error instanceof DeviceUnavailableError) {
            // #ensureToken already tore the identity down.
          } else {
            throw error;
          }
        }
      }
      const stored = await generateStoredDevice(userId);
      const identity = await importDeviceIdentity(stored);
      const challenge = await this.#control.deviceChallenge(identity.deviceId);
      const signature = await signChallenge(identity, challenge);
      let device: ControlDevice;
      try {
        device = await this.#control.enrollCloudDevice({
          userId,
          nonce,
          deviceId: identity.deviceId,
          devicePublicKey: identity.devicePublicKey,
          agreementPublicKey: identity.agreementPublicKey,
          challenge,
          signature,
        });
      } catch (error) {
        if (error instanceof ControlError && error.status === 409 && error.code === "cloud_device_exists") {
          return { status: 409, error: "cloud_device_exists" };
        }
        throw error;
      }
      await this.#store.save(userId, stored);
      this.#users.set(userId, freshState(identity));
      this.#log.info("cloud device enrolled", { userId, deviceId: identity.deviceId });
      return { status: 201, device };
    });
  }

  /** The stored identity for a user, or null when none is enrolled. */
  identityFor(userId: string): Promise<DeviceIdentity | null> {
    return this.#serialize(userId, async () => (await this.#loadLocked(userId))?.identity ?? null);
  }

  /** True when `deviceId` is the identity this process holds for `userId`. */
  async matchesStoredIdentity(userId: string, deviceId: string): Promise<boolean> {
    const identity = await this.identityFor(userId);
    return identity !== null && identity.deviceId === deviceId;
  }

  /** A valid device token, refreshed at `exp − 60 s`; throws `DeviceUnavailableError` when the device is gone. */
  async tokenFor(userId: string): Promise<string> {
    const state = await this.#serialize(userId, () => this.#loadLocked(userId));
    if (state === null) throw new DeviceUnavailableError("cloud_device_missing");
    return this.#ensureToken(userId, state);
  }

  /** `GET /devices` for the user's cloud device, cached for `devicesCacheMs`. */
  async listDevices(userId: string, options: { fresh?: boolean } = {}): Promise<ControlDevice[]> {
    const state = await this.#requireState(userId);
    if (options.fresh !== true && state.devices !== null && this.#now() - state.devices.at < this.#devicesCacheMs) {
      return state.devices.list;
    }
    const token = await this.#ensureToken(userId, state);
    const list = await this.#deviceCall(userId, () => this.#control.listDevices(token));
    state.devices = { at: this.#now(), list };
    return list;
  }

  /**
   * The Space keys for `(userId, spaceId)`, unwrapped once from the
   * `device-x25519` wrapper addressed to this device and held in memory.
   * Throws `WrapperRejectedError` (logged as `wrapper_rejected`) when no
   * acceptable wrapper exists.
   */
  async spaceKeysFor(userId: string, spaceId: string): Promise<SpaceKeys> {
    const state = await this.#requireState(userId);
    const cached = state.spaceKeys.get(spaceId);
    if (cached !== undefined) return cached;
    const deviceId = state.identity.deviceId;
    const token = await this.#ensureToken(userId, state);
    const wrappers = await this.#deviceCall(userId, () => this.#control.listWrappers(token, spaceId));
    const row = wrappers.find((wrapper) => wrapper.kind === "device-x25519" && wrapper.credentialId === deviceId);
    const reject = (senderDeviceId: string | null, reason: WrapperRejection): never => {
      this.#log.warn("wrapper_rejected", { spaceId, credentialId: deviceId, senderDeviceId, reason });
      throw new WrapperRejectedError(spaceId, deviceId, senderDeviceId, reason);
    };
    if (row === undefined) return reject(null, "no_wrapper");
    const senderDeviceId = row.senderDeviceId;
    if (senderDeviceId === null || row.signature === null) return reject(senderDeviceId, "sender_invalid");
    let sender = (await this.listDevices(userId)).find((device) => device.id === senderDeviceId);
    if (sender === undefined) {
      sender = (await this.listDevices(userId, { fresh: true })).find((device) => device.id === senderDeviceId);
    }
    if (sender === undefined) return reject(senderDeviceId, "sender_unknown");
    if ((sender.platform !== "macos" && sender.platform !== "web") || sender.revokedAt !== null) {
      return reject(senderDeviceId, "sender_invalid");
    }
    const wrapper: KeyWrapper = {
      kind: "device-x25519",
      spaceId: row.spaceId,
      credentialId: row.credentialId,
      salt: row.salt,
      wrapped: row.wrapped,
      createdAtMs: Date.parse(row.createdAt) || 0,
      senderDeviceId,
      signature: row.signature,
    };
    let secret: Uint8Array;
    try {
      const senderKey = await importPublicKeyRaw(fromBase64(sender.devicePublicKey));
      secret = await unwrapRootSecretFromDevice(
        wrapper,
        spaceId,
        {
          deviceId,
          agreementPrivateKey: state.identity.agreementPrivateKey,
          agreementPublicKeyRaw: state.identity.agreementPublicKeyRaw,
        },
        senderKey,
      );
    } catch {
      return reject(senderDeviceId, "unwrap_failed");
    }
    const keys = await deriveSpaceKeys(spaceId, secret);
    state.rootSecrets.set(spaceId, secret);
    state.spaceKeys.set(spaceId, keys);
    return keys;
  }

  /**
   * `DeviceRegistryVerifier('reject')` over the user's non-revoked devices.
   * `refresh: true` re-reads the registry (the first unknown-device rejection).
   */
  async verifierFor(userId: string, options: { refresh?: boolean } = {}): Promise<DeviceRegistryVerifier> {
    const state = await this.#requireState(userId);
    if (options.refresh !== true && state.verifier !== null) return state.verifier;
    const devices = await this.listDevices(userId, { fresh: options.refresh === true });
    const verifier = new DeviceRegistryVerifier("reject");
    for (const device of devices) {
      if (device.revokedAt !== null) continue;
      try {
        verifier.addDevice(device.id, await importPublicKeyRaw(fromBase64(device.devicePublicKey)));
      } catch (error) {
        this.#log.warn("device key unreadable", { deviceId: device.id, error: errorMessage(error) });
      }
    }
    state.verifier = verifier;
    return verifier;
  }

  /**
   * `onDeviceRevoked(userId)`: run every teardown listener, zeroize the
   * unwrapped secrets, drop the tokens, delete `device.json`. Idempotent.
   */
  revoke(userId: string): Promise<void> {
    return this.#serialize(userId, async () => {
      const state = await this.#loadLocked(userId);
      if (state === null) {
        await this.#store.delete(userId);
        return;
      }
      await this.#teardownLocked(userId, state);
    });
  }

  /* ------------------------------ internals ------------------------------ */

  async #requireState(userId: string): Promise<UserState> {
    const state = await this.#serialize(userId, () => this.#loadLocked(userId));
    if (state === null) throw new DeviceUnavailableError("cloud_device_missing");
    return state;
  }

  async #loadLocked(userId: string): Promise<UserState | null> {
    const cached = this.#users.get(userId);
    if (cached !== undefined) return cached;
    const stored = await this.#store.load(userId);
    if (stored === null) return null;
    if (this.#retired.has(stored.deviceId)) {
      // A file that survived a teardown is never revived.
      await this.#store.delete(userId);
      return null;
    }
    const state = freshState(await importDeviceIdentity(stored));
    this.#users.set(userId, state);
    return state;
  }

  async #teardownLocked(userId: string, state: UserState): Promise<void> {
    const identity = state.identity;
    this.#log.warn("cloud device revoked; tearing down", { userId, deviceId: identity.deviceId });
    for (const listener of [...this.#listeners]) {
      try {
        await listener(userId, identity);
      } catch (error) {
        this.#log.error("revocation listener failed", { userId, error: errorMessage(error) });
      }
    }
    for (const secret of state.rootSecrets.values()) secret.fill(0);
    state.rootSecrets.clear();
    state.spaceKeys.clear();
    state.verifier = null;
    state.devices = null;
    state.token = null;
    this.#retired.add(identity.deviceId);
    this.#users.delete(userId);
    await this.#store.delete(userId);
  }

  /** Current token, refreshed (single-flight) when within the lead window. */
  #ensureToken(userId: string, state: UserState): Promise<string> {
    const token = state.token;
    if (token !== null && this.#now() / 1000 < token.exp - TOKEN_REFRESH_LEAD_SECONDS) {
      return Promise.resolve(token.token);
    }
    if (state.tokenInFlight !== null) return state.tokenInFlight;
    const attempt = this.#mintToken(userId, state).finally(() => {
      if (state.tokenInFlight === attempt) state.tokenInFlight = null;
    });
    state.tokenInFlight = attempt;
    return attempt;
  }

  async #mintToken(userId: string, state: UserState): Promise<string> {
    const current = state.token;
    if (current !== null) {
      try {
        const refreshed = await this.#control.refreshToken(current.token);
        state.token = refreshed;
        return refreshed.token;
      } catch (error) {
        if (!isDeviceRejection(error, [403])) {
          throw error;
        }
        // The token lapsed or was rejected: prove possession of the key instead.
      }
    }
    try {
      const identity = state.identity;
      const challenge = await this.#control.deviceChallenge(identity.deviceId);
      const signature = await signChallenge(identity, challenge);
      const minted = await this.#control.deviceLogin(identity.deviceId, challenge, signature);
      state.token = minted;
      return minted.token;
    } catch (error) {
      if (isDeviceRejection(error, [403, 404])) {
        await this.revoke(userId);
        throw new DeviceUnavailableError("cloud_device_missing");
      }
      throw error;
    }
  }

  /** A device-bearer call: a 401/410 answer means the device is gone (§8.2). */
  async #deviceCall<T>(userId: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (isDeviceRejection(error)) {
        await this.revoke(userId);
        throw new DeviceUnavailableError("cloud_device_missing");
      }
      throw error;
    }
  }

  /**
   * Serialize per user, reentrantly. An operation that already holds this
   * user's chain may call another one — `#ensureToken` discovering the device
   * is gone and calling `revoke`, say — and must run it inline: queueing would
   * make it wait on the very operation calling it. Reentrancy is scoped to the
   * async context that holds the chain (`AsyncLocalStorage`), so an unrelated
   * concurrent caller still queues and mutual exclusion holds.
   */
  #serialize<T>(userId: string, operation: () => Promise<T>): Promise<T> {
    const held = this.#held.getStore();
    if (held?.has(userId) === true) return operation();
    const run = (): Promise<T> => {
      const nested = new Set(held ?? []);
      nested.add(userId);
      return this.#held.run(nested, operation);
    };
    const previous = this.#chains.get(userId) ?? Promise.resolve();
    const next = previous.then(run, run);
    this.#chains.set(
      userId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }
}

function freshState(identity: DeviceIdentity): UserState {
  return {
    identity,
    token: null,
    tokenInFlight: null,
    devices: null,
    verifier: null,
    spaceKeys: new Map(),
    rootSecrets: new Map(),
  };
}

async function signChallenge(identity: DeviceIdentity, challenge: string): Promise<string> {
  const bytes = deviceLoginSigningBytes(identity.deviceId, challenge);
  const signature = await crypto.subtle.sign("Ed25519", identity.signingPrivateKey, bytes as BufferSource);
  return toBase64(new Uint8Array(signature));
}
