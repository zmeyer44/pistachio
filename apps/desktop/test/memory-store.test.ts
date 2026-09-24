import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryStore, type MemoryEmbedder } from "../src/main/memory-store";
import { factKey, PROFILE_KEY, rekeyedFor, type MemorySource } from "@pistachio/shell-contracts/memory";

const USER: MemorySource = { kind: "user", runId: null };
const AGENT: MemorySource = { kind: "agent", runId: "run-1" };
const LEARNED: MemorySource = { kind: "learned", runId: "run-1" };

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "pistachio-memory-"));
}

/** A clock the test moves by hand. */
function clock(start = "2026-03-14T12:00:00.000Z") {
  let at = new Date(start);
  return {
    now: () => at,
    advance(ms: number) {
      at = new Date(at.getTime() + ms);
    },
  };
}

describe("MemoryStore", () => {
  it("persists what it is told and reads it back", () => {
    const directory = scratch();
    const store = new MemoryStore(directory);
    const fact = store.add({ content: "Prefers aisle seats", kind: "static", bucket: "preference" }, USER);
    expect(fact).toMatchObject({ version: 1, isLatest: true, confidence: 1, review: "approved", source: USER });
    const reopened = new MemoryStore(directory);
    expect(reopened.get(fact.id)).toEqual(fact);
    expect(JSON.parse(readFileSync(join(directory, "memory.json"), "utf8"))).toMatchObject({ version: 1 });
  });

  it("frees a renamed place's key, so the old name can be added again beside it", () => {
    // Settings → Memory: Home/Boston renamed to Office, then Home/Cambridge
    // added. The rename carries the key with it (rekeyedFor), so the add
    // makes a second record instead of versioning Office away.
    const store = new MemoryStore(scratch());
    const home = store.add({ key: factKey("location", "Home"), label: "Home", content: "Boston", kind: "static", bucket: "location" }, USER);
    const office = store.update(home.id, { label: "Office", key: rekeyedFor(home, "location", "Office") }, USER);
    expect(office.key).toBe("location.office");
    expect(office.content).toBe("Boston");
    const cambridge = store.add({ key: factKey("location", "Home"), label: "Home", content: "Cambridge", kind: "static", bucket: "location" }, USER);
    expect(cambridge.rootId).not.toBe(home.rootId);
    const active = store.all().filter((entry) => entry.isLatest && !entry.isForgotten && entry.bucket === "location");
    expect(active.map((entry) => `${entry.label ?? ""}/${entry.content}`).sort()).toEqual(["Home/Cambridge", "Office/Boston"]);
    // Renaming onto a name another place holds is refused, not merged.
    expect(() => store.update(cambridge.id, { label: "Office", key: rekeyedFor(cambridge, "location", "Office") }, USER)).toThrow(/already uses/);
  });

  it("versions a keyed fact instead of duplicating it, and keeps the history", () => {
    const store = new MemoryStore(scratch());
    const first = store.add({ key: PROFILE_KEY.name, content: "Alex", kind: "static", bucket: "profile" }, USER);
    const second = store.add({ key: PROFILE_KEY.name, content: "Alexandra", kind: "static", bucket: "profile" }, USER);
    expect(second.id).not.toBe(first.id);
    expect(second).toMatchObject({ rootId: first.id, parentId: first.id, version: 2, isLatest: true });
    expect(store.get(first.id)?.isLatest).toBe(false);
    expect(store.active().map((entry) => entry.content)).toEqual(["Alexandra"]);
    expect(store.history(first.id).map((entry) => entry.content)).toEqual(["Alex", "Alexandra"]);
    expect(store.profile().name).toBe("Alexandra");
  });

  it("re-asserts a repeated fact rather than storing it twice", () => {
    const store = new MemoryStore(scratch());
    const once = store.add({ content: "Prefers aisle seats", bucket: "preference" }, LEARNED);
    const twice = store.add({ content: "prefers aisle seats!", bucket: "preference" }, USER);
    expect(twice.id).toBe(once.id);
    expect(twice.mentions).toBe(2);
    expect(twice.confidence).toBe(1);
    expect(store.all()).toHaveLength(1);
  });

  it("updates through an old version's id, and does nothing for a no-op", () => {
    const store = new MemoryStore(scratch());
    const v1 = store.add({ content: "Lives in Boston", label: "Home", bucket: "location" }, USER);
    const v2 = store.update(v1.id, { content: "Lives in Denver" }, AGENT);
    const v3 = store.update(v1.id, { content: "Lives in Denver, Colorado" }, AGENT);
    expect(v3).toMatchObject({ rootId: v1.id, parentId: v2.id, version: 3, source: AGENT, label: "Home" });
    expect(store.update(v3.id, { content: "Lives in Denver, Colorado" }, AGENT)).toEqual(v3);
    expect(store.all()).toHaveLength(3);
    expect(() => store.update("nope", { content: "x" }, AGENT)).toThrow("memory not found");
  });

  it("keeps a label out of its own content, whoever wrote it", () => {
    const store = new MemoryStore(scratch());
    const home = store.add({ content: "Home: Lives in Denver", label: "Home", bucket: "location" }, LEARNED);
    expect(home.content).toBe("Lives in Denver");
    expect(store.update(home.id, { content: "home: Home: Lives in Boulder" }, LEARNED).content).toBe("Lives in Boulder");
    // Only a leading label is a repeat; the word inside a sentence stays.
    expect(store.update(home.id, { content: "Moved home to Boulder" }, LEARNED).content).toBe("Moved home to Boulder");
  });

  it("refuses a secret from the agent or the learner, but not from the person", () => {
    const store = new MemoryStore(scratch());
    expect(() => store.add({ content: "The password is hunter2" }, AGENT)).toThrow(/cannot be remembered/);
    expect(() => store.add({ content: "Card 4242 4242 4242 4242" }, LEARNED)).toThrow(/cannot be remembered/);
    const fact = store.add({ content: "Uses the corporate card" }, AGENT);
    expect(() => store.update(fact.id, { content: "Corporate card, CVV 123" }, AGENT)).toThrow(/cannot be remembered/);
    expect(store.active()).toHaveLength(1);
    // Their own words are their own business.
    expect(store.add({ content: "Locker passcode is 4411" }, USER).content).toBe("Locker passcode is 4411");
  });

  it("moves a fact's key with a rename, and refuses a key another fact holds", () => {
    const store = new MemoryStore(scratch());
    const home = store.add({ content: "Denver", label: "Home", key: "location.home", kind: "static", bucket: "location" }, USER);
    const office = store.update(home.id, { label: "Office", key: "location.office" }, USER);
    expect(office).toMatchObject({ version: 2, label: "Office", key: "location.office" });
    // "Home" is free again: a new one is a new fact, not a version of Office.
    const again = store.add({ content: "Boulder", label: "Home", key: "location.home", kind: "static", bucket: "location" }, USER);
    expect(again.version).toBe(1);
    expect(again.rootId).not.toBe(home.id);
    expect(() => store.update(again.id, { key: "location.office" }, USER)).toThrow(/already uses location.office/);
    expect(store.update(again.id, { key: null }, USER).key).toBeNull();
  });

  it("forgets softly, restores, and records who and why", () => {
    const time = clock();
    const store = new MemoryStore(scratch(), { now: time.now });
    const fact = store.add({ content: "Allergic to shellfish" }, USER);
    time.advance(1_000);
    const gone = store.forget(fact.id, "Not true any more", AGENT);
    expect(gone).toMatchObject({ isForgotten: true, forgetReason: "Not true any more", source: AGENT });
    expect(gone.forgottenAt).toBe(time.now().toISOString());
    expect(store.active()).toEqual([]);
    expect(store.restore(fact.id)).toMatchObject({ isForgotten: false, forgottenAt: null, forgetReason: null });
    expect(store.active()).toHaveLength(1);
  });

  it("expires what has passed its forgetAfter, and restoring drops the clock", () => {
    const time = clock();
    const store = new MemoryStore(scratch(), { now: time.now });
    const fact = store.add({ content: "Flying to Berlin on the 20th", forgetAfter: "2026-03-21T00:00:00.000Z" }, USER);
    expect(store.active()).toHaveLength(1);
    time.advance(8 * 86_400_000);
    expect(store.expire()).toBe(1);
    expect(store.get(fact.id)).toMatchObject({ isForgotten: true, forgetReason: "Expired" });
    expect(store.restore(fact.id).forgetAfter).toBeNull();
  });

  it("reviews an inferred fact: approve lifts it, decline hides it", () => {
    const store = new MemoryStore(scratch());
    const guess = store.add({ content: "Probably prefers mornings", confidence: 0.5, review: "pending" }, LEARNED);
    expect(store.review(guess.id, "approved")).toMatchObject({ review: "approved", confidence: 0.9 });
    expect(store.review(guess.id, "declined").review).toBe("declined");
    expect(store.active()).toEqual([]);
    expect(store.prompt()).toBe("");
  });

  it("the person restating a learned fact settles it", () => {
    const store = new MemoryStore(scratch());
    const guess = store.add({ content: "Prefers mornings", confidence: 0.5, review: "pending" }, LEARNED);
    const settled = store.update(guess.id, { content: "Prefers early mornings" }, USER);
    expect(settled).toMatchObject({ review: "approved", confidence: 1 });
  });

  it("searches lexically and stamps what it recalled", async () => {
    const store = new MemoryStore(scratch());
    const seats = store.add({ content: "Prefers aisle seats on flights", bucket: "preference" }, USER);
    store.add({ label: "Home", content: "Denver, Colorado", bucket: "location" }, USER);
    const hits = await store.search("book a flight");
    expect(hits.map((entry) => entry.id)).toEqual([seats.id]);
    expect(store.get(seats.id)?.lastRecalledAt).not.toBeNull();
  });

  it("applies a batch, skipping stale ids without dropping the rest", () => {
    const store = new MemoryStore(scratch());
    const old = store.add({ content: "Works at Acme", kind: "static", bucket: "profile" }, USER);
    const changes = store.applyOperations(
      [
        { op: "update", id: old.id, content: "Works at Stripe" },
        { op: "forget", id: "stale", reason: "gone" },
        { op: "add", content: "Leads a team of five", kind: "dynamic", bucket: "profile" },
        { op: "add", content: "Works at Stripe", kind: "static" },
      ],
      LEARNED,
    );
    expect(changes.updated.map((entry) => entry.content)).toEqual(["Works at Stripe", "Works at Stripe"]);
    expect(changes.added.map((entry) => entry.content)).toEqual(["Leads a team of five"]);
    expect(changes.forgotten).toEqual([]);
    expect(store.active().map((entry) => entry.content).sort()).toEqual(["Leads a team of five", "Works at Stripe"]);
    expect(store.active().find((entry) => entry.content === "Works at Stripe")?.mentions).toBe(2);
  });

  it("forgets everything active at once and keeps the audit", () => {
    const store = new MemoryStore(scratch());
    store.add({ content: "a" }, USER);
    store.add({ content: "b" }, USER);
    expect(store.forgetAll("Cleared", USER)).toBe(2);
    expect(store.active()).toEqual([]);
    expect(store.all()).toHaveLength(2);
    expect(store.forgetAll("Cleared", USER)).toBe(0);
  });

  it("tells listeners on every commit with a snapshot that carries no vectors", () => {
    const store = new MemoryStore(scratch());
    const seen: number[] = [];
    const off = store.onChange((snapshot) => seen.push(snapshot.entries.length));
    store.add({ content: "a" }, USER);
    store.add({ content: "b" }, USER);
    off();
    store.add({ content: "c" }, USER);
    expect(seen).toEqual([1, 2]);
    expect(Object.keys(store.snapshot())).toEqual(["entries"]);
  });

  it("survives a corrupt file", () => {
    const directory = scratch();
    writeFileSync(join(directory, "memory.json"), "{not json");
    expect(new MemoryStore(directory).all()).toEqual([]);
  });
});

/** Two axes: "travel" and "home". Deterministic and instant. */
function fakeEmbedder(id = "fake-v1"): MemoryEmbedder & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    id,
    calls,
    embed: async (texts) => {
      calls.push(texts);
      return texts.map((text) => {
        const lower = text.toLowerCase();
        const travel = /flight|seat|travel|trip|airport/.test(lower) ? 1 : 0;
        const home = /home|live|address|denver/.test(lower) ? 1 : 0;
        return [travel, home, travel === 0 && home === 0 ? 1 : 0];
      });
    },
  };
}

describe("MemoryStore with an embedder", () => {
  it("embeds in the background, searches semantically, and persists the vectors", async () => {
    const directory = scratch();
    const embedder = fakeEmbedder();
    const store = new MemoryStore(directory, { embedder });
    const home = store.add({ label: "Home", content: "Denver, Colorado", bucket: "location" }, USER);
    store.add({ content: "Prefers aisle seats", bucket: "preference" }, USER);
    // No shared word with the fact: only a vector can find it.
    const hits = await store.search("where should the package be delivered");
    expect(hits.map((entry) => entry.id)).toEqual([home.id]);

    const file = JSON.parse(readFileSync(join(directory, "memory.json"), "utf8")) as { vectors?: { model: string; byId: Record<string, number[]> } };
    expect(file.vectors?.model).toBe("fake-v1");
    expect(Object.keys(file.vectors?.byId ?? {})).toHaveLength(2);

    // Reopened with the same model: nothing is re-embedded.
    const again = fakeEmbedder();
    const reopened = new MemoryStore(directory, { embedder: again });
    await reopened.search("delivery address");
    expect(again.calls.flat()).toEqual(["delivery address"]);

    // A different model throws the stored vectors away.
    const other = fakeEmbedder("fake-v2");
    const migrated = new MemoryStore(directory, { embedder: other });
    await migrated.search("delivery address");
    expect(other.calls.flat().length).toBeGreaterThan(1);
  });

  it("does not embed while memory is off, and catches up when it is turned on", async () => {
    const embedder = fakeEmbedder();
    const store = new MemoryStore(scratch(), { embedder, embeddingEnabled: false });
    const home = store.add({ label: "Home", content: "Denver, Colorado", bucket: "location" }, USER);
    // Lexical only: nothing left this Mac, and a vector-only query finds nothing.
    expect(await store.search("where should the package be delivered")).toEqual([]);
    expect(embedder.calls).toEqual([]);
    store.setEmbeddingEnabled(true);
    expect((await store.search("where should the package be delivered")).map((entry) => entry.id)).toEqual([home.id]);
    expect(embedder.calls.length).toBeGreaterThan(0);
    store.setEmbeddingEnabled(false);
    const before = embedder.calls.length;
    store.add({ content: "Prefers aisle seats", bucket: "preference" }, USER);
    await store.search("seat on the plane");
    expect(embedder.calls.length).toBe(before);
  });

  it("falls back to lexical search when embedding fails", async () => {
    const store = new MemoryStore(scratch(), {
      embedder: {
        id: "broken",
        embed: () => Promise.reject(new Error("no network")),
      },
    });
    const seats = store.add({ content: "Prefers aisle seats", bucket: "preference" }, USER);
    expect((await store.search("aisle")).map((entry) => entry.id)).toEqual([seats.id]);
  });
});
