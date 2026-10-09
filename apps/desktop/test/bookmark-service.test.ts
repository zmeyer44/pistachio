import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import type { WatchtowerSavedEntity } from "@pistachio/shell-contracts/watchtower";
import { extractBookmark, extractionPrompt, mergeModelAnswer, verifiedEntities } from "../src/main/bookmark-extractor";
import { BookmarkStore } from "../src/main/bookmark-store";
import { BookmarkService, USER_BOOKMARK_SOURCE, type ArchiveKept, type BookmarkArchive, type BookmarkPageReader } from "../src/main/bookmarks";
import { draftFromPage, type BookmarkToast, type PageSnapshot } from "@pistachio/shell-contracts/bookmarks";
import type { BrowserTabInfo } from "@pistachio/shell-contracts/ipc";

function tab(id: string, url: string, title = "A page"): BrowserTabInfo {
  return { id, spaceId: "s", title, url, faviconUrl: "https://a.com/favicon.ico", loading: false, canGoBack: false, canGoForward: false, kind: "human", runId: null, lifecycle: "live", lastActiveAt: 0, anchorId: null, unlisted: false };
}

function snapshot(url: string, overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return { url, title: "Breville Barista Express | Amazon", lang: "en", meta: [{ name: "og:site_name", content: "Amazon" }, { name: "og:type", content: "product" }], links: [], jsonLd: [], headline: "", images: [], text: "An espresso machine.", ...overrides };
}

const HTML = `<html><head><title>Cacio e Pepe | Serious Eats</title><meta property="og:site_name" content="Serious Eats"><script type="application/ld+json">{"@type":"Recipe","name":"Cacio e Pepe","totalTime":"PT20M"}</script></head><body><p>Pasta.</p></body></html>`;

function harness(options: { tabs?: BrowserTabInfo[]; capture?: (tabId: string) => Promise<PageSnapshot>; fetch?: (url: string) => Promise<string>; useModel?: boolean; archive?: BookmarkArchive; entities?: WatchtowerSavedEntity[] } = {}) {
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
    extract: async (page) => ({ fields: draftFromPage(page), url: page.url, provenance: "page", entities: options.entities ?? [] }),
    ...(options.archive === undefined ? {} : { archive: () => options.archive ?? null }),
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

/** Watchtower, as the save sees it: what it was asked to keep and to file. */
function archive(outcome: ArchiveKept | { skipped: string } = { observationId: "o1", snapshotId: 7, pageId: 3, spaceId: "s", epoch: 1 }) {
  const log: string[] = [];
  const filed: WatchtowerSavedEntity[][] = [];
  const fake: BookmarkArchive = {
    keep: async (tabId, keptKey) => {
      log.push(`keep:${tabId}:${keptKey}`);
      return outcome;
    },
    file: async (_kept, entities) => {
      filed.push(entities);
      return entities.map((entity, index) => ({ id: index + 1, kind: entity.kind, name: entity.name }));
    },
    about: async () => ({ observationId: "o1", entities: [{ id: 9, kind: "product", name: "Barista Express" }] }),
    rekeep: (_kept, keptKey) => log.push(`rekeep:${keptKey}`),
  };
  return { fake, log, filed };
}

const PERSON_AND_COMPANY: WatchtowerSavedEntity[] = [
  { kind: "person", name: "Patrick Collison", aliases: ["Collison"], role: "subject", facts: [{ kind: "definition", text: "Patrick Collison is the CEO of Stripe." }], context: "Patrick Collison is the CEO of Stripe." },
  { kind: "company", name: "Stripe", aliases: [], role: "major", facts: [], context: "Patrick Collison is the CEO of Stripe." },
];

async function archived(service: BookmarkService, state: "saved" | "skipped", tries = 50): Promise<void> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (service.toast()?.watchtower?.state === state) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`the save never reached ${state} in Watchtower`);
}

describe("a save is a Watchtower save", () => {
  it("keeps the page while the model reads it, then files everything it is about and says so on the card", async () => {
    const { fake, log, filed } = archive();
    const { store, service, toasts } = harness({ archive: fake, entities: PERSON_AND_COMPANY });
    const skeleton = service.captureTab();
    // The card goes up at once, already saying the page is being kept.
    expect(toasts[0]).toMatchObject({ id: skeleton.id, existed: false, watchtower: { state: "saving", entities: [] } });
    expect(log).toEqual(["keep:t1:amazon.com/dp/B00CH9QWOU"]);
    await settled(store, skeleton.id);
    await archived(service, "saved");
    expect(filed).toEqual([PERSON_AND_COMPANY]);
    expect(service.toast()?.watchtower).toEqual({
      state: "saved",
      observationId: "o1",
      entities: [
        { id: 1, kind: "person", name: "Patrick Collison" },
        { id: 2, kind: "company", name: "Stripe" },
      ],
    });
    // The kept page follows the record's address as it settled.
    expect(log).toContain("rekeep:amazon.com/dp/B00CH9QWOU");
  });

  it("with nothing read by the model, shows what the archive already filed the page under", async () => {
    const { fake, filed } = archive();
    const { store, service } = harness({ archive: fake });
    const saved = service.captureTab();
    await settled(store, saved.id);
    await archived(service, "saved");
    expect(filed).toEqual([]);
    expect(service.toast()?.watchtower?.entities).toEqual([{ id: 9, kind: "product", name: "Barista Express" }]);
  });

  it("still saves when Watchtower will not keep the page, and says why", async () => {
    const { fake } = archive({ skipped: "This site or Profile is excluded from Watchtower." });
    const { store, service } = harness({ archive: fake, entities: PERSON_AND_COMPANY });
    const saved = service.captureTab();
    await settled(store, saved.id);
    await archived(service, "skipped");
    expect(store.get(saved.id)?.status).toBe("ready");
    expect(service.toast()?.watchtower).toEqual({ state: "skipped", reason: "This site or Profile is excluded from Watchtower.", entities: [] });
  });

  it("saves a page saved before again: a new version kept, its entries brought up to date", async () => {
    const { fake, log, filed } = archive();
    const { store, service } = harness({ archive: fake, entities: PERSON_AND_COMPANY });
    const first = service.captureTab();
    await settled(store, first.id);
    await archived(service, "saved");
    const again = service.captureTab();
    expect(again.id).toBe(first.id);
    expect(service.toast()).toMatchObject({ id: first.id, existed: true, watchtower: { state: "saving" } });
    await settled(store, first.id);
    await archived(service, "saved");
    expect(log.filter((entry) => entry.startsWith("keep:"))).toHaveLength(2);
    expect(filed).toHaveLength(2);
    expect(store.all()).toHaveLength(1);
  });

  it("has no Watchtower half where there is no archive", async () => {
    const { store, service, toasts } = harness();
    const saved = service.captureTab();
    await settled(store, saved.id);
    expect(toasts.every((toast) => toast === null || toast.watchtower === undefined)).toBe(true);
  });
});

describe("what a saved page is about", () => {
  const TEXT = "Patrick Collison is the CEO of Stripe. He co-founded the company with his brother John in 2010. Stripe processed $1.4 trillion in 2024, up 38% from the year before.";
  const answer = (entities: Parameters<typeof verifiedEntities>[0]) => entities;

  it("keeps a fact only when the page says it, word for word", () => {
    const entities = verifiedEntities(
      answer([
        { kind: "company", name: "Stripe", alsoKnownAs: ["Stripe, Inc.", "Stripe"], role: "major", facts: [
          { kind: "metric", quote: "Stripe processed $1.4 trillion in 2024, up 38% from the year before." },
          // Paraphrased: not on the page.
          { kind: "metric", quote: "Stripe handled about $1.4T of payments last year." },
        ] },
        { kind: "person", name: "  Patrick   Collison ", alsoKnownAs: [], role: "subject", facts: [
          // Curly quotes and a line break where the page had none still match.
          { kind: "definition", quote: "“Patrick Collison is the CEO\nof Stripe.”" },
        ] },
        { kind: "person", name: "Patrick Collison", alsoKnownAs: [], role: "mention", facts: [] },
      ]),
      TEXT,
    );
    // The subject first; the duplicate gone; the invented fact dropped.
    expect(entities.map((entity) => [entity.kind, entity.name, entity.role])).toEqual([
      ["person", "Patrick Collison", "subject"],
      ["company", "Stripe", "major"],
    ]);
    expect(entities[0]!.facts).toEqual([{ kind: "definition", text: "Patrick Collison is the CEO of Stripe." }]);
    expect(entities[1]!.facts).toEqual([{ kind: "metric", text: "Stripe processed $1.4 trillion in 2024, up 38% from the year before." }]);
    expect(entities[1]!.aliases).toEqual(["Stripe, Inc."]);
    expect(entities[1]!.context).toContain("Stripe");
  });

  it("reads the card and every entity in one answer from the model", async () => {
    const page = snapshot("https://www.example.com/people/patrick-collison", { title: "Patrick Collison | Profiles", text: TEXT, meta: [{ name: "og:site_name", content: "Profiles" }] });
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              kind: "website",
              title: "Patrick Collison",
              description: "The CEO of Stripe.",
              siteName: "Profiles",
              imageUrl: null,
              keywords: ["stripe", "founder"],
              details: [],
              entities: [
                { kind: "person", name: "Patrick Collison", alsoKnownAs: ["Collison"], role: "subject", facts: [{ kind: "definition", quote: "Patrick Collison is the CEO of Stripe." }] },
                { kind: "company", name: "Stripe", alsoKnownAs: [], role: "major", facts: [{ kind: "metric", quote: "Stripe processed $1.4 trillion in 2024, up 38% from the year before." }] },
                { kind: "person", name: "John Collison", alsoKnownAs: ["John"], role: "mention", facts: [] },
              ],
            }),
          },
        ],
        finishReason: { unified: "stop", raw: "end_turn" },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
        warnings: [],
      }),
    });
    const result = await extractBookmark(page, { model, env: {} });
    expect(result.provenance).toBe("model");
    expect(result.fields.title).toBe("Patrick Collison");
    expect(result.entities?.map((entity) => `${entity.role}:${entity.kind}:${entity.name}`)).toEqual(["subject:person:Patrick Collison", "major:company:Stripe", "mention:person:John Collison"]);
    // Without a model there is nothing to file: the page's own tags stand.
    expect((await extractBookmark(page, { useModel: false })).entities).toBeUndefined();
  });
});

