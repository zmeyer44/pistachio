/**
 * Tunnel authentication (docs/cloud-sync-design.md §7.6, §9).
 *
 * Every CONNECT carries a credential in `Proxy-Authorization`, either as
 * `Basic base64(username:password)` or `Bearer <username>.<password>`. The
 * username is `pe1.<userId>.<deviceId>.<credentialId>.<expUnixSeconds>` and
 * the password is `base64url(HMAC-SHA256(key, utf8(username)))` without
 * padding, `key = Buffer.from(EGRESS_TOKEN_SECRET, 'hex')`. The MAC covers
 * the whole username, so the user a tunnel is metered against, the device it
 * is capped by, the credential id revocation keys on, and the expiry are all
 * authenticated: none of them can be swapped on a valid credential.
 *
 * Verification is a single seam, {@link TokenVerifier}, with two
 * implementations:
 *
 * * {@link SharedSecretVerifier} — the only one a deployment may serve
 *   traffic with. Constant-time MAC comparison.
 * * {@link DevVerifier} — shape check only, i.e. **no authentication at
 *   all**. Reachable only through the explicit `EGRESS_DEV_INSECURE=1` opt-in,
 *   which also forces a loopback bind (see `startup.ts`).
 *
 * A missing or unverifiable credential is a 407 with a Basic challenge; a
 * credential minted for another user on an owner-pinned gateway is a 403.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

// The username format is the contract control mints against, so it lives in
// `@pistachio/egress-policy` alongside the routing rules both sides share;
// only the MAC (which needs `node:crypto`) stays here.
import {
  CREDENTIAL_PREFIX,
  credentialUsername,
  isCredentialSecretHex,
  parseCredentialUsername,
  type ParsedCredential,
} from "@pistachio/egress-policy";

import { SECRET_BYTES } from "./config.js";

export { CREDENTIAL_PREFIX, credentialUsername, parseCredentialUsername, type ParsedCredential };

/** What the client presented, before any verification. */
export interface PresentedCredential {
  readonly username: string;
  readonly password: string;
}

/**
 * Parse a `Proxy-Authorization` value. `Basic` splits the decoded pair at the
 * first colon (a username never contains one); `Bearer` splits at the
 * **last** dot, because the username itself carries four.
 */
export function parseProxyAuthorization(header: string | undefined): PresentedCredential | null {
  if (header === undefined) return null;
  const trimmed = header.trim();
  const space = trimmed.search(/\s/);
  if (space <= 0) return null;
  const scheme = trimmed.slice(0, space).toLowerCase();
  const rest = trimmed.slice(space).trim();
  if (rest === "") return null;
  if (scheme === "basic") {
    if (!/^[A-Za-z0-9+/=_-]+$/.test(rest)) return null;
    const decoded = Buffer.from(rest, "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    if (colon <= 0) return null;
    return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
  }
  if (scheme === "bearer") {
    const dot = rest.lastIndexOf(".");
    if (dot <= 0 || dot === rest.length - 1) return null;
    return { username: rest.slice(0, dot), password: rest.slice(dot + 1) };
  }
  return null;
}

/** The one seam where credential trust is decided. */
export interface TokenVerifier {
  /** True when `password` is the MAC of `username` under this verifier's key. */
  verify(username: string, password: string): boolean;
}

/** `base64url(HMAC-SHA256(key, utf8(username)))` without padding (43 chars). */
export function credentialPassword(key: Buffer, username: string): string {
  return createHmac("sha256", key).update(username, "utf8").digest("base64url");
}

/** Decode the 64-lowercase-hex form used in configuration; null otherwise. */
export function parseSecretHex(secretHex: string): Buffer | null {
  const trimmed = secretHex.trim();
  if (!isCredentialSecretHex(trimmed)) return null;
  return Buffer.from(trimmed, "hex");
}

/**
 * MAC-checking verifier. Both halves of the scheme (sign and verify) live
 * here so they cannot drift apart; control mints with the same function.
 */
export class SharedSecretVerifier implements TokenVerifier {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== SECRET_BYTES) {
      throw new Error(`egress token secret must be exactly ${SECRET_BYTES} bytes`);
    }
    this.#key = Buffer.from(key);
  }

  static fromHex(secretHex: string): SharedSecretVerifier {
    const key = parseSecretHex(secretHex);
    if (key === null) {
      throw new Error(
        `egress token secret must be ${SECRET_BYTES} bytes of lowercase hex (${SECRET_BYTES * 2} characters)`,
      );
    }
    return new SharedSecretVerifier(key);
  }

  /** The issuing side of the MAC. */
  sign(username: string): string {
    return credentialPassword(this.#key, username);
  }

  verify(username: string, password: string): boolean {
    const expected = Buffer.from(this.sign(username), "utf8");
    const presented = Buffer.from(password, "utf8");
    if (expected.length !== presented.length) return false;
    return timingSafeEqual(expected, presented);
  }
}

/**
 * Development verifier: any non-empty password is accepted for a well-shaped
 * username. This is NOT authentication. It is unreachable without the
 * `EGRESS_DEV_INSECURE=1` opt-in that pins the listener to loopback.
 */
export class DevVerifier implements TokenVerifier {
  verify(_username: string, password: string): boolean {
    return password.length > 0;
  }
}

/** Revoked device and credential ids, fed by the control-plane feed. */
export class RevocationSet {
  readonly #devices = new Set<string>();
  readonly #credentials = new Set<string>();

  revokeDevice(deviceId: string): void {
    this.#devices.add(deviceId);
  }

  revokeCredential(credentialId: string): void {
    this.#credentials.add(credentialId);
  }

  isDeviceRevoked(deviceId: string): boolean {
    return this.#devices.has(deviceId);
  }

  isCredentialRevoked(credentialId: string): boolean {
    return this.#credentials.has(credentialId);
  }

  /** Drop credential ids the caller knows have expired (entries past exp may be dropped). */
  forgetCredential(credentialId: string): void {
    this.#credentials.delete(credentialId);
  }

  get size(): number {
    return this.#devices.size + this.#credentials.size;
  }
}

export type AuthFailure =
  | "missing"
  | "malformed"
  | "bad_signature"
  | "expired"
  | "device_revoked"
  | "credential_revoked"
  | "owner_mismatch";

export type AuthResult =
  | { readonly ok: true; readonly credential: ParsedCredential }
  | { readonly ok: false; readonly reason: AuthFailure };

/**
 * Status for a refused credential: 407 (present a different credential)
 * for everything except a credential minted for another user, which no
 * refresh can fix on an owner-pinned gateway (403).
 */
export function authFailureStatus(reason: AuthFailure): 403 | 407 {
  return reason === "owner_mismatch" ? 403 : 407;
}

export interface AuthenticatorOptions {
  readonly verifier: TokenVerifier;
  readonly revocations?: RevocationSet;
  /** `EGRESS_OWNER_USER_ID`: when set, every other user is refused. */
  readonly ownerUserId?: string | null;
  /** Milliseconds since the epoch. */
  readonly now?: () => number;
}

/** Parse → MAC → expiry → revocation → owner pin, in that order. */
export class Authenticator {
  readonly #verifier: TokenVerifier;
  readonly #revocations: RevocationSet;
  readonly #ownerUserId: string | null;
  readonly #now: () => number;

  constructor(options: AuthenticatorOptions) {
    this.#verifier = options.verifier;
    this.#revocations = options.revocations ?? new RevocationSet();
    this.#ownerUserId = options.ownerUserId ?? null;
    this.#now = options.now ?? Date.now;
  }

  get revocations(): RevocationSet {
    return this.#revocations;
  }

  authenticate(header: string | undefined): AuthResult {
    if (header === undefined) return { ok: false, reason: "missing" };
    const presented = parseProxyAuthorization(header);
    if (presented === null) return { ok: false, reason: "malformed" };
    const credential = parseCredentialUsername(presented.username);
    if (credential === null) return { ok: false, reason: "malformed" };
    if (!this.#verifier.verify(presented.username, presented.password)) {
      return { ok: false, reason: "bad_signature" };
    }
    const nowSeconds = Math.floor(this.#now() / 1000);
    if (credential.exp <= nowSeconds) return { ok: false, reason: "expired" };
    if (this.#revocations.isDeviceRevoked(credential.deviceId)) {
      return { ok: false, reason: "device_revoked" };
    }
    if (this.#revocations.isCredentialRevoked(credential.credentialId)) {
      return { ok: false, reason: "credential_revoked" };
    }
    if (this.#ownerUserId !== null && credential.userId !== this.#ownerUserId) {
      return { ok: false, reason: "owner_mismatch" };
    }
    return { ok: true, credential };
  }
}
