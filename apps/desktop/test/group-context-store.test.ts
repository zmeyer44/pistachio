/**
 * A tab group's context on disk and in sync (docs/desk-agent.md §3): files
 * content-addressed beside one index, owner-only; what the agent reads of
 * an item; and the two registers another Mac sees — the context (whole, by
 * group) and each file small enough to travel, verified by its hash.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
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
    expect(rejected).toEqual([{ name: "song.mp3", reason: "Pistachio can read images, PDFs and text files" }]);
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

  it("reads a fact, a text file as text, and an image or PDF as a file the model looks at", () => {
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
    expect(store.read("g1", fact.id)).toMatchObject({ text: "Check-in from 15:00\n(from “Hotel Avenida” https://hotel.example/)" });
    expect(store.read("g1", notes!.id)).toMatchObject({ text: "Gate closes 09:10" });
    expect(store.read("g1", pdf!.id)).toMatchObject({ file: { mediaType: "application/pdf", name: "pass.pdf", dataUrl: `data:application/pdf;base64,${PDF.toString("base64")}` } });
    expect(store.read("g1", picture!.id)).toMatchObject({ file: { mediaType: "image/png" } });
    expect(() => store.read("g1", "000000000000")).toThrow(/no item/);
    expect(() => store.read("g2", fact.id)).toThrow(/no item/);
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

  it("takes another Mac's context whole, keeps its files only when their bytes hash to their key, and says which are here", () => {
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
    expect(mine.read("g1", mine.items("g1")[0]!.id)).toMatchObject({ file: { name: "pass.pdf" } });

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
