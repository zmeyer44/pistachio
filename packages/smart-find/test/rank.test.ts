import type { Experimental_EvaluationModel } from "ai";
import { describe, expect, it } from "vitest";
import { SMART_FIND_LIMITS, type SmartFindPassage } from "../src/contract.js";
import { focusSentences, rankPassages, sentenceSpans, type SmartFindBatch } from "../src/rank.js";
import { scriptedFindModel } from "../src/scripted.js";

const page = (count: number, needleAt: number[] = []): SmartFindPassage[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `b${i}`,
    block: `b${i}`,
    text: needleAt.includes(i) ? `Passage ${i} explains that refunds take five days.` : `Passage ${i} is about something else entirely.`,
  }));

const drain = async (stream: AsyncGenerator<SmartFindBatch>): Promise<SmartFindBatch[]> => {
  const out: SmartFindBatch[] = [];
  for await (const batch of stream) out.push(batch);
  return out;
};

type Spec = Exclude<Experimental_EvaluationModel, string>;
const spec = (model: Experimental_EvaluationModel): Spec => model as Spec;

describe("rankPassages", () => {
  it("judges every passage, in batches of the limit, and maps answers back to passage ids", async () => {
    const calls: number[] = [];
    const inner = spec(scriptedFindModel({ "money back": ["refunds"] }));
    const model: Experimental_EvaluationModel = {
      ...inner,
      doEvaluate: (options) => {
        calls.push(Object.keys(options.questions).length);
        return inner.doEvaluate(options);
      },
    };
    const batches = await drain(rankPassages("  money back ", page(95, [3, 47, 94]), { model }));
    expect(calls.sort((a, b) => b - a)).toEqual([SMART_FIND_LIMITS.batch, SMART_FIND_LIMITS.batch, 15]);
    const scores = batches.flatMap((batch) => batch.scores);
    expect(scores).toHaveLength(95);
    expect(scores.filter((score) => score.probability > 0.5).map((score) => score.id).sort()).toEqual(["b3", "b47", "b94"]);
  });

  it("keeps no more than the limit in flight", async () => {
    let flying = 0;
    let peak = 0;
    const inner = spec(scriptedFindModel({}));
    const model: Experimental_EvaluationModel = {
      ...inner,
      doEvaluate: async (options) => {
        flying += 1;
        peak = Math.max(peak, flying);
        await new Promise((resolve) => setTimeout(resolve, 5));
        flying -= 1;
        return inner.doEvaluate(options);
      },
    };
    await drain(rankPassages("anything", page(SMART_FIND_LIMITS.batch * 9), { model }));
    expect(peak).toBe(SMART_FIND_LIMITS.concurrency);
  });

  it("goes on without a batch that fails, and says which", async () => {
    let call = 0;
    const inner = spec(scriptedFindModel({ q: ["refunds"] }));
    const model: Experimental_EvaluationModel = {
      ...inner,
      doEvaluate: (options) => (call++ === 0 ? Promise.reject(new Error("gateway 502")) : inner.doEvaluate(options)),
    };
    const batches = await drain(rankPassages("q", page(80, [70]), { model }));
    expect(batches.filter((batch) => batch.failed)).toHaveLength(1);
    expect(batches.flatMap((batch) => batch.scores)).toHaveLength(40);
  });

  it("rejects a batch whose answers are not probabilities", async () => {
    const model: Experimental_EvaluationModel = {
      ...spec(scriptedFindModel({})),
      doEvaluate: ({ questions }) =>
        Promise.resolve({
          answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: "boolean" as const, probability: 7 }])),
          warnings: [],
        }),
    };
    const [batch] = await drain(rankPassages("q", page(3), { model }));
    expect(batch).toEqual({ scores: [], asked: 3, failed: true });
  });

  it("stops yielding once aborted", async () => {
    const abort = new AbortController();
    const seen: SmartFindBatch[] = [];
    for await (const batch of rankPassages("q", page(400), { model: scriptedFindModel({}), signal: abort.signal })) {
      seen.push(batch);
      abort.abort();
    }
    expect(seen).toHaveLength(1);
  });
});

describe("focusSentences", () => {
  it("spans are offsets into the passage's own text", () => {
    const text = "First one here. The second sentence!  And a third?";
    expect(sentenceSpans(text).map(({ start, end }) => text.slice(start, end))).toEqual([
      "First one here.",
      "The second sentence!",
      "And a third?",
    ]);
  });

  it("picks the key sentence of a multi-sentence passage and needs no question for a single one", async () => {
    let asked = 0;
    const inner = spec(scriptedFindModel({ "money back": ["refunds"] }));
    const model: Experimental_EvaluationModel = {
      ...inner,
      doEvaluate: (options) => {
        asked += Object.keys(options.questions).length;
        return inner.doEvaluate(options);
      },
    };
    const long = "We value every customer. Refunds are issued within five days. Contact support for anything else.";
    const found = await focusSentences(
      "money back",
      [
        { id: "b1", block: "b1", text: long },
        { id: "b2", block: "b2", text: "Refunds only." },
      ],
      { model },
    );
    expect(asked).toBe(1);
    const span = found.get("b1")!;
    expect(long.slice(span.start, span.end)).toBe("Refunds are issued within five days.");
    expect(found.get("b2")).toEqual({ start: 0, end: 13 });
  });
});
