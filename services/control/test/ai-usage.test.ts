/**
 * ai-usage.ts: reading tokens and cost off the SDK's answers, in both wire
 * shapes and in a stream, and counting bytes whatever the body is.
 */

import { describe, expect, it } from "vitest";
import {
  AI_USAGE_KINDS,
  meteredBody,
  usageFromEventStream,
  usageFromJson,
  usageFromPart,
  usageKindOf,
  type MeteredOutcome,
} from "../src/ai-usage.js";

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(bytes(chunk));
      controller.close();
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (stream === null) return "";
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

describe("usageKindOf", () => {
  it("names the model kind from the path and falls back to other", () => {
    expect(usageKindOf("/v1/ai/language-model", "/v1/ai")).toBe("language-model");
    expect(usageKindOf("/v1/ai/video-model/start", "/v1/ai")).toBe("video-model");
    expect(usageKindOf("/v1/ai/config", "/v1/ai")).toBe("other");
    expect(usageKindOf("/v1/ai", "/v1/ai")).toBe("other");
    for (const kind of AI_USAGE_KINDS) expect(usageKindOf(`/v1/ai/${kind}`, "/v1/ai")).toBe(kind);
  });
});

describe("usageFromPart", () => {
  it("reads the nested {total} shape, the flat number shape, and the embedding shape", () => {
    expect(
      usageFromPart({
        usage: { inputTokens: { total: 120, noCache: 100 }, outputTokens: { total: 30, text: 30 } },
        providerMetadata: { gateway: { cost: "0.00012", marketCost: "0.00015" } },
      }),
    ).toEqual({ inputTokens: 120, outputTokens: 30, costUsd: "0.00012000" });
    expect(usageFromPart({ usage: { inputTokens: 7, outputTokens: 2 }, providerMetadata: { gateway: { cost: 0.5 } } })).toEqual({
      inputTokens: 7,
      outputTokens: 2,
      costUsd: "0.50000000",
    });
    expect(usageFromPart({ embeddings: [], usage: { tokens: 42 } })).toEqual({ inputTokens: 42, outputTokens: null, costUsd: null });
  });

  it("answers nulls for anything it cannot read", () => {
    expect(usageFromPart({ usage: { inputTokens: "many", outputTokens: -1 }, providerMetadata: { gateway: { cost: "free" } } })).toEqual({
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    });
    expect(usageFromPart(null)).toEqual({ inputTokens: null, outputTokens: null, costUsd: null });
    expect(usageFromJson("{not json")).toEqual({ inputTokens: null, outputTokens: null, costUsd: null });
  });
});

describe("usageFromEventStream", () => {
  it("takes the finish part and ignores the rest, split however the chunks fell", () => {
    const text = [
      'data: {"type":"stream-start","warnings":[]}',
      'data: {"type":"text-delta","id":"1","delta":"finish is a word"}',
      'data: {"type":"finish","finishReason":"stop","usage":{"inputTokens":{"total":11},"outputTokens":{"total":5}},"providerMetadata":{"gateway":{"cost":"0.001"}}}',
      "data: [DONE]",
      "",
    ].join("\n");
    expect(usageFromEventStream(text)).toEqual({ inputTokens: 11, outputTokens: 5, costUsd: "0.00100000" });
  });
});

describe("meteredBody", () => {
  it("passes a stream through unchanged and reports the finish part's usage once it ends", async () => {
    const outcomes: MeteredOutcome[] = [];
    const finish = 'data: {"type":"finish","usage":{"inputTokens":3,"outputTokens":4},"providerMetadata":{"gateway":{"cost":"0.2"}}}\n\n';
    const first = 'data: {"type":"text-delta","delta":"hi"}\n\n';
    // The finish line is cut across two chunks.
    const metered = meteredBody(streamOf([first, finish.slice(0, 20), finish.slice(20)]), "text/event-stream", (o) => outcomes.push(o));
    expect(outcomes).toHaveLength(0);
    expect(await drain(metered)).toBe(first + finish);
    expect(outcomes).toEqual([
      { responseBytes: bytes(first + finish).byteLength, usage: { inputTokens: 3, outputTokens: 4, costUsd: "0.20000000" }, truncated: false },
    ]);
  });

  it("reads a JSON answer whole, and counts only bytes past the capture limit", async () => {
    const outcomes: MeteredOutcome[] = [];
    const json = JSON.stringify({ content: [], usage: { inputTokens: { total: 9 }, outputTokens: { total: 1 } } });
    await drain(meteredBody(streamOf([json.slice(0, 10), json.slice(10)]), "application/json; charset=utf-8", (o) => outcomes.push(o)));
    expect(outcomes[0]).toEqual({ responseBytes: bytes(json).byteLength, usage: { inputTokens: 9, outputTokens: 1, costUsd: null }, truncated: false });

    const big: MeteredOutcome[] = [];
    await drain(meteredBody(streamOf([json, json]), "application/json", (o) => big.push(o), 16));
    expect(big[0]).toEqual({ responseBytes: bytes(json).byteLength * 2, usage: { inputTokens: null, outputTokens: null, costUsd: null }, truncated: false });
  });

  it("meters an evaluation answer the way it meters every other JSON answer", async () => {
    // What `experimental_evaluate` really gets back from `/evaluation-model`
    // (docs/smart-suggestions.md §2): no text, two answers, and the same
    // `usage` and gateway `cost` a language model carries — so the intent
    // model counts against the account's cap like everything else.
    const outcomes: MeteredOutcome[] = [];
    const json = JSON.stringify({
      answers: {
        intent: { type: "choice", choice: "browser_command", probabilities: { browser_command: 0.82, web_search: 0.1, ai_prompt: 0.05, open_page: 0.03 } },
        target: { type: "choice", choice: "c0", probabilities: { c0: 0.74, c1: 0.16, none: 0.1 } },
      },
      usage: { inputTokens: 364, outputTokens: 42 },
      providerMetadata: { gateway: { cost: "0", marketCost: "0.000015288" } },
    });
    await drain(meteredBody(streamOf([json]), "application/json", (o) => outcomes.push(o)));
    expect(outcomes[0]).toEqual({
      responseBytes: bytes(json).byteLength,
      // A call the operator's plan covers costs nothing, and "0" is a figure,
      // not a missing one: it still has to be written as a row.
      usage: { inputTokens: 364, outputTokens: 42, costUsd: "0.00000000" },
      truncated: false,
    });
    expect(usageKindOf("/v1/ai/evaluation-model", "/v1/ai")).toBe("evaluation-model");
  });

  it("reports a missing body at once, and a cancelled one as truncated", async () => {
    const none: MeteredOutcome[] = [];
    expect(meteredBody(null, null, (o) => none.push(o))).toBeNull();
    expect(none).toEqual([{ responseBytes: 0, usage: { inputTokens: null, outputTokens: null, costUsd: null }, truncated: false }]);

    const cut: MeteredOutcome[] = [];
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(bytes('data: {"type":"text-delta","delta":"…"}\n\n'));
      },
    });
    const metered = meteredBody(endless, "text/event-stream", (o) => cut.push(o));
    if (metered === null) throw new Error("unreachable");
    const reader = metered.getReader();
    await reader.read();
    await reader.cancel();
    expect(cut).toHaveLength(1);
    expect(cut[0]?.truncated).toBe(true);
    expect(cut[0]?.responseBytes).toBeGreaterThan(0);
  });
});
