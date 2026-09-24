import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractBookmark, extractionPrompt, mergeModelAnswer } from "../src/main/bookmark-extractor";
import { BookmarkStore } from "../src/main/bookmark-store";
import { BookmarkService, USER_BOOKMARK_SOURCE, type BookmarkPageReader } from "../src/main/bookmarks";
import { draftFromPage, type BookmarkToast, type PageSnapshot } from "@pistachio/shell-contracts/bookmarks";
import type { BrowserTabInfo } from "@pistachio/shell-contracts/ipc";

function tab(id: string, url: string, title = "A page"): BrowserTabInfo {
  return { id, spaceId: "s", title, url, faviconUrl: "https://a.com/favicon.ico", loading: false, canGoBack: false, canGoForward: false, kind: "human", runId: null, lifecycle: "live", lastActiveAt: 0, anchorId: null, unlisted: false };
}

function snapshot(url: string, overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return { url, title: "Breville Barista Express | Amazon", lang: "en", meta: [{ name: "og:site_name", content: "Amazon" }, { name: "og:type", content: "product" }], links: [], jsonLd: [], headline: "", images: [], text: "An espresso machine.", ...overrides };
}

const HTML = `<html><head><title>Cacio e Pepe | Serious Eats</title><meta property="og:site_name" content="Serious Eats"><script type="application/ld+json">{"@type":"Recipe","name":"Cacio e Pepe","totalTime":"PT20M"}</script></head><body><p>Pasta.</p></body></html>`;

function harness(options: { tabs?: BrowserTabInfo[]; capture?: (tabId: string) => Promise<PageSnapshot>; fetch?: (url: string) => Promise<string>; useModel?: boolean } = {}) {
  const tabs = options.tabs ?? [tab("t1", "https://www.amazon.com/dp/B00CH9QWOU?tag=x", "Amazon.com: Breville Barista Express")];
  const calls: string[] = [];
  const reader: BookmarkPageReader = {
    activeTab: () => tabs[0] ?? null,
    tab: (id) => tabs.find((candidate) => candidate.id === id) ?? null,
    allTabs: () => tabs,
    capturePage: async (tabId) => {
      calls.push(`capture:${tabId}`);
      if (options.capture !== undefined) return options.capture(tabId);
      const own = tabs.find((candidate) => candidate.id === tabId);
      return snapshot(own?.url ?? "https://a.com/");
    },
    fetchHtml: async (url) => {
      calls.push(`fetch:${url}`);
      if (options.fetch !== undefined) return options.fetch(url);
      return HTML;
    },
  };
  const toasts: Array<BookmarkToast | null> = [];
  const store = new BookmarkStore(mkdtempSync(join(tmpdir(), "pistachio-bookmark-service-")));
  const service = new BookmarkService({
    store,
    reader: () => reader,
    useModel: () => options.useModel ?? false,
    onToast: (toast) => toasts.push(toast),
    // The page's own draft, without a model: what a run without a key gets.
    extract: async (page) => ({ fields: draftFromPage(page), url: page.url, provenance: "page" }),
  });
  return { store, service, toasts, calls };
}

async function settled(store: BookmarkStore, id: string, tries = 50): Promise<void> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (store.get(id)?.status === "ready") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the bookmark never settled");
}

describe("BookmarkService", () => {
  it("shows the skeleton at once and fills the card from the page", async () => {
    const { store, service, toasts, calls } = harness();
    const skeleton = service.captureTab();
    expect(skeleton).toMatchObject({ status: "extracting", title: "Amazon.com: Breville Barista Express", url: "https://www.amazon.com/dp/B00CH9QWOU", faviconUrl: "https://a.com/favicon.ico" });
    expect(toasts).toEqual([{ id: skeleton.id, existed: false, shownAt: expect.any(String) }]);
    await settled(store, skeleton.id);
    expect(store.get(skeleton.id)).toMatchObject({ status: "ready", provenance: "page", kind: "product", title: "Breville Barista Express", siteName: "Amazon" });
    expect(calls).toEqual(["capture:t1"]);
  });

  it("shows the existing card for a page already saved rather than a twin", async () => {
    const { store, service, toasts } = harness();
    const first = service.captureTab();
    await settled(store, first.id);
    const again = service.captureTab();
    expect(again.id).toBe(first.id);
    expect(store.all()).toHaveLength(1);
    expect(toasts.at(-1)).toMatchObject({ id: first.id, existed: true });
  });

  it("declines the app's own pages", () => {
    const { service } = harness({ tabs: [tab("t1", "pistachio://reminders")] });
    expect(() => service.captureTab()).toThrow(/web pages/);
    expect(() => service.captureTab("missing")).toThrow(/no page/);
  });

  it("falls back to fetching the page when the tab cannot be read, and completes on nothing when that fails too", async () => {
    const failing = harness({ capture: async () => { throw new Error("tab gone"); } });
    const one = failing.service.captureTab();
    await settled(failing.store, one.id);
    expect(failing.calls).toEqual(["capture:t1", "fetch:https://www.amazon.com/dp/B00CH9QWOU?tag=x"]);
    // The fetched HTML is a recipe page in this harness: that is what is read.
    expect(failing.store.get(one.id)).toMatchObject({ status: "ready", provenance: "page", kind: "recipe", title: "Cacio e Pepe" });

    const dead = harness({ capture: async () => { throw new Error("tab gone"); }, fetch: async () => { throw new Error("offline"); } });
    const two = dead.service.captureTab();
    await settled(dead.store, two.id);
    expect(dead.store.get(two.id)).toMatchObject({ status: "ready", provenance: "none", title: "Amazon.com: Breville Barista Express" });
  });

  it("saves an address for the agent, reading its tab when open and its HTML otherwise, with the agent's words on top", async () => {
    const { store, service, calls, toasts } = harness();
    const fromTab = await service.create({ url: "https://amazon.com/dp/B00CH9QWOU", note: "for the office kitchen" }, { kind: "agent", runId: "run-1" });
    expect(fromTab).toMatchObject({ status: "ready", kind: "product", title: "Breville Barista Express", note: "for the office kitchen", source: { kind: "agent", runId: "run-1" } });
    expect(calls).toEqual(["capture:t1"]);
    expect(toasts.at(-1)).toMatchObject({ id: fromTab.id, existed: false });

    const fetched = await service.create({ url: "https://www.seriouseats.com/cacio-e-pepe", kind: "recipe", title: "Cacio e Pepe (weeknight)" }, { kind: "agent", runId: "run-1" });
    expect(calls.at(-1)).toBe("fetch:https://www.seriouseats.com/cacio-e-pepe");
    expect(fetched).toMatchObject({ status: "ready", kind: "recipe", title: "Cacio e Pepe (weeknight)", siteName: "Serious Eats", details: [{ label: "Total time", value: "20m" }], editedFields: ["title", "kind"] });

    // Saving it again only adds what is new.
    const again = await service.create({ url: "https://www.seriouseats.com/cacio-e-pepe", note: "Tuesday" }, { kind: "agent", runId: "run-2" });
    expect(again.id).toBe(fetched.id);
    expect(again.note).toBe("Tuesday");
    expect(store.all()).toHaveLength(2);
    await expect(service.create({ url: "pistachio://bookmarks" }, USER_BOOKMARK_SOURCE)).rejects.toThrow(/http/);
  });

  it("reads a page again on request, keeping what was edited", async () => {
    const { store, service, calls } = harness();
    const saved = service.captureTab();
    await settled(store, saved.id);
    store.update(saved.id, { title: "The good espresso machine" });
    const refreshed = await service.refresh(saved.id);
    expect(refreshed).toMatchObject({ status: "ready", title: "The good espresso machine", kind: "product" });
    expect(calls).toEqual(["capture:t1", "capture:t1"]);
    await expect(service.refresh("nope")).rejects.toThrow("bookmark not found");
  });

  it("treats an undo during the reading as its cancellation, not an error", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { store, service } = harness({ capture: async (tabId) => { await gate; return snapshot(`https://www.amazon.com/dp/${tabId}`); } });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const skeleton = service.captureTab();
      expect(store.remove(skeleton.id)).toBe(true);
      release!();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(store.all()).toEqual([]);
      expect(unhandled).toEqual([]);
      // The awaited paths say so in words instead.
      await expect(service.refresh(skeleton.id)).rejects.toThrow("bookmark not found");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("takes the card down on request", () => {
    const { service, toasts } = harness();
    service.captureTab();
    service.dismissToast();
    expect(service.toast()).toBeNull();
    expect(toasts.at(-1)).toBeNull();
  });
});

describe("extraction", () => {
  const page = snapshot("https://www.amazon.com/dp/B00CH9QWOU", { images: ["https://m.media-amazon.com/a.jpg", "https://m.media-amazon.com/b.jpg"] });

  it("is the page's draft when the model is off or absent", async () => {
    const result = await extractBookmark(page, { useModel: false });
    expect(result).toMatchObject({ provenance: "page", url: "https://www.amazon.com/dp/B00CH9QWOU", fields: { kind: "product", title: "Breville Barista Express", siteName: "Amazon" } });
    const offline = await extractBookmark(page, { env: { PISTACHIO_E2E: "1" } });
    expect(offline.provenance).toBe("page");
  });

  it("checks the model's answer against the page", () => {
    const draft = draftFromPage(page);
    const merged = mergeModelAnswer(
      draft,
      { kind: "product", title: "  Breville Barista Express  ", description: "", siteName: null, imageUrl: "https://m.media-amazon.com/b.jpg", keywords: ["Espresso", "espresso", "coffee"], details: [{ label: "Price", value: "$699.95" }] },
      ["https://m.media-amazon.com/a.jpg", "https://m.media-amazon.com/b.jpg"],
    );
    expect(merged).toMatchObject({ title: "Breville Barista Express", description: draft.description, siteName: "Amazon", imageUrl: "https://m.media-amazon.com/b.jpg", details: [{ label: "Price", value: "$699.95" }] });
    expect(merged.keywords.slice(0, 2)).toEqual(["espresso", "coffee"]);
    // An image the page never showed is not taken; the draft's stands.
    const invented = mergeModelAnswer(draft, { kind: "product", title: "X", description: "Y", siteName: "Z", imageUrl: "https://elsewhere.com/x.jpg", keywords: [], details: [] }, ["https://m.media-amazon.com/a.jpg"]);
    expect(invented.imageUrl).toBe(draft.imageUrl);
    expect(invented.keywords).toEqual(draft.keywords);
  });

  it("asks about the thing, with the page's evidence and the person's hint", () => {
    const prompt = extractionPrompt(page, draftFromPage(page), ["https://m.media-amazon.com/a.jpg"], "the machine, not the grinder");
    expect(prompt).toContain("Address: https://www.amazon.com/dp/B00CH9QWOU");
    expect(prompt).toContain("the machine, not the grinder");
    expect(prompt).toContain("og:site_name: Amazon");
    expect(prompt).toContain("1. https://m.media-amazon.com/a.jpg");
    expect(prompt).toContain("An espresso machine.");
  });
});
