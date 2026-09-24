/**
 * What Settings → About states about the thing it is running in.
 *
 * The page used to read `AppInfo` straight into four rows, and three of them
 * are the DESKTOP'S questions: which Electron, which Chromium, and the path
 * of the settings file on disk. A session host answers none of those — it is
 * a browser in a fleet, and the settings this shell reads and writes are the
 * account's sealed `shell-settings:default` register
 * (docs/web-browser-design.md §6.3). Before the fields became optional the
 * host sent empty strings for them and the page rendered "Electron  ·
 * Chromium 141" and a settings path of "/settings.json": two rows that were
 * not merely irrelevant but WRONG, on the one page whose subject is where
 * things are.
 *
 * So the rows are chosen by surface rather than the values patched. On a Mac
 * the four rows are exactly what they were, character for character. In a
 * browser tab the runtime row says what actually runs the pages — this
 * browser, and Chromium in the cloud browser — and the settings row names the
 * register instead of a path.
 *
 * Pure on purpose — `AppInfo` in, rows out — so `test/about-rows.test.ts`
 * pins both surfaces without a DOM. The row list is deliberately the same
 * shape and the same four keys on both, because the page's structure is not
 * what the surface changes.
 */

import type { AppInfo } from "@pistachio/shell-contracts/ipc";
import type { CopySurface } from "./surface-copy";

export interface AboutRow {
  key: "app" | "runtime" | "settings" | "license";
  label: string;
  note: string;
  /**
   * Render the note in the mono face. True only for a real path: a sentence
   * set in mono reads as a value the reader is meant to copy.
   */
  mono: boolean;
}

/** What every row shows before the first `getAppInfo` has answered. */
const PENDING = "…";

const LICENSE = "GPL-3.0. Source and security model are in the repository's docs/.";

/**
 * The About page's rows for this surface, with `info` as the host answered it
 * (null until it has).
 */
export function aboutRowsFor(info: AppInfo | null, surface: CopySurface): AboutRow[] {
  const app: AboutRow = {
    key: "app",
    label: "Pistachio",
    note: info === null ? PENDING : `Version ${info.version} · ${info.platform}`,
    mono: false,
  };
  const license: AboutRow = { key: "license", label: "License", note: LICENSE, mono: false };
  if (surface === "stream") {
    return [
      app,
      {
        key: "runtime",
        label: "Runs in",
        // Two runtimes, and the distinction is the product: the chrome is in
        // the reader's own browser, and the PAGES are Chromium's, elsewhere.
        note:
          info === null
            ? PENDING
            : `Your browser; pages run in the cloud browser on Chromium ${info.chrome}`,
        mono: false,
      },
      {
        key: "settings",
        label: "Settings",
        // The register, not a file: the same document every host of this
        // account reads on the way up (§6.3).
        note: "This account's synced settings register",
        mono: false,
      },
      license,
    ];
  }
  return [
    app,
    {
      key: "runtime",
      label: "Runtime",
      note: info === null ? PENDING : `Electron ${info.electron ?? ""} · Chromium ${info.chrome}`,
      mono: false,
    },
    {
      key: "settings",
      label: "Settings file",
      note: info === null ? PENDING : `${info.userDataPath ?? ""}/settings.json`,
      mono: info !== null,
    },
    license,
  ];
}
