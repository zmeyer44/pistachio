"use client";

/**
 * Pistachio, in a browser tab (docs/web-browser-design.md §7).
 *
 * The route's whole job is to hand the shell a working bridge: pick the Space,
 * create or resume its browser session, dial the shell socket, prove the Space
 * key, and only then mount the tree. Everything the person then sees — the
 * tabs, the splits, the shelf, the console, settings — is the desktop's own
 * chrome running over that socket.
 *
 * The states before that are the ones worth writing carefully, because each is
 * a different thing to do next: no Space runs in the cloud (turn one on), this
 * browser holds no key for the one that does (unlock), the session ended or
 * the worker let go (start again). They wear the dashboard's dress rather than
 * the shell's: the shell has not started yet, and pretending otherwise with a
 * blank chrome would be a lie about what is running.
 */

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Cloud, Loader2 } from "lucide-react";
import type { OnboardingCompletion } from "@pistachio/shell-contracts/onboarding";
import {
  Button,
  completeAccountOnboarding,
  createBrowserSession,
  errorDetailOf,
  Loading,
  me,
  Note,
  NotSetUp,
  PinGate,
  renameSpace,
  SignIn,
  Unlock,
  useSession,
} from "@pistachio/web-account";
import { createOnboardingAi } from "../lib/onboarding-ai";
import { describeShellError, WsShellApi, type ShellSocketStatus } from "../lib/shell-socket";

/**
 * The shell is a browser program — its modules read `navigator` as they
 * evaluate — so it is never prerendered. This is also what keeps the whole
 * desktop chrome out of the dashboard's bundle: no other route loads it.
 */
const ShellTree = dynamic(() => import("../components/shell-tree"), { ssr: false });

/** The Space this browser was last browsing, so a reload lands where it was. */
const LAST_SPACE_KEY = "pistachio.browse.space";

function rememberedSpace(): string | null {
  try {
    return window.localStorage.getItem(LAST_SPACE_KEY);
  } catch {
    // A browser with site data blocked still browses; it just always opens
    // the first cloud Space.
    return null;
  }
}

function rememberSpace(spaceId: string): void {
  try {
    window.localStorage.setItem(LAST_SPACE_KEY, spaceId);
  } catch {
    // As above: remembering is a convenience, never a precondition.
  }
}

/**
 * Everything that is not the shell: one centred panel over the shell's own
 * ground, so the transition into the chrome is a fill rather than a jump.
 */
function Curtain({
  title,
  children,
  detail,
  action,
  busy,
}: {
  title: string;
  children: ReactNode;
  detail?: string | null;
  action?: { label: string; onClick: () => void };
  busy?: boolean;
}): ReactNode {
  return (
    <div className="grid h-full w-full place-items-center bg-background-200 p-6" data-testid="browse-curtain">
      <div className="flex w-full max-w-[420px] flex-col gap-3 rounded-lg bg-background-100 p-5 shadow-small">
        <p className="flex items-center gap-2 text-heading-16 text-gray-1000">
          {busy === true ? (
            <Loader2 className="size-4 shrink-0 animate-spin text-gray-700" aria-hidden="true" />
          ) : (
            <Cloud className="size-4 shrink-0 text-gray-700" aria-hidden="true" />
          )}
          {title}
        </p>
        <div className="text-copy-13 text-gray-900">{children}</div>
        {detail === undefined || detail === null ? null : <Note tone="alert">{detail}</Note>}
        {action === undefined ? null : (
          <span>
            <Button type="button" variant="primary" onClick={action.onClick} disabled={busy === true}>
              {action.label}
            </Button>
          </span>
        )}
      </div>
    </div>
  );
}

function Browse(): ReactNode {
  const { state, spaces, keys, keysFor, getToken, enableCloud, relock, refreshSpaces } =
    useSession();
  const [api, setApi] = useState<WsShellApi | null>(null);
  const [status, setStatus] = useState<ShellSocketStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Bumped by "Try again"; the connect effect keys off it. */
  const [attempt, setAttempt] = useState(0);

  const cloudSpaces = useMemo(() => spaces.filter((space) => space.cloudEnabled), [spaces]);
  const [spaceId, setSpaceId] = useState<string | null>(null);

  // The last Space this browser used, if it still runs in the cloud; else the
  // account's first. Chosen in an effect because `localStorage` is not there
  // during prerender, and a Space that is gone must not pin the page to it.
  useEffect(() => {
    if (cloudSpaces.length === 0) {
      setSpaceId(null);
      return;
    }
    const remembered = rememberedSpace();
    const chosen = cloudSpaces.find((space) => space.id === remembered)?.id ?? cloudSpaces[0]?.id ?? null;
    setSpaceId(chosen);
    if (chosen !== null) rememberSpace(chosen);
  }, [cloudSpaces]);

  const spaceKeys = spaceId === null ? null : keysFor(spaceId);

  /* ------------------------------- the session ------------------------------ */

  /**
   * The shell's Space switcher, on this transport (§6.3). A browser session is
   * one Space's, so switching is not something to ask the host for: it is this
   * page opening or resuming the other Space's session and swapping sockets,
   * which the effect below does the moment `spaceId` changes.
   */
  const switchSpace = useCallback(async (next: string): Promise<void> => {
    rememberSpace(next);
    setSpaceId(next);
  }, []);

  /**
   * The walkthrough's three model calls, answered here rather than by the
   * host: control's model proxy is device-bearer and turns a `cloud` device
   * away, while THIS browser is a device of the person's own (§14).
   */
  const ai = useMemo(() => createOnboardingAi(getToken), [getToken]);

  /** Save account completion after the host has applied the walkthrough. */
  const afterCompleteOnboarding = useCallback(
    async (input: OnboardingCompletion): Promise<void> => {
      const token = await getToken();
      if (token === null) throw new Error("Sign in again to finish onboarding.");
      // A failed database write keeps the wizard open and can be retried.
      try {
        await completeAccountOnboarding(token);
      } catch (cause) {
        throw new Error("We couldn't save your setup. Please try again.", { cause });
      }

      // This session's Space is the one the host just renamed — on a first
      // run it is also the account's first, since there is only one.
      const renamed = spaceId;
      if (input.spaceName !== null && renamed !== null) {
        try {
          await renameSpace(token, renamed, input.spaceName);
          await refreshSpaces();
        } catch {
          // The Space is named where it counts; this row catches up on the
          // next rename from any device.
        }
      }
    },
    [getToken, refreshSpaces, spaceId],
  );

  useEffect(() => {
    if (state !== "ready" || spaceId === null || spaceKeys === null) return;
    let live = true;
    let socket: WsShellApi | null = null;
    setError(null);
    setDetail(null);
    setApi(null);

    void (async () => {
      try {
        const token = await getToken();
        if (token === null) throw new Error("This browser is not signed in.");
        // Create-or-resume: the Space's one session, whether this tab opens it
        // or joins the one a phone left running.
        const { session } = await createBrowserSession(token, spaceId);
        if (!live) return;
        const next = new WsShellApi({
          sessionId: session.id,
          keys: spaceKeys,
          getToken,
          switchSpace,
          local: ai,
          afterCompleteOnboarding,
        });
        socket = next;
        setStatus(next.status);
        next.onStatus(setStatus);
        await next.connect();
        if (!live) {
          next.close();
          return;
        }
        // The account database decides on every visit, including an existing
        // account signing in on a fresh browser. Override both stale completed
        // and stale incomplete shell settings before the store's first load.
        const account = await me(token);
        if (!live) return;
        const remoteSettings = await next.getSettings();
        if (remoteSettings.onboarding.completed !== (account.onboardingCompletedAt !== null)) await next.updateSettings({
          onboarding: {
            completed: account.onboardingCompletedAt !== null,
            completedAt: account.onboardingCompletedAt,
          },
        });
        if (!live) return;
        setApi(next);
      } catch (cause: unknown) {
        if (!live) return;
        setError(describeShellError(cause));
        setDetail(errorDetailOf(cause));
      }
    })();

    return () => {
      live = false;
      socket?.close();
    };
  }, [afterCompleteOnboarding, ai, attempt, getToken, spaceId, spaceKeys, state, switchSpace]);

  /* ------------------------------- the states ------------------------------- */

  const setupCloud = useCallback((): void => {
    const first = spaces[0];
    if (first === undefined || busy) return;
    setBusy(true);
    setError(null);
    // Wrapping a Space for the cloud device needs the root secrets, which only
    // a password unlock puts in this tab. Remembered derived keys are not
    // enough, and saying so beats a refusal from control.
    const work =
      (keys?.rootSecrets.size ?? 0) === 0
        ? relock({ preserveRemembered: true, enableCloudAfterUnlock: true })
        : enableCloud(first.id);
    void work
      .catch((cause: unknown) => {
        setError(describeShellError(cause));
        setDetail(errorDetailOf(cause));
      })
      .finally(() => {
        setBusy(false);
      });
  }, [busy, enableCloud, keys, relock, spaces]);

  const retry = useCallback((): void => {
    setError(null);
    setDetail(null);
    setAttempt((value) => value + 1);
  }, []);

  if (state !== "ready") {
    // The shell around this route already renders the gate for every other
    // state; this is the beat between them.
    return (
      <Curtain title="Opening" busy>
        Checking this browser.
      </Curtain>
    );
  }

  if (cloudSpaces.length === 0) {
    return (
      <Curtain
        title="No Space runs in the cloud yet"
        detail={error}
        busy={busy}
        action={{
          label: busy
            ? "Turning on…"
            : (keys?.rootSecrets.size ?? 0) === 0
              ? "Unlock to turn on"
              : "Turn on cloud browser",
          onClick: setupCloud,
        }}
      >
        The pages here are real Chromium tabs on the cloud browser, in your signed-in sessions. Turn it on for a Space
        and they open here, on any device, whether or not your Mac is awake.
      </Curtain>
    );
  }

  if (spaceKeys === null) {
    return (
      <Curtain title="This browser cannot open that Space" action={{ label: "Unlock", onClick: () => void relock({ preserveRemembered: true }) }}>
        Your password unlocks the key this Space is sealed under, and this browser is not holding it. The cloud browser
        will not show a pixel of a Space this device cannot read.
      </Curtain>
    );
  }

  if (error !== null) {
    return (
      <Curtain title="The cloud browser could not be opened" detail={detail} action={{ label: "Try again", onClick: retry }}>
        {error}
      </Curtain>
    );
  }

  if (status?.phase === "closed") {
    return (
      <Curtain title="This session is not open" detail={status.error} action={{ label: "Try again", onClick: retry }}>
        {status.code === "ended"
          ? "This browser session has ended. Opening it again starts a fresh one for this Space."
          : (status.error ?? "The cloud browser disconnected.")}
      </Curtain>
    );
  }

  if (api === null) {
    return (
      <Curtain title="Opening your browser session" busy>
        Dialling the cloud browser with a one-minute ticket, and proving this Space&apos;s key before anything is sent.
      </Curtain>
    );
  }

  // A key per socket: a reconnect keeps the same object, but a NEW session (a
  // different Space, a retry) must remount the tree so the store initializes
  // against the bridge that is actually live.
  return <ShellTree api={api} key={`${spaceId ?? ""}:${String(attempt)}`} />;
}

/**
 * The door, and then the browser (docs/web-browser-design.md §15).
 *
 * On the dashboard the rail's shell decides what a reader may see; here there
 * is no rail, so this page runs the same gate — the package's, so both sites
 * ask for the same things in the same words and in the same order. What it
 * wears is the one thing that differs: `skin="shell"` dresses it in the
 * browser's own material rather than the marketing site's, because a person
 * who creates their account here is already standing where their walkthrough
 * runs (§14). The state flips to `ready`, the shell mounts under them with no
 * navigation at all, and the wizard's first step arrives in the same frame the
 * form was just in.
 */
export default function BrowserPage(): ReactNode {
  const { state } = useSession();

  if (state === "loading") return <Loading skin="shell" />;
  if (state === "signed-out") return <SignIn skin="shell" />;
  // The keypad, in all three of its states: answering a PIN, choosing one, and
  // — `unlocking` — the digits rolling up into a ring over an open session.
  if (state === "pin" || state === "set-pin" || state === "unlocking") return <PinGate skin="shell" />;
  if (state === "locked") return <Unlock skin="shell" />;
  if (state === "unprovisioned") return <NotSetUp skin="shell" />;
  return <Browse />;
}
