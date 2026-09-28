/**
 * Live check of Watchtower's index judge: the real Jev through the real
 * gateway, on names shaped like the ones `watchtower/entities.ts` finds in
 * real pages. Skipped unless PISTACHIO_WATCHTOWER_LIVE=1 and the workspace
 * has a gateway key in `.env`. It costs a fraction of a cent and sends only
 * the synthetic text below.
 *
 * What it guards is the WORDING of the criteria in `watchtower-entities.ts`:
 * the model reads only those descriptions, so a careless edit there shows
 * up here as a founder called a company, a menu label kept as a name, or
 * two different people merged into one.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createGateway } from "ai";
import { describe, expect, it } from "vitest";
import type { WatchtowerIndexCandidate, WatchtowerIndexJob } from "../src/views/watchtower.js";
import { judgeIndex } from "../src/watchtower-entities.js";

const envPath = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")].find((path) => existsSync(path));
const live = process.env["PISTACHIO_WATCHTOWER_LIVE"] === "1";
if (envPath !== undefined && live) process.loadEnvFile(envPath);
const key = process.env["AI_GATEWAY_API_KEY"];

const name = (value: string, context: string, extra: Partial<WatchtowerIndexCandidate> = {}): WatchtowerIndexCandidate => ({
  name: value,
  key: value.toLowerCase(),
  kind: null,
  aliases: [],
  count: 1,
  salience: 0.5,
  context,
  known: [],
  ...extra,
});

describe.skipIf(!live || key === undefined)("Watchtower index judge (live Jev)", () => {
  it("sorts the names of a funding story, matches known entries, and reads its facts", { timeout: 30000 }, async () => {
    const job: Pick<WatchtowerIndexJob, "candidates" | "facts"> = {
      candidates: [
        name("Stripe", "Stripe, the payments company run by Patrick Collison and John Collison, said on Wednesday that it raised $6.5 billion.", {
          known: [
            { id: 11, kind: "company", name: "Stripe", aliases: ["Stripe", "Stripe, Inc."], sites: ["stripe.com", "wikipedia.org"], context: "Stripe is an Irish-American multinational financial services and SaaS company." },
            { id: 12, kind: "company", name: "Stripe Press", aliases: [], sites: ["press.stripe.com"], context: "Stripe Press publishes books about technological progress." },
          ],
        }),
        name("Patrick Collison", "Stripe, the payments company run by Patrick Collison and John Collison, said on Wednesday that it raised $6.5 billion."),
        name("Collison", "Collison told employees the money would cover taxes on employee shares.", {
          known: [
            { id: 21, kind: "person", name: "Patrick Collison", aliases: [], sites: ["stripe.com"], context: "Patrick Collison is the CEO of Stripe." },
            { id: 22, kind: "person", name: "Jane Collison", aliases: [], sites: ["gardening.example"], context: "Jane Collison grows heirloom tomatoes in Devon." },
          ],
        }),
        name("Thrive Capital", "The round was led by Thrive Capital, with participation from Andreessen Horowitz and Y Combinator."),
        name("Stripe Billing", "Stripe Billing now processes subscriptions for companies such as Slack and Notion."),
        name("Kubernetes", "The platform migrated its batch jobs to Kubernetes last year to cut costs."),
        name("Dublin", "The company was founded in Dublin before moving to San Francisco."),
        name("Getting Started", "Getting Started"),
        name("Read More", "Read More"),
        name("Series I", "The Series I round values the company at $50 billion."),
        name("Stablecoins", "Collison said stablecoins would reshape cross-border payments within a decade."),
      ],
      facts: [
        { candidate: 0, text: "Founded in 2010, Stripe is a financial infrastructure platform used by millions of businesses." },
        { candidate: 4, text: "Stripe Billing charges 0.5% of recurring revenue on the starter plan." },
        { candidate: 0, text: "Stripe said on Wednesday that it raised $6.5 billion at a $50 billion valuation." },
        { candidate: 0, text: "Share this article on Stripe and more on Twitter, Facebook and LinkedIn." },
      ],
    };
    const started = Date.now();
    const answers = await judgeIndex(
      { host: "techcrunch.com", title: "Stripe raises $6.5B at a $50B valuation" },
      job,
      { model: createGateway({ apiKey: key }).evaluationModel(process.env["PISTACHIO_INTENT_MODEL"] ?? "typesafe-ai/jev") },
    );
    console.table(job.candidates.map((candidate, i) => ({ name: candidate.name, kind: answers.entities[i]!.kind ?? "(none)", same: answers.entities[i]!.same ?? "" })));
    console.table(job.facts.map((fact, i) => ({ fact: fact.text.slice(0, 60), kind: answers.facts[i] ?? "(none)" })));
    console.log(`latency ${Date.now() - started} ms`);
    const kind = (i: number) => answers.entities[i]!.kind;
    expect(kind(0)).toBe("company");
    expect(answers.entities[0]!.same).toBe(11);
    expect(kind(1)).toBe("person");
    // "Collison" on a Stripe story is Patrick, not the gardener — or, unsure, a new entry: never Jane.
    expect(answers.entities[2]!.same).not.toBe(22);
    expect(["company", "organization"]).toContain(kind(3));
    expect(kind(4)).toBe("product");
    expect(kind(5)).toBe("technology");
    expect(kind(6)).toBe("place");
    expect(kind(7)).toBeNull();
    expect(kind(8)).toBeNull();
    expect(answers.facts[0]).toBe("definition");
    expect(answers.facts[1]).toBe("price");
    expect(["metric", "event"]).toContain(answers.facts[2]);
    expect(answers.facts[3]).toBeNull();
  });

  it("tells an investigation from a way to a site, one search per results page", { timeout: 30000 }, async () => {
    const model = createGateway({ apiKey: key }).evaluationModel(process.env["PISTACHIO_INTENT_MODEL"] ?? "typesafe-ai/jev");
    const judged = await Promise.all(
      ["stripe vs adyen fees", "how to restore a lathe", "patrick collison", "gmail", "facebook login", "nytimes"].map(async (query) => {
        const answers = await judgeIndex({ host: "google.com", title: `${query} - Google Search` }, { candidates: [name(query, query, { search: true })], facts: [] }, { model });
        return [query, answers.entities[0]!.kind] as const;
      }),
    );
    console.table(judged);
    expect(Object.fromEntries(judged)).toEqual({
      "stripe vs adyen fees": "question",
      "how to restore a lathe": "question",
      "patrick collison": "question",
      gmail: null,
      "facebook login": null,
      nytimes: null,
    });
  });
});
