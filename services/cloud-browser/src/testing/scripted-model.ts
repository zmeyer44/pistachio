/**
 * A scripted model for integration tests: `runAiBrowserAgent` runs for
 * real, the model answers from a queue of steps, and nothing touches the
 * network. `gate()` makes a step wait until the test releases it, so a run
 * can be held "active" deterministically.
 */

import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModel } from "ai";
import type { ModelFactory } from "../runs/executor.js";

export type ScriptCallOptions = Parameters<MockLanguageModelV4["doGenerate"]>[0];
export type ScriptResult = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;
export type ScriptStep = (options: ScriptCallOptions) => ScriptResult | Promise<ScriptResult>;

let nextCallId = 0;

function usageFor(prompt: ScriptCallOptions["prompt"]): ScriptResult["usage"] {
  const tokens = Math.ceil(JSON.stringify(prompt).length / 4) + 4_000;
  return {
    inputTokens: { total: tokens, noCache: tokens, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 20, text: 20, reasoning: undefined },
  };
}

/** A step that calls one or more tools. */
export function toolCalls(...requests: Array<{ name: string; input: Record<string, unknown> }>): ScriptStep {
  return ({ prompt }) => ({
    content: requests.map((request) => ({
      type: "tool-call" as const,
      toolCallId: `call-${String(++nextCallId)}`,
      toolName: request.name,
      input: JSON.stringify(request.input),
    })),
    finishReason: { unified: "tool-calls", raw: "tool_use" },
    usage: usageFor(prompt),
    warnings: [],
  });
}

/** A step that answers in text. */
export function answer(text: string): ScriptStep {
  return ({ prompt }) => ({
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "end_turn" },
    usage: usageFor(prompt),
    warnings: [],
  });
}

/** A step that waits until `release()` — the run stays active meanwhile; an abort rejects it. */
export function gate(): { step: ScriptStep; release: (next?: ScriptStep) => void; readonly waiting: boolean } {
  let release: ((next: ScriptStep) => void) | null = null;
  let released: ScriptStep | null = null;
  let waiting = false;
  const step: ScriptStep = async (options) => {
    waiting = true;
    const next = await new Promise<ScriptStep>((resolve, reject) => {
      if (released !== null) {
        resolve(released);
        return;
      }
      const signal = options.abortSignal;
      const onAbort = (): void => reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
      if (signal?.aborted === true) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      release = (value) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
    });
    waiting = false;
    return next(options);
  };
  return {
    step,
    release: (next = answer("Done.")) => {
      released = next;
      release?.(next);
    },
    get waiting() {
      return waiting;
    },
  };
}

/** A model that answers from a queue, then from `fallback`, then fails loudly. */
export function scriptedModel(steps: ScriptStep[], fallback?: ScriptStep): MockLanguageModelV4 {
  const queue = [...steps];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      const step = queue.shift() ?? fallback;
      if (step === undefined) {
        throw new Error(`model script exhausted after ${String(model.doGenerateCalls.length)} calls`);
      }
      return step(options);
    },
  });
  return model;
}

/** A `ModelFactory` whose model runs `script()` for each run. */
export function scriptedModelFactory(
  script: (input: { userId: string; spaceId: string; runId: string }) => ScriptStep[],
  options: { fallback?: ScriptStep; modelName?: string } = {},
): ModelFactory {
  return (input) => ({
    model: scriptedModel(script(input), options.fallback) as unknown as LanguageModel,
    modelName: options.modelName ?? "scripted-model",
  });
}
