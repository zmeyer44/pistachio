import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, X } from "lucide-react";
import type {
  BrowserImportResult,
  InstalledBrowser,
} from "@pistachio/shell-contracts/browser-import";
import type { AccountState } from "@pistachio/shell-contracts/ipc";
import {
  ACCOUNT_STEP,
  onboardingStepsFor,
  spaceNameFor,
  SUGGESTED_FAVORITES,
  type OnboardingFavoritePick,
  type OnboardingIntake,
  type OnboardingStep,
} from "@pistachio/shell-contracts/onboarding";
import { accountGated, accountStep, type AccountStep as AccountStage } from "../../lib/account";
import { cn } from "../../lib/cn";
import { aboutCopy, appearanceCopy, IMPORT_ON_THE_WEB, importPrimary, importSkipLabel } from "../../lib/onboarding-steps";
import { useSurface } from "../../surface";
import { useAppStore } from "../../store";
import { PistachioMark } from "../PistachioMark";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { StepRail } from "./parts";
import { SidebarPreview } from "./SidebarPreview";
import { AboutStep } from "./steps/AboutStep";
import { AccountStep, type AccountDraft } from "./steps/AccountStep";
import { AppearanceStep } from "./steps/AppearanceStep";
import { FavoritesStep } from "./steps/FavoritesStep";
import {
  ImportStep,
  type ImportChoice,
  type ProfilePick,
} from "./steps/ImportStep";
import { nativeApi } from "../../api";

const EMPTY_INTAKE: OnboardingIntake = {
  transcript: "",
  name: "",
  about: "",
  facts: [],
};

/** How long the wizard takes to fade once the browser behind it is ready. */
const LEAVE_MS = 380;

interface Copy {
  title: React.ReactNode;
  blurb: string;
  /** The quiet link under the primary button, or null when the step cannot be skipped. */
  skip: string | null;
  /** A line at the column's foot. */
  aside: string | null;
}

/** The four steps' columns. The account step's depends on where the person is in it: `accountCopy`. */
const COPY: Record<Exclude<OnboardingStep, typeof ACCOUNT_STEP>, Copy> = {
  about: {
    title: (
      <>
        Tell us about
        <br />
        yourself.
      </>
    ),
    blurb:
      "Pistachio's agent works for you, so it helps to know who you are. Tap the mic and introduce yourself — your name, what you do, what you're into. It becomes memory you can read and edit any time.",
    skip: "Skip for now",
    // Surface-aware: `aboutCopy` owns both wordings. What sits here is the
    // desktop's, so a reader of this table still sees the default.
    aside: aboutCopy("native").aside,
  },
  import: {
    title: (
      <>
        Get us up
        <br />
        to speed.
      </>
    ),
    blurb:
      "Bring your signed-in sessions and bookmarks over from the browser you use today, so your first Profile already knows where you go and who you are there.",
    skip: "Start fresh instead",
    aside:
      "Read from this Mac and written to this Mac. From here, what lands in your Profile converges with your other devices end-to-end encrypted.",
  },
  favorites: {
    title: (
      <>
        Choose the apps
        <br />
        you use most.
      </>
    ),
    blurb: `Pick the ones you open every day — ${String(SUGGESTED_FAVORITES)} is a good start, and a site of your own works too. They sit at the top of your sidebar as favorites — one click, always the same tab, in every window.`,
    skip: "Skip for now",
    aside: "None of this is final: add or remove favorites later by dragging tabs onto the grid.",
  },
  appearance: {
    title: (
      <>
        Make it
        <br />
        yours.
      </>
    ),
    blurb:
      "Pick a look for the window. The material, every colour, and each slider stay adjustable in Settings → Appearance.",
    skip: null,
    aside: appearanceCopy("native").aside,
  },
};

/** A password seals the keys, so the one thing a new account has to be told before it is made. */
const PASSWORD_ASIDE =
  "Your password derives the key that seals every Profile, so Pistachio cannot reset it for you. The recovery code shown next is the only other way in.";

/**
 * The account step's column. Unlike the other steps' its words depend on
 * where the person is in it — making an account or signing in to one,
 * waiting on this Mac's keys, or holding a recovery code that is shown once
 * — and on whether this is the walkthrough's first step or the sign-in
 * screen of a Mac that already finished it (`signInOnly`), which has to say
 * why a browser that was working is asking. Never skippable: Pistachio is
 * not used without an account (docs/onboarding.md, "The account").
 */
function accountCopy(input: {
  stage: AccountStage;
  creating: boolean;
  signInOnly: boolean;
  account: AccountState;
  recoveryCode: string | null;
}): Copy {
  const { stage, creating, signInOnly, account, recoveryCode } = input;
  if (stage === "done") {
    return recoveryCode === null
      ? {
          title: (
            <>
              You&rsquo;re
              <br />
              signed in.
            </>
          ),
          blurb: "This Mac is enrolled in your account. Its keys were made here and stay here.",
          skip: null,
          aside: null,
        }
      : {
          title: (
            <>
              Save your
              <br />
              recovery code.
            </>
          ),
          blurb:
            "Your account is made and this Mac is enrolled. The code beside this is the only other way into your synced sessions if you forget your password, and this is the one time it is shown.",
          skip: null,
          aside: "Write it down, or keep it in a password manager. Settings → Account can mint a new one later, which retires this one.",
        };
  }
  // Signed in with only this Mac's keys missing reads as signing in, whichever form got there.
  const making = creating && stage === "sign-in";
  const title = making ? (
    <>
      Create your
      <br />
      account.
    </>
  ) : signInOnly ? (
    <>
      Sign in to
      <br />
      Pistachio.
    </>
  ) : (
    <>
      Sign in to
      <br />
      your account.
    </>
  );
  if (!signInOnly) {
    return {
      title,
      blurb:
        "Pistachio runs on an account. The models its agent works with come with it — nothing to paste, no provider to sign up with — and it lets your Macs, and the cloud browser if you use it, share the sessions you are signed into, sealed under keys derived on your machines.",
      skip: null,
      aside: making ? PASSWORD_ASIDE : "What this account already holds arrives on this Mac as it syncs.",
    };
  }
  return {
    title,
    blurb: account.revoked
      ? "This Mac's enrollment was revoked, so it has to sign in again before Pistachio can be used here. Your Profiles, tabs, and the sessions already on this Mac were left alone."
      : account.state === "anonymous"
        ? "Pistachio now runs on an account, and this Mac has none yet. Create one and it is this Mac's own, upgraded: your Profiles, tabs, and settings stay where they are, and what the agent has done here comes with it."
        : "Pistachio runs on an account, and nobody is signed in on this Mac. Your Profiles, tabs, and settings are still here: sign in and the browser opens where you left it.",
    skip: null,
    aside: making ? PASSWORD_ASIDE : null,
  };
}

type Phase = "idle" | "finishing" | "leaving";

/**
 * The first-run walkthrough, drawn over the whole window before the
 * browser is revealed: who you are, what to bring over, which apps to
 * keep close, and how the window should look, in Pistachio's material —
 * a white column of copy and one primary action on the left,
 * and on the right a stage in the theme's own gradient where each step's
 * controls live inside a mock window.
 *
 * The wizard holds every answer until the last step, then hands them to
 * main in one `completeOnboarding` (@pistachio/shell-contracts/onboarding) and fades away
 * over the browser it just furnished: favorites in the grid, the Space
 * named, the welcome tabs open. The appearance step is the one exception —
 * it writes settings as it goes, so the window behind the wizard is
 * already wearing the choice as the wizard leaves.
 *
 * `onboardingReplay` (Settings → About) lets it be dismissed with Esc or
 * the close button; the first run has no way out but through, though
 * every step that can be skipped says so. The account step, where there is
 * one, cannot be: it stands first, and the rest waits on it.
 *
 * `onboardingSignIn` is the wizard as the sign-in screen: that one step and
 * nothing after it, on a Mac that finished the walkthrough and is signed
 * out. It gathers nothing for main and completes nothing — it leaves, over
 * the browser that was there all along, once this Mac is enrolled.
 */
export function OnboardingWizard() {
  const replay = useAppStore((state) => state.onboardingReplay);
  const signInOnly = useAppStore((state) => state.onboardingSignIn);
  const account = useAppStore((state) => state.account);
  const signUp = useAppStore((state) => state.signUp);
  const signIn = useAppStore((state) => state.signIn);
  const enrollDevice = useAppStore((state) => state.enrollDevice);
  const closeOnboarding = useAppStore((state) => state.closeOnboarding);
  const completeOnboarding = useAppStore((state) => state.completeOnboarding);
  const overlayReady = useAppStore((state) => state.overlayReady);
  // The one thing the walkthrough asks of the surface (§14): there are no
  // browsers to read in a browser tab, so the import step shows the web
  // variant and its primary just continues.
  const surface = useSurface().kind;

  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const [intake, setIntake] = useState<OnboardingIntake>(EMPTY_INTAKE);
  const [aboutBusy, setAboutBusy] = useState(false);
  /**
   * Whether the walkthrough opens on the account — decided ONCE, at mount.
   *
   * It does wherever a sign-in is owed: main says an account is required and
   * this Mac is not enrolled in one (`accountGated`). Never in a browser tab,
   * where the person signed in on the way to this page (§14), and never on a
   * replay, which only a signed-in Mac can start.
   *
   * It is frozen because it is a fact about the STEP LIST: re-deriving it
   * would delete the step from under the person the instant enrollment
   * succeeded — taking the recovery code, shown exactly once, with it. The
   * account is loaded before the wizard can mount (the shell renders it only
   * once the first snapshot has landed), so one read is enough.
   */
  const [askAccount] = useState(() => signInOnly || accountGated(account));
  // What the account step still has to ask for: credentials, the enrollment
  // alone (signed in, this Mac's keys missing), or nothing.
  const accountStage = accountStep(account);
  const [accountDraft, setAccountDraft] = useState<AccountDraft>(() => ({
    // A first run is most often someone new. The sign-in screen is most
    // often someone coming back — unless this Mac holds an anonymous account
    // from before one was required, which proves it never had a real one.
    mode: signInOnly && account.state !== "anonymous" ? "sign-in" : "sign-up",
    email: account.email ?? "",
    password: "",
    confirm: "",
  }));
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [browsers, setBrowsers] = useState<InstalledBrowser[] | null>(null);
  const [importChoice, setImportChoice] = useState<ImportChoice | null>(null);
  const [importResult, setImportResult] = useState<
    BrowserImportResult[] | null
  >(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  // Catalog apps and typed-in sites in one list, in the order picked: that
  // order is the preview's and the shelf's, so a new pick only ever appends.
  const [picks, setPicks] = useState<OnboardingFavoritePick[]>([]);
  const favorites = useMemo(() => picks.flatMap((pick) => (pick.kind === "app" ? [pick.id] : [])), [picks]);
  const customFavorites = useMemo(() => picks.flatMap((pick) => (pick.kind === "site" ? [{ url: pick.url, title: pick.title }] : [])), [picks]);

  const steps = useMemo<readonly OnboardingStep[]>(
    () => (signInOnly ? [ACCOUNT_STEP] : onboardingStepsFor(askAccount)),
    [signInOnly, askAccount],
  );
  const step = steps[index] ?? "about";
  const creating = accountDraft.mode === "sign-up";
  // Three steps say where what you just gave GOES, and that answer is about
  // the machine, so the surface rewrites them (§14). Import is rewritten
  // whole — there is nothing on a stream surface to import — while about and
  // appearance keep their step but swap the claim about storage: the two
  // helpers hold both wordings and `COPY` above holds the native one.
  const copy: Copy =
    step === ACCOUNT_STEP
      ? accountCopy({ stage: accountStage, creating, signInOnly, account, recoveryCode })
      : step === "import" && surface === "stream"
      ? { ...COPY.import, blurb: IMPORT_ON_THE_WEB.blurb, aside: IMPORT_ON_THE_WEB.aside }
      : step === "about"
        ? { ...COPY.about, aside: aboutCopy(surface).aside }
        : step === "appearance"
          ? { ...COPY.appearance, aside: appearanceCopy(surface).aside }
          : COPY[step];
  const skipLabel = step === "import" ? importSkipLabel(surface) : copy.skip;
  const last = index === steps.length - 1;
  const busy = phase !== "idle";

  const next = () =>
    setIndex((current) => Math.min(steps.length - 1, current + 1));
  const back = () => setIndex((current) => Math.max(0, current - 1));

  /** The sign-in screen's way out: nothing to hand main, only the browser to give back. */
  const leave = () => {
    setPhase("leaving");
    window.setTimeout(closeOnboarding, LEAVE_MS);
  };

  /**
   * Sign in (or sign up) and enroll this Mac in one go: an account that has
   * not enrolled a device brings no models and syncs nothing, so stopping
   * halfway would leave this Mac no nearer to being usable.
   *
   * When only the enrollment failed the account already stands, so this runs
   * the enrollment alone: signing up again for the address that was just
   * created is refused by control, and asking for the password a second time
   * would make a retry look like a mistake the person made.
   *
   * A new account's enrollment mints the recovery code, shown exactly once:
   * the step stays where it is until the person says they have it. Joining
   * an account that exists mints none, so there is nothing to wait for and
   * the wizard goes straight on — to the introduction, or out.
   */
  const saveAccount = async () => {
    const enrollOnly = accountStage === "enroll";
    const email = accountDraft.email.trim();
    if (!enrollOnly) {
      if (!email.includes("@")) {
        setAccountError("Enter the email address for the account.");
        return;
      }
      if (creating && accountDraft.password.length < 8) {
        setAccountError("Choose a password of at least 8 characters.");
        return;
      }
      if (creating && accountDraft.confirm !== accountDraft.password) {
        setAccountError("The two passwords do not match. This one seals your Profile keys, so it cannot be recovered later.");
        return;
      }
    }
    setAccountBusy(true);
    setAccountError(null);
    if (!enrollOnly) {
      const authenticated = creating
        ? await signUp(email, accountDraft.password)
        : await signIn(email, accountDraft.password);
      if (!authenticated.ok) {
        setAccountBusy(false);
        setAccountError(authenticated.error);
        return;
      }
    }
    const enrolled = await enrollDevice();
    setAccountBusy(false);
    // The password is not kept in a view once it has done its work.
    setAccountDraft((current) => ({ ...current, password: "", confirm: "" }));
    if (!enrolled.ok) {
      setAccountError(`Signed in, but this Mac could not enroll: ${enrolled.error}. Try again.`);
      return;
    }
    if (enrolled.value.recoveryCode !== null) setRecoveryCode(enrolled.value.recoveryCode);
    else if (signInOnly) leave();
    else next();
  };

  const finish = async () => {
    setPhase("finishing");
    setNotice(null);
    const error = await completeOnboarding({
      name: intake.name.trim(),
      about: intake.about.trim(),
      facts: intake.facts,
      favorites: picks,
      spaceName: spaceNameFor(intake.name),
      openWelcomeTabs: true,
    });
    if (error !== null) {
      setNotice(error);
      setPhase("idle");
      return;
    }
    setPhase("leaving");
    window.setTimeout(closeOnboarding, LEAVE_MS);
  };

  const runImport = async () => {
    if (importChoice?.kind !== "browser" || importChoice.profiles.length === 0)
      return;
    setImportBusy(true);
    setImportError(null);
    try {
      // Each profile brings everything its browser can hand over.
      const requests = importChoice.profiles.map((pick) => {
        const installed = browsers?.find(
          (candidate) => candidate.kind === pick.browser,
        );
        return {
          browser: pick.browser,
          profileId: pick.profileId,
          sessions: installed?.supports.sessions ?? false,
          bookmarks: installed?.supports.bookmarks ?? false,
        };
      });
      // Nothing to import from without a local browser (W12); the step
      // reports no results rather than failing.
      const result = (await nativeApi()?.importBrowserProfiles(requests)) ?? [];
      setImportResult(result);
    } catch (caught) {
      setImportError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setImportBusy(false);
    }
  };

  /** The one primary action, per step — the button and Enter both run it. */
  const primary: {
    label: string;
    disabled: boolean;
    loading: boolean;
    run: () => void;
  } =
    step === ACCOUNT_STEP
      ? accountStage === "done"
        ? {
            // Enrolled. With a recovery code on the stage the button is also
            // the person saying they have it: it is not shown again.
            label: recoveryCode !== null ? "I’ve saved it — continue" : signInOnly ? "Open Pistachio" : "Continue",
            disabled: busy,
            loading: false,
            run: signInOnly ? leave : next,
          }
        : accountStage === "enroll"
          ? {
              // Signed in; only this Mac's keys are missing, so the button
              // asks for that and nothing else.
              label: accountBusy ? "Setting up your keys…" : "Enroll this Mac",
              disabled: accountBusy,
              loading: accountBusy,
              run: () => void saveAccount(),
            }
          : {
              label: accountBusy ? "Setting up your keys…" : creating ? "Create account" : "Sign in",
              // Nothing to submit without the keychain the keys are sealed
              // with (the stage says so), or with a field still empty.
              disabled:
                accountBusy ||
                !account.encryptionAvailable ||
                accountDraft.email.trim() === "" ||
                accountDraft.password === "" ||
                (creating && accountDraft.confirm === ""),
              loading: accountBusy,
              run: () => void saveAccount(),
            }
      : step === "about"
        ? { label: "Continue", disabled: aboutBusy, loading: false, run: next }
      : step === "import"
        ? {
            ...importPrimary({
              surface,
              choice: importChoice === null ? "none" : importChoice.kind === "fresh" ? "fresh" : "browser",
              profiles: importChoice?.kind === "browser" ? importChoice.profiles.length : 0,
              importLabel: importLabel(importChoice?.kind === "browser" ? importChoice.profiles : []),
              imported: importResult !== null,
              busy: importBusy,
            }),
            run:
              surface === "stream" || importResult !== null || importChoice?.kind !== "browser"
                ? next
                : () => void runImport(),
          }
        : step === "favorites"
          ? {
              // Three is a suggestion, not a gate: someone who uses none of
              // the offered apps gets to the browser without picking extras.
              label: "Next",
              disabled: false,
              loading: false,
              run: next,
            }
          : {
              label:
                phase === "finishing"
                  ? "Setting up your Profile…"
                  : "Open Pistachio",
              disabled: busy,
              loading: phase === "finishing",
              run: () => void finish(),
            };

  const skip = () => {
    if (step === "import") {
      setImportChoice({ kind: "fresh" });
      setImportResult(null);
    }
    // Skipping the favorites means none: what was tapped on the way out is
    // not kept, or "skip" would be a second Next.
    if (step === "favorites") setPicks([]);
    next();
  };

  // Enter runs the primary; Esc leaves only a replay. Neither while a step
  // owns the keyboard for typing.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && replay && !busy) {
        event.preventDefault();
        closeOnboarding();
        return;
      }
      if (
        event.key !== "Enter" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        // A held key is one press: the Enter that submitted a step must not
        // also run whatever the next one offers.
        event.repeat
      )
        return;
      // The recovery code is shown once, and the button under it is the
      // person saying they have it. That takes a deliberate click, not the
      // key that was under the finger when the code appeared.
      if (step === ACCOUNT_STEP && accountStage === "done" && recoveryCode !== null) return;
      const target = event.target as HTMLElement | null;
      if (
        target !== null &&
        (target.tagName === "TEXTAREA" ||
          target.tagName === "BUTTON" ||
          target.tagName === "SELECT")
      )
        return;
      if (primary.disabled) return;
      event.preventDefault();
      primary.run();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const onAboutBusy = useCallback((value: boolean) => setAboutBusy(value), []);
  const toggleFavorite = (id: string) =>
    setPicks((current) =>
      current.some((pick) => pick.kind === "app" && pick.id === id)
        ? current.filter((pick) => !(pick.kind === "app" && pick.id === id))
        : [...current, { kind: "app", id }],
    );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={signInOnly ? "Sign in to Pistachio" : "Welcome to Pistachio"}
      data-testid="onboarding"
      data-step={step}
      data-sign-in={signInOnly ? "" : undefined}
      // A replay fades in over the chrome the person was using; a first run
      // is opaque from its first frame, so the chrome never shows through
      // (shell.css, "First-run wizard").
      data-replay={replay ? "" : undefined}
      data-leaving={phase === "leaving" ? "" : undefined}
      className="onboarding fixed inset-0 z-50 flex bg-background-100 text-gray-1000"
    >
      {/* The traffic lights sit in this corner; the strip under them moves the window. */}
      <div
        aria-hidden="true"
        className="drag-region absolute inset-x-0 top-0 h-11"
      />

      <section className="no-drag relative flex w-[42%] max-w-[560px] min-w-[400px] shrink-0 flex-col px-12 pt-[66px] pb-10">
        <div className="flex h-8 items-center justify-between">
          {/* One step is not a walk: the sign-in screen has no rail to move along. */}
          {signInOnly ? <span /> : <StepRail count={steps.length} index={index} />}
          <span className="flex items-center gap-2 text-label-12 text-gray-700">
            <PistachioMark size={24} />
            Pistachio
          </span>
        </div>

        <div
          key={step}
          className="onboarding-step flex min-h-0 flex-1 flex-col"
        >
          <div className="mt-9 h-7">
            {index > 0 ? (
              <button
                type="button"
                onClick={back}
                disabled={busy || importBusy}
                data-testid="onboarding-back"
                className="flex cursor-pointer items-center gap-1.5 rounded-sm px-1.5 py-1 text-label-13 font-medium text-(--theme-accent) [color:color-mix(in_oklch,var(--theme-accent)_65%,var(--color-gray-1000))] hover:bg-alpha-100 disabled:cursor-default disabled:opacity-50"
              >
                <ArrowLeft className="size-3.5" aria-hidden="true" />
                Back
              </button>
            ) : null}
          </div>
          <h1 className="mt-3 text-[40px] leading-[1.04] font-bold tracking-[-0.035em] text-gray-1000">
            {copy.title}
          </h1>
          <p className="mt-5 max-w-[42ch] text-[15px] leading-6 text-gray-900">
            {copy.blurb}
          </p>
          {copy.aside === null ? null : (
            <p className="mt-4 max-w-[42ch] text-label-12 leading-4.5 text-gray-700">
              {copy.aside}
            </p>
          )}
          {/* The mock sidebar stays put from the favorites step into the
              appearance step, where it becomes a live preview of the palette. */}
          {step === "favorites" || step === "appearance" ? (
            <div className="mt-8 min-h-0 flex-1 overflow-hidden">
              <SidebarPreview
                picks={picks}
                themed={step === "appearance"}
              />
            </div>
          ) : null}
        </div>

        <div className="mt-8 flex flex-col gap-3">
          {notice !== null ? (
            <p
              role="alert"
              className="rounded-md bg-red-100 px-3.5 py-2.5 text-copy-13 leading-snug text-red-1000"
            >
              {notice}
            </p>
          ) : null}
          <Button
            size="lg"
            data-testid="onboarding-primary"
            className="w-full"
            disabled={primary.disabled}
            loading={primary.loading}
            onClick={primary.run}
          >
            {primary.label}
          </Button>
          <div className="flex h-8 items-center justify-center">
            {skipLabel !== null && (step !== "import" || importResult === null) ? (
              <button
                type="button"
                data-testid="onboarding-skip"
                disabled={busy || importBusy || (step === "about" && aboutBusy)}
                onClick={skip}
                className="cursor-pointer rounded-sm px-2 py-1 text-label-13 font-medium text-gray-900 hover:bg-alpha-100 hover:text-gray-1000 disabled:cursor-default disabled:opacity-50"
              >
                {skipLabel}
              </button>
            ) : last && step !== ACCOUNT_STEP ? (
              <span className="flex items-center gap-1.5 text-label-12 text-gray-700">
                <Kbd>⏎</Kbd> to open
              </span>
            ) : null}
          </div>
        </div>
      </section>

      <section
        aria-label="Step content"
        className={cn(
          "theme-window relative flex min-w-0 flex-1 items-center justify-center overflow-hidden border-l border-alpha-400 bg-background-200 px-12 py-14",
          step === "favorites" && "items-stretch justify-stretch p-0",
        )}
      >
        {/* Two blooms of the theme's colours, so the stage is the window's own material rather than a flat well. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              "radial-gradient(60% 55% at 85% 10%, color-mix(in srgb, var(--theme-accent-3) 42%, transparent), transparent 70%), radial-gradient(55% 60% at 10% 90%, color-mix(in srgb, var(--theme-accent-2) 40%, transparent), transparent 70%)",
          }}
        />
        {replay ? (
          <Button
            variant="tertiary"
            size="sm"
            svgOnly
            aria-label="Close setup"
            data-testid="onboarding-close"
            onClick={closeOnboarding}
            className="no-drag absolute top-3 right-3 z-10"
          >
            <X aria-hidden="true" />
          </Button>
        ) : null}
        <div
          key={step}
          className={cn(
            "no-drag relative flex w-full items-center justify-center",
            step === "favorites" ? "h-full" : "max-h-full",
          )}
        >
          {step === ACCOUNT_STEP ? (
            <AccountStep
              draft={accountDraft}
              onDraft={(next) => {
                setAccountDraft(next);
                setAccountError(null);
              }}
              account={account}
              recoveryCode={recoveryCode}
              error={accountError}
              busy={accountBusy}
            />
          ) : step === "about" ? (
            <AboutStep
              intake={intake}
              onIntake={setIntake}
              onBusy={onAboutBusy}
              modelsKey={account.state}
            />
          ) : step === "import" ? (
            <ImportStep
              browsers={browsers}
              onBrowsers={setBrowsers}
              choice={importChoice}
              onChoose={(choice) => {
                setImportChoice(choice);
                setImportError(null);
              }}
              result={importResult}
              busy={importBusy}
              error={importError}
            />
          ) : step === "favorites" ? (
            <FavoritesStep
              selected={favorites}
              custom={customFavorites}
              onToggle={toggleFavorite}
              onAddCustom={(favorite) =>
                setPicks((current) =>
                  current.some((pick) => pick.kind === "site" && pick.url === favorite.url)
                    ? current
                    : [...current, { kind: "site", ...favorite }],
                )
              }
              onRemoveCustom={(url) =>
                setPicks((current) => current.filter((pick) => !(pick.kind === "site" && pick.url === url)))
              }
            />
          ) : (
            <AppearanceStep />
          )}
        </div>
        {/* The stage renders before main has raised the chrome; until then the
            page's stills are not up and the tab views may still paint over
            this. Nothing to draw for it — the wizard is opaque — but the flag
            keeps the reveal honest. */}
        <span
          className="sr-only"
          data-testid="onboarding-ready"
          data-ready={overlayReady ? "" : undefined}
        />
      </section>
    </div>
  );
}

/** "Import from Chrome", "Import 3 Chrome profiles", "Import from Chrome and Firefox". */
function importLabel(profiles: readonly ProfilePick[]): string {
  const kinds = [...new Set(profiles.map((pick) => pick.browser))];
  if (kinds.length === 0) return "Import";
  if (kinds.length === 1) {
    const name = browserName(kinds[0]!);
    return profiles.length === 1
      ? `Import from ${name}`
      : `Import ${String(profiles.length)} ${name} profiles`;
  }
  const names = kinds.map(browserName);
  return `Import from ${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}

function browserName(kind: InstalledBrowser["kind"]): string {
  switch (kind) {
    case "edge":
      return "Edge";
    case "chrome":
      return "Chrome";
    case "arc":
      return "Arc";
    case "brave":
      return "Brave";
    case "chromium":
      return "Chromium";
    case "vivaldi":
      return "Vivaldi";
    case "opera":
      return "Opera";
    case "firefox":
      return "Firefox";
    case "safari":
      return "Safari";
  }
}
