import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  WatchtowerCapture,
  WatchtowerEntityDecision,
  WatchtowerIndexJob,
  WatchtowerVisit,
} from "@pistachio/agent-runtime/watchtower";
import { Archive } from "../src/archive.js";

let n = 0;
const save = (
  archive: Archive,
  url: string,
  title: string,
  blocks: string[],
  options: { at?: number; spaceId?: string; subjects?: WatchtowerCapture["subjects"] } = {},
): WatchtowerVisit => {
  const at = options.at ?? 1000 + ++n;
  const visit = { id: `v${++n}`, spaceId: options.spaceId ?? "personal", url, title, at };
  archive.visit(visit);
  archive.ingest(visit, `${visit.id}:o`, at + 1, {
    url,
    title,
    description: "",
    creator: "",
    kind: "article",
    blocks,
    links: [],
    truncated: false,
    subjects: options.subjects,
  });
  return visit;
};
const observation = (visit: WatchtowerVisit): string => `${visit.id}:o`;

/** Stands in for Jev: a kind per name, a known entry per name, a kind per sentence. */
function judge(
  job: WatchtowerIndexJob,
  kinds: Record<string, WatchtowerEntityDecision["kind"]>,
  same: Record<string, string> = {},
  facts: Record<string, string> = {},
): { decisions: WatchtowerEntityDecision[]; facts: (string | null)[] } {
  return {
    decisions: job.candidates.map((candidate) => ({
      kind: candidate.kind ?? kinds[candidate.name] ?? null,
      same: candidate.known.find((known) => known.name === same[candidate.name])?.id ?? null,
    })),
    facts: job.facts.map((fact) => Object.entries(facts).find(([text]) => fact.text.includes(text))?.[1] ?? null),
  };
}
const run = (archive: Archive, ...args: Parameters<typeof judge> extends [unknown, ...infer R] ? R : never) => {
  const job = archive.index.next();
  expect(job).not.toBeNull();
  const answers = judge(job!, ...args);
  expect(archive.index.apply(job!, answers.decisions, answers.facts as never, 2)).toBe(true);
  return job!;
};

const TECHCRUNCH = [
  "Stripe, the payments company run by Patrick Collison, said on Wednesday that it raised $6.5 billion from Thrive Capital.",
  "Founded in 2010, Stripe is a financial infrastructure platform used by millions of businesses.",
  "Stripe Billing charges 0.5% of recurring revenue.",
];
const WIKIPEDIA = [
  "Stripe, Inc. is an Irish-American multinational financial services company.",
  "Stripe was founded by Patrick Collison and his brother John Collison in 2010.",
  "Stripe's headquarters are in South San Francisco and Dublin.",
];
const KINDS = {
  Stripe: "company",
  "Patrick Collison": "person",
  "John Collison": "person",
  "Thrive Capital": "company",
  "Stripe Billing": "product",
  Dublin: "place",
  "South San Francisco": "place",
} as const;

describe("Watchtower index", () => {
  it("files what a page declares at capture, with no model", () => {
    const archive = new Archive(":memory:");
    try {
      const visit = save(archive, "https://shop.example/p/air-runner", "Air Runner 2 | Shop", ["Lightweight trainers."], {
        subjects: [
          { name: "Air Runner 2", type: "Product" },
          { name: "Acme Shoes", type: "", via: "brand" },
          { name: "Shop", type: "Organization", via: "publisher" },
        ],
      });
      const index = archive.index.list("personal", {});
      expect(index.entities.map((entity) => [entity.name, entity.kind])).toEqual([
        ["Air Runner 2", "product"],
        ["Acme Shoes", "company"],
      ]);
      expect(index.counts).toEqual({ product: 1, company: 1 });
      // Local indexing is a first pass: the model has not read the page yet.
      expect(index.pending).toBe(1);
      expect(archive.read("personal", observation(visit)).entities.map((entity) => entity.name)).toEqual(["Air Runner 2", "Acme Shoes"]);
    } finally {
      archive.close();
    }
  });

  it("recognizes one company across sites, keeps facts verbatim with their source, and links co-mentioned entries", () => {
    const archive = new Archive(":memory:");
    try {
      const story = save(archive, "https://techcrunch.example/2026/stripe-raises", "Stripe raises $6.5B - TechCrunch", TECHCRUNCH);
      // Newest first: the Wikipedia visit is judged before the story.
      const wiki = save(archive, "https://en.wikipedia.example/wiki/Stripe,_Inc.", "Stripe, Inc. - Wikipedia", WIKIPEDIA);
      const first = run(archive, KINDS);
      expect(first.snapshotId).toBe(archive.read("personal", observation(wiki)).snapshotId);
      const second = archive.index.next()!;
      // What the index knows about "Stripe" is offered to the model, described.
      const stripe = second.candidates.find((candidate) => candidate.name === "Stripe")!;
      expect(stripe.known[0]).toMatchObject({ name: "Stripe", kind: "company", sites: ["en.wikipedia.example"] });
      // Spellings are kept per normalized key: "Stripe, Inc." is "Stripe".
      expect(stripe.known[0]!.aliases).toEqual(["Stripe"]);
      const answers = judge(second, KINDS, { Stripe: "Stripe" }, {
        "financial infrastructure platform": "definition",
        "0.5% of recurring revenue": "price",
        "raised $6.5 billion": "event",
      });
      archive.index.apply(second, answers.decisions, answers.facts as never, 2);
      expect(archive.index.next()).toBeNull();
      expect(archive.index.pending("personal")).toBe(0);

      const index = archive.index.list("personal", {});
      const company = index.entities.find((entity) => entity.name === "Stripe")!;
      expect(company).toMatchObject({ kind: "company", pageCount: 2, siteCount: 2, factCount: 2 });
      expect(index.entities[0]!.name).toBe("Stripe");
      expect(index.counts).toMatchObject({ company: 2, person: 2, product: 1, place: 2 });
      // Patrick Collison, named on both pages, is one person.
      expect(index.entities.filter((entity) => entity.name === "Patrick Collison")).toHaveLength(1);

      const document = archive.index.read("personal", company.id);
      expect(document.facts.map((fact) => [fact.kind, fact.text])).toEqual([
        ["definition", "Founded in 2010, Stripe is a financial infrastructure platform used by millions of businesses."],
        ["event", "Stripe, the payments company run by Patrick Collison, said on Wednesday that it raised $6.5 billion from Thrive Capital."],
      ]);
      expect(document.facts[0]!.source.observationId).toBe(observation(story));
      expect(document.mentions.map((mention) => mention.source.observationId).sort()).toEqual([observation(story), observation(wiki)].sort());
      expect(document.sites.map((site) => site.host).sort()).toEqual(["en.wikipedia.example", "techcrunch.example"]);
      expect(document.related.map((entity) => entity.name)).toContain("Patrick Collison");
      // The price belongs to the product, not the company.
      const billing = index.entities.find((entity) => entity.name === "Stripe Billing")!;
      expect(archive.index.read("personal", billing.id).facts.map((fact) => fact.kind)).toEqual(["price"]);

      expect(archive.index.list("personal", { query: "coll" }).entities.map((entity) => entity.name)).toEqual(expect.arrayContaining(["Patrick Collison", "John Collison"]));
      expect(archive.index.list("personal", { kind: "place" }).entities.map((entity) => entity.name).sort()).toEqual(["Dublin", "South San Francisco"]);
      expect(() => archive.index.read("work", company.id)).toThrow(/another Space/u);
      expect(archive.index.list("work", {}).entities).toEqual([]);
    } finally {
      archive.close();
    }
  });

  it("never merges on doubt: an unmatched name of the same kind and spelling still joins, a different kind does not", () => {
    const archive = new Archive(":memory:");
    try {
      save(archive, "https://a.example/1", "One", ["Mercury is the closest planet to the Sun. Astronomers say Mercury has no moons."]);
      run(archive, { Mercury: "place", Sun: "place" });
      save(archive, "https://b.example/2", "Two", ["Mercury Bank offers accounts to startups. Founders say Mercury raised money."]);
      // The model says a company, and matches no known entry: a second, separate Mercury.
      run(archive, { Mercury: "company", "Mercury Bank": "company" });
      const mercuries = archive.index.list("personal", { query: "mercury" }).entities;
      expect(mercuries.filter((entity) => entity.name === "Mercury").map((entity) => entity.kind).sort()).toEqual(["company", "place"]);
      save(archive, "https://c.example/3", "Three", ["Mercury is hot during the day. Probes found Mercury is small."]);
      // Same spelling, same kind: the same entry, even without a confirmed match.
      run(archive, { Mercury: "place" });
      const planet = archive.index.list("personal", { kind: "place", query: "mercury" }).entities[0]!;
      expect(planet.pageCount).toBe(2);
    } finally {
      archive.close();
    }
  });

  it("forgets what it learned with the pages it learned it from", () => {
    const archive = new Archive(":memory:");
    try {
      const story = save(archive, "https://techcrunch.example/2026/stripe-raises", "Stripe raises $6.5B - TechCrunch", TECHCRUNCH, { at: 1000 });
      save(archive, "https://en.wikipedia.example/wiki/Stripe,_Inc.", "Stripe, Inc. - Wikipedia", WIKIPEDIA, { at: 5000 });
      run(archive, KINDS);
      run(archive, KINDS, { Stripe: "Stripe", "Patrick Collison": "Patrick Collison" });
      expect(archive.index.list("personal", {}).entities.find((entity) => entity.name === "Thrive Capital")).toBeDefined();
      archive.forget("personal", { pageId: archive.read("personal", observation(story)).pageId });
      const left = archive.index.list("personal", {}).entities;
      // Only the forgotten page named Thrive Capital and Stripe Billing.
      expect(left.map((entity) => entity.name)).not.toContain("Thrive Capital");
      expect(left.map((entity) => entity.name)).not.toContain("Stripe Billing");
      expect(left.find((entity) => entity.name === "Stripe")).toMatchObject({ pageCount: 1, factCount: 0 });
      expect(archive.get<{ n: number }>("SELECT count(*) n FROM fact")?.n).toBe(0);
      // Retention takes saved text, and with it what was learned from it.
      archive.prune(1, 5000 + 2 * 86400000);
      expect(archive.index.list("personal", {}).entities).toEqual([]);
      expect(archive.get<{ n: number }>("SELECT count(*) n FROM entity_alias")?.n).toBe(0);
    } finally {
      archive.close();
    }
  });

  it("merges, corrects and removes entries by hand; a removed name stays out", () => {
    const archive = new Archive(":memory:");
    try {
      save(archive, "https://a.example/1", "One", ["Collison spoke at the event. Later, Collison said growth was strong."]);
      run(archive, { Collison: "person" });
      save(archive, "https://b.example/2", "Two", ["Patrick Collison founded a company. Patrick Collison lives in California."]);
      run(archive, { "Patrick Collison": "person", California: "place" });
      const index = archive.index.list("personal", { kind: "person" }).entities;
      const surname = index.find((entity) => entity.name === "Collison")!;
      const full = index.find((entity) => entity.name === "Patrick Collison")!;
      // Offered, not done: one name inside the other, same kind.
      expect(archive.index.read("personal", surname.id).similar.map((entity) => entity.id)).toEqual([full.id]);
      expect(archive.index.edit("personal", { entityId: surname.id, merge: full.id })).toBe(full.id);
      const merged = archive.index.read("personal", full.id);
      expect(merged).toMatchObject({ pageCount: 2 });
      expect(merged.aliases).toEqual(expect.arrayContaining(["Patrick Collison", "Collison"]));
      expect(() => archive.index.read("personal", surname.id)).toThrow();

      const place = archive.index.list("personal", { kind: "place" }).entities[0]!;
      archive.index.edit("personal", { entityId: place.id, kind: "organization" });
      expect(archive.index.read("personal", place.id).kind).toBe("organization");

      archive.index.edit("personal", { entityId: place.id, remove: true });
      save(archive, "https://c.example/3", "Three", ["California passed a law. Residents say California is large."]);
      const job = archive.index.next();
      expect(job?.candidates.map((candidate) => candidate.name) ?? []).not.toContain("California");
      expect(archive.index.list("personal", {}).entities.map((entity) => entity.name)).not.toContain("California");
      expect(() => archive.index.edit("work", { entityId: full.id, remove: true })).toThrow();
    } finally {
      archive.close();
    }
  });

  it("never offers an excluded site or Space to the model", () => {
    const archive = new Archive(":memory:");
    try {
      save(archive, "https://mail.example/inbox", "Inbox", ["Patrick Collison wrote to you about Stripe."]);
      save(archive, "https://news.example/a", "News", ["Patrick Collison wrote about Stripe."], { spaceId: "work" });
      archive.configure({ excludedHosts: ["mail.example"], excludedSpaces: ["work"] });
      expect(archive.index.next()).toBeNull();
      archive.configure({ excludedHosts: [], excludedSpaces: [] });
      expect(archive.index.next()).not.toBeNull();
    } finally {
      archive.close();
    }
  });

  it("upgrades a version 3 archive in place and indexes its history in the background", () => {
    const directory = mkdtempSync(join(tmpdir(), "watchtower-index-"));
    const path = join(directory, "watchtower.db");
    try {
      const before = new Archive(path);
      save(before, "https://shop.example/p/1", "Air Runner 2", ["Trainers."], { subjects: [{ name: "Air Runner 2", type: "Product" }] });
      // Back to version 3: no index tables, no index columns.
      before.db.exec(`
        DROP TABLE fact; DROP TABLE mention; DROP TABLE entity_alias; DROP TABLE entity_ignore; DROP TABLE entity;
        DROP INDEX snapshot_understood; ALTER TABLE snapshot DROP COLUMN understood; ALTER TABLE snapshot DROP COLUMN subjects;
        PRAGMA user_version=3;
      `);
      before.close();
      const after = new Archive(path);
      try {
        expect(after.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(4);
        expect(after.index.list("personal", {}).entities).toEqual([]);
        expect(after.index.backlog()).toBe(1);
        expect(after.index.backlog()).toBe(0);
        // Structured data was not kept before version 4; the model reads the rest.
        expect(after.index.pending("personal")).toBe(1);
      } finally {
        after.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("exports the index as wiki pages linked to the saved versions", () => {
    const directory = mkdtempSync(join(tmpdir(), "watchtower-index-export-"));
    const archive = new Archive(":memory:");
    try {
      save(archive, "https://techcrunch.example/2026/stripe-raises", "Stripe raises $6.5B - TechCrunch", TECHCRUNCH);
      run(archive, KINDS, {}, { "financial infrastructure platform": "definition" });
      const out = archive.export("personal", join(directory, "out"));
      const files = readdirSync(out);
      const stripe = archive.index.list("personal", { query: "stripe", kind: "company" }).entities[0]!;
      expect(files).toContain(`entity-${stripe.id}.md`);
      const page = readFileSync(join(out, `entity-${stripe.id}.md`), "utf8");
      expect(page).toMatch(/^---\nkind: company\nname: "Stripe"/u);
      expect(page).toContain("**What it is.** “Founded in 2010, Stripe is a financial infrastructure platform");
      expect(page).toMatch(/\[Stripe raises \$6\.5B - TechCrunch\]\(snapshot-\d+\.md\)/u);
      const index = readFileSync(join(out, "index.md"), "utf8");
      expect(index).toContain("### Companies (2)");
      expect(index).toContain(`- [Stripe](entity-${stripe.id}.md) · 1 page`);
      const snapshot = files.find((file) => file.startsWith("snapshot-"))!;
      expect(readFileSync(join(out, snapshot), "utf8")).toContain(`## About\n\n- [Stripe](entity-${stripe.id}.md) · Company`);
    } finally {
      archive.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps a page saved on purpose, files what the model read on it, and never lets a later pass replace that", () => {
    const archive = new Archive(":memory:");
    try {
      // Watchtower was never switched on: a save still keeps its page.
      expect(archive.settings().enabled).toBe(false);
      const visit = { id: "saved-visit", spaceId: "personal", url: "https://profiles.example/patrick-collison", title: "Patrick Collison | Profiles", at: 5000 };
      const kept = archive.keep(visit, "saved-visit:o", 5001, {
        url: visit.url,
        title: visit.title,
        description: "",
        creator: "",
        kind: "page",
        blocks: ["Patrick Collison is the CEO of Stripe.", "Stripe processed $1.4 trillion in 2024, up 38% from the year before.", "He lives in San Francisco."],
        links: [],
        truncated: false,
      }, "profiles.example/patrick-collison")!;
      expect(kept).toMatchObject({ observationId: "saved-visit:o" });
      expect(archive.search("personal", "trillion")[0]).toMatchObject({ observationId: "saved-visit:o", kept: 1 });

      // An earlier pass found San Francisco; the save's reading adds, it does not replace.
      const passive = archive.index.next()!;
      const answers = judge(passive, { "San Francisco": "place", "Patrick Collison": "person", Stripe: "company" });
      archive.index.apply(passive, answers.decisions, answers.facts as never, 2);
      const prepared = archive.index.prepareSaved(kept.snapshotId, [
        { kind: "person", name: "Patrick Collison", aliases: ["Collison"], role: "subject", facts: [{ kind: "definition", text: "Patrick Collison is the CEO of Stripe." }], context: "Patrick Collison is the CEO of Stripe." },
        { kind: "company", name: "Stripe", aliases: [], role: "major", facts: [{ kind: "metric", text: "Stripe processed $1.4 trillion in 2024, up 38% from the year before." }], context: "Patrick Collison is the CEO of Stripe." },
      ], { observationId: kept.observationId, spaceId: "personal" })!;
      // Both names are already entries of their kind: nothing to ask.
      expect(prepared.job.candidates.map((candidate) => candidate.known)).toEqual([[], []]);
      expect(prepared.factKinds).toEqual(["definition", "metric"]);
      archive.index.apply(prepared.job, prepared.job.candidates.map((candidate) => ({ kind: candidate.kind, same: null })), prepared.factKinds, 3, { merge: true });
      const about = archive.about("personal", "https://profiles.example/patrick-collison")!;
      expect(about.observationId).toBe("saved-visit:o");
      expect(about.entities.map((entity) => entity.name)).toEqual(["Patrick Collison", "Stripe", "San Francisco"]);
      const stripe = archive.index.list("personal", { kind: "company" }).entities[0]!;
      expect(archive.index.read("personal", stripe.id).facts.map((fact) => fact.kind)).toEqual(["metric"]);
      // Filing twice adds nothing twice.
      archive.index.apply(prepared.job, prepared.job.candidates.map((candidate) => ({ kind: candidate.kind, same: null })), prepared.factKinds, 3, { merge: true });
      expect(archive.index.read("personal", stripe.id).facts).toHaveLength(1);
      // The Jev pass never takes the saved version back.
      expect(archive.index.next()).toBeNull();
      expect(archive.index.pending("personal")).toBe(0);
    } finally {
      archive.close();
    }
  });

  it("keeps a saved page's text past retention until the save is deleted", () => {
    const archive = new Archive(":memory:");
    try {
      const saved = { id: "saved", spaceId: "personal", url: "https://kept.example/a", title: "Kept", at: 1000 };
      archive.keep(saved, "saved:o", 1001, { url: saved.url, title: "Kept", description: "", creator: "", kind: "article", blocks: ["Keepsake paragraphs remain."], links: [], truncated: false }, "kept.example/a");
      save(archive, "https://plain.example/b", "Plain", ["Ephemeral paragraphs vanish."], { at: 1000 });
      archive.prune(1, 1000 + 3 * 86400000);
      // An expired visit keeps its title; its text is what goes.
      expect(archive.search("personal", "keepsake")).toHaveLength(1);
      expect(archive.search("personal", "ephemeral")).toHaveLength(0);
      // Still saved (its record's key is listed): kept.
      archive.setKept(["kept.example/a"]);
      archive.prune(1, 1000 + 4 * 86400000);
      expect(archive.search("personal", "keepsake")).toHaveLength(1);
      // The save was deleted, here or on another device: the page ages.
      archive.setKept([]);
      archive.prune(1, 1000 + 5 * 86400000);
      expect(archive.search("personal", "keepsake")).toHaveLength(0);
    } finally {
      archive.close();
    }
  });

  describe("a deliberate save's filing is bound to what it kept", () => {
    const text = (url: string, blocks: string[], title = "Saved"): WatchtowerCapture => ({ url, title, description: "", creator: "", kind: "article", blocks, links: [], truncated: false });
    const person = { kind: "person" as const, name: "Forgotten Person", aliases: [], role: "subject" as const, facts: [], context: "" };

    it("files nothing when the kept page was forgotten and its version's id went to another Space's page", () => {
      const archive = new Archive(":memory:");
      try {
        const a = { id: "a", spaceId: "personal", url: "https://a.example/x", title: "A", at: 1 };
        const kept = archive.keep(a, "a:o", 2, text(a.url, ["Alpha text."]), "a.example/x")!;
        archive.forget("personal", { pageId: kept.pageId });
        const b = { id: "b", spaceId: "work", url: "https://b.example/y", title: "B", at: 3 };
        archive.visit(b);
        archive.ingest(b, "b:o", 4, text(b.url, ["Beta text."]));
        // SQLite hands the forgotten version's id to the next one saved.
        expect(archive.read("work", "b:o").snapshotId).toBe(kept.snapshotId);
        expect(archive.index.prepareSaved(kept.snapshotId, [person], { observationId: kept.observationId, spaceId: "personal" })).toBeNull();
        // Prepared before the forget, applied after: still refused.
        const c = { id: "c", spaceId: "personal", url: "https://c.example/z", title: "C", at: 5 };
        const again = archive.keep(c, "c:o", 6, text(c.url, ["Gamma text."]), "c.example/z")!;
        const prepared = archive.index.prepareSaved(again.snapshotId, [person], { observationId: again.observationId, spaceId: "personal" })!;
        archive.forget("personal", { pageId: again.pageId });
        const d = { id: "d", spaceId: "personal", url: "https://d.example/w", title: "D", at: 7 };
        archive.visit(d);
        archive.ingest(d, "d:o", 8, text(d.url, ["Delta text."]));
        expect(archive.read("personal", "d:o").snapshotId).toBe(again.snapshotId);
        expect(archive.index.apply(prepared.job, [{ kind: "person", same: null }], [], 3, { merge: true })).toBe(false);
        expect(archive.index.list("personal", {}).entities.map((entity) => entity.name)).not.toContain("Forgotten Person");
        expect(archive.index.list("work", {}).entities.map((entity) => entity.name)).not.toContain("Forgotten Person");
      } finally {
        archive.close();
      }
    });

    it("refuses a passive reading that finishes after a deliberate save, keeping the save's entries", () => {
      const archive = new Archive(":memory:");
      try {
        const visit = { id: "v", spaceId: "personal", url: "https://profiles.example/ada", title: "Ada Okafor", at: 1 };
        const kept = archive.keep(visit, "v:o", 2, text(visit.url, ["Ada Okafor runs Lumen Grid. Later, Okafor said Lumen Grid would grow."], "Ada Okafor"), "profiles.example/ada")!;
        // The Jev pass takes the version, and is still asking when the save lands.
        const passive = archive.index.next()!;
        expect(passive.snapshotId).toBe(kept.snapshotId);
        const prepared = archive.index.prepareSaved(kept.snapshotId, [{ ...person, name: "Ada Okafor", facts: [{ kind: "definition", text: "Ada Okafor runs Lumen Grid." }] }], { observationId: kept.observationId, spaceId: "personal" })!;
        expect(archive.index.apply(prepared.job, [{ kind: "person", same: null }], prepared.factKinds, 3, { merge: true })).toBe(true);
        expect(archive.index.apply(passive, passive.candidates.map(() => ({ kind: "concept", same: null })), [], 2)).toBe(false);
        const ada = archive.index.list("personal", { kind: "person" }).entities.find((entity) => entity.name === "Ada Okafor")!;
        expect(archive.index.read("personal", ada.id).facts.map((fact) => fact.text)).toEqual(["Ada Okafor runs Lumen Grid."]);
        expect(archive.index.list("personal", { kind: "concept" }).entities).toEqual([]);
      } finally {
        archive.close();
      }
    });

    it("keeps the current text of a page saved after the visit's passive captures ran out, and reports a save that failed", () => {
      const archive = new Archive(":memory:");
      try {
        const visit = { id: "feed", spaceId: "personal", url: "https://feed.example/", title: "Feed", at: 1 };
        archive.visit(visit);
        for (let n = 1; n <= 12; n++) archive.ingest(visit, `feed:${n}`, 1 + n, text(visit.url, [`Version ${n} of the feed.`]));
        const kept = archive.keep(visit, "feed:kept", 100, text(visit.url, ["The thirteenth version worth keeping."]), "feed.example")!;
        expect(kept.observationId).toBe("feed:kept");
        expect(archive.read("personal", kept.observationId).markdown).toContain("thirteenth version worth keeping");
        expect(archive.search("personal", "thirteenth")[0]?.observationId).toBe("feed:kept");
        // Unchanged content is still a save: of the version already there.
        expect(archive.keep(visit, "feed:again", 101, text(visit.url, ["The thirteenth version worth keeping."]), "feed.example")?.observationId).toBe("feed:kept");
        // Too large to save: a failure, not the previous version passed off as this one.
        expect(archive.keep(visit, "feed:huge", 102, text(visit.url, ["x".repeat(300 * 1024)]), "feed.example")).toBeNull();
      } finally {
        archive.close();
      }
    });

    it("reaches an eligible page behind thousands of excluded ones", () => {
      const archive = new Archive(":memory:");
      try {
        save(archive, "https://eligible.example/a", "Eligible", ["Grace Hopper wrote about COBOL. Later, Hopper taught at Vassar College."]);
        // Many newer versions, all of an excluded site, still waiting for the model.
        archive.run("INSERT INTO page(space_id,url,host) VALUES('personal','https://mail.example/inbox','mail.example')");
        const page = archive.get<{ id: number }>("SELECT id FROM page WHERE host='mail.example'")!.id;
        archive.transaction(() => {
          for (let n = 0; n < 2050; n++)
            archive.run("INSERT INTO snapshot(page_id,digest,title,kind,links,understood) VALUES(?,?,?,?,?,1)", page, Buffer.from(String(n).padStart(32, "0")), `Mail ${n}`, "page", Buffer.alloc(0));
        });
        archive.configure({ excludedHosts: ["mail.example"] });
        const job = archive.index.next();
        expect(job?.host).toBe("eligible.example");
        // An excluded site is not "waiting": it will never be read.
        expect(archive.index.pending("personal")).toBe(1);
      } finally {
        archive.close();
      }
    });
  });
});

