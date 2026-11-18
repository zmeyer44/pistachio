/**
 * A person's own AI plan, used for the chat (docs/ai-plans.md).
 *
 * Pistachio's models come with the account and are metered; a person who
 * pays for ChatGPT can sign in with it instead, and the agent's turns then
 * run on their plan. This is what the shell knows of that: one view per
 * plan — whether it is connected, whether the chat is on it, what is wrong
 * when something is, and Pistachio's own count of what it has sent. No token
 * is ever here: the credentials stay in main, sealed (main's ai-plans/store).
 *
 * One request union and one snapshot, as extensions and notes: main
 * publishes the snapshot whenever it changes and after every request.
 */

/** The plans a person can bring. One today; every shape here is keyed by it, so another is an entry, not a redesign. */
export const AI_PLAN_PROVIDERS = ["chatgpt"] as const;
export type AiPlanProvider = (typeof AI_PLAN_PROVIDERS)[number];

/** Where the person reviews what each app used of their ChatGPT plan, and sets its limit. */
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";
/** OpenAI's own word on using a ChatGPT plan in another app. */
export const CHATGPT_PLAN_HELP_URL = "https://help.openai.com";

/**
 * - `off`: not connected (never, or signed out).
 * - `connecting`: the sign-in page is open in their browser; main is waiting for it to come back.
 * - `ready`: signed in, and plan usage is granted.
 * - `limit`: a usage limit was reached — the plan's, or the one set for Pistachio in ChatGPT. Plan requests are
 *   paused until the person says to try again; nothing is known of when it lifts, and nothing is guessed.
 * - `signIn`: the sign-in lapsed, or Pistachio was disconnected in ChatGPT: sign in again.
 * - `ineligible`: signed in, but plan usage is not available to this account, workspace or policy.
 */
export type AiPlanStatus = "off" | "connecting" | "ready" | "limit" | "signIn" | "ineligible";

/** What last went wrong, as a kind the shell picks its actions by. */
export type AiPlanTroubleKind =
  | "limit"
  | "ineligible"
  | "signIn"
  /** The provider could not serve or check it just now: nothing changed, later. */
  | "unavailable"
  /** The request was one the plan's route does not take. */
  | "refused"
  /** The person said no on the sign-in page, or closed it. */
  | "declined"
  /** The sign-in did not complete, for the reason in the sentence. */
  | "failed";

export interface AiPlanTrouble {
  kind: AiPlanTroubleKind;
  /** A sentence for the person: never the provider's raw answer. */
  message: string;
  at: string;
}

/** One day of what Pistachio sent on the plan: its own count, not the provider's meter. */
export interface AiPlanUsageDay {
  /** The day on this Mac's clock, `YYYY-MM-DD`. */
  day: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

export interface AiPlanModel {
  /** What a request names. */
  id: string;
  /** What the picker shows. */
  name: string;
}

export interface AiPlanView {
  provider: AiPlanProvider;
  status: AiPlanStatus;
  /** The person's choice: the chat runs on this plan whenever it can. */
  chosen: boolean;
  /** The next turn runs on it: chosen, and `ready`. */
  inUse: boolean;
  /** The account signed in, as its verified ID token named it. */
  email: string | null;
  connectedAt: string | null;
  /** The last request the plan served. */
  lastUsedAt: string | null;
  /** What last went wrong; cleared by the next request that works. */
  trouble: AiPlanTrouble | null;
  /** The model turns ask for, and the account's catalog as last read (empty until it has been). */
  model: string | null;
  models: AiPlanModel[];
  /** The last 30 days with anything in them, oldest first. */
  usage: AiPlanUsageDay[];
  /** The first-sign-in confirmation is still to be shown: once, ever. */
  welcome: boolean;
  /** Signed out here, but the provider did not confirm it ended the session: said once, with where to finish it. */
  unconfirmedSignOut: boolean;
}

export interface AiPlansSnapshot {
  plans: AiPlanView[];
}

export const EMPTY_AI_PLANS_SNAPSHOT: AiPlansSnapshot = { plans: [] };

export type AiPlanRequest =
  /** The hello: answer with what you have. */
  | { type: "get" }
  /**
   * Open the sign-in page and wait for it: answers once the page is open, not once the person is done. `fresh`
   * forgets the account last connected first, so whoever signs in is a new registration (*Use a different account*).
   */
  | { type: "connect"; provider: AiPlanProvider; fresh?: boolean }
  /** Stop waiting for a sign-in page. */
  | { type: "cancel"; provider: AiPlanProvider }
  /** Sign out: end the session at the provider, and forget the tokens here. */
  | { type: "disconnect"; provider: AiPlanProvider }
  /** Whether the chat runs on the plan. */
  | { type: "choose"; provider: AiPlanProvider; chosen: boolean }
  | { type: "model"; provider: AiPlanProvider; model: string }
  /** The first-sign-in confirmation was read. */
  | { type: "welcomed"; provider: AiPlanProvider }
  /** After a limit: try the plan again from the next turn. */
  | { type: "resume"; provider: AiPlanProvider }
  /** Open the provider's usage page, in the browser the person signed in with. */
  | { type: "manageUsage"; provider: AiPlanProvider }
  /** Read the account's models again. */
  | { type: "refresh"; provider: AiPlanProvider };

export type AiPlanResponse = { type: "ok"; snapshot: AiPlansSnapshot };

export function isAiPlanProvider(value: unknown): value is AiPlanProvider {
  return typeof value === "string" && (AI_PLAN_PROVIDERS as readonly string[]).includes(value);
}

const REQUEST_TYPES = new Set(["get", "connect", "cancel", "disconnect", "choose", "model", "welcomed", "resume", "manageUsage", "refresh"]);

/** A request from another process, checked: null when it is not one. */
export function parseAiPlanRequest(value: unknown): AiPlanRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const request = value as Record<string, unknown>;
  const type = request["type"];
  if (typeof type !== "string" || !REQUEST_TYPES.has(type)) return null;
  if (type === "get") return { type };
  const provider = request["provider"];
  if (!isAiPlanProvider(provider)) return null;
  if (type === "choose") return typeof request["chosen"] === "boolean" ? { type, provider, chosen: request["chosen"] } : null;
  if (type === "model") {
    const model = request["model"];
    return typeof model === "string" && model.length > 0 && model.length <= 120 ? { type, provider, model } : null;
  }
  if (type === "connect") return request["fresh"] === true ? { type, provider, fresh: true } : { type, provider };
  return { type: type as Exclude<AiPlanRequest["type"], "get" | "choose" | "model" | "connect">, provider };
}

/** The plan the next turn runs on, if any. */
export function planInUse(snapshot: AiPlansSnapshot): AiPlanView | null {
  return snapshot.plans.find((plan) => plan.inUse) ?? null;
}

/** What a plan is called, where one is named. */
export const AI_PLAN_NAMES: Record<AiPlanProvider, { product: string; plan: string; using: string; connect: string }> = {
  chatgpt: { product: "ChatGPT", plan: "ChatGPT plan", using: "Using ChatGPT plan", connect: "Continue with ChatGPT" },
};

/** A 30-day summary of Pistachio's own count: the total, the busiest day, the days with anything in them. */
export function summarizePlanUsage(days: readonly AiPlanUsageDay[]): { requests: number; tokens: number; peakRequests: number; activeDays: number } {
  let requests = 0;
  let tokens = 0;
  let peakRequests = 0;
  let activeDays = 0;
  for (const day of days) {
    requests += day.requests;
    tokens += day.inputTokens + day.outputTokens;
    if (day.requests > peakRequests) peakRequests = day.requests;
    if (day.requests > 0) activeDays += 1;
  }
  return { requests, tokens, peakRequests, activeDays };
}
