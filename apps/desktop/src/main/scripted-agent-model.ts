/**
 * A spec's stand-in for the agent's model (`PISTACHIO_AGENT_SCRIPT`, under
 * `PISTACHIO_E2E=1`; docs/desk-agent.md §4): the turns run through the real
 * runner, tools and controller, and only the model's choices are scripted.
 *
 * The script is a queue of steps, taken one per model call across the whole
 * session: a step calls tools, or answers (which ends the turn). A spec does
 * not know tab or item ids in advance, so a string in a tool's input may
 * name them by what the prompt shows: `{{tab:Flight}}` is the tab whose
 * title or address contains "Flight" in the latest desk block or tab list
 * the model was sent, and `{{item:boarding}}` the context item whose name or
 * text contains "boarding".
 */

import type { LanguageModel } from "ai";

interface ScriptStep {
  /** Tools to call in this step, in order. */
  tools?: Array<{ name: string; input: Record<string, unknown> }>;
  /** The reply that ends the turn. */
  text?: string;
  /** Wait this long first (a turn a spec watches while it works). */
  delayMs?: number;
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
    doStream: () => Promise.reject(new Error("the scripted model does not stream")),
  };
  return () => model as unknown as LanguageModel;
}
