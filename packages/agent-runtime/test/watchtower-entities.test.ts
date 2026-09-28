import { describe, expect, it } from "vitest";
import type { Experimental_EvaluationModel } from "ai";
import type { WatchtowerIndexCandidate, WatchtowerIndexJob } from "../src/views/watchtower.js";
import { judgeIndex, WATCHTOWER_INDEX_LIMITS } from "../src/watchtower-entities.js";

type Model = Exclude<Experimental_EvaluationModel, string>;
type Call = Parameters<Model["doEvaluate"]>[0];
const model = (evaluate: Model["doEvaluate"]): Model => ({
  specificationVersion: "v4",
  provider: "typesafe-ai",
  modelId: "jev",
  supportedQuestionTypes: ["choice", "boolean"],
  doEvaluate: evaluate,
});
const candidate = (name: string, extra: Partial<WatchtowerIndexCandidate> = {}): WatchtowerIndexCandidate => ({
  name,
  key: name.toLowerCase(),
  kind: null,
  aliases: [],
  count: 1,
  salience: 0.5,
  context: `${name} appears in this sentence.`,
  known: [],
  ...extra,
});
/** A whole distribution, as the SDK requires: `p` on the choice, the rest spread over the others. */
const pick = (call: Call, id: string, choice: string, p = 0.95) => {
  const question = call.questions[id] as { criteria: Record<string, unknown> };
  const options = Object.keys(question.criteria);
  const rest = (1 - p) / (options.length - 1);
  const probabilities = Object.fromEntries(options.map((option) => [option, option === choice ? p : rest])) as Record<string, number>;
  return { type: "choice" as const, choice, probabilities };
};
const page = { host: "techcrunch.example", title: "Stripe raises $6.5B" };

describe("Watchtower index decisions", () => {
  it("asks what each undecided name is, which known entry it is, and what each sentence says", async () => {
    const calls: Call[] = [];
    const job: Pick<WatchtowerIndexJob, "candidates" | "facts"> = {
      candidates: [
        candidate("Stripe", {
          known: [
            { id: 7, kind: "company", name: "Stripe", aliases: ["Stripe", "Stripe, Inc."], sites: ["stripe.com"], context: "Stripe is a payments company." },
            { id: 9, kind: "product", name: "Stripe Billing", aliases: [], sites: [], context: "" },
          ],
        }),
        candidate("Acme Shoes", { kind: "company" }),
        candidate("Read More"),
      ],
      facts: [
        { candidate: 0, text: "Stripe is a financial infrastructure platform." },
        { candidate: 0, text: "Stripe was mentioned in a list of links on this page." },
      ],
    };
    const answers = await judgeIndex(page, job, {
      model: model(async (call) => {
        calls.push(call);
        const answers: Record<string, ReturnType<typeof pick>> =
          "fact_0" in call.questions
            ? { fact_0: pick(call, "fact_0", "definition"), fact_1: pick(call, "fact_1", "nothing_specific") }
            : { kind_0: pick(call, "kind_0", "company"), same_0: pick(call, "same_0", "known_0"), kind_2: pick(call, "kind_2", "not_a_name") };
        return { answers, warnings: [] };
      }),
    });
    expect(answers.entities).toEqual([
      { kind: "company", same: 7 },
      // Settled by the page: not asked, and no known entry to match.
      { kind: "company", same: null },
      { kind: null, same: null },
    ]);
    expect(answers.facts).toEqual(["definition", null]);
    expect(calls).toHaveLength(2);
    const names = calls.find((call) => "kind_0" in call.questions)!;
    expect(Object.keys(names.questions).sort()).toEqual(["kind_0", "kind_2", "same_0"]);
    // Known entries are described by name, kind, spellings, sites and an example — never by id.
    const same = names.questions["same_0"] as { criteria: Record<string, string> };
    expect(Object.keys(same.criteria)).toEqual(["known_0", "known_1", "new"]);
    expect(same.criteria["known_0"]).toMatch(/^Stripe \(company\); also written Stripe, Inc\.; seen on stripe\.com; for example/u);
    expect(JSON.stringify(same.criteria)).not.toMatch(/"7"|\b7\b/u);
    const state = JSON.stringify(names.state);
    expect(state).toContain("techcrunch.example");
    expect(state).not.toMatch(/https?:/u);
  });

  it("makes nothing of an unsure answer: no kind, no merge", async () => {
    const answers = await judgeIndex(
      page,
      {
        candidates: [
          candidate("Collison", {
            known: [
              { id: 1, kind: "person", name: "Patrick Collison", aliases: [], sites: [], context: "" },
              { id: 2, kind: "person", name: "John Collison", aliases: [], sites: [], context: "" },
            ],
          }),
          candidate("Mercury"),
        ],
        facts: [],
      },
      {
        model: model(async (call) => ({
          answers: {
            kind_0: pick(call, "kind_0", "person"),
            same_0: pick(call, "same_0", "known_0", 0.55),
            kind_1: pick(call, "kind_1", "place", 0.4),
          },
          providerMetadata: { typesafe: { confidence: { kind_0: 0.9, same_0: 0.3, kind_1: 0.2 } } },
          warnings: [],
        })),
      },
    );
    // "Collison" is a person, but which one is a coin toss: a new entry, not a guess.
    expect(answers.entities).toEqual([
      { kind: "person", same: null },
      { kind: null, same: null },
    ]);
  });

  it("asks whether a search was an investigation", async () => {
    const answers = await judgeIndex(
      { host: "google.com", title: "stripe vs adyen" },
      { candidates: [candidate("stripe vs adyen", { search: true, kind: "question" })], facts: [] },
      { model: model(async () => ({ answers: { search_0: { type: "boolean", probability: 0.2 } }, warnings: [] })) },
    );
    expect(answers.entities).toEqual([{ kind: null, same: null }]);
  });

  it("asks about a bounded number of names, and none when the page settled them all", async () => {
    let asked = 0;
    const many = Array.from({ length: 30 }, (_, i) => candidate(`Name${i}`));
    const answers = await judgeIndex(page, { candidates: many, facts: [] }, {
      model: model(async (call) => {
        asked = Object.keys(call.questions).length;
        return {
          answers: Object.fromEntries(Object.keys(call.questions).map((id) => [id, pick(call, id, "concept")])),
          warnings: [],
        };
      }),
    });
    expect(asked).toBe(WATCHTOWER_INDEX_LIMITS.kinds);
    expect(answers.entities.filter((decision) => decision.kind === "concept")).toHaveLength(WATCHTOWER_INDEX_LIMITS.kinds);
    expect(answers.entities.slice(WATCHTOWER_INDEX_LIMITS.kinds).every((decision) => decision.kind === null)).toBe(true);

    const settled = await judgeIndex(page, { candidates: [candidate("Acme", { kind: "company" })], facts: [] }, {
      model: model(async () => {
        throw new Error("must not be called");
      }),
    });
    expect(settled.entities).toEqual([{ kind: "company", same: null }]);
  });

  it("fails as a whole when the model answers out of shape, so nothing half-judged is written", async () => {
    await expect(
      judgeIndex(page, { candidates: [candidate("Stripe")], facts: [] }, {
        model: model(async () => ({ answers: {}, warnings: [] })),
      }),
    ).rejects.toThrow();
  });
});
