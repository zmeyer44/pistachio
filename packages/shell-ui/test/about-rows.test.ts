/**
 * Settings → About, on the two things the shell runs in.
 *
 * The bug this pins was not a wrong sentence but a row built from a field the
 * host does not have. A session host answers `getAppInfo` with a version, a
 * Chromium version and `platform: "web"` and nothing else
 * (docs/web-browser-design.md §6.3), and the page used to render its
 * `electron` and `userDataPath` anyway — as an empty gap after "Electron" and
 * as a settings path of "/settings.json". Both are now optional on `AppInfo`,
 * the host omits them, and the row list is chosen by surface instead.
 *
 * The desktop's four rows are pinned character for character, because the
 * whole risk of choosing rows by surface is that the surface that already
 * worked stops saying what it said.
 */

import { describe, expect, it } from "vitest";
import type { AppInfo } from "@pistachio/shell-contracts/ipc";
import { aboutRowsFor, type AboutRow } from "../src/lib/about-rows";

const DESKTOP: AppInfo = {
  version: "0.0.3",
  electron: "33.2.1",
  chrome: "130.0.6723.44",
  platform: "darwin",
  userDataPath: "/Users/ada/Library/Application Support/Pistachio",
};

/** Exactly what `ShellHost.getAppInfo` answers: three fields, no more. */
const HOSTED: AppInfo = { version: "0.0.3", chrome: "141.0.7390.54", platform: "web" };

function noteOf(rows: AboutRow[], key: AboutRow["key"]): string {
  const row = rows.find((candidate) => candidate.key === key);
  if (row === undefined) throw new Error(`no ${key} row`);
  return `${row.label}: ${row.note}`;
}

describe("About on a Mac", () => {
  it("says exactly what it said before the rows were chosen by surface", () => {
    const rows = aboutRowsFor(DESKTOP, "native");
    expect(rows.map((row) => row.key)).toEqual(["app", "runtime", "settings", "license"]);
    expect(noteOf(rows, "app")).toBe("Pistachio: Version 0.0.3 · darwin");
    expect(noteOf(rows, "runtime")).toBe("Runtime: Electron 33.2.1 · Chromium 130.0.6723.44");
    expect(noteOf(rows, "settings")).toBe(
      "Settings file: /Users/ada/Library/Application Support/Pistachio/settings.json",
    );
    expect(noteOf(rows, "license")).toBe(
      "License: GPL-3.0. Source and security model are in the repository's docs/.",
    );
    // The path is the one value a reader copies, and the only mono row.
    expect(rows.filter((row) => row.mono).map((row) => row.key)).toEqual(["settings"]);
  });

  it("shows the waiting mark until the host has answered, and never a mono blank", () => {
    const rows = aboutRowsFor(null, "native");
    expect(rows.map((row) => row.note)).toEqual([
      "…",
      "…",
      "…",
      "GPL-3.0. Source and security model are in the repository's docs/.",
    ]);
    expect(rows.some((row) => row.mono)).toBe(false);
  });
});

describe("About in a browser tab", () => {
  it("names what actually runs the chrome and what runs the pages", () => {
    const rows = aboutRowsFor(HOSTED, "stream");
    expect(rows.map((row) => row.key)).toEqual(["app", "runtime", "settings", "license"]);
    expect(noteOf(rows, "app")).toBe("Pistachio: Version 0.0.3 · web");
    expect(noteOf(rows, "runtime")).toBe(
      "Runs in: Your browser; pages run in the cloud browser on Chromium 141.0.7390.54",
    );
    expect(noteOf(rows, "settings")).toBe("Settings: This account's synced settings register");
    expect(noteOf(rows, "license")).toBe(
      "License: GPL-3.0. Source and security model are in the repository's docs/.",
    );
  });

  it("renders no gap, no stray slash, and no path — the whole bug", () => {
    for (const info of [HOSTED, null]) {
      for (const row of aboutRowsFor(info, "stream")) {
        const line = `${row.label}: ${row.note}`;
        expect(line).not.toContain("undefined");
        expect(line).not.toMatch(/Electron/u);
        expect(line).not.toMatch(/settings\.json/u);
        expect(line).not.toMatch(/^Settings: \//u);
        // Nothing here is a path, so nothing here is set in mono.
        expect(row.mono).toBe(false);
      }
    }
  });

  it("keeps the waiting mark, so a slow host is not a wrong claim", () => {
    const rows = aboutRowsFor(null, "stream");
    expect(noteOf(rows, "app")).toBe("Pistachio: …");
    expect(noteOf(rows, "runtime")).toBe("Runs in: …");
    // The settings row states no value of the host's, so it never waits.
    expect(noteOf(rows, "settings")).toBe("Settings: This account's synced settings register");
  });

  it("says something different from the Mac wherever the Mac names its machine", () => {
    const mac = aboutRowsFor(DESKTOP, "native");
    const web = aboutRowsFor(HOSTED, "stream");
    for (const key of ["runtime", "settings"] as const) {
      expect(noteOf(web, key)).not.toBe(noteOf(mac, key));
    }
  });
});
