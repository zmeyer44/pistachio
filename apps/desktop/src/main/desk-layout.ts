/**
 * Main's side of `NativeSurfaceApi.judgeDeskLayout`: one live question per
 * window, and no more (docs/desk-layout.md §3).
 *
 * Three tabs closed in a row ask three times. Only the last matters — the
 * desk it describes is the desk as it now is — and an answer about the desk
 * of two closes ago would move windows that have already moved. So the judge
 * keeps one AbortController per asking `WebContents`: a new question aborts
 * the one before it, and the superseded call answers null AT ONCE.
 *
 * It is a plain object over injected parts — the model, the evaluator — so
 * the superseding is tested without Electron, a gateway, or a window.
 */

import type { Experimental_EvaluationModel } from "ai";
import { evaluateDeskLayout } from "@pistachio/agent-runtime/desk-layout";
import { sanitizeDeskLayoutRequest, type DeskLayoutEvaluation, type DeskLayoutRequest } from "@pistachio/shell-contracts/desk-layout";

export interface DeskLayoutJudgement {
  model: Experimental_EvaluationModel;
  request: DeskLayoutRequest;
  abortSignal: AbortSignal;
}

export interface DeskLayoutJudgeOptions {
  /** The evaluation model, or null when signed out or turned off (`configuredIntentModel`). */
  model: () => Experimental_EvaluationModel | null;
  /** Swappable for tests; the real one never throws and answers null on abort. */
  evaluate?: (judgement: DeskLayoutJudgement) => Promise<DeskLayoutEvaluation | null>;
}

export class DeskLayoutJudge {
  readonly #options: DeskLayoutJudgeOptions;
  readonly #evaluate: (judgement: DeskLayoutJudgement) => Promise<DeskLayoutEvaluation | null>;
  /** The live question per asker, keyed by `WebContents.id`. */
  readonly #inFlight = new Map<number, AbortController>();

  constructor(options: DeskLayoutJudgeOptions) {
    this.#options = options;
    this.#evaluate =
      options.evaluate ??
      ((judgement) => evaluateDeskLayout({ model: judgement.model, request: judgement.request, abortSignal: judgement.abortSignal }));
  }

  /** What the IPC handler returns. `value` is whatever the renderer sent. */
  async judge(askerId: number, value: unknown): Promise<DeskLayoutEvaluation | null> {
    const request = sanitizeDeskLayoutRequest(value);
    if (request === null) return null;
    const model = this.#options.model();
    if (model === null) return null;

    this.#inFlight.get(askerId)?.abort();
    const controller = new AbortController();
    this.#inFlight.set(askerId, controller);
    const superseded = new Promise<null>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve(null), { once: true });
    });
    try {
      const evaluation = await Promise.race([this.#evaluate({ model, request, abortSignal: controller.signal }).catch(() => null), superseded]);
      // An answer about a desk that has changed since is worth nothing, however it arrived.
      return controller.signal.aborted ? null : evaluation;
    } finally {
      if (this.#inFlight.get(askerId) === controller) this.#inFlight.delete(askerId);
    }
  }

  /** A window went away: whatever it was asking is nobody's answer now. */
  forget(askerId: number): void {
    this.#inFlight.get(askerId)?.abort();
    this.#inFlight.delete(askerId);
  }
}

/* --------------------------- the scripted stand-in --------------------------- */

/** One scripted judgement: the move to be sure of, and the windows (by title, or part of one) it is about. */
export interface ScriptedDeskLayout {
  move: "keep" | "fill" | "pair" | "tile" | "focus";
  main?: string;
  partner?: string;
}

/**
 * A stand-in for the layout model under Playwright, like the scripted intent
 * model (./address-intent.ts): the e2e suite dials no gateway, and a test of
 * the DESK — what moves after a window comes or goes, the Undo — needs an
 * answer it can state in advance.
 *
 * It exists only when a spec asks for it: `PISTACHIO_E2E=1` AND a JSON
 * script in `PISTACHIO_LAYOUT_SCRIPT`, keyed by what happened:
 * `{"opened": {"move": "pair", "partner": "Vendor"}, "closed": {"move":
 * "fill"}, "asked": {"move": "focus", "main": "Invoice"}}`. A trigger with
 * no entry reads as keep (asked: tile). Windows are named by a part of
 * their title. It answers the evaluator's own questions in the same wire
 * shape, so the real evaluator, the real IPC hop and the real policy all
 * run over it.
 */
export function scriptedLayoutModel(env: NodeJS.ProcessEnv = process.env): Experimental_EvaluationModel | null {
  if (env["PISTACHIO_E2E"] !== "1") return null;
  const raw = env["PISTACHIO_LAYOUT_SCRIPT"]?.trim() ?? "";
  if (raw === "") return null;
  let script: Partial<Record<"opened" | "closed" | "asked", ScriptedDeskLayout>>;
  try {
    script = JSON.parse(raw) as typeof script;
  } catch {
    return null;
  }
  const spread = (options: string[], chosen: string): Record<string, number> => {
    const rest = options.length > 1 ? 0.04 / (options.length - 1) : 0;
    return Object.fromEntries(options.map((option) => [option, option === chosen ? (options.length > 1 ? 0.96 : 1) : rest]));
  };
  /** The option whose description quotes a title containing `part`. */
  const named = (criteria: Record<string, unknown>, part: string | undefined): string | null =>
    part === undefined ? null : (Object.keys(criteria).find((option) => String(criteria[option] ?? "").includes(part)) ?? null);
  return {
    specificationVersion: "v4",
    provider: "pistachio-e2e",
    modelId: "scripted-layout",
    supportedQuestionTypes: ["choice"],
    doEvaluate: ({ state, questions }) => {
      const happened = typeof state === "object" && state !== null && !Array.isArray(state) ? String((state as Record<string, unknown>)["what_happened"] ?? "") : "";
      const trigger = happened.startsWith("The person asked") ? "asked" : happened.startsWith("The person opened") ? "opened" : "closed";
      const scripted = script[trigger] ?? { move: trigger === "asked" ? "tile" : "keep" };
      const answers: Record<string, { type: "choice"; choice: string; probabilities: Record<string, number> }> = {};
      for (const [id, question] of Object.entries(questions)) {
        if (question.type !== "choice") continue;
        const options = Object.keys(question.criteria);
        const chosen =
          id === "move"
            ? options.includes(scripted.move)
              ? scripted.move
              : options[0]!
            : id === "main"
              ? (named(question.criteria, scripted.main) ?? options[0]!)
              : (named(question.criteria, scripted.partner) ?? "none");
        answers[id] = { type: "choice", choice: chosen, probabilities: spread(options, chosen) };
      }
      return Promise.resolve({ answers, warnings: [] });
    },
  };
}
