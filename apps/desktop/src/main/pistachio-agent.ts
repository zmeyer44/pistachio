/**
 * Pistachio as the agent reaches it, main's side (docs/agent-pistachio.md):
 * no Electron here, so the rules are unit-tested (test/pistachio-agent.test.ts)
 * and index.ts wires them to the settings file, the shell and the extension
 * service.
 *
 * - **The settings catalog.** Every field of `DesktopSettings` is one of three
 *   things, and a test holds the table to that: *the agent's to change* (how
 *   Pistachio looks and behaves: the theme, the sidebar, new tabs, search,
 *   Tidy, shortcuts), *the person's alone* (`locked`: what the agent itself
 *   may do, approvals, protection, where conversations run, an extension's
 *   developer mode — read, never written), or *not shown* (`HIDDEN`: nothing
 *   a person sets by hand). A new setting cannot be added without deciding
 *   which.
 * - `readSettings` / `planSettingsChange`: the catalog over the live values,
 *   and a change checked whole before any of it is written — every key known,
 *   none locked, every value one the setting takes, and the file's own
 *   sanitizer agreeing — so a refusal is a sentence the model can act on and
 *   a change is all of it or none.
 * - `PISTACHIO_PAGES` / `pageCommand`: the app's own pages `pistachio_open`
 *   can show, each the shell command that shows it.
 * - `extensionListView` / `buildOutcome`: an installed extension, and what a
 *   build came to, in the model's terms — read from the same snapshot the
 *   extensions page draws.
 */

import type { ExtensionBuildOutcome, ExtensionListToolView, PistachioPageToolView, SettingChangeInput, SettingChangedToolView, SettingsSectionToolView, SettingToolView } from "@pistachio/agent-runtime";
import { APPEARANCE_PRESETS, GRADIENT_BLENDS, GRADIENT_HARMONIES, APPEARANCE_SCHEMES, normalizeThemeColor } from "@pistachio/shell-contracts/appearance";
import type { ShellCommand } from "@pistachio/shell-contracts/chrome";
import type { ExtensionInfo } from "@pistachio/shell-contracts/extensions";
import { NOTICE_POSITIONS } from "@pistachio/shell-contracts/notice";
import { AI_SEARCH_PROVIDER_IDS, WEB_SEARCH_PROVIDER_IDS } from "@pistachio/shell-contracts/search";
import {
  APPROVAL_EXPIRY_MINUTES,
  applySettingsPatch,
  ARCHIVE_AFTER_HOURS_OPTIONS,
  CAPSULE_MINUTES,
  MAX_INTERACTIONS,
  PLAYBACK_RATE_OPTIONS,
  SETTINGS_SECTIONS,
  SIDEBAR_MODES,
  SPACE_ARRIVALS,
  SPACE_SWITCH_EXITS,
  type DesktopSettings,
  type SettingsSection,
} from "@pistachio/shell-contracts/settings";
import { normalizeShortcut, SHORTCUT_DEFINITIONS, shortcutLabel, shortcutOffered } from "@pistachio/shell-contracts/shortcuts";
import { TAB_SWITCHER_HOLDS } from "@pistachio/shell-contracts/tab-switcher";
import { ARCHIVE_RETENTION_DAYS } from "@pistachio/shell-contracts/tidy";
import type { StatusFile } from "./extensions/status";

/* ------------------------------------ the catalog ------------------------------------ */

/** What a setting takes: enough to say it in words and to refuse a value before the file is touched. */
type SettingKind =
  | { kind: "choice"; options: readonly (string | number)[] }
  | { kind: "switch" }
  | { kind: "number"; min: number; max: number; whole?: true }
  | { kind: "colors" }
  | { kind: "address" }
  | { kind: "time" }
  | { kind: "text"; max: number }
  | { kind: "path" };

interface SettingEntry {
  field: string;
  what: string;
  type: SettingKind;
  /** The person's alone, whatever its page: why, in a sentence. */
  locked?: string;
  /** Refused in a turn that has read untrusted content: an address a tab would open is a classic thing for a page to ask for. */
  guarded?: true;
}

interface SettingsCatalogSection {
  /** The key of `DesktopSettings` its fields are under. */
  id: keyof DesktopSettings;
  title: string;
  about: string;
  /** The page of Settings it is on, as `pistachio_open` names it. */
  page: SettingsSection;
  /** The whole page is the person's alone: why. */
  locked?: string;
  entries: SettingEntry[];
}

const SWITCH: SettingKind = { kind: "switch" };
const unit = (min: number, max: number): SettingKind => ({ kind: "number", min, max });

const AGENT_LIMITS = "It bounds what you yourself may do in the person's tabs, so only they change it.";
const APPROVALS = "It is how the person is asked before you act, so only they change it.";
const PROTECTION = "It is the person's protection from the sites they visit, so only they change it.";

export const SETTINGS_CATALOG: readonly SettingsCatalogSection[] = [
  {
    id: "appearance",
    title: "Appearance",
    about: "How the window looks: light or dark, the colour wash, the glass, grain, contrast, corners, the app icon, where notices appear.",
    page: "appearance",
    entries: [
      { field: "scheme", what: "Light, dark, or whatever the Mac is set to.", type: { kind: "choice", options: APPEARANCE_SCHEMES } },
      { field: "gradientEnabled", what: "The colour wash over the window. Off, the window is plain.", type: SWITCH },
      { field: "colors", what: "The wash's colours, in paint order; the first is the accent — the focus ring and the tint of Pistachio's own controls.", type: { kind: "colors" } },
      { field: "blend", what: "How the colours meet: a soft mesh, a straight line, or pools.", type: { kind: "choice", options: GRADIENT_BLENDS } },
      { field: "angle", what: "The direction the wash runs, in degrees.", type: { kind: "number", min: 0, max: 359, whole: true } },
      { field: "intensity", what: "How strong the wash is: 0 barely there, 1 full.", type: unit(0, 1) },
      { field: "harmony", what: "How the Settings page derives the other colours from the first; \"floating\" keeps each as it was set. Set colors yourself: this only matters to the page's colour picker.", type: { kind: "choice", options: GRADIENT_HARMONIES } },
      { field: "texture", what: "Grain over the window: 0 none, 1 heavy.", type: unit(0, 1) },
      { field: "contrast", what: "How much raised surfaces stand out from recessed ones.", type: unit(0, 1) },
      { field: "surfaceOpacity", what: "How solid Pistachio's own surfaces are: lower lets more of the wash and the glass through.", type: unit(0.55, 1) },
      { field: "desktopGlass", what: "Let the Mac's desktop show through the window as glass.", type: SWITCH },
      { field: "glassTint", what: "How strongly that glass is tinted: 0.25 clear, 1 nearly solid.", type: unit(0.25, 1) },
      { field: "radius", what: "The roundness of corners, in pixels: 0 square, 18 very round.", type: { kind: "number", min: 0, max: 18, whole: true } },
      { field: "desktopIcon", what: "The app icon's background in the Dock.", type: { kind: "choice", options: ["white", "green"] } },
      { field: "toastPosition", what: "Where brief notices appear over the page.", type: { kind: "choice", options: NOTICE_POSITIONS } },
    ],
  },
  {
    id: "layout",
    title: "Sidebar and spaces",
    about: "How the sidebar stands, and how a space's windows leave and arrive when another space is chosen. On Settings → General.",
    page: "",
    entries: [
      { field: "sidebar", what: "The sidebar: whole, a narrow rail of icons, or hidden until the pointer reaches the window's left edge.", type: { kind: "choice", options: SIDEBAR_MODES } },
      { field: "spaceExit", what: "How the windows go when another space is chosen: bloom swells and blurs them away, recede steps the desk back, gather draws them to the middle, pop lifts then drops them, sink tips the desk back, tile flies each into its space's tile on the rail.", type: { kind: "choice", options: SPACE_SWITCH_EXITS } },
      { field: "spaceArrival", what: "How the chosen space's windows come: matched to how the others left, or out of its tile on the rail.", type: { kind: "choice", options: SPACE_ARRIVALS } },
    ],
  },
  {
    id: "general",
    title: "General",
    about: "What a new tab and the home page open, the daily brief's schedule, and asking before a working tab is closed.",
    page: "",
    entries: [
      { field: "newTab", what: "What a new tab opens: the home page, the address bar with nothing in it, or the address in newTabUrl.", type: { kind: "choice", options: ["home", "address", "url"] } },
      { field: "newTabUrl", what: "The address a new tab opens when newTab is \"url\".", type: { kind: "address" }, guarded: true },
      { field: "homePage", what: "The home page: Pistachio's own, or the address in homeUrl.", type: { kind: "choice", options: ["pistachio", "url"] } },
      { field: "homeUrl", what: "The address of the home page when homePage is \"url\". Setting it makes it the home page.", type: { kind: "address" }, guarded: true },
      { field: "morningBrief", what: "Make the daily brief by itself each day at morningBriefTime. It reads the connected mail and calendar.", type: SWITCH },
      { field: "morningBriefTime", what: "When the daily brief is made.", type: { kind: "time" } },
      { field: "morningBriefNotify", what: "A notification when the scheduled brief is ready.", type: SWITCH },
      { field: "confirmCloseWithRun", what: "Ask before closing a tab you are working in.", type: SWITCH },
    ],
  },
  {
    id: "search",
    title: "Search",
    about: "Where words typed in the address bar go, and whether a fast model helps with suggestions and find. On Settings → General.",
    page: "",
    entries: [
      { field: "webProvider", what: "The engine a web search runs on.", type: { kind: "choice", options: WEB_SEARCH_PROVIDER_IDS } },
      { field: "aiProvider", what: "The assistant the address bar's \"Ask\" suggestion opens with what was typed.", type: { kind: "choice", options: AI_SEARCH_PROVIDER_IDS } },
      { field: "smartSuggestions", what: "Send what is typed in the address bar to a fast model that orders the suggestions. Off, nothing typed leaves the Mac.", type: SWITCH },
      { field: "smartFind", what: "Let find-in-page find by meaning, which sends the page's visible text to a model. Off, find is exact.", type: SWITCH },
    ],
  },
  {
    id: "tabs",
    title: "Tabs",
    about: "Tidy — when idle tabs are put away, whether related ones are gathered into spaces — the archive, and the tab switcher.",
    page: "tabs",
    entries: [
      { field: "archiveAfterHours", what: "Hours a tab may go unviewed before Tidy puts it in the archive; 0 never does it by itself.", type: { kind: "choice", options: ARCHIVE_AFTER_HOURS_OPTIONS } },
      { field: "groupRelated", what: "Let a model gather related tabs into spaces and name them. Off, Tidy goes by the clock alone.", type: SWITCH },
      { field: "resetFavorites", what: "A favorite that wandered from its page goes back to it when Tidy runs.", type: SWITCH },
      { field: "archiveRetentionDays", what: "Days an archived tab or a closed space is kept.", type: { kind: "choice", options: ARCHIVE_RETENTION_DAYS } },
      { field: "switcherHold", what: "How long the tab switcher's keys are held before it opens.", type: { kind: "choice", options: TAB_SWITCHER_HOLDS } },
    ],
  },
  {
    id: "media",
    title: "Playback",
    about: "Audio and video on every site, and Read aloud. On Settings → General.",
    page: "",
    entries: [{ field: "defaultPlaybackRate", what: "The speed audio and video start at on every site, and Read aloud's.", type: { kind: "choice", options: PLAYBACK_RATE_OPTIONS } }],
  },
  {
    id: "reminders",
    title: "Reminders",
    about: "Whether reminders and scheduled tasks fire, and how they tell the person.",
    page: "reminders",
    entries: [
      { field: "enabled", what: "Reminders and scheduled tasks fire at all.", type: SWITCH },
      { field: "desktopNotifications", what: "A notification when one fires or a scheduled task finishes.", type: SWITCH },
      { field: "openConsoleOnFire", what: "Bring the conversation forward when one fires.", type: SWITCH },
    ],
  },
  {
    id: "bookmarks",
    title: "Bookmarks",
    about: "How a page is saved.",
    page: "bookmarks",
    entries: [
      { field: "doubleShift", what: "Tapping shift twice bookmarks the page in front.", type: SWITCH },
      { field: "enrichWithModel", what: "A model reads a saved page to say what it is about. Off, only the page's own tags are read.", type: SWITCH },
    ],
  },
  {
    id: "memory",
    title: "Memory",
    about: "Whether you remember things about the person. What is remembered is not here: your memory tools hold it.",
    page: "memory",
    entries: [
      { field: "enabled", what: "What you remember about the person is used in conversations.", type: SWITCH },
      { field: "learnFromRuns", what: "Finished conversations are read for facts worth keeping.", type: SWITCH },
    ],
  },
  {
    id: "privacy",
    title: "Site data",
    about: "What the address bar remembers. Clearing cookies and site storage is done on the page itself, by the person.",
    page: "privacy",
    entries: [{ field: "rememberRecents", what: "The address bar remembers recently visited sites.", type: SWITCH }],
  },
  {
    id: "evidence",
    title: "Evidence",
    about: "The signed record of what you did, as its replay shows it.",
    page: "evidence",
    entries: [{ field: "showPayloads", what: "The replay shows each entry's payload, not only its kind.", type: SWITCH }],
  },
  {
    id: "delegation",
    title: "Agent",
    about: "What you may do in the person's tabs, and the instructions every conversation starts with.",
    page: "delegation",
    locked: AGENT_LIMITS,
    entries: [
      { field: "defaultIntent", what: "Instructions every conversation starts with.", type: { kind: "text", max: 2_000 } },
      { field: "allowWrites", what: "You may submit forms and make other changes on sites.", type: SWITCH },
      { field: "allowUploads", what: "You may upload files to sites.", type: SWITCH },
      { field: "allowDownloads", what: "You may download files.", type: SWITCH },
      { field: "allowClipboard", what: "You may use the clipboard.", type: SWITCH },
      { field: "maxInteractions", what: "How many actions a grant covers.", type: { kind: "choice", options: MAX_INTERACTIONS } },
      { field: "capsuleMinutes", what: "How long a grant lasts, in minutes.", type: { kind: "choice", options: CAPSULE_MINUTES } },
    ],
  },
  {
    id: "approvals",
    title: "Approvals & notifications",
    about: "How the person is asked before you act, and how long a paused task waits.",
    page: "approvals",
    locked: APPROVALS,
    entries: [
      { field: "expiryMinutes", what: "Minutes a paused task waits for a decision.", type: { kind: "choice", options: APPROVAL_EXPIRY_MINUTES } },
      { field: "desktopNotifications", what: "A notification when you need a decision.", type: SWITCH },
      { field: "flashDock", what: "The Dock icon bounces when you need a decision.", type: SWITCH },
      { field: "focusConsoleOnPause", what: "The approval card comes forward, not just a badge.", type: SWITCH },
    ],
  },
  {
    id: "shields",
    title: "Ads & trackers",
    about: "Shields: blocking ads, trackers and dangerous sites. Its page holds more than is listed here — filter lists, cookies, fingerprinting.",
    page: "privacy/shields",
    locked: PROTECTION,
    entries: [
      { field: "enabled", what: "Shields is on at all.", type: SWITCH },
      { field: "level", what: "The protection level that sets everything at once.", type: { kind: "choice", options: ["standard", "strict", "custom"] } },
      { field: "dangerousSites", what: "A dangerous site is stopped behind a warning before it loads.", type: SWITCH },
      { field: "globalPrivacyControl", what: "Every site is told not to sell or share the person's data.", type: SWITCH },
    ],
  },
  {
    id: "extensions",
    title: "Extensions",
    about: "Developer mode: watching a folder of the person's own extensions and reloading them as they are saved. Which extensions are installed is not a setting: extensions_list reads that.",
    page: "extensions",
    locked: "Turning extensions on, and where their code is read from, is the person's. Building one with extension_build turns Developer mode on by itself.",
    entries: [
      { field: "developerMode", what: "The dev folder is watched and its extensions reload as they are saved.", type: SWITCH },
      { field: "devFolder", what: "The dev folder, when it is not ~/Pistachio/Extensions.", type: { kind: "path" } },
    ],
  },
  {
    id: "cloud",
    title: "Cloud browser",
    about: "Where new conversations run.",
    page: "cloud",
    locked: "It decides whether your work happens on this Mac or on Pistachio's servers, so only the person changes it.",
    entries: [{ field: "runByDefault", what: "New conversations start in the cloud browser when the Profile allows it.", type: SWITCH }],
  },
];

/**
 * The fields the agent is not shown: nothing a person sets by hand (the
 * walkthrough's own record, an organization's seeded links), a switch for a
 * surface the desktop no longer draws, and the deep end of Shields, which its
 * own page explains better than a line here could. Each with the reason, so
 * the test that holds the catalog to `DesktopSettings` reads as decisions.
 */
export const HIDDEN_SETTINGS: Readonly<Record<string, string>> = {
  "onboarding.completed": "the walkthrough's own record",
  "onboarding.completedAt": "the walkthrough's own record",
  "organization.presetLinks": "an organization's, laid down at install",
  "general.consoleOpenOnLaunch": "the agent panel it opened is not drawn on the desktop",
  "shields.blocking": "Shields' detail: its page",
  "shields.lists": "Shields' detail: its page",
  "shields.cookieBanners": "Shields' detail: its page",
  "shields.trackingParams": "Shields' detail: its page",
  "shields.bounceTracking": "Shields' detail: its page",
  "shields.crossSiteCookies": "Shields' detail: its page",
  "shields.fingerprinting": "Shields' detail: its page",
  "shields.https": "Shields' detail: its page",
  "shields.referrer": "Shields' detail: its page",
  "shields.webRtc": "Shields' detail: its page",
  "shields.blockPings": "Shields' detail: its page",
  "shields.customFilters": "Shields' detail: its page",
};

/** The page of keyboard shortcuts: not in the table above, since its fields are the actions themselves. */
const SHORTCUTS_SECTION = {
  id: "shortcuts",
  title: "Keyboard shortcuts",
  about: "The key that runs each of Pistachio's commands. \"Mod\" is ⌘ on the Mac. A key another command holds is refused: clear that one first, or pick another.",
  page: "shortcuts",
} as const;

const SHORTCUT_ACCEPTS = "Mod (⌘), Alt (⌥) and Shift with one key, like \"Mod+Shift+K\" or \"Alt+L\" — Control is not bound — or null for no key";

/**
 * A key as a person or a model writes it — "⌘⇧N", "Cmd+Shift+N", "Option+L" — in the settings file's spelling
 * ("Mod+Shift+N"), which is the only one its parser reads. Anything else is left for the parser to refuse.
 */
function portableShortcut(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const parts = value
    .trim()
    .replace(/⌘/g, "Mod+")
    .replace(/⇧/g, "Shift+")
    .replace(/⌥/g, "Alt+")
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  return parts.map((part, index) => (index === parts.length - 1 ? part : /^(?:cmd|command|meta)$/i.test(part) ? "Mod" : /^(?:opt|option)$/i.test(part) ? "Alt" : part)).join("+");
}

/** The one setting that is not a field: a named look, which sets the wash's colours, blend, angle, strength and grain together. */
const PRESET_KEY = "appearance.preset";

/* ------------------------------------ reading ------------------------------------ */

function accepts(type: SettingKind): string {
  switch (type.kind) {
    case "choice":
      return `one of: ${type.options.map((option) => String(option)).join(", ")}`;
    case "switch":
      return "true or false";
    case "number":
      return type.whole === true ? `a whole number from ${String(type.min)} to ${String(type.max)}` : `a number from ${String(type.min)} to ${String(type.max)}`;
    case "colors":
      return "a list of one to three colours, each \"#rrggbb\"";
    case "address":
      return "an http or https address";
    case "time":
      return "a time as \"HH:MM\", 24-hour";
    case "text":
      return `text, at most ${String(type.max)} characters`;
    case "path":
      return "a folder's path";
  }
}

function valueAt(settings: DesktopSettings, section: keyof DesktopSettings, field: string): unknown {
  return (settings[section] as unknown as Record<string, unknown>)[field];
}

/** The preset the wash matches now, or "custom". */
function presetOf(settings: DesktopSettings): string {
  const look = settings.appearance;
  const match = APPEARANCE_PRESETS.find(
    (preset) =>
      preset.blend === look.blend &&
      preset.angle === look.angle &&
      preset.intensity === look.intensity &&
      preset.texture === look.texture &&
      preset.colors.length === look.colors.length &&
      preset.colors.every((color, index) => color.toUpperCase() === look.colors[index]?.toUpperCase()),
  );
  return match?.id ?? "custom";
}

/** The pages of settings, without their settings. */
export function settingsSections(): Array<{ id: string; title: string; about: string }> {
  return [...SETTINGS_CATALOG.map((section) => ({ id: section.id as string, title: section.title, about: section.locked === undefined ? section.about : `${section.about} Locked: the person's to change.` })), { id: SHORTCUTS_SECTION.id, title: SHORTCUTS_SECTION.title, about: SHORTCUTS_SECTION.about }];
}

/** One page, with every setting on it as it stands. Throws, naming the pages there are, for one there is not. */
export function readSettings(settings: DesktopSettings, sectionId: string): SettingsSectionToolView {
  const wanted = sectionId.trim().toLowerCase();
  if (wanted === SHORTCUTS_SECTION.id || wanted === "keyboard") {
    const views: SettingToolView[] = [];
    for (const definition of SHORTCUT_DEFINITIONS) {
      // (The Mac's own window: what the web's surface alone offers, and what is retired, is not this app's to bind.)
      if (!shortcutOffered(definition, "native")) continue;
      const binding = settings.shortcuts[definition.id];
      views.push({
        key: `shortcuts.${definition.id}`,
        what: `${definition.label}${definition.note === undefined ? "" : ` — ${definition.note}`}${binding === null ? "" : ` (shown to the person as ${shortcutLabel(binding, "darwin") ?? binding})`}`,
        value: binding,
        accepts: SHORTCUT_ACCEPTS,
      });
    }
    return { id: SHORTCUTS_SECTION.id, title: SHORTCUTS_SECTION.title, about: SHORTCUTS_SECTION.about, settings: views };
  }
  const section = SETTINGS_CATALOG.find((candidate) => candidate.id === wanted || candidate.title.toLowerCase() === wanted);
  if (section === undefined) throw new Error(`There is no page of settings "${sectionId}". The pages: ${settingsSections().map((entry) => entry.id).join(", ")}.`);
  const views: SettingToolView[] = section.entries.map((entry) => {
    const locked = entry.locked ?? section.locked;
    return {
      key: `${section.id}.${entry.field}`,
      what: entry.what,
      value: valueAt(settings, section.id, entry.field),
      accepts: accepts(entry.type),
      ...(locked === undefined ? {} : { locked }),
    };
  });
  if (section.id === "appearance") {
    views.unshift({
      key: PRESET_KEY,
      what: "A named look: sets the wash's colours, blend, angle, strength and grain together. \"custom\" means the person's own mix; it cannot be set.",
      value: presetOf(settings),
      accepts: `one of: ${APPEARANCE_PRESETS.map((preset) => preset.id).join(", ")}`,
    });
  }
  return { id: section.id, title: section.title, about: section.about, settings: views };
}

/* ------------------------------------ changing ------------------------------------ */

function refuse(message: string): never {
  throw new Error(message);
}

function said(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : JSON.stringify(value);
}

/** The value as the settings file holds it, or a sentence about why this setting does not take it. */
function checked(key: string, type: SettingKind, value: unknown): unknown {
  const wrong = (): never => refuse(`${key} does not take ${said(value)}: it accepts ${accepts(type)}.`);
  switch (type.kind) {
    case "choice": {
      // (A model writes 1.5 as "1.5" as often as not: a number's choices are matched by what they say.)
      const match = type.options.find((option) => option === value || (typeof option === "number" && typeof value === "string" && String(option) === value.trim()));
      return match === undefined ? wrong() : match;
    }
    case "switch":
      return typeof value === "boolean" ? value : wrong();
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value) || value < type.min || value > type.max) return wrong();
      return type.whole === true ? Math.round(value) : value;
    }
    case "colors": {
      const list = typeof value === "string" ? [value] : value;
      if (!Array.isArray(list) || list.length < 1 || list.length > 3) return wrong();
      const colors = list.map((color) => normalizeThemeColor(color));
      return colors.some((color) => color === null) ? wrong() : colors;
    }
    case "address": {
      if (typeof value !== "string") return wrong();
      // (A bare site name is what a person says: "nytimes.com" is https://nytimes.com.)
      const spelled = /^[a-z][a-z0-9+.-]*:/i.test(value.trim()) ? value.trim() : `https://${value.trim()}`;
      try {
        const url = new URL(spelled);
        return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : wrong();
      } catch {
        return wrong();
      }
    }
    case "time":
      return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/u.test(value.trim()) ? value.trim() : wrong();
    case "text":
      return typeof value === "string" && value.length <= type.max ? value : wrong();
    case "path":
      return typeof value === "string" && value.length > 0 ? value : wrong();
  }
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface SettingsChangePlan {
  /** What `SettingsStore.update` is handed. Empty sections left out. */
  patch: Record<string, Record<string, unknown>>;
  /** What will have changed, a line a setting, in the order asked; one already so is left out. */
  changed: SettingChangedToolView[];
}

/**
 * A change, checked whole before any of it is written: every key one the
 * catalog knows, none locked, none guarded in a turn that read untrusted
 * content, every value one its setting takes — and then the file's own
 * sanitizer run over the result, which must agree (it refuses a keyboard
 * shortcut another command holds, with its own sentence). Throws with a
 * sentence for the first thing wrong; nothing is written by this.
 */
export function planSettingsChange(settings: DesktopSettings, changes: readonly SettingChangeInput[], context: { readUntrusted: boolean }): SettingsChangePlan {
  const patch: Record<string, Record<string, unknown>> = {};
  const asked: Array<{ key: string; what: string; section: keyof DesktopSettings; field: string; value: unknown }> = [];
  const put = (section: keyof DesktopSettings, field: string, value: unknown): void => {
    (patch[section] ??= {})[field] = value;
  };
  for (const change of changes) {
    const key = change.key.trim();
    if (key === PRESET_KEY) {
      const preset = APPEARANCE_PRESETS.find((candidate) => candidate.id === change.value || candidate.label.toLowerCase() === String(change.value).toLowerCase());
      if (preset === undefined) refuse(`${PRESET_KEY} does not take ${said(change.value)}: it accepts one of: ${APPEARANCE_PRESETS.map((candidate) => candidate.id).join(", ")}.`);
      for (const [field, value] of Object.entries({ gradientEnabled: true, colors: [...preset.colors], harmony: preset.harmony, blend: preset.blend, angle: preset.angle, intensity: preset.intensity, texture: preset.texture })) put("appearance", field, value);
      asked.push({ key, what: "The window's look", section: "appearance", field: "preset", value: preset.id });
      continue;
    }
    const dot = key.indexOf(".");
    const sectionId = dot === -1 ? "" : key.slice(0, dot);
    const field = dot === -1 ? "" : key.slice(dot + 1);
    if (sectionId === SHORTCUTS_SECTION.id) {
      const definition = SHORTCUT_DEFINITIONS.find((candidate) => candidate.id === field && shortcutOffered(candidate, "native"));
      if (definition === undefined) refuse(`There is no keyboard command "${field}". settings_read with section "shortcuts" lists them.`);
      const binding = change.value === null || change.value === "" ? null : normalizeShortcut(portableShortcut(change.value));
      if (change.value !== null && change.value !== "" && binding === null) refuse(`${key} does not take ${said(change.value)}: it accepts ${SHORTCUT_ACCEPTS}.`);
      put("shortcuts", definition.id, binding);
      asked.push({ key, what: definition.label, section: "shortcuts", field: definition.id, value: binding });
      continue;
    }
    const section = SETTINGS_CATALOG.find((candidate) => candidate.id === sectionId);
    const entry = section?.entries.find((candidate) => candidate.field === field);
    if (section === undefined || entry === undefined) refuse(`There is no setting "${key}". settings_read lists the pages, and a page's settings by their keys.`);
    const locked = entry.locked ?? section.locked;
    if (locked !== undefined) refuse(`${key} is the person's to change. ${locked} Offer to open Settings → ${section.title} for them (pistachio_open "${pageId(section.page)}").`);
    if (entry.guarded === true && context.readUntrusted) {
      refuse(`${key} is not changed in a turn that has read a page, mail, a note or an extension's answer: an address a tab opens must be the person's own choice. Tell them what you would set and let them ask.`);
    }
    const value = checked(key, entry.type, change.value);
    put(section.id, entry.field, value);
    asked.push({ key, what: entry.what, section: section.id, field: entry.field, value });
  }
  // The file's own word: what a patch of these would leave. (It throws for a key two commands would hold.)
  const next = applySettingsPatch(settings, patch);
  const changed: SettingChangedToolView[] = [];
  for (const item of asked) {
    if (item.key === PRESET_KEY) {
      const before = presetOf(settings);
      if (presetOf(next) !== item.value) refuse(`${PRESET_KEY} could not be set to ${said(item.value)}.`);
      if (before !== item.value) changed.push({ key: item.key, what: item.what, before, after: item.value });
      continue;
    }
    const before = valueAt(settings, item.section, item.field);
    const after = valueAt(next, item.section, item.field);
    if (!same(after, item.value)) refuse(`${item.key} could not be set to ${said(item.value)}: Pistachio kept ${said(after)}.`);
    if (!same(before, after)) changed.push({ key: item.key, what: item.what, before, after });
  }
  return { patch, changed };
}

/* ------------------------------------ pages ------------------------------------ */

function pageId(section: SettingsSection): string {
  return section === "" ? "settings" : `settings/${section}`;
}

/** Pistachio's own pages the agent can show the person, beside the pages of Settings. */
const APP_PAGES: ReadonlyArray<PistachioPageToolView & { command: ShellCommand }> = [
  { id: "extensions", what: "the extensions page: what is installed, what waits to be turned on, the library", command: { type: "openExtensions" } },
  { id: "notes", what: "the person's notes", command: { type: "openNotes" } },
  { id: "bookmarks", what: "everything bookmarked", command: { type: "openBookmarks" } },
  { id: "reminders", what: "reminders and scheduled tasks", command: { type: "openReminders" } },
  { id: "archive", what: "tabs Tidy put away and spaces that were closed", command: { type: "openArchive" } },
  { id: "watchtower", what: "the archive of pages read", command: { type: "openWatchtower" } },
  { id: "downloads", what: "this session's downloads", command: { type: "openDownloads" } },
  { id: "brief", what: "today's brief", command: { type: "openBrief" } },
];

/** Every page `pistachio_open` takes: Settings' pages by their names, then the app's others. */
export const PISTACHIO_PAGES: readonly PistachioPageToolView[] = [
  ...(Object.entries(SETTINGS_SECTIONS) as Array<[SettingsSection, string]>).map(([section, title]) => ({ id: pageId(section), what: `Settings → ${title}` })),
  ...APP_PAGES.map(({ id, what }) => ({ id, what })),
];

/** The shell command that shows a page, and the words for what was opened; null for an id that names none. */
export function pageCommand(page: string): { command: ShellCommand; opened: string } | null {
  const app = APP_PAGES.find((candidate) => candidate.id === page);
  if (app !== undefined) return { command: app.command, opened: app.what };
  for (const [section, title] of Object.entries(SETTINGS_SECTIONS) as Array<[SettingsSection, string]>) {
    if (pageId(section) === page) return { command: { type: "openSettings", section }, opened: `Settings → ${title}` };
  }
  return null;
}

/* ------------------------------------ extensions ------------------------------------ */

function stateOf(info: ExtensionInfo): string {
  switch (info.status) {
    case "off":
      return "off";
    case "needs-approval":
      return "waiting for the person to turn it on";
    case "paused":
      return info.pending?.changedByAgent === true ? "paused: waiting for the person to approve what you changed" : "paused: waiting for the person to approve a change";
    case "error":
      return `broken: ${info.error?.message ?? "it does not load"}`;
    case "incompatible":
      return info.verdict?.kind === "wont" ? `won't work in Pistachio: ${info.verdict.reason}` : "won't work in Pistachio";
    case "idle":
    case "running":
      return info.enabledHere ? "on" : "off in this Profile";
  }
}

/** An installed extension as the model reads it. `slug`: its folder's name, when it is one a build may change. */
export function extensionListView(info: ExtensionInfo, slug: string | null): ExtensionListToolView {
  const adds: string[] = [];
  for (const command of info.barCommands) adds.push(`/${command.name} in the Bar: ${command.description}`);
  for (const tool of info.tools) adds.push(`a tool for you, ${tool.name}: ${tool.description}`);
  if (info.hasPanel) adds.push("a side panel");
  for (const page of info.pages) adds.push(`a page: ${page.title}`);
  for (const item of info.menuItems) adds.push(`a menu item “${item.title}” (${item.contexts.join(", ")})`);
  for (const trigger of info.triggers ?? []) adds.push(`runs by itself: ${trigger.text}`);
  const shows = (info.shows ?? []).map((shown) => {
    const where = shown.spaceId === null ? "every space" : shown.space === "" ? "a space" : `“${shown.space}”`;
    const what = shown.what === "theme" ? shown.detail : shown.what === "mark" ? `a mark (${shown.detail})` : shown.what === "tabMarks" ? `marks on tabs (${shown.detail})` : `${shown.what === "band" ? "rows beside the Bar" : "a section in the sidebar"} (${shown.detail})`;
    return `${what} in ${where}`;
  });
  return {
    id: info.id,
    name: info.name,
    kind: info.kind,
    description: info.description,
    state: stateOf(info),
    adds,
    shows,
    ...(slug === null ? {} : { slug }),
  };
}

/**
 * What a build came to (`extension_build`'s answer): the folder as Pistachio
 * read it once the builder stopped — its status file's errors, and, when it
 * loads, what its approval sheet will say. `info` null: nothing registered,
 * because nothing there loads yet.
 */
export function buildOutcome(input: { slug: string; name: string; status: StatusFile | null; info: ExtensionInfo | null }): ExtensionBuildOutcome {
  const { status, info } = input;
  const errors: string[] = [];
  for (const issue of status?.manifestErrors ?? []) errors.push(issue.path === "" ? issue.message : `pistachio.json ${issue.path}: ${issue.message}`);
  for (const issue of status?.runtimeErrors ?? []) errors.push(`${issue.file === undefined ? issue.context : `${issue.file}${issue.line === undefined ? "" : `:${String(issue.line)}`}`}: ${issue.message}`);
  if (status === null && info === null) errors.push("Nothing that loads was written: there is no pistachio.json Pistachio could read.");
  if (info?.status === "error" && errors.length === 0) errors.push(info.error?.message ?? "It does not load.");
  const sheet = info?.pending ?? null;
  return {
    id: info?.id ?? null,
    title: info?.name ?? input.name,
    slug: input.slug,
    waiting: errors.length === 0 && sheet !== null,
    adds: sheet?.adds ?? [],
    asks: sheet?.can.map((line) => line.text) ?? [],
    runs: sheet?.runs ?? (info?.triggers ?? []).map((trigger) => trigger.text),
    errors: errors.slice(0, 12),
  };
}
