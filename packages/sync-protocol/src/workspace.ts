/**
 * Workspace-state synchronization model (docs/cloud-sync-design.md §2, D9).
 * Every state category has exactly one canonical location and a defined
 * ownership rule — without ownership rules, two active devices constantly
 * rearrange each other's workspace.
 *
 *   Spaces, settings                       → globally synchronized LWW docs
 *   Open tabs (restore point per device)   → `device-workspace:<deviceId>`,
 *                                             writable only by that device;
 *                                             other devices Pull/Merge explicitly
 *   Device liveness                        → `device-activity:<deviceId>`
 *   Authentication state                   → per-origin continuity policy
 */

import { compareHlc, type Hlc } from "./hlc.js";
import type { DeviceKind } from "./device.js";

/* ------------------------------------------------------------------ *
 * Durable tab session — structural copy of the desktop's
 * `shared/tab-session.ts` shapes so this package never imports the app.
 * ------------------------------------------------------------------ */

export type DurableSplitMode = "vertical" | "horizontal" | "grid";

export type DurableSplitGridLayout = "span-top" | "span-bottom" | "span-left" | "span-right";

/** A persistent tab-group whose two to four members reopen together when selected. */
export interface DurableSplitGroup {
  id: string;
  /** Pane order, read left-to-right or top-to-bottom for linear layouts. */
  tabIds: string[];
  /** Compatibility alias for tabIds[0]. */
  primaryTabId: string;
  /** Compatibility alias for tabIds[1]. */
  secondaryTabId: string;
  mode: DurableSplitMode;
  /** Which edge the spanning pane occupies when a three-pane group uses grid mode. */
  gridLayout: DurableSplitGridLayout;
}

export interface DurableTab {
  id: string;
  spaceId: string;
  title: string;
  url: string;
  faviconUrl: string | null;
  anchorId: string | null;
  lastActiveAt: number;
  resume?: { url: string; scrollX: number; scrollY: number; drafts: Array<{ id: string; name: string; value: string }> };
}

/** A titled, coloured run of day tabs kept together (the shell's `TabGroupInfo`). */
export interface DurableTabGroup {
  id: string;
  title: string;
  color: "gray" | "green" | "blue" | "purple" | "amber" | "pink" | "red" | "orange";
  tabIds: string[];
  origin: "auto" | "manual";
  open: boolean;
  createdAt: number;
}

export interface DurableSpaceSession {
  /** Last actual change; republishing an unchanged device must not win a handoff. */
  updatedAt?: number;
  tabs: DurableTab[];
  activeTabId: string | null;
  recentTabIds: string[];
  splitGroups: DurableSplitGroup[];
  /** Absent in restore points written before tab groups. */
  tabGroups?: DurableTabGroup[];
}

export const TAB_SESSION_VERSION = 1;

/** The durable, recoverable part of a device's human browsing session. */
export interface DurableTabSession {
  version: typeof TAB_SESSION_VERSION;
  spaces: Record<string, DurableSpaceSession>;
}

/* ------------------------------------------------------------------ *
 * Docs
 * ------------------------------------------------------------------ */

export type WorkspaceScope = "global" | "device-local";

/** `identity` routes the Space through the user's static-IP egress gateway (D13). */
export type EgressPolicy = "direct" | "identity";

/** Key mode is a visible security state, never a silent downgrade. */
export type KeyMode = "e2ee";

export interface WorkspaceSettings {
  keyMode: KeyMode;
}

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  keyMode: "e2ee",
};

import type {
  ArtifactRecord,
  BookmarkRecord,
  BrowserSessionRecord,
  MemoryRecord,
  NoteBlobRecord,
  NoteRecord,
  ReminderRecord,
  ShellSettingsRecord,
} from "./records.js";

/**
 * Settings fields are synced as INDEPENDENT LWW registers, one doc key each
 * (`settings:keyMode`), so a field only moves when that field was written.
 */
export type WorkspaceSettingsField = "keyMode";

/** Globally synchronized Space metadata (mirrors the desktop's SpaceInfo plus sync fields). */
export interface SpaceDoc {
  kind: "space";
  id: string;
  name: string;
  color: string;
  parentSpaceId: string | null;
  purpose: string;
  createdAt: number;
  /** Origins whose sign-in cookies were copied at fork time. */
  carriedOrigins: string[];
  egressPolicy: EgressPolicy;
  cloudEnabled: boolean;
}

export interface SettingsDoc {
  kind: "settings";
  field: "keyMode";
  value: KeyMode;
}

/** A device's sealed restore point; writable only by `deviceId` (hub-enforced). */
export interface DeviceWorkspaceDoc {
  kind: "deviceWorkspace";
  deviceId: string;
  deviceKind: DeviceKind;
  name: string;
  session: DurableTabSession;
  savedAtMs: number;
}

/** A device's liveness card; writable only by `deviceId` (hub-enforced). */
export interface DeviceActivityDoc {
  kind: "deviceActivity";
  deviceId: string;
  name: string;
  platform: string;
  lastActiveMs: number;
  activeSpaceId: string | null;
}

/**
 * A saved page. Account-global: bookmarks belong to the person, not to the Mac
 * that kept them, so any signed-in device sees the same shelf.
 */
export interface BookmarkDoc {
  kind: "bookmark";
  bookmark: BookmarkRecord;
}

/** A scheduled errand. Account-global for the same reason. */
export interface ReminderDoc {
  kind: "reminder";
  reminder: ReminderRecord;
}

/**
 * One fact the agent holds about the person. Versioned on the desktop
 * (`rootId`/`version`), and each version is its own register so a correction
 * does not race the fact it corrects.
 */
export interface MemoryDoc {
  kind: "memory";
  memory: MemoryRecord;
}

/** A generated page, including its HTML, sealed under the workspace key. */
export interface ArtifactDoc {
  kind: "artifact";
  artifact: ArtifactRecord;
}

/** A note the person wrote, metadata and markdown in one register (docs/notes.md N2). */
export interface NoteDoc {
  kind: "note";
  note: NoteRecord;
}

/**
 * One image a note references, in a register of its own (N3), so a keystroke
 * re-seals the text without the pictures.
 */
export interface NoteBlobDoc {
  kind: "noteBlob";
  blob: NoteBlobRecord;
}

/**
 * A persistent browser session's durable state, one per Space
 * (web-browser-design.md §9). Account-global rather than device-owned: the
 * point of the record is that any worker in the fleet can rebuild the session
 * from it, so it is not written under a `device-` prefix the hub would fence
 * to one device.
 */
export interface BrowserSessionDoc {
  kind: "browserSession";
  session: BrowserSessionRecord;
}

/**
 * The shell's settings, account-global (web-browser-design.md §6.3). Its own
 * key prefix rather than `settings:`, which is reserved for the per-FIELD
 * workspace settings registers (`settings:keyMode`) a reader folds with
 * `applySettingsDoc`; this is one whole document with its own version.
 */
export interface ShellSettingsDoc {
  kind: "shellSettings";
  settings: ShellSettingsRecord;
}

/**
 * Typed workspace document — the plaintext inside a sealed WorkspaceRecordWire.
 * A register holding `null` instead of a doc is a deletion (tombstone).
 */
export type WorkspaceDoc =
  | SpaceDoc
  | SettingsDoc
  | DeviceWorkspaceDoc
  | DeviceActivityDoc
  | BookmarkDoc
  | ReminderDoc
  | MemoryDoc
  | ArtifactDoc
  | NoteDoc
  | NoteBlobDoc
  | BrowserSessionDoc
  | ShellSettingsDoc;

/** A single per-field settings doc (its own LWW register). */
export type WorkspaceSettingsDoc = SettingsDoc;

/** Doc key. Raw ids, no URL encoding — the hub compares them by string equality. */
export function workspaceKeyFor(doc: WorkspaceDoc): string {
  switch (doc.kind) {
    case "space":
      return `space:${doc.id}`;
    case "settings":
      return `settings:${doc.field}`;
    case "deviceWorkspace":
      return `device-workspace:${doc.deviceId}`;
    case "deviceActivity":
      return `device-activity:${doc.deviceId}`;
    case "bookmark":
      return `bookmark:${doc.bookmark.id}`;
    case "reminder":
      return `reminder:${doc.reminder.id}`;
    case "memory":
      return `memory:${doc.memory.id}`;
    case "artifact":
      return `artifact:${doc.artifact.id}`;
    case "note":
      return `note:${doc.note.id}`;
    case "noteBlob":
      return `note-blob:${doc.blob.id}`;
    case "browserSession":
      return `browser-session:${doc.session.spaceId}`;
    case "shellSettings":
      return SHELL_SETTINGS_KEY;
  }
}

/** The one key the shell's settings document lives under (§6.3). */
export const SHELL_SETTINGS_KEY = "shell-settings:default";

/** Key prefixes that are account-global personal records (§17). */
export const RECORD_KEY_PREFIXES = ["bookmark:", "reminder:", "memory:", "artifact:", "note:", "note-blob:"] as const;

/** The record id a personal-record key names, or null for any other key. */
export function recordKeyId(key: string, prefix: (typeof RECORD_KEY_PREFIXES)[number]): string | null {
  return key.startsWith(prefix) ? key.slice(prefix.length) : null;
}

/** Every settings field as its own LWW doc — hydration/reconcile mapping. */
export function settingsDocs(settings: WorkspaceSettings): WorkspaceSettingsDoc[] {
  return [{ kind: "settings", field: "keyMode", value: settings.keyMode }];
}

/** Fold one per-field settings doc into a settings object (LWW winner apply). */
export function applySettingsDoc(
  settings: WorkspaceSettings,
  doc: WorkspaceSettingsDoc,
): WorkspaceSettings {
  switch (doc.field) {
    case "keyMode":
      return { ...settings, keyMode: doc.value };
  }
}

/* ------------------------------------------------------------------ *
 * Restore-point bounding
 * ------------------------------------------------------------------ */

/**
 * Plaintext ceiling for a `device-workspace` doc's session before sealing.
 * Every other workspace doc has a natural bound (an artifact's HTML is
 * capped, a memory is one fact), but a restore point grows with the tabs a
 * person keeps: a favicon may be a 16 KB `data:` URL and a Space may hold
 * 200 tabs, so an unbounded session reaches hundreds of megabytes and no
 * longer fits a hub frame. Sealed base64 is ~4/3 of this, well inside
 * `FRAME_BUDGET_BYTES`.
 */
export const MAX_RESTORE_POINT_BYTES = 1_000_000;

/** JSON allowance per tab: field names, quotes, commas, `lastActiveAt`. */
const TAB_ENVELOPE_BYTES = 160;
/** JSON allowance per Space: key, the four wrapper fields, brackets. */
const SPACE_ENVELOPE_BYTES = 256;

function tabBytes(tab: DurableTab): number {
  return (
    tab.id.length +
    tab.spaceId.length +
    tab.title.length +
    tab.url.length +
    (tab.faviconUrl?.length ?? 0) +
    (tab.anchorId?.length ?? 0) +
    (tab.resume ? JSON.stringify(tab.resume).length * 6 : 0) +
    TAB_ENVELOPE_BYTES
  );
}

function sessionBytes(session: DurableTabSession): number {
  let total = 64;
  for (const [spaceId, space] of Object.entries(session.spaces)) {
    total += spaceId.length + SPACE_ENVELOPE_BYTES;
    for (const tab of space.tabs) total += tabBytes(tab);
    total += space.recentTabIds.reduce((sum, id) => sum + id.length + 3, 0);
    total += space.splitGroups.length * 192;
    for (const group of space.tabGroups ?? []) total += 160 + group.title.length + group.tabIds.reduce((sum, id) => sum + id.length + 3, 0);
  }
  return total;
}

/** Rebuild a Space's session around `keep`, repairing every id that referred
 * to a dropped tab. A split group that lost a member is dropped whole — a
 * group reopens its panes together, so a partial one is not the same group. */
function withTabs(space: DurableSpaceSession, keep: readonly DurableTab[]): DurableSpaceSession {
  const ids = new Set(keep.map((tab) => tab.id));
  return {
    tabs: [...keep],
    activeTabId: space.activeTabId !== null && ids.has(space.activeTabId) ? space.activeTabId : (keep[0]?.id ?? null),
    recentTabIds: space.recentTabIds.filter((id) => ids.has(id)),
    splitGroups: space.splitGroups.filter((group) => group.tabIds.every((id) => ids.has(id))),
    // A tab group, unlike a split, is still itself with fewer tabs: it keeps the members that survived.
    ...(space.tabGroups === undefined
      ? {}
      : {
          tabGroups: space.tabGroups
            .map((group) => ({ ...group, tabIds: group.tabIds.filter((id) => ids.has(id)) }))
            .filter((group) => group.tabIds.length > 0),
        }),
  };
}

/**
 * Trim a restore point to `maxBytes`, cheapest loss first: `data:` favicons
 * go before any tab does (they are decoration the browser refetches), then
 * the least recently active tabs across every Space. Every Space keeps at
 * least its active tab, so a restart never reopens a person's window on a
 * Space that lost everything — a thinned Space is recoverable, a deleted
 * one reads as data loss. A session already at that floor is published as
 * it stands even if it is over budget; the sender's frame guard is what
 * catches an undeliverable doc.
 *
 * Returns the session unchanged when it already fits.
 */
export function boundRestorePoint(
  session: DurableTabSession,
  maxBytes: number = MAX_RESTORE_POINT_BYTES,
): DurableTabSession {
  if (sessionBytes(session) <= maxBytes) return session;

  // Page details yield to tab identity when the encrypted document is full.
  const spaces: Record<string, DurableSpaceSession> = {};
  for (const [spaceId, space] of Object.entries(session.spaces)) {
    spaces[spaceId] = {
      ...space,
      tabs: space.tabs.map((tab) => {
        const { resume: _resume, ...identity } = tab;
        return { ...identity, faviconUrl: tab.faviconUrl?.startsWith("data:") ? null : tab.faviconUrl };
      }),
    };
  }
  let trimmed: DurableTabSession = { version: session.version, spaces };
  if (sessionBytes(trimmed) <= maxBytes) return trimmed;

  // Oldest-first across the whole session. Every Space holds one tab back —
  // its active tab, or its most recent one — so trimming thins a Space but
  // never deletes it. One tab per Space is ~1 KB and there are at most
  // MAX_DECLARED_SPACES of them, so the floor always fits the budget.
  const droppable = Object.entries(trimmed.spaces)
    .flatMap(([spaceId, space]) => {
      const held =
        space.activeTabId !== null && space.tabs.some((tab) => tab.id === space.activeTabId)
          ? space.activeTabId
          : [...space.tabs].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]?.id;
      return space.tabs.filter((tab) => tab.id !== held).map((tab) => ({ spaceId, tab }));
    })
    .sort((a, b) => a.tab.lastActiveAt - b.tab.lastActiveAt);

  const dropped = new Set<string>();
  let bytes = sessionBytes(trimmed);
  for (const entry of droppable) {
    if (bytes <= maxBytes) break;
    dropped.add(`${entry.spaceId}\u0000${entry.tab.id}`);
    bytes -= tabBytes(entry.tab);
  }

  const kept: Record<string, DurableSpaceSession> = {};
  for (const [spaceId, space] of Object.entries(trimmed.spaces)) {
    const keep = space.tabs.filter((tab) => !dropped.has(`${spaceId}\u0000${tab.id}`));
    if (keep.length > 0) kept[spaceId] = withTabs(space, keep);
  }
  trimmed = { version: trimmed.version, spaces: kept };
  return trimmed;
}

export interface LwwRegister<T> {
  value: T | null;
  hlc: Hlc;
}

/** LWW merge for globally-synchronized workspace records. Returns the winner. */
export function mergeLww<T>(
  current: LwwRegister<T> | undefined,
  incoming: LwwRegister<T>,
): LwwRegister<T> {
  if (!current) return incoming;
  return compareHlc(incoming.hlc, current.hlc) > 0 ? incoming : current;
}
