/**
 * The shell's answer to "where does this live?", on both surfaces
 * (docs/web-browser-design.md §6.3, §11; `lib/surface-copy.ts`).
 *
 * Two risks, and a test for each.
 *
 * The first is the one that matters to the person: a browser tab that says
 * "kept on this Mac" is not making a stale claim, it is making a FALSE
 * PROMISE ABOUT STORAGE. There is no Mac under a tab. So every `stream`
 * sentence is checked for the words a Mac's copy uses, and — because a
 * helper that forgot its branch would pass that by returning the Mac's
 * wording once and the same wording again — each is checked against its
 * `native` twin as well.
 *
 * The second is the one that matters to the desktop: making copy
 * surface-aware is exactly how a surface that already worked starts saying
 * something new. So every `native` string is pinned here, byte for byte, as
 * the literal that stood in the component before the module existed.
 *
 * The third test is about DRIFT. A table of copy is only true while nothing
 * is written outside it, so the last test greps the source tree the way the
 * inventory did and insists every hit is either in the copy module, in a
 * file that never renders on a stream surface (with the reason recorded
 * beside it), or in a comment.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MANAGED_ELSEWHERE } from "../src/lib/chrome-status";
import { copyFor, SURFACE_COPY, type CopySurface, type SurfaceCopy } from "../src/lib/surface-copy";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/* --------------------------- walking the record --------------------------- */

/** Every sentence one surface can say, as `area.key` → the words. */
function sentences(surface: CopySurface): Map<string, string> {
  const out = new Map<string, string>();
  const copy = copyFor(surface) as unknown as Record<string, Record<string, unknown>>;
  for (const [area, group] of Object.entries(copy)) {
    for (const [key, value] of Object.entries(group)) {
      // The few entries that take a value (a time zone, a queue's words) are
      // functions; a sample argument makes them a sentence like the rest.
      out.set(`${area}.${key}`, typeof value === "function" ? String(value("SAMPLE")) : String(value));
    }
  }
  return out;
}

/* ------------------------- the desktop's own words ------------------------ */

describe("what the Mac app says", () => {
  it("says exactly what it said before the copy became surface-aware", () => {
    const native = copyFor("native");
    // Settings, its rail, and the page it opens on.
    expect(native.settings.lede).toBe("Preferences, kept on this Mac");
    expect(native.nav.account).toBe("Sign in, recovery, this Mac");
    // Appearance.
    expect(native.appearance.description).toBe(
      "Shape the whole window material. Themes stay on this Mac and update as you edit.",
    );
    expect(native.appearance.colorMode).toBe("System follows macOS appearance changes automatically.");
    expect(native.appearance.desktopGlass).toBe(
      "Blur the macOS desktop beneath the sidebar and window chrome. Webpages stay opaque.",
    );
    expect(native.appearance.desktopGlassUnsupported).toBe("Native desktop blur is currently available on macOS.");
    expect(native.appearance.materialFooter).toBe("Appearance is stored on this Mac and never synced.");
    // Privacy & security.
    expect(native.privacy.siteData).toBe("What your browsing session keeps on this Mac, and how to clear it.");
    expect(native.privacy.recents).toBe(
      "The chips in the address bar. Kept on this Mac only, in the chrome's own storage — never in a page's.",
    );
    expect(native.privacy.betweenDevicesTitle).toBe("Between your machines");
    expect(native.privacy.betweenDevices).toBe(
      "What a Space carries to your other devices, and what never leaves this one.",
    );
    expect(native.privacy.sessions).toBe(
      "With an account, a Space's sign-ins converge across your enrolled devices, sealed under a key derived for that Space alone — the hub stores ciphertext. Without an account, nothing leaves this Mac. Settings → Sync says which sites take part.",
    );
    expect(native.privacy.preferencesLabel).toBe("Preferences stay on this Mac");
    expect(native.privacy.preferences).toBe(
      "Settings, shortcuts, and appearance are per-machine. Organization policies and preset links may be shared; your preferences are not.",
    );
    expect(native.privacy.liveTabs).toBe(
      "How a task run here, on this Mac, relates to the sites you are signed in to. Settings → Agent lists what it can do in them.",
    );
    expect(native.privacy.cloudEgress).toBe(
      "Each run goes out through the egress gateway on a credential minted for that run and revoked when it ends — however it ends. Site state that changed during the run reaches this Mac only through the Space's sync, under your own keys.",
    );
    // Memory.
    expect(native.memory.followSystemZone("Europe/Berlin")).toBe("Follow this Mac — Europe/Berlin");
    expect(native.memory.useMemory).toBe("Memory is stored on this Mac, in its own file, and never synced.");
    expect(native.memory.forgetEverything).toBe(
      "Every fact in use is marked forgotten. The history stays on this Mac until it is pruned, so anything forgotten by mistake can be restored from the list above.",
    );
    // Bookmarks and reminders, in their windows and in their sections.
    expect(native.bookmarks.scope).toBe("this Mac only");
    expect(native.bookmarks.enrich).toBe(
      "The page's text and tags are sent to the model your account provides to name the thing, describe it, and pick its facts and keywords. Off reads only the page's own tags, which is instant and stays on this Mac.",
    );
    expect(native.reminders.scope).toBe("this Mac only");
    expect(native.reminders.systemZone("Europe Berlin")).toBe("Europe Berlin (this Mac)");
    expect(native.reminders.unknownZone).toBe("That time zone is not one this Mac knows.");
    // About and approvals.
    expect(native.about.thisApp).toBe("What is installed on this Mac, and where it keeps its settings.");
    expect(native.approvals.alerts).toBe("How this Mac tells you a run is waiting.");
    expect(native.approvals.desktopNotifications).toBe(
      "A macOS notification for each pause, judgment, step-up, and completion. Clicking it brings the window forward.",
    );
  });

  it("pins every entry, so a new one cannot be added without a wording to pin", () => {
    // The count is the guard: an area added to `SurfaceCopy` and left out of
    // the snapshot above would otherwise sail through unchecked.
    expect(sentences("native").size).toBe(27);
  });
});

/* --------------------------- the browser tab's ---------------------------- */

describe("what a browser tab says", () => {
  it("promises no Mac, no machine, and no disk anywhere", () => {
    for (const [key, line] of sentences("stream")) {
      expect(`${key}: ${line}`).not.toMatch(/this Mac/u);
      expect(`${key}: ${line}`).not.toMatch(/your Mac/iu);
      expect(`${key}: ${line}`).not.toMatch(/per-machine/u);
      expect(`${key}: ${line}`).not.toMatch(/on disk/iu);
      expect(`${key}: ${line}`).not.toMatch(/this machine/iu);
      expect(`${key}: ${line}`).not.toMatch(/this computer/iu);
    }
  });

  it("says something of its own wherever the Mac's wording names a Mac", () => {
    const native = sentences("native");
    const stream = sentences("stream");
    expect([...stream.keys()]).toEqual([...native.keys()]);
    for (const [key, mac] of native) {
      if (!/mac|machine|disk|computer/iu.test(mac)) continue;
      expect(`${key}: ${stream.get(key) ?? ""}`).not.toBe(`${key}: ${mac}`);
    }
  });

  it("says what the host actually does with what it is given", () => {
    const stream = copyFor("stream");
    // Settings are the sealed account-global `shell-settings:default`
    // register, so they are synced rather than local (§6.3).
    expect(stream.settings.lede).toMatch(/synced to your account/u);
    expect(stream.appearance.materialFooter).toMatch(/synced settings/u);
    expect(stream.privacy.preferences).toMatch(/synced settings/u);
    // Memory, bookmarks and reminders are written by the host AS THE PERSON,
    // under this account's keys, through the same registers the agent's tool
    // hosts use (§11) — so they converge rather than sit in a file.
    expect(stream.memory.useMemory).toMatch(/sealed under this account's keys/u);
    expect(stream.memory.useMemory).toMatch(/synced to your devices/u);
    expect(stream.bookmarks.scope).toMatch(/synced to your devices/u);
    expect(stream.reminders.scope).toMatch(/synced to your devices/u);
    // The pane is a picture: the tab never holds a cookie (security.md).
    expect(stream.privacy.sessions).toMatch(/pixels/u);
  });

  it("leaves the account family to the web app rather than repeating a reason", () => {
    // Account, devices, sync, cloud, egress, the vault and integrations are
    // "managed from the web app's settings pages" (§11) and render
    // `Unavailable` with the HOST's own sentence. What this module owns for
    // them is only what renders anyway: the nav caption and the chrome rows.
    expect(copyFor("stream").nav.account).not.toMatch(/Mac/u);
    // The chrome's status card says it once, in `lib/chrome-status.ts`, for
    // all four subjects at once — not four times here.
    expect(MANAGED_ELSEWHERE).toBe("Account, sync, cloud and egress are managed from the web app");
  });
});

/* ------------------------------- no drift -------------------------------- */

/**
 * Files whose strings a stream surface NEVER renders, and why. Anything else
 * that names a Mac has to move into the copy module.
 */
const NATIVE_ONLY: Record<string, string> = {
  // Every section the host refuses whole (§11): its body never mounts in a
  // tab, because `useUnavailable` swaps it for `Unavailable` and the host's
  // own reason. Duplicating that reason here is exactly what we must not do.
  "components/settings/sections/account.tsx": "managed from the web app; renders Unavailable",
  "components/settings/sections/devices.tsx": "managed from the web app; renders Unavailable",
  "components/settings/sections/sync.tsx": "managed from the web app; renders Unavailable",
  "components/settings/sections/cloud.tsx": "managed from the web app; renders Unavailable",
  "components/settings/sections/egress.tsx": "managed from the web app; renders Unavailable",
  "components/settings/sections/vault.tsx": "managed from the web app; renders Unavailable",
  "components/settings/sections/integrations.tsx": "managed from the web app; renders Unavailable",
  // The confirm dialog those sections raise, and the account state they read.
  "components/settings/dialogs.tsx": "only opened from the account and devices sections",
  "lib/account.ts": "the account pages' own view model",
  // The walkthrough. Its sign-in form is not offered on a stream surface
  // (`canSignIn` is false there), the import step is replaced whole by
  // `IMPORT_ON_THE_WEB`, and the two steps that differ in one sentence read
  // it from `lib/onboarding-steps.ts`.
  "components/onboarding/OnboardingWizard.tsx": "the sign-in form is never offered on a stream surface",
  "components/onboarding/SignInPanel.tsx": "the sign-in form is never offered on a stream surface",
  "components/onboarding/steps/ImportStep.tsx": "the native import view; a tab renders ImportOnTheWeb",
  "lib/onboarding-steps.ts": "the walkthrough's own surface-aware copy (§14)",
  // The console's "run in the cloud" control renders only where the host
  // publishes a cloud status (`cloud.available`), which no session host does:
  // the session already runs in the cloud browser.
  "components/AgentConsole.tsx": "the cloud toggle renders only where a cloud status is published",
  "lib/cloud.ts": "cloudReadiness is read behind the same cloud.available gate",
  // The three planes fold into one "managed from the web app" row on a stream
  // surface (`planesFor`), and the sync pill drops its sync states there, so
  // everything these three say about a hub, a gateway or an enrolled machine
  // is now the desktop's alone.
  "lib/sync.ts": "the sync section and the pill's sync states are the desktop's",
  "lib/egress.ts": "the egress section and the egress plane are the desktop's",
  "lib/chrome-status.ts": "the three plane rows fold into one on a stream surface",
  // The module itself: the Mac's own wording is the point.
  "lib/surface-copy.ts": "the copy module",
};

const PATTERNS = [/this mac/iu, /your mac/iu, /this machine/iu, /per-machine/iu, /on disk/iu, /this computer/iu, /macos/iu];

/** A line the reader never sees: a comment, or the opening of one. */
function isComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*");
}

function sourceFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(join(dir, entry.name), rel));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(rel);
  }
  return out;
}

describe("nothing says it outside the copy module", () => {
  it("finds no Mac-naming string left in a file a browser tab renders", () => {
    const stray: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (file in NATIVE_ONLY) continue;
      const lines = readFileSync(join(SRC, file), "utf8").split("\n");
      lines.forEach((line, index) => {
        if (isComment(line)) return;
        if (!PATTERNS.some((pattern) => pattern.test(line))) return;
        stray.push(`${file}:${String(index + 1)}: ${line.trim()}`);
      });
    }
    // The message is the point of the test: it names the line to move.
    expect(stray).toEqual([]);
  });

  it("keeps the allowlist honest: every entry names a file that exists and still needs it", () => {
    const files = new Set(sourceFiles(SRC));
    for (const [file, reason] of Object.entries(NATIVE_ONLY)) {
      expect(files.has(file), `${file} is allowlisted but does not exist`).toBe(true);
      expect(reason.length > 10, `${file} needs a reason`).toBe(true);
      const hit = readFileSync(join(SRC, file), "utf8")
        .split("\n")
        .some((line) => !isComment(line) && PATTERNS.some((pattern) => pattern.test(line)));
      expect(hit, `${file} no longer names a Mac; drop it from the allowlist`).toBe(true);
    }
  });
});

/* --------------------------- the accessor itself -------------------------- */

describe("copyFor", () => {
  it("hands back the surface's own record, and nothing shared between them", () => {
    expect(copyFor("native")).toBe(SURFACE_COPY.native);
    expect(copyFor("stream")).toBe(SURFACE_COPY.stream);
    const areas = Object.keys(SURFACE_COPY.native) as (keyof SurfaceCopy)[];
    expect(Object.keys(SURFACE_COPY.stream)).toEqual(areas);
    for (const area of areas) expect(SURFACE_COPY.stream[area]).not.toBe(SURFACE_COPY.native[area]);
  });
});
