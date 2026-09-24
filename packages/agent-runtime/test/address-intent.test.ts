/**
 * The one model call behind the address bar (docs/smart-suggestions.md §4),
 * against a fake evaluator, so what is pinned here is the CONTRACT rather
 * than any real model's opinion.
 *
 * Four things matter enough to be nailed down. What leaves the device: the
 * state carries the typed words, titles and hosts, and nothing that could
 * name a page — no URL, no path, no query string. What comes back: the
 * model answers in `c0`, `c1`, … and the shell gets its own ids, so a
 * candidate id never reaches the model and the model can never invent one.
 * How thin an answer is read: a provider that sends only its pick still
 * yields a whole distribution, and its own confidence figure wins over the
 * margin this file would otherwise compute. And how failure reads: a
 * timeout, an abort or a thrown error are all `null` — never an exception
 * on a keystroke's path.
 */

import { describe, expect, it } from "vitest";
import type { Experimental_EvaluationModel } from "ai";
import { evaluateAddressIntent } from "../src/address-intent.js";
import {
  NO_TARGET,
  sanitizeAddressIntentRequest,
  ADDRESS_INTENT_LIMITS,
  type AddressIntentRequest,
} from "../src/address-intent-contract.js";

/**
 * The provider-side evaluation model contract, named from what `ai`
 * re-exports rather than by reaching past it into `@ai-sdk/provider`, which
 * this package does not depend on directly.
 */
type EvaluationModelV4 = Exclude<Experimental_EvaluationModel, string>;
type EvaluationCall = Parameters<EvaluationModelV4["doEvaluate"]>[0];
type EvaluationAnswerResult = Awaited<ReturnType<EvaluationModelV4["doEvaluate"]>>;

/** A stand-in for Jev: it records what it was asked and answers as told. */
function fakeModel(
  answer: (options: EvaluationCall) => Promise<EvaluationAnswerResult>,
): { model: EvaluationModelV4; calls: EvaluationCall[] } {
  const calls: EvaluationCall[] = [];
  return {
    calls,
    model: {
      specificationVersion: "v4",
      provider: "typesafe-ai",
      modelId: "jev",
      supportedQuestionTypes: ["choice", "score", "boolean"],
      doEvaluate(options) {
        calls.push(options);
        return answer(options);
      },
    },
  };
}

function answering(
  intent: Record<string, number>,
  target?: Record<string, number>,
  extra: Partial<EvaluationAnswerResult> = {},
): (options: EvaluationCall) => Promise<EvaluationAnswerResult> {
  return async (options) => ({
    answers: {
      intent: { type: "choice", choice: top(intent), probabilities: intent },
      ...(target === undefined || options.questions["target"] === undefined
        ? {}
        : { target: { type: "choice" as const, choice: top(target), probabilities: target } }),
    },
    warnings: [],
    ...extra,
  });
}

function top(spread: Record<string, number>): string {
  return Object.entries(spread).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

const REQUEST: AddressIntentRequest = {
  query: "change theme color",
  currentPage: { title: "Inbox (12)", host: "mail.google.com" },
  recentPages: [{ title: "Pistachio", host: "pistachio.test" }],
  candidates: [
    { id: "settings-intent:theme", kind: "command", label: "Theme & colors", detail: "Change the theme, accent color and gradient" },
    { id: "typed-tab:9f3c-aa21", kind: "page", label: "Gmail — Inbox" },
  ],
};

describe("evaluateAddressIntent", () => {
  it("asks one question per reading, in one call, with only titles and hosts in the state", async () => {
    const fake = fakeModel(answering({ web_search: 0.1, ai_prompt: 0.05, open_page: 0.05, browser_command: 0.8 }, { c0: 0.9, c1: 0.05, [NO_TARGET]: 0.05 }));
    const ranking = await evaluateAddressIntent({ model: fake.model, request: REQUEST });

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call?.state).toEqual({
      typed: "change theme color",
      current_page: { title: "Inbox (12)", host: "mail.google.com" },
      recent_pages: [{ title: "Pistachio", host: "pistachio.test" }],
    });
    // Nothing that could name a page: the state is what it says it is.
    expect(JSON.stringify(call?.state)).not.toMatch(/https?:|\/|\?/);
    expect(Object.keys(call?.questions ?? {})).toEqual(["intent", "target"]);
    const intent = call?.questions["intent"];
    expect(intent?.type).toBe("choice");
    expect(Object.keys(intent?.type === "choice" ? intent.criteria : {})).toEqual([
      "web_search",
      "ai_prompt",
      "open_page",
      "browser_command",
    ]);
    expect(ranking?.intents).toEqual({ web_search: 0.1, ai_prompt: 0.05, open_page: 0.05, browser_command: 0.8 });
    expect(ranking?.query).toBe("change theme color");
  });

  it("sends short option keys and answers in the shell's own ids", async () => {
    const fake = fakeModel(answering({ web_search: 0, ai_prompt: 0, open_page: 0, browser_command: 1 }, { c0: 0.7, c1: 0.2, [NO_TARGET]: 0.1 }));
    const ranking = await evaluateAddressIntent({ model: fake.model, request: REQUEST });

    const target = fake.calls[0]?.questions["target"];
    expect(target?.type).toBe("choice");
    const criteria = target?.type === "choice" ? target.criteria : {};
    expect(Object.keys(criteria)).toEqual(["c0", "c1", NO_TARGET]);
    // No shell id crosses the wire, and the descriptions read positively.
    expect(JSON.stringify(criteria)).not.toContain("settings-intent:theme");
    expect(criteria["c0"]).toBe(
      "Have the browser do this: Theme & colors. Change the theme, accent color and gradient.",
    );
    expect(criteria["c1"]).toBe("Go to this page: Gmail — Inbox.");
    expect(criteria[NO_TARGET]).toMatch(/^Something else:/);

    expect(ranking?.targets).toEqual({
      "settings-intent:theme": 0.7,
      "typed-tab:9f3c-aa21": 0.2,
      [NO_TARGET]: 0.1,
    });
  });

  it("reads a bare pick as all the mass on that option", async () => {
    const fake = fakeModel(async () => ({
      answers: {
        intent: { type: "choice", choice: "ai_prompt" },
        target: { type: "choice", choice: NO_TARGET },
      },
      warnings: [],
    }));
    const ranking = await evaluateAddressIntent({ model: fake.model, request: REQUEST });

    expect(ranking?.intents).toEqual({ web_search: 0, ai_prompt: 1, open_page: 0, browser_command: 0 });
    expect(ranking?.targets).toEqual({ "settings-intent:theme": 0, "typed-tab:9f3c-aa21": 0, [NO_TARGET]: 1 });
    // A bare pick is a decided answer, and the margin says so.
    expect(ranking?.intentConfidence).toBe(1);
    expect(ranking?.targetConfidence).toBe(1);
  });

  it("prefers the provider's own confidence, and falls back to the margin", async () => {
    const spread = { web_search: 0.45, ai_prompt: 0.4, open_page: 0.1, browser_command: 0.05 };
    const targets = { c0: 0.5, c1: 0.3, [NO_TARGET]: 0.2 };
    const withMetadata = fakeModel(
      answering(spread, targets, { providerMetadata: { typesafe: { confidence: { intent: 0.82 } } } }),
    );
    const ranked = await evaluateAddressIntent({ model: withMetadata.model, request: REQUEST });
    expect(ranked?.intentConfidence).toBe(0.82);
    // No figure for `target`: the gap between first and second stands in.
    expect(ranked?.targetConfidence).toBeCloseTo(0.2, 10);

    const bare = fakeModel(answering(spread, targets));
    const fallback = await evaluateAddressIntent({ model: bare.model, request: REQUEST });
    expect(fallback?.intentConfidence).toBeCloseTo(0.05, 10);
  });

  it("asks nothing about targets when the shell sent no candidates", async () => {
    const fake = fakeModel(answering({ web_search: 0.6, ai_prompt: 0.4, open_page: 0, browser_command: 0 }));
    const ranking = await evaluateAddressIntent({
      model: fake.model,
      request: { ...REQUEST, candidates: [] },
    });

    expect(Object.keys(fake.calls[0]?.questions ?? {})).toEqual(["intent"]);
    expect(ranking?.targets).toEqual({});
    expect(ranking?.targetConfidence).toBe(0);
  });

  it("records how long the model took", async () => {
    const fake = fakeModel(answering({ web_search: 1, ai_prompt: 0, open_page: 0, browser_command: 0 }));
    let clock = 1_000;
    const ranking = await evaluateAddressIntent({
      model: fake.model,
      request: { ...REQUEST, candidates: [] },
      now: () => {
        const value = clock;
        clock += 137;
        return value;
      },
    });
    expect(ranking?.latencyMs).toBe(137);
  });

  // Real time, not a fake clock: `AbortSignal.timeout` is the platform's own
  // and a fake timer does not reach it, so the deadline is only proven by
  // waiting for it. 1.5s is the whole of what the person would have waited.
  it("answers null when the model outlives the deadline", { timeout: 10_000 }, async () => {
    const fake = fakeModel(
      (options) =>
        new Promise((_resolve, reject) => {
          options.abortSignal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    );
    const startedAt = Date.now();
    await expect(evaluateAddressIntent({ model: fake.model, request: REQUEST })).resolves.toBeNull();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(ADDRESS_INTENT_LIMITS.timeoutMs - 50);
  });

  it("answers null when the caller aborts", async () => {
    const controller = new AbortController();
    const fake = fakeModel(
      (options) =>
        new Promise((_resolve, reject) => {
          options.abortSignal?.addEventListener("abort", () => {
            reject(new Error("superseded"));
          });
        }),
    );
    const pending = evaluateAddressIntent({ model: fake.model, request: REQUEST, abortSignal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toBeNull();
  });

  it("answers null when the model throws, and when it answers nonsense", async () => {
    const angry = fakeModel(async () => {
      throw new Error("the gateway said no");
    });
    await expect(evaluateAddressIntent({ model: angry.model, request: REQUEST })).resolves.toBeNull();

    const confused = fakeModel(async () => ({
      answers: { intent: { type: "boolean", probability: 0.5 } },
      warnings: [],
    }));
    await expect(evaluateAddressIntent({ model: confused.model, request: REQUEST })).resolves.toBeNull();
  });
});

describe("sanitizeAddressIntentRequest", () => {
  it("keeps a whole request and normalises its whitespace", () => {
    expect(
      sanitizeAddressIntentRequest({
        query: "  change   theme color\n",
        currentPage: { title: " Inbox ", host: "mail.google.com" },
        recentPages: [{ title: "Pistachio", host: "pistachio.test" }],
        candidates: [{ id: "chrome:newTab", kind: "command", label: "New tab", detail: "Open an empty tab" }],
      }),
    ).toEqual({
      query: "change theme color",
      currentPage: { title: "Inbox", host: "mail.google.com" },
      recentPages: [{ title: "Pistachio", host: "pistachio.test" }],
      candidates: [{ id: "chrome:newTab", kind: "command", label: "New tab", detail: "Open an empty tab" }],
    });
  });

  it("refuses what is not worth asking about", () => {
    expect(sanitizeAddressIntentRequest(null)).toBeNull();
    expect(sanitizeAddressIntentRequest("change theme color")).toBeNull();
    expect(sanitizeAddressIntentRequest({})).toBeNull();
    // Shorter than `minQueryChars` is a prefix, not an intent.
    expect(sanitizeAddressIntentRequest({ query: "ma" })).toBeNull();
  });

  it("clips strings and caps lists to the bounds the hosts enforce", () => {
    const request = sanitizeAddressIntentRequest({
      query: "q".repeat(ADDRESS_INTENT_LIMITS.maxQueryChars + 50),
      currentPage: { title: "t".repeat(200), host: "h".repeat(200) },
      recentPages: Array.from({ length: ADDRESS_INTENT_LIMITS.maxRecentPages + 4 }, (_value, index) => ({
        title: `Page ${String(index)}`,
        host: "example.test",
      })),
      candidates: Array.from({ length: ADDRESS_INTENT_LIMITS.maxCandidates + 10 }, (_value, index) => ({
        id: `entry:${String(index)}`,
        kind: "page",
        label: "l".repeat(200),
        detail: "d".repeat(400),
      })),
    });

    expect(request?.query).toHaveLength(ADDRESS_INTENT_LIMITS.maxQueryChars);
    expect(request?.currentPage?.title).toHaveLength(ADDRESS_INTENT_LIMITS.maxTitleChars);
    expect(request?.recentPages).toHaveLength(ADDRESS_INTENT_LIMITS.maxRecentPages);
    expect(request?.candidates).toHaveLength(ADDRESS_INTENT_LIMITS.maxCandidates);
    expect(request?.candidates[0]?.label).toHaveLength(ADDRESS_INTENT_LIMITS.maxLabelChars);
    expect(request?.candidates[0]?.detail).toHaveLength(ADDRESS_INTENT_LIMITS.maxDetailChars);
  });

  it("drops candidates that would collide, mislead, or say nothing", () => {
    const request = sanitizeAddressIntentRequest({
      query: "my email",
      candidates: [
        { id: "tab:1", kind: "page", label: "Gmail" },
        // A second row under the same id would make one probability two rows.
        { id: "tab:1", kind: "page", label: "Gmail again" },
        // `none` is the model's own "something else"; it cannot also be a row.
        { id: NO_TARGET, kind: "page", label: "Nothing" },
        { id: "tab:2", kind: "elsewhere", label: "Mystery" },
        { id: "", kind: "page", label: "Nameless" },
        { id: "tab:3", kind: "page", label: "" },
        "not a candidate at all",
        null,
      ],
    });

    expect(request?.candidates).toEqual([{ id: "tab:1", kind: "page", label: "Gmail" }]);
    expect(request?.currentPage).toBeNull();
    expect(request?.recentPages).toEqual([]);
  });

  it("drops a recent page that has neither a title nor a host", () => {
    const request = sanitizeAddressIntentRequest({
      query: "my email",
      recentPages: [{ title: "", host: "" }, 7, { title: "Gmail", host: "mail.google.com" }],
      candidates: [],
    });
    expect(request?.recentPages).toEqual([{ title: "Gmail", host: "mail.google.com" }]);
  });
});
