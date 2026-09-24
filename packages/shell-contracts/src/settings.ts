/**
 * Desktop settings: the knobs a person can turn on this Mac, shared between
 * main (which owns the file and enforces the values) and the renderer (which
 * only ever edits a copy and asks main to commit it).
 *
 * Everything here is LOCAL and per-machine, and stays that way now that the
 * account exists: sessions, Spaces, and tab restore points converge between
 * your devices end-to-end encrypted (docs/cloud-sync-design.md §10.2), but
 * preferences do not travel with them. There is no sealed settings document
 * and no LWW register — one JSON file under userData, per Mac. The one field
 * here that the account can even be seen in is `cloud.runByDefault`, and
 * that is a preference about where the NEXT run goes, not a shared value.
 *
 * The grant defaults are the interesting half. They are not "preferences":
 * they are the ceiling every capsule starts from, so main re-validates them
 * against DEFAULT_SETTINGS' shape before every fork rather than trusting the
 * stored value (`sanitizeSettings`), the same way harbor re-validates its
 * new-tab URL before every use.
 */

import type { HttpMethod } from "@pistachio/protocol";
import {
  DEFAULT_APPEARANCE,
  sanitizeAppearance,
  type AppearanceSettings,
} from "./appearance.js";
import {
  DEFAULT_SHORTCUTS,
  isShortcutActionId,
  normalizeShortcut,
  sanitizeShortcuts,
  SHORTCUT_ACTION_IDS,
  SHORTCUT_DEFINITIONS,
  type ShortcutActionId,
  type ShortcutSettings,
} from "./shortcuts.js";
import { HOME_PAGE_URL, isHomeUrl } from "./home.js";
import {
  ARCHIVE_AFTER_HOURS,
  ARCHIVE_RETENTION_DAYS,
  DEFAULT_ARCHIVE_AFTER_HOURS,
  DEFAULT_ARCHIVE_RETENTION_DAYS,
} from "./tidy.js";
import {
  AI_SEARCH_PROVIDER_IDS,
  DEFAULT_AI_SEARCH_PROVIDER,
  DEFAULT_WEB_SEARCH_PROVIDER,
  WEB_SEARCH_PROVIDER_IDS,
  type AiSearchProvider,
  type WebSearchProvider,
} from "./search.js";
import { DEFAULT_HOME_URL, isAllowedNavigation } from "./url.js";

/**
 * What ⌘T opens: the home page (`general.homeUrl`), the address bar with
 * nothing in it, or a page the person named (`general.newTabUrl`).
 */
export type NewTabBehavior = "home" | "address" | "url";
export const NEW_TAB_BEHAVIORS: readonly NewTabBehavior[] = [
  "home",
  "address",
  "url",
];

/**
 * What a tab opens with when nothing chose a page: Pistachio's own home page
 * (@pistachio/shell-contracts/home), or an address the person named.
 */
export type HomePageBehavior = "pistachio" | "url";

/**
 * Where the browser chrome lives. "top" is a single titlebar row of tabs;
 * "sidebar" is a vertical column at the window's left edge.
 * Every chrome feature is declared once with a placement in BOTH layouts
 * (renderer/src/chrome/manifest.ts), so switching is a re-arrangement, never
 * a loss of function.
 */
export type ChromeLayoutMode = "top" | "sidebar";
export const CHROME_LAYOUT_MODES: readonly ChromeLayoutMode[] = [
  "sidebar",
  "top",
];

/**
 * How the sidebar behaves when it is the layout. "pinned" keeps it in the
 * window's layout at all times; "compact" hides it (and the window controls
 * with it) and reveals it over the page when the pointer reaches the
 * window's left edge.
 */
export type SidebarPresentation = "pinned" | "compact";
export const SIDEBAR_PRESENTATIONS: readonly SidebarPresentation[] = [
  "pinned",
  "compact",
];

/**
 * A page the organization keeps in everyone's sidebar: the first tiles of
 * the favorites grid, ahead of the person's own, and not removable there.
 * Stored with the rest of the settings so a managed deployment can seed it
 * the way it seeds any other default (a settings.json laid down at install).
 */
export interface PresetLink {
  title: string;
  url: string;
}

export interface DesktopSettings {
  appearance: AppearanceSettings;
  shortcuts: ShortcutSettings;
  /**
   * The first-run walkthrough (@pistachio/shell-contracts/onboarding). `completed` is what
   * decides whether the window opens on the wizard or the browser; it is
   * set by finishing OR skipping it, and cleared by nothing but a reset —
   * Settings → About offers a replay without touching it.
   */
  onboarding: {
    completed: boolean;
    /** When it was finished, or null if it was skipped or never run. */
    completedAt: string | null;
  };
  /**
   * Whether the agent's memory (main/memory-store.ts — its own file) is
   * used. The facts themselves are not settings; these are the switches.
   */
  memory: {
    /** Fold the profile and recalled facts into every run's prompt. */
    enabled: boolean;
    /** Read each finished conversation for facts worth keeping. */
    learnFromRuns: boolean;
  };
  layout: {
    mode: ChromeLayoutMode;
    sidebar: SidebarPresentation;
  };
  organization: {
    /** The organization's links, in the order the grid shows them. */
    presetLinks: PresetLink[];
  };
  general: {
    /** Whether the home page is Pistachio's own or an address of the person's choosing. */
    homePage: HomePageBehavior;
    /**
     * The page a tab shows when nothing else chose one: the window's first
     * tab, a Space opened with none, a split's empty second pane. Always the
     * RESOLVED address — `HOME_PAGE_URL` while `homePage` is "pistachio" —
     * so a host opens it without knowing which of the two it is.
     */
    homeUrl: string;
    /** What ⌘T does: the home page, the address bar, or `newTabUrl`. */
    newTab: NewTabBehavior;
    newTabUrl: string;
    /** The agent chat is open when the window first shows. */
    consoleOpenOnLaunch: boolean;
    /**
     * Make the daily brief (docs/reports.md) on its own each day at
     * `morningBriefTime` — or as soon after as the app is running and awake.
     * Off, a brief is made when it is opened. Off by default: a brief reads
     * the connected mailbox and calendar.
     */
    morningBrief: boolean;
    /** Local wall-clock time, `HH:MM`. */
    morningBriefTime: string;
    /** A system notification when the scheduled brief is ready and the window is not in front. */
    morningBriefNotify: boolean;
    /** Closing a tab that owns a live run asks first. */
    confirmCloseWithRun: boolean;
  };
  /**
   * Where words typed into the address bar go (@pistachio/shell-contracts/search):
   * the address bar offers both for whatever is typed, ↵ on prose runs the
   * web search, and the page menu's "Search … for" uses the same engine.
   */
  search: {
    /** The engine a web search runs on. */
    webProvider: WebSearchProvider;
    /** The assistant a typed prompt is sent to. */
    aiProvider: AiSearchProvider;
    /**
     * Whether typed prose is sent to the intent model so the address bar can
     * put the likeliest action first (@pistachio/shell-contracts/address-intent).
     * Off, nothing typed leaves the device and the bar's own heuristics rank alone.
     */
    smartSuggestions: boolean;
    /**
     * Whether find in page may find by meaning (docs/smart-find.md). A smart
     * find sends the page's visible text and the description to the
     * evaluation model; an exact find never sends anything. Off, the bar is
     * Chromium's find and nothing else.
     */
    smartFind: boolean;
  };
  delegation: {
    /** Prefilled intent in the console's "What should the agent continue?". */
    defaultIntent: string;
    /** Methods a capsule may issue. GET/HEAD/OPTIONS are always granted. */
    allowWrites: boolean;
    allowUploads: boolean;
    allowDownloads: boolean;
    allowClipboard: boolean;
    maxInteractions: number;
    /** Capsule lifetime; the key is destroyed when it lapses. */
    capsuleMinutes: number;
  };
  /**
   * Reminders (main/reminder-store.ts — their own file). The schedule is
   * not a setting; these are the switches around it.
   */
  reminders: {
    /** Fire reminders at all. Off: nothing fires and nothing is marked missed. */
    enabled: boolean;
    /** A native notification when a reminder fires or a scheduled task finishes. */
    desktopNotifications: boolean;
    /** Bring the agent chat forward when a reminder fires. */
    openConsoleOnFire: boolean;
  };
  /**
   * Bookmarks (main/bookmark-store.ts — their own file). What is saved is
   * not a setting; these are the switches around saving.
   */
  bookmarks: {
    /** Tap shift twice to bookmark the page in front. */
    doubleShift: boolean;
    /** Ask the model what the page is about; off reads only the page's own tags. */
    enrichWithModel: boolean;
  };
  approvals: {
    /** How long a pause waits for a decision before the run fails safe. */
    expiryMinutes: number;
    desktopNotifications: boolean;
    flashDock: boolean;
    /** Interrupt the console with the approval card, not just a badge. */
    focusConsoleOnPause: boolean;
  };
  evidence: {
    /** Show each entry's signed payload in the replay, not only its type. */
    showPayloads: boolean;
  };
  privacy: {
    /** Recently-visited chips in the address bar (renderer-side localStorage). */
    rememberRecents: boolean;
  };
  /**
   * Tidy (docs/tab-tidy.md): the pass that archives idle tabs, gathers
   * related ones into groups, and sends favorites home. What is archived is
   * not a setting (main/tab-archive-store.ts — its own file); these are the
   * switches around it.
   */
  tabs: {
    /** Hours a day tab may go unviewed before Tidy archives it; 0 never runs Tidy on its own. */
    archiveAfterHours: number;
    /** Ask the model which tabs belong together, and what to call a group made by hand. Off, Tidy archives by the clock alone and nothing leaves the device. */
    groupRelated: boolean;
    /** A favorite that wandered from its address goes back to it when Tidy runs. */
    resetFavorites: boolean;
    /** Days an archived tab is kept. */
    archiveRetentionDays: number;
  };
  /**
   * The hosted cloud browser (docs/cloud-sync-design.md §10.4). WHETHER a
   * Space may run in the cloud at all is an account fact control owns
   * (`cloud:enable`); this is only what the console offers by default for
   * the next conversation on this Mac.
   */
  cloud: {
    /** Start new conversations in the cloud when the active Space allows it. */
    runByDefault: boolean;
  };
}

export const CAPSULE_MINUTES = [10, 15, 30, 60, 120] as const;
export const MAX_INTERACTIONS = [10, 20, 50, 100] as const;
export const APPROVAL_EXPIRY_MINUTES = [2, 5, 10, 30] as const;

/** `0` is "never": Tidy then runs only when asked. */
export const ARCHIVE_AFTER_HOURS_OPTIONS = [0, ...ARCHIVE_AFTER_HOURS] as const;

export const MAX_PRESET_LINKS = 24;
export const MAX_PRESET_TITLE = 80;

export const DEFAULT_SETTINGS: DesktopSettings = {
  appearance: DEFAULT_APPEARANCE,
  shortcuts: DEFAULT_SHORTCUTS,
  onboarding: {
    completed: false,
    completedAt: null,
  },
  memory: {
    enabled: true,
    learnFromRuns: true,
  },
  layout: {
    mode: "sidebar",
    sidebar: "pinned",
  },
  organization: {
    presetLinks: [],
  },
  general: {
    homePage: "pistachio",
    homeUrl: DEFAULT_HOME_URL,
    newTab: "home",
    newTabUrl: "",
    consoleOpenOnLaunch: false,
    morningBrief: false,
    morningBriefTime: "07:00",
    morningBriefNotify: true,
    confirmCloseWithRun: true,
  },
  search: {
    webProvider: DEFAULT_WEB_SEARCH_PROVIDER,
    aiProvider: DEFAULT_AI_SEARCH_PROVIDER,
    smartSuggestions: true,
    smartFind: true,
  },
  delegation: {
    defaultIntent: "",
    allowWrites: true,
    allowUploads: false,
    allowDownloads: false,
    allowClipboard: false,
    maxInteractions: 20,
    capsuleMinutes: 30,
  },
  reminders: {
    enabled: true,
    desktopNotifications: true,
    openConsoleOnFire: true,
  },
  bookmarks: {
    doubleShift: true,
    enrichWithModel: true,
  },
  approvals: {
    expiryMinutes: 5,
    desktopNotifications: true,
    flashDock: true,
    focusConsoleOnPause: true,
  },
  evidence: {
    showPayloads: true,
  },
  privacy: {
    rememberRecents: true,
  },
  tabs: {
    archiveAfterHours: DEFAULT_ARCHIVE_AFTER_HOURS,
    groupRelated: true,
    resetFavorites: true,
    archiveRetentionDays: DEFAULT_ARCHIVE_RETENTION_DAYS,
  },
  cloud: {
    runByDefault: false,
  },
};

/** The HTTP methods a capsule grant carries for the stored write setting. */
export function grantMethods(settings: DesktopSettings): HttpMethod[] {
  return settings.delegation.allowWrites
    ? ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]
    : ["GET", "HEAD", "OPTIONS"];
}

/**
 * A deep partial the renderer sends: one section at a time, only the fields
 * it changed. Main merges over the current value and sanitizes the result.
 */
export type SettingsPatch = {
  [K in keyof DesktopSettings]?: Partial<DesktopSettings[K]>;
};

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function oneOf<T extends number | string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return (allowed as readonly unknown[]).includes(value)
    ? (value as T)
    : fallback;
}

function text(value: unknown, fallback: string, max: number): string {
  return typeof value === "string" && value.length <= max ? value : fallback;
}

/** An ISO timestamp, or null — never a string that only looks like one. */
function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/**
 * The console's first prefill was this demo sentence, and every settings
 * file written while it was the default still carries it. Read it as "no
 * default instructions", which is what the default has been since.
 */
const RETIRED_DEFAULT_INTENT =
  "Reconcile this invoice, document the variance, and pause before submission.";

function intentText(value: unknown, fallback: string): string {
  const intent = text(value, fallback, 2_000);
  return intent === RETIRED_DEFAULT_INTENT ? "" : intent;
}

/** An http(s) address, or "" — anything else is refused, not stored. */
function webUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048)
    return "";
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : "";
  } catch {
    return "";
  }
}

/**
 * A home page the person named: any address a tab may load — http, https,
 * or the app's own scheme, so the demo portal can still be chosen —
 * normalized the way the URL parser writes it, or null when it is not one.
 */
function customHomeUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048)
    return null;
  if (!isAllowedNavigation(value)) return null;
  return new URL(value).toString();
}

/**
 * Google was the home page before Pistachio had one of its own, and the
 * settings file is written whole, so every file from then holds it whether
 * or not anyone chose it.
 */
const LEGACY_DEFAULT_HOME_URL = "https://www.google.com/";

/**
 * Which home page the stored settings mean. An explicit `homePage` is the
 * answer, so long as a custom one names a page a tab may load. A file
 * written before the field existed chose a page only if it holds one that
 * is not the old default.
 */
function homePageBehavior(
  general: Record<string, unknown>,
  custom: string | null,
): HomePageBehavior {
  if (custom === null) return "pistachio";
  const chosen = general["homePage"];
  if (chosen === "pistachio" || chosen === "url") return chosen;
  return custom === LEGACY_DEFAULT_HOME_URL || isHomeUrl(custom)
    ? "pistachio"
    : "url";
}

/**
 * ⌘T's behavior. "blank" is the address bar as files spelled it while that
 * was the default; the default is the home page now, and an address-bar
 * choice made from here on is written as "address". A page with no address
 * falls back to the default rather than opening nothing.
 */
function newTabBehavior(value: unknown, newTabUrl: string): NewTabBehavior {
  const behavior =
    value === "blank"
      ? "home"
      : oneOf(value, NEW_TAB_BEHAVIORS, DEFAULT_SETTINGS.general.newTab);
  return behavior === "url" && newTabUrl === "" ? "home" : behavior;
}

function section(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The organization's links: each needs an address a tab may load (http,
 * https, or the app's own scheme — the demo portal is one); a missing title
 * falls back to the address's host. Duplicates by address collapse to the
 * first, and the list is capped, so a bad file cannot flood the grid.
 */
export function presetLinks(value: unknown): PresetLink[] {
  if (!Array.isArray(value)) return [];
  const out: PresetLink[] = [];
  const seen = new Set<string>();
  for (const raw of value as unknown[]) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as Record<string, unknown>;
    const url = item["url"];
    if (
      typeof url !== "string" ||
      url.length === 0 ||
      url.length > 2_048 ||
      !isAllowedNavigation(url) ||
      seen.has(url)
    )
      continue;
    seen.add(url);
    const title =
      typeof item["title"] === "string"
        ? item["title"].trim().slice(0, MAX_PRESET_TITLE)
        : "";
    out.push({ title: title === "" ? hostLabel(url) : title, url });
    if (out.length === MAX_PRESET_LINKS) break;
  }
  return out;
}

function hostLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "pistachio:"
      ? parsed.host
      : parsed.host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Fold unknown JSON (a file from an older build, a patch from the renderer)
 * into a complete, valid settings object. Every field falls back to its
 * default individually, so one bad key never discards the rest.
 */
export function sanitizeSettings(input: unknown): DesktopSettings {
  const root = section(input);
  const appearance = section(root["appearance"]);
  const shortcuts = section(root["shortcuts"]);
  const onboarding = section(root["onboarding"]);
  const memory = section(root["memory"]);
  const layout = section(root["layout"]);
  // `workspace` is the pre-Spaces name. Read it as a migration fallback,
  // but every write uses the unambiguous Organization vocabulary.
  const organization = section(root["organization"] ?? root["workspace"]);
  const general = section(root["general"]);
  const search = section(root["search"]);
  const delegation = section(root["delegation"]);
  const reminders = section(root["reminders"]);
  const bookmarks = section(root["bookmarks"]);
  const approvals = section(root["approvals"]);
  const evidence = section(root["evidence"]);
  const privacy = section(root["privacy"]);
  const tabs = section(root["tabs"]);
  const cloud = section(root["cloud"]);
  // An `ai` section (provider keys) may still be in a file written before
  // models came with the account; it is dropped, not carried, on the next write.
  const d = DEFAULT_SETTINGS;
  const newTabUrl = webUrl(general["newTabUrl"]);
  const customHome = customHomeUrl(general["homeUrl"]);
  const homePage = homePageBehavior(general, customHome);
  return {
    appearance: sanitizeAppearance(appearance, d.appearance),
    shortcuts: sanitizeShortcuts(shortcuts, d.shortcuts),
    onboarding: {
      completed: bool(onboarding["completed"], d.onboarding.completed),
      completedAt: isoOrNull(onboarding["completedAt"]),
    },
    memory: {
      enabled: bool(memory["enabled"], d.memory.enabled),
      learnFromRuns: bool(memory["learnFromRuns"], d.memory.learnFromRuns),
    },
    layout: {
      mode: oneOf(layout["mode"], CHROME_LAYOUT_MODES, d.layout.mode),
      sidebar: oneOf(
        layout["sidebar"],
        SIDEBAR_PRESENTATIONS,
        d.layout.sidebar,
      ),
    },
    organization: {
      presetLinks: presetLinks(organization["presetLinks"]),
    },
    general: {
      homePage,
      homeUrl:
        homePage === "url" && customHome !== null ? customHome : HOME_PAGE_URL,
      newTab: newTabBehavior(general["newTab"], newTabUrl),
      newTabUrl,
      consoleOpenOnLaunch: bool(
        general["consoleOpenOnLaunch"],
        d.general.consoleOpenOnLaunch,
      ),
      morningBrief: bool(general["morningBrief"], d.general.morningBrief),
      morningBriefTime:
        typeof general["morningBriefTime"] === "string" && /^([01]\d|2[0-3]):[0-5]\d$/u.test(general["morningBriefTime"])
          ? general["morningBriefTime"]
          : d.general.morningBriefTime,
      morningBriefNotify: bool(general["morningBriefNotify"], d.general.morningBriefNotify),
      confirmCloseWithRun: bool(
        general["confirmCloseWithRun"],
        d.general.confirmCloseWithRun,
      ),
    },
    search: {
      webProvider: oneOf(
        search["webProvider"],
        WEB_SEARCH_PROVIDER_IDS,
        d.search.webProvider,
      ),
      aiProvider: oneOf(
        search["aiProvider"],
        AI_SEARCH_PROVIDER_IDS,
        d.search.aiProvider,
      ),
      smartSuggestions: bool(
        search["smartSuggestions"],
        d.search.smartSuggestions,
      ),
      smartFind: bool(search["smartFind"], d.search.smartFind),
    },
    delegation: {
      defaultIntent: intentText(
        delegation["defaultIntent"],
        d.delegation.defaultIntent,
      ),
      allowWrites: bool(delegation["allowWrites"], d.delegation.allowWrites),
      allowUploads: bool(delegation["allowUploads"], d.delegation.allowUploads),
      allowDownloads: bool(
        delegation["allowDownloads"],
        d.delegation.allowDownloads,
      ),
      allowClipboard: bool(
        delegation["allowClipboard"],
        d.delegation.allowClipboard,
      ),
      maxInteractions: oneOf(
        delegation["maxInteractions"],
        MAX_INTERACTIONS,
        d.delegation.maxInteractions,
      ),
      capsuleMinutes: oneOf(
        delegation["capsuleMinutes"],
        CAPSULE_MINUTES,
        d.delegation.capsuleMinutes,
      ),
    },
    reminders: {
      enabled: bool(reminders["enabled"], d.reminders.enabled),
      desktopNotifications: bool(
        reminders["desktopNotifications"],
        d.reminders.desktopNotifications,
      ),
      openConsoleOnFire: bool(
        reminders["openConsoleOnFire"],
        d.reminders.openConsoleOnFire,
      ),
    },
    bookmarks: {
      doubleShift: bool(bookmarks["doubleShift"], d.bookmarks.doubleShift),
      enrichWithModel: bool(
        bookmarks["enrichWithModel"],
        d.bookmarks.enrichWithModel,
      ),
    },
    approvals: {
      expiryMinutes: oneOf(
        approvals["expiryMinutes"],
        APPROVAL_EXPIRY_MINUTES,
        d.approvals.expiryMinutes,
      ),
      desktopNotifications: bool(
        approvals["desktopNotifications"],
        d.approvals.desktopNotifications,
      ),
      flashDock: bool(approvals["flashDock"], d.approvals.flashDock),
      focusConsoleOnPause: bool(
        approvals["focusConsoleOnPause"],
        d.approvals.focusConsoleOnPause,
      ),
    },
    evidence: {
      showPayloads: bool(evidence["showPayloads"], d.evidence.showPayloads),
    },
    privacy: {
      rememberRecents: bool(
        privacy["rememberRecents"],
        d.privacy.rememberRecents,
      ),
    },
    tabs: {
      archiveAfterHours: oneOf(
        tabs["archiveAfterHours"],
        ARCHIVE_AFTER_HOURS_OPTIONS,
        d.tabs.archiveAfterHours,
      ),
      groupRelated: bool(tabs["groupRelated"], d.tabs.groupRelated),
      resetFavorites: bool(tabs["resetFavorites"], d.tabs.resetFavorites),
      archiveRetentionDays: oneOf(
        tabs["archiveRetentionDays"],
        ARCHIVE_RETENTION_DAYS,
        d.tabs.archiveRetentionDays,
      ),
    },
    cloud: {
      runByDefault: bool(cloud["runByDefault"], d.cloud.runByDefault),
    },
  };
}

/** Merge a patch over `current`, section by section, then sanitize. */
export function applySettingsPatch(
  current: DesktopSettings,
  patch: unknown,
): DesktopSettings {
  const p = section(patch);
  const merged: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<
    keyof DesktopSettings
  >) {
    merged[key] = { ...current[key], ...section(p[key]) };
  }
  // Writing a home address IS choosing one: a patch that names `homeUrl`
  // and says nothing of `homePage` means the address, not Pistachio's page.
  const generalPatch = section(p["general"]);
  if ("homeUrl" in generalPatch && !("homePage" in generalPatch)) {
    (merged["general"] as Record<string, unknown>)["homePage"] = "url";
  }
  refuseShortcutClash(current.shortcuts, section(p["shortcuts"]));
  return sanitizeSettings(merged);
}

/**
 * A patch that hands one action a binding another action holds is refused,
 * not merged: the sanitizer would keep the first of the two in definition
 * order and quietly unassign the other, and the page promised conflicts are
 * never overwritten. The check is against the patch's own result, so a
 * whole-table write (reset all) is judged as one.
 */
function refuseShortcutClash(
  current: ShortcutSettings,
  patch: Record<string, unknown>,
): void {
  const next: Record<string, string | null> = { ...current };
  for (const [id, value] of Object.entries(patch)) {
    if (!isShortcutActionId(id)) continue;
    next[id] = value === null ? null : normalizeShortcut(value);
  }
  for (const id of Object.keys(patch)) {
    if (!isShortcutActionId(id)) continue;
    const binding = next[id];
    if (binding === null || binding === undefined) continue;
    const holder = SHORTCUT_ACTION_IDS.find(
      (other) => other !== id && next[other] === binding,
    );
    if (holder === undefined) continue;
    const label = (candidate: ShortcutActionId) =>
      SHORTCUT_DEFINITIONS.find((definition) => definition.id === candidate)
        ?.label ?? candidate;
    throw new Error(
      `${label(id)} and ${label(holder)} cannot both use ${binding}. Clear one of them first.`,
    );
  }
}

/* ------------------------------ sections ------------------------------- */

/**
 * Every settings section, keyed by address. Shared with main so a deep link
 * (a notification's "open settings" action, a future `pistachio://settings`
 * page) cannot name a section the renderer does not have.
 */
export const SETTINGS_SECTIONS = {
  "": "General",
  appearance: "Appearance",
  delegation: "Agent",
  memory: "Memory",
  reminders: "Reminders",
  bookmarks: "Bookmarks",
  tabs: "Tabs",
  watchtower: "Watchtower",
  integrations: "Integrations",
  approvals: "Approvals & notifications",
  evidence: "Evidence",
  privacy: "Site data",
  "privacy/spaces": "Spaces",
  "privacy/isolation": "Agent isolation",
  account: "Account",
  devices: "Devices",
  sync: "Sync",
  cloud: "Cloud browser",
  egress: "Identity egress",
  vault: "Vault",
  shortcuts: "Keyboard shortcuts",
  about: "About",
} as const;

export type SettingsSection = keyof typeof SETTINGS_SECTIONS;

export function isSettingsSection(value: unknown): value is SettingsSection {
  // An own-property check: `in` would also admit "constructor" and the rest
  // of Object.prototype, and this guards values from another process.
  return typeof value === "string" && Object.hasOwn(SETTINGS_SECTIONS, value);
}
