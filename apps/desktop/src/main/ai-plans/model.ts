/**
 * The model a turn runs on when the chat is on the person's ChatGPT plan
 * (docs/ai-plans.md §3), and the account's catalog.
 *
 * The agent's loop is unchanged: it is handed a `LanguageModel` as it always
 * was. This one is the AI SDK's OpenAI provider speaking the Responses API
 * at `https://api.openai.com/v1`, through `planFetch` — which puts the
 * person's token on each request and makes the body the plan route's
 * (./plan-request.ts). The provider's own key is a placeholder that never
 * reaches the wire.
 *
 * `store: false` is asked of the library too, not only set on the body: it
 * is what makes it send the conversation whole (reasoning with its encrypted
 * content, never a reference to an item the server was to have kept).
 */

import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { AiPlanModel } from "@pistachio/shell-contracts/ai-plans";

/** The model asked for when the person has chosen none, if the account lists it: the one Pistachio's own turns use. */
export const PREFERRED_PLAN_MODELS = ["gpt-5.6-terra", "gpt-5.6"] as const;

/** What a plan turn asks of the provider library on every step. */
export const PLAN_PROVIDER_OPTIONS = { openai: { store: false, reasoningSummary: "auto" } } as const;

/** The name a plan turn's model is recorded under: which plan, then the model. */
export function planModelName(model: string): string {
  return `chatgpt-plan/${model}`;
}

export function planLanguageModel(input: { api: string; model: string; fetch: typeof fetch }): LanguageModel {
  return createOpenAI({ baseURL: input.api, apiKey: "chatgpt-plan", fetch: input.fetch }).responses(input.model);
}

/**
 * The account's models, as `GET /models` lists them for this token: those
 * meant for a picker (`visibility: "list"`), in the server's order.
 */
export function readPlanModels(body: unknown): AiPlanModel[] {
  const list = typeof body === "object" && body !== null ? (body as { models?: unknown }).models : null;
  if (!Array.isArray(list)) return [];
  const models: AiPlanModel[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const model = entry as Record<string, unknown>;
    const slug = model["slug"];
    if (typeof slug !== "string" || slug === "" || model["visibility"] !== "list" || model["supported_in_api"] === false) continue;
    models.push({ id: slug, name: typeof model["display_name"] === "string" && model["display_name"] !== "" ? model["display_name"] : slug });
  }
  return models;
}

/** The model a turn asks for: the person's choice while the account lists it, else the preferred one it lists, else its first. */
export function pickPlanModel(chosen: string | null, models: readonly AiPlanModel[]): string {
  if (models.length === 0) return chosen ?? PREFERRED_PLAN_MODELS[0];
  if (chosen !== null && models.some((model) => model.id === chosen)) return chosen;
  for (const preferred of PREFERRED_PLAN_MODELS) if (models.some((model) => model.id === preferred)) return preferred;
  return models[0]!.id;
}
