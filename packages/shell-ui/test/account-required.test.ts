/**
 * An account is required to use Pistachio (docs/onboarding.md, "The
 * account"): where main says so, a Mac that is not signed in shows the
 * sign-in screen and nothing else. `accountGated` (src/lib/account.ts) is the
 * rule, and the store (src/store.ts) is where it puts the screen up — at the
 * first load, and whenever the account leaves this Mac afterwards — and where
 * it is taken down again.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { AccountState, ShellSnapshot } from "@pistachio/shell-contracts/ipc";
import { DEFAULT_SETTINGS } from "@pistachio/shell-contracts/settings";
import { setShellApi, type ShellApiBridge } from "../src/api";
import { accountGated, DEFAULT_ACCOUNT } from "../src/lib/account";
import { useAppStore } from "../src/store";

/** A desktop's account, as main reports it before anyone signs in. */
const SIGNED_OUT: AccountState = { ...DEFAULT_ACCOUNT, required: true, encryptionAvailable: true };
const SIGNED_UP: AccountState = { ...SIGNED_OUT, state: "signed-up", email: "someone@example.com", userId: "user-1" };
const ENROLLED: AccountState = { ...SIGNED_UP, state: "enrolled", deviceId: "11111111-1111-4111-8111-111111111111" };

const SNAPSHOT = {
  spaces: [{ id: "space-1", name: "Personal", color: "#8fbf6a", parentSpaceId: null, cloudEnabled: false }],
  activeSpaceId: "space-1",
  tabs: [],
  activeTabId: null,
  visibleTabIds: [],
  wakingTabIds: [],
  splitGroups: [],
  recentlyClosed: null,
  sidebar: { pinned: [], favorites: [], folders: [], presets: [], collapsed: [] },
  run: null,
  threads: [],
} as unknown as ShellSnapshot;

/** The bridge the store calls through, with only the calls the action makes. */
function bridge(pistachio: Record<string, unknown>): void {
  setShellApi(pistachio as unknown as ShellApiBridge);
}

/**
 * A host for a whole first load: the snapshot, the settings and the account
 * as given, every subscription accepted, and every other getter refusing —
 * which the load spares, as it does for a host that does not answer.
 */
function host(account: AccountState, onboardingCompleted: boolean): Record<string, unknown> {
  const answers: Record<string, unknown> = {
    getSnapshot: () => Promise.resolve(SNAPSHOT),
    getSettings: () =>
      Promise.resolve({ ...DEFAULT_SETTINGS, onboarding: { completed: onboardingCompleted, completedAt: null } }),
    getAccount: () => Promise.resolve(account),
  };
  return new Proxy(answers, {
    get(target, member) {
      if (typeof member !== "string") return undefined;
      if (member in target) return target[member];
      if (member.startsWith("on")) return () => () => undefined;
      return () => Promise.reject(new Error("not asked"));
    },
  });
}

const CLOSED = { onboardingOpen: false, onboardingReplay: false, onboardingSignIn: false };

afterEach(() => {
  bridge({});
  useAppStore.setState({ ...CLOSED, account: DEFAULT_ACCOUNT, devices: [], channels: [], overlay: "none", snapshot: null });
});

describe("whether a sign-in is owed", () => {
  it("is, wherever an account is required and this Mac is not enrolled in one", () => {
    expect(accountGated(SIGNED_OUT)).toBe(true);
    // An account made here whose Mac never enrolled is no nearer to usable.
    expect(accountGated(SIGNED_UP)).toBe(true);
    // An anonymous account from before one was required is nobody signed in.
    expect(accountGated({ ...SIGNED_OUT, state: "anonymous", userId: "anon-1" })).toBe(true);
    // A revoked Mac still reports `enrolled`; its token is gone.
    expect(accountGated({ ...ENROLLED, revoked: true })).toBe(true);
    expect(accountGated(ENROLLED)).toBe(false);
  });

  it("is not where nothing requires one: a host that never answers, a spec, a development run", () => {
    expect(accountGated(DEFAULT_ACCOUNT)).toBe(false);
    expect(accountGated({ ...SIGNED_OUT, required: false })).toBe(false);
    expect(accountGated({ ...SIGNED_OUT, required: false, state: "anonymous" })).toBe(false);
  });
});

describe("what stands in front of the browser when it opens", () => {
  it("is the walkthrough on a fresh install, which asks for the account itself", async () => {
    bridge(host(SIGNED_OUT, false));
    const stop = await useAppStore.getState().initialize();
    stop();

    expect(useAppStore.getState()).toMatchObject({ onboardingOpen: true, onboardingReplay: false, onboardingSignIn: false });
  });

  it("is the sign-in screen alone on a Mac that finished the walkthrough and is signed out", async () => {
    bridge(host(SIGNED_OUT, true));
    const stop = await useAppStore.getState().initialize();
    stop();

    expect(useAppStore.getState()).toMatchObject({ onboardingOpen: true, onboardingReplay: false, onboardingSignIn: true });
  });

  it("is nothing on a Mac that is signed in", async () => {
    bridge(host(ENROLLED, true));
    const stop = await useAppStore.getState().initialize();
    stop();

    expect(useAppStore.getState()).toMatchObject(CLOSED);
  });

  it("is nothing where no account is required, signed in or not", async () => {
    bridge(host({ ...SIGNED_OUT, required: false }, true));
    const stop = await useAppStore.getState().initialize();
    stop();

    expect(useAppStore.getState()).toMatchObject(CLOSED);
  });
});

describe("the account leaving this Mac", () => {
  it("raises the sign-in screen on sign-out, over whatever page asked for it", async () => {
    useAppStore.setState({ ...CLOSED, account: ENROLLED, overlay: "settings" });
    bridge({ signOut: () => Promise.resolve(SIGNED_OUT) });

    await expect(useAppStore.getState().signOut()).resolves.toBeNull();

    expect(useAppStore.getState()).toMatchObject({
      account: SIGNED_OUT,
      onboardingOpen: true,
      onboardingReplay: false,
      onboardingSignIn: true,
      // Settings → Account ran the sign-out; it is not left open under the screen.
      overlay: "none",
    });
  });

  it("raises it when main reports a revocation, taking a replay's place", async () => {
    let publish: (state: AccountState) => void = () => undefined;
    const answers = host(ENROLLED, true);
    bridge(
      new Proxy(answers, {
        get(target, member) {
          if (member === "onAccount") {
            return (listener: (state: AccountState) => void) => {
              publish = listener;
              return () => undefined;
            };
          }
          return Reflect.get(target, member) as unknown;
        },
      }),
    );
    const stop = await useAppStore.getState().initialize();
    useAppStore.getState().openOnboarding();
    expect(useAppStore.getState()).toMatchObject({ onboardingOpen: true, onboardingReplay: true });

    publish({ ...ENROLLED, revoked: true });
    stop();

    expect(useAppStore.getState()).toMatchObject({ onboardingOpen: true, onboardingReplay: false, onboardingSignIn: true });
  });

  it("asks for nothing where no account is required", async () => {
    useAppStore.setState({ ...CLOSED, account: { ...ENROLLED, required: false }, overlay: "settings" });
    bridge({ signOut: () => Promise.resolve({ ...SIGNED_OUT, required: false }) });

    await useAppStore.getState().signOut();

    expect(useAppStore.getState()).toMatchObject({ ...CLOSED, overlay: "settings" });
  });
});

describe("getting through the sign-in screen", () => {
  it("stays up when this Mac enrolls: the recovery code shown once is on it", async () => {
    useAppStore.setState({ onboardingOpen: true, onboardingReplay: false, onboardingSignIn: true, account: SIGNED_OUT });
    bridge({
      signUp: () => Promise.resolve(SIGNED_UP),
      enroll: () => Promise.resolve({ state: ENROLLED, recoveryCode: "AAAA-BBBB-CCCC-DDDD" }),
    });

    await useAppStore.getState().signUp("someone@example.com", "correct horse");
    const enrolled = await useAppStore.getState().enrollDevice();

    expect(enrolled).toMatchObject({ ok: true, value: { recoveryCode: "AAAA-BBBB-CCCC-DDDD" } });
    expect(useAppStore.getState()).toMatchObject({ account: ENROLLED, onboardingOpen: true, onboardingSignIn: true });
  });

  it("comes down when the person is through it", () => {
    useAppStore.setState({ onboardingOpen: true, onboardingReplay: false, onboardingSignIn: true, account: ENROLLED });

    useAppStore.getState().closeOnboarding();

    expect(useAppStore.getState()).toMatchObject(CLOSED);
  });
});

describe("a walkthrough and the account", () => {
  it("is left alone while it is up: its own first step asks for the account", async () => {
    useAppStore.setState({ onboardingOpen: true, onboardingReplay: false, onboardingSignIn: false, account: SIGNED_OUT });
    bridge({ signIn: () => Promise.resolve(SIGNED_UP) });

    await useAppStore.getState().signIn("someone@example.com", "correct horse");

    expect(useAppStore.getState()).toMatchObject({ account: SIGNED_UP, onboardingOpen: true, onboardingSignIn: false });
  });

  it("gives way to the sign-in screen when it ends with a sign-in still owed", () => {
    // The account left this Mac while the walkthrough was up (a revocation):
    // finishing it must not open a browser nobody is signed in to.
    useAppStore.setState({ onboardingOpen: true, onboardingReplay: false, onboardingSignIn: false, account: { ...ENROLLED, revoked: true } });

    useAppStore.getState().closeOnboarding();

    expect(useAppStore.getState()).toMatchObject({ onboardingOpen: true, onboardingReplay: false, onboardingSignIn: true });
  });
});
