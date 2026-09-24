import { describe, expect, it } from "vitest";
import type { Experimental_EvaluationModel } from "ai";
import type { WatchtowerHit } from "../src/views/watchtower.js";
import { rerank } from "../src/watchtower-rerank.js";

type Model = Exclude<Experimental_EvaluationModel, string>;
const hit = (id: string): WatchtowerHit => ({
  observationId: id,
  visitId: id,
  pageId: 1,
  snapshotId: 1,
  url: "https://private.example/secret",
  title: "Workshop",
  kind: "video",
  snippet: "Lathe restoration",
  visitedAt: 1,
  capturedAt: 2,
  coverage: "complete",
});
const model = (evaluate: Model["doEvaluate"]): Model => ({
  specificationVersion: "v4",
  provider: "typesafe-ai",
  modelId: "jev",
  supportedQuestionTypes: ["score"],
  doEvaluate: evaluate,
});
describe("Watchtower decisions", () => {
  it("sends bounded evidence and reorders only existing observations", async () => {
    let sent = "";
    const candidates = [hit("first-private-id"), hit("second-private-id")];
    const result = await rerank("lathe", candidates, {
      model: model(async (call) => {
        sent = JSON.stringify(call.state);
        return {
          answers: {
            candidate_0: { type: "score", score: 1 },
            candidate_1: { type: "score", score: 3 },
          },
          warnings: [],
        };
      }),
    });
    expect(result).toEqual([candidates[1], candidates[0]]);
    expect(sent).toContain("Lathe restoration");
    expect(sent).not.toMatch(/private|snapshot|visitedAt/u);
  });
  it("rejects invalid scores so local search survives bad decisions", async () => {
    await expect(
      rerank("lathe", [hit("one")], {
        model: model(async () => ({
          answers: { candidate_0: { type: "score", score: 999 } },
          warnings: [],
        })),
      }),
    ).rejects.toThrow();
  });
  it("avoids calling the model for an empty candidate set", async () => {
    expect(
      await rerank("lathe", [], {
        model: model(async () => {
          throw new Error("must not run");
        }),
      }),
    ).toEqual([]);
  });
});
