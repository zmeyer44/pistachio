import { describe, expect, it } from "vitest";
import type { Experimental_EvaluationModel } from "ai";
import { WATCHTOWER_REGION_ROLES, type WatchtowerRegion } from "../src/views/watchtower.js";
import {
  judgeRegions,
  WATCHTOWER_FILTER_LIMITS,
  WATCHTOWER_KEPT_ROLES,
} from "../src/watchtower-filter.js";

type Model = Exclude<Experimental_EvaluationModel, string>;
const model = (evaluate: Model["doEvaluate"]): Model => ({
  specificationVersion: "v4",
  provider: "typesafe-ai",
  modelId: "jev",
  supportedQuestionTypes: ["choice"],
  doEvaluate: evaluate,
});
const region = (signature: string, excerpt: string, chars = 900, linkChars = 0): WatchtowerRegion => ({
  signature,
  blocks: [0, 1, 2],
  chars,
  linkChars,
  hasHeading: false,
  excerpt,
});
const page = { host: "video.example", title: "Rebuilding a lathe", kind: "video" };
/** The SDK insists on a whole distribution; the rest of the mass goes to `other`. */
const spread = (choice: string, p: number, other = "main_content") => {
  const probabilities = Object.fromEntries(WATCHTOWER_REGION_ROLES.map((role) => [role, 0])) as Record<string, number>;
  probabilities[choice] = p;
  probabilities[other === choice ? "site_chrome" : other] = 1 - p;
  return { type: "choice" as const, choice, probabilities };
};

describe("Watchtower region decisions", () => {
  it("sends layout, shares and a bounded excerpt — never whole pages, block indices or addresses", async () => {
    let state = "";
    let questions: Record<string, unknown> = {};
    const long = "x".repeat(5000);
    const answers = await judgeRegions(
      page,
      [region("div#a>div#b>div#c>div.rail", long, 900, 800), region("div#comments", "Great video.")],
      {
        model: model(async (call) => {
          state = JSON.stringify(call.state);
          questions = call.questions as Record<string, unknown>;
          return {
            answers: {
              region_0: spread("recommendations", 0.9),
              region_1: spread("discussion", 0.97),
            },
            warnings: [],
          };
        }),
      },
    );
    expect(answers.map((answer) => answer?.role)).toEqual(["recommendations", "discussion"]);
    expect(WATCHTOWER_KEPT_ROLES.has(answers[0]!.role)).toBe(false);
    expect(WATCHTOWER_KEPT_ROLES.has(answers[1]!.role)).toBe(true);
    expect(Object.keys(questions)).toEqual(["region_0", "region_1"]);
    expect(state).toContain("video.example");
    expect(state).toContain("div#b > div#c > div.rail");
    expect(state).not.toContain("div#a");
    expect(state).toContain('"shareThatIsLinks":"89%"');
    expect(state).not.toContain("x".repeat(WATCHTOWER_FILTER_LIMITS.excerpt + 1));
    expect(state).not.toMatch(/"blocks":\[/u);
  });

  it("treats an unsure answer as no answer, and an invalid response as a failure the caller survives", async () => {
    const answers = await judgeRegions(page, [region("div.a", "one"), region("div.b", "two")], {
      model: model(async () => ({
        answers: { region_0: spread("advertising", 0.55), region_1: spread("site_chrome", 0.98) },
        warnings: [],
      })),
    });
    // 0.55 against 0.45 is a coin toss whatever its winner.
    expect(answers[0]).toBeNull();
    expect(answers[1]?.role).toBe("site_chrome");
    await expect(
      judgeRegions(page, [region("div.a", "one")], {
        model: model(async () => ({ answers: {}, warnings: [] })),
      }),
    ).rejects.toThrow();
  });

  it("prefers the provider's calibrated confidence and asks about a bounded number of regions", async () => {
    const many = Array.from({ length: 30 }, (_, i) => region(`div.r${i}`, `region ${i}`));
    let asked = 0;
    const answers = await judgeRegions(page, many, {
      model: model(async (call) => {
        asked = Object.keys(call.questions).length;
        return {
          answers: Object.fromEntries(
            Object.keys(call.questions).map((id) => [id, spread("advertising", 0.99)]),
          ),
          providerMetadata: { typesafe: { confidence: { region_0: 0.2, region_1: 0.95 } } },
          warnings: [],
        };
      }),
    });
    expect(asked).toBe(WATCHTOWER_FILTER_LIMITS.regions);
    expect(answers[0]).toBeNull();
    expect(answers[1]).toEqual({ role: "advertising", confidence: 0.95 });
    expect(answers.slice(WATCHTOWER_FILTER_LIMITS.regions).every((answer) => answer === null)).toBe(true);
  });

  it("does not call the model with nothing to ask", async () => {
    expect(
      await judgeRegions(page, [], {
        model: model(async () => {
          throw new Error("must not be called");
        }),
      }),
    ).toEqual([]);
  });
});
