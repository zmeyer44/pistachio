/**
 * Bookmarks, reminders, memory and Space metadata, read from the hub.
 *
 * The hub stores every workspace document as ciphertext and never holds a key,
 * so this browser opens a socket like any other device, hydrates the sealed
 * documents, and unseals them here with the workspace key it derived from the
 * account password.
 *
 * Every document is checked against the account's enrolled devices before it is
 * opened. Without that, a hub that kept the ciphertext of an old document could
 * re-serve it under a fabricated newer clock and roll a reader's view back.
 */

import { WsTransport } from "@pistachio/sync-engine";
import {
  fromBase64,
  fromUtf8,
  importPublicKeyRaw,
  open,
  workspaceSealAad,
  workspaceSigningBytes,
  type BookmarkRecord,
  type ArtifactRecord,
  type MemoryRecord,
  type NoteBlobRecord,
  type NoteRecord,
  type ReminderRecord,
  type SpaceKeys,
  type SpaceDoc,
  type WorkspaceRecordWire,
} from "@pistachio/sync-protocol";
import { listDevices } from "./control";

export interface WorkspaceView {
  artifacts: ArtifactRecord[];
  bookmarks: BookmarkRecord[];
  /** The person's own writing (docs/notes.md N2), newest edit first. */
  notes: NoteRecord[];
  /**
   * The pictures those notes reference (N3), by blob id. They are held in the
   * view with their bytes because the viewer renders a note into a sandboxed
   * iframe with no network at all: every picture has to travel inside the
   * document as a `data:` URI, so the bytes must already be here, decrypted.
   */
  noteBlobs: Map<string, NoteBlobRecord>;
  reminders: ReminderRecord[];
  memory: MemoryRecord[];
  spaces: SpaceDoc[];
  /** Documents whose signature or seal did not check out, surfaced rather than hidden. */
  rejected: number;
}

export const emptyView = (): WorkspaceView => ({
  artifacts: [],
  bookmarks: [],
  notes: [],
  noteBlobs: new Map(),
  reminders: [],
  memory: [],
  spaces: [],
  rejected: 0,
});

type Verifier = (wire: WorkspaceRecordWire) => Promise<boolean>;

/** How long a feed waits before reading the device registry again. */
const VERIFIER_RETRY_MS = 5_000;

/**
 * Verify against the account's non-revoked devices, keyed by the clock's
 * device id (§10.2, D15).
 *
 * A registry that could not be read RAISES rather than answering an empty
 * one: without it nothing can be trusted, and a verifier that rejects
 * everything is indistinguishable from a workspace of forged documents. The
 * caller retries instead of keeping it.
 */
async function deviceVerifier(getToken: () => Promise<string | null>): Promise<Verifier> {
  const keys = new Map<string, CryptoKey>();
  const token = await getToken();
  if (token === null) throw new Error("this browser holds no device token");
  const { devices } = await listDevices(token);
  for (const device of devices) {
    if (device.revokedAt !== null) continue;
    keys.set(device.id, await importPublicKeyRaw(fromBase64(device.devicePublicKey)));
  }
  return async (wire) => {
    const key = keys.get(wire.hlc.deviceId);
    if (key === undefined) return false;
    try {
      return await crypto.subtle.verify(
        "Ed25519",
        key,
        fromBase64(wire.deviceSig) as BufferSource,
        workspaceSigningBytes(wire.key, wire.sealedValue, wire.hlc) as BufferSource,
      );
    } catch {
      return false;
    }
  };
}

/** Newest wins per key, the same rule every device applies (LWW by hybrid clock). */
function newestPerKey(wires: WorkspaceRecordWire[]): Map<string, WorkspaceRecordWire> {
  const winners = new Map<string, WorkspaceRecordWire>();
  for (const wire of wires) {
    const held = winners.get(wire.key);
    if (
      held === undefined ||
      wire.hlc.physicalMs > held.hlc.physicalMs ||
      (wire.hlc.physicalMs === held.hlc.physicalMs && wire.hlc.logical > held.hlc.logical)
    ) {
      winners.set(wire.key, wire);
    }
  }
  return winners;
}

async function openDoc(keys: SpaceKeys, wire: WorkspaceRecordWire): Promise<unknown> {
  if (wire.sealedValue === null) return null; // a tombstone: the record was deleted
  const bytes = await open(keys.sealKey, fromBase64(wire.sealedValue), workspaceSealAad(wire.key));
  return JSON.parse(fromUtf8(bytes)) as unknown;
}

const ARTIFACT_ID_RE = /^[a-f0-9]{12}$/u;
const MAX_ARTIFACT_HTML_BYTES = 1_500_000;

/** The web renderer treats workspace plaintext as hostile until its shape is checked. */
function artifactRecord(value: unknown): ArtifactRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const artifact = value as Partial<ArtifactRecord>;
  if (
    typeof artifact.id !== "string" || !ARTIFACT_ID_RE.test(artifact.id) ||
    typeof artifact.title !== "string" || artifact.title.trim() === "" || artifact.title.length > 120 ||
    typeof artifact.brief !== "string" || artifact.brief.length > 2_000 ||
    typeof artifact.html !== "string" || new TextEncoder().encode(artifact.html).byteLength > MAX_ARTIFACT_HTML_BYTES ||
    typeof artifact.builtWith !== "string" ||
    typeof artifact.createdAt !== "string" || Number.isNaN(Date.parse(artifact.createdAt)) ||
    typeof artifact.updatedAt !== "string" || Number.isNaN(Date.parse(artifact.updatedAt)) ||
    typeof artifact.revision !== "number" || !Number.isInteger(artifact.revision) || artifact.revision < 1 ||
    typeof artifact.source !== "object" || artifact.source === null ||
    (artifact.source.kind !== "user" && artifact.source.kind !== "agent") ||
    (artifact.source.runId !== null && typeof artifact.source.runId !== "string")
  ) return null;
  return artifact as ArtifactRecord;
}

// The note caps, restated rather than imported (docs/notes.md N4). The shapes
// this module checks come from a hub that holds only ciphertext it cannot
// read, so what arrives is plaintext of unknown provenance either way; and
// this package stays light on purpose — it is loaded by the front door.
const NOTE_ID_RE = /^[a-f0-9]{12}$/u;
const NOTE_BLOB_ID_RE = /^[a-f0-9]{24}$/u;
const MAX_NOTE_TITLE = 200;
const MAX_NOTE_MARKDOWN_BYTES = 262_144;
const MAX_NOTE_BLOB_BYTES = 1_500_000;
/** Base64 is four characters per three bytes, plus padding. */
const MAX_NOTE_BLOB_BASE64 = Math.ceil(MAX_NOTE_BLOB_BYTES / 3) * 4 + 4;
const NOTE_BLOB_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function noteRecord(value: unknown): NoteRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const note = value as Partial<NoteRecord>;
  if (
    typeof note.id !== "string" || !NOTE_ID_RE.test(note.id) ||
    typeof note.title !== "string" || note.title.length > MAX_NOTE_TITLE ||
    typeof note.markdown !== "string" ||
    new TextEncoder().encode(note.markdown).byteLength > MAX_NOTE_MARKDOWN_BYTES ||
    (note.icon !== null && typeof note.icon !== "string") ||
    !Array.isArray(note.blobIds) || note.blobIds.some((id) => typeof id !== "string" || !NOTE_BLOB_ID_RE.test(id)) ||
    typeof note.createdAt !== "string" || Number.isNaN(Date.parse(note.createdAt)) ||
    typeof note.updatedAt !== "string" || Number.isNaN(Date.parse(note.updatedAt)) ||
    typeof note.revision !== "number" || !Number.isInteger(note.revision) || note.revision < 1 ||
    typeof note.source !== "object" || note.source === null ||
    (note.source.kind !== "user" && note.source.kind !== "agent") ||
    (note.source.runId !== null && typeof note.source.runId !== "string")
  ) return null;
  return note as NoteRecord;
}

function noteBlobRecord(value: unknown): NoteBlobRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const blob = value as Partial<NoteBlobRecord>;
  if (
    typeof blob.id !== "string" || !NOTE_BLOB_ID_RE.test(blob.id) ||
    typeof blob.mediaType !== "string" || !NOTE_BLOB_MEDIA_TYPES.has(blob.mediaType) ||
    typeof blob.byteLength !== "number" || !Number.isInteger(blob.byteLength) ||
    blob.byteLength < 1 || blob.byteLength > MAX_NOTE_BLOB_BYTES ||
    typeof blob.data !== "string" || blob.data === "" || blob.data.length > MAX_NOTE_BLOB_BASE64 ||
    typeof blob.createdAt !== "string" || Number.isNaN(Date.parse(blob.createdAt))
  ) return null;
  return blob as NoteBlobRecord;
}

/** Fold the sealed documents this account holds into something a page can render. */
export async function readWorkspace(
  wires: WorkspaceRecordWire[],
  workspaceKeys: SpaceKeys,
  verify: Verifier,
): Promise<WorkspaceView> {
  const view = emptyView();
  for (const wire of newestPerKey(wires).values()) {
    if (!(await verify(wire))) {
      view.rejected += 1;
      continue;
    }
    let doc: unknown;
    try {
      doc = await openDoc(workspaceKeys, wire);
    } catch {
      view.rejected += 1;
      continue;
    }
    if (doc === null || typeof doc !== "object") continue;
    const record = doc as { kind?: unknown };
    if (record.kind === "artifact") {
      const artifact = artifactRecord((doc as { artifact?: unknown }).artifact);
      if (artifact === null) view.rejected += 1;
      else view.artifacts.push(artifact);
    } else if (record.kind === "note") {
      const note = noteRecord((doc as { note?: unknown }).note);
      if (note === null) view.rejected += 1;
      else view.notes.push(note);
    } else if (record.kind === "noteBlob") {
      const blob = noteBlobRecord((doc as { blob?: unknown }).blob);
      if (blob === null) view.rejected += 1;
      else view.noteBlobs.set(blob.id, blob);
    } else if (record.kind === "bookmark") view.bookmarks.push((doc as { bookmark: BookmarkRecord }).bookmark);
    else if (record.kind === "reminder") view.reminders.push((doc as { reminder: ReminderRecord }).reminder);
    else if (record.kind === "memory") view.memory.push((doc as { memory: MemoryRecord }).memory);
    else if (record.kind === "space") view.spaces.push(doc as SpaceDoc);
  }
  view.bookmarks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  view.artifacts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  view.notes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  view.reminders.sort((a, b) => (a.nextFireAt ?? "￿").localeCompare(b.nextFireAt ?? "￿"));
  // `isLatest` is derived, never trusted from the wire: recompute the winner of
  // each `rootId` chain (highest version) so a correction and the fact it
  // corrects converge whichever order they arrived in.
  const latest = new Map<string, MemoryRecord>();
  for (const entry of view.memory) {
    const held = latest.get(entry.rootId);
    if (held === undefined || entry.version > held.version) latest.set(entry.rootId, entry);
  }
  view.memory = [...latest.values()]
    .filter((entry) => !entry.isForgotten)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return view;
}

export interface WorkspaceFeed {
  close(): void;
}

/**
 * Hold a hub socket open and hand back the account's records whenever they
 * change. The transport is the same one the Mac and the cloud browser use.
 */
export function subscribeWorkspace(options: {
  hubUrl: string;
  deviceId: string;
  /** The device token as it stands: this socket outlives the one it was opened with. */
  getToken: () => Promise<string | null>;
  spaceIds: string[];
  workspaceKeys: SpaceKeys;
  onView: (view: WorkspaceView) => void;
  onState?: (state: "connecting" | "connected" | "offline" | "off") => void;
}): WorkspaceFeed {
  let wires: WorkspaceRecordWire[] = [];
  let closed = false;
  // Memoized as a PROMISE, not as its result: `??=` on the result reassigns
  // only after the await, so every render started before the first one
  // resolves would fetch the device registry again. A FAILURE is not kept:
  // one bad `/devices` read would otherwise reject every document for the
  // life of the feed.
  let verifier: Promise<Verifier> | null = null;
  const verify = (): Promise<Verifier> => {
    if (verifier !== null) return verifier;
    const attempt = deviceVerifier(options.getToken).catch((cause: unknown) => {
      if (verifier === attempt) verifier = null;
      throw cause;
    });
    verifier = attempt;
    return attempt;
  };

  // Hydration arrives as many frames — a library of artifacts is dozens —
  // and each one would otherwise re-verify and re-decrypt every doc received
  // so far. Buffer until `workspace.hydrate.done` and render once. Live
  // fan-out after that is a doc or two at a time and renders immediately.
  let hydrating = true;
  let rendering = false;
  let restart = false;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const render = async (): Promise<void> => {
    if (rendering) {
      // A doc landed mid-render; fold it into the next pass rather than
      // starting a second one that could resolve out of order and show a
      // view built from fewer records than the one it replaces.
      restart = true;
      return;
    }
    rendering = true;
    try {
      do {
        restart = false;
        // Compact first: reconnects re-hydrate, so `wires` would otherwise
        // grow by the whole workspace on every dial.
        wires = [...newestPerKey(wires).values()];
        let checked: Verifier;
        try {
          checked = await verify();
        } catch {
          // The device registry could not be read. The view stands as it is
          // and this comes round again — a transient `/devices` failure is
          // not a reason to show the reader an empty workspace until they
          // reload.
          if (retry === null && !closed) {
            retry = setTimeout(() => {
              retry = null;
              void render();
            }, VERIFIER_RETRY_MS);
          }
          return;
        }
        const view = await readWorkspace(wires, options.workspaceKeys, checked);
        options.onView(view);
      } while (restart);
    } finally {
      rendering = false;
    }
  };

  // A web device presents on the hub as an ordinary device; only the cloud
  // browser takes exclusive leases, and this one never writes at all.
  const transport = new WsTransport(options.hubUrl, options.deviceId, "desktop", {
    getToken: options.getToken,
    authRequired: () => true,
    onStateChanged: (state) => {
      // A redial re-hydrates from scratch: buffer that burst too. Going
      // offline mid-hydration renders what did arrive rather than leaving
      // the page on an empty view until the socket comes back.
      if (state === "connecting") {
        hydrating = true;
        // Read the registry again on the way back: a device enrolled while
        // this feed was open signs documents this one has never heard of.
        verifier = null;
      }
      if (state !== "connected" && hydrating && wires.length > 0) {
        hydrating = false;
        void render();
      }
      options.onState?.(state);
    },
    onWorkspaceRecords: (docs) => {
      wires.push(...docs);
      if (!hydrating) void render();
    },
    onWorkspaceHydrated: () => {
      hydrating = false;
      void render();
    },
  });
  transport.start(options.spaceIds);

  return {
    close: () => {
      closed = true;
      if (retry !== null) clearTimeout(retry);
      retry = null;
      transport.stop();
    },
  };
}
