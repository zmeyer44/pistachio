/**
 * AuthService — the `account:*`, `devices:*`, and the key half of `cloud:*`
 * IPC surface (docs/cloud-sync-design.md §10.1).
 *
 * Sign-up creates the account and leaves this Mac "signed-up" with a
 * bootstrap token; sign-in does the same for an existing account and, with
 * nothing but the password, unwraps the account's `password` key wrappers so
 * the Space and workspace root secrets are here before anything derives keys.
 * `enroll()` then registers this device's keys under its one id (D24), mints
 * the device token, and — on the account's first enrollment — generates a
 * root secret for every local Space and `__workspace__` and seals each under
 * the password and under a recovery code that is shown exactly once.
 *
 * The cloud browser gets a Space's secret only through `enableCloud`: the
 * root secret is wrapped to the cloud device's X25519 key with a wrapper this
 * device signs, and the cloud device's identity is pinned on first use so a
 * later substitution by control is refused until a person confirms it (D6).
 *
 * A Mac nobody has signed in on is not accountless (docs/anonymous-
 * accounts.md): `ensureAnonymous` has control make an anonymous account with
 * this Mac as its one device, so the models work — metered and bounded — from
 * the first launch. That account holds no keys and syncs nothing. Signing UP
 * upgrades it in place (same user, same device token); signing IN to an
 * existing account folds it into that one, device included. Either way
 * `enroll` finds the device token already here and only has keys left to do.
 *
 * Nothing here touches the network under PISTACHIO_E2E: index.ts never
 * constructs the service there (D22).
 */

import { createHash } from "node:crypto";
import {
  deriveKekFromPassphrase,
  deriveKekFromRecoveryCode,
  deviceLoginSigningBytes,
  fromBase64,
  generateRecoveryCode,
  generateSpaceRootSecret,
  RECOVERY_CODE_PBKDF2_ITERATIONS,
  toBase64,
  unwrapRootSecret,
  WORKSPACE_PSEUDO_SPACE_ID,
  wrapRootSecret,
  wrapRootSecretToDevice,
  type KeyWrapperKind,
} from "@pistachio/sync-protocol";
import type { AccountEnrollResult, AccountState, CloudDevicePin, DeviceInfo } from "@pistachio/shell-contracts/ipc";
import type { SpaceStore } from "../space-store";
import {
  ControlClient,
  ControlError,
  type ControlDevice,
  type ControlWrapperInput,
} from "./control-client";
import { isBootstrapToken } from "./auth-token";
import type { CloudDevicePinRecord, DeviceStore, PendingWrapper } from "./device-store";

const KEK_SALT_BYTES = 16;
const PASSWORD_CREDENTIAL_ID = "password";
const RECOVERY_CREDENTIAL_ID = "recovery";
const DEVICE_WRAPPER_KIND: KeyWrapperKind = "device-x25519";
const X25519_KEY_BYTES = 32;

export class CloudDeviceInvalid extends Error {
  constructor(detail: string) {
    super(`control introduced an invalid cloud device: ${detail}`);
    this.name = "CloudDeviceInvalid";
  }
}

/** The cloud device control answered with differs from the pinned one; nothing was wrapped. */
export class CloudDeviceChanged extends Error {
  readonly code = "cloud-device-changed" as const;

  constructor() {
    super(
      "The cloud browser's identity changed since this Mac pinned it. Confirm the new device under Settings → Devices before enabling the cloud for a Space.",
    );
    this.name = "CloudDeviceChanged";
  }
}

export interface AuthServiceDeps {
  store: DeviceStore;
  spaces: SpaceStore;
  controlUrl: string;
  /** Where the current state goes whenever it changes (shell window). */
  publish(state: AccountState): void;
  publishDevices?(devices: DeviceInfo[]): void;
  /** This Mac holds a device token: the sync, cloud, and egress services may start. */
  onEnrolled?(): void;
  /** The account is gone from this Mac (sign-out) or control stopped honouring it (revocation). */
  onSignedOut?(reason: "sign-out" | "revoked"): void | Promise<void>;
  /** A silently refreshed device token: the hub socket must reconnect with it. */
  onTokenChanged?(): void;
  /** `PISTACHIO_HUB_URL`, pinning the hub over `/me` discovery. */
  hubUrlPin?: string | null;
  fetchImpl?: typeof fetch;
  /** PBKDF2 rounds for password and recovery wrappers; tests lower it. */
  kdfIterations?: number;
  /**
   * Make an anonymous account whenever nobody is signed in
   * (docs/anonymous-accounts.md). Off unless asked for, so a service built
   * for a test makes no call the test did not script.
   */
  anonymousAccounts?: boolean;
  /** The clock behind the anonymous retry backoff; tests inject it. */
  now?: () => number;
}

/** After a failed anonymous sign-up, how long before another is tried; doubles to the ceiling. */
export const ANONYMOUS_RETRY_MS = 30_000;
export const ANONYMOUS_RETRY_MAX_MS = 60 * 60 * 1000;

/** A short, comparable rendering of a raw public key (base64 in, 8 groups of 4 hex out). */
export function keyFingerprint(publicKeyBase64: string): string {
  let raw: Uint8Array;
  try {
    raw = fromBase64(publicKeyBase64);
  } catch {
    return "";
  }
  const hex = createHash("sha256").update(raw).digest("hex").slice(0, 32);
  return hex.match(/.{4}/g)?.join(" ") ?? hex;
}

export class AuthService {
  readonly #deps: AuthServiceDeps;
  readonly #client: ControlClient;
  readonly #kdfIterations: number;
  /** Held only between sign-in/sign-up and enroll, so enroll can seal the keys under it. */
  #pendingPassword: string | null = null;
  /**
   * This Mac joined an EXISTING account: its secrets came from the account,
   * so enroll must not overwrite the account's recovery wrappers.
   */
  #joinedExistingAccount = false;
  /**
   * Spaces the ACCOUNT holds a key for that this Mac could not open: a
   * wrapper listing that failed, a wrapper sealed under an older password, or
   * none at all after a password reset. Minting a stand-in for one of these
   * would fork the Space — and, on a joined account, upload a `password`
   * wrapper over the real one — so nothing here is ever minted or sealed.
   */
  readonly #keylessSpaces = new Set<string>();
  #discovery: { hubUrl: string | null; cloudBrowserUrl: string | null } | null = null;
  #cloudDeviceChanged: CloudDevicePinRecord | null = null;
  #revoked = false;
  #error: string | null = null;
  /** In flight, so a launch and the first model call share one sign-up. */
  #anonymousInFlight: Promise<boolean> | null = null;
  #anonymousRetryAt = 0;
  #anonymousRetryMs = ANONYMOUS_RETRY_MS;
  #anonymousRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * A sign-up or sign-in is under way. The client's token is theirs while it
   * is: an anonymous sign-up landing in the middle would replace it.
   */
  #signingIn = 0;

  constructor(deps: AuthServiceDeps) {
    this.#deps = deps;
    this.#kdfIterations = deps.kdfIterations ?? RECOVERY_CODE_PBKDF2_ITERATIONS;
    this.#client = new ControlClient(deps.controlUrl, {
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      onUnauthorized: () => this.#unauthorized(),
      onTokenChanged: (token) => this.#tokenChanged(token),
    });
    const enrollment = deps.store.enrollment();
    if (enrollment.state !== "unenrolled" && enrollment.token !== null) {
      // A device token: an enrolled Mac, an anonymous one, or one that was
      // anonymous and is between sign-up and enroll.
      this.#client.setToken(enrollment.token);
      this.#wireReauth();
    } else if (enrollment.state === "signed-up" && enrollment.bootstrapToken !== null) {
      this.#client.setToken(enrollment.bootstrapToken);
    }
  }

  /** Restored at startup: discover the planes and finish what was left undone. */
  start(): void {
    if (!this.enrolled()) {
      void this.ensureAnonymous();
      return;
    }
    void this.#refreshDiscovery();
    void this.#flushPendingWrappers();
    this.#deps.onEnrolled?.();
  }

  shutdown(): void {
    this.#client.dispose();
    if (this.#anonymousRetryTimer !== null) clearTimeout(this.#anonymousRetryTimer);
    this.#anonymousRetryTimer = null;
  }

  controlClient(): ControlClient {
    return this.#client;
  }

  enrolled(): boolean {
    const enrollment = this.#deps.store.enrollment();
    return enrollment.state === "enrolled" && enrollment.token !== null && !this.#revoked;
  }

  /** The device token, refreshed when due; null until enrolled. */
  getToken(): Promise<string | null> {
    return this.enrolled() ? this.#client.getToken() : Promise.resolve(null);
  }

  /**
   * Whether the models can be reached: this Mac holds a device token, a
   * signed-in account's or an anonymous one's. Everything else an account
   * brings (sync, the vault, the cloud browser) still asks `enrolled()`.
   */
  modelsAvailable(): boolean {
    const enrollment = this.#deps.store.enrollment();
    return enrollment.state !== "unenrolled" && enrollment.token !== null && !this.#revoked;
  }

  /**
   * The token for a model call. With none here yet — the first launch was
   * offline, say — this is also when the anonymous sign-up is tried again.
   */
  async getModelToken(): Promise<string | null> {
    if (!this.modelsAvailable() && !(await this.ensureAnonymous())) return null;
    // While a sign-in is under way the client speaks for the account being
    // signed in to — its token is that account's BOOTSTRAP token, which the
    // models refuse (`device_required`). The device token this Mac holds is
    // the one in the store: the anonymous account's until the link lands,
    // then this Mac's under the real account (`#tokenChanged` keeps it
    // current). Only when the two agree is the client's refresh the way.
    const held = this.#deps.store.enrollment().token;
    if (held !== null && this.#client.token() !== held) return held;
    return this.#client.getToken();
  }

  /**
   * Nobody is signed in: have control make an anonymous account with this
   * Mac as its device. Answers whether this Mac holds one afterwards. Quiet
   * on failure — the browser works without it — and retried on a backoff.
   */
  ensureAnonymous(): Promise<boolean> {
    if (this.#deps.anonymousAccounts !== true) return Promise.resolve(false);
    const store = this.#deps.store;
    if (store.enrollment().state === "anonymous") return Promise.resolve(this.modelsAvailable());
    if (store.enrollment().state !== "unenrolled" || !store.encryptionAvailable) return Promise.resolve(false);
    if (this.#anonymousInFlight !== null) return this.#anonymousInFlight;
    // Every way out of here while nobody is signed in leaves something that
    // will ask again — the sign-in's end, or a timer — or the models would
    // stay off until the next launch.
    if (this.#signingIn > 0) return Promise.resolve(false); // `#exclusively` asks again when it ends
    const now = (this.#deps.now ?? Date.now)();
    if (now < this.#anonymousRetryAt) {
      if (this.#anonymousRetryTimer === null) this.#armAnonymousRetry(this.#anonymousRetryAt - now);
      return Promise.resolve(false);
    }
    const attempt = (async (): Promise<boolean> => {
      try {
        const out = await this.#anonymousOnce(true);
        // A sign-in that started meanwhile owns the enrollment now.
        if (store.enrollment().state !== "unenrolled") return false;
        store.setEnrollment({
          state: "anonymous",
          userId: out.userId,
          email: null,
          controlUrl: this.#deps.controlUrl,
          token: out.token,
          bootstrapToken: null,
        });
        this.#revoked = false;
        this.#anonymousRetryMs = ANONYMOUS_RETRY_MS;
        this.#wireReauth();
        this.#publish();
        return true;
      } catch (error) {
        console.error("[account] could not make an anonymous account; the models stay off until it can", error);
        const delay = this.#anonymousRetryMs;
        this.#anonymousRetryAt = (this.#deps.now ?? Date.now)() + delay;
        this.#anonymousRetryMs = Math.min(delay * 2, ANONYMOUS_RETRY_MAX_MS);
        this.#armAnonymousRetry(delay);
        return false;
      } finally {
        this.#anonymousInFlight = null;
      }
    })();
    this.#anonymousInFlight = attempt;
    return attempt;
  }

  /**
   * Nothing else asks again while the models are off (every feature checks
   * `modelsAvailable` first), so the retry is this service's own.
   */
  #armAnonymousRetry(delayMs: number): void {
    if (this.#anonymousRetryTimer !== null) clearTimeout(this.#anonymousRetryTimer);
    this.#anonymousRetryTimer = setTimeout(() => {
      this.#anonymousRetryTimer = null;
      void this.ensureAnonymous();
    }, Math.max(0, delayMs));
    this.#anonymousRetryTimer.unref?.();
  }

  hubUrl(): string | null {
    const pin = this.#deps.hubUrlPin?.trim() ?? "";
    return pin !== "" ? pin : (this.#discovery?.hubUrl ?? null);
  }

  cloudBrowserUrl(): string | null {
    return this.#discovery?.cloudBrowserUrl ?? null;
  }

  state(): AccountState {
    const store = this.#deps.store;
    const enrollment = store.enrollment();
    const pin = store.cloudDevicePin();
    return {
      state: enrollment.state,
      email: enrollment.email,
      userId: enrollment.userId,
      deviceId: store.encryptionAvailable ? store.deviceId : null,
      deviceName: store.deviceName,
      controlUrl: this.#deps.controlUrl,
      encryptionAvailable: store.encryptionAvailable,
      cloudDevicePin: pin === null ? null : pinInfo(pin),
      cloudDeviceChanged: this.#cloudDeviceChanged === null ? null : pinInfo(this.#cloudDeviceChanged),
      revoked: this.#revoked,
      hubUrl: this.hubUrl(),
      cloudBrowserUrl: this.cloudBrowserUrl(),
      error: this.#error,
    };
  }

  /* -------------------------------- account -------------------------------- */

  signUp(email: string, password: string): Promise<AccountState> {
    return this.#exclusively(() => this.#signUp(email, password));
  }

  signIn(email: string, password: string): Promise<AccountState> {
    return this.#exclusively(() => this.#signIn(email, password));
  }

  /** One sign-up or sign-in at a time with respect to the anonymous sign-up: it settles first, and none starts during. */
  async #exclusively<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#anonymousInFlight !== null) await this.#anonymousInFlight.catch(() => false);
    this.#signingIn += 1;
    try {
      return await operation();
    } finally {
      this.#signingIn -= 1;
      // A retry that came due meanwhile was turned away, and its timer is
      // spent. If this ended with nobody signed in (a wrong password), that
      // retry is owed now; any other outcome makes this a no-op.
      if (this.#signingIn === 0) void this.ensureAnonymous();
    }
  }

  async #signUp(email: string, password: string): Promise<AccountState> {
    this.#requireEncryption();
    const normalized = normalizeEmail(email);
    if (password.length < 8) throw new Error("Choose a password of at least 8 characters.");
    if (this.#anonymous()) return this.#upgrade(normalized, password);
    const out = await this.#attempt(() => this.#client.signUp(normalized, password));
    this.#keylessSpaces.clear();
    this.#pendingPassword = password;
    this.#joinedExistingAccount = false;
    this.#revoked = false;
    this.#deps.store.setEnrollment({
      state: "signed-up",
      userId: out.userId,
      email: normalized,
      controlUrl: this.#deps.controlUrl,
      bootstrapToken: out.bootstrapToken,
      token: null,
    });
    this.#publish();
    return this.state();
  }

  async #signIn(email: string, password: string): Promise<AccountState> {
    this.#requireEncryption();
    const normalized = normalizeEmail(email);
    // The anonymous account's own token, taken before the login replaces it:
    // it is the proof `/account/link` needs that this Mac may fold it in.
    const anonymousToken = this.#anonymous() ? await this.#client.getToken().catch(() => null) : null;
    const out = await this.#attempt(() => this.#client.passwordLogin(normalized, password));
    // From here the client speaks for the account signed in to; a 401 must
    // not be answered by re-proving the anonymous device.
    this.#client.setReauth(null);
    // Install the account's secrets BEFORE anything derives keys, so no
    // engine ever seals under a fresh random stand-in. The wrappers were
    // sealed at first enroll under a KEK from this same password; control
    // holds only ciphertext.
    this.#keylessSpaces.clear();
    try {
      const spaceIds = [...(await this.#client.listSpaces()).map((space) => space.id), WORKSPACE_PSEUDO_SPACE_ID];
      const keks = new Map<string, CryptoKey>();
      for (const spaceId of new Set(spaceIds)) {
        let wrappers;
        try {
          wrappers = await this.#client.listWrappers(spaceId);
        } catch {
          // The account owns a key for this Space and this Mac did not get
          // it; that must never look like a Space with no key at all.
          this.#keylessSpaces.add(spaceId);
          continue;
        }
        for (const wrapper of wrappers) {
          if (wrapper.kind !== "password" || wrapper.credentialId !== PASSWORD_CREDENTIAL_ID) continue;
          try {
            let kek = keks.get(wrapper.salt);
            if (kek === undefined) {
              kek = await deriveKekFromPassphrase(password, fromBase64(wrapper.salt), this.#kdfIterations);
              keks.set(wrapper.salt, kek);
            }
            const secret = await unwrapRootSecret(kek, fromBase64(wrapper.wrapped), spaceId);
            this.#storeSecret(spaceId, secret);
          } catch {
            // A wrapper from a rotated password or secret: skip it; the
            // recovery path can still restore this Space later.
          }
        }
        // No password wrapper opened here — a tampered or rotated one, or a
        // password reset that purged them (§7.3) — and nothing else brought
        // the key either.
        if (this.#secretFor(spaceId) === null) this.#keylessSpaces.add(spaceId);
      }
    } catch (error) {
      // The account link still stands; keys can follow later. Nothing is
      // known about which Spaces the account holds keys for, so every one of
      // them is treated as the account's until a sign-in says otherwise.
      console.error("[account] wrapper listing failed after sign-in", error);
      for (const space of this.#deps.spaces.all()) this.#keylessSpaces.add(space.id);
      this.#keylessSpaces.add(WORKSPACE_PSEUDO_SPACE_ID);
    }
    for (const spaceId of [...this.#keylessSpaces])
      if (this.#secretFor(spaceId) !== null) this.#keylessSpaces.delete(spaceId);
    this.#pendingPassword = password;
    this.#joinedExistingAccount = true;
    this.#revoked = false;
    this.#deps.store.setEnrollment({
      state: "signed-up",
      userId: out.userId,
      email: normalized,
      controlUrl: this.#deps.controlUrl,
      bootstrapToken: out.bootstrapToken,
      token: anonymousToken === null ? null : await this.#linkAnonymous(anonymousToken, out.bootstrapToken),
    });
    this.#publish();
    return this.state();
  }

  /**
   * Enroll this Mac under its one device id. On the account's first
   * enrollment the recovery code in the answer is the only time it is shown.
   */
  async enroll(): Promise<AccountEnrollResult> {
    this.#requireEncryption();
    const store = this.#deps.store;
    const enrollment = store.enrollment();
    if (enrollment.state === "enrolled" && enrollment.token !== null && !this.#revoked) {
      return { state: this.state(), recoveryCode: null };
    }
    // An account that was this Mac's anonymous one (upgraded), or that
    // absorbed it (linked), already has this device: the token is here, and
    // only the keys below are left to do.
    const held = enrollment.state === "signed-up" ? enrollment.token : null;
    if (held !== null) {
      this.#client.setToken(held);
    } else {
      if (enrollment.state !== "signed-up" || enrollment.bootstrapToken === null) {
        throw new Error("Sign in before enrolling this Mac.");
      }
      this.#client.setReauth(null);
      this.#client.setToken(enrollment.bootstrapToken);
      const device = await this.#attempt(() => this.#enrollOnce(true));
      if (device.id !== store.deviceId) {
        this.#client.setToken(enrollment.bootstrapToken);
        throw new Error("control enrolled a different device id than this Mac sent");
      }
    }
    const token = this.#client.token();
    if (token === null) throw new Error("control answered enrollment without a device token");
    store.setEnrollment({ state: "enrolled", token, bootstrapToken: null });
    this.#revoked = false;
    this.#error = null;
    this.#wireReauth();

    const created = await this.#ensureLocalSecrets();
    this.#reportKeylessSpaces();
    let recoveryCode: string | null = null;
    const password = this.#pendingPassword;
    this.#pendingPassword = null;
    if (!this.#joinedExistingAccount) {
      // First enrollment: every local Space is new to control, and the
      // account's recovery code is minted here, once.
      const spaceIds = this.#secretSpaceIds();
      await this.#registerSpaces(spaceIds);
      if (password !== null) await this.#uploadPasswordWrappers(spaceIds, password);
      recoveryCode = await this.#uploadRecoveryWrappers(spaceIds);
    } else if (created.length > 0) {
      // A joined account: only the Spaces that exist here alone need control
      // to know them and a password wrapper so another device can follow.
      await this.#registerSpaces(created);
      if (password !== null) await this.#uploadPasswordWrappers(created, password);
    }
    await this.#flushPendingWrappers();
    this.#publish();
    this.#deps.onEnrolled?.();
    void this.#refreshDiscovery();
    return { state: this.state(), recoveryCode };
  }

  /** Forget the account here. Spaces and tabs stay; keys and tokens go; the device id stays (§10.1). */
  async signOut(): Promise<AccountState> {
    this.#client.setReauth(null);
    this.#client.setToken(null);
    this.#client.dispose();
    this.#deps.store.clearAccount();
    this.#pendingPassword = null;
    this.#joinedExistingAccount = false;
    this.#keylessSpaces.clear();
    this.#discovery = null;
    this.#cloudDeviceChanged = null;
    this.#revoked = false;
    this.#error = null;
    for (const space of this.#deps.spaces.all()) {
      if (space.cloudEnabled) this.#deps.spaces.setCloudEnabled(space.id, false);
    }
    await this.#deps.onSignedOut?.("sign-out");
    this.#publish();
    // Signed out is not accountless: the models carry on under a fresh
    // anonymous account (control still holds the old device row, so the
    // sign-up mints a new identity on the 409, as enroll does).
    void this.ensureAnonymous();
    return this.state();
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<AccountState> {
    this.#requireEnrolled();
    if (newPassword.length < 8) throw new Error("Choose a password of at least 8 characters.");
    await this.#attempt(() => this.#client.changePassword({ currentPassword, newPassword }));
    // Wrappers sealed under the old password can never open again; only this
    // device (holding the secrets) can mint replacements. The upload upserts
    // per space, so stale seals are replaced in place.
    await this.#uploadPasswordWrappers(this.#secretSpaceIds(), newPassword);
    this.#publish();
    return this.state();
  }

  /** A fresh recovery code for every secret this Mac holds; the old code stops working. */
  async recoveryCode(): Promise<string> {
    this.#requireEnrolled();
    const code = await this.#uploadRecoveryWrappers(this.#secretSpaceIds());
    if (code === null) throw new Error("The recovery wrappers could not be uploaded. Try again when control is reachable.");
    return code;
  }

  /* -------------------------------- devices -------------------------------- */

  async listDevices(): Promise<DeviceInfo[]> {
    if (!this.enrolled()) return [];
    const devices = (await this.#attempt(() => this.#client.listDevices())).map((device) =>
      this.#deviceInfo(device),
    );
    this.#deps.publishDevices?.(devices);
    return devices;
  }

  async renameDevice(deviceId: string, name: string): Promise<DeviceInfo[]> {
    this.#requireEnrolled();
    const trimmed = name.trim();
    if (trimmed === "") throw new Error("Give the device a name.");
    await this.#attempt(() => this.#client.renameDevice(deviceId, trimmed));
    if (deviceId === this.#deps.store.deviceId) {
      this.#deps.store.setDeviceName(trimmed);
      this.#publish();
    }
    return this.listDevices();
  }

  async revokeDevice(deviceId: string): Promise<DeviceInfo[]> {
    this.#requireEnrolled();
    await this.#attempt(() => this.#client.revokeDevice(deviceId));
    const pin = this.#deps.store.cloudDevicePin();
    if (pin !== null && pin.deviceId === deviceId) {
      // Revocation clears the pin and every Space the cloud device held (§10.1).
      this.#deps.store.setCloudDevicePin(null);
      for (const space of this.#deps.spaces.all()) {
        if (space.cloudEnabled) this.#deps.spaces.setCloudEnabled(space.id, false);
      }
      this.#publish();
    }
    if (deviceId === this.#deps.store.deviceId) {
      // This Mac revoked itself: control will refuse its token from here on.
      this.#revoked = true;
      this.#error = "This Mac's enrollment was revoked. Sign in again to enroll it.";
      await this.#deps.onSignedOut?.("revoked");
      this.#publish();
      return [];
    }
    return this.listDevices();
  }

  /* --------------------------------- cloud --------------------------------- */

  /** Hand the pinned cloud device this Space's key and the workspace key (D6). */
  async enableCloud(spaceId: string): Promise<void> {
    this.#requireEnrolled();
    if (this.#deps.spaces.get(spaceId) === null) throw new Error("unknown Space");
    await this.#ensureLocalSecrets();
    const device = await this.#attempt(() => this.#client.enableCloud(spaceId));
    const candidate = validateCloudDevice(device);
    const store = this.#deps.store;
    let pin = store.cloudDevicePin();
    if (pin === null) {
      // Trust on first use: control introduces the cloud device once; the
      // fingerprint under Settings → Devices makes any later change visible.
      pin = candidate;
      store.setCloudDevicePin(pin);
      this.#cloudDeviceChanged = null;
    } else if (pin.deviceId !== candidate.deviceId || pin.agreementPublicKey !== candidate.agreementPublicKey) {
      this.#cloudDeviceChanged = candidate;
      this.#publish();
      throw new CloudDeviceChanged();
    }
    const identity = store.identity();
    const recipient = { deviceId: pin.deviceId, agreementPublicKeyRaw: fromBase64(pin.agreementPublicKey) };
    const sender = { deviceId: store.deviceId, signingKey: identity.signingKey };
    for (const id of [spaceId, WORKSPACE_PSEUDO_SPACE_ID]) {
      const secret = this.#secretFor(id);
      if (secret === null) throw new Error(`this Mac holds no key for ${id}`);
      const wrapper = await wrapRootSecretToDevice(secret, id, recipient, sender);
      const input: ControlWrapperInput = {
        kind: DEVICE_WRAPPER_KIND,
        credentialId: wrapper.credentialId,
        salt: wrapper.salt,
        wrapped: wrapper.wrapped,
        ...(wrapper.senderDeviceId === undefined ? {} : { senderDeviceId: wrapper.senderDeviceId }),
        ...(wrapper.signature === undefined ? {} : { signature: wrapper.signature }),
      };
      await this.#attempt(() => this.#client.putWrappers(id, [input]));
    }
    this.#deps.spaces.setCloudEnabled(spaceId, true);
    this.#publish();
  }

  async disableCloud(spaceId: string): Promise<void> {
    this.#requireEnrolled();
    await this.#attempt(() => this.#client.disableCloud(spaceId));
    const pin = this.#deps.store.cloudDevicePin();
    if (pin !== null) {
      // Control drops the Space's wrapper itself; this only tidies a stale one.
      await this.#client.deleteWrapper(spaceId, DEVICE_WRAPPER_KIND, pin.deviceId).catch(() => undefined);
    }
    this.#deps.spaces.setCloudEnabled(spaceId, false);
    if (!this.#deps.spaces.all().some((space) => space.cloudEnabled)) {
      // No Space left: control revoked the cloud device, so the pin goes with it.
      this.#deps.store.setCloudDevicePin(null);
    }
    this.#publish();
  }

  /** Accept the cloud device control introduced after the pin; the caller then enables again. */
  confirmCloudDevice(): AccountState {
    const changed = this.#cloudDeviceChanged;
    if (changed !== null) {
      this.#deps.store.setCloudDevicePin(changed);
      this.#cloudDeviceChanged = null;
      this.#publish();
    }
    return this.state();
  }

  /**
   * A Space created after enrollment (a fork) needs a root secret before its
   * cookies can sync, and control must know the Space before a wrapper can
   * attach to it. Password wrappers for it follow at the next password change
   * (the password is not kept). Called on every local Space change.
   */
  async ensureSpaceSecrets(): Promise<void> {
    if (!this.enrolled()) return;
    const created = await this.#ensureLocalSecrets();
    if (created.length > 0) await this.#registerSpaces(created);
  }

  /* -------------------------------- internals -------------------------------- */

  #anonymous(): boolean {
    return this.#deps.store.enrollment().state === "anonymous" && this.modelsAvailable();
  }

  async #anonymousOnce(retryOnConflict: boolean): Promise<{ userId: string; token: string }> {
    const store = this.#deps.store;
    const identity = store.identity();
    const challenge = await this.#client.deviceChallenge(store.deviceId);
    const signature = await this.#sign(challenge);
    try {
      const out = await this.#client.createAnonymousAccount({
        deviceId: store.deviceId,
        name: store.deviceName,
        platform: "macos",
        devicePublicKey: toBase64(identity.devicePublicKeyRaw),
        agreementPublicKey: toBase64(identity.agreementPublicKeyRaw),
        challenge,
        signature,
      });
      if (out.device.id !== store.deviceId) throw new Error("control enrolled a different device id than this Mac sent");
      return { userId: out.userId, token: out.token };
    } catch (error) {
      if (retryOnConflict && error instanceof ControlError && error.status === 409 && IDENTITY_CONFLICTS.has(error.code ?? "")) {
        // Control knows this identity under an account this Mac signed out
        // of: a new id and keys together, once (§10.1).
        await store.regenerateIdentity();
        return this.#anonymousOnce(false);
      }
      throw error;
    }
  }

  /** The anonymous account becomes the real one in place; this Mac keeps its token. */
  async #upgrade(email: string, password: string): Promise<AccountState> {
    const out = await this.#attempt(() => this.#client.upgradeAccount(email, password));
    this.#keylessSpaces.clear();
    this.#pendingPassword = password;
    this.#joinedExistingAccount = false;
    // `signed-up` WITH the device token: enroll has no device left to
    // register, only this account's first keys to make and seal.
    this.#deps.store.setEnrollment({ state: "signed-up", userId: out.userId, email, bootstrapToken: null });
    this.#publish();
    return this.state();
  }

  /**
   * Fold the anonymous account into the one just signed in to. Answers this
   * Mac's device token under that account, or null when control would not —
   * then enroll registers the device afresh (on a new identity, since control
   * still holds the old one) and the anonymous account is left to be swept.
   */
  async #linkAnonymous(anonymousToken: string, bootstrapToken: string): Promise<string | null> {
    try {
      const out = await this.#client.linkAnonymousAccount(anonymousToken);
      if (out.device.id !== this.#deps.store.deviceId) throw new Error("control linked a different device id than this Mac's");
      return out.token;
    } catch (error) {
      console.error("[account] could not link the anonymous account; enrolling afresh instead", error);
      this.#client.setToken(bootstrapToken);
      return null;
    }
  }

  async #enrollOnce(retryOnConflict: boolean): Promise<ControlDevice> {
    const store = this.#deps.store;
    const identity = store.identity();
    const challenge = await this.#client.deviceChallenge(store.deviceId);
    const signature = await this.#sign(challenge);
    try {
      const out = await this.#client.enrollDevice({
        deviceId: store.deviceId,
        name: store.deviceName,
        platform: "macos",
        devicePublicKey: toBase64(identity.devicePublicKeyRaw),
        agreementPublicKey: toBase64(identity.agreementPublicKeyRaw),
        challenge,
        signature,
      });
      return out.device;
    } catch (error) {
      if (retryOnConflict && error instanceof ControlError && error.status === 409 && IDENTITY_CONFLICTS.has(error.code ?? "")) {
        // Control knows this identity already (another account, or a revoked
        // row): mint a new id and keys together and try once more (§10.1).
        await store.regenerateIdentity();
        return this.#enrollOnce(false);
      }
      throw error;
    }
  }

  async #sign(challenge: string): Promise<string> {
    const identity = this.#deps.store.identity();
    const signature = await crypto.subtle.sign(
      "Ed25519",
      identity.signingKey,
      deviceLoginSigningBytes(this.#deps.store.deviceId, challenge) as BufferSource,
    );
    return toBase64(new Uint8Array(signature));
  }

  /**
   * The 401 fallback: prove possession of the device key and mint a fresh
   * token.
   *
   * The answer is a verdict on the KEY, so only control refusing it answers
   * `null` — which is what erases the enrollment. A proof that could not be
   * made at all (the plane unreachable, a 5xx, a rate limit, a challenge
   * control forgot across a restart) rejects instead, so the token survives
   * and the next refresh or request tries again; a Mac that wakes on a slow
   * Wi-Fi must not be told its enrollment was revoked.
   */
  #wireReauth(): void {
    this.#client.setReauth(async () => {
      const deviceId = this.#deps.store.deviceId;
      try {
        const challenge = await this.#client.deviceChallenge(deviceId);
        const signature = await this.#sign(challenge);
        const out = await this.#client.deviceLogin({ deviceId, challenge, signature });
        this.#deps.store.setEnrollment({ token: out.token });
        return out.token;
      } catch (error) {
        if (refusesThisKey(error)) return null;
        throw error;
      }
    });
  }

  #unauthorized(): void {
    const enrollment = this.#deps.store.enrollment();
    if (enrollment.state === "anonymous") {
      // Control no longer knows the anonymous account (swept after months
      // unused, say). Nothing of the person's was in it: start another.
      this.#client.setReauth(null);
      this.#client.setToken(null);
      this.#deps.store.setEnrollment({ state: "unenrolled", userId: null, token: null, bootstrapToken: null });
      this.#publish();
      void this.ensureAnonymous();
      return;
    }
    if (enrollment.state !== "enrolled") return;
    this.#revoked = true;
    this.#deps.store.setEnrollment({ token: null });
    this.#error = "Control no longer accepts this Mac's key: its enrollment was revoked. Sign in again to enroll it.";
    void this.#deps.onSignedOut?.("revoked");
    this.#publish();
  }

  #tokenChanged(token: string | null): void {
    if (token === null || !token.includes(".")) return;
    const enrollment = this.#deps.store.enrollment();
    if (enrollment.token === token) return;
    // A refreshed DEVICE token is kept wherever one is held; a bootstrap
    // token passing through the client (sign-in) is not one.
    if (enrollment.state === "unenrolled" || enrollment.token === null || isBootstrapToken(token)) return;
    this.#deps.store.setEnrollment({ token });
    // Only an enrolled Mac has a hub socket to reconnect.
    if (enrollment.state === "enrolled") this.#deps.onTokenChanged?.();
  }

  async #refreshDiscovery(): Promise<void> {
    try {
      const me = await this.#client.me();
      this.#discovery = {
        hubUrl: typeof me.hubUrl === "string" && me.hubUrl !== "" ? me.hubUrl : null,
        cloudBrowserUrl:
          typeof me.cloudBrowserUrl === "string" && me.cloudBrowserUrl !== "" ? me.cloudBrowserUrl : null,
      };
      this.#publish();
    } catch {
      // Control unreachable: the next start or enroll retries.
    }
  }

  #requireEncryption(): void {
    if (!this.#deps.store.encryptionAvailable) {
      throw new Error(
        "Pistachio can't sign in on this Mac: the system keychain is unavailable, so account keys could not be protected.",
      );
    }
  }

  #requireEnrolled(): void {
    if (!this.enrolled()) throw new Error("This Mac is not enrolled. Sign in and enroll it first.");
  }

  /** Every Space with a secret here, the workspace pseudo-Space included. */
  #secretSpaceIds(): string[] {
    const ids = new Set(this.#deps.store.spaceSecretIds());
    if (this.#deps.store.workspaceSecret() !== null) ids.add(WORKSPACE_PSEUDO_SPACE_ID);
    return [...ids];
  }

  #secretFor(spaceId: string): Uint8Array | null {
    return spaceId === WORKSPACE_PSEUDO_SPACE_ID
      ? this.#deps.store.workspaceSecret()
      : this.#deps.store.spaceSecret(spaceId);
  }

  #storeSecret(spaceId: string, secret: Uint8Array): void {
    if (spaceId === WORKSPACE_PSEUDO_SPACE_ID) this.#deps.store.setWorkspaceSecret(secret);
    else this.#deps.store.setSpaceSecret(spaceId, secret);
  }

  /** A root secret for every local Space and `__workspace__`; answers the ids that were missing. */
  async #ensureLocalSecrets(): Promise<string[]> {
    const created: string[] = [];
    const ids = [...this.#deps.spaces.all().map((space) => space.id), WORKSPACE_PSEUDO_SPACE_ID];
    for (const spaceId of ids) {
      if (this.#secretFor(spaceId) !== null) continue;
      // The account holds this Space's key and this Mac did not get it:
      // minting one here would fork the Space and, worse, upload a `password`
      // wrapper over the account's own (the upload upserts on kind and
      // credential id), leaving the real key openable by the recovery code
      // alone. It stays keyless until a sign-in brings the key.
      if (this.#keylessSpaces.has(spaceId)) continue;
      this.#storeSecret(spaceId, generateSpaceRootSecret());
      created.push(spaceId);
    }
    return created;
  }

  /**
   * Say so when this Mac enrolled without some of the account's keys, rather
   * than leaving those Spaces silently unsynced: they hold no key here, so
   * nothing seals or opens for them until a sign-in with a reachable control
   * plane — or the recovery code — brings the key.
   */
  #reportKeylessSpaces(): void {
    const missing = [...this.#keylessSpaces]
      .filter((spaceId) => this.#secretFor(spaceId) === null)
      .map((spaceId) =>
        spaceId === WORKSPACE_PSEUDO_SPACE_ID
          ? "the shared workspace"
          : (this.#deps.spaces.get(spaceId)?.name ?? spaceId),
      );
    if (missing.length === 0) return;
    this.#error = `This Mac could not obtain the keys for ${missing.join(", ")}. That will not sync here — sign in again when the control plane is reachable, or use your recovery code.`;
  }

  /** Control must know a Space before a wrapper can attach to it; `__workspace__` it made itself. */
  async #registerSpaces(spaceIds: string[]): Promise<void> {
    for (const spaceId of spaceIds) {
      if (spaceId === WORKSPACE_PSEUDO_SPACE_ID) continue;
      const space = this.#deps.spaces.get(spaceId);
      if (space === null) continue;
      try {
        await this.#client.putSpace(spaceId, space.name);
      } catch (error) {
        console.error(`[account] could not register Space ${spaceId}`, error);
      }
    }
  }

  async #uploadPasswordWrappers(spaceIds: string[], password: string): Promise<void> {
    const salt = new Uint8Array(KEK_SALT_BYTES);
    crypto.getRandomValues(salt);
    const kek = await deriveKekFromPassphrase(password, salt, this.#kdfIterations);
    const wrappers = await this.#wrapAll(spaceIds, kek, salt, "password", PASSWORD_CREDENTIAL_ID);
    await this.#uploadWrappers(wrappers);
  }

  /** One recovery code seals every secret; null when nothing could be uploaded. */
  async #uploadRecoveryWrappers(spaceIds: string[]): Promise<string | null> {
    const code = generateRecoveryCode();
    const salt = new Uint8Array(KEK_SALT_BYTES);
    crypto.getRandomValues(salt);
    const kek = await deriveKekFromRecoveryCode(code, salt, this.#kdfIterations);
    const wrappers = await this.#wrapAll(spaceIds, kek, salt, "recovery-code", RECOVERY_CREDENTIAL_ID);
    if (wrappers.length === 0) return null;
    const failed = await this.#uploadWrappers(wrappers);
    // A code that recovers nothing must never be shown.
    return failed === wrappers.length ? null : code;
  }

  async #wrapAll(
    spaceIds: string[],
    kek: CryptoKey,
    salt: Uint8Array,
    kind: KeyWrapperKind,
    credentialId: string,
  ): Promise<PendingWrapper[]> {
    const wrappers: PendingWrapper[] = [];
    for (const spaceId of spaceIds) {
      const secret = this.#secretFor(spaceId);
      if (secret === null) continue;
      wrappers.push({
        spaceId,
        kind,
        credentialId,
        salt: toBase64(salt),
        wrapped: toBase64(await wrapRootSecret(kek, secret, spaceId)),
      });
    }
    return wrappers;
  }

  /** Upload per Space; what fails is kept (ciphertext only) and retried at the next start. Answers how many failed. */
  async #uploadWrappers(wrappers: PendingWrapper[]): Promise<number> {
    const failed: PendingWrapper[] = [];
    for (const wrapper of wrappers) {
      try {
        await this.#client.putWrappers(wrapper.spaceId, [
          { kind: wrapper.kind, credentialId: wrapper.credentialId, salt: wrapper.salt, wrapped: wrapper.wrapped },
        ]);
      } catch (error) {
        console.error(`[account] wrapper upload failed for ${wrapper.spaceId}`, error);
        failed.push(wrapper);
      }
    }
    if (failed.length > 0) {
      const pending = this.#deps.store
        .pendingWrappers()
        .filter((p) => !failed.some((f) => f.spaceId === p.spaceId && f.kind === p.kind && f.credentialId === p.credentialId));
      this.#deps.store.setPendingWrappers([...pending, ...failed]);
    }
    return failed.length;
  }

  async #flushPendingWrappers(): Promise<void> {
    const pending = this.#deps.store.pendingWrappers();
    if (pending.length === 0 || !this.enrolled()) return;
    this.#deps.store.setPendingWrappers([]);
    await this.#uploadWrappers(pending);
  }

  #deviceInfo(device: ControlDevice): DeviceInfo {
    const pin = this.#deps.store.cloudDevicePin();
    return {
      id: device.id,
      name: device.name,
      // Control's own union, passed through rather than collapsed: a browser
      // signed in on the web is not a Mac, and the device list says so.
      platform: device.platform,
      devicePublicKey: device.devicePublicKey,
      agreementPublicKey: device.agreementPublicKey,
      fingerprint: keyFingerprint(device.agreementPublicKey),
      createdAt: device.createdAt ?? null,
      lastSeenAt: device.lastSeenAt ?? null,
      revokedAt: device.revokedAt ?? null,
      isThisDevice: device.id === this.#deps.store.deviceId,
      isPinnedCloudDevice:
        pin !== null && pin.deviceId === device.id && pin.agreementPublicKey === device.agreementPublicKey,
    };
  }

  /** Run one control call; a failure is remembered for the settings page and rethrown. */
  async #attempt<T>(call: () => Promise<T>): Promise<T> {
    try {
      const out = await call();
      this.#error = null;
      return out;
    } catch (error) {
      this.#error = friendly(error);
      this.#publish();
      throw error;
    }
  }

  #publish(): void {
    this.#deps.publish(this.state());
  }
}

/** Control already knows this device id or key: the answer is a new identity, once. */
const IDENTITY_CONFLICTS: ReadonlySet<string> = new Set(["device_id_taken", "device_already_enrolled", "device_revoked"]);

function pinInfo(pin: CloudDevicePinRecord): CloudDevicePin {
  return { ...pin, fingerprint: keyFingerprint(pin.agreementPublicKey) };
}

function validateCloudDevice(device: ControlDevice): CloudDevicePinRecord {
  if (device.platform !== "cloud") throw new CloudDeviceInvalid(`platform ${String(device.platform)}`);
  if (typeof device.id !== "string" || device.id === "") throw new CloudDeviceInvalid("missing id");
  let raw: Uint8Array;
  try {
    raw = fromBase64(device.agreementPublicKey);
  } catch {
    throw new CloudDeviceInvalid("agreement key is not base64");
  }
  if (raw.length !== X25519_KEY_BYTES) throw new CloudDeviceInvalid(`agreement key is ${String(raw.length)} bytes`);
  return { deviceId: device.id, agreementPublicKey: device.agreementPublicKey };
}

/**
 * Whether control REFUSED this device key, as opposed to the proof never
 * getting an answer. A 401/403 naming a revoked, unknown, or wrong key is a
 * refusal; a challenge that expired or a rate limit is control asking for
 * another attempt, and everything else (unreachable, 5xx) never reached a
 * verdict at all.
 */
function refusesThisKey(error: unknown): boolean {
  if (!(error instanceof ControlError)) return false;
  if (error.status !== 401 && error.status !== 403) return false;
  return error.code !== "challenge_expired" && error.code !== "rate_limited";
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error("Enter a valid email address.");
  return normalized;
}

function friendly(error: unknown): string {
  if (error instanceof ControlError) {
    if (error.status === 403 && (error.code === "invalid_credentials" || error.path.includes("password")))
      return "That email and password did not match.";
    if (error.code === "email_taken") return "That email already has an account. Sign in to it instead.";
    if (error.status === 401) return "Control did not accept this Mac's credentials.";
    if (error.status === 503 && error.code === "cloud_unavailable") return "The cloud browser is not available right now.";
    if (error.code === "space_not_cloud_enabled") return "Enable the cloud browser for this Space first.";
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
