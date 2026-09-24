# Onboarding

The first time Pistachio opens it does not show the browser. It shows a
four-step walkthrough, and only when that is done —
or skipped — does the chrome appear, already furnished with what the
person chose: a Space named after them, their apps in the favorites grid,
their old browser's sessions and bookmarks, the agent's memory seeded, and
a set of welcome tabs open.

## The steps

| Step         | What it gathers                                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
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

Nobody has to sign in for any of this, the spoken introduction included: a
Mac nobody signed in on is given an anonymous account that the models run
under (docs/anonymous-accounts.md), and the account made later in Settings →
Account is that same one, upgraded.

On an enrolled desktop, finishing also saves the account's completion through
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
them by name.

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
- **"Or sign in" is not offered.** On a Mac the about step carries a quiet
  "Or sign in" under the introduction: it opens a sign-in form in the step's
  own stage, enrolls the Mac in the same pass, and returns to the
  introduction with the microphone available. The walkthrough never creates
  an account — that is Settings → Account, which is also where a recovery
  code is shown. In a tab the person just signed in, so the link is absent;
  the steps are about, import, favorites, appearance either way.
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
