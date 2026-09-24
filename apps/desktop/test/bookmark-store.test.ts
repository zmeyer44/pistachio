import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BookmarkStore } from "../src/main/bookmark-store";
import type { BookmarkSource } from "@pistachio/shell-contracts/bookmarks";

const USER: BookmarkSource = { kind: "user", runId: null };
const AGENT: BookmarkSource = { kind: "agent", runId: "run-1" };

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "pistachio-bookmarks-"));
}

function clock(start = "2026-08-27T21:40:00.000Z") {
  let at = new Date(start);
  return {
    now: () => at,
    advance(ms: number) {
      at = new Date(at.getTime() + ms);
    },
  };
}

function open(directory = scratch(), time = clock()) {
  return { store: new BookmarkStore(directory, { now: time.now }), directory, time };
}

describe("BookmarkStore", () => {
  it("saves a page at once as a skeleton, then completes it from the reading", () => {
    const { store, directory, time } = open();
    const saved = store.add({ url: "https://www.amazon.com/dp/B00CH9QWOU?tag=x", title: "Amazon.com: Breville…", faviconUrl: "https://amazon.com/favicon.ico" }, USER, { status: "extracting" });
    expect(saved).toMatchObject({ url: "https://www.amazon.com/dp/B00CH9QWOU", status: "extracting", provenance: "none", kind: "website", siteName: "", editedFields: [], source: USER });
    time.advance(2_000);
    const done = store.complete(saved.id, {
      kind: "product",
      title: "Breville Barista Express",
      description: "An espresso machine.",
      imageUrl: "https://m.media-amazon.com/x.jpg",
      siteName: "Amazon",
      keywords: ["espresso"],
      details: [{ label: "Price", value: "$699.95" }],
      url: "https://www.amazon.com/dp/B00CH9QWOU",
      provenance: "model",
    });
    expect(done).toMatchObject({ status: "ready", provenance: "model", kind: "product", title: "Breville Barista Express", siteName: "Amazon", updatedAt: time.now().toISOString() });
    expect(done.createdAt).toBe(saved.createdAt);
    const reopened = new BookmarkStore(directory);
    expect(reopened.get(saved.id)).toEqual(done);
    expect(JSON.parse(readFileSync(join(directory, "bookmarks.json"), "utf8"))).toMatchObject({ version: 1 });
  });

  it("finds a page by any of its addresses", () => {
    const { store } = open();
    const saved = store.add({ url: "https://www.example.com/a?utm_source=x" }, USER);
    expect(store.byUrl("http://example.com/a/")?.id).toBe(saved.id);
    expect(store.byUrl("https://example.com/b")).toBeNull();
  });

  it("keeps exactly what the person edited when a late reading arrives", () => {
    const { store } = open();
    const saved = store.add({ url: "https://a.com/x", title: "A page" }, USER, { status: "extracting" });
    store.update(saved.id, { title: "My mug", note: "for the office" }, USER);
    const done = store.complete(saved.id, { kind: "product", title: "Nice Mug 12oz", description: "A mug.", keywords: ["mug"], details: [], imageUrl: null, siteName: "Shop", provenance: "page" });
    expect(done).toMatchObject({ title: "My mug", note: "for the office", kind: "product", description: "A mug.", keywords: ["mug"], siteName: "Shop", editedFields: ["title", "note"], status: "ready" });
    // A note typed while the page was read does not freeze the title.
    const other = store.add({ url: "https://a.com/y", title: "Raw tab title" }, USER, { status: "extracting" });
    store.update(other.id, { note: "later" }, USER);
    expect(store.complete(other.id, { title: "The thing", provenance: "page" })).toMatchObject({ title: "The thing", note: "later" });
  });

  it("marks edits, and an agent's edit as the agent's", () => {
    const { store, time } = open();
    const saved = store.add({ url: "https://a.com/x" }, USER);
    time.advance(1_000);
    const edited = store.update(saved.id, { kind: "book", keywords: ["Sci-Fi"], details: [{ label: "Author", value: "Weir" }] }, AGENT);
    expect(edited).toMatchObject({ kind: "book", keywords: ["Sci-Fi"], details: [{ label: "Author", value: "Weir" }], editedFields: ["kind", "keywords", "details"], source: AGENT, updatedAt: time.now().toISOString() });
    expect(() => store.update("nope", { title: "x" })).toThrow("bookmark not found");
  });

  it("keeps an edit made before a restart through a later reading", () => {
    const { store, directory } = open();
    const saved = store.add({ url: "https://a.com/x", title: "A page" }, USER);
    store.update(saved.id, { title: "The good one" }, USER);
    const reopened = new BookmarkStore(directory);
    expect(reopened.get(saved.id)?.editedFields).toEqual(["title"]);
    reopened.beginExtraction(saved.id);
    const done = reopened.complete(saved.id, { title: "Model's title", description: "Fresh.", provenance: "model" });
    expect(done).toMatchObject({ title: "The good one", description: "Fresh.", status: "ready" });
  });

  it("goes back to a skeleton for a second reading, removes, and lists newest first", () => {
    const { store, time } = open();
    const first = store.add({ url: "https://a.com/1" }, USER);
    time.advance(1_000);
    const second = store.add({ url: "https://a.com/2" }, USER);
    expect(store.all().map((bookmark) => bookmark.id)).toEqual([second.id, first.id]);
    expect(store.beginExtraction(first.id).status).toBe("extracting");
    expect(store.remove(first.id)).toBe(true);
    expect(store.remove(first.id)).toBe(false);
    expect(store.all().map((bookmark) => bookmark.id)).toEqual([second.id]);
  });

  it("searches what it holds", () => {
    const { store } = open();
    store.add({ url: "https://a.com/1", title: "Breville Barista Express", kind: "product", keywords: ["espresso"] }, USER);
    store.add({ url: "https://a.com/2", title: "Project Hail Mary", kind: "book" }, USER);
    expect(store.search("espresso").map((bookmark) => bookmark.title)).toEqual(["Breville Barista Express"]);
    expect(store.search("", { kind: "book" }).map((bookmark) => bookmark.title)).toEqual(["Project Hail Mary"]);
  });

  it("tells listeners after every change", () => {
    const { store } = open();
    let calls = 0;
    const off = store.onChange(() => {
      calls += 1;
    });
    const saved = store.add({ url: "https://a.com/x" }, USER, { status: "extracting" });
    store.complete(saved.id, { provenance: "none" });
    store.update(saved.id, { note: "n" });
    off();
    store.remove(saved.id);
    expect(calls).toBe(3);
  });
});
