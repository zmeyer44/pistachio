import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SettingsStore } from "../src/main/settings-store";
import { DEFAULT_SHORTCUTS } from "@pistachio/shell-contracts/shortcuts";
import { HOME_PAGE_URL } from "@pistachio/shell-contracts/home";
import {
  applySettingsPatch,
  DEFAULT_SETTINGS,
  grantMethods,
  isSettingsSection,
  sanitizeSettings,
  SETTINGS_SECTIONS,
} from "@pistachio/shell-contracts/settings";

describe("isSettingsSection", () => {
  it("accepts the sections the renderer has", () => {
    expect(isSettingsSection("")).toBe(true);
    expect(isSettingsSection("privacy/spaces")).toBe(true);
  });

  it("accepts the identity sections (docs/cloud-sync-design.md §10.6)", () => {
    // Account, Devices, and Sync are addresses like any other section: main
    // validates a deep link against this list before the renderer routes it.
    expect(isSettingsSection("account")).toBe(true);
    expect(isSettingsSection("devices")).toBe(true);
    expect(isSettingsSection("sync")).toBe(true);
    expect(isSettingsSection("cloud")).toBe(true);
    expect(isSettingsSection("egress")).toBe(true);
    expect(SETTINGS_SECTIONS.account).toBe("Account");
    expect(SETTINGS_SECTIONS.devices).toBe("Devices");
    expect(SETTINGS_SECTIONS.sync).toBe("Sync");
    expect(SETTINGS_SECTIONS.cloud).toBe("Cloud browser");
    expect(SETTINGS_SECTIONS.egress).toBe("Identity egress");
  });

  it("keeps every section's label distinct, so the command palette cannot offer two of the same", () => {
    const labels = Object.values(SETTINGS_SECTIONS);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("refuses anything else — Object.prototype's keys included", () => {
    // The guard checks a section name that crossed a process boundary; an
    // `in` check would let "constructor" through and index a function.
    expect(isSettingsSection("nope")).toBe(false);
    expect(isSettingsSection("constructor")).toBe(false);
    expect(isSettingsSection("__proto__")).toBe(false);
    expect(isSettingsSection("hasOwnProperty")).toBe(false);
    expect(isSettingsSection(3)).toBe(false);
  });
});

describe("the cloud preference", () => {
  it("starts off and survives a round trip; anything else falls back", () => {
    // WHETHER a Space may run in the cloud is the control plane's answer
    // (cloud:enable); this is only where the console sends the next task.
    expect(DEFAULT_SETTINGS.cloud).toEqual({ runByDefault: false });
    expect(sanitizeSettings({ cloud: { runByDefault: true } }).cloud.runByDefault).toBe(true);
    expect(sanitizeSettings({ cloud: { runByDefault: "yes" } }).cloud.runByDefault).toBe(false);
    expect(sanitizeSettings({ cloud: 7 }).cloud).toEqual(DEFAULT_SETTINGS.cloud);
    expect(applySettingsPatch(DEFAULT_SETTINGS, { cloud: { runByDefault: true } }).cloud.runByDefault).toBe(true);
  });
});

describe("sanitizeSettings", () => {
  it("reads the retired demo prefill as no default instructions", () => {
    const retired = "Reconcile this invoice, document the variance, and pause before submission.";
    expect(sanitizeSettings({ delegation: { defaultIntent: retired } }).delegation.defaultIntent).toBe("");
    expect(sanitizeSettings({ delegation: { defaultIntent: "Be concise." } }).delegation.defaultIntent).toBe("Be concise.");
  });

  it("returns defaults for garbage", () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings("nope")).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings({ general: 4 })).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps valid fields and falls back per field", () => {
    const next = sanitizeSettings({
      delegation: { capsuleMinutes: 60, maxInteractions: 7, allowWrites: "yes" },
      approvals: { expiryMinutes: 2 },
    });
    expect(next.delegation.capsuleMinutes).toBe(60);
    expect(next.delegation.maxInteractions).toBe(DEFAULT_SETTINGS.delegation.maxInteractions);
    expect(next.delegation.allowWrites).toBe(DEFAULT_SETTINGS.delegation.allowWrites);
    expect(next.approvals.expiryMinutes).toBe(2);
  });

  it("sanitizes appearance and shortcut sections without losing other defaults", () => {
    const next = sanitizeSettings({
      appearance: { scheme: "dark", colors: ["#123456"], radius: 14 },
      shortcuts: { ...DEFAULT_SETTINGS.shortcuts, newTab: "Mod+K" },
    });
    expect(next.appearance).toMatchObject({ scheme: "dark", colors: ["#123456"], radius: 14 });
    expect(next.shortcuts.newTab).toBe("Mod+K");
    expect(next.shortcuts.closeTab).toBe(DEFAULT_SETTINGS.shortcuts.closeTab);
    expect(next.general).toEqual(DEFAULT_SETTINGS.general);
  });

  it("keeps the organization's preset links that a tab could load, titled, deduplicated, and capped", () => {
    const next = sanitizeSettings({
      organization: {
        presetLinks: [
          { title: "  Portal ", url: "https://portal.example/" },
          { url: "https://www.docs.example/handbook" },
          { title: "Demo", url: "pistachio://demo/invoices" },
          { title: "Nope", url: "javascript:alert(1)" },
          { title: "Dup", url: "https://portal.example/" },
          "garbage",
        ],
      },
    });
    expect(next.organization.presetLinks).toEqual([
      { title: "Portal", url: "https://portal.example/" },
      { title: "docs.example", url: "https://www.docs.example/handbook" },
      { title: "Demo", url: "pistachio://demo/invoices" },
    ]);
    expect(sanitizeSettings({ organization: { presetLinks: "no" } }).organization.presetLinks).toEqual([]);
    const many = Array.from({ length: 40 }, (_, i) => ({ title: String(i), url: `https://${String(i)}.example/` }));
    expect(sanitizeSettings({ organization: { presetLinks: many } }).organization.presetLinks).toHaveLength(24);
  });

  it("migrates the former workspace key into Organization settings", () => {
    expect(sanitizeSettings({ workspace: { presetLinks: [{ title: "Portal", url: "https://portal.example" }] } }).organization.presetLinks)
      .toEqual([{ title: "Portal", url: "https://portal.example" }]);
  });

  it("starts in the vertical sidebar layout with the sidebar pinned", () => {
    expect(DEFAULT_SETTINGS.layout).toEqual({ mode: "sidebar", sidebar: "pinned" });
    expect(sanitizeSettings(null).layout).toEqual({ mode: "sidebar", sidebar: "pinned" });
  });

  it("refuses an unknown layout mode or presentation per field, keeping the valid one", () => {
    // A layout the renderer does not have would leave the chrome nowhere;
    // each field falls back on its own so the good half survives.
    expect(sanitizeSettings({ layout: { mode: "left", sidebar: "compact" } }).layout).toEqual({
      mode: "sidebar",
      sidebar: "compact",
    });
    expect(sanitizeSettings({ layout: { mode: "sidebar", sidebar: 3 } }).layout).toEqual({
      mode: "sidebar",
      sidebar: "pinned",
    });
    expect(sanitizeSettings({ layout: "sidebar" }).layout).toEqual(DEFAULT_SETTINGS.layout);
  });

  it("starts the home page at Pistachio's own and accepts any address a tab may load", () => {
    expect(DEFAULT_SETTINGS.general).toMatchObject({ homePage: "pistachio", homeUrl: HOME_PAGE_URL });
    expect(sanitizeSettings({}).general).toMatchObject({ homePage: "pistachio", homeUrl: HOME_PAGE_URL });
    expect(sanitizeSettings({ general: { homePage: "url", homeUrl: "https://example.com" } }).general).toMatchObject({
      homePage: "url",
      homeUrl: "https://example.com/",
    });
    // The demo portal is the app's own page; a person may put it back.
    expect(sanitizeSettings({ general: { homePage: "url", homeUrl: "pistachio://demo/invoices" } }).general.homeUrl).toBe(
      "pistachio://demo/invoices",
    );
    // Choosing Pistachio's page resolves the address, whatever custom one is still stored.
    expect(sanitizeSettings({ general: { homePage: "pistachio", homeUrl: "https://example.com" } }).general.homeUrl).toBe(
      HOME_PAGE_URL,
    );
  });

  it("reads a file from before the home page: Google was the default, anything else was chosen", () => {
    expect(sanitizeSettings({ general: { homeUrl: "https://www.google.com/" } }).general).toMatchObject({
      homePage: "pistachio",
      homeUrl: HOME_PAGE_URL,
    });
    expect(sanitizeSettings({ general: { homeUrl: "https://news.example/" } }).general).toMatchObject({
      homePage: "url",
      homeUrl: "https://news.example/",
    });
    // Google chosen from here on is written with its behavior, and kept.
    expect(sanitizeSettings({ general: { homePage: "url", homeUrl: "https://www.google.com/" } }).general.homeUrl).toBe(
      "https://www.google.com/",
    );
  });

  it("refuses a home page a tab could not load, falling back to the default", () => {
    for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "", "not a url", 42]) {
      expect(sanitizeSettings({ general: { homePage: "url", homeUrl: bad } }).general).toMatchObject({
        homePage: "pistachio",
        homeUrl: HOME_PAGE_URL,
      });
    }
  });

  it("opens the home page on a new tab by default, and keeps the address bar a choice", () => {
    expect(DEFAULT_SETTINGS.general.newTab).toBe("home");
    // "blank" was the address bar while it was the default.
    expect(sanitizeSettings({ general: { newTab: "blank" } }).general.newTab).toBe("home");
    expect(sanitizeSettings({ general: { newTab: "address" } }).general.newTab).toBe("address");
  });

  it("refuses a non-web new tab page and drops back to the home page", () => {
    expect(sanitizeSettings({ general: { newTab: "url", newTabUrl: "file:///etc/passwd" } }).general).toMatchObject({
      newTab: "home",
      newTabUrl: "",
    });
    expect(sanitizeSettings({ general: { newTab: "url", newTabUrl: "https://example.com" } }).general).toMatchObject({
      newTab: "url",
      newTabUrl: "https://example.com/",
    });
  });
});

describe("applySettingsPatch", () => {
  it("takes a written home address as choosing it", () => {
    const next = applySettingsPatch(DEFAULT_SETTINGS, { general: { homeUrl: "https://home.example" } });
    expect(next.general).toMatchObject({ homePage: "url", homeUrl: "https://home.example/" });
    expect(applySettingsPatch(next, { general: { homePage: "pistachio" } }).general.homeUrl).toBe(HOME_PAGE_URL);
  });

  it("merges one section without touching the others", () => {
    const next = applySettingsPatch(DEFAULT_SETTINGS, { privacy: { rememberRecents: false } });
    expect(next.privacy.rememberRecents).toBe(false);
    expect(next.delegation).toEqual(DEFAULT_SETTINGS.delegation);
  });

  it("merges one appearance value and one binding without resetting their sections", () => {
    const themed = applySettingsPatch(DEFAULT_SETTINGS, { appearance: { intensity: 0.8 } });
    expect(themed.appearance.intensity).toBe(0.8);
    expect(themed.appearance.colors).toEqual(DEFAULT_SETTINGS.appearance.colors);
    const rebound = applySettingsPatch(themed, { shortcuts: { newTab: "Mod+K" } });
    expect(rebound.shortcuts.newTab).toBe("Mod+K");
    expect(rebound.shortcuts.closeTab).toBe(DEFAULT_SETTINGS.shortcuts.closeTab);
  });

  it("refuses a binding another action holds instead of unassigning that action", () => {
    // New tab moved to ⌘K, Edit address took the freed ⌘T: resetting New tab
    // to its default must not silently clear Edit address.
    const moved = applySettingsPatch(DEFAULT_SETTINGS, { shortcuts: { newTab: "Mod+K" } });
    const swapped = applySettingsPatch(moved, { shortcuts: { editAddress: "Mod+T" } });
    expect(swapped.shortcuts.editAddress).toBe("Mod+T");
    expect(() => applySettingsPatch(swapped, { shortcuts: { newTab: "Mod+T" } })).toThrow(/Edit address/);
    // A whole-table reset is judged as one: the defaults never clash.
    expect(applySettingsPatch(swapped, { shortcuts: DEFAULT_SHORTCUTS }).shortcuts).toEqual(DEFAULT_SHORTCUTS);
    // Re-asserting the binding an action already has is not a clash.
    expect(applySettingsPatch(swapped, { shortcuts: { editAddress: "Mod+T" } }).shortcuts.editAddress).toBe("Mod+T");
  });

  it("switches the layout without disturbing the sidebar's presentation or other sections", () => {
    const next = applySettingsPatch(DEFAULT_SETTINGS, { layout: { mode: "top" } });
    expect(next.layout).toEqual({ mode: "top", sidebar: "pinned" });
    expect(next.general).toEqual(DEFAULT_SETTINGS.general);
    expect(next.delegation).toEqual(DEFAULT_SETTINGS.delegation);
    expect(next.privacy).toEqual(DEFAULT_SETTINGS.privacy);
    // And back: a compact sidebar stays compact through a round trip to top tabs.
    const compact = applySettingsPatch(next, { layout: { sidebar: "compact" } });
    expect(applySettingsPatch(compact, { layout: { mode: "sidebar" } }).layout).toEqual({
      mode: "sidebar",
      sidebar: "compact",
    });
  });

  it("narrows the grant's methods when writes are off", () => {
    const next = applySettingsPatch(DEFAULT_SETTINGS, { delegation: { allowWrites: false } });
    expect(grantMethods(next)).toEqual(["GET", "HEAD", "OPTIONS"]);
    expect(grantMethods(DEFAULT_SETTINGS)).toContain("POST");
  });
});

describe("provider keys from older builds", () => {
  const scratchDirs: string[] = [];
  const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "pistachio-settings-"));
    scratchDirs.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  });

  it("drops a stored `ai` section rather than carrying keys the app no longer reads", () => {
    const next = sanitizeSettings({ ai: { provider: "gateway", gatewayApiKey: "vck_abc" } });
    expect("ai" in next).toBe(false);
    expect(isSettingsSection("ai")).toBe(false);
  });

  it("scrubs the key from disk on the first launch, before any setting changes", () => {
    const dir = scratch();
    const path = join(dir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({ ai: { provider: "gateway", gatewayApiKey: "vck_abc" }, layout: { sidebar: "compact" } }),
    );

    const store = new SettingsStore(dir);
    expect(store.get().layout.sidebar).toBe("compact");
    const onDisk = readFileSync(path, "utf8");
    expect(onDisk).not.toContain("vck_abc");
    expect("ai" in (JSON.parse(onDisk) as object)).toBe(false);
    expect((JSON.parse(onDisk) as { layout: { sidebar: string } }).layout.sidebar).toBe("compact");
  });

  it("leaves a file without provider keys alone at startup", () => {
    const dir = scratch();
    const path = join(dir, "settings.json");
    const written = JSON.stringify({ layout: { sidebar: "compact" } });
    writeFileSync(path, written);
    new SettingsStore(dir);
    expect(readFileSync(path, "utf8")).toBe(written);
  });
});

describe("desktop icon preference", () => {
  it("defaults new and older profiles to white and rejects unknown styles", () => {
    expect(DEFAULT_SETTINGS.appearance.desktopIcon).toBe("white");
    expect(sanitizeSettings({ appearance: { scheme: "dark" } }).appearance.desktopIcon).toBe("white");
    expect(sanitizeSettings({ appearance: { desktopIcon: "purple" } }).appearance.desktopIcon).toBe("white");
  });

  it("persists green across restarts, preserves it in other edits, and restores white", () => {
    const dir = mkdtempSync(join(tmpdir(), "pistachio-icon-"));
    try {
      const store = new SettingsStore(dir);
      store.update({ appearance: { desktopIcon: "green" } });
      store.update({ appearance: { scheme: "dark" } });
      expect(new SettingsStore(dir).get().appearance).toMatchObject({ desktopIcon: "green", scheme: "dark" });
      store.reset();
      expect(new SettingsStore(dir).get().appearance.desktopIcon).toBe("white");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
