/**
 * `pistachio.ai.complete` (docs/primitives.md §3.8): one question to the
 * account's fast model — a prompt, optionally how to answer, the text back.
 * No tools, no memory, no turn in anybody's conversation: the plain call a
 * feature needs to name, sort or sum something up, which `agent.ask` (a
 * visible turn the person sends) is not.
 *
 * Every failure is null — signed out, offline, a timeout, a refusal — and
 * the extension is told `UNAVAILABLE`: what it does without a model is its
 * own to decide, as Tidy's is (docs/tab-tidy.md §1, "Degrades to Arc").
 *
 * Here, apart from index.ts, so the call and the spec's stand-in are tested
 * without Electron.
 */

import { generateText, type LanguageModel } from "ai";
import { AI_COMPLETE_TIMEOUT_MS } from "@pistachio/extension-api/wire";

export interface CompleteRequest {
  prompt: string;
  system: string | null;
  maxTokens: number;
}

/** How long one question may wait, and what stops it sooner: whoever asked being gone (CompleteCalls). */
export interface CompleteLimits {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * The model's answer to one question, or null on any failure — never throws. The request itself is stopped at
 * `timeoutMs` (the model's own bound when unsaid) or when `signal` says to: it does not run on, spending usage, for
 * a caller that has stopped waiting.
 */
export async function completeWith(model: LanguageModel, request: CompleteRequest, limits: CompleteLimits = {}): Promise<string | null> {
  const timeout = AbortSignal.timeout(limits.timeoutMs ?? AI_COMPLETE_TIMEOUT_MS);
  try {
    const { text } = await generateText({
      model,
      ...(request.system === null ? {} : { system: request.system }),
      prompt: request.prompt,
      maxOutputTokens: request.maxTokens,
      maxRetries: 0,
      abortSignal: limits.signal === undefined ? timeout : AbortSignal.any([timeout, limits.signal]),
    });
    return text;
  } catch {
    return null;
  }
}

/**
 * The questions under way, each with the view that asked (its webContents id). A view that goes — a worker stopped
 * once its trigger's handler has answered or timed out, a page closed — takes its questions with it: `abortOwned`
 * stops each request, so nothing is asked on for nobody.
 */
export class CompleteCalls {
  readonly #calls = new Map<AbortController, number>();

  get size(): number {
    return this.#calls.size;
  }

  /** A question `owner` asks: the signal that stops it, and `done` for when it has been answered. */
  begin(owner: number): { signal: AbortSignal; done(): void } {
    const controller = new AbortController();
    this.#calls.set(controller, owner);
    return { signal: controller.signal, done: () => void this.#calls.delete(controller) };
  }

  abortOwned(owner: number): void {
    for (const [controller, asked] of [...this.#calls]) {
      if (asked !== owner) continue;
      this.#calls.delete(controller);
      controller.abort();
    }
  }

  abortAll(): void {
    for (const controller of [...this.#calls.keys()]) controller.abort();
    this.#calls.clear();
  }
}

/**
 * A spec's stand-in for the model (`PISTACHIO_E2E_COMPLETE`, under `PISTACHIO_E2E=1` only): a JSON object of answers,
 * each keyed by a fragment of the prompt it answers, `"*"` for any other; a question none answers is one no model
 * could be asked. Null when no script is set — a spec run then asks nobody.
 */
export function scriptedComplete(env: NodeJS.ProcessEnv = process.env): ((request: CompleteRequest) => Promise<string | null>) | null {
  if (env["PISTACHIO_E2E"] !== "1") return null;
  const raw = env["PISTACHIO_E2E_COMPLETE"]?.trim() ?? "";
  if (raw === "") return null;
  let script: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    script = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  return (request) => {
    const key = Object.keys(script).find((fragment) => fragment !== "*" && request.prompt.includes(fragment)) ?? "*";
    const answer = script[key];
    return Promise.resolve(typeof answer === "string" ? answer : null);
  };
}
