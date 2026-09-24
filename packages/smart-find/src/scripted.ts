/**
 * A stand-in for the evaluation model, for tests of everything AROUND the
 * model: the collect, the batching, the paint, the bar. A spec needs an
 * answer it can state in advance, not a real model's opinion, and the e2e
 * suite dials no gateway.
 *
 * The script is `{"typed description": ["words found in the passage", …]}`:
 * a passage containing any of a description's needles is a match (0.95), any
 * other is not (0.02), and the key sentence is the first one holding a
 * needle. It answers the two question shapes `rank.ts` asks, in the same
 * wire shape, so the real ranking, policy and session all run over it.
 */
import type { Experimental_EvaluationModel } from "ai";

export type SmartFindScript = Record<string, string[]>;

export function scriptedFindModel(script: SmartFindScript): Experimental_EvaluationModel {
  return {
    specificationVersion: "v4",
    provider: "pistachio-e2e",
    modelId: "scripted-find",
    supportedQuestionTypes: ["boolean", "choice"],
    doEvaluate: ({ state, questions }) => {
      const record = typeof state === "object" && state !== null && !Array.isArray(state) ? (state as Record<string, unknown>) : {};
      const needles = (script[String(record["search"] ?? "")] ?? []).map((needle) => needle.toLowerCase());
      const passages = Array.isArray(record["passages"]) ? record["passages"].map(String) : [];
      const holds = (text: string): boolean => needles.some((needle) => text.toLowerCase().includes(needle));
      const answers: Record<
        string,
        { type: "boolean"; probability: number } | { type: "choice"; choice: string; probabilities: Record<string, number> }
      > = {};
      for (const [id, question] of Object.entries(questions)) {
        const index = Number(id.slice(1));
        if (question.type === "boolean") answers[id] = { type: "boolean", probability: holds(passages[index] ?? "") ? 0.95 : 0.02 };
        else if (question.type === "choice") {
          const options = Object.entries(question.criteria);
          const choice = (options.find(([, sentence]) => typeof sentence === "string" && holds(sentence)) ?? options[0])?.[0] ?? "s0";
          const rest = options.length > 1 ? 0.04 / (options.length - 1) : 0;
          answers[id] = {
            type: "choice",
            choice,
            probabilities: Object.fromEntries(options.map(([option]) => [option, option === choice ? (options.length > 1 ? 0.96 : 1) : rest])),
          };
        }
      }
      return Promise.resolve({ answers, warnings: [] });
    },
  };
}

/** The scripted model a spec asked for through the environment, or null — which is every ordinary run. */
export function scriptedFindModelFromEnv(env: Record<string, string | undefined>): Experimental_EvaluationModel | null {
  if (env["PISTACHIO_E2E"] !== "1") return null;
  const raw = env["PISTACHIO_FIND_SCRIPT"]?.trim() ?? "";
  if (raw === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const script: SmartFindScript = {};
    for (const [query, needles] of Object.entries(parsed))
      if (Array.isArray(needles)) script[query] = needles.filter((needle): needle is string => typeof needle === "string");
    return scriptedFindModel(script);
  } catch {
    return null;
  }
}
