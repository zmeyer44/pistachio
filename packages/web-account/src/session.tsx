"use client";

/**
 * The signed-in session.
 *
 * Four states, and the difference between two of them is the point:
 *
 *   signed-out    no device identity in this browser
 *   locked        enrolled and authenticated, but no space keys in memory
 *   unprovisioned enrolled, but this account has no keys yet at all
 *   ready         keys unwrapped; records and runs are readable
 *   loading       deciding which of the above
 *
 * A device token proves who you are to the control plane. It does not decrypt
 * anything. The keys that do are derived from your password and, by default,
 * held only in this tab's memory, so a reload lands in `locked` and asks for
 * the password again. That is what lets the server hold this data without
 * being able to read it.
 *
 * A reader can trade that reload away — "stay unlocked on this browser" seals
 * this session's root secrets in the browser's vault under a six-digit PIN,
 * and boot then lands in `pin`: six digits instead of a password, and no
 * network round trip to check them. `vault.ts` and `pin.ts` say exactly what
 * that costs. The server's position is unchanged either way: it still never
 * sees a key.
 *
 * The PIN is asked for AFTER the password, never beside it: `set-pin` is a
 * session that is already open and is choosing what to be sealed under. Doing
 * it in that order means nobody picks six digits for a password that turns out
 * to be wrong, and it is the reason both PIN screens are the same screen — one
 * choosing, one answering.
 *
 * `unlocking` is the beat before the app: the keys are open and deliberately
 * NOT handed over yet, so the screen that took the PIN can play itself out
 * before the desktop replaces it. `finishPinUnlock` is the caller saying it is
 * done.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { SpaceKeys } from "@pistachio/sync-protocol";
import {
  ControlError,
  errorDetailOf,
  claimIMessageOnboarding,
  deviceChallenge,
  deviceLogin,
  enrollDevice,
  listSpaces,
  me,
  passwordLogin,
  signUp,
  type ControlMe,
  type ControlSpace,
} from "./control";
import {
  deviceLabel,
  createIdentity,
  forgetIdentity,
  loadIdentity,
  publicKeys,
  saveIdentity,
  signChallenge,
  type DeviceIdentity,
  type WebDeviceName,
} from "./device";
import { enableCloudForSpace, openedNothing, provisionKeys, unlock, type UnlockedKeys } from "./keys";
import { DeviceTokenSession } from "./token";
import { forgetKeys, recallKeys, rememberKeys, unsealKeys } from "./vault";
import { MAX_PIN_ATTEMPTS } from "./pin";
import { emptyView, subscribeWorkspace, type WorkspaceFeed, type WorkspaceView } from "./records";

export type SessionState =
  | "loading"
  | "signed-out"
  | "locked"
  /** A sealed vault is here; six digits open it. */
  | "pin"
  /** Signed in, keys open, choosing the PIN they are about to be sealed under. */
  | "set-pin"
  /** The PIN was right. The keys are held back until `finishPinUnlock`. */
  | "unlocking"
  | "unprovisioned"
  | "ready";

export interface Session {
  state: SessionState;
  error: string | null;
  /** The wire-level reason behind `error`, for a diagnostics disclosure. */
  errorDetail: string | null;
  busy: boolean;
  account: ControlMe | null;
  identity: DeviceIdentity | null;
  token: string | null;
  spaces: ControlSpace[];
  keys: UnlockedKeys | null;
  workspace: WorkspaceView;
  hubState: "connecting" | "connected" | "offline" | "off" | null;
  /** Whether this browser is keeping the keys, so a reload asks for a PIN instead. */
  remembered: boolean;
  /**
   * Tries left before the sealed vault is destroyed, while the PIN screen is
   * up. Null when no vault is being asked about.
   */
  pinAttemptsLeft: number | null;
  /**
   * The last thing the vault could not do, if it is still true. Kept apart
   * from `error` on purpose: `error` is why you could not get in, and this is
   * a promise about stored keys that was not kept while you were already in.
   */
  vaultError: string | null;
  /**
   * `keep` is the reader asking to stay unlocked. It does not carry a PIN,
   * because the PIN is chosen afterwards: a session that keeps itself lands in
   * `set-pin` rather than `ready`.
   */
  signIn(
    email: string,
    password: string,
    mode: "sign-in" | "sign-up",
    keep?: boolean,
    imessageOnboardingToken?: string,
  ): Promise<boolean>;
  /**
   * `setUpEncryption` is the reader saying, from the screen that says so, that
   * this account has no keys yet and this browser should create them. Without
   * it an account with no wrapper only ever lands back on that screen: nothing
   * has checked the password, and sealing fresh root secrets under a typo
   * cannot be undone.
   */
  unlockWith(password: string, keep?: boolean, options?: { setUpEncryption?: boolean }): Promise<void>;
  /**
   * The digits chosen on the `set-pin` screen. The session is already open, so
   * this enters the app whatever the vault does with them: sealing is the
   * convenience, and a storage fault reports itself in `vaultError` rather
   * than standing between the reader and the account they just unlocked.
   */
  setSessionPin(pin: string): void;
  /**
   * Spend one try at the sealed vault. True means the keys are open and the
   * session is in `unlocking`, waiting for `finishPinUnlock`; false leaves the
   * screen up with `pinAttemptsLeft` decremented, or drops to `locked` when
   * the last try is spent and the record is destroyed.
   */
  unlockWithPin(pin: string): Promise<boolean>;
  /** Hand over the keys a right PIN opened, and enter the app. */
  finishPinUnlock(): void;
  /** Give up on the PIN: forget the vault and ask for the password instead. */
  forgetPin(): Promise<void>;
  /**
   * The current device token, re-minted first if it is about to expire. What
   * a stream (SSE, the hub socket) must dial with: `token` is a snapshot and
   * goes stale ten minutes after it was minted.
   */
  getToken(): Promise<string | null>;
  /** Hand a Space's in-memory key to the account's hosted cloud browser. */
  enableCloud(spaceId: string): Promise<void>;
  /**
   * Start or stop keeping them, from a session that is already unlocked.
   * Turning it on needs the PIN to seal with, and root secrets to seal — a
   * session that has neither has to unlock with its password first.
   */
  setRemembered(on: boolean, pin?: string): Promise<void>;
  /** Ask for the password again without signing out. */
  relock(options?: { preserveRemembered?: boolean; enableCloudAfterUnlock?: boolean }): Promise<void>;
  signOut(): Promise<void>;
  keysFor(spaceId: string): SpaceKeys | null;
  /** Re-read the account's Spaces — after one is renamed, or created. */
  refreshSpaces(): Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (session === null) throw new Error("useSession outside the app shell");
  return session;
}

interface Failure {
  message: string;
  /** The wire-level reason, for a diagnostics disclosure. */
  detail: string | null;
}

/** The sentence the reader sees, with the diagnostics line behind it. */
function failureOf(message: string, cause?: unknown): Failure {
  return { message, detail: errorDetailOf(cause) };
}

/** A ControlError's message is already the plain sentence for its code. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

/** Trade the stored identity for a fresh device token. */
async function tokenFor(identity: DeviceIdentity): Promise<string> {
  const { challenge } = await deviceChallenge(identity.deviceId);
  const signature = await signChallenge(identity, challenge);
  const { token } = await deviceLogin(identity.deviceId, challenge, signature);
  return token;
}

export function SessionProvider({
  children,
  autoRestore = true,
  deviceName,
}: {
  children: ReactNode;
  autoRestore?: boolean;
  /**
   * Which site is enrolling. The dashboard is "Web" and the browser app is
   * "Browser"; each origin holds its own device keys, so an account signed in
   * to both has two devices and the Devices page says which is which
   * (docs/web-browser-design.md §15).
   */
  deviceName: WebDeviceName;
}): ReactNode {
  const [state, setState] = useState<SessionState>("loading");
  // One value, so the sentence and its diagnostics line can never disagree.
  const [failure, setFailure] = useState<Failure | null>(null);
  const error = failure?.message ?? null;
  const errorDetail = failure?.detail ?? null;
  const [busy, setBusy] = useState(false);
  const [identity, setIdentity] = useState<DeviceIdentity | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [account, setAccount] = useState<ControlMe | null>(null);
  const [spaces, setSpaces] = useState<ControlSpace[]>([]);
  const [keys, setKeys] = useState<UnlockedKeys | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceView>(emptyView);
  const [hubState, setHubState] = useState<Session["hubState"]>(null);
  const [remembered, setRememberedState] = useState(false);
  const [pinAttemptsLeft, setPinAttemptsLeft] = useState<number | null>(null);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const feed = useRef<WorkspaceFeed | null>(null);
  const enableCloudAfterUnlock = useRef(false);
  /**
   * Keys a right PIN opened, held back on purpose. Handing them to `keys`
   * immediately would swap the desktop in under the screen that is still
   * playing the unlock, so they wait here for `finishPinUnlock`. A ref, not
   * state: nothing renders from them until they move.
   */
  const pending = useRef<UnlockedKeys | null>(null);
  /**
   * The seal in flight, if one is. Held as a PROMISE rather than as its result
   * so there is no window to miss: `finishPinUnlock` chains onto it, which
   * lands after the animation whether the vault beat it or not.
   */
  const sealing = useRef<Promise<boolean> | null>(null);
  // The token, and what keeps it alive. Held in a ref because it outlives
  // every render that reads it: a re-mint replaces the string in `token`
  // without disturbing the hub socket or a run stream, which ask for the
  // current one when they dial.
  const tokens = useRef<DeviceTokenSession | null>(null);

  /** Take a freshly minted token and keep it fresh for as long as it is held. */
  const adoptToken = useCallback((minted: string, who: DeviceIdentity): void => {
    tokens.current?.close();
    tokens.current = new DeviceTokenSession({
      token: minted,
      proof: () => tokenFor(who),
      onToken: setToken,
    });
    setToken(minted);
  }, []);

  const dropToken = useCallback((): void => {
    tokens.current?.close();
    tokens.current = null;
    setToken(null);
  }, []);

  const getToken = useCallback(
    (): Promise<string | null> => tokens.current?.get() ?? Promise.resolve(null),
    [],
  );

  // A tab that is closed mid-session must not leave a refresh timer behind.
  useEffect(() => () => {
    tokens.current?.close();
    tokens.current = null;
  }, []);

  // A device already enrolled here needs only a token; its keys come later.
  useEffect(() => {
    if (!autoRestore) {
      setState("signed-out");
      return;
    }

    let cancelled = false;
    void (async () => {
      const stored = await loadIdentity();
      if (cancelled) return;
      if (stored === null) {
        setState("signed-out");
        return;
      }
      try {
        const fresh = await tokenFor(stored);
        if (cancelled) return;
        setIdentity(stored);
        adoptToken(fresh, stored);
        setAccount(await me(fresh));
        const live = (await listSpaces(fresh)).spaces;
        setSpaces(live);
        // A vault this browser was asked to keep means a PIN rather than a
        // password — but only if it still covers the account as it stands now.
        const kept = await recallKeys(
          stored.userId,
          stored.deviceId,
          live.map((space) => space.id),
        );
        if (cancelled) return;
        if (kept.kind === "stale") {
          // The record survives: the reader asked to stay unlocked, and one
          // new Space is a reason to ask for the password, not to revoke that.
          setRememberedState(true);
          setFailure(
            failureOf(
              kept.missing.length === 1
                ? "A new Space was added on another device. Unlock once to open it."
                : `${String(kept.missing.length)} new Spaces were added on another device. Unlock once to open them.`,
            ),
          );
          setState("locked");
          return;
        }
        if (kept.kind === "none") {
          setState("locked");
          return;
        }
        setRememberedState(true);
        setPinAttemptsLeft(kept.attemptsLeft);
        setState("pin");
      } catch (cause) {
        if (cancelled) return;
        // Revoked from another device, or the account is gone: start over.
        if (cause instanceof ControlError && [401, 403, 404].includes(cause.status)) {
          // A device that lost its token must not leave usable keys behind,
          // but a failed vault deletion must not strand the shell in Loading.
          const [, forgottenKeys] = await Promise.allSettled([forgetIdentity(), forgetKeys()]);
          if (cancelled) return;
          setIdentity(null);
          dropToken();
          setAccount(null);
          setSpaces([]);
          setKeys(null);
          setWorkspace(emptyView());
          setHubState(null);
          setRememberedState(false);
          setPinAttemptsLeft(null);
          setVaultError(
            forgottenKeys.status === "rejected"
              ? "This browser was signed out, but it could not delete the keys it had stored. Clear this site's data to remove them."
              : null,
          );
          setState("signed-out");
          setFailure(failureOf("This browser was signed out. Sign in again."));
          return;
        }
        setState("signed-out");
        setFailure(failureOf(messageOf(cause), cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [autoRestore, adoptToken, dropToken]);

  // Hold the hub socket open only while there is a key to read docs with.
  useEffect(() => {
    feed.current?.close();
    feed.current = null;
    const hubUrl = account?.hubUrl ?? null;
    const workspaceKeys = keys?.workspace ?? null;
    if (state !== "ready" || hubUrl === null || workspaceKeys === null || identity === null) return;
    feed.current = subscribeWorkspace({
      hubUrl,
      deviceId: identity.deviceId,
      // Not the token as it stands now: this socket outlives it, and a redial
      // an hour from now must carry whatever the session holds by then.
      getToken,
      spaceIds: spaces.map((space) => space.id),
      workspaceKeys,
      onView: setWorkspace,
      onState: setHubState,
    });
    return () => {
      feed.current?.close();
      feed.current = null;
    };
  }, [state, account?.hubUrl, keys, identity, getToken, spaces]);

  const finishUnlock = useCallback(
    async (
      bearer: string,
      who: DeviceIdentity,
      password: string,
      /** The reader asked to stay unlocked; the PIN comes next, not here. */
      keep: boolean,
      options: {
        autoEnableCloud?: boolean;
        /** The reader asked for the account's keys to be created here. */
        provision?: boolean;
        /** Control has already checked this password (a sign-in did). */
        passwordVerified?: boolean;
      } = {},
    ): Promise<void> => {
      let liveSpaces = (await listSpaces(bearer)).spaces;
      let opened = await unlock(bearer, password);
      let createdHere = false;
      // A browser can be the first device now. It creates the root secrets
      // locally and commits the complete password-wrapper set atomically.
      if (!opened.provisioned) {
        if (options.provision !== true) {
          // An account with no wrapper cannot tell a right password from a
          // wrong one, so the Unlock screen must never seal root secrets
          // under whatever was typed there — a typo would become the key
          // password for good. Ask for it on the screen that says so.
          setFailure(failureOf("This account has no keys yet. Set up encryption to create them."));
          setState("unprovisioned");
          return;
        }
        if (options.passwordVerified !== true) {
          // Control holds the account password, and before the first wrapper
          // exists it is the only thing that can say whether this is it.
          // Throws 403 `invalid_credentials` when it is not.
          const { email } = await me(bearer);
          await passwordLogin(email, password);
        }
        try {
          opened = await provisionKeys(bearer, password, liveSpaces);
          createdHere = true;
        } catch (cause) {
          // Another first device may have won the provisioning race. Re-open
          // its complete set rather than replacing any secret.
          if (!(cause instanceof ControlError && cause.status === 409 && cause.code === "already_provisioned")) {
            throw cause;
          }
          opened = await unlock(bearer, password);
        }
      }
      if (openedNothing(opened)) throw new Error("That password did not open this account's keys.");

      const firstSpace = liveSpaces[0];
      if ((createdHere || options.autoEnableCloud === true) && firstSpace !== undefined && !firstSpace.cloudEnabled) {
        try {
          await enableCloudForSpace(bearer, who, opened, firstSpace.id);
          liveSpaces = (await listSpaces(bearer)).spaces;
        } catch (cause) {
          // A runner outage must not lock someone out of the account they just
          // created. The Agent screen can retry with these in-memory roots.
          setFailure(failureOf(`Your account is ready, but cloud setup needs another try. ${messageOf(cause)}`, cause));
        }
      }
      setSpaces(liveSpaces);

      // The password was right, so the reader is in. What is left is what this
      // browser keeps, and that is where the two paths part: a session that
      // keeps itself has a PIN to choose first, and one that does not has an
      // old record to be rid of.
      if (keep) {
        pending.current = opened;
        setState("set-pin");
        return;
      }
      try {
        await forgetKeys();
        setVaultError(null);
      } catch {
        setVaultError(
          "This browser could not clear the keys it had stored. Clear this site's data to be sure they are gone.",
        );
      }
      setRememberedState(false);
      setPinAttemptsLeft(null);
      setKeys(opened);
      setState("ready");
    },
    [],
  );

  const signIn = useCallback(
    async (
      email: string,
      password: string,
      mode: "sign-in" | "sign-up",
      keep = false,
      imessageOnboardingToken?: string,
    ): Promise<boolean> => {
      setBusy(true);
      setFailure(null);
      enableCloudAfterUnlock.current = false;
      try {
        const { userId, bootstrapToken } = await (mode === "sign-up"
          ? signUp(email, password)
          : passwordLogin(email, password));

        // Enrol this browser as a device of its own, then work as that device.
        const fresh = await createIdentity(userId);
        const { challenge } = await deviceChallenge(fresh.deviceId);
        const signature = await signChallenge(fresh, challenge);
        const { devicePublicKey, agreementPublicKey } = await publicKeys(fresh);
        const enrolled = await enrollDevice(bootstrapToken, {
          deviceId: fresh.deviceId,
          name: deviceLabel(deviceName),
          platform: "web",
          devicePublicKey,
          agreementPublicKey,
          challenge,
          signature,
        });
        await saveIdentity(fresh);
        setIdentity(fresh);
        adoptToken(enrolled.token, fresh);
        setAccount(await me(enrolled.token));
        setSpaces((await listSpaces(enrolled.token)).spaces);
        await finishUnlock(enrolled.token, fresh, password, keep, {
          // Signing into the browser is also a request to open its cloud
          // session, including accounts first created on desktop.
          autoEnableCloud: deviceName === "Browser" || mode === "sign-up" || imessageOnboardingToken !== undefined,
          // Control checked this password a moment ago, on the way to the
          // bootstrap token this enrollment used, so a first device may
          // create the account's keys here without asking again.
          provision: true,
          passwordVerified: true,
        });
        // Linking a number consumes every outstanding invitation sent to it.
        // Do that only after this browser has successfully opened or created
        // the account keys, so a transient unlock failure leaves the secure
        // onboarding link available for a clean retry.
        if (imessageOnboardingToken !== undefined) {
          await claimIMessageOnboarding(enrolled.token, imessageOnboardingToken);
        }
        return true;
      } catch (cause) {
        setFailure(failureOf(messageOf(cause), cause));
        setState((current) => (current === "ready" ? current : "signed-out"));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [finishUnlock, adoptToken, deviceName],
  );

  const enableCloudSpace = useCallback(
    async (spaceId: string): Promise<void> => {
      if (token === null || identity === null || keys === null) {
        throw new Error("Unlock this browser before turning on the cloud browser.");
      }
      setBusy(true);
      try {
        await enableCloudForSpace(token, identity, keys, spaceId);
        setSpaces((await listSpaces(token)).spaces);
      } finally {
        setBusy(false);
      }
    },
    [token, identity, keys],
  );

  const unlockWith = useCallback(
    async (password: string, keep = false, options?: { setUpEncryption?: boolean }): Promise<void> => {
      if (token === null || identity === null) return;
      setBusy(true);
      setFailure(null);
      try {
        await finishUnlock(token, identity, password, keep, {
          autoEnableCloud: enableCloudAfterUnlock.current,
          provision: options?.setUpEncryption === true,
        });
        enableCloudAfterUnlock.current = false;
      } catch (cause) {
        setFailure(failureOf(messageOf(cause), cause));
      } finally {
        setBusy(false);
      }
    },
    [token, identity, finishUnlock],
  );

  /**
   * Spend one try at the sealed vault.
   *
   * No network: the answer is whether AES-GCM opens what is on this disk, so
   * this works on a plane and cannot be rate-limited from outside. What stands
   * in for that is the attempt count `unsealKeys` keeps inside the record.
   */
  const unlockWithPin = useCallback(
    async (pin: string): Promise<boolean> => {
      if (identity === null) return false;
      setBusy(true);
      setFailure(null);
      try {
        const opened = await unsealKeys(identity.userId, identity.deviceId, pin);
        if (opened.kind === "keys") {
          pending.current = opened.keys;
          setPinAttemptsLeft(MAX_PIN_ATTEMPTS);
          setState("unlocking");
          return true;
        }
        if (opened.kind === "gone") {
          setRememberedState(false);
          setPinAttemptsLeft(null);
          setFailure(failureOf("This browser is no longer holding your keys. Unlock with your password."));
          setState("locked");
          return false;
        }
        setPinAttemptsLeft(opened.attemptsLeft);
        if (opened.attemptsLeft <= 0) {
          setRememberedState(false);
          setPinAttemptsLeft(null);
          setFailure(
            failureOf("That was the last try, so this browser has forgotten your keys. Unlock with your password."),
          );
          setState("locked");
        }
        return false;
      } catch (cause) {
        setFailure(failureOf(messageOf(cause), cause));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [identity],
  );

  /** What a finished seal means for the session, applied once nothing is moving. */
  const applySeal = useCallback((kept: boolean): void => {
    setRememberedState(kept);
    setPinAttemptsLeft(kept ? MAX_PIN_ATTEMPTS : null);
    setVaultError(
      kept
        ? null
        : "This browser could not store your keys, so it will ask for your password again next time rather than your PIN.",
    );
  }, []);

  /**
   * Take the digits chosen on the `set-pin` screen and seal this session under
   * them.
   *
   * The seal is NOT awaited before the unlock plays. The keys have been open
   * since the password landed, so nothing the reader is waiting for depends on
   * it; what the second of PBKDF2 would otherwise buy is a dead beat on a full
   * keypad, and running it under the animation costs nothing. Whatever it
   * settles on lands in `remembered` and `vaultError` when it gets there.
   */
  const setSessionPin = useCallback(
    (pin: string): void => {
      const opened = pending.current;
      if (identity === null || opened === null) return;
      setState("unlocking");
      // Started, and deliberately NOT awaited or reported yet. Landing three
      // state updates in the middle of the unlock re-renders the keypad while
      // it is being animated, and a reconcile of six moving inputs is exactly
      // the kind of hitch the rest of this was tuned to avoid. What it settles
      // on is applied by `finishPinUnlock`, after the last frame.
      sealing.current = rememberKeys(identity.userId, identity.deviceId, opened, pin).then(
        () => true,
        () => false,
      );
    },
    [identity],
  );

  /**
   * The PIN screen saying it has finished with itself. Splitting this from
   * `unlockWithPin` is what lets the unlock be watchable: the keys have been
   * open since the digits landed, and this is only the moment the app is
   * allowed to notice.
   */
  const finishPinUnlock = useCallback((): void => {
    const opened = pending.current;
    if (opened === null) return;
    pending.current = null;
    // Whatever the seal settles on. Already resolved on any ordinary machine,
    // so this is a microtask; on a slow one it is however long the vault
    // needs, and the app is up and usable in the meantime either way.
    const seal = sealing.current;
    sealing.current = null;
    if (seal !== null) void seal.then(applySeal);
    setKeys(opened);
    setState(opened.provisioned ? "ready" : "unprovisioned");
  }, [applySeal]);

  /** "Use my password instead": the vault goes, and with it the PIN. */
  const forgetPin = useCallback(async (): Promise<void> => {
    pending.current = null;
    try {
      await forgetKeys();
      setVaultError(null);
    } catch {
      setVaultError("This browser could not delete the keys it had stored. Clear this site's data to remove them.");
    }
    setRememberedState(false);
    setPinAttemptsLeft(null);
    setFailure(null);
    setState("locked");
  }, []);

  /**
   * Turning this on from an unlocked session needs no password — the keys are
   * already open in memory — but it does need the PIN to seal them under, and
   * the root secrets to seal. A session with neither has to unlock with its
   * password first, which is what the thrown message is for.
   */
  const setRemembered = useCallback(
    async (on: boolean, pin?: string): Promise<void> => {
      if (on) {
        if (identity === null || keys === null) return;
        if (pin === undefined) throw new Error("Choose a PIN to keep this browser unlocked.");
        await rememberKeys(identity.userId, identity.deviceId, keys, pin);
        setPinAttemptsLeft(MAX_PIN_ATTEMPTS);
      } else {
        // Deliberately unguarded. The switch may only move once the store
        // says the keys are gone, or the reader is looking at an "off" that
        // is not true — the one failure this feature must never hide.
        await forgetKeys();
        setPinAttemptsLeft(null);
      }
      setVaultError(null);
      setRememberedState(on);
    },
    [identity, keys],
  );

  /**
   * Back to the Unlock screen without signing out. A repaired Space keeps the
   * reader's existing preference and stored record until a successful unlock
   * replaces it; an ordinary relock drops both.
   */
  const relock = useCallback(async (options?: {
    preserveRemembered?: boolean;
    enableCloudAfterUnlock?: boolean;
  }): Promise<void> => {
    if (options?.preserveRemembered !== true) {
      await forgetKeys();
      setVaultError(null);
      setRememberedState(false);
      setPinAttemptsLeft(null);
    }
    pending.current = null;
    sealing.current = null;
    enableCloudAfterUnlock.current = options?.enableCloudAfterUnlock === true;
    feed.current?.close();
    feed.current = null;
    setKeys(null);
    setWorkspace(emptyView());
    setHubState(null);
    setFailure(null);
    setState("locked");
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
    feed.current?.close();
    feed.current = null;
    // Signing out has to finish either way — refusing to sign out because a
    // delete failed strands the reader signed in. The identity goes first, so
    // any record left behind is unreachable: recall matches on the device id,
    // and the next sign-in mints a new one.
    let residue: string | null = null;
    await forgetIdentity();
    try {
      await forgetKeys();
    } catch {
      residue = "Signed out, but this browser could not delete the keys it had stored. Clear this site's data to remove them.";
    }
    setRememberedState(false);
    setPinAttemptsLeft(null);
    pending.current = null;
    sealing.current = null;
    enableCloudAfterUnlock.current = false;
    setIdentity(null);
    dropToken();
    setAccount(null);
    setSpaces([]);
    setKeys(null);
    setWorkspace(emptyView());
    setHubState(null);
    setVaultError(residue);
    setFailure(null);
    setState("signed-out");
  }, [dropToken]);

  /** Control's own view of the Spaces, after one was renamed or added. */
  const refreshSpaces = useCallback(async (): Promise<void> => {
    const bearer = await getToken();
    if (bearer === null) return;
    setSpaces((await listSpaces(bearer)).spaces);
  }, [getToken]);

  const value = useMemo<Session>(
    () => ({
      state,
      error,
      errorDetail,
      busy,
      account,
      identity,
      token,
      spaces,
      keys,
      workspace,
      hubState,
      remembered,
      pinAttemptsLeft,
      vaultError,
      signIn,
      unlockWith,
      setSessionPin,
      unlockWithPin,
      finishPinUnlock,
      forgetPin,
      getToken,
      enableCloud: enableCloudSpace,
      setRemembered,
      relock,
      signOut,
      keysFor: (spaceId) => keys?.spaces.get(spaceId) ?? null,
      refreshSpaces,
    }),
    [
      state,
      error,
      errorDetail,
      busy,
      account,
      identity,
      token,
      spaces,
      keys,
      workspace,
      hubState,
      remembered,
      pinAttemptsLeft,
      vaultError,
      signIn,
      unlockWith,
      setSessionPin,
      unlockWithPin,
      finishPinUnlock,
      forgetPin,
      getToken,
      enableCloudSpace,
      setRemembered,
      relock,
      signOut,
      refreshSpaces,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
