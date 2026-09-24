/**
 * The one step of the walkthrough that differs by surface
 * (docs/web-browser-design.md §14): importing reads the browsers installed
 * on a Mac (W12), so in a browser tab the step says what it is instead of
 * offering something that cannot happen.
 *
 * The about and appearance steps differ in one string each — where what you
 * just gave is KEPT — and both wordings are pinned below, because a browser
 * tab that promises "this Mac" is making a false promise about storage.
 *
 * What is pinned here is the pair that decides whether the person can get
 * PAST that step — the primary's label and whether it is live — and the
 * copy that has to be true of the surface it is on. The desktop's own rule
 * is pinned in the same place, because the whole risk of a surface-aware
 * button is that the surface that already worked stops working.
 */

import { describe, expect, it } from "vitest";
import {
  aboutCopy,
  appearanceCopy,
  IMPORT_ON_THE_WEB,
  importPrimary,
  importSkipLabel,
  type ImportPrimaryInput,
} from "../src/lib/onboarding-steps";

function primary(patch: Partial<ImportPrimaryInput>) {
  return importPrimary({
    surface: "native",
    choice: "none",
    profiles: 0,
    importLabel: "Import from Chrome",
    imported: false,
    busy: false,
    ...patch,
  });
}

describe("the import step in a browser tab", () => {
  it("continues, live, whatever the step is holding", () => {
    expect(primary({ surface: "stream" })).toEqual({ label: "Continue", disabled: false, loading: false });
    // Nothing on a stream surface can put the step in any other state, but
    // the button must not depend on that being true.
    expect(primary({ surface: "stream", choice: "browser", profiles: 2, busy: true })).toEqual({
      label: "Continue",
      disabled: false,
      loading: false,
    });
  });

  it("offers nothing to skip: there was nothing on offer", () => {
    expect(importSkipLabel("stream")).toBeNull();
    expect(importSkipLabel("native")).toBe("Start fresh instead");
  });

  it("says why it is a Mac's job, and that a Mac brings it here through sync", () => {
    expect(IMPORT_ON_THE_WEB.reason).toMatch(/Mac/u);
    expect(IMPORT_ON_THE_WEB.reason).toMatch(/not in this tab/u);
    expect(IMPORT_ON_THE_WEB.sync).toMatch(/sign in with this account/u);
    expect(IMPORT_ON_THE_WEB.sync).toMatch(/sealed under keys only your devices hold/u);
    expect(IMPORT_ON_THE_WEB.download).toBe("Download Pistachio for Mac");
    // The column's own copy must not promise this tab can read a browser.
    expect(IMPORT_ON_THE_WEB.blurb).not.toMatch(/Bring your signed-in sessions/u);
    expect(IMPORT_ON_THE_WEB.aside).toMatch(/Nothing to do in this tab/u);
  });
});

describe("the import step on a Mac", () => {
  it("waits for an answer before it will continue", () => {
    expect(primary({})).toEqual({ label: "Continue", disabled: true, loading: false });
  });

  it("continues once starting fresh is chosen", () => {
    expect(primary({ choice: "fresh" })).toEqual({ label: "Continue", disabled: false, loading: false });
  });

  it("imports what is ticked, and refuses a browser with nothing ticked", () => {
    expect(primary({ choice: "browser", profiles: 1 })).toEqual({
      label: "Import from Chrome",
      disabled: false,
      loading: false,
    });
    expect(primary({ choice: "browser", profiles: 0 }).disabled).toBe(true);
  });

  it("says it is working while the import runs, and will not start a second one", () => {
    expect(primary({ choice: "browser", profiles: 2, busy: true })).toEqual({
      label: "Bringing it over…",
      disabled: true,
      loading: true,
    });
  });

  it("continues once an import has run, whatever is still ticked", () => {
    expect(primary({ choice: "browser", profiles: 2, imported: true })).toEqual({
      label: "Continue",
      disabled: false,
      loading: false,
    });
  });
});

describe("what the walkthrough promises about storage", () => {
  it("keeps the Mac's own wording on the desktop", () => {
    expect(aboutCopy("native").aside).toBe(
      "Kept on this Mac, in Settings → Memory. The recording goes to the model once, for the words, and nowhere else.",
    );
    expect(aboutCopy("native").recording).toBe(
      "A few sentences is plenty. Sent to your model provider once, for the words — nothing else leaves this Mac.",
    );
    expect(appearanceCopy("native").aside).toBe(
      "Appearance is a per-machine preference: it stays on this Mac. Sessions and Spaces are what travel between your devices.",
    );
  });

  it("promises the account's keys and sync in a browser tab, not a Mac", () => {
    const about = aboutCopy("stream");
    // The whole point: a tab has no Mac to keep anything on, and saying it
    // does is a false promise about storage rather than a stale phrasing.
    expect(about.aside).not.toMatch(/Mac/u);
    expect(about.recording).not.toMatch(/Mac/u);
    // What IS true: the host writes it into the account's memory, sealed and
    // synced, and the audio still only goes to the model for the words.
    expect(about.aside).toMatch(/memory/iu);
    expect(about.aside).toMatch(/sealed under this account's keys/u);
    expect(about.aside).toMatch(/synced to your devices/u);
    expect(about.aside).toMatch(/Settings → Memory/u);
    expect(about.recording).toMatch(/sealed under this account's keys/u);
  });

  it("says appearance is the account's synced setting in a browser tab", () => {
    const appearance = appearanceCopy("stream").aside;
    expect(appearance).not.toMatch(/Mac/u);
    expect(appearance).not.toMatch(/per-machine/u);
    expect(appearance).toMatch(/synced settings/u);
    expect(appearance).toMatch(/every device that reads them/u);
  });

  it("says something different on each surface, for every string", () => {
    // A helper that forgot its branch would pass every assertion above by
    // returning the web wording twice, or the Mac's.
    expect(aboutCopy("stream").aside).not.toBe(aboutCopy("native").aside);
    expect(aboutCopy("stream").recording).not.toBe(aboutCopy("native").recording);
    expect(appearanceCopy("stream").aside).not.toBe(appearanceCopy("native").aside);
  });

  it("leaves no 'this Mac' anywhere the walkthrough can show it on the web", () => {
    for (const line of [
      aboutCopy("stream").aside,
      aboutCopy("stream").recording,
      appearanceCopy("stream").aside,
      IMPORT_ON_THE_WEB.blurb,
      IMPORT_ON_THE_WEB.aside,
      IMPORT_ON_THE_WEB.reason,
      IMPORT_ON_THE_WEB.sync,
      IMPORT_ON_THE_WEB.download,
    ]) {
      expect(line).not.toMatch(/this Mac/u);
    }
  });
});
