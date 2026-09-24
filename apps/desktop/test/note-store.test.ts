/**
 * The notes library on this Mac (docs/notes.md §3): metadata in `notes.json`,
 * bodies in `notes/<id>.md`, pictures in `note-blobs/<id>`; the caps refused
 * out loud rather than obeyed quietly; a deletion that collects the pictures
 * nobody else names; and the two subscriptions kept apart — the renderer hears
 * every change, the sync lane only local ones.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NoteStore, type NoteRecordKind } from "../src/main/note-store";
import {
  MAX_NOTE_BLOB_BYTES,
  MAX_NOTE_BLOBS_PER_NOTE,
  MAX_NOTE_MARKDOWN_BYTES,
  MAX_NOTES,
  type Note,
  type NoteSnapshot,
  type NoteSource,
} from "@pistachio/shell-contracts/notes";

const USER: NoteSource = { kind: "user", runId: null };
const AGENT: NoteSource = { kind: "agent", runId: "run-1" };

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "pistachio-notes-"));
  dirs.push(dir);
  return dir;
}

/** A clock the test moves by hand, so `updatedAt` ordering is deterministic. */
function clock(start = "2026-09-20T09:00:00.000Z") {
  let at = new Date(start);
  return {
    now: () => at,
    advance(ms: number) {
      at = new Date(at.getTime() + ms);
    },
  };
}

function open(directory = scratch(), time = clock()) {
  return { store: new NoteStore(directory, { now: time.now }), directory, time };
}

function png(marker: number): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, marker, 1, 2, 3]);
}

function blobIdOf(bytes: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex").slice(0, 24);
}

function remoteNote(overrides: Partial<Note> = {}): Note {
  return {
    id: "aaaabbbbcccc",
    title: "From the other Mac",
    markdown: "# Pie\n\nSour cherries.",
    icon: null,
    blobIds: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    revision: 3,
    source: { kind: "user", runId: null },
    ...overrides,
  };
}

describe("NoteStore", () => {
  it("keeps the metadata and the body apart, and reads both back after a restart", () => {
    const { store, directory } = open();
    const body = `Sour cherries, a lattice top.\n\n${"Butter, flour, patience. ".repeat(40)}\n\nThe secret is the lard.`;
    const note = store.create({ title: "Sunday pie", markdown: body }, USER);
    expect(note.id).toMatch(/^[a-f0-9]{12}$/);
    expect(note).toMatchObject({ title: "Sunday pie", revision: 1, icon: null, blobIds: [], source: USER });
    expect(note.createdAt).toBe(note.updatedAt);
    expect(readFileSync(join(directory, "notes", `${note.id}.md`), "utf8")).toBe(body);
    const index = JSON.parse(readFileSync(join(directory, "notes.json"), "utf8")) as { version: number; notes: unknown[] };
    expect(index.version).toBe(1);
    // The library holds a snippet, never a body: five hundred notes are not a
    // keystroke's work, and the last line of this one never reaches the index.
    expect(JSON.stringify(index)).not.toContain("the lard");

    const reopened = new NoteStore(directory);
    expect(reopened.get(note.id)).toEqual(note);
    expect(reopened.list()).toEqual([{ ...noteSummary(note), snippet: expect.stringContaining("Sour cherries, a lattice top.") }]);
    expect(reopened.get("aaaabbbbcccc")).toBeNull();
  });

  it("bumps the revision, stamps the time, keeps what the patch leaves out, and recomputes the pictures", () => {
    const { store, time } = open();
    const created = store.create({ title: "Trip", markdown: "Ferry at nine." }, USER);
    const id = blobIdOf(png(1));
    time.advance(60_000);
    const updated = store.update(created.id, { markdown: `Ferry at nine.\n\n![deck](note-blob:${id})` }, AGENT);
    expect(updated).toMatchObject({ title: "Trip", revision: 2, blobIds: [id], source: AGENT });
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt).not.toBe(created.updatedAt);

    time.advance(60_000);
    const renamed = store.update(created.id, { title: "Island trip", icon: "🛳️" }, USER);
    expect(renamed).toMatchObject({ title: "Island trip", icon: "🛳️", revision: 3, blobIds: [id] });
    expect(renamed.markdown).toContain("Ferry at nine.");
    expect(() => store.update("aaaabbbbcccc", { title: "nope" }, USER)).toThrow(/no note/);
  });

  it("lists the most recently edited first and searches title before body", () => {
    const { store, time } = open();
    const pie = store.create({ title: "Sunday pie", markdown: "Sour cherries." }, USER);
    time.advance(1_000);
    const ferry = store.create({ title: "Island trip", markdown: "The pie shop by the ferry." }, USER);
    expect(store.list().map((note) => note.id)).toEqual([ferry.id, pie.id]);
    time.advance(1_000);
    store.update(pie.id, { markdown: "Sour cherries, a lattice top." }, USER);
    expect(store.list().map((note) => note.id)).toEqual([pie.id, ferry.id]);

    expect(store.search("pie").map((note) => note.id)).toEqual([pie.id, ferry.id]);
    expect(store.search("cherries").map((note) => note.id)).toEqual([pie.id]);
    expect(store.search("pie", 1).map((note) => note.id)).toEqual([pie.id]);
    expect(store.search("aubergine")).toEqual([]);
    // An empty query is the library in its own order.
    expect(store.search("").map((note) => note.id)).toEqual([pie.id, ferry.id]);
    expect(store.list()[0]?.snippet).toBe("Sour cherries, a lattice top.");
  });

  it("refuses a body over the cap rather than quietly cutting it, on create and on update", () => {
    const { store } = open();
    const tooLong = "x".repeat(MAX_NOTE_MARKDOWN_BYTES + 1);
    expect(() => store.create({ markdown: tooLong }, USER)).toThrow(/at most/);
    const note = store.create({ markdown: "short" }, USER);
    expect(() => store.update(note.id, { markdown: tooLong }, USER)).toThrow(/at most/);
    expect(store.get(note.id)?.markdown).toBe("short");
    expect(store.get(note.id)?.revision).toBe(1);
  });

  it("holds the library at its cap and refuses a note that names more pictures than one may", () => {
    const { store } = open();
    for (let index = 0; index < MAX_NOTES; index += 1) store.create({ title: `Note ${String(index)}` }, USER);
    expect(() => store.create({ title: "one more" }, USER)).toThrow(/Delete one/);
    const many = Array.from({ length: MAX_NOTE_BLOBS_PER_NOTE + 1 }, (_, index) =>
      `![](note-blob:${String(index).padStart(24, "0")})`,
    ).join("\n");
    expect(() => store.update(store.list()[0]!.id, { markdown: many }, USER)).toThrow(/at most 40 images/);
  });

  it("leaves a note exactly as it was when an update is refused", () => {
    const { store, directory } = open();
    const note = store.create({ title: "Pie", markdown: "Sour cherries.\n" }, USER);
    const many = Array.from({ length: MAX_NOTE_BLOBS_PER_NOTE + 1 }, (_, index) =>
      `![](note-blob:${String(index).padStart(24, "0")})`,
    ).join("\n");
    const changes: string[] = [];
    store.onRecordChange((_kind, id) => changes.push(id));
    expect(() => store.update(note.id, { title: "Pies", markdown: many }, USER)).toThrow(/at most 40 images/);
    // Neither the body on disk nor the index moved, and the sync lane heard nothing.
    expect(readFileSync(join(directory, "notes", `${note.id}.md`), "utf8")).toBe("Sour cherries.\n");
    expect(store.get(note.id)).toEqual(note);
    expect(changes).toEqual([]);
  });
});

describe("pictures", () => {
  it("hashes, dedupes and hands the bytes back", () => {
    const { store, directory } = open();
    const bytes = png(1);
    const blob = store.putBlob(bytes, "image/png");
    expect(blob.id).toBe(blobIdOf(bytes));
    expect(blob).toMatchObject({ mediaType: "image/png", byteLength: bytes.byteLength });
    expect(Buffer.from(blob.data, "base64")).toEqual(Buffer.from(bytes));
    expect(readFileSync(join(directory, "note-blobs", blob.id))).toEqual(Buffer.from(bytes));

    // The same picture dropped twice is one register.
    const again = store.putBlob(new Uint8Array(bytes), "image/png");
    expect(again.id).toBe(blob.id);
    expect(store.syncAll("noteBlob")).toHaveLength(1);
    expect(store.getBlob(blob.id)).toEqual(blob);
    expect(store.getBlob(blobIdOf(png(2)))).toBeNull();
  });

  it("refuses an image over the cap", () => {
    const { store } = open();
    expect(() => store.putBlob(new Uint8Array(MAX_NOTE_BLOB_BYTES + 1), "image/jpeg")).toThrow(/up to/);
    expect(() => store.putBlob(new Uint8Array(0), "image/png")).toThrow(/bytes/);
  });

  it("collects a picture nobody references any more, and keeps one that is still named", () => {
    const { store, directory } = open();
    const shared = store.putBlob(png(1), "image/png");
    const lonely = store.putBlob(png(2), "image/png");
    const kept = store.create({ title: "Keeps", markdown: `![](note-blob:${shared.id})` }, USER);
    const doomed = store.create({ title: "Goes", markdown: `![](note-blob:${shared.id})\n![](note-blob:${lonely.id})` }, USER);

    const records: Array<[NoteRecordKind, string]> = [];
    store.onRecordChange((kind, id) => records.push([kind, id]));
    expect(store.remove(doomed.id)).toBe(true);
    expect(store.remove(doomed.id)).toBe(false);

    // The note, and only the picture the survivor does not name.
    expect(records).toEqual([["note", doomed.id], ["noteBlob", lonely.id]]);
    expect(store.getBlob(lonely.id)).toBeNull();
    expect(existsSync(join(directory, "note-blobs", lonely.id))).toBe(false);
    expect(store.getBlob(shared.id)).not.toBeNull();
    expect(existsSync(join(directory, "notes", `${doomed.id}.md`))).toBe(false);
    expect(store.get(kept.id)).not.toBeNull();
  });
});

describe("collecting the pictures an edit orphaned", () => {
  it("keeps a young orphan, sweeps an old one, and never takes one a note still names", () => {
    const { store, time, directory } = open();
    const kept = store.putBlob(png(1), "image/png");
    const stale = store.putBlob(png(2), "image/png");
    const note = store.create({ markdown: `![](note-blob:${kept.id})\n![](note-blob:${stale.id})` }, USER);

    // The edit that removed the second picture; nothing is collected yet.
    store.update(note.id, { markdown: `![](note-blob:${kept.id})` }, USER);
    expect(store.sweepOrphanBlobs()).toEqual([]);
    expect(store.getBlob(stale.id)).not.toBeNull();

    // A fresh orphan is still within reach of ⌘Z.
    const young = store.putBlob(png(3), "image/png");
    time.advance(25 * 60 * 60 * 1_000);
    const later = store.putBlob(png(4), "image/png");

    const records: Array<[NoteRecordKind, string]> = [];
    store.onRecordChange((kind, id) => records.push([kind, id]));
    const swept = store.sweepOrphanBlobs();

    expect(swept.sort()).toEqual([stale.id, young.id].sort());
    expect(records.sort()).toEqual([["noteBlob", stale.id], ["noteBlob", young.id]].sort());
    expect(store.getBlob(stale.id)).toBeNull();
    expect(existsSync(join(directory, "note-blobs", stale.id))).toBe(false);
    expect(store.getBlob(later.id)).not.toBeNull();
    // The one the note still names is never a candidate, however old it is.
    expect(store.getBlob(kept.id)).not.toBeNull();
    expect(store.get(note.id)?.blobIds).toEqual([kept.id]);

    // The window is the caller's to set, and a second sweep has nothing to do.
    expect(store.sweepOrphanBlobs({ olderThanMs: 0 })).toEqual([later.id]);
    expect(store.sweepOrphanBlobs({ olderThanMs: 0 })).toEqual([]);
    expect(new NoteStore(directory).syncAll("noteBlob").map((blob) => blob.id)).toEqual([kept.id]);
  });
});

describe("the two subscriptions", () => {
  it("tells the renderer metadata only, and the sync lane what a local write touched", () => {
    const { store } = open();
    const snapshots: NoteSnapshot[] = [];
    const records: Array<[NoteRecordKind, string]> = [];
    store.onChange((snapshot) => snapshots.push(snapshot));
    store.onRecordChange((kind, id) => records.push([kind, id]));

    const note = store.create({ title: "Sunday pie", markdown: "Sour cherries." }, USER);
    store.update(note.id, { markdown: "Sour cherries, a lattice top." }, USER);
    const blob = store.putBlob(png(3), "image/png");

    expect(records).toEqual([["note", note.id], ["note", note.id], ["noteBlob", blob.id]]);
    expect(snapshots).toHaveLength(3);
    expect(JSON.stringify(snapshots)).not.toContain("lattice top.\n");
    expect(snapshots.at(-1)?.notes.map((entry) => entry.title)).toEqual(["Sunday pie"]);
    // Metadata only: a summary has a snippet where a note has its markdown.
    expect(snapshots.at(-1)?.notes[0]).not.toHaveProperty("markdown");
    expect(snapshots.at(-1)?.notes[0]?.snippet).toBe("Sour cherries, a lattice top.");
  });
});

describe("records from another device", () => {
  it("applies a note and its picture, never echoing either back to the sync lane", () => {
    const { store } = open();
    const bytes = png(4);
    const blobId = blobIdOf(bytes);
    const snapshots: NoteSnapshot[] = [];
    const records: Array<[NoteRecordKind, string]> = [];
    store.onChange((snapshot) => snapshots.push(snapshot));
    store.onRecordChange((kind, id) => records.push([kind, id]));

    // The note may arrive before the picture it names; each is its own register.
    const note = remoteNote({ markdown: `# Pie\n\n![](note-blob:${blobId})` });
    expect(store.applyRemote("note", note)).toMatchObject({ id: note.id, blobIds: [blobId] });
    expect(store.get(note.id)).toMatchObject({ title: "From the other Mac", revision: 3, blobIds: [blobId] });
    expect(store.getBlob(blobId)).toBeNull();

    expect(
      store.applyRemote("noteBlob", {
        id: blobId,
        mediaType: "image/png",
        byteLength: bytes.byteLength,
        data: Buffer.from(bytes).toString("base64"),
        createdAt: "2026-09-01T00:00:00.000Z",
      }),
    ).toMatchObject({ id: blobId });
    expect(store.getBlob(blobId)?.data).toBe(Buffer.from(bytes).toString("base64"));

    expect(records).toEqual([]);
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots.at(-1)?.notes.map((entry) => entry.title)).toEqual(["From the other Mac"]);
  });

  it("short-circuits a value it already holds, and refuses one it cannot read", () => {
    const { store } = open();
    const note = remoteNote();
    store.applyRemote("note", note);
    const snapshots: NoteSnapshot[] = [];
    store.onChange((snapshot) => snapshots.push(snapshot));
    expect(store.applyRemote("note", note)).toEqual(store.get(note.id));
    expect(snapshots).toEqual([]);

    expect(store.applyRemote("note", { id: "nope", title: "x" })).toBeNull();
    expect(store.applyRemote("noteBlob", { id: "aa", mediaType: "image/png" })).toBeNull();
    // Content addressing is the guarantee: bytes whose hash is not their key are not kept.
    expect(
      store.applyRemote("noteBlob", {
        id: "0".repeat(24),
        mediaType: "image/png",
        byteLength: 3,
        data: Buffer.from([1, 2, 3]).toString("base64"),
        createdAt: "2026-09-01T00:00:00.000Z",
      }),
    ).toBeNull();
    expect(store.list()).toHaveLength(1);
  });

  it("removes what another device deleted, and says when there was nothing to remove", () => {
    const { store } = open();
    const note = remoteNote();
    store.applyRemote("note", note);
    const blob = store.putBlob(png(5), "image/png");
    const records: Array<[NoteRecordKind, string]> = [];
    store.onRecordChange((kind, id) => records.push([kind, id]));

    expect(store.removeRemote("note", note.id)).toBe(true);
    expect(store.removeRemote("note", note.id)).toBe(false);
    expect(store.removeRemote("noteBlob", blob.id)).toBe(true);
    expect(store.get(note.id)).toBeNull();
    expect(store.getBlob(blob.id)).toBeNull();
    // A remote deletion is not this Mac's to publish.
    expect(records).toEqual([]);
  });

  it("hands the sync lane whole records, and skips a note whose body went missing", () => {
    const { store, directory } = open();
    const blob = store.putBlob(png(6), "image/png");
    const note = store.create({ title: "Sunday pie", markdown: `Cherries ![](note-blob:${blob.id})` }, USER);
    expect(store.syncAll("note")).toEqual([store.get(note.id)]);
    expect(store.syncGet("note", note.id)).toEqual(store.get(note.id));
    expect(store.syncAll("noteBlob")).toEqual([store.getBlob(blob.id)]);
    expect(store.syncGet("noteBlob", blob.id)).toEqual(store.getBlob(blob.id));
    expect(store.syncGet("note", "aaaabbbbcccc")).toBeNull();

    rmSync(join(directory, "notes", `${note.id}.md`));
    // An empty document must never be published over the good copy a peer holds.
    expect(store.syncAll("note")).toEqual([]);
    expect(store.syncGet("note", note.id)).toBeNull();
  });
});

function noteSummary(note: Note) {
  const { markdown: _markdown, ...rest } = note;
  return rest;
}
