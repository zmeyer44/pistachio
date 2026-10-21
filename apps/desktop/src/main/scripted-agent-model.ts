/**
 * A spec's stand-in for the agent's model (`PISTACHIO_AGENT_SCRIPT`, under
 * `PISTACHIO_E2E=1`; docs/desk-agent.md §4): the turns run through the real
 * runner, tools and controller, and only the model's choices are scripted.
 *
 * The script is a queue of steps, taken one per model call across the whole
 * session: a step calls tools, answers (which ends the turn), or fails (the
 * model call throws, as a provider's outage would, which fails the run). A
 * spec does not know tab or item ids in advance, so a string in a tool's
 * input may name them by what the prompt shows: `{{tab:Flight}}` is the tab whose
 * title or address contains "Flight" in the latest desk block or tab list
 * the model was sent, and `{{item:boarding}}` the context item whose name or
 * text contains "boarding".
 *
 * A script with `stream: true` is streamed, as the configured model's turns
 * are (RunController's `stream`): a step's `reasoning` comes first, word by
 * word over `streamMs`, then its tool calls or its answer, the answer's
 * words spread over `streamMs` too — for a spec that watches a turn be
 * written.
 */

import type { LanguageModel } from "ai";

interface ScriptStep {
  /** Tools to call in this step, in order. */
  tools?: Array<{ name: string; input: Record<string, unknown> }>;
  /** The reply that ends the turn. */
  text?: string;
  /** The model call fails with this message instead. */
  error?: string;
  /** Wait this long first (a turn a spec watches while it works). */
  delayMs?: number;
  /** What the model thinks before it acts or answers (a streamed script's alone). */
  reasoning?: string;
  /** How long a streamed step takes to write its reasoning, and again its answer (600 ms when absent). */
  streamMs?: number;
}

/** The script's own word on streaming (`stream: true`), read as scriptedAgentModel reads the script. */
export function scriptedAgentStreams(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env["PISTACHIO_E2E"] !== "1") return false;
  try {
    return (JSON.parse(env["PISTACHIO_AGENT_SCRIPT"]?.trim() ?? "") as { stream?: unknown }).stream === true;
  } catch {
    return false;
  }
}

/** A text's words, each with the space before it: the deltas a stream writes it in. */
function words(text: string): string[] {
  return text.match(/\s*\S+/g) ?? [];
}

type GenerateOptions = { prompt: unknown };

let nextCall = 0;

/** The tab and item ids the prompt names, latest last. */
function namesIn(prompt: unknown): { tabs: Array<{ id: string; label: string }>; items: Array<{ id: string; label: string }> } {
  const text = JSON.stringify(prompt);
  const tabs: Array<{ id: string; label: string }> = [];
  // The desk block's "tab <id> “title” url", and a tabs_list result's JSON.
  for (const match of text.matchAll(/- tab ([A-Za-z0-9-]+) “([^”]*)” (\S*)/g)) tabs.push({ id: match[1]!, label: `${match[2]!} ${match[3]!}` });
  for (const match of text.matchAll(/\\?"id\\?":\\?"([A-Za-z0-9-]+)\\?",\\?"spaceId\\?":\\?"[^"\\]*\\?",\\?"title\\?":\\?"([^"\\]*)\\?",\\?"url\\?":\\?"([^"\\]*)/g))
    tabs.push({ id: match[1]!, label: `${match[2]!} ${match[3]!}` });
  const items: Array<{ id: string; label: string }> = [];
  for (const match of text.matchAll(/- ([0-9a-f]{12}) (?:file|fact|snippet|link) “([^”]*)”/g)) items.push({ id: match[1]!, label: match[2]! });
  return { tabs, items };
}

function resolve(value: unknown, names: ReturnType<typeof namesIn>): unknown {
  if (typeof value === "string") {
    return value.replace(/\{\{(tab|item):([^}]+)\}\}/g, (whole, kind: string, needle: string) => {
      const pool = kind === "tab" ? names.tabs : names.items;
      const found = [...pool].reverse().find((entry) => entry.label.toLowerCase().includes(needle.toLowerCase()));
      return found?.id ?? whole;
    });
  }
  if (Array.isArray(value)) return value.map((entry) => resolve(entry, names));
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolve(entry, names)]));
  return value;
}

export function scriptedAgentModel(env: NodeJS.ProcessEnv = process.env): (() => LanguageModel) | null {
  if (env["PISTACHIO_E2E"] !== "1") return null;
  const raw = env["PISTACHIO_AGENT_SCRIPT"]?.trim() ?? "";
  if (raw === "") return null;
  let steps: ScriptStep[];
  try {
    const parsed = JSON.parse(raw) as { steps?: ScriptStep[] };
    steps = Array.isArray(parsed.steps) ? parsed.steps : [];
  } catch {
    return null;
  }
  const queue = [...steps];
  const usage = {
    inputTokens: { total: 1_000, noCache: 1_000, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 20, text: 20, reasoning: undefined },
  };
  const model = {
    specificationVersion: "v4",
    provider: "pistachio-e2e",
    modelId: "scripted-agent",
    supportedUrls: {},
    doGenerate: async ({ prompt }: GenerateOptions) => {
      const step = queue.shift() ?? { text: "The script has nothing more to say." };
      if (step.delayMs !== undefined && step.delayMs > 0) await new Promise((done) => setTimeout(done, step.delayMs));
      if (step.error !== undefined) throw new Error(step.error);
      const names = namesIn(prompt);
      if (step.tools !== undefined && step.tools.length > 0) {
        return {
          content: step.tools.map((call) => ({
            type: "tool-call" as const,
            toolCallId: `scripted-${String(++nextCall)}`,
            toolName: call.name,
            input: JSON.stringify(resolve(call.input, names)),
          })),
          finishReason: { unified: "tool-calls", raw: "tool_use" },
          usage,
          warnings: [],
        };
      }
      return { content: [{ type: "text" as const, text: step.text ?? "" }], finishReason: { unified: "stop", raw: "end_turn" }, usage, warnings: [] };
    },
    doStream: async ({ prompt }: GenerateOptions) => {
      const step = queue.shift() ?? { text: "The script has nothing more to say." };
      if (step.delayMs !== undefined && step.delayMs > 0) await new Promise((done) => setTimeout(done, step.delayMs));
      if (step.error !== undefined) throw new Error(step.error);
      const names = namesIn(prompt);
      const spread = step.streamMs ?? 600;
      const parts: Array<{ part: Record<string, unknown>; after: number }> = [{ part: { type: "stream-start", warnings: [] }, after: 0 }];
      const write = (kind: "reasoning" | "text", text: string): void => {
        const id = `${kind}-${String(++nextCall)}`;
        const each = words(text);
        parts.push({ part: { type: `${kind}-start`, id }, after: 0 });
        for (const word of each) parts.push({ part: { type: `${kind}-delta`, id, delta: word }, after: spread / Math.max(1, each.length) });
        parts.push({ part: { type: `${kind}-end`, id }, after: 0 });
      };
      if (step.reasoning !== undefined && step.reasoning !== "") write("reasoning", step.reasoning);
      const calls = step.tools ?? [];
      if (calls.length > 0) {
        for (const call of calls)
          parts.push({
            part: { type: "tool-call", toolCallId: `scripted-${String(++nextCall)}`, toolName: call.name, input: JSON.stringify(resolve(call.input, names)) },
            after: 0,
          });
      } else write("text", step.text ?? "");
      parts.push({ part: { type: "finish", finishReason: calls.length > 0 ? { unified: "tool-calls", raw: "tool_use" } : { unified: "stop", raw: "end_turn" }, usage }, after: 0 });
      let next = 0;
      const stream = new ReadableStream<Record<string, unknown>>({
        async pull(controller) {
          const entry = parts[next++];
          if (entry === undefined) {
            controller.close();
            return;
          }
          if (entry.after > 0) await new Promise((done) => setTimeout(done, entry.after));
          controller.enqueue(entry.part);
        },
      });
      return { stream };
    },
  };
  return () => model as unknown as LanguageModel;
}
