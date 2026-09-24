/**
 * The personal records that sync between a person's devices: bookmarks,
 * reminders, and what the agent remembers about them.
 *
 * These mirror the desktop's own types (`@pistachio/agent-runtime/views/*`).
 * They are re-declared here rather than imported because this package is
 * WebCrypto-only and dependency-free — it runs in Electron main, in Node
 * services, and in a browser tab — while the view modules are Node-typed and
 * carry the agent's tooling with them.
 *
 * Re-declaration risks drift, so it is checked rather than trusted:
 * `packages/shell-contracts/test/record-docs.test.ts` asserts assignability in both
 * directions and fails to compile if either side changes shape. Change the two
 * together.
 *
 * Everything here is sealed under the workspace key before it leaves a device
 * (§2 `workspaceSealAad`), so the hub and the control plane store ciphertext
 * and never learn a URL, a reminder, or a fact about anyone.
 */

import type { DurableSplitGroup } from "./workspace.js";

/* ----------------------------------- bookmarks ---------------------------------- */

export const BOOKMARK_KINDS = [
  "website",
  "article",
  "product",
  "book",
  "movie",
  "show",
  "video",
  "music",
  "recipe",
  "place",
  "software",
  "other",
] as const;
export type BookmarkKind = (typeof BOOKMARK_KINDS)[number];
export type BookmarkStatus = "extracting" | "ready";
export type BookmarkProvenance = "model" | "page" | "none";
export type BookmarkSourceKind = "user" | "agent";

/** The fields a person can change by hand; a later reading must not overwrite them. */
export type BookmarkEditableField =
  | "url"
  | "title"
  | "kind"
  | "description"
  | "imageUrl"
  | "siteName"
  | "keywords"
  | "details"
  | "note";

/** One labelled fact read off the page ("Serves", "4 people"). */
export interface BookmarkDetail {
  label: string;
  value: string;
}

/** Who saved it: the person, or the agent in a run. */
export interface BookmarkSource {
  kind: BookmarkSourceKind;
  runId: string | null;
}

export interface BookmarkRecord {
  id: string;
  url: string;
  kind: BookmarkKind;
  title: string;
  description: string;
  imageUrl: string | null;
  faviconUrl: string | null;
  siteName: string;
  keywords: string[];
  details: BookmarkDetail[];
  /** The person's own words about why they kept it. */
  note: string;
  status: BookmarkStatus;
  provenance: BookmarkProvenance;
  editedFields: BookmarkEditableField[];
  source: BookmarkSource;
  createdAt: string;
  updatedAt: string;
}

/* ----------------------------------- reminders ---------------------------------- */

export type ReminderStatus = "active" | "paused" | "done" | "cancelled";
export type ReminderSourceKind = "user" | "agent";

/** When it fires. Wall-clock kinds are read in the reminder's own zone. */
export type ReminderScheduleRecord =
  | { kind: "once"; at: string }
  | { kind: "interval"; everyMinutes: number; startAt: string }
  | { kind: "daily"; time: string }
  | { kind: "weekly"; days: number[]; time: string }
  | { kind: "monthly"; day: number; time: string };

/** What happens when it does: text shown, or an agent turn. */
export type ReminderActionRecord =
  | { kind: "message"; text: string }
  | { kind: "agent"; prompt: string };

export interface ReminderSourceRecord {
  kind: ReminderSourceKind;
  runId: string | null;
}

export interface ReminderRecord {
  id: string;
  title: string;
  schedule: ReminderScheduleRecord;
  action: ReminderActionRecord;
  /** IANA zone the wall-clock schedules are read in. */
  timezone: string;
  status: ReminderStatus;
  source: ReminderSourceRecord;
  createdAt: string;
  updatedAt: string;
  /** The next instant it fires, or null when it never will again. */
  nextFireAt: string | null;
  lastFiredAt: string | null;
  until: string | null;
  maxFires: number | null;
  fireCount: number;
}

/* ------------------------------------ memory ------------------------------------ */

export const MEMORY_BUCKETS = [
  "profile",
  "preference",
  "location",
  "project",
  "contact",
  "account",
  "routine",
  "episode",
  "other",
] as const;
export type MemoryBucket = (typeof MEMORY_BUCKETS)[number];
export type MemoryKind = "static" | "dynamic";
export type MemoryReview = "approved" | "pending" | "declined";
export type MemorySourceKind = "user" | "agent" | "learned";

export interface MemorySourceRecord {
  kind: MemorySourceKind;
  runId: string | null;
}

export interface MemoryRecord {
  id: string;
  rootId: string;
  parentId: string | null;
  version: number;
  /**
   * Derived, never trusted from the wire: a receiving device recomputes it
   * for the whole `rootId` chain (highest version wins), so a correction and
   * the fact it corrects converge whichever order they arrive in.
   */
  isLatest: boolean;
  /** The fact itself. Entity-centric, one line. */
  content: string;
  label: string | null;
  key: string | null;
  kind: MemoryKind;
  bucket: MemoryBucket;
  source: MemorySourceRecord;
  confidence: number;
  review: MemoryReview;
  mentions: number;
  createdAt: string;
  lastRecalledAt: string | null;
  isForgotten: boolean;
  forgottenAt: string | null;
  forgetAfter: string | null;
  forgetReason: string | null;
}

/* ----------------------------------- artifacts --------------------------------- */

/** An artifact's metadata and page travel as one encrypted LWW document. */
export interface ArtifactRecord {
  id: string;
  title: string;
  brief: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  builtWith: string;
  source: { kind: "user" | "agent"; runId: string | null };
  html: string;
}

/* ------------------------------------ notes ------------------------------------ */

/**
 * A note the person writes: metadata AND its markdown in one sealed LWW
 * register, the way an artifact carries its HTML (docs/notes.md N2). No index
 * register — readers list by the `note:` prefix, and an index would be the one
 * key every device contends for.
 */
export interface NoteRecord {
  id: string;
  title: string;
  /** The canonical body. Never includes the title. */
  markdown: string;
  /** One emoji, or null. */
  icon: string | null;
  /** Every note-blob the markdown references, for cleanup and the caps. */
  blobIds: string[];
  createdAt: string;
  updatedAt: string;
  revision: number;
  source: { kind: "user" | "agent"; runId: string | null };
}

export type NoteBlobMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

/**
 * One image a note references, in its own register (N3): immutable and
 * content-addressed, so autosave re-seals kilobytes of text rather than
 * megabytes of picture.
 */
export interface NoteBlobRecord {
  /** Twenty-four hex characters: the SHA-256 prefix of the bytes. */
  id: string;
  mediaType: NoteBlobMediaType;
  byteLength: number;
  /** base64 */
  data: string;
  createdAt: string;
}

/* ------------------------------- browser session -------------------------------- */

/**
 * One tab of a persistent browser session (web-browser-design.md §9). Only
 * what a session can be rebuilt from: the address, what to label it with, and
 * which shelf entry it is the live page of, and optional portable page state.
 * The JS heap is preserved only while the Chromium context lives (W9).
 */
export interface BrowserSessionTabRecord {
  id: string;
  url: string;
  title: string;
  /** Resolved through the Space's cookies and egress, as a data URL, or null. */
  favicon: string | null;
  /** A session's tabs are the person's; a run's agent tabs are the run's, not the session's. */
  kind: "human";
  /** The shelf entry (a pin's or a favorite's id, or `preset:<url>`) this tab is the page of. */
  pinnedAnchor?: string;
  /**
   * When the tab was last in front, so a rebuilt session's tab switcher is
   * still most-recent-first rather than insertion order. Absent in records
   * written before version 2.
   */
  lastActiveAt?: number;
  resume?: { url: string; scrollX: number; scrollY: number; drafts: Array<{ id: string; name: string; value: string }> };
}

/** A shelf favorite, as the session record keeps it (mirrors the shell's `SidebarFavorite`). */
export interface BrowserSessionFavoriteRecord {
  id: string;
  url: string;
  title: string;
  faviconUrl: string | null;
}

export interface BrowserSessionFolderRecord {
  kind: "folder";
  id: string;
  name: string;
  collapsed: boolean;
  /** One of the shell's tab-group colour names, or null for none. */
  color: "gray" | "green" | "blue" | "purple" | "amber" | "pink" | "red" | "orange" | null;
  /** One emoji drawn in place of the folder icon, or null. */
  emoji: string | null;
}

export interface BrowserSessionPinRecord {
  kind: "pin";
  id: string;
  url: string;
  title: string;
  faviconUrl: string | null;
  folderId: string | null;
}

export type BrowserSessionShelfEntryRecord = BrowserSessionFolderRecord | BrowserSessionPinRecord;

/** The shelf — favorites, pins, folders — of one Space (mirrors `SidebarState`). */
export interface BrowserSessionShelfRecord {
  favorites: BrowserSessionFavoriteRecord[];
  entries: BrowserSessionShelfEntryRecord[];
}

/**
 * Bumped to 2 when site permissions joined the record (§9, §11). A worker
 * that only knows version 1 refuses to READ a version-2 record rather than
 * reading it half-way and writing the remainder back, which is how a mixed
 * fleet loses the grants a person gave.
 */
export const BROWSER_SESSION_RECORD_VERSION = 2;

/**
 * A persistent browser session's durable state (§9), sealed under the
 * workspace key as `browser-session:<spaceId>`, so a session suspended on one
 * worker can be rebuilt on whichever worker the next viewer reaches (§6.4).
 *
 * Structurally mirrored by `@pistachio/shell-contracts/tab-session`, and the
 * two are held together by the record-docs parity test.
 */
export interface BrowserSessionRecord {
  version: typeof BROWSER_SESSION_RECORD_VERSION;
  spaceId: string;
  tabs: BrowserSessionTabRecord[];
  activeTabId: string | null;
  splitGroups: DurableSplitGroup[];
  shelf: BrowserSessionShelfRecord;
  /** Per-origin host page zoom, so a zoomed site is still zoomed after a rebuild. */
  zoom: Record<string, number>;
  /**
   * What each site was allowed, per origin host and then per permission
   * (docs/web-browser-design.md §11). The permission names are the shell's
   * `BrowserPermission` set; this package stays dependency-free, so it keeps
   * the shape rather than the union and the parity test holds the two
   * together.
   */
  permissions: Record<string, Record<string, "ask" | "allow" | "block">>;
  updatedAt: number;
}

/* -------------------------------- shell settings -------------------------------- */

/**
 * The shell's own settings, as one sealed account-global register
 * (docs/web-browser-design.md §6.3). The desktop keeps the same object in a
 * file under `userData`; a browser session has no such file, and a person who
 * changed their theme in a browser tab should find it changed the next time
 * the session is rebuilt on another worker.
 *
 * Structurally mirrored by `@pistachio/shell-contracts/settings`'
 * `DesktopSettings`, and held to it by the record-docs parity test. The
 * unions below are re-declared for the same reason every other record's are:
 * this package is dependency-free, and a copy that is not checked drifts.
 */
export type ShellAppearanceScheme = "system" | "light" | "dark";
export type ShellDesktopIconStyle = "white" | "green";
export type ShellGradientHarmony =
  | "complementary"
  | "singleAnalogous"
  | "splitComplementary"
  | "analogous"
  | "triadic"
  | "floating";
export type ShellGradientBlend = "mesh" | "linear" | "radial";
export type ShellToastPosition = "top-left" | "top" | "top-right" | "bottom-left" | "bottom" | "bottom-right";

export interface ShellAppearanceRecord {
  scheme: ShellAppearanceScheme;
  desktopIcon: ShellDesktopIconStyle;
  desktopGlass: boolean;
  glassTint: number;
  gradientEnabled: boolean;
  colors: string[];
  harmony: ShellGradientHarmony;
  blend: ShellGradientBlend;
  angle: number;
  intensity: number;
  texture: number;
  contrast: number;
  surfaceOpacity: number;
  radius: number;
  toastPosition: ShellToastPosition;
}

/** Every action a keyboard shortcut can be bound to (mirrors `ShortcutActionId`). */
export type ShellShortcutAction =
  | "newTab"
  | "editAddress"
  | "closeTab"
  | "togglePin"
  | "reload"
  | "back"
  | "forward"
  | "find"
  | "readerView"
  | "print"
  | "copyUrl"
  | "copyUrlMarkdown"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset"
  | "toggleSplit"
  | "toggleSidebarPinned"
  | "toggleConsole"
  | "toggleEvidence"
  | "openSettings"
  | "openReminders"
  | "openBookmarks"
  | "bookmarkPage"
  | "delegate"
  | "forkSpace"
  | "restoreClosedTab"
  | "openDownloads"
  | "tidyTabs"
  | "smartFind"
  | "newNote"
  | "openNotes";

export type ShellShortcutsRecord = Record<ShellShortcutAction, string | null>;

export type ShellNewTabBehavior = "home" | "address" | "url";
export type ShellHomePageBehavior = "pistachio" | "url";
export type ShellChromeLayoutMode = "top" | "sidebar";
export type ShellSidebarPresentation = "pinned" | "compact";
export type ShellWebSearchProvider = "google" | "duckduckgo" | "yahoo" | "bing";
export type ShellAiSearchProvider = "chatgpt" | "gemini" | "claude" | "grok" | "perplexity";

export interface ShellPresetLinkRecord {
  title: string;
  url: string;
}

export interface ShellSettingsValue {
  appearance: ShellAppearanceRecord;
  shortcuts: ShellShortcutsRecord;
  onboarding: {
    completed: boolean;
    completedAt: string | null;
  };
  memory: {
    enabled: boolean;
    learnFromRuns: boolean;
  };
  layout: {
    mode: ShellChromeLayoutMode;
    sidebar: ShellSidebarPresentation;
  };
  organization: {
    presetLinks: ShellPresetLinkRecord[];
  };
  general: {
    homePage: ShellHomePageBehavior;
    homeUrl: string;
    newTab: ShellNewTabBehavior;
    newTabUrl: string;
    consoleOpenOnLaunch: boolean;
    morningBrief: boolean;
    morningBriefTime: string;
    morningBriefNotify: boolean;
    confirmCloseWithRun: boolean;
  };
  search: {
    webProvider: ShellWebSearchProvider;
    aiProvider: ShellAiSearchProvider;
    /**
     * Whether typed prose may be sent to the intent model so the address bar
     * can rank what it most likely means (docs/smart-suggestions.md §8). A
     * record written before this field existed carries no answer; the shell's
     * own `sanitizeSettings` reads that absence as the default, which is on.
     */
    smartSuggestions: boolean;
    /**
     * Whether find in page may send the page's text to the evaluation model
     * to find a passage by meaning (docs/smart-find.md §8). A record written
     * before this field existed carries no answer; `sanitizeSettings` reads
     * that absence as the default, which is on.
     */
    smartFind: boolean;
  };
  delegation: {
    defaultIntent: string;
    allowWrites: boolean;
    allowUploads: boolean;
    allowDownloads: boolean;
    allowClipboard: boolean;
    maxInteractions: number;
    capsuleMinutes: number;
  };
  reminders: {
    enabled: boolean;
    desktopNotifications: boolean;
    openConsoleOnFire: boolean;
  };
  bookmarks: {
    doubleShift: boolean;
    enrichWithModel: boolean;
  };
  approvals: {
    expiryMinutes: number;
    desktopNotifications: boolean;
    flashDock: boolean;
    focusConsoleOnPause: boolean;
  };
  evidence: {
    showPayloads: boolean;
  };
  privacy: {
    rememberRecents: boolean;
  };
  tabs: {
    archiveAfterHours: number;
    groupRelated: boolean;
    resetFavorites: boolean;
    archiveRetentionDays: number;
  };
  cloud: {
    runByDefault: boolean;
  };
}

export const SHELL_SETTINGS_RECORD_VERSION = 1;

/**
 * The sealed `settings:shell` register (§6.3): one account-global LWW
 * document holding the shell's settings, so theme, layout, shortcuts and the
 * home page survive a suspend and cross between a Mac and a browser tab.
 */
export interface ShellSettingsRecord {
  version: typeof SHELL_SETTINGS_RECORD_VERSION;
  settings: ShellSettingsValue;
  updatedAt: number;
}
