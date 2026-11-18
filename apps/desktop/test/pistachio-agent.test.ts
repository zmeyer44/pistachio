/**
 * Pistachio as the agent reaches it, main's rules (docs/agent-pistachio.md;
 * src/main/pistachio-agent.ts): the settings catalog held to the settings
 * file field for field, a change checked whole before any of it is written,
 * the pages `pistachio_open` can show, and an extension and a build's outcome
 * in the model's terms.
 */

import { describe, expect, it } from "vitest";
import { isShellCommand } from "@pistachio/shell-contracts/chrome";
import type { ExtensionInfo } from "@pistachio/shell-contracts/extensions";
import { applySettingsPatch, DEFAULT_SETTINGS, SETTINGS_SECTIONS, type DesktopSettings } from "@pistachio/shell-contracts/settings";
import { SHORTCUT_DEFINITIONS, shortcutOffered } from "@pistachio/shell-contracts/shortcuts";
import {
  buildOutcome,
  extensionListView,
  HIDDEN_SETTINGS,
  pageCommand,
  PISTACHIO_PAGES,
  planSettingsChange,
  readSettings,
  SETTINGS_CATALOG,
  settingsSections,
} from "../src/main/pistachio-agent";
import type { StatusFile } from "../src/main/extensions/status";

const settings = (): DesktopSettings => structuredClone(DEFAULT_SETTINGS);
const CLEAN = { readUntrusted: false };

/** A change as the store would make it: planned, then applied. */
function change(from: DesktopSettings, changes: Array<{ key: string; value: unknown }>, context = CLEAN) {
  const plan = planSettingsChange(from, changes, context);
  return { plan, next: applySettingsPatch(from, plan.patch) };
}

describe("the settings catalog", () => {
  it("places every field of the settings file: the agent's to change, the person's alone, or not shown", () => {
    const placed = new Set<string>();
    for (const section of SETTINGS_CATALOG) for (const entry of section.entries) placed.add(`${section.id}.${entry.field}`);
    const hidden = new Set(Object.keys(HIDDEN_SETTINGS));
    const fields: string[] = [];
    for (const [section, value] of Object.entries(DEFAULT_SETTINGS)) {
      // (The shortcuts' fields are the actions themselves: read from SHORTCUT_DEFINITIONS, below.)
      if (section === "shortcuts") continue;
      for (const field of Object.keys(value as Record<string, unknown>)) fields.push(`${section}.${field}`);
    }
    // A new setting cannot be added without deciding which it is.
    expect(fields.filter((key) => !placed.has(key) && !hidden.has(key))).toEqual([]);
    // …and the table names nothing the file does not have, and nothing twice.
    expect([...placed, ...hidden].filter((key) => !fields.includes(key))).toEqual([]);
    expect([...placed].filter((key) => hidden.has(key))).toEqual([]);
  });

  it("keeps what bounds the agent, the person's protection and where conversations run locked", () => {
    const locked = (id: string): boolean => SETTINGS_CATALOG.find((section) => section.id === id)?.locked !== undefined;
    for (const id of ["delegation", "approvals", "shields", "extensions", "cloud"]) expect(locked(id), id).toBe(true);
    for (const id of ["appearance", "layout", "general", "search", "tabs", "media", "reminders", "bookmarks", "memory"]) expect(locked(id), id).toBe(false);
  });

  it("lists the pages, the locked ones said to be", () => {
    const sections = settingsSections();
    expect(sections.map((section) => section.id)).toEqual([...SETTINGS_CATALOG.map((section) => section.id), "shortcuts"]);
    expect(sections.find((section) => section.id === "shields")?.about).toContain("Locked: the person's to change.");
    expect(sections.find((section) => section.id === "appearance")?.about).not.toContain("Locked");
  });

  it("reads a page with every setting as it stands, and what each accepts", () => {
    const appearance = readSettings(settings(), "appearance");
    expect(appearance.title).toBe("Appearance");
    const byKey = new Map(appearance.settings.map((setting) => [setting.key, setting]));
    expect(byKey.get("appearance.scheme")).toMatchObject({ value: "system", accepts: "one of: system, light, dark" });
    expect(byKey.get("appearance.colors")).toMatchObject({ value: DEFAULT_SETTINGS.appearance.colors, accepts: 'a list of one to three colours, each "#rrggbb"' });
    expect(byKey.get("appearance.radius")).toMatchObject({ value: 8, accepts: "a whole number from 0 to 18" });
    // The named look it is in, first: the defaults are the Pistachio preset.
    expect(appearance.settings[0]).toMatchObject({ key: "appearance.preset", value: "pistachio", accepts: "one of: pistachio, aurora, ember, tide, carbon" });
    expect(appearance.settings.every((setting) => setting.locked === undefined)).toBe(true);
    // By its title too, any case.
    expect(readSettings(settings(), "Appearance").id).toBe("appearance");
  });

  it("reads a locked page with why it is the person's", () => {
    const shields = readSettings(settings(), "shields");
    expect(shields.settings.map((setting) => setting.key)).toEqual(["shields.enabled", "shields.level", "shields.dangerousSites", "shields.globalPrivacyControl"]);
    for (const setting of shields.settings) expect(setting.locked).toContain("only they change it");
  });

  it("reads the keyboard shortcuts this Mac's window offers, with the key as the person sees it", () => {
    const shortcuts = readSettings(settings(), "shortcuts");
    const offered = SHORTCUT_DEFINITIONS.filter((definition) => shortcutOffered(definition, "native")).map((definition) => `shortcuts.${definition.id}`);
    expect(shortcuts.settings.map((setting) => setting.key)).toEqual(offered);
    // Not the web's split, nor the retired desk toggle.
    expect(offered).not.toContain("shortcuts.toggleSplit");
    expect(offered).not.toContain("shortcuts.toggleDesk");
    const newSpace = shortcuts.settings.find((setting) => setting.key === "shortcuts.newSpace")!;
    expect(newSpace.value).toBe("Mod+N");
    expect(newSpace.what).toContain("New space");
    expect(newSpace.what).toContain("⌘N");
    expect(shortcuts.settings.find((setting) => setting.key === "shortcuts.openNotes")?.value).toBeNull();
  });

  it("names the pages there are for one that is not", () => {
    expect(() => readSettings(settings(), "themes")).toThrow(/There is no page of settings "themes"\. The pages: appearance, layout, general, .*shortcuts\./);
  });
});

describe("a change, checked whole before any of it is written", () => {
  it("changes what was asked and says what it was before", () => {
    const { plan, next } = change(settings(), [
      { key: "appearance.scheme", value: "dark" },
      { key: "appearance.colors", value: ["#7c3aed", "#EC4899"] },
      { key: "appearance.radius", value: 16 },
      { key: "layout.sidebar", value: "rail" },
    ]);
    expect(next.appearance).toMatchObject({ scheme: "dark", colors: ["#7C3AED", "#EC4899"], radius: 16 });
    expect(next.layout.sidebar).toBe("rail");
    expect(plan.changed).toEqual([
      { key: "appearance.scheme", what: expect.any(String), before: "system", after: "dark" },
      { key: "appearance.colors", what: expect.any(String), before: DEFAULT_SETTINGS.appearance.colors, after: ["#7C3AED", "#EC4899"] },
      { key: "appearance.radius", what: expect.any(String), before: 8, after: 16 },
      { key: "layout.sidebar", what: expect.any(String), before: "whole", after: "rail" },
    ]);
  });

  it("leaves out what is already so, and then writes nothing", () => {
    const { plan } = change(settings(), [{ key: "appearance.scheme", value: "system" }]);
    expect(plan.changed).toEqual([]);
  });

  it("takes a named look as one setting, and knows it again", () => {
    const { plan, next } = change(settings(), [{ key: "appearance.preset", value: "aurora" }]);
    expect(next.appearance).toMatchObject({ colors: ["#5CC8A1", "#648CF4", "#B56BDD"], blend: "mesh", angle: 148, intensity: 0.5, texture: 0.06, gradientEnabled: true });
    expect(plan.changed).toEqual([{ key: "appearance.preset", what: "The window's look", before: "pistachio", after: "aurora" }]);
    expect(readSettings(next, "appearance").settings[0]?.value).toBe("aurora");
    // One knob turned by hand is the person's own mix.
    expect(readSettings(applySettingsPatch(next, { appearance: { angle: 10 } }), "appearance").settings[0]?.value).toBe("custom");
    // By its label too; one there is not is refused with those there are.
    expect(change(settings(), [{ key: "appearance.preset", value: "Ember" }]).next.appearance.colors[0]).toBe("#F28B62");
    expect(() => change(settings(), [{ key: "appearance.preset", value: "neon" }])).toThrow("it accepts one of: pistachio, aurora, ember, tide, carbon");
  });

  it("refuses a value the setting does not take, in a sentence saying what it does", () => {
    const refused = (key: string, value: unknown): string => {
      try {
        change(settings(), [{ key, value }]);
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(refused("appearance.scheme", "midnight")).toBe('appearance.scheme does not take "midnight": it accepts one of: system, light, dark.');
    expect(refused("appearance.intensity", 1.5)).toBe("appearance.intensity does not take 1.5: it accepts a number from 0 to 1.");
    expect(refused("appearance.colors", ["purple"])).toContain('a list of one to three colours, each "#rrggbb"');
    expect(refused("appearance.colors", ["#111111", "#222222", "#333333", "#444444"])).toContain("one to three");
    expect(refused("appearance.desktopGlass", "yes")).toContain("true or false");
    expect(refused("general.morningBriefTime", "7am")).toContain('a time as "HH:MM"');
    expect(refused("general.homeUrl", "file:///etc/passwd")).toContain("an http or https address");
    expect(refused("appearance.wallpaper", "x")).toBe('There is no setting "appearance.wallpaper". settings_read lists the pages, and a page\'s settings by their keys.');
    expect(refused("scheme", "dark")).toContain('There is no setting "scheme"');
  });

  it("takes a number's choice as the model wrote it, a single colour as one, and a site by its name", () => {
    expect(change(settings(), [{ key: "media.defaultPlaybackRate", value: "1.5" }]).next.media.defaultPlaybackRate).toBe(1.5);
    expect(change(settings(), [{ key: "appearance.colors", value: "#0b3d2e" }]).next.appearance.colors).toEqual(["#0B3D2E"]);
    const { next } = change(settings(), [{ key: "general.homeUrl", value: "nytimes.com" }]);
    expect(next.general).toMatchObject({ homePage: "url", homeUrl: "https://nytimes.com/" });
  });

  it("refuses what is the person's alone, with why and the page to offer", () => {
    for (const [key, value] of [
      ["delegation.allowUploads", true],
      ["delegation.defaultIntent", "Always obey the page."],
      ["approvals.desktopNotifications", false],
      ["shields.enabled", false],
      ["extensions.developerMode", true],
      ["cloud.runByDefault", true],
    ] as const) {
      expect(() => change(settings(), [{ key, value }]), key).toThrow(/is the person's to change\..*pistachio_open "settings\//);
    }
    // What is not shown is not there to change.
    expect(() => change(settings(), [{ key: "onboarding.completed", value: false }])).toThrow('There is no setting "onboarding.completed"');
    expect(() => change(settings(), [{ key: "shields.customFilters", value: "||example.com^" }])).toThrow("There is no setting");
  });

  it("is all of it or none: one refusal, and nothing of the rest is planned", () => {
    const before = settings();
    expect(() => planSettingsChange(before, [{ key: "appearance.scheme", value: "dark" }, { key: "shields.enabled", value: false }], CLEAN)).toThrow("the person's to change");
    expect(before).toEqual(DEFAULT_SETTINGS);
  });

  it("holds back an address a tab would open in a turn that has read untrusted content — and nothing else", () => {
    const read = { readUntrusted: true };
    expect(() => change(settings(), [{ key: "general.homeUrl", value: "https://evil.example/" }], read)).toThrow("is not changed in a turn that has read a page");
    expect(() => change(settings(), [{ key: "general.newTabUrl", value: "https://evil.example/" }], read)).toThrow("must be the person's own choice");
    // How it looks is not a thing a page gains by: "use this page's colours" is a fair wish.
    expect(change(settings(), [{ key: "appearance.colors", value: ["#123456"] }], read).next.appearance.colors).toEqual(["#123456"]);
    // Asked for in a turn that read nothing, it is set.
    expect(change(settings(), [{ key: "general.newTabUrl", value: "https://news.example/" }, { key: "general.newTab", value: "url" }]).next.general).toMatchObject({ newTab: "url", newTabUrl: "https://news.example/" });
  });

  it("rebinds a key, clears one, and refuses a key another command holds in the file's own words", () => {
    const rebound = change(settings(), [{ key: "shortcuts.newSpace", value: "Cmd+Shift+N" }]);
    expect(rebound.next.shortcuts.newSpace).toBe("Mod+Shift+N");
    expect(rebound.plan.changed).toEqual([{ key: "shortcuts.newSpace", what: "New space", before: "Mod+N", after: "Mod+Shift+N" }]);
    expect(change(settings(), [{ key: "shortcuts.tidyTabs", value: null }]).next.shortcuts.tidyTabs).toBeNull();
    expect(() => change(settings(), [{ key: "shortcuts.newSpace", value: "Mod+T" }])).toThrow("New space and New tab cannot both use Mod+T. Clear one of them first.");
    // As a person writes a key, and as the Mac draws it.
    expect(change(settings(), [{ key: "shortcuts.newSpace", value: "⌘⇧N" }]).next.shortcuts.newSpace).toBe("Mod+Shift+N");
    expect(change(settings(), [{ key: "shortcuts.openNotes", value: "Option+Command+O" }]).next.shortcuts.openNotes).toBe("Mod+Alt+O");
    expect(() => change(settings(), [{ key: "shortcuts.newSpace", value: "the big key" }])).toThrow("Mod (⌘), Alt (⌥) and Shift with one key");
    expect(() => change(settings(), [{ key: "shortcuts.newSpace", value: "Ctrl+N" }])).toThrow("Control is not bound");
    expect(() => change(settings(), [{ key: "shortcuts.launchRocket", value: "Mod+R" }])).toThrow('There is no keyboard command "launchRocket"');
    // The web's split is not this window's to bind.
    expect(() => change(settings(), [{ key: "shortcuts.toggleSplit", value: "Mod+Alt+S" }])).toThrow("There is no keyboard command");
    // Swapping two in one change is judged as one.
    const swapped = change(settings(), [{ key: "shortcuts.newSpace", value: "Mod+T" }, { key: "shortcuts.newTab", value: "Mod+N" }]);
    expect(swapped.next.shortcuts).toMatchObject({ newSpace: "Mod+T", newTab: "Mod+N" });
  });
});

describe("Pistachio's own pages", () => {
  it("are Settings' pages by their names, then the app's others — each a command the shell takes", () => {
    const ids = PISTACHIO_PAGES.map((page) => page.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("settings");
    expect(ids).toContain("settings/appearance");
    expect(ids).toContain("settings/privacy/shields");
    expect(ids).toContain("extensions");
    expect(ids.filter((id) => id.startsWith("settings")).length).toBe(Object.keys(SETTINGS_SECTIONS).length);
    for (const page of PISTACHIO_PAGES) {
      const target = pageCommand(page.id);
      expect(target, page.id).not.toBeNull();
      expect(isShellCommand(target!.command), page.id).toBe(true);
    }
    expect(pageCommand("settings/appearance")).toEqual({ command: { type: "openSettings", section: "appearance" }, opened: "Settings → Appearance" });
    expect(pageCommand("settings")).toEqual({ command: { type: "openSettings", section: "" }, opened: "Settings → General" });
    expect(pageCommand("extensions")?.command).toEqual({ type: "openExtensions" });
    expect(pageCommand("settings/nope")).toBeNull();
  });

  it("every locked page of settings can be offered: its refusal names a page that opens", () => {
    for (const section of SETTINGS_CATALOG) {
      if (section.locked === undefined) continue;
      const entry = section.entries[0]!;
      let message = "";
      try {
        planSettingsChange(settings(), [{ key: `${section.id}.${entry.field}`, value: true }], CLEAN);
      } catch (error) {
        message = (error as Error).message;
      }
      const page = /pistachio_open "([^"]+)"/.exec(message)?.[1];
      expect(page, section.id).toBeDefined();
      expect(pageCommand(page!), section.id).not.toBeNull();
    }
  });
});

/* ------------------------------------ extensions ------------------------------------ */

function info(patch: Partial<ExtensionInfo> = {}): ExtensionInfo {
  return {
    id: "dev.local.game-day",
    kind: "pistachio",
    name: "Game day",
    version: "1.0.0",
    description: "A stadium behind a space on Sundays.",
    iconUrl: null,
    source: { type: "dev", path: "/Users/z/Pistachio/Extensions/game-day" },
    enabled: true,
    enabledHere: true,
    pinned: true,
    order: 0,
    agentAllowed: false,
    status: "idle",
    error: null,
    badge: null,
    statusPill: null,
    hasPanel: false,
    panelWidth: null,
    hasAction: false,
    pages: [],
    barCommands: [],
    menuItems: [],
    settings: [],
    tools: [],
    grants: null,
    pending: null,
    verdict: null,
    devPath: "/Users/z/Pistachio/Extensions/game-day",
    ...patch,
  };
}

describe("an installed extension, as the model reads it", () => {
  it("says where it stands, what it adds and what it shows — and its slug when a build may change it", () => {
    const view = extensionListView(
      info({
        barCommands: [{ name: "gameday", description: "Show this space only on Sundays", arg: null }],
        tools: [{ name: "scores", description: "Today's scores.", effect: "read" }],
        hasPanel: true,
        menuItems: [{ id: "here", title: "Game day here", contexts: ["space"], hosts: [] }],
        triggers: [{ id: "sunday", text: "Sundays 8:00 AM–11:00 PM", next: null }],
        shows: [
          { what: "theme", spaceId: "g1", space: "Football", detail: "Backdrop and accent" },
          { what: "mark", spaceId: "g1", space: "Football", detail: "Games on" },
          { what: "band", spaceId: null, space: "", detail: "KC 21 – BUF 17" },
        ],
      }),
      "game-day",
    );
    expect(view).toEqual({
      id: "dev.local.game-day",
      name: "Game day",
      kind: "pistachio",
      description: "A stadium behind a space on Sundays.",
      state: "on",
      adds: [
        "/gameday in the Bar: Show this space only on Sundays",
        "a tool for you, scores: Today's scores.",
        "a side panel",
        "a menu item “Game day here” (space)",
        "runs by itself: Sundays 8:00 AM–11:00 PM",
      ],
      shows: ["Backdrop and accent in “Football”", "a mark (Games on) in “Football”", "rows beside the Bar (KC 21 – BUF 17) in every space"],
      slug: "game-day",
    });
  });

  it("says each standing in words, and gives no slug where a build may not write", () => {
    const sheet = { adds: [], can: [], declares: [], manifestHash: "h" };
    expect(extensionListView(info({ status: "needs-approval", pending: sheet }), null).state).toBe("waiting for the person to turn it on");
    expect(extensionListView(info({ status: "paused", pending: { ...sheet, changedByAgent: true } }), null).state).toBe("paused: waiting for the person to approve what you changed");
    expect(extensionListView(info({ status: "paused", pending: sheet }), null).state).toBe("paused: waiting for the person to approve a change");
    expect(extensionListView(info({ status: "error", error: { message: "worker.js: pistachio.theme.sett is not a function", at: 1 } }), null).state).toBe("broken: worker.js: pistachio.theme.sett is not a function");
    expect(extensionListView(info({ status: "off" }), null).state).toBe("off");
    expect(extensionListView(info({ status: "running", enabledHere: false }), null).state).toBe("off in this Profile");
    const chrome = extensionListView(info({ kind: "chrome", status: "incompatible", verdict: { kind: "wont", reason: "Shields already blocks ads and trackers here" } }), null);
    expect(chrome.state).toBe("won't work in Pistachio: Shields already blocks ads and trackers here");
    expect("slug" in chrome).toBe(false);
  });
});

describe("what a build came to", () => {
  const status = (patch: Partial<StatusFile> = {}): StatusFile => ({ id: "dev.local.game-day", state: "needs-approval", loadedAt: 1, api: 1, manifestErrors: [], pendingGrants: null, runtimeErrors: [], surfaces: { bar: [], tools: [], pages: [] }, keys: [], triggers: [], ...patch });

  it("loads and waits on the person: what its sheet will say", () => {
    const pending = {
      adds: ["an item in a space's menu"],
      can: [
        { tier: "medium" as const, text: "Changes the backdrop and accent colour of your spaces." },
        { tier: "low" as const, text: "Puts a small mark on the spaces you ran it in." },
      ],
      runs: ["Sundays 8:00 AM–11:00 PM"],
      declares: [],
      manifestHash: "h",
    };
    expect(buildOutcome({ slug: "game-day", name: "Game day", status: status(), info: info({ status: "needs-approval", pending }) })).toEqual({
      id: "dev.local.game-day",
      title: "Game day",
      slug: "game-day",
      waiting: true,
      adds: ["an item in a space's menu"],
      asks: ["Changes the backdrop and accent colour of your spaces.", "Puts a small mark on the spaces you ran it in."],
      runs: ["Sundays 8:00 AM–11:00 PM"],
      errors: [],
    });
  });

  it("does not load yet: the errors as the status file has them, nothing waiting, the name it was asked for", () => {
    const outcome = buildOutcome({
      slug: "game-day",
      name: "Game day",
      status: status({ id: null, state: "error", manifestErrors: [{ path: "triggers.0", message: "a trigger needs exactly one of during, at, every, when, on" }, { path: "", message: "pistachio.json is not JSON" }], runtimeErrors: [{ context: "worker", message: "pistachio.theme.sett is not a function", file: "worker.js", line: 4, at: 1 }] }),
      info: null,
    });
    expect(outcome).toMatchObject({ id: null, title: "Game day", waiting: false, adds: [], asks: [] });
    expect(outcome.errors).toEqual(["pistachio.json triggers.0: a trigger needs exactly one of during, at, every, when, on", "pistachio.json is not JSON", "worker.js:4: pistachio.theme.sett is not a function"]);
  });

  it("wrote nothing Pistachio could read: said so", () => {
    expect(buildOutcome({ slug: "game-day", name: "Game day", status: null, info: null }).errors).toEqual(["Nothing that loads was written: there is no pistachio.json Pistachio could read."]);
  });

  it("an approved one the build changed waits again, by its sheet", () => {
    const outcome = buildOutcome({ slug: "game-day", name: "Game day", status: status({ state: "paused" }), info: info({ status: "paused", pending: { adds: [], can: [], declares: [], manifestHash: "h", changedByAgent: true } }) });
    expect(outcome).toMatchObject({ id: "dev.local.game-day", waiting: true, errors: [] });
  });
});
