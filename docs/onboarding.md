# Onboarding

(Until 2026-10-09 the UI called a space a "tab group", and a Profile a "Space"; identifiers keep the old words.)

The first time Pistachio opens it does not show the browser. It shows a
walkthrough — the account, then four steps — and only when that is done
does the chrome appear, already furnished with what the
person chose: a Space named after them, their apps in the favorites grid,
their old browser's sessions and bookmarks, the agent's memory seeded, and
a set of welcome tabs open. The four steps can each be skipped. The account
cannot.

## The account

Pistachio is not used without an account (since 2026-11-17). The agent's
models come with it, and it is what lets sessions, Profiles and restore
points travel between a person's machines, sealed under keys only they hold.
So a Mac that is not signed in shows a way to sign in and nothing else:

- **On a first run** the walkthrough opens on the account step
  (`ACCOUNT_STEP`, `onboardingStepsFor`): create an account or sign in to
  one, and this Mac is enrolled in the same pass. There is no skip. A new
  account's enrollment mints its recovery code, shown exactly once, so the
  step holds — "I've saved it — continue" — until the person says they have
  it; joining an account that exists mints none and goes straight on. The
  step list is fixed at mount, so enrolling does not take the step (and the
  code) away.
- **After the walkthrough**, a Mac that is signed out — it signed out in
  Settings → Account, its enrollment was revoked, or it finished setup before
  an account was required — shows the same step alone, in the browser's
  place: the sign-in screen (`onboardingSignIn` in the shell's store). No
  rail, no Back, no Esc; it leaves when this Mac is enrolled. Profiles, tabs
  and settings are untouched behind it. Settings → Account's sign-out dialog
  says that signing out closes the browser until someone signs in again.

**Who decides.** Main does: `AccountState.required`, true on a desktop. The
shell's rule is `accountGated` (`shell-ui/src/lib/account.ts`): required, and
not enrolled — nobody signed in, an account made but this Mac not enrolled,
or a revoked device. The store raises the screen at the first load and
whenever the account leaves this Mac (`accountPatch`), and only
`closeOnboarding` takes it down, so the recovery code is never taken off the
screen by the enrollment that minted it. While it is up `onboardingOpen` is
true, so everything that stands down for the walkthrough — shortcuts, the
tab switcher, the update prompt — stands down for it. Before the first
snapshot, `launchState().signedOut` gives the window the wizard's ground
instead of a frame of chrome.

**Where it is not required.** Where no account layer runs (`PISTACHIO_E2E`),
on the web (the person signed in on the way to the page; no host there
reports `required`), and in a development run on an anonymous account
(`PISTACHIO_ANONYMOUS=1`, ignored in a packaged app —
docs/anonymous-accounts.md). A Mac still holding an anonymous account from
before is asked to sign in like any other, and what that account holds
comes along: signing up upgrades it in place, signing in folds it into the
account signed in to.

**What it cannot get past.** Signing in seals keys with the system keychain;
where that is unavailable the step says so and its button stays off. A Mac
that has never signed in and cannot reach control cannot get in either —
one already signed in opens offline as before.

## The steps

| Step         | What it gathers                                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account      | An email and a password, to create an account or sign in to one; this Mac is enrolled in the same pass. Required, and shown only where a sign-in is owed (above). |
| About you    | A spoken (or typed) introduction. Speech is transcribed, then read for a name, a bio, and durable facts; every one is editable before it is written to memory.       |
| Bring a browser | Which profiles to import from the browsers on this Mac — any number, across browsers, each shown with the account it is signed in to. Every ticked profile brings its signed-in sessions and bookmarks (whatever its browser supports). |
| Favorites    | At least three apps from a catalog. Each tile lights up in the brand's own colours — all of Figma's, only YouTube's red.                                              |
| Appearance   | A preset, a colour mode, desktop glass, corner radius — the same controls as Settings → Appearance, written live so the window behind the wizard is already dressed. |

Every step's copy, primary action, and skip live in
`renderer/src/components/onboarding/OnboardingWizard.tsx`; the stages
(the right-hand mock window) are one file per step under `steps/`.

## What finishing does

`completeOnboarding` (main/index.ts) applies everything at once:

1. The name and bio become the keyed memories `profile.name` and
   `profile.about` — the same slots Settings → Memory edits — and each
   extra fact becomes a memory of its own, all with the person as source.
2. The first Space is renamed to the person's first name (`SpaceStore.rename`).
3. The chosen apps are appended to the Space's favorites (`sidebar.json`),
   each with the site's `/favicon.ico` until the page's own favicon lands.
4. `settings.onboarding.completed` is set, with `completedAt`.
5. The welcome tabs (`WELCOME_TABS`, shared/onboarding.ts) open in the
   Space, the overview active.

Then the wizard fades over the finished browser.

The account step comes first so that all of this happens signed in: the
spoken introduction is a model call, and what the import step brings over
lands in an account that can carry it to the person's other devices.

Finishing also saves the account's completion through
`POST /v1/me/onboarding/complete` before dismissing the wizard. A failed save
leaves it open for retry. A desktop that finished setup before enrolling, or
before account-backed onboarding existed, reconciles completion when its
account services start. Signing into the browser app with that account then
opens the browser without repeating setup.

## Voice

The about step records with `MediaRecorder` (`renderer/src/lib/recorder.ts`)
and hands main the audio. `main/onboarding.ts` transcribes through the AI
Gateway's transcription model (`PISTACHIO_STT_MODEL`, default
`openai/whisper-1`), falling back to any configured chat model that takes
audio, then extracts name, bio, and facts with `generateObject`. Without a
provider the stage says so and offers the fields; without a model answer
the heuristic reader (`heuristicIntake`) prefills what it can. Nothing is
written until the person has seen and edited it.

## Browser import

`main/browser-import.ts` finds Chrome, Arc, Brave, Edge, Chromium, Vivaldi,
Opera, Firefox, and Safari by their data directories, lists each one's
profiles and the accounts they are signed in to (Chromium's `Local State`,
Firefox's `profiles.ini` and `signedInUser.json`), and imports each chosen profile in turn:

- **Sessions** — the profile's cookies, into the active Space's session.
  Chromium encrypts cookie values with a key kept in the login keychain
  ("Chrome Safe Storage" and its siblings); on macOS it is read through
  `security find-generic-password`, which is what makes the OS ask the
  person to allow it. Values are AES-128-CBC under PBKDF2 of that password
  (Chromium's os_crypt); from cookie schema 24 the plaintext starts with a
  hash of the host, which is dropped. Firefox's cookies are unencrypted.
  Safari's are the OS's and are not read.
- **Bookmarks** — into the shelf as pins, in folders named for the browser
  and each bookmark folder's path (the shelf is one level deep).

Every database is copied to a temp directory and opened read-only through
`node:sqlite` before it is read; the browser's own files are never opened.
Nothing leaves the machine.

## Welcome pages

The pages themselves are `@pistachio/shell-contracts/welcome-pages`: pure
builders (`welcomeOverviewHtml`, `welcomeLessonHtml`, `welcomeLessons`,
`welcomePalette`, `welcomePage`) parameterised by a link base, an asset base
and a font source, because the cloud browser draws the same four documents
with none of a desktop's protocol behind it (see "On the web").

`main/welcome-pages.ts` is what only a Mac can do: it serves
`pistachio://welcome` (the overview: greeting, the lessons as a numbered
list, the person's own shortcut bindings) and `pistachio://learn/agent`,
`/spaces`, `/memory` (one lesson each: steps, a "try it now",
previous/next), reads the font and the video files off disk, and hands the
builders the context through `setWelcomeContext`. They are drawn in the
person's theme — the appearance's gradient, colours, and radius — and greet
them by name. The desktop passes `splits: false` (2026-10-09): it has no split
view, so lesson 2 (`learn/spaces`, *The sidebar, favorites & Profiles*;
*Spaces, favorites & split view* until then) teaches a space in its place,
its video slot the "coming soon" card, and the overview leaves out the split
shortcut; the web keeps the split step. There is no lesson of spaces' own.

Each page keeps a video slot. `WELCOME_VIDEOS` names the source for each;
null draws a "coming soon" card. Files are served from the welcome assets
directory (`PISTACHIO_WELCOME_ASSETS`, else `resources/welcome` beside the
app, else `<userData>/welcome`) at `pistachio://welcome/assets/<file>`, so
dropping `agent.mp4` there and pointing `WELCOME_VIDEOS.agent.src` at
`pistachio://welcome/assets/agent.mp4` is all a finished video needs.

## On the web

The same walkthrough runs in a browser tab, over a cloud browser session
(docs/web-browser-design.md §14). The steps, the stages and the completion
are the desktop's; four things differ.

- **The account database decides.** `users.onboarding_completed_at` is null
  until the walkthrough finishes. Existing and new accounts start incomplete.
  Each web visit reads this status from `/v1/me` and copies it into the host's
  `onboarding.completed` setting before mounting the shell. Reloads and fresh
  browsers require onboarding until the host has applied the walkthrough and
  `POST /v1/me/onboarding/complete` has saved the account's completion timestamp.
  A failed save keeps the wizard open for retry. Local storage and older synced
  settings cannot bypass this check.
- **There is no account step.** On a Mac the walkthrough opens on it (see
  "The account"). In a tab the person just signed in — no host there reports
  an account as `required` — so the steps are about, import, favorites,
  appearance, and "Step 1 of 4".
- **Bring a browser is a variant.** Importing reads databases on a Mac, so
  the step keeps its place and says so: a Mac signed into this account
  brings its sessions and bookmarks here through sync, with a download link
  and "Continue" as the primary. `detectBrowsers`/`importBrowserProfiles`
  are never called.
- **Voice runs on the web's side of the bridge.** The recorder is browser
  code either way; transcription and intake go through the web device's own
  token against control's `/v1/ai/*` proxy rather than through the host,
  which as a `cloud` device is refused there.
- **The welcome pages are host-rendered.** There is no `pistachio://`
  protocol in a cloud tab, so the host renders each page into a
  self-contained `data:` document and opens it as a tab whose DISPLAYED
  address is the page's own `pistachio://` one — the reader's mechanism
  (web-browser-design.md §11), with a logical address on top. A
  `pistachio://` link inside such a document cannot navigate, so the page
  bridge intercepts the click, reports it, and the host re-renders that tab
  with the page the link named. Welcome tabs are therefore rebuilt on
  restore rather than stored: the sealed session record carries
  `pistachio://learn/spaces`, never the document.

## Replaying, skipping, testing

- Settings → About → **Run setup again** opens the wizard over a completed
  install. A replay can be dismissed with Esc; finishing it adds to what is
  there (favorites, memories) and never removes anything.
- Under Playwright (`PISTACHIO_E2E=1`) the wizard is marked complete at
  startup so every other spec opens on the browser; `PISTACHIO_ONBOARDING=1`
  keeps it, which is what `e2e/tests/onboarding.spec.ts` sets.
- No account is required under `PISTACHIO_E2E` either (no account layer is
  built), so those specs never meet the account step or the sign-in screen.
  `PISTACHIO_E2E_ACCOUNT=required` makes main report one owed, and the spec
  answers the account channels with a double in main: the account step, the
  recovery code, and sign-out → sign-in screen → sign-in are walked that way.
  A second spec runs the real account layer (`PISTACHIO_E2E=0`, a mock
  keychain, a control address nothing listens on) to show a signed-out Mac
  opening on the sign-in screen. The rule itself is unit-tested in
  `shell-ui/test/account-required.test.ts`.
