/**
 * Staying unlocked on this browser.
 *
 * By default the Space keys live in one tab's memory and a reload forgets
 * them, which is why Pistachio asks for the password again (see `keys.ts`).
 * A reader who does not want to be asked every time can trade that away, and
 * this module is the trade: the Space ROOT SECRETS are kept in this browser's
 * IndexedDB, sealed under a six-digit PIN, until they expire, are signed out,
 * are forgotten by hand, or the PIN is got wrong too many times.
 *
 * WHAT IS AND IS NOT WRITTEN DOWN. The password is not stored, and neither is
 * the PIN — only a salt and ciphertext that the PIN can open (`pin.ts` says
 * what that is worth). Nothing here is usable at rest: an earlier version of
 * this file kept non-extractable `CryptoKey` handles instead, which could not
 * be read out but could be USED by anything that opened this origin, with no
 * challenge whatsoever. Ciphertext plus a challenge is the better trade, and
 * it is what makes the reader's own root secrets available again after the
 * PIN — which a handle-only vault could never do, and which is what the cloud
 * browser needs to be turned on without a fresh password ceremony.
 *
 * WHAT IT CANNOT DO IS GO STALE QUIETLY. Kept secrets open the Spaces that
 * existed when they were sealed, and a Mac can add one afterwards. So the
 * record carries the Space list it was built against, `recallKeys` compares it
 * to the live one, and anything it could not open that it was not already told
 * it could not open makes the record STALE — good secrets, but no longer the
 * whole account, which is a password prompt rather than a silent gap.
 *
 * WHAT IT STILL COSTS. Anyone who can use this browser profile AND knows the
 * PIN can read this account's data without the password, and script that gets
 * to run on this origin can use the keys for as long as a tab holds them. That
 * is the trade, it is off unless asked for, and Devices revokes the browser
 * outright when it stops being true that this profile is yours alone.
 */

import { WORKSPACE_PSEUDO_SPACE_ID } from "@pistachio/sync-protocol";
import { KEYS_STORE, withStore } from "./idb";
import type { UnlockedKeys } from "./keys";
import {
  MAX_PIN_ATTEMPTS,
  openRootSecrets,
  sealRootSecrets,
  spaceKeysFrom,
  type SealedSecrets,
} from "./pin";

const RECORD_KEY = "unlocked";

/**
 * The shape this file writes. Bumped from the handle-keeping record that came
 * before it, which is unreadable here and is deleted on sight rather than
 * migrated: those handles were never sealed under anything, so there is no
 * honest way to bring them across into a record that promises they are.
 */
const RECORD_VERSION = 3;

/**
 * Kept keys expire on their own. Long enough that the option is worth having,
 * short enough that a browser left behind stops being a way in.
 */
export const REMEMBER_DAYS = 30;

interface StoredKeys extends SealedSecrets {
  version: number;
  /** Both are checked on the way out: keys are useless to another account. */
  userId: string;
  deviceId: string;
  expiresAt: number;
  /** Spaces the unlock was told about but could not open. */
  unopened: string[];
  provisioned: boolean;
  /** Wrong PINs since the last right one. At `MAX_PIN_ATTEMPTS` the record dies. */
  failed: number;
}

/**
 * What this browser has to offer at boot.
 *
 * `pin` means there is a sealed vault here and it is this account's: the keys
 * exist but nothing can be handed over until the reader proves the PIN.
 *
 * `stale` is the interesting one: the record is this account's and still
 * fresh, but the account has grown a Space it cannot open. Asking for the PIN
 * would enter the app with a Space silently unreadable and no way to fix it,
 * so the password is asked for instead — and the record is kept, because the
 * next unlock will overwrite it anyway and a failed boot should not cost
 * anyone the option they turned on.
 */
export type Recall =
  | { kind: "none" }
  | { kind: "stale"; missing: string[] }
  | { kind: "pin"; attemptsLeft: number };

/** What a PIN was worth. `attemptsLeft: 0` means the record is now gone. */
export type Unseal =
  | { kind: "keys"; keys: UnlockedKeys }
  | { kind: "wrong"; attemptsLeft: number }
  | { kind: "gone" };

async function read(): Promise<StoredKeys | undefined> {
  return withStore<StoredKeys | undefined>(KEYS_STORE, "readonly", (store) => store.get(RECORD_KEY));
}

async function write(record: StoredKeys): Promise<void> {
  await withStore(KEYS_STORE, "readwrite", (store) => store.put(record, RECORD_KEY));
}

/** A record this build cannot open, or that has run out of time or tries. */
function unusable(record: StoredKeys | undefined, userId: string, deviceId: string): boolean {
  return (
    record === undefined ||
    record.version !== RECORD_VERSION ||
    record.userId !== userId ||
    record.deviceId !== deviceId ||
    record.expiresAt <= Date.now() ||
    record.failed >= MAX_PIN_ATTEMPTS
  );
}

/**
 * Keep this session on this browser, sealed under `pin`. Replaces anything
 * already kept, and resets the attempt count with it: a reader who just
 * proved their password is not carrying anyone else's wrong guesses.
 */
export async function rememberKeys(
  userId: string,
  deviceId: string,
  keys: UnlockedKeys,
  pin: string,
): Promise<void> {
  const sealed = await sealRootSecrets(pin, keys.rootSecrets);
  await write({
    version: RECORD_VERSION,
    userId,
    deviceId,
    expiresAt: Date.now() + REMEMBER_DAYS * 24 * 60 * 60 * 1000,
    salt: sealed.salt,
    iterations: sealed.iterations,
    wrapped: sealed.wrapped,
    unopened: keys.unopened,
    provisioned: keys.provisioned,
    failed: 0,
  });
}

/**
 * Spaces the live account has that this record cannot open, EXCLUDING the ones
 * the unlock already knew it could not open. Without that exclusion an account
 * with a permanently unopenable Space would be called stale on every boot,
 * which is a password prompt every time and the option made worthless.
 */
function missingFrom(record: StoredKeys, spaceIds: string[]): string[] {
  return spaceIds.filter((id) => !record.wrapped.has(id) && !record.unopened.includes(id));
}

/**
 * Whether this browser is holding a sealed session for whoever is asking,
 * checked against the account as it stands now.
 *
 * A record belonging to someone else, past its expiry, out of attempts, or
 * written by a build that sealed things differently is deleted rather than
 * reported: it can never be used again, so it has no reason to survive the
 * read.
 *
 * `spaceIds` is the live list from the control plane, which is what makes this
 * a reconciliation rather than a lookup.
 */
export async function recallKeys(userId: string, deviceId: string, spaceIds: string[]): Promise<Recall> {
  let stored: StoredKeys | undefined;
  try {
    stored = await read();
  } catch {
    return { kind: "none" }; // private windows and blocked storage: ask for the password.
  }
  if (stored === undefined) return { kind: "none" };

  if (unusable(stored, userId, deviceId)) {
    // Unusable for good. A delete that fails here is not worth failing the
    // boot over — the guard above already refuses to hand this record out.
    await forgetKeys().catch(() => undefined);
    return { kind: "none" };
  }

  const missing = missingFrom(stored, spaceIds);
  if (missing.length > 0) return { kind: "stale", missing };

  return { kind: "pin", attemptsLeft: MAX_PIN_ATTEMPTS - stored.failed };
}

/**
 * Spend one attempt at the PIN.
 *
 * The count is written BEFORE the answer is known to be right, and cleared
 * afterwards, so a tab killed mid-unlock costs an attempt rather than granting
 * a free one — the cheap direction to be wrong in. At the last attempt the
 * record is destroyed rather than left at zero: a vault nobody can open is
 * only a way to keep sealed data lying around.
 */
export async function unsealKeys(userId: string, deviceId: string, pin: string): Promise<Unseal> {
  let stored: StoredKeys | undefined;
  try {
    stored = await read();
  } catch {
    return { kind: "gone" };
  }
  if (unusable(stored, userId, deviceId)) {
    await forgetKeys().catch(() => undefined);
    return { kind: "gone" };
  }
  const record = stored as StoredKeys;

  await write({ ...record, failed: record.failed + 1 }).catch(() => undefined);

  const opened = await openRootSecrets(pin, record);
  if (opened.kind === "damaged") {
    // The PIN was right and the record is not. Nothing here can be trusted to
    // be the whole account, so it goes, and the password is the way back.
    await forgetKeys().catch(() => undefined);
    return { kind: "gone" };
  }
  if (opened.kind === "wrong") {
    const attemptsLeft = MAX_PIN_ATTEMPTS - (record.failed + 1);
    if (attemptsLeft <= 0) {
      await forgetKeys().catch(() => undefined);
      return { kind: "wrong", attemptsLeft: 0 };
    }
    return { kind: "wrong", attemptsLeft };
  }

  await write({ ...record, failed: 0 }).catch(() => undefined);
  const spaces = await spaceKeysFrom(opened.secrets);
  return {
    kind: "keys",
    keys: {
      spaces,
      workspace: spaces.get(WORKSPACE_PSEUDO_SPACE_ID) ?? null,
      // The real thing, unlike the handle-only vault this replaced: a PIN
      // unlock recovers exactly what a password unlock does, which is what
      // lets this tab wrap a Space for the cloud browser.
      rootSecrets: opened.secrets,
      unopened: record.unopened,
      provisioned: record.provisioned,
    },
  };
}

/**
 * Drop the kept keys. THIS THROWS RATHER THAN SWALLOWING: a caller turning
 * the option off, or signing out, is making a promise to the reader that the
 * keys are gone, and it can only keep that promise if a failure to delete
 * reaches it. `withStore` settles on the transaction, so a resolved call
 * means the delete committed.
 */
export async function forgetKeys(): Promise<void> {
  await withStore(KEYS_STORE, "readwrite", (store) => store.delete(RECORD_KEY));
}
