/**
 * The PIN that keeps a session alive after the tab is closed.
 *
 * "Stay unlocked on this browser" used to mean the derived Space keys sat in
 * IndexedDB as non-extractable handles, and anything that opened this origin
 * got them — no challenge at all. This module is the challenge: the reader
 * picks six digits, and what the browser keeps is the Space ROOT SECRETS
 * sealed under a key derived from those digits. Nothing usable is at rest
 * without them.
 *
 * WHAT THIS BUYS, AND WHAT IT DOES NOT. Six digits is a million
 * possibilities, which is not a lot. Someone who copies this browser profile
 * can grind the sealed blob offline, and `PIN_PBKDF2_ITERATIONS` is what
 * makes that expensive rather than what makes it impossible; the attempt
 * counter in `vault.ts` only binds an attacker going through this UI. So the
 * PIN is a real lock against the person who picks up your laptop, and a
 * speed bump against someone who walks off with the disk — which is why it
 * expires (`REMEMBER_DAYS`), why five wrong answers destroy the record, and
 * why the account password is still the only thing that opens the account
 * itself. It is strictly more than the nothing that was here before.
 *
 * WHAT IS SEALED. The root secrets, not the derived keys: `deriveSpaceKeys`
 * turns a secret back into the same non-extractable `sealKey`/`idKey` pair a
 * password unlock produces, so what lands in memory after a correct PIN is
 * exactly what lands there after a correct password — including the root
 * secrets themselves, which is what lets a PIN-unlocked tab wrap a Space for
 * the cloud browser without a second password ceremony.
 */

import {
  RECOVERY_CODE_PBKDF2_ITERATIONS,
  deriveKekFromPassphrase,
  deriveSpaceKeys,
  unwrapRootSecret,
  wrapRootSecret,
  type SpaceKeys,
} from "@pistachio/sync-protocol";

/** Six digits, because that is what the keypad asks for. */
export const PIN_LENGTH = 6;

/**
 * The same stretch the account password and the recovery code get. One
 * derivation opens every Space — the KEK is per record, not per Space — so
 * this is about a second of work once, on unlock, and about a second per
 * guess for anyone grinding the record offline.
 */
export const PIN_PBKDF2_ITERATIONS = RECOVERY_CODE_PBKDF2_ITERATIONS;

/**
 * Wrong answers before the record is destroyed and the password is the only
 * way back in. Low, because the PIN is low-entropy and a person who knows
 * theirs does not need six tries; the count survives a reload because it
 * lives in the record it protects.
 */
export const MAX_PIN_ATTEMPTS = 5;

const DIGITS = /^[0-9]+$/u;

/** True when `value` is exactly what the keypad can produce. */
export function isCompletePin(value: string): boolean {
  return value.length === PIN_LENGTH && DIGITS.test(value);
}

/** Keep only digits, and never more than the keypad holds. */
export function sanitizePinInput(value: string): string {
  return value.replace(/[^0-9]/gu, "").slice(0, PIN_LENGTH);
}

/**
 * What one sealed vault holds. `salt` and `iterations` travel WITH the
 * ciphertext rather than being constants read at unlock time: a later release
 * that raises the stretch must still be able to open a record sealed by this
 * one, and a record that carried only ciphertext could not say how.
 */
export interface SealedSecrets {
  salt: Uint8Array;
  iterations: number;
  /** Space id (and `__workspace__`) to its root secret, sealed under the PIN. */
  wrapped: Map<string, Uint8Array>;
}

/**
 * Seal every root secret this tab holds under a fresh salt.
 *
 * One KEK for the whole record. Deriving per Space would multiply the second
 * of PBKDF2 by the number of Spaces on every unlock while adding nothing: the
 * PIN is the same secret either way, and `wrapRootSecret` already binds each
 * ciphertext to its own Space id as additional data, so a blob lifted from
 * one Space cannot be opened as another.
 */
export async function sealRootSecrets(
  pin: string,
  rootSecrets: ReadonlyMap<string, Uint8Array>,
): Promise<SealedSecrets> {
  if (!isCompletePin(pin)) throw new Error(`A PIN is ${String(PIN_LENGTH)} digits.`);
  if (rootSecrets.size === 0) {
    throw new Error("This browser has no keys to seal. Unlock with your password first.");
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const kek = await deriveKekFromPassphrase(pin, salt, PIN_PBKDF2_ITERATIONS);
  const wrapped = new Map<string, Uint8Array>();
  for (const [spaceId, secret] of rootSecrets) {
    wrapped.set(spaceId, await wrapRootSecret(kek, secret, spaceId));
  }
  return { salt, iterations: PIN_PBKDF2_ITERATIONS, wrapped };
}

/**
 * What a PIN turned out to be worth.
 *
 * `damaged` is deliberately not `wrong`: the PIN opened something, so it was
 * right, and burning an attempt for a record this browser corrupted would
 * punish the reader for a storage fault. The caller drops the record and asks
 * for the password instead.
 */
export type Opened =
  | { kind: "secrets"; secrets: Map<string, Uint8Array> }
  | { kind: "wrong" }
  | { kind: "damaged" };

/**
 * Open the sealed secrets, or say why not.
 *
 * AES-GCM authenticates, so a wrong PIN cannot produce plausible-looking
 * bytes — every entry simply fails to open. That is the test: NOTHING opened
 * means the PIN was wrong, and something opening means it was right, whatever
 * happened to the rest.
 */
export async function openRootSecrets(pin: string, sealed: SealedSecrets): Promise<Opened> {
  if (!isCompletePin(pin)) return { kind: "wrong" };
  const kek = await deriveKekFromPassphrase(pin, sealed.salt, sealed.iterations);
  const secrets = new Map<string, Uint8Array>();
  let failed = 0;
  for (const [spaceId, blob] of sealed.wrapped) {
    try {
      secrets.set(spaceId, await unwrapRootSecret(kek, blob, spaceId));
    } catch {
      failed += 1;
    }
  }
  if (secrets.size === 0) return { kind: "wrong" };
  if (failed > 0) return { kind: "damaged" };
  return { kind: "secrets", secrets };
}

/** Root secrets back to the non-extractable handles the app reads records with. */
export async function spaceKeysFrom(
  secrets: ReadonlyMap<string, Uint8Array>,
): Promise<Map<string, SpaceKeys>> {
  const keys = new Map<string, SpaceKeys>();
  for (const [spaceId, secret] of secrets) {
    keys.set(spaceId, await deriveSpaceKeys(spaceId, secret));
  }
  return keys;
}
