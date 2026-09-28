import { describe, expect, it } from "vitest";
import {
  entityKey,
  findCandidates,
  looksLikeQuestion,
  repository,
  searchQuery,
  sentencesOf,
  siteLabel,
  subjectKind,
} from "../src/entities.js";

const card = (title: string, description = "", creator = ""): string =>
  [`# ${title}`, description, creator ? `Creator: ${creator}` : ""].filter(Boolean).join("\n\n");

const STORY = {
  url: "https://techcrunch.example/2026/09/12/stripe-raises",
  title: "Stripe raises $6.5B at a $50B valuation - TechCrunch",
  blocks: [
    card("Stripe raises $6.5B at a $50B valuation", "The payments company is raising new money from existing investors.", "Mary Ann Azevedo"),
    "Stripe, the payments company run by Patrick Collison and John Collison, said on Wednesday that it raised $6.5 billion.",
    "Founded in 2010, Stripe is a financial infrastructure platform used by millions of businesses. Collison told employees the money would cover taxes on employee shares.",
    "The round was led by Thrive Capital, with participation from Andreessen Horowitz and Y Combinator (YC). YC first backed the company in 2010.",
    "## What it means for Stripe Billing",
    "Stripe Billing now processes subscriptions for companies such as Slack and Notion. Stripe Billing charges 0.5% of recurring revenue.",
    "However, the company did not say when it would go public. Read more about payments.",
    "~~~~\nconst Stripe = require('stripe');\n~~~~",
  ],
};

describe("Watchtower index keys", () => {
  it("spells a name one way however a page wrote it", () => {
    expect(entityKey("Stripe, Inc.")).toBe("stripe");
    expect(entityKey("Stripe’s")).toBe("stripe");
    expect(entityKey("The New York Times")).toBe("new york times");
    expect(entityKey("Crème Brûlée Ltd")).toBe("creme brulee");
    expect(entityKey("U.S.")).toBe("us");
    expect(entityKey("C++")).toBe("c++");
    expect(entityKey("AT&T")).toBe("at&t");
    expect(entityKey("Procter & Gamble")).toBe("procter and gamble");
    // A lone suffix is a name, not nothing.
    expect(entityKey("The")).toBe("the");
  });

  it("splits sentences without breaking at abbreviations", () => {
    expect(sentencesOf("Stripe Inc. said so. The U.S. market grew. Next one")).toEqual([
      "Stripe Inc. said so.",
      "The U.S. market grew.",
      "Next one",
    ]);
  });
});

describe("Watchtower index candidates", () => {
  it("finds the people, companies and products in an article, most central first", () => {
    const { candidates } = findCandidates(STORY);
    const names = candidates.map((candidate) => candidate.name);
    expect(names[0]).toBe("Stripe");
    for (const name of ["Patrick Collison", "John Collison", "Thrive Capital", "Andreessen Horowitz", "Y Combinator", "Stripe Billing", "Slack", "Notion", "Mary Ann Azevedo"])
      expect(names).toContain(name);
    // Sentence starts, interface words, dates and code are not names.
    for (const junk of ["Founded", "However", "Read", "Wednesday", "What", "The", "TechCrunch"])
      expect(names).not.toContain(junk);
    const stripe = candidates.find((candidate) => candidate.key === "stripe")!;
    expect(stripe.salience).toBe(1);
    expect(stripe.kind).toBeNull();
    expect(stripe.context).toMatch(/payments company/u);
    // The page's own abbreviation is an alias, not a second entry.
    const yc = candidates.find((candidate) => candidate.key === "y combinator")!;
    expect(yc.aliases).toContain("YC");
    expect(names).not.toContain("YC");
    // The author the page declares is a candidate without a decided kind.
    expect(candidates.find((candidate) => candidate.name === "Mary Ann Azevedo")?.kind).toBeNull();
  });

  it("folds a surname into the full name the same page used, and not when two people share it", () => {
    const single = findCandidates({
      url: "https://news.example/a",
      title: "An interview",
      blocks: [card("An interview"), "Patrick Collison spoke on Monday. Later, Collison said growth was strong. Collison also said hiring would slow."],
    }).candidates;
    const patrick = single.find((candidate) => candidate.key === "patrick collison")!;
    expect(patrick.aliases).toContain("Collison");
    expect(single.some((candidate) => candidate.key === "collison")).toBe(false);
    // With both brothers named, "Collison" alone is ambiguous: it stays for the model.
    const both = findCandidates(STORY).candidates;
    expect(both.find((candidate) => candidate.key === "patrick collison")?.aliases ?? []).not.toContain("Collison");
  });

  it("reads the subject from a title, not the site that signs it", () => {
    const wiki = findCandidates({
      url: "https://en.wikipedia.example/wiki/Patrick_Collison",
      title: "Patrick Collison - Wikipedia",
      blocks: [card("Patrick Collison - Wikipedia"), "Patrick Collison is an Irish entrepreneur."],
    }).candidates;
    expect(wiki[0]).toMatchObject({ name: "Patrick Collison", salience: 1 });
    expect(wiki.some((candidate) => candidate.key === "wikipedia")).toBe(false);
    const signed = findCandidates({
      url: "https://www.nytimes.example/2026/business/stripe.html",
      title: "Stripe’s Next Move | The New York Times",
      blocks: [card("Stripe’s Next Move"), "Stripe is growing. Analysts expect Stripe to list."],
      siteNames: new Set(["new york times"]),
    }).candidates;
    expect(signed.some((candidate) => candidate.key === "new york times")).toBe(false);
    // Title Case headlines say nothing about which words are names.
    expect(signed.some((candidate) => candidate.key === "next move")).toBe(false);
    expect(signed[0]?.key).toBe("stripe");
    // A site's own home page is about the site.
    const home = findCandidates({ url: "https://stripe.example/", title: "Stripe | Financial Infrastructure to Grow Your Revenue", blocks: [card("Stripe")] }).candidates;
    expect(home[0]).toMatchObject({ key: "stripe", salience: 1 });
  });

  it("takes declared structured data as settled kinds", () => {
    const { candidates } = findCandidates({
      url: "https://shop.example/p/air",
      title: "Air Runner 2",
      blocks: [card("Air Runner 2")],
      subjects: [
        { name: "Air Runner 2", type: "Product" },
        { name: "Acme Shoes", type: "", via: "brand" },
        { name: "Shop Example", type: "Organization", via: "publisher" },
        { name: "Air Runner 2", type: "WebPage" },
      ],
    });
    expect(candidates.find((candidate) => candidate.key === "air runner 2")).toMatchObject({ kind: "product", salience: 1 });
    expect(candidates.find((candidate) => candidate.key === "acme shoes")?.kind).toBe("company");
    // A bare Organization may be a company or a university: left to the model.
    expect(candidates.find((candidate) => candidate.key === "shop example")?.kind).toBeNull();
  });

  it("maps declared types and the properties names were found under", () => {
    expect(subjectKind({ type: "Person" })).toBe("person");
    expect(subjectKind({ type: "https://schema.org/Corporation" })).toBe("company");
    expect(subjectKind({ type: "CollegeOrUniversity" })).toBe("organization");
    expect(subjectKind({ type: "SoftwareApplication" })).toBe("product");
    expect(subjectKind({ type: "MusicEvent" })).toBe("event");
    expect(subjectKind({ type: "Book" })).toBe("work");
    expect(subjectKind({ type: "SoftwareSourceCode" })).toBe("project");
    expect(subjectKind({ type: "City" })).toBe("place");
    expect(subjectKind({ type: "NewsArticle" })).toBeUndefined();
    expect(subjectKind({ type: "", via: "author" })).toBeNull();
    expect(subjectKind({ type: "", via: "location" })).toBe("place");
  });

  it("turns a search into a question, and a repository into a project", () => {
    expect(searchQuery("https://www.google.com/search?q=how+does+stripe+billing+work&hl=en")).toBe("how does stripe billing work");
    expect(searchQuery("https://duckduckgo.com/?q=stripe+vs+adyen")).toBe("stripe vs adyen");
    expect(searchQuery("https://www.youtube.com/results?search_query=lathe+restoration")).toBe("lathe restoration");
    expect(searchQuery("https://www.google.com/maps?q=cafe")).toBeNull();
    const search = findCandidates({
      url: "https://www.google.com/search?q=stripe+vs+adyen+fees",
      title: "stripe vs adyen fees - Google Search",
      blocks: [card("stripe vs adyen fees - Google Search"), "Stripe charges 2.9%. Adyen charges interchange plus."],
    });
    expect(search.candidates).toEqual([expect.objectContaining({ name: "stripe vs adyen fees", kind: "question", search: true })]);
    expect(search.facts).toEqual([]);
    expect(looksLikeQuestion("gmail")).toBe(false);
    expect(looksLikeQuestion("why is the sky blue")).toBe(true);
    expect(findCandidates({ url: "https://www.bing.com/search?q=gmail", title: "gmail", blocks: [] }).candidates[0]?.kind).toBeNull();

    expect(repository("https://github.com/stripe/stripe-node/blob/main/README.md")).toBe("stripe/stripe-node");
    expect(repository("https://github.com/features/actions")).toBeNull();
    expect(repository("https://github.com/stripe")).toBeNull();
    expect(findCandidates({ url: "https://github.com/stripe/stripe-node", title: "GitHub - stripe/stripe-node", blocks: [card("stripe-node")] }).candidates[0]).toMatchObject({
      name: "stripe/stripe-node",
      kind: "project",
      salience: 1,
    });
    expect(siteLabel("www.bbc.co.uk")).toBe("bbc");
    expect(siteLabel("en.wikipedia.org")).toBe("wikipedia");
  });

  it("offers sentences that say what something is, a number or a date — verbatim", () => {
    const { candidates, facts } = findCandidates(STORY);
    const about = (text: RegExp) => {
      const fact = facts.find((item) => text.test(item.text));
      return fact === undefined ? undefined : candidates[fact.candidate]?.name;
    };
    expect(about(/is a financial infrastructure platform/u)).toBe("Stripe");
    expect(about(/0\.5% of recurring revenue/u)).toBe("Stripe Billing");
    for (const fact of facts) expect(STORY.blocks.join("\n")).toContain(fact.text);
    expect(facts.length).toBeLessThanOrEqual(8);
  });

  it("is deterministic and bounded on a page of nothing but capitals", () => {
    const noise = Array.from({ length: 400 }, (_, i) => `Alpha${i} Beta${i} met Gamma${i} Delta${i} in Epsilon${i}.`);
    const input = { url: "https://noise.example/x", title: "Noise", blocks: [card("Noise"), ...noise] };
    const first = findCandidates(input);
    expect(first.candidates.length).toBeLessThanOrEqual(24);
    expect(findCandidates(input)).toEqual(first);
  });
});
