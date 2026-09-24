/**
 * What the walkthrough's steps say and offer, where that depends on the
 * SURFACE rather than on what the person has done (docs/web-browser-design.md
 * §14, and §10's table).
 *
 * The IMPORT step differs most. Importing reads the browsers installed on a
 * Mac (W12), so in a browser tab there is nothing to detect and nothing to
 * import; the step keeps its place — the walkthrough is the same four steps
 * wherever it runs — and says what it is instead: why it is a Mac's job,
 * that a Mac signed into this account brings its sessions and bookmarks
 * here through sync, and where to get it. Its primary is therefore a plain
 * "Continue", live from the moment the step opens, and there is no "start
 * fresh instead" to choose because nothing was on offer.
 *
 * The ABOUT and APPEARANCE steps differ in one thing each, and it is the
 * thing a reader is being asked to trust: WHERE WHAT THEY JUST GAVE GOES.
 * On a Mac both answers are "here, on this machine". In a browser tab
 * neither is: the introduction becomes memory the SESSION HOST writes,
 * sealed under this account's keys and synced to the account's devices; the
 * appearance is written to the account's own settings register and every
 * device that reads it opens wearing it. Saying "kept on this Mac" in a tab
 * is not a stale phrasing, it is a false promise about storage, so the
 * strings are surface-aware rather than shared.
 *
 * Pure on purpose — no React, no DOM — so the copy and the button's state
 * are pinned by vitest rather than by a browser.
 */

/** Which surface the shell is running on; `Surface["kind"]` by another name. */
export type OnboardingSurface = "native" | "stream";

/** The import step, in a browser tab: the column's copy and the stage's. */
export const IMPORT_ON_THE_WEB = {
  blurb:
    "The browser you use today lives on your Mac, and so do its sessions and bookmarks. Bring them over there and they arrive here on their own.",
  aside:
    "Nothing to do in this tab. What a Mac imports is sealed under keys only your devices hold and converges into this Space.",
  reason:
    "Bringing a browser over reads the profiles installed on a Mac — its cookies, its bookmarks — so it happens in the Mac app, not in this tab.",
  sync: "Install Pistachio on your Mac and sign in with this account: everything you import there travels here, sealed under keys only your devices hold. Your sessions and bookmarks arrive in this Space on their own.",
  /** The link's own words; the address comes from the surface. */
  download: "Download Pistachio for Mac",
} as const;

/**
 * The quiet link under the primary, or null where the step has nothing to
 * skip. Only the import step's changes: on a stream surface "start fresh
 * instead" would be a second Continue for a choice nobody was offered.
 */
export function importSkipLabel(surface: OnboardingSurface): string | null {
  return surface === "stream" ? null : "Start fresh instead";
}

/** What the wizard's one primary action is on the import step. */
export interface StepPrimary {
  label: string;
  disabled: boolean;
  loading: boolean;
}

export interface ImportPrimaryInput {
  surface: OnboardingSurface;
  /** What the step has been told: nothing yet, "start fresh", or a browser. */
  choice: "none" | "fresh" | "browser";
  /** How many profiles are ticked, when a browser is the choice. */
  profiles: number;
  /** The label an import of those profiles would carry ("Import from Chrome"). */
  importLabel: string;
  /** Whether an import has already run: the step then only continues. */
  imported: boolean;
  busy: boolean;
}

/**
 * The import step's primary. On a stream surface it is always an enabled
 * "Continue": there is nothing to detect, nothing to pick, and nothing that
 * could still be running. On a Mac it is the desktop's own rule — Continue
 * once the import has run or "start fresh" was chosen, the import itself
 * while profiles are ticked, and nothing at all until the step is answered.
 */
export function importPrimary(input: ImportPrimaryInput): StepPrimary {
  if (input.surface === "stream") return { label: "Continue", disabled: false, loading: false };
  if (input.imported) return { label: "Continue", disabled: false, loading: false };
  if (input.choice === "browser") {
    return {
      label: input.busy ? "Bringing it over\u2026" : input.importLabel,
      disabled: input.busy || input.profiles === 0,
      loading: input.busy,
    };
  }
  return { label: "Continue", disabled: input.choice === "none", loading: false };
}

/* ------------------------------- the copy ------------------------------- */

/**
 * The about step's two claims about storage: the line under the column's
 * blurb, and the caption under the microphone.
 *
 * The desktop's wording is untouched — the introduction really is written to
 * this Mac's own memory store, and the audio really does leave only to be
 * transcribed. In a browser tab the recording is made HERE and read by the
 * model this account comes with, and what it becomes is written by the
 * session host into the account's memory: sealed under keys only this
 * account's devices hold, and synced to them.
 */
export function aboutCopy(surface: OnboardingSurface): { aside: string; recording: string } {
  if (surface === "stream") {
    return {
      aside:
        "Written to your agent's memory, in Settings \u2192 Memory \u2014 sealed under this account's keys and synced to your devices. The recording goes to the model once, for the words, and nowhere else.",
      recording:
        "A few sentences is plenty. Sent to your model provider once, for the words \u2014 what it becomes is sealed under this account's keys.",
    };
  }
  return {
    aside:
      "Kept on this Mac, in Settings \u2192 Memory. The recording goes to the model once, for the words, and nowhere else.",
    recording:
      "A few sentences is plenty. Sent to your model provider once, for the words \u2014 nothing else leaves this Mac.",
  };
}

/**
 * The appearance step's line about where the choice lives.
 *
 * On a Mac appearance is a per-machine preference, written to that machine's
 * settings file and nowhere else; the sentence says so, and says what DOES
 * travel instead. In a browser tab the shell has no machine of its own: the
 * host writes the settings into the account's sealed register (`shell-settings`),
 * which is the same record every host of this account reads on the way up.
 */
export function appearanceCopy(surface: OnboardingSurface): { aside: string } {
  if (surface === "stream") {
    return {
      aside:
        "Appearance is saved to this account's synced settings, so every device that reads them opens wearing it. Sessions and Spaces travel the same way.",
    };
  }
  return {
    aside:
      "Appearance is a per-machine preference: it stays on this Mac. Sessions and Spaces are what travel between your devices.",
  };
}
