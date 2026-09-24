/**
 * The one model call ahead of a console turn (docs/console-routing.md §3),
 * against a fake evaluator, so what is pinned here is the CONTRACT rather
 * than any real model's opinion.
 *
 * What leaves the device: the message, a few clipped exchanges, attachment
 * kinds, and a page as title and host — never a URL. What comes back: a
 * probability per route and the provider's own confidence. How the host
 * decides: `answer` only at or above the floor, `browse` for everything
 * else including no opinion at all. And how failure reads: a timeout, an
 * abort, a thrown error, a nonsense answer are all `null`.
 */

import { describe, expect, it } from "vitest";
import type { Experimental_EvaluationModel } from "ai";
import { evaluateTurnRoute } from "../src/turn-route.js";
import {
  TURN_ROUTE_LIMITS,
  decideTurnRoute,
  sanitizeTurnRouteRequest,
  type TurnRouteRequest,
} from "../src/turn-route-contract.js";

type EvaluationModelV4 = Exclude<Experimental_EvaluationModel, string>;
type EvaluationCall = Parameters<EvaluationModelV4["doEvaluate"]>[0];
type EvaluationAnswerResult = Awaited<ReturnType<EvaluationModelV4["doEvaluate"]>>;

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
  route: Record<string, number>,
  extra: Partial<EvaluationAnswerResult> = {},
): (options: EvaluationCall) => Promise<EvaluationAnswerResult> {
  const choice = Object.entries(route).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  return async () => ({
    answers: { route: { type: "choice", choice, probabilities: route } },
    warnings: [],
    ...extra,
  });
}

const REQUEST: TurnRouteRequest = {
  message: "shorten that to two sentences",
  attachments: [],
  conversation: [
    { who: "person", said: "what does this page say about returns?" },
    { who: "assistant", said: "Returns are accepted within 30 days with the receipt; refunds go to the original payment method." },
  ],
  browserUsed: true,
  currentPage: { title: "Returns & refunds — Example Store", host: "www.example.com" },
  tools: ["set reminders"],
};

describe("evaluateTurnRoute", () => {
  it("asks one choice question over a thin state and returns the spread", async () => {
    const { model, calls } = fakeModel(answering({ answer: 0.8, page: 0.1, browse: 0.1 }, { providerMetadata: { typesafe: { confidence: { route: 0.83 } } } }));
    const evaluation = await evaluateTurnRoute({ model, request: REQUEST, now: (() => { let t = 100; return () => (t += 40); })() });
    expect(evaluation).toEqual({ routes: { answer: 0.8, page: 0.1, browse: 0.1 }, confidence: 0.83, latencyMs: 40 });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(Object.keys(call.questions)).toEqual(["route"]);
    expect(call.questions["route"]?.type).toBe("choice");
    const state = call.state as Record<string, unknown>;
    expect(state).toEqual({
      message: "shorten that to two sentences",
      earlier_exchanges: [
        { person: "what does this page say about returns?" },
        { assistant: "Returns are accepted within 30 days with the receipt; refunds go to the original payment method." },
      ],
      browser_used_earlier_in_this_conversation: true,
      page_they_are_looking_at: { title: "Returns & refunds — Example Store", host: "www.example.com" },
    });
    // The page reaches the model as a title and a host, never an address.
    expect(JSON.stringify(call)).not.toContain("https://");
    // The host's tools are named inside the "answer" reading, so a reminder is a reply.
    const criteria = (call.questions["route"] as { criteria: Record<string, string> }).criteria;
    expect(criteria["answer"]).toContain("set reminders");
    // A web page is in view, so the middle reading is on offer.
    expect(Object.keys(criteria)).toEqual(["answer", "page", "browse"]);
  });

  it("leaves optional halves out rather than sending nulls, and offers no page reading without a page", async () => {
    const { model, calls } = fakeModel(answering({ answer: 0.2, browse: 0.8 }));
    const evaluation = await evaluateTurnRoute({ model, request: { ...REQUEST, conversation: [], currentPage: null, tools: [], attachments: ["image"] } });
    const state = calls[0]!.state as Record<string, unknown>;
    expect(state).toEqual({ message: "shorten that to two sentences", attached: ["image"], browser_used_earlier_in_this_conversation: true });
    const criteria = (calls[0]!.questions["route"] as { criteria: Record<string, string> }).criteria;
    expect(criteria["answer"]).not.toContain("can also");
    expect(Object.keys(criteria)).toEqual(["answer", "browse"]);
    expect(evaluation?.routes).toEqual({ answer: 0.2, page: 0, browse: 0.8 });
  });

  it("reads a bare pick as the whole distribution and the margin as confidence", async () => {
    const { model } = fakeModel(async () => ({ answers: { route: { type: "choice", choice: "browse" } }, warnings: [] }));
    const evaluation = await evaluateTurnRoute({ model, request: REQUEST });
    expect(evaluation).toEqual({ routes: { answer: 0, page: 0, browse: 1 }, confidence: 1, latencyMs: expect.any(Number) });
  });

  it("answers null for a thrown error, a nonsense answer, an abort, or an empty request", async () => {
    const thrown = fakeModel(async () => { throw new Error("spend cap reached"); });
    expect(await evaluateTurnRoute({ model: thrown.model, request: REQUEST })).toBeNull();

    const nonsense = fakeModel(async () => ({ answers: { route: { type: "score", score: 3 } }, warnings: [] }));
    expect(await evaluateTurnRoute({ model: nonsense.model, request: REQUEST })).toBeNull();

    const aborted = new AbortController();
    aborted.abort();
    const slow = fakeModel(() => new Promise(() => {}));
    expect(await evaluateTurnRoute({ model: slow.model, request: REQUEST, abortSignal: aborted.signal })).toBeNull();

    const never = fakeModel(async () => { throw new Error("should not be asked"); });
    expect(await evaluateTurnRoute({ model: never.model, request: { ...REQUEST, message: "   ", attachments: [] } })).toBeNull();
    expect(never.calls).toHaveLength(0);
  });
});

describe("decideTurnRoute", () => {
  const floor = TURN_ROUTE_LIMITS.answerFloor;
  it("takes a quick path only when answer and page together reach the floor, and browse for no opinion", () => {
    const at = { routes: { answer: floor, page: 0, browse: 1 - floor }, confidence: 0.5, latencyMs: 10 };
    expect(decideTurnRoute(at)).toEqual({ route: "answer", basis: "model", evaluation: at });
    const together = { routes: { answer: floor / 2, page: floor / 2, browse: 1 - floor }, confidence: 0.5, latencyMs: 10 };
    expect(decideTurnRoute(together).route).toBe("answer");
    const below = { routes: { answer: floor - 0.01, page: 0, browse: 0.5 }, confidence: 0.5, latencyMs: 10 };
    expect(decideTurnRoute(below).route).toBe("browse");
    expect(decideTurnRoute(null)).toEqual({ route: "browse", basis: "unavailable", evaluation: null });
  });

  it("reads the page when that is the likelier of the two quick readings", () => {
    expect(decideTurnRoute({ routes: { answer: 0.2, page: 0.7, browse: 0.1 }, confidence: 0.5, latencyMs: 10 }).route).toBe("page");
    expect(decideTurnRoute({ routes: { answer: 0.35, page: 0.3, browse: 0.35 }, confidence: 0.5, latencyMs: 10 }).route).toBe("answer");
    // Page alone below the floor but with answer above it: quick, and the page.
    expect(decideTurnRoute({ routes: { answer: 0.3, page: 0.4, browse: 0.3 }, confidence: 0.5, latencyMs: 10 }).route).toBe("page");
  });
});

describe("sanitizeTurnRouteRequest", () => {
  it("clips the message and exchanges, keeps only the last few, and dedupes kinds and tools", () => {
    const long = "x".repeat(TURN_ROUTE_LIMITS.messageChars + 50);
    const sanitized = sanitizeTurnRouteRequest({
      message: `  ${long}  `,
      attachments: ["image", "image", " pdf ", ""],
      conversation: Array.from({ length: TURN_ROUTE_LIMITS.exchanges + 3 }, (_, index) => ({
        who: index % 2 === 0 ? "person" as const : "assistant" as const,
        said: `${String(index)} ${"y".repeat(TURN_ROUTE_LIMITS.exchangeChars)}`,
      })),
      browserUsed: false,
      currentPage: { title: " Title ", host: " host.example " },
      tools: ["a", "a", " b "],
    });
    expect(sanitized.message).toHaveLength(TURN_ROUTE_LIMITS.messageChars);
    expect(sanitized.message.endsWith("…")).toBe(true);
    expect(sanitized.attachments).toEqual(["image", "pdf"]);
    expect(sanitized.conversation).toHaveLength(TURN_ROUTE_LIMITS.exchanges);
    expect(sanitized.conversation[0]?.said.startsWith("3 ")).toBe(true);
    for (const exchange of sanitized.conversation) expect(exchange.said).toHaveLength(TURN_ROUTE_LIMITS.exchangeChars);
    expect(sanitized.currentPage).toEqual({ title: "Title", host: "host.example" });
    expect(sanitized.tools).toEqual(["a", "b"]);
  });
});
