import { describe, expect, it } from "vitest";
import {
  seal,
  toBase64,
  utf8,
  workspaceSealAad,
  type Hlc,
  type SpaceKeys,
  type WorkspaceRecordWire,
} from "@pistachio/sync-protocol";
import { readWorkspace } from "../src/records";

/**
 * What a web device makes of the sealed documents the hub hands it.
 *
 * Two rules matter and neither is the hub's to decide: newest-per-key wins
 * (LWW by hybrid clock, the same rule every device applies), and a document
 * that does not verify against an enrolled device is COUNTED rather than
 * shown — a hub that re-served old ciphertext under a fabricated clock must
 * not be able to roll a reader's view back.
 */

async function spaceKeys(): Promise<SpaceKeys> {
  const sealKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const idKey = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return { spaceId: "space-1", sealKey, idKey };
}

const hlc = (physicalMs: number, logical = 0, deviceId = "device-a"): Hlc => ({ physicalMs, logical, deviceId });

async function wire(
  keys: SpaceKeys,
  key: string,
  value: unknown | null,
  clock: Hlc,
): Promise<WorkspaceRecordWire> {
  const sealedValue =
    value === null ? null : toBase64(await seal(keys.sealKey, utf8(JSON.stringify(value)), workspaceSealAad(key)));
  return { key, sealedValue, hlc: clock, deviceSig: "signature-is-checked-by-the-verifier" };
}

const bookmark = (id: string, createdAt: string): unknown => ({
  kind: "bookmark",
  bookmark: { id, title: id, url: `https://example.com/${id}`, createdAt },
});

const everything = (): Promise<boolean> => Promise.resolve(true);
const nothing = (): Promise<boolean> => Promise.resolve(false);

describe("readWorkspace", () => {
  it("keeps the newest write per key and never the one it replaced", async () => {
    const keys = await spaceKeys();
    const view = await readWorkspace(
      [
        await wire(keys, "bookmark:1", bookmark("old", "2026-01-01T00:00:00.000Z"), hlc(1_000)),
        await wire(keys, "bookmark:1", bookmark("new", "2026-01-02T00:00:00.000Z"), hlc(2_000)),
      ],
      keys,
      everything,
    );
    expect(view.bookmarks.map((entry) => entry.id)).toEqual(["new"]);
    expect(view.rejected).toBe(0);
  });

  it("breaks a same-millisecond tie on the logical counter", async () => {
    const keys = await spaceKeys();
    const view = await readWorkspace(
      [
        await wire(keys, "bookmark:1", bookmark("second", "2026-01-02T00:00:00.000Z"), hlc(1_000, 2)),
        await wire(keys, "bookmark:1", bookmark("first", "2026-01-01T00:00:00.000Z"), hlc(1_000, 1)),
      ],
      keys,
      everything,
    );
    expect(view.bookmarks.map((entry) => entry.id)).toEqual(["second"]);
  });

  it("does not depend on the order the hub sent them in", async () => {
    const keys = await spaceKeys();
    const wires = [
      await wire(keys, "bookmark:1", bookmark("a", "2026-01-01T00:00:00.000Z"), hlc(3_000)),
      await wire(keys, "bookmark:1", bookmark("b", "2026-01-02T00:00:00.000Z"), hlc(1_000)),
      await wire(keys, "bookmark:1", bookmark("c", "2026-01-03T00:00:00.000Z"), hlc(2_000)),
    ];
    const forwards = await readWorkspace(wires, keys, everything);
    const backwards = await readWorkspace([...wires].reverse(), keys, everything);
    expect(forwards.bookmarks.map((entry) => entry.id)).toEqual(["a"]);
    expect(backwards.bookmarks).toEqual(forwards.bookmarks);
  });

  it("lets a newer tombstone delete a record, and an older one not resurrect it", async () => {
    const keys = await spaceKeys();
    const live = await wire(keys, "bookmark:1", bookmark("live", "2026-01-01T00:00:00.000Z"), hlc(1_000));
    const gone = await wire(keys, "bookmark:1", null, hlc(2_000));
    expect((await readWorkspace([live, gone], keys, everything)).bookmarks).toEqual([]);
    // The same two documents with the clocks the other way round: the delete
    // is the older write and the record stands.
    const staleDelete = await wire(keys, "bookmark:1", null, hlc(500));
    expect((await readWorkspace([live, staleDelete], keys, everything)).bookmarks).toHaveLength(1);
  });

  it("counts what does not verify instead of showing it", async () => {
    const keys = await spaceKeys();
    const view = await readWorkspace(
      [await wire(keys, "bookmark:1", bookmark("forged", "2026-01-01T00:00:00.000Z"), hlc(1_000))],
      keys,
      nothing,
    );
    expect(view.bookmarks).toEqual([]);
    expect(view.rejected).toBe(1);
  });

  it("counts what this browser holds no key for, and keeps reading the rest", async () => {
    const keys = await spaceKeys();
    const other = await spaceKeys();
    const view = await readWorkspace(
      [
        await wire(other, "bookmark:1", bookmark("sealed-elsewhere", "2026-01-01T00:00:00.000Z"), hlc(1_000)),
        await wire(keys, "bookmark:2", bookmark("readable", "2026-01-02T00:00:00.000Z"), hlc(1_000)),
      ],
      keys,
      everything,
    );
    expect(view.bookmarks.map((entry) => entry.id)).toEqual(["readable"]);
    expect(view.rejected).toBe(1);
  });

  it("sorts bookmarks newest first, whatever order they arrived in", async () => {
    const keys = await spaceKeys();
    const view = await readWorkspace(
      [
        await wire(keys, "bookmark:1", bookmark("older", "2026-01-01T00:00:00.000Z"), hlc(1_000)),
        await wire(keys, "bookmark:2", bookmark("newer", "2026-03-01T00:00:00.000Z"), hlc(1_000)),
      ],
      keys,
      everything,
    );
    expect(view.bookmarks.map((entry) => entry.id)).toEqual(["newer", "older"]);
  });

  it("derives which memory is current rather than trusting the wire", async () => {
    const keys = await spaceKeys();
    const memory = (id: string, version: number, isForgotten = false): unknown => ({
      kind: "memory",
      memory: {
        id,
        rootId: "root-1",
        version,
        isLatest: false,
        isForgotten,
        content: id,
        createdAt: `2026-01-0${String(version)}T00:00:00.000Z`,
      },
    });
    const view = await readWorkspace(
      [
        await wire(keys, "memory:1", memory("first", 1), hlc(1_000)),
        await wire(keys, "memory:2", memory("correction", 2), hlc(1_000)),
      ],
      keys,
      everything,
    );
    expect(view.memory.map((entry) => entry.content)).toEqual(["correction"]);

    // A forgotten head hides the whole chain, not just its own version.
    const forgotten = await readWorkspace(
      [
        await wire(keys, "memory:1", memory("first", 1), hlc(1_000)),
        await wire(keys, "memory:2", memory("forgotten", 2, true), hlc(1_000)),
      ],
      keys,
      everything,
    );
    expect(forgotten.memory).toEqual([]);
  });
  it("opens notes and their pictures, and counts a note whose shape is wrong", async () => {
    const keys = await spaceKeys();
    const note = (id: string, updatedAt: string, extra: Record<string, unknown> = {}): unknown => ({
      kind: "note",
      note: {
        id,
        title: "Groceries",
        markdown: "- olives\n",
        icon: null,
        blobIds: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt,
        revision: 1,
        source: { kind: "user", runId: null },
        ...extra,
      },
    });
    const blob = (id: string): unknown => ({
      kind: "noteBlob",
      blob: {
        id,
        mediaType: "image/png",
        byteLength: 3,
        data: "AAAA",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const view = await readWorkspace(
      [
        await wire(keys, "note:aaaaaaaaaaaa", note("aaaaaaaaaaaa", "2026-01-01T00:00:00.000Z"), hlc(1_000)),
        await wire(keys, "note:bbbbbbbbbbbb", note("bbbbbbbbbbbb", "2026-02-01T00:00:00.000Z"), hlc(1_000)),
        // A note id that is not twelve hex characters is not a note.
        await wire(keys, "note:cccc", note("cccc", "2026-03-01T00:00:00.000Z"), hlc(1_000)),
        await wire(keys, "note-blob:" + "d".repeat(24), blob("d".repeat(24)), hlc(1_000)),
        // A picture of an unknown type is not opened either.
        await wire(keys, "note-blob:" + "e".repeat(24), { kind: "noteBlob", blob: { id: "e".repeat(24), mediaType: "image/svg+xml", byteLength: 3, data: "AAAA", createdAt: "2026-01-01T00:00:00.000Z" } }, hlc(1_000)),
      ],
      keys,
      everything,
    );
    // Newest edit first.
    expect(view.notes.map((entry) => entry.id)).toEqual(["bbbbbbbbbbbb", "aaaaaaaaaaaa"]);
    expect([...view.noteBlobs.keys()]).toEqual(["d".repeat(24)]);
    expect(view.rejected).toBe(2);
  });
});
