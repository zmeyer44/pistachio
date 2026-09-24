/**
 * The device token this browser holds, kept fresh.
 *
 * Control mints device tokens with a ten-minute life
 * (`DEVICE_TOKEN_TTL_SECONDS`), so a tab left open outlives its bearer many
 * times over. Nothing about the enrollment expires with it — the device key is
 * still enrolled — so the fix is to mint another one rather than to make the
 * reader sign in again: this holds the current token, re-mints it a minute
 * before expiry, and re-mints once more when control refuses one. A long
 * session keeps calling, streaming and holding the hub socket open without a
 * reload.
 *
 * `POST /auth/token/refresh` is the cheap path. A token control has already
 * let expire is refused there, and the device key answers instead: the same
 * signed challenge the boot path uses.
 */

import { base64urlDecode, fromUtf8, type DeviceTokenClaims } from "@pistachio/sync-protocol";
import { ControlError, refreshDeviceToken, setTokenRecovery } from "./control";

/** Re-mint this long before `exp`. */
export const TOKEN_REFRESH_LEEWAY_SECONDS = 60;

/** How long a re-mint that could not be completed waits before trying again. */
const RENEW_RETRY_MS = 30_000;

/**
 * `exp` (epoch seconds) of a compact JWT, read without verifying it: control
 * signed the token, and this only needs to know when to replace it.
 */
export function tokenExpSeconds(token: string): number | null {
  const payload = token.split(".")[1];
  if (payload === undefined) return null;
  try {
    const claims = JSON.parse(fromUtf8(base64urlDecode(payload))) as Partial<DeviceTokenClaims>;
    return typeof claims.exp === "number" && Number.isFinite(claims.exp) ? claims.exp : null;
  } catch {
    return null;
  }
}

export interface DeviceTokenSessionOptions {
  /** The token this browser starts with (device login, or enrollment). */
  token: string;
  /** Prove possession of the device key and mint a fresh token. */
  proof: () => Promise<string>;
  /** Every replacement, so the session can hand the current one to its readers. */
  onToken?: (token: string) => void;
}

export class DeviceTokenSession {
  readonly #proof: () => Promise<string>;
  readonly #onToken: ((token: string) => void) | undefined;
  readonly #release: () => void;
  #token: string;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #renewing: Promise<string | null> | null = null;
  #closed = false;

  constructor(options: DeviceTokenSessionOptions) {
    this.#token = options.token;
    this.#proof = options.proof;
    this.#onToken = options.onToken;
    // Registered here rather than by the caller: every call this app makes
    // carries a token from this session, so there is no moment where one is
    // held and a 401 on it cannot be answered.
    this.#release = setTokenRecovery((rejected) => this.renew(rejected));
    this.#arm();
  }

  /** The token as it stands, with no round trip. */
  current(): string {
    return this.#token;
  }

  /** The token, re-minted first when it is inside the leeway window. */
  async get(): Promise<string> {
    const exp = tokenExpSeconds(this.#token);
    if (exp === null || Date.now() / 1_000 < exp - TOKEN_REFRESH_LEEWAY_SECONDS) return this.#token;
    return (await this.renew(this.#token)) ?? this.#token;
  }

  /**
   * Replace a token control refused. `rejected` is the one that was sent, so a
   * call that raced a re-mint takes the current token instead of starting a
   * second one, and a burst of 401s shares a single attempt. Null means the
   * token could not be replaced — the caller's own failure stands.
   */
  renew(rejected: string): Promise<string | null> {
    if (this.#closed) return Promise.resolve(null);
    if (rejected !== this.#token) return Promise.resolve(this.#token);
    if (this.#renewing !== null) return this.#renewing;
    const attempt = this.#renewOnce().finally(() => {
      if (this.#renewing === attempt) this.#renewing = null;
    });
    this.#renewing = attempt;
    return attempt;
  }

  /** Stop refreshing and stop answering 401s: this browser signed out. */
  close(): void {
    this.#closed = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#release();
  }

  async #renewOnce(): Promise<string | null> {
    try {
      const { token } = await refreshDeviceToken(this.#token);
      this.#adopt(token);
      return token;
    } catch (cause) {
      // Only control REFUSING the token is a reason to prove possession again.
      // A network error or a 5xx says nothing about it, so the token is kept
      // and the caller sees its own failure.
      if (!(cause instanceof ControlError) || (cause.status !== 401 && cause.status !== 403)) return null;
    }
    try {
      const minted = await this.#proof();
      this.#adopt(minted);
      return minted;
    } catch {
      // The device key itself was refused: revoked, or the account is gone.
      // The boot path signs this browser out; nothing here can be salvaged.
      return null;
    }
  }

  #adopt(token: string): void {
    if (this.#closed) return;
    this.#token = token;
    this.#arm();
    this.#onToken?.(token);
  }

  /** Wake at `exp − leeway`, or on a fixed delay after a re-mint that failed. */
  #arm(delayMs?: number): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    if (this.#closed) return;
    let delay = delayMs;
    if (delay === undefined) {
      const exp = tokenExpSeconds(this.#token);
      if (exp === null) return;
      delay = Math.max(0, (exp - TOKEN_REFRESH_LEEWAY_SECONDS) * 1_000 - Date.now());
    }
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.renew(this.#token).then((fresh) => {
        // A retry on the fixed delay, never on the expiry: that has passed by
        // now, and re-arming from it would spin.
        if (fresh === null) this.#arm(RENEW_RETRY_MS);
      });
    }, delay);
  }
}
