/**
 * Main's side of `ShellApi.rankAddressIntent`: one live question per window,
 * and no more (docs/smart-suggestions.md §7).
 *
 * Someone typing "change theme color" produces a dozen candidate keystrokes
 * in under a second. The renderer debounces, but a debounce is not a lock:
 * requests still overlap, they finish out of order, and an answer to
 * "change th" that lands after the answer to "change theme color" would
 * reorder the list under the person's hands with an opinion about words
 * they have already finished typing. So the ranker keeps exactly one
 * AbortController per asking `WebContents`: a new question aborts the one
 * before it, and the superseded call answers null AT ONCE rather than
 * waiting for the gateway to notice — the renderer is already ignoring it,
 * and a pending IPC reply that never settles is a leak.
 *
 * The three cheap refusals come first, before anything is spent: a request
 * not worth asking about (`sanitizeAddressIntentRequest`), the person's own
 * "Smart suggestions" switch, and no reachable model (signed out, or
 * `PISTACHIO_INTENT_MODEL=off`). Each is null, which is what the address
 * bar treats every other failure as too.
 *
 * It is a plain object over injected parts — the setting, the model, the
 * evaluator — so the superseding can be tested without Electron, a gateway,
 * or a window.
 */

import type { Experimental_EvaluationModel } from "ai";
import { evaluateAddressIntent } from "@pistachio/agent-runtime/address-intent";
import {
  sanitizeAddressIntentRequest,
  type AddressIntentRanking,
  type AddressIntentRequest,
} from "@pistachio/shell-contracts/address-intent";

export interface AddressIntentEvaluation {
  model: Experimental_EvaluationModel;
  request: AddressIntentRequest;
  abortSignal: AbortSignal;
}

export interface AddressIntentRankerOptions {
  /** `settings.search.smartSuggestions`, read fresh: it can be turned off mid-session. */
  enabled: () => boolean;
  /** The intent model, or null when signed out or turned off (`configuredIntentModel`). */
  model: () => Experimental_EvaluationModel | null;
  /** Swappable for tests; the real one never throws and answers null on abort. */
  evaluate?: (evaluation: AddressIntentEvaluation) => Promise<AddressIntentRanking | null>;
}

export class AddressIntentRanker {
  readonly #options: AddressIntentRankerOptions;
  readonly #evaluate: (evaluation: AddressIntentEvaluation) => Promise<AddressIntentRanking | null>;
  /** The live question per asker, keyed by `WebContents.id`. */
  readonly #inFlight = new Map<number, AbortController>();

  constructor(options: AddressIntentRankerOptions) {
    this.#options = options;
    this.#evaluate =
      options.evaluate ??
      ((evaluation) =>
        evaluateAddressIntent({
          model: evaluation.model,
          request: evaluation.request,
          abortSignal: evaluation.abortSignal,
        }));
  }

  /** What the IPC handler returns. `value` is whatever the renderer sent. */
  async rank(askerId: number, value: unknown): Promise<AddressIntentRanking | null> {
    const request = sanitizeAddressIntentRequest(value);
    if (request === null) return null;
    if (!this.#options.enabled()) return null;
    const model = this.#options.model();
    if (model === null) return null;

    this.#inFlight.get(askerId)?.abort();
    const controller = new AbortController();
    this.#inFlight.set(askerId, controller);
    const superseded = new Promise<null>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve(null), { once: true });
    });
    try {
      const ranking = await Promise.race([
        this.#evaluate({ model, request, abortSignal: controller.signal }).catch(() => null),
        superseded,
      ]);
      // An answer that arrived after its keystroke was superseded is worth
      // nothing, however it arrived.
      return controller.signal.aborted ? null : ranking;
    } finally {
      if (this.#inFlight.get(askerId) === controller) this.#inFlight.delete(askerId);
    }
  }

  /** A window went away: whatever it was asking is nobody's answer now. */
  forget(askerId: number): void {
    this.#inFlight.get(askerId)?.abort();
    this.#inFlight.delete(askerId);
  }

  /** On quit. */
  abortAll(): void {
    for (const controller of [...this.#inFlight.values()]) controller.abort();
    this.#inFlight.clear();
  }
}

/* --------------------------- the scripted stand-in --------------------------- */

/** One scripted reading: the intent to be sure of, and the row (by its label) to name. */
export interface ScriptedIntent {
  intent: "web_search" | "ai_prompt" | "open_page" | "browser_command";
  /** The label of the candidate to choose, as the row is titled; absent means "none". */
  target?: string;
}

/**
 * A stand-in for the intent model under Playwright, like the scripted
 * extractor and the offline embedder: the e2e suite dials no gateway, and a
 * test of the ADDRESS BAR — the debounce, the reorder, what ↵ does — needs
 * an answer it can state in advance, not a real model's opinion.
 *
 * It exists only when a spec asks for it: `PISTACHIO_E2E=1` AND a JSON
 * script in `PISTACHIO_INTENT_SCRIPT`, `{"typed words": {"intent": …,
 * "target": "Row label"}}`. Every other spec runs with no intent model at
 * all, exactly as before. Typed words with no script entry read as a web
 * search naming nothing, which moves no row.
 *
 * It answers the same two questions the evaluator asks
 * (@pistachio/agent-runtime/address-intent) in the same wire shape, so the
 * real evaluator, the real IPC hop and the real policy all run over it.
 */
export function scriptedIntentModel(env: NodeJS.ProcessEnv = process.env): Experimental_EvaluationModel | null {
  if (env["PISTACHIO_E2E"] !== "1") return null;
  const raw = env["PISTACHIO_INTENT_SCRIPT"]?.trim() ?? "";
  if (raw === "") return null;
  let script: Record<string, ScriptedIntent>;
  try {
    script = JSON.parse(raw) as Record<string, ScriptedIntent>;
  } catch {
    return null;
  }
  const spread = (options: string[], chosen: string): Record<string, number> => {
    const rest = options.length > 1 ? 0.04 / (options.length - 1) : 0;
    return Object.fromEntries(options.map((option) => [option, option === chosen ? (options.length > 1 ? 0.96 : 1) : rest]));
  };
  return {
    specificationVersion: "v4",
    provider: "pistachio-e2e",
    modelId: "scripted-intent",
    supportedQuestionTypes: ["choice"],
    doEvaluate: ({ state, questions }) => {
      const typed =
        typeof state === "object" && state !== null && !Array.isArray(state)
          ? String((state as Record<string, unknown>)["typed"] ?? "")
          : "";
      const scripted = script[typed] ?? { intent: "web_search" };
      const answers: Record<string, { type: "choice"; choice: string; probabilities: Record<string, number> }> = {};
      for (const [id, question] of Object.entries(questions)) {
        if (question.type !== "choice") continue;
        const options = Object.keys(question.criteria);
        let chosen = options.includes(scripted.intent) ? scripted.intent : "none";
        if (!options.includes(scripted.intent) && scripted.target !== undefined) {
          const label = scripted.target;
          chosen =
            options.find((option) => {
              const criterion = question.criteria[option];
              return typeof criterion === "string" && criterion.includes(`: ${label}.`);
            }) ?? "none";
        }
        if (!options.includes(chosen)) chosen = options[0] ?? "none";
        answers[id] = { type: "choice", choice: chosen, probabilities: spread(options, chosen) };
      }
      return Promise.resolve({ answers, warnings: [] });
    },
  };
}
