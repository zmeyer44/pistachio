# Pistachio

## Testing

Don't run tests after every change or feature. Run them only when necessary — when asked, when writing or fixing a test, or when a risky change can't be checked any other way — and then the narrowest run that answers the question (one spec or one unit file before `test:changed`). Run the whole suite once before merging.

- **When a change does need testing:** `pnpm test:changed`. It runs the unit tests related to the change (turbo picks the affected packages, vitest the test files that import a changed file) and the desktop e2e areas the changed files belong to, plus the `@smoke` tests. The change is measured against where the branch left `main`, or against `HEAD` on `main` itself, so uncommitted work counts either way.
  - `--dry --explain` prints the plan and which area each changed file fell into.
  - `--files a,b --dry` answers "what would changing these run?".
  - `--unit` or `--e2e` runs one half; `--base <ref>` measures against another ref.
- **Before merging, or when asked for a full run:** `pnpm test` (all unit tests, one package at a time, about two minutes) and `pnpm test:e2e` (the whole desktop e2e suite, about ten minutes). The web app's and the cloud's specs (`@web`, in the same folder for now) are `pnpm test:e2e:web`, about twelve minutes — each boots the cloud services and a cold Next.js build; run them before merging web or cloud changes (`test:changed` picks them for those paths). A change to a hub file — `browser-controller.ts`, main's `index.ts`, the preloads, the shell's `store.ts` or `App.tsx` — is only smoke-tested by `test:changed`, so it especially needs the full run.
- **One area by hand:** `pnpm test:e2e -- --grep @desk` (any tag below).

### E2E areas

Every desktop e2e test carries an area tag; `apps/desktop/e2e/areas.mjs` maps source paths to tags. When you add a test, tag it (`test("…", { tag: ["@sidebar"] }, …)`); when you add a source file an area should own, add its path there (unclaimed desktop files are only smoke-tested).

Tags: `@desk @sidebar @tabs @split @address @home @glance @agent @settings @onboarding @site @popup @media @notices @pages @startup @web`, plus `@smoke` (a quick pass over each part of the window, run for any desktop change) and `@live` (needs a signed-in account and network; never run by default).

### Writing e2e tests

- Launch through `launchApp()` in `apps/desktop/e2e/tests/app.ts`, and let tests that share settings share one launch (`test.describe.serial` with a `beforeAll`): every launch costs seconds.
- In a serial group, put the area tags on the group (`test.describe.serial("…", { tag: [...] }, …)`), not on its tests: a `--grep` that picked one test of a group would run it without the earlier tests whose state it inherits. `@smoke` may go on a group's first test.
- Wait for a condition (`expect.poll`, an attribute, main's state through `app.evaluate`), never a fixed sleep, unless the time itself is what is tested.
- Screenshots are for people reviewing a change: write them only when `captureEnabled` (`PISTACHIO_E2E_CAPTURE=1`). Nothing should assert on them.
- Temp profiles are cleaned up by the run (`scripts/test-tmpdir.mjs`); `PISTACHIO_KEEP_TEST_TMP=1` keeps them for a look.
- Logic belongs in a unit test; an e2e test proves the wiring that only the real app has — native views, focus, IPC, the OS.

### Known environment failures

Tests that need native window focus fail while the macOS screen is locked (`ioreg -n Root -d1 -a | grep -A1 CGSSessionScreenIsLocked`): the tab switcher, keyboard hand-off, fullscreen, the scheduled brief, and the desk's mask and dock-menu focus checks. Rerun a failure alone before treating it as a regression; the real cursor resting over the window can also disturb drag tests.
