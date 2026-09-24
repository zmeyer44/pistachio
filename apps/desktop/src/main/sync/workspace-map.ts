/**
 * Pure workspace-sync logic (docs/cloud-sync-design.md §10.2, D9):
 * SpaceStore state ⇄ WorkspaceDoc mapping, the LWW+HLC merge decision for
 * incoming docs, and the readers that turn an opened doc value back into a
 * typed doc. No Electron, no I/O — unit tests exercise this module directly.
 * The seal AAD and signature layouts live in @pistachio/sync-protocol.
 */

import {
  mergeLww,
  recordKeyId,
  settingsDocs,
  workspaceKeyFor,
  RECORD_KEY_PREFIXES,
  type BookmarkRecord,
  type ArtifactRecord,
  type DeviceActivityDoc,
  type DeviceWorkspaceDoc,
  type Hlc,
  type MemoryRecord,
  type NoteBlobRecord,
  type NoteRecord,
  type ReminderRecord,
  type SpaceDoc,
  type WorkspaceDoc,
  type WorkspaceSettings,
} from "@pistachio/sync-protocol";
import type { RemoteRestorePoint } from "@pistachio/shell-contracts/ipc";
import type { SpaceInfo } from "@pistachio/shell-contracts/spaces";
import { sanitizeTabSession } from "@pistachio/shell-contracts/tab-session";

export const SPACE_KEY_PREFIX = "space:";
export const SETTINGS_KEY_PREFIX = "settings:";
export const DEVICE_WORKSPACE_KEY_PREFIX = "device-workspace:";
export const DEVICE_ACTIVITY_KEY_PREFIX = "device-activity:";

/**
 * The account-global personal records: what a person saves, schedules, and
 * is remembered for. One register per record — and for memory, one per
 * VERSION — so two devices editing different bookmarks never contend.
 */
export const WORKSPACE_RECORD_KINDS = ["bookmark", "reminder", "memory", "artifact", "note", "noteBlob"] as const;
export type WorkspaceRecordKind = (typeof WORKSPACE_RECORD_KINDS)[number];

/**
 * The key prefix each kind lives under, and the field its doc carries the
 * record in. Only notes need saying: `noteBlob` is `note-blob:` on the wire
 * and `blob` inside its doc, so neither can be derived from the kind's name
 * the way the first four are.
 */
const RECORD_KIND_KEYS: Record<WorkspaceRecordKind, { prefix: (typeof RECORD_KEY_PREFIXES)[number]; field: string }> = {
  bookmark: { prefix: "bookmark:", field: "bookmark" },
  reminder: { prefix: "reminder:", field: "reminder" },
  memory: { prefix: "memory:", field: "memory" },
  artifact: { prefix: "artifact:", field: "artifact" },
  note: { prefix: "note:", field: "note" },
  noteBlob: { prefix: "note-blob:", field: "blob" },
};

/** The globally synchronized categories: Spaces and the per-field settings. */
export interface GlobalWorkspaceState {
  spaces: SpaceInfo[];
  settings: WorkspaceSettings;
}

/** A Space as its account-global doc. */
export function spaceDocFor(space: SpaceInfo): SpaceDoc {
  return {
    kind: "space",
    id: space.id,
    name: space.name,
    color: space.color,
    parentSpaceId: space.parentSpaceId,
    purpose: space.purpose,
    createdAt: space.createdAt,
    carriedOrigins: [...space.carriedOrigins],
    egressPolicy: space.egressPolicy,
    cloudEnabled: space.cloudEnabled,
  };
}

/** Map the globally-synced categories to their WorkspaceDocs. */
export function docsForState(state: GlobalWorkspaceState): WorkspaceDoc[] {
  return [
    ...state.spaces.map((space): WorkspaceDoc => spaceDocFor(space)),
    // Settings fan out to one independent LWW doc per field.
    ...settingsDocs(state.settings),
  ];
}

/** The Space id a `space:` key names, or null for any other key. */
export function spaceIdOfKey(key: string): string | null {
  if (!key.startsWith(SPACE_KEY_PREFIX)) return null;
  const id = key.slice(SPACE_KEY_PREFIX.length);
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id) ? id : null;
}

/** One record as its account-global doc. The record is the store's own shape (§17). */
export function recordDocFor(kind: WorkspaceRecordKind, record: unknown): WorkspaceDoc {
  switch (kind) {
    case "bookmark":
      return { kind: "bookmark", bookmark: record as BookmarkRecord };
    case "reminder":
      return { kind: "reminder", reminder: record as ReminderRecord };
    case "memory":
      return { kind: "memory", memory: record as MemoryRecord };
    case "artifact":
      return { kind: "artifact", artifact: record as ArtifactRecord };
    case "note":
      return { kind: "note", note: record as NoteRecord };
    case "noteBlob":
      return { kind: "noteBlob", blob: record as NoteBlobRecord };
  }
}

/** The record inside a record doc. */
export function recordOfDoc(doc: WorkspaceDoc): unknown {
  switch (doc.kind) {
    case "bookmark":
      return doc.bookmark;
    case "reminder":
      return doc.reminder;
    case "memory":
      return doc.memory;
    case "artifact":
      return doc.artifact;
    case "note":
      return doc.note;
    case "noteBlob":
      return doc.blob;
    default:
      return null;
  }
}

/** `bookmark:<id>` → its kind and id; null for any other key. */
export function recordKeyParts(key: string): { kind: WorkspaceRecordKind; id: string } | null {
  for (const kind of WORKSPACE_RECORD_KINDS) {
    const id = recordKeyId(key, RECORD_KIND_KEYS[kind].prefix);
    if (id === null || id === "") continue;
    return { kind, id };
  }
  return null;
}

/** The doc key a record of `kind` with `id` lives under. */
export function recordKeyOf(kind: WorkspaceRecordKind, id: string): string {
  return workspaceKeyFor(recordDocFor(kind, { id }));
}

/**
 * A remote value as a record doc for `kind`/`id`, or undefined when it is
 * not one. Only the envelope is checked here: the record itself is the
 * store's to sanitize, which is where its shape is actually known.
 */
export function readRecordDoc(kind: WorkspaceRecordKind, id: string, value: unknown): WorkspaceDoc | undefined {
  if (!isRecord(value) || value["kind"] !== kind) return undefined;
  const inner = value[RECORD_KIND_KEYS[kind].field];
  if (!isRecord(inner) || inner["id"] !== id) return undefined;
  return recordDocFor(kind, inner);
}

/** The device id a `device-workspace:` / `device-activity:` key names (raw, D24). */
export function deviceIdOfKey(key: string, prefix: string): string | null {
  if (!key.startsWith(prefix)) return null;
  const id = key.slice(prefix.length);
  return id.length === 0 ? null : id;
}

/** A local workspace LWW register: null value ⇒ tombstone (deleted doc). */
export interface WorkspaceRegister {
  doc: WorkspaceDoc | null;
  hlc: Hlc;
}

/** An incoming (already-unsealed) remote workspace doc. */
export interface IncomingWorkspaceDoc {
  key: string;
  value: WorkspaceDoc | null;
  hlc: Hlc;
}

export interface MergeDecision {
  /** Remote winners to apply into local state (and adopt their HLC). */
  apply: IncomingWorkspaceDoc[];
  /**
   * Remote docs that win on HLC but whose value already equals local state —
   * adopt the HLC only. Applying nothing here is the echo suppression: a doc
   * that matches local state must never trigger a state change or republish.
   */
  adoptHlc: IncomingWorkspaceDoc[];
}

export function docValueEquals(a: WorkspaceDoc | null, b: WorkspaceDoc | null): boolean {
  // Docs are plain data built by the same code paths, so JSON equality holds.
  return JSON.stringify(a) === JSON.stringify(b);
}

/** LWW+HLC (protocol mergeLww) decision for incoming docs vs local registers. */
export function decideMerge(
  local: Readonly<Record<string, WorkspaceRegister>>,
  incoming: readonly IncomingWorkspaceDoc[],
): MergeDecision {
  const apply: IncomingWorkspaceDoc[] = [];
  const adoptHlc: IncomingWorkspaceDoc[] = [];
  for (const doc of incoming) {
    const current = local[doc.key];
    if (current === undefined) {
      apply.push(doc);
      continue;
    }
    const incomingRegister = { value: doc.value, hlc: doc.hlc };
    if (mergeLww({ value: current.doc, hlc: current.hlc }, incomingRegister) !== incomingRegister) {
      continue; // local wins (or equal HLC — merge is idempotent)
    }
    if (docValueEquals(current.doc, doc.value)) adoptHlc.push(doc);
    else apply.push(doc);
  }
  return { apply, adoptHlc };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A remote device's restore point, or null when the value is not one for `expectedDeviceId`. */
export function readDeviceWorkspaceDoc(
  expectedDeviceId: string,
  value: unknown,
): DeviceWorkspaceDoc | null {
  if (!isRecord(value) || value["kind"] !== "deviceWorkspace") return null;
  if (value["deviceId"] !== expectedDeviceId) return null;
  const session = sanitizeTabSession(value["session"]);
  const deviceKind = value["deviceKind"] === "cloud" ? "cloud" : "desktop";
  return {
    kind: "deviceWorkspace",
    deviceId: expectedDeviceId,
    deviceKind,
    name: typeof value["name"] === "string" ? value["name"].trim().slice(0, 120) : "",
    session,
    savedAtMs:
      typeof value["savedAtMs"] === "number" && Number.isFinite(value["savedAtMs"]) && value["savedAtMs"] >= 0
        ? value["savedAtMs"]
        : 0,
  };
}

/** A remote device's liveness card, or null when the value is not one for `expectedDeviceId`. */
export function readDeviceActivityDoc(
  expectedDeviceId: string,
  value: unknown,
): DeviceActivityDoc | null {
  if (!isRecord(value) || value["kind"] !== "deviceActivity") return null;
  if (value["deviceId"] !== expectedDeviceId) return null;
  return {
    kind: "deviceActivity",
    deviceId: expectedDeviceId,
    name: typeof value["name"] === "string" ? value["name"].trim().slice(0, 120) : "",
    platform: typeof value["platform"] === "string" ? value["platform"] : "",
    lastActiveMs:
      typeof value["lastActiveMs"] === "number" && Number.isFinite(value["lastActiveMs"]) ? value["lastActiveMs"] : 0,
    activeSpaceId: typeof value["activeSpaceId"] === "string" ? value["activeSpaceId"] : null,
  };
}

/** What the settings page lists for a remote restore point (§10.5). */
export function restorePointInfo(
  doc: DeviceWorkspaceDoc,
  activity: DeviceActivityDoc | null,
): RemoteRestorePoint {
  const spaces = Object.entries(doc.session.spaces);
  const fallback = `${doc.deviceKind === "cloud" ? "Cloud browser" : "Mac"} ${doc.deviceId.slice(0, 8)}`;
  return {
    deviceId: doc.deviceId,
    name: doc.name || activity?.name || fallback,
    deviceKind: doc.deviceKind,
    savedAtMs: doc.savedAtMs,
    tabCount: spaces.reduce((count, [, space]) => count + space.tabs.length, 0),
    spaceIds: spaces.map(([spaceId]) => spaceId),
  };
}
