/**
 * The anti-drift check for the duplicated record types
 * (docs/cloud-sync-design.md §2, §17).
 *
 * `@pistachio/sync-protocol` re-declares the desktop's `Bookmark`,
 * `Reminder`, `MemoryEntry` and `Note` as `BookmarkRecord`, `ReminderRecord`,
 * `MemoryRecord` and `NoteRecord`, because that package is WebCrypto-only and
 * dependency-free while the view modules carry the agent's Node tooling with
 * them. A copy that is not checked is a copy that drifts, and a drifted record
 * type is a silent data-loss bug: a bookmark kind a browser tab cannot name, a
 * reminder schedule a cloud device reads as a different schedule.
 *
 * So the copy is checked here, at COMPILE time, in both directions:
 *
 *  - `Mutual<A, B>` resolves to `true` only when A and B are assignable each
 *    way. Assigning `true` to it fails to compile the moment either side
 *    gains, loses, or retypes a field — including a new member in one of the
 *    literal unions, which a value fixture on its own would not notice.
 *  - Real fixtures are then assigned across the seam, so the check is a thing
 *    a person can read as well as a thing the compiler enforces. They are
 *    plain literals: a cast here would defeat the whole file.
 *
 * When this file stops compiling, change the two declarations together —
 * never widen one side to make it pass.
 */

import { describe, expect, it } from "vitest";
import type {
  BookmarkKind as BookmarkKindRecord,
  BookmarkRecord,
  BrowserSessionRecord,
  BrowserSessionShelfRecord,
  BrowserSessionTabRecord,
  BookmarkStatus as BookmarkStatusRecord,
  MemoryBucket as MemoryBucketRecord,
  MemoryKind as MemoryKindRecord,
  MemoryRecord,
  MemoryReview as MemoryReviewRecord,
  NoteBlobMediaType as NoteBlobMediaTypeRecord,
  NoteBlobRecord,
  NoteRecord,
  ReminderActionRecord,
  ReminderRecord,
  ReminderScheduleRecord,
  ReminderStatus as ReminderStatusRecord,
  ShellAppearanceRecord,
  ShellSettingsValue,
  ShellShortcutAction,
  ShellShortcutsRecord,
} from "@pistachio/sync-protocol";
import type { Bookmark, BookmarkKind, BookmarkStatus } from "../src/bookmarks.js";
import type { MemoryBucket, MemoryEntry, MemoryKind, MemoryReview } from "../src/memory.js";
import type { Note, NoteBlob, NoteBlobMediaType } from "../src/notes.js";
import type { Reminder, ReminderAction, ReminderSchedule, ReminderStatus } from "../src/reminders.js";
import type { AppearanceSettings } from "../src/appearance.js";
import { DEFAULT_SETTINGS, type DesktopSettings } from "../src/settings.js";
import type { ShortcutActionId, ShortcutSettings } from "../src/shortcuts.js";
import type { SidebarState } from "../src/sidebar.js";
import type { BrowserSessionState, BrowserSessionTab } from "../src/tab-session.js";

/** `true` only when A and B are assignable in both directions. Never distributes. */
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/* ------------------------- the whole record shapes ------------------------ */

const _bookmarkShape: Mutual<Bookmark, BookmarkRecord> = true;
const _reminderShape: Mutual<Reminder, ReminderRecord> = true;
const _memoryShape: Mutual<MemoryEntry, MemoryRecord> = true;
/**
 * A note is the same copy again (docs/notes.md §2), and the one where drift
 * would cost the most: the record IS the document. A field the protocol loses
 * is a paragraph that stops travelling between a person's Mac and their tab.
 */
const _noteShape: Mutual<Note, NoteRecord> = true;
const _noteBlobShape: Mutual<NoteBlob, NoteBlobRecord> = true;
/**
 * The browser session record (web-browser-design.md §9) is the same copy in
 * the other direction: the protocol declares the wire shape, the shell states
 * it in its own vocabulary (`SidebarState`, `SplitGroupInfo`), and a session
 * that could not be rebuilt because one side grew a field is exactly the
 * silent loss this file exists to prevent.
 */
const _browserSessionShape: Mutual<BrowserSessionState, BrowserSessionRecord> = true;
const _browserSessionTabShape: Mutual<BrowserSessionTab, BrowserSessionTabRecord> = true;
const _browserSessionShelfShape: Mutual<SidebarState, BrowserSessionShelfRecord> = true;
/**
 * The shell's settings are a sealed account-global register too (§6.3), so
 * they get the same treatment: theme, layout, shortcuts and the home page are
 * what a person set, and a field one side grows and the other does not is a
 * preference that silently stops travelling between their Mac and a tab.
 */
const _shellSettingsShape: Mutual<DesktopSettings, ShellSettingsValue> = true;
const _shellAppearanceShape: Mutual<AppearanceSettings, ShellAppearanceRecord> = true;
const _shellShortcutsShape: Mutual<ShortcutSettings, ShellShortcutsRecord> = true;
const _shellShortcutActions: Mutual<ShortcutActionId, ShellShortcutAction> = true;

/* ------------------ every union the shapes are built from ----------------- */

const _bookmarkKinds: Mutual<BookmarkKind, BookmarkKindRecord> = true;
const _bookmarkStatuses: Mutual<BookmarkStatus, BookmarkStatusRecord> = true;
const _reminderStatuses: Mutual<ReminderStatus, ReminderStatusRecord> = true;
const _reminderSchedules: Mutual<ReminderSchedule, ReminderScheduleRecord> = true;
const _reminderActions: Mutual<ReminderAction, ReminderActionRecord> = true;
const _memoryKinds: Mutual<MemoryKind, MemoryKindRecord> = true;
const _memoryBuckets: Mutual<MemoryBucket, MemoryBucketRecord> = true;
const _memoryReviews: Mutual<MemoryReview, MemoryReviewRecord> = true;
const _noteBlobMediaTypes: Mutual<NoteBlobMediaType, NoteBlobMediaTypeRecord> = true;

/* ------------------------------- fixtures -------------------------------- */

const bookmark: Bookmark = {
  id: "bk-1",
  url: "https://example.com/pie",
  kind: "recipe",
  title: "Sour cherry pie",
  description: "A pie.",
  imageUrl: "https://example.com/pie.jpg",
  faviconUrl: "https://example.com/favicon.ico",
  siteName: "Example",
  keywords: ["pie", "cherry"],
  details: [{ label: "Serves", value: "8" }],
  note: "for Sunday",
  status: "ready",
  provenance: "model",
  editedFields: ["title", "note"],
  source: { kind: "user", runId: null },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

const bookmarkRecord: BookmarkRecord = {
  id: "bk-1",
  url: "https://example.com/pie",
  kind: "recipe",
  title: "Sour cherry pie",
  description: "A pie.",
  imageUrl: "https://example.com/pie.jpg",
  faviconUrl: "https://example.com/favicon.ico",
  siteName: "Example",
  keywords: ["pie", "cherry"],
  details: [{ label: "Serves", value: "8" }],
  note: "for Sunday",
  status: "ready",
  provenance: "model",
  editedFields: ["title", "note"],
  source: { kind: "user", runId: null },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

const reminder: Reminder = {
  id: "rm-1",
  title: "Water the plants",
  schedule: { kind: "weekly", days: [1, 4], time: "07:00" },
  action: { kind: "agent", prompt: "check the forecast" },
  timezone: "America/Denver",
  status: "active",
  source: { kind: "agent", runId: "run-9" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  nextFireAt: "2026-01-05T14:00:00.000Z",
  lastFiredAt: null,
  until: null,
  maxFires: 12,
  fireCount: 3,
};

const reminderRecord: ReminderRecord = {
  id: "rm-1",
  title: "Water the plants",
  schedule: { kind: "weekly", days: [1, 4], time: "07:00" },
  action: { kind: "agent", prompt: "check the forecast" },
  timezone: "America/Denver",
  status: "active",
  source: { kind: "agent", runId: "run-9" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  nextFireAt: "2026-01-05T14:00:00.000Z",
  lastFiredAt: null,
  until: null,
  maxFires: 12,
  fireCount: 3,
};

const memory: MemoryEntry = {
  id: "mem-2",
  rootId: "mem-1",
  parentId: "mem-1",
  version: 2,
  isLatest: true,
  content: "Alex prefers window seats",
  label: "Seats",
  key: "preference.seat",
  kind: "static",
  bucket: "preference",
  source: { kind: "learned", runId: null },
  confidence: 0.8,
  review: "pending",
  mentions: 2,
  createdAt: "2026-01-02T00:00:00.000Z",
  lastRecalledAt: "2026-01-03T00:00:00.000Z",
  isForgotten: false,
  forgottenAt: null,
  forgetAfter: null,
  forgetReason: null,
};

const memoryRecord: MemoryRecord = {
  id: "mem-2",
  rootId: "mem-1",
  parentId: "mem-1",
  version: 2,
  isLatest: true,
  content: "Alex prefers window seats",
  label: "Seats",
  key: "preference.seat",
  kind: "static",
  bucket: "preference",
  source: { kind: "learned", runId: null },
  confidence: 0.8,
  review: "pending",
  mentions: 2,
  createdAt: "2026-01-02T00:00:00.000Z",
  lastRecalledAt: "2026-01-03T00:00:00.000Z",
  isForgotten: false,
  forgottenAt: null,
  forgetAfter: null,
  forgetReason: null,
};

const noteValue: Note = {
  id: "0a1b2c3d4e5f",
  title: "Sour cherry pie",
  markdown: "# Sunday\n\nLattice top.",
  icon: "\u{1F967}",
  blobIds: ["0123456789abcdef01234567"],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  revision: 3,
  source: { kind: "agent", runId: "run-9" },
};

const noteRecord: NoteRecord = {
  id: "0a1b2c3d4e5f",
  title: "Sour cherry pie",
  markdown: "# Sunday\n\nLattice top.",
  icon: "\u{1F967}",
  blobIds: ["0123456789abcdef01234567"],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  revision: 3,
  source: { kind: "agent", runId: "run-9" },
};

const noteBlobValue: NoteBlob = {
  id: "0123456789abcdef01234567",
  mediaType: "image/png",
  byteLength: 1_024,
  data: "aVZCT1J3MEtHZ289",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const noteBlobRecord: NoteBlobRecord = {
  id: "0123456789abcdef01234567",
  mediaType: "image/png",
  byteLength: 1_024,
  data: "aVZCT1J3MEtHZ289",
  createdAt: "2026-01-01T00:00:00.000Z",
};

/* ------------------------ assignable both directions ---------------------- */

const bookmarkAsRecord: BookmarkRecord = bookmark;
const recordAsBookmark: Bookmark = bookmarkRecord;
const reminderAsRecord: ReminderRecord = reminder;
const recordAsReminder: Reminder = reminderRecord;
const memoryAsRecord: MemoryRecord = memory;
const recordAsMemory: MemoryEntry = memoryRecord;
const noteAsRecord: NoteRecord = noteValue;
const recordAsNote: Note = noteRecord;
const noteBlobAsRecord: NoteBlobRecord = noteBlobValue;
const recordAsNoteBlob: NoteBlob = noteBlobRecord;

const browserSession: BrowserSessionState = {
  version: 2,
  spaceId: "work",
  tabs: [
    {
      id: "cloud:1",
      url: "https://example.com/",
      title: "Example",
      favicon: null,
      kind: "human",
      pinnedAnchor: "pin-1",
      lastActiveAt: 1_767_225_600_000,
    },
  ],
  activeTabId: "cloud:1",
  splitGroups: [
    {
      id: "grp-1",
      tabIds: ["cloud:1", "cloud:2"],
      primaryTabId: "cloud:1",
      secondaryTabId: "cloud:2",
      mode: "vertical",
      gridLayout: "span-bottom",
    },
  ],
  shelf: {
    favorites: [{ id: "fav-1", url: "https://example.com/", title: "Example", faviconUrl: null }],
    entries: [{ kind: "pin", id: "pin-1", url: "https://example.com/", title: "Example", faviconUrl: null, folderId: null }],
  },
  zoom: { "example.com": 1.2 },
  permissions: { "example.com": { geolocation: "allow", notifications: "block" } },
  updatedAt: 1_767_225_600_000,
};

const browserSessionRecord: BrowserSessionRecord = {
  version: 2,
  spaceId: "work",
  tabs: [
    {
      id: "cloud:1",
      url: "https://example.com/",
      title: "Example",
      favicon: null,
      kind: "human",
      pinnedAnchor: "pin-1",
      lastActiveAt: 1_767_225_600_000,
    },
  ],
  activeTabId: "cloud:1",
  splitGroups: [
    {
      id: "grp-1",
      tabIds: ["cloud:1", "cloud:2"],
      primaryTabId: "cloud:1",
      secondaryTabId: "cloud:2",
      mode: "vertical",
      gridLayout: "span-bottom",
    },
  ],
  shelf: {
    favorites: [{ id: "fav-1", url: "https://example.com/", title: "Example", faviconUrl: null }],
    entries: [{ kind: "pin", id: "pin-1", url: "https://example.com/", title: "Example", faviconUrl: null, folderId: null }],
  },
  zoom: { "example.com": 1.2 },
  permissions: { "example.com": { geolocation: "allow", notifications: "block" } },
  updatedAt: 1_767_225_600_000,
};

const sessionAsRecord: BrowserSessionRecord = browserSession;
const recordAsSession: BrowserSessionState = browserSessionRecord;

/**
 * The settings the shell ships with, carried across the seam as a value: a
 * field the record grew and the shell did not (or the other way round) fails
 * here as well as in `_shellSettingsShape` above.
 */
const settingsAsRecord: ShellSettingsValue = DEFAULT_SETTINGS;
const recordAsSettings: DesktopSettings = settingsAsRecord;

describe("the record types the protocol re-declares", () => {
  it("mirrors the desktop's own bookmark, reminder, and memory shapes", () => {
    // The real assertions are above, and they are the compiler's. These keep
    // the fixtures honest: a field added to one literal and not the other
    // fails here even where both types still happen to accept it.
    expect(bookmarkAsRecord).toEqual(bookmarkRecord);
    expect(recordAsBookmark).toEqual(bookmark);
    expect(reminderAsRecord).toEqual(reminderRecord);
    expect(recordAsReminder).toEqual(reminder);
    expect(memoryAsRecord).toEqual(memoryRecord);
    expect(recordAsMemory).toEqual(memory);
    expect(noteAsRecord).toEqual(noteRecord);
    expect(recordAsNote).toEqual(noteValue);
    expect(noteBlobAsRecord).toEqual(noteBlobRecord);
    expect(recordAsNoteBlob).toEqual(noteBlobValue);
    expect(sessionAsRecord).toEqual(browserSessionRecord);
    expect(recordAsSession).toEqual(browserSession);
    expect(recordAsSettings).toEqual(DEFAULT_SETTINGS);
    expect([
      _bookmarkShape,
      _reminderShape,
      _memoryShape,
      _bookmarkKinds,
      _bookmarkStatuses,
      _reminderStatuses,
      _reminderSchedules,
      _reminderActions,
      _memoryKinds,
      _memoryBuckets,
      _memoryReviews,
      _noteShape,
      _noteBlobShape,
      _noteBlobMediaTypes,
      _browserSessionShape,
      _browserSessionTabShape,
      _browserSessionShelfShape,
      _shellSettingsShape,
      _shellAppearanceShape,
      _shellShortcutsShape,
      _shellShortcutActions,
    ]).toEqual(Array.from({ length: 21 }, () => true));
  });
});
