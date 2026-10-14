/**
 * A tab group's context on disk and in sync (docs/desk-agent.md §3): files
 * content-addressed beside one index, owner-only; what the agent reads of
 * an item; and the two registers another Mac sees — the context (whole, by
 * group) and each file small enough to travel, verified by its hash.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_GROUP_BLOB_BYTES, MAX_GROUP_FILE_BYTES } from "@pistachio/shell-contracts/desk-agent";
import { GroupContextStore } from "../src/main/group-context-store";

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "pistachio-group-context-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PDF = Buffer.from("%PDF-1.7 boarding pass BA 0490 seat 14C");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function blobId(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 24);
}

describe("a group's context", () => {
  it("keeps files by their contents, owner-only, and knows them again after a restart", () => {
    const dir = scratch();
    const store = new GroupContextStore(dir);
    const { added, rejected } = store.addFiles(
      "g1",
      "Lisbon",
      [
        { name: "boarding-pass.pdf", mediaType: "application/pdf", bytes: PDF },
        { name: "itinerary.md", mediaType: "", bytes: Buffer.from("# Day one\nTram 28") },
        { name: "boarding-pass copy.pdf", mediaType: "application/pdf", bytes: PDF },
        { name: "song.mp3", mediaType: "audio/mpeg", bytes: Buffer.from("ID3") },
      ],
      "person",
    );
    expect(added.map((item) => [item.name, item.mediaType])).toEqual([
      ["boarding-pass.pdf", "application/pdf"],
      ["itinerary.md", "text/markdown"],
    ]);
    expect(rejected).toEqual([{ name: "song.mp3", reason: "Pistachio can open pictures, PDFs, text, Word and Excel files" }]);
    expect(statSync(join(dir, "group-context.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "group-blobs", blobId(PDF))).mode & 0o777).toBe(0o600);

    const reopened = new GroupContextStore(dir);
    expect(reopened.list()).toEqual([
      expect.objectContaining({ groupId: "g1", title: "Lisbon", items: [expect.objectContaining({ name: "boarding-pass.pdf", here: true }), expect.objectContaining({ name: "itinerary.md", here: true })] }),
    ]);
  });

  it("refuses a file past the limit, and a context past its count", () => {
    const store = new GroupContextStore(scratch());
    const huge = { name: "scan.pdf", mediaType: "application/pdf", bytes: Buffer.alloc(MAX_GROUP_FILE_BYTES + 1) };
    expect(store.addFiles("g1", "Lisbon", [huge], "person").rejected).toEqual([{ name: "scan.pdf", reason: "larger than 20 MB" }]);
    for (let index = 0; index < 60; index += 1) store.addText("g1", "Lisbon", { kind: "fact", text: `fact ${String(index)}` }, "person");
    expect(() => store.addText("g1", "Lisbon", { kind: "fact", text: "one too many" }, "person")).toThrow(/already holds 60/);
  });

  it("reads a fact, a text file as text, and an image or PDF as a file the model looks at", async () => {
    const store = new GroupContextStore(scratch());
    const fact = store.addText("g1", "Lisbon", { kind: "snippet", text: "Check-in from 15:00", url: "https://hotel.example/", title: "Hotel Avenida" }, "agent");
    const [pdf, notes, picture] = store.addFiles(
      "g1",
      "Lisbon",
      [
        { name: "pass.pdf", mediaType: "application/pdf", bytes: PDF },
        { name: "notes.txt", mediaType: "text/plain", bytes: Buffer.from("Gate closes 09:10") },
        { name: "map.png", mediaType: "image/png", bytes: PNG },
      ],
      "person",
    ).added;
    await expect(store.read("g1", fact.id)).resolves.toMatchObject({ text: "Check-in from 15:00\n(from “Hotel Avenida” https://hotel.example/)" });
    await expect(store.read("g1", notes!.id)).resolves.toMatchObject({ text: "Gate closes 09:10" });
    await expect(store.read("g1", pdf!.id)).resolves.toMatchObject({ file: { mediaType: "application/pdf", name: "pass.pdf", dataUrl: `data:application/pdf;base64,${PDF.toString("base64")}` } });
    await expect(store.read("g1", picture!.id)).resolves.toMatchObject({ file: { mediaType: "image/png" } });
    await expect(store.read("g1", "000000000000")).rejects.toThrow(/no item/);
    await expect(store.read("g2", fact.id)).rejects.toThrow(/no item/);
  });

  it("copies another group's context in, as new items", () => {
    const store = new GroupContextStore(scratch());
    store.addText("mac-b-group", "Lisbon (MacBook)", { kind: "fact", text: "Seat 14C" }, "person");
    store.addFiles("mac-b-group", "Lisbon (MacBook)", [{ name: "pass.pdf", mediaType: "application/pdf", bytes: PDF }], "person");
    expect(store.adopt("g1", "Lisbon", "mac-b-group")).toBe(2);
    const here = store.items("g1");
    const there = store.items("mac-b-group");
    expect(here.map((item) => item.kind)).toEqual(["fact", "file"]);
    expect(here.map((item) => item.id)).not.toEqual(there.map((item) => item.id));
    // Brought in again, the same file is not taken twice.
    expect(store.adopt("g1", "Lisbon", "mac-b-group")).toBe(1);
  });

  it("moves a merged space's context into another's whole, keeping the items' ids, and tells sync both (2026-10-14)", async () => {
    const store = new GroupContextStore(scratch());
    store.addText("trip", "Trip", { kind: "fact", text: "Hotel QX7F2L" }, "person");
    const [pass] = store.addFiles("trip", "Trip", [{ name: "pass.pdf", mediaType: "application/pdf", bytes: PDF }], "person").added;
    store.addFiles("lisbon", "Lisbon", [{ name: "same pass.pdf", mediaType: "application/pdf", bytes: PDF }], "person");
    const fact = store.items("trip")[0]!;
    const touched: string[] = [];
    store.onRecordChange((kind, id) => touched.push(`${kind}:${id}`));

    // The file Lisbon holds already is not taken twice; the fact comes over under its own id (a desk's file window names it).
    expect(store.moveAll("trip", "lisbon", "Lisbon")).toBe(1);
    expect(store.items("lisbon").map((item) => item.id)).toEqual([expect.any(String), fact.id]);
    expect(store.items("lisbon").filter((item) => item.kind === "file")).toHaveLength(1);
    // Nothing stays behind under an id no space has; the entry stays, empty, as a removed item leaves it.
    expect(store.items("trip")).toEqual([]);
    expect(store.get("trip")).not.toBeNull();
    expect(store.hasItems("trip")).toBe(false);
    expect(touched).toEqual(["groupContext:trip", "groupContext:lisbon"]);
    // The pass's bytes are still named — by Lisbon's copy — and still there.
    expect(pass).toBeDefined();
    await expect(store.fileContent("lisbon", store.items("lisbon")[0]!.id)).resolves.not.toBeNull();
    // Nothing to move is no change.
    expect(store.moveAll("trip", "lisbon", "Lisbon")).toBe(0);
    expect(store.moveAll("nowhere", "lisbon", "Lisbon")).toBe(0);
    expect(touched).toHaveLength(2);
  });

  it("lands a document's edit made under the space merged away on the file it has become, and reads it there", async () => {
    const store = new GroupContextStore(scratch());
    const [notes] = store.addFiles("trip", "Trip", [{ name: "notes.md", mediaType: "text/markdown", bytes: Buffer.from("# Trip\n") }], "person").added;
    // Lisbon has a Context of its own: the file joins it.
    store.addText("lisbon", "Lisbon", { kind: "fact", text: "Tram 28" }, "person");
    expect(store.moveAll("trip", "lisbon", "Lisbon")).toBe(1);
    // The document's window still names Trip and its item: its autosave goes through, onto Lisbon's copy.
    const edited = Buffer.from("# Trip\n\nAlfama on Tuesday\n");
    const saved = await store.writeFile({ groupId: "trip", itemId: notes!.id, baseBlobId: notes!.blobId, bytes: new Uint8Array(edited) });
    expect(saved).toMatchObject({ ok: true });
    const moved = store.items("lisbon").find((item) => item.kind === "file")!;
    expect(Buffer.from((await store.fileContent("lisbon", moved.id))!.bytes).toString()).toBe(edited.toString());
    // Opened again under Trip's name, it is the same file.
    expect(Buffer.from((await store.fileContent("trip", notes!.id))!.bytes).toString()).toBe(edited.toString());
  });

  it("refuses a move the other context cannot take whole, moving nothing", () => {
    const store = new GroupContextStore(scratch());
    for (let index = 0; index < 40; index += 1) store.addText("a", "A", { kind: "fact", text: `a ${String(index)}` }, "person");
    for (let index = 0; index < 21; index += 1) store.addText("b", "B", { kind: "fact", text: `b ${String(index)}` }, "person");
    expect(() => store.moveAll("b", "a", "A")).toThrow(/more than 60/);
    expect(store.items("a")).toHaveLength(40);
    expect(store.items("b")).toHaveLength(21);
    store.remove("b", store.items("b")[0]!.id);
    expect(store.moveAll("b", "a", "A")).toBe(20);
    expect(store.items("a")).toHaveLength(60);
  });
});

describe("a group's context in sync", () => {
  it("publishes the context and each small file, and never a file too large to travel", () => {
    const store = new GroupContextStore(scratch());
    const changes: string[] = [];
    store.onRecordChange((kind, id) => changes.push(`${kind}:${id}`));
    const big = Buffer.alloc(MAX_GROUP_BLOB_BYTES + 10, 7);
    store.addFiles(
      "g1",
      "Lisbon",
      [
        { name: "pass.pdf", mediaType: "application/pdf", bytes: PDF },
        { name: "scan.pdf", mediaType: "application/pdf", bytes: big },
      ],
      "person",
    );
    expect(changes).toEqual([`groupBlob:${blobId(PDF)}`, "groupContext:g1"]);
    expect(store.syncAll("groupBlob").map((blob) => blob.id)).toEqual([blobId(PDF)]);
    expect(store.getBlob(blobId(big))).toBeNull();
    expect(store.syncGet("groupContext", "g1")).toMatchObject({ groupId: "g1", items: [{ name: "pass.pdf" }, { name: "scan.pdf" }] });

    // The last item naming a small file takes its register with it; a large one had none.
    changes.length = 0;
    const [pass, scan] = store.items("g1");
    store.remove("g1", scan!.id);
    store.remove("g1", pass!.id);
    expect(changes).toEqual(["groupContext:g1", `groupBlob:${blobId(PDF)}`, "groupContext:g1"]);
  });

  it("takes another Mac's context whole, keeps its files only when their bytes hash to their key, and says which are here", async () => {
    const mine = new GroupContextStore(scratch());
    const theirs = new GroupContextStore(scratch());
    theirs.addFiles("g1", "Lisbon", [{ name: "pass.pdf", mediaType: "application/pdf", bytes: PDF }], "person");
    theirs.addText("g1", "Lisbon", { kind: "fact", text: "Seat 14C" }, "agent");
    const context = theirs.syncGet("groupContext", "g1");
    const blob = theirs.syncGet("groupBlob", blobId(PDF));

    const listener = vi.fn();
    mine.onChange(listener);
    expect(mine.applyRemote("groupContext", context)).toMatchObject({ groupId: "g1" });
    expect(mine.list()[0]?.items.map((item) => item.here)).toEqual([false, true]);
    // An echo of what is already here changes nothing.
    listener.mockClear();
    mine.applyRemote("groupContext", context);
    expect(listener).not.toHaveBeenCalled();

    expect(mine.applyRemote("groupBlob", { ...blob, data: Buffer.from("tampered").toString("base64") })).toBeNull();
    expect(mine.applyRemote("groupBlob", blob)).toMatchObject({ id: blobId(PDF) });
    expect(mine.list()[0]?.items.map((item) => item.here)).toEqual([true, true]);
    await expect(mine.read("g1", mine.items("g1")[0]!.id)).resolves.toMatchObject({ file: { name: "pass.pdf" } });

    expect(mine.removeRemote("groupContext", "g1")).toBe(true);
    expect(mine.list()).toEqual([]);
  });

  it("collects files no context names once they are old enough", () => {
    let now = new Date("2026-09-30T10:00:00Z");
    const store = new GroupContextStore(scratch(), { now: () => now });
    const [pass] = store.addFiles("g1", "Lisbon", [{ name: "pass.pdf", mediaType: "application/pdf", bytes: PDF }], "person").added;
    // Another Mac dropped the item; the bytes stay a while (⌘Z, a late sync).
    store.applyRemote("groupContext", { ...store.syncGet("groupContext", "g1"), items: [], updatedAt: "2026-09-30T10:01:00.000Z" });
    expect(store.sweepOrphanBlobs()).toBe(0);
    now = new Date("2026-10-02T10:00:00Z");
    expect(store.sweepOrphanBlobs()).toBe(1);
    expect(store.getBlob(pass!.blobId)).toBeNull();
  });
});

describe("a group's documents (docs/desk-documents.md)", () => {
  const DOCX = readFileSync(join(import.meta.dirname, "../../../packages/documents/test/files/cocoa-trip.docx"));
  /** A converter that says what it was asked, for the conversions macOS makes. */
  function converter() {
    return {
      docToDocx: vi.fn(async () => DOCX),
      docxToDoc: vi.fn(async (bytes: Buffer) => Buffer.concat([Buffer.from("DOC:"), bytes.subarray(0, 8)])),
      docText: vi.fn(async () => "Lisbon trip, as text"),
      imageToPng: vi.fn(async () => PNG),
    };
  }

  it("takes Word, Excel and more pictures by their extension, and says which items a drop came to", () => {
    const store = new GroupContextStore(scratch());
    const first = store.addFiles(
      "g1",
      "Lisbon",
      [
        { name: "trip.docx", mediaType: "", bytes: DOCX },
        { name: "budget.XLSX", mediaType: "application/octet-stream", bytes: Buffer.from("PK xlsx") },
        { name: "photo.heic", mediaType: "", bytes: Buffer.from("heic") },
        { name: "old.doc", mediaType: "application/msword", bytes: Buffer.from("doc") },
      ],
      "person",
    );
    expect(first.added.map((item) => item.mediaType)).toEqual([
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "image/heic",
      "application/msword",
    ]);
    // The same bytes again: nothing new, but the drop comes to the item that has them.
    const again = store.addFiles("g1", "Lisbon", [{ name: "trip copy.docx", mediaType: "", bytes: DOCX }], "person");
    expect(again.added).toEqual([]);
    expect(again.kept.map((item) => item.id)).toEqual([first.added[0]!.id]);
  });

  it("gives a window a file's bytes, and what macOS makes of a .doc or a HEIC to show instead", async () => {
    const convert = converter();
    const store = new GroupContextStore(scratch(), { convert });
    const [doc, heic, pdf] = store.addFiles(
      "g1",
      "Lisbon",
      [
        { name: "old.doc", mediaType: "", bytes: Buffer.from("doc bytes") },
        { name: "photo.heic", mediaType: "", bytes: Buffer.from("heic bytes") },
        { name: "pass.pdf", mediaType: "", bytes: PDF },
      ],
      "person",
    ).added;
    const shownDoc = await store.fileContent("g1", doc!.id);
    expect(Buffer.from(shownDoc!.bytes).toString()).toBe("doc bytes");
    expect(shownDoc!.shown?.mediaType).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(Buffer.from(shownDoc!.shown!.bytes).equals(DOCX)).toBe(true);
    expect((await store.fileContent("g1", heic!.id))!.shown?.mediaType).toBe("image/png");
    expect((await store.fileContent("g1", pdf!.id))!.shown).toBeUndefined();
    // Converted once: opened again, the window does not wait for macOS.
    await store.fileContent("g1", doc!.id);
    expect(convert.docToDocx).toHaveBeenCalledTimes(1);
    expect(await store.fileContent("g1", "000000000000")).toBeNull();
  });

  it("saves an edit over the version it was made to, tells another Mac, and lets the old version go", async () => {
    const store = new GroupContextStore(scratch());
    const records: Array<[string, string]> = [];
    store.onRecordChange((kind, id) => records.push([kind, id]));
    const [notes] = store.addFiles("g1", "Lisbon", [{ name: "notes.md", mediaType: "text/markdown", bytes: Buffer.from("# Trip\n") }], "person").added;
    records.length = 0;
    const edited = Buffer.from("# Trip\n\nPack the adapter\n");
    const saved = await store.writeFile({ groupId: "g1", itemId: notes!.id, baseBlobId: notes!.blobId, bytes: new Uint8Array(edited) });
    expect(saved).toMatchObject({ ok: true, item: { id: notes!.id, blobId: blobId(edited), byteLength: edited.byteLength } });
    expect(saved.ok && saved.item.editedAt).toBeTruthy();
    await expect(store.read("g1", notes!.id)).resolves.toMatchObject({ text: "# Trip\n\nPack the adapter\n" });
    // The new bytes, the context, and the old bytes' register gone everywhere.
    expect(records).toEqual([
      ["groupBlob", notes!.blobId],
      ["groupBlob", blobId(edited)],
      ["groupContext", "g1"],
    ]);
    expect(store.getBlob(notes!.blobId)).toBeNull();
    // An edit made to the old version is refused — unless the person chose to keep theirs.
    const stale = await store.writeFile({ groupId: "g1", itemId: notes!.id, baseBlobId: notes!.blobId, bytes: new Uint8Array(Buffer.from("# Mine\n")) });
    expect(stale).toMatchObject({ ok: false, reason: "changed" });
    const forced = await store.writeFile({ groupId: "g1", itemId: notes!.id, baseBlobId: notes!.blobId, bytes: new Uint8Array(Buffer.from("# Mine\n")), force: true });
    expect(forced.ok).toBe(true);
    expect(await store.writeFile({ groupId: "g1", itemId: "000000000000", baseBlobId: notes!.blobId, bytes: new Uint8Array(1) })).toMatchObject({ ok: false, reason: "gone" });
  });

  it("keeps a .doc a .doc: its edits come as a .docx and are written back through macOS", async () => {
    const convert = converter();
    const store = new GroupContextStore(scratch(), { convert });
    const [doc] = store.addFiles("g1", "Lisbon", [{ name: "old.doc", mediaType: "", bytes: Buffer.from("doc bytes") }], "person").added;
    const saved = await store.writeFile({ groupId: "g1", itemId: doc!.id, baseBlobId: doc!.blobId, bytes: new Uint8Array(DOCX), as: "docx" });
    expect(convert.docxToDoc).toHaveBeenCalledTimes(1);
    expect(saved).toMatchObject({ ok: true, item: { mediaType: "application/msword" } });
    expect(store.getBlob(saved.ok ? saved.item.blobId : "")?.data).toBe(Buffer.concat([Buffer.from("DOC:"), DOCX.subarray(0, 8)]).toString("base64"));
  });

  it("lands a .doc's edit on the file it has become when its space is merged away while the edit is converted", async () => {
    const convert = converter();
    let release: (bytes: Buffer<ArrayBuffer>) => void = () => undefined;
    convert.docxToDoc.mockImplementationOnce(() => new Promise<Buffer<ArrayBuffer>>((resolve) => (release = resolve)));
    const store = new GroupContextStore(scratch(), { convert });
    const [doc] = store.addFiles("trip", "Trip", [{ name: "old.doc", mediaType: "", bytes: Buffer.from("doc bytes") }], "person").added;
    const saving = store.writeFile({ groupId: "trip", itemId: doc!.id, baseBlobId: doc!.blobId, bytes: new Uint8Array(DOCX), as: "docx" });
    // The merge comes while macOS converts the edit.
    await vi.waitFor(() => expect(convert.docxToDoc).toHaveBeenCalledTimes(1));
    expect(store.moveAll("trip", "lisbon", "Lisbon")).toBe(1);
    release(Buffer.from("DOC: edited"));
    expect(await saving).toMatchObject({ ok: true, item: { mediaType: "application/msword" } });
    const moved = store.items("lisbon").find((item) => item.kind === "file")!;
    expect(Buffer.from((await store.fileContent("lisbon", moved.id))!.bytes).toString()).toBe("DOC: edited");
  });

  it("reads Word documents, workbooks and pictures the model cannot look at as they are, for the agent and for a mention", async () => {
    const convert = converter();
    const store = new GroupContextStore(scratch(), { convert });
    const [docx, doc, heic, big] = store.addFiles(
      "g1",
      "Lisbon",
      [
        { name: "trip.docx", mediaType: "", bytes: DOCX },
        { name: "old.doc", mediaType: "", bytes: Buffer.from("doc") },
        { name: "photo.heic", mediaType: "", bytes: Buffer.from("heic") },
        { name: "scan.pdf", mediaType: "", bytes: Buffer.alloc(5 * 1024 * 1024, 1) },
      ],
      "person",
    ).added;
    await expect(store.read("g1", docx!.id)).resolves.toMatchObject({ text: expect.stringContaining("We land at 11:05 on Friday") });
    await expect(store.read("g1", doc!.id)).resolves.toMatchObject({ text: "Lisbon trip, as text" });
    await expect(store.read("g1", heic!.id)).resolves.toMatchObject({ file: { mediaType: "image/png", dataUrl: `data:image/png;base64,${PNG.toString("base64")}` } });
    await expect(store.forMessage("g1", docx!.id)).resolves.toMatchObject({ kind: "text", name: "trip.docx" });
    await expect(store.forMessage("g1", heic!.id)).resolves.toMatchObject({ kind: "file", mediaType: "image/png" });
    // Too large to ride with a message: the agent is told where it is.
    await expect(store.forMessage("g1", big!.id)).resolves.toMatchObject({ kind: "reference", name: "scan.pdf", reason: "too large to attach" });
  });
});
