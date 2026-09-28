/**
 * Live check of a deliberate save's reading: the agent's real model through
 * the real gateway, on a page shaped like a profile — one page about a
 * person AND the company they run. Skipped unless PISTACHIO_WATCHTOWER_LIVE=1
 * and the workspace has a gateway key in `.env`. It sends only the synthetic
 * text below.
 *
 * What it guards is the prompt and schema in `bookmark-extractor.ts`: that
 * the model names every entity the page is about, and that the facts it
 * returns survive the check that they are the page's own sentences.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createGateway } from "ai";
import { describe, expect, it } from "vitest";
import type { PageSnapshot } from "@pistachio/shell-contracts/bookmarks";
import { extractBookmark } from "../src/main/bookmark-extractor";

const envPath = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")].find((path) => existsSync(path));
const live = process.env["PISTACHIO_WATCHTOWER_LIVE"] === "1";
if (envPath !== undefined && live) process.loadEnvFile(envPath);
const key = process.env["AI_GATEWAY_API_KEY"];

const TEXT = [
  "Ada Okafor is the co-founder and chief executive of Lumen Grid, a company that builds battery storage for rural power networks.",
  "Before Lumen Grid, Okafor spent six years as an engineer at Siemens Energy in Munich.",
  "She founded the company in Lagos in 2019 with Tunde Bello, who serves as its chief technology officer.",
  "Lumen Grid raised $40 million in a Series B round led by Breakthrough Energy Ventures in March 2026.",
  "The company's flagship product, the GridCell 2, stores 250 kilowatt-hours and costs $38,000 per unit.",
  "Lumen Grid says its systems now power more than 1,200 villages across Nigeria and Kenya.",
  "Okafor believes that distributed storage will be cheaper than extending national grids within five years.",
  "Share this profile · Follow · Related: 10 founders to watch",
].join(" ");

describe.skipIf(!live || key === undefined)("a deliberate save's reading (live model)", () => {
  it("names the person, the company and the rest of what the page covers, with facts the page states", { timeout: 120000 }, async () => {
    const page: PageSnapshot = {
      url: "https://founders.example/profiles/ada-okafor",
      title: "Ada Okafor, Lumen Grid | Founder Profiles",
      lang: "en",
      meta: [{ name: "og:site_name", content: "Founder Profiles" }, { name: "og:type", content: "profile" }],
      links: [],
      jsonLd: [],
      headline: "Ada Okafor",
      images: [],
      text: TEXT,
    };
    const model = createGateway({ apiKey: key }).languageModel(process.env["PISTACHIO_AGENT_MODEL"] ?? "openai/gpt-5.6-terra");
    const started = Date.now();
    const result = await extractBookmark(page, { model, env: {} });
    console.log(`latency ${Date.now() - started} ms; card: ${result.fields.kind} “${result.fields.title}”`);
    console.table((result.entities ?? []).map((entity) => ({ role: entity.role, kind: entity.kind, name: entity.name, aliases: entity.aliases.join(", "), facts: entity.facts.map((fact) => `${fact.kind}: ${fact.text.slice(0, 50)}`).join(" | ") })));
    expect(result.provenance).toBe("model");
    const entities = result.entities ?? [];
    const named = (kind: string, pattern: RegExp) => entities.find((entity) => entity.kind === kind && pattern.test(entity.name));
    const person = named("person", /Ada Okafor/u);
    const company = named("company", /Lumen Grid/u);
    expect(person?.role).toBe("subject");
    expect(company).toBeDefined();
    expect(named("person", /Tunde Bello/u)).toBeDefined();
    expect(entities.some((entity) => /GridCell 2/u.test(entity.name))).toBe(true);
    // Every kept fact is a sentence of the page; the page's own claims are there.
    for (const entity of entities) for (const fact of entity.facts) expect(TEXT).toContain(fact.text);
    expect([...(person?.facts ?? []), ...(company?.facts ?? [])].length).toBeGreaterThanOrEqual(2);
    // The site that published the profile, and its chrome, are not what it is about.
    expect(entities.some((entity) => /Founder Profiles/u.test(entity.name))).toBe(false);
  });
});
