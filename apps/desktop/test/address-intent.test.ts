/**
 * The one-question-per-window rule behind `rankAddressIntent`
 * (docs/smart-suggestions.md §7), and the three refusals that come before
 * anything is spent.
 *
 * What is pinned: a second question aborts the first, and the first answers
 * null AT ONCE rather than leaving an IPC reply pending on a keystroke
 * nobody is waiting for any more; two windows do not supersede each other;
 * and the switch, the model and the sanitizer each refuse before the
 * evaluator is reached at all.
 */

import { describe, expect, it } from "vitest";
import type { Experimental_EvaluationModel } from "ai";
import type { AddressIntentRanking, AddressIntentRequest } from "@pistachio/shell-contracts/address-intent";
import { evaluateAddressIntent } from "@pistachio/agent-runtime/address-intent";
import { AddressIntentRanker, scriptedIntentModel, type AddressIntentEvaluation } from "../src/main/address-intent";

const MODEL = { specificationVersion: "v4" } as unknown as Experimental_EvaluationModel;

function ask(query: string): unknown {
  return { query, currentPage: null, recentPages: [], candidates: [] };
}

function ranking(query: string): AddressIntentRanking {
  return {
    query,
    intents: { web_search: 1, ai_prompt: 0, open_page: 0, browser_command: 0 },
    intentConfidence: 1,
    targets: {},
    targetConfidence: 0,
    latencyMs: 12,
  };
}

/** An evaluator that answers only when the test says to. */
function gated(): {
  evaluate: (evaluation: AddressIntentEvaluation) => Promise<AddressIntentRanking | null>;
  seen: AddressIntentRequest[];
  release: (query: string) => void;
} {
  const pending = new Map<string, (value: AddressIntentRanking | null) => void>();
  const seen: AddressIntentRequest[] = [];
  return {
    seen,
    evaluate: (evaluation) => {
      seen.push(evaluation.request);
      return new Promise((resolve) => pending.set(evaluation.request.query, resolve));
    },
    release: (query) => pending.get(query)?.(ranking(query)),
  };
}

describe("AddressIntentRanker", () => {
  it("keeps one question per window: a new one aborts the last, which answers null at once", async () => {
    const gate = gated();
    const aborted: string[] = [];
    const ranker = new AddressIntentRanker({
      enabled: () => true,
      model: () => MODEL,
      evaluate: (evaluation) => {
        evaluation.abortSignal.addEventListener("abort", () => aborted.push(evaluation.request.query));
        return gate.evaluate(evaluation);
      },
    });

    const first = ranker.rank(1, ask("change th"));
    const second = ranker.rank(1, ask("change theme color"));
    // The superseded reply settles without the gateway ever answering it.
    await expect(first).resolves.toBeNull();
    expect(aborted).toEqual(["change th"]);

    gate.release("change theme color");
    expect(await second).toEqual(ranking("change theme color"));
  });

  it("drops an answer that arrives after its keystroke was superseded", async () => {
    const gate = gated();
    const ranker = new AddressIntentRanker({ enabled: () => true, model: () => MODEL, evaluate: gate.evaluate });

    const first = ranker.rank(1, ask("my ema"));
    const second = ranker.rank(1, ask("my email"));
    // The first evaluator ignores its abort and answers anyway; it is still
    // an opinion about words the person has moved past.
    gate.release("my ema");
    await expect(first).resolves.toBeNull();
    gate.release("my email");
    expect((await second)?.query).toBe("my email");
  });

  it("does not let one window supersede another", async () => {
    const gate = gated();
    const ranker = new AddressIntentRanker({ enabled: () => true, model: () => MODEL, evaluate: gate.evaluate });

    const left = ranker.rank(1, ask("best gelato"));
    const right = ranker.rank(2, ask("explain tls"));
    gate.release("best gelato");
    gate.release("explain tls");
    expect((await left)?.query).toBe("best gelato");
    expect((await right)?.query).toBe("explain tls");
  });

  it("forgets a window that went away, and everything on quit", async () => {
    const gate = gated();
    const ranker = new AddressIntentRanker({ enabled: () => true, model: () => MODEL, evaluate: gate.evaluate });

    const closing = ranker.rank(1, ask("best gelato"));
    ranker.forget(1);
    await expect(closing).resolves.toBeNull();

    const quitting = ranker.rank(2, ask("explain tls"));
    ranker.abortAll();
    await expect(quitting).resolves.toBeNull();
  });

  it("refuses before it spends: the switch, the model, and a request not worth asking", async () => {
    const gate = gated();
    let enabled = false;
    let model: Experimental_EvaluationModel | null = null;
    const ranker = new AddressIntentRanker({
      enabled: () => enabled,
      model: () => model,
      evaluate: gate.evaluate,
    });

    expect(await ranker.rank(1, ask("change theme color"))).toBeNull();
    enabled = true;
    expect(await ranker.rank(1, ask("change theme color"))).toBeNull();
    model = MODEL;
    // A prefix shorter than the bounds allow, and junk, never reach a model.
    expect(await ranker.rank(1, ask("ch"))).toBeNull();
    expect(await ranker.rank(1, "change theme color")).toBeNull();
    expect(await ranker.rank(1, null)).toBeNull();
    expect(gate.seen).toEqual([]);
  });

  it("answers null when the evaluator throws", async () => {
    const ranker = new AddressIntentRanker({
      enabled: () => true,
      model: () => MODEL,
      evaluate: () => Promise.reject(new Error("the gateway said no")),
    });
    await expect(ranker.rank(1, ask("change theme color"))).resolves.toBeNull();
  });
});

describe("the scripted stand-in the e2e suite asks for", () => {
  const script = JSON.stringify({
    "make it prettier": { intent: "browser_command", target: "Theme & colors" },
    "explain tls": { intent: "ai_prompt" },
  });
  const request = (query: string): AddressIntentRequest => ({
    query,
    currentPage: null,
    recentPages: [],
    candidates: [
      { id: "chrome:newTab", kind: "command", label: "New tab" },
      { id: "settings:appearance", kind: "command", label: "Theme & colors", detail: "Change the theme." },
    ],
  });

  it("exists only under Playwright, and only when a spec wrote a script", () => {
    expect(scriptedIntentModel({})).toBeNull();
    expect(scriptedIntentModel({ PISTACHIO_E2E: "1" })).toBeNull();
    expect(scriptedIntentModel({ PISTACHIO_INTENT_SCRIPT: script })).toBeNull();
    expect(scriptedIntentModel({ PISTACHIO_E2E: "1", PISTACHIO_INTENT_SCRIPT: "not json" })).toBeNull();
    expect(scriptedIntentModel({ PISTACHIO_E2E: "1", PISTACHIO_INTENT_SCRIPT: script })).not.toBeNull();
  });

  it("answers the real evaluator with the scripted reading, by the row's label", async () => {
    const model = scriptedIntentModel({ PISTACHIO_E2E: "1", PISTACHIO_INTENT_SCRIPT: script });
    if (model === null) throw new Error("no scripted model");
    const themed = await evaluateAddressIntent({ model, request: request("make it prettier") });
    expect(themed?.intents.browser_command).toBeGreaterThan(0.9);
    expect(themed?.targets["settings:appearance"]).toBeGreaterThan(0.9);
    const prompt = await evaluateAddressIntent({ model, request: request("explain tls") });
    expect(prompt?.intents.ai_prompt).toBeGreaterThan(0.9);
    expect(prompt?.targets["none"]).toBeGreaterThan(0.9);
    // Unscripted words move nothing: a web search that names no row.
    const plain = await evaluateAddressIntent({ model, request: request("best gelato") });
    expect(plain?.intents.web_search).toBeGreaterThan(0.9);
    expect(plain?.targets["none"]).toBeGreaterThan(0.9);
  });
});
