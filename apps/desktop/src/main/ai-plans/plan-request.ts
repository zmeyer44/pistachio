/**
 * A model request, as the ChatGPT plan route takes it (docs/ai-plans.md §3).
 *
 * The agent's loop is Pistachio's own and speaks to OpenAI through the AI
 * SDK's OpenAI provider; a person's plan is used through the PUBLIC Responses
 * API (`POST https://api.openai.com/v1/responses`) with their OAuth access
 * token as the bearer — never ChatGPT's own backend. That route is the same
 * API with a preview's rules (developers.openai.com/siwc, "Preview
 * limitations"), and this file is where a request is made to keep them, in
 * one place, whatever the provider library sends:
 *
 * - `store: false` and `stream: true`, always; the context rides in `input`.
 * - System text is `instructions`: an explicit system-role item is rejected.
 * - Function tools go grouped in a namespace, and a function call played
 *   back as history names that namespace.
 * - The fields the route refuses are left out.
 *
 * And where what comes back is read for what the person must be told: an
 * error's code as one of a few states with something to do about each
 * (`planFailure`), a stream's own late failure (`response.failed` can carry
 * a usage limit after the first words), and what a finished response used.
 *
 * Pure but for the fetch it is handed; test/ai-plans-request.test.ts.
 */

import { CHATGPT_USAGE_URL } from "./siwc";

/** The namespace Pistachio's tools are declared in. */
export const PLAN_TOOL_NAMESPACE = "pistachio";
const PLAN_TOOL_NAMESPACE_DESCRIPTION = "Pistachio's tools: the person's browser tabs and pages, their notes, reminders, bookmarks and memory, and Pistachio's own settings.";

/** What the plan route refuses in a request body (the docs' "Unsupported fields", and conversation state over HTTP). */
export const PLAN_UNSUPPORTED_FIELDS = [
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
  "previous_response_id",
] as const;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** A system-role item's text: a string, or the text parts of a content array. */
function systemText(item: Json): string {
  const content = item["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (isObject(part) && typeof part["text"] === "string" ? part["text"] : "")).join("");
}

/**
 * A Responses request body, made the plan route's. Returns a new object; the
 * one handed in is the provider library's and is left as it was.
 */
export function planRequestBody(body: Json): Json {
  const next: Json = { ...body, store: false, stream: true };
  for (const field of PLAN_UNSUPPORTED_FIELDS) delete next[field];

  // Function tools, grouped: a namespace holds function tools only, so anything else stays where it is.
  const tools = Array.isArray(body["tools"]) ? (body["tools"] as unknown[]) : [];
  const functions = tools.filter((tool): tool is Json => isObject(tool) && tool["type"] === "function");
  const names = new Set(functions.map((tool) => tool["name"]).filter((name): name is string => typeof name === "string"));
  if (functions.length > 0) {
    const others = tools.filter((tool) => !(isObject(tool) && tool["type"] === "function"));
    next["tools"] = [...others, { type: "namespace", name: PLAN_TOOL_NAMESPACE, description: PLAN_TOOL_NAMESPACE_DESCRIPTION, tools: functions }];
  }

  // The context: a string is one user message; system-role items become `instructions`; a function call of ours
  // played back names its namespace.
  const input = typeof body["input"] === "string" ? [{ role: "user", content: body["input"] }] : Array.isArray(body["input"]) ? (body["input"] as unknown[]) : [];
  const system: string[] = [];
  const items: unknown[] = [];
  for (const item of input) {
    if (isObject(item) && item["role"] === "system" && (item["type"] === undefined || item["type"] === "message")) {
      const text = systemText(item).trim();
      if (text !== "") system.push(text);
      continue;
    }
    // Reasoning this route did not write cannot be read back by it: every reasoning item of ours carries its
    // encrypted content (the request asks for it), so one without is another model's, and is left behind.
    if (isObject(item) && item["type"] === "reasoning" && typeof item["encrypted_content"] !== "string") continue;
    if (isObject(item) && item["type"] === "function_call" && typeof item["name"] === "string" && names.has(item["name"]) && item["namespace"] === undefined) {
      items.push({ ...item, namespace: PLAN_TOOL_NAMESPACE });
      continue;
    }
    items.push(item);
  }
  next["input"] = items;
  if (system.length > 0) {
    const given = typeof body["instructions"] === "string" && body["instructions"].trim() !== "" ? [body["instructions"]] : [];
    next["instructions"] = [...given, ...system].join("\n\n");
  }
  return next;
}

/* ------------------------------ what went wrong ------------------------------ */

/**
 * A plan request's failure, as a state the person can act on:
 *
 * - `limit`: a usage limit was reached — the plan's, or the one the person
 *   set for Pistachio in ChatGPT. Plan requests pause; *Manage usage* is the
 *   way on. No reset time is known, and none is guessed.
 * - `ineligible`: plan usage is not available for this account, workspace or
 *   policy. Not retried, and not a reason to sign in again.
 * - `signIn`: the sign-in is no longer accepted (disconnected in ChatGPT, or
 *   revoked): sign in again.
 * - `unavailable`: OpenAI could not check or serve it just now: later.
 * - `refused`: the request itself is one the route does not take — a tool,
 *   an input, a model: Pistachio's to fix, or the model's to change.
 */
export type PlanFailureKind = "limit" | "ineligible" | "signIn" | "unavailable" | "refused";

export class PlanError extends Error {
  readonly kind: PlanFailureKind;
  readonly code: string | null;
  readonly status: number | null;
  readonly requestId: string | null;
  constructor(kind: PlanFailureKind, message: string, detail: { code?: string | null; status?: number | null; requestId?: string | null } = {}) {
    super(message);
    this.name = "PlanError";
    this.kind = kind;
    this.code = detail.code ?? null;
    this.status = detail.status ?? null;
    this.requestId = detail.requestId ?? null;
  }
}

/**
 * The plan's own failure inside whatever a turn ended on. The provider
 * library wraps an error thrown while it reads a response ("Failed to
 * process successful response", the `PlanError` its cause), so the sentence
 * the person can act on is looked for down the chain of causes.
 */
export function findPlanError(error: unknown): PlanError | null {
  let at: unknown = error;
  for (let depth = 0; depth < 6 && at !== null && at !== undefined; depth += 1) {
    if (at instanceof PlanError || (at instanceof Error && at.name === "PlanError")) return at as PlanError;
    at = typeof at === "object" ? (at as { cause?: unknown }).cause : null;
  }
  return null;
}

/** The sentence each state is said in. (The usage page is a link the chat draws as one.) */
export const PLAN_FAILURE_WORDS: Record<PlanFailureKind, string> = {
  limit: `Your ChatGPT plan's usage limit was reached — the plan's own, or the one set for Pistachio. [Manage usage](${CHATGPT_USAGE_URL}) in ChatGPT, or switch to Pistachio's models under Settings → AI plan.`,
  ineligible: "ChatGPT plan usage isn't available for this account or workspace. Pistachio's own models still work: switch to them under Settings → AI plan.",
  signIn: "Your ChatGPT connection expired or was disconnected. Sign in again under Settings → AI plan.",
  unavailable: "ChatGPT couldn't serve this request on your plan just now. Try again in a moment.",
  refused: "ChatGPT refused this request on your plan.",
};

const CODES: Record<string, PlanFailureKind> = {
  subscription_sharing_usage_limit_exceeded: "limit",
  subscription_sharing_workplace_individual_usage_limit_exceeded: "limit",
  subscription_sharing_user_not_eligible: "ineligible",
  subscription_sharing_invalid_user: "signIn",
  subscription_sharing_usage_unavailable: "unavailable",
  subscription_sharing_user_unavailable: "unavailable",
  subscription_sharing_unsupported_capability: "refused",
  subscription_sharing_route_not_supported: "refused",
  chatpass_v2_scope_not_authorized: "refused",
  chatpass_v2_invalid_authorization_context: "refused",
};

/** The Responses-layer error object's code and param, when a body (or a stream's `response.failed`) carries one. */
function errorFields(body: unknown): { code: string | null; param: string | null; message: string | null } {
  const error = isObject(body) && isObject(body["error"]) ? body["error"] : null;
  return {
    code: error !== null && typeof error["code"] === "string" ? error["code"] : null,
    param: error !== null && typeof error["param"] === "string" ? error["param"] : null,
    message: error !== null && typeof error["message"] === "string" ? error["message"] : null,
  };
}

/**
 * A failed plan request as one of the states above: by its code when the
 * body is the API's error object; by its status alone when it is the direct
 * route's own refusal before a request starts (`{"detail": …}`, whose words
 * are diagnostics, not a code). Null for a failure that is not the plan's to
 * explain — a 400 for a malformed body, a 500: the provider library says
 * those as it always did.
 */
export function planFailure(status: number, body: unknown, requestId: string | null = null): PlanError | null {
  const { code, param } = errorFields(body);
  const known = code === null ? undefined : CODES[code];
  if (known !== undefined) {
    const words = known === "refused" && param !== null ? `${PLAN_FAILURE_WORDS.refused} It does not take “${param}” there.` : PLAN_FAILURE_WORDS[known];
    return new PlanError(known, words, { code, status, requestId });
  }
  if (code !== null) return null;
  // Direct-route admission, before the Responses layer.
  if (status === 401) return new PlanError("signIn", PLAN_FAILURE_WORDS.signIn, { status, requestId });
  if (status === 403) return new PlanError("ineligible", PLAN_FAILURE_WORDS.ineligible, { status, requestId });
  if (status === 503) return new PlanError("unavailable", PLAN_FAILURE_WORDS.unavailable, { status, requestId });
  return null;
}

/**
 * A provider's machine-readable word — an error code, a type, a parameter
 * path — when it is one: short, and made only of what such words are made
 * of. Anything else (a sentence, an address, an identifier with an `@`) is
 * not passed on.
 */
function safeWord(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_.\-[\]]{1,80}$/.test(value) ? value : null;
}

/**
 * What is said of a failure the plan does not explain: that it happened, its
 * status and the provider's code — never the provider's own sentence, which
 * can name the account and would be kept with the thread.
 */
export function plainFailureWords(status: number | null, body: unknown): string {
  const { code, param } = errorFields(body);
  const error = isObject(body) && isObject(body["error"]) ? body["error"] : null;
  const detail = [status === null ? null : `HTTP ${String(status)}`, safeWord(code) ?? safeWord(error?.["type"]), safeWord(param)].filter((part): part is string => part !== null);
  return `ChatGPT couldn't complete this request on your plan${detail.length === 0 ? "" : ` (${detail.join(" · ")})`}.`;
}

/**
 * A failed response the provider library is handed in place of the
 * provider's own: the same status and headers (so what it retries, it still
 * retries), the body an error object whose message is Pistachio's and whose
 * code, type and parameter are the provider's where they are plain words.
 */
function plainErrorResponse(response: Response, body: unknown): Response {
  const { code, param } = errorFields(body);
  const error = isObject(body) && isObject(body["error"]) ? body["error"] : null;
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(
    JSON.stringify({ error: { message: plainFailureWords(response.status, body), type: safeWord(error?.["type"]) ?? "api_error", code: safeWord(code), param: safeWord(param) } }),
    { status: response.status, statusText: response.statusText, headers },
  );
}

/* ------------------------------ the stream ------------------------------ */

/** What a finished response used, as the route reports it. */
export interface PlanUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * A response stream, read on its way to the provider library: event by
 * event, each passed on as it completes. A completed response's usage is
 * taken for the tally. A late failure the plan explains (`response.failed`
 * — a usage limit can arrive after the first words) ends the stream with
 * that `PlanError` in place of the event, so the turn stops on the sentence
 * the person can act on rather than on the provider's raw one.
 */
export function watchPlanStream(response: Response, hooks: { failed(error: PlanError): void; used(usage: PlanUsage): void }): Response {
  if (response.body === null) return response;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = "";
  /** The plan's failure in an event, if it is one; a finished response's usage is taken on the way. */
  const read = (event: string): PlanError | null => {
    const data = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data === "" || data === "[DONE]") return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return null;
    }
    if (!isObject(parsed)) return null;
    // The stream's own error event, and a response that failed: the plan's sentence when it explains it, a plain
    // one when it does not — never the provider's.
    if (parsed["type"] === "error") {
      const body = { error: parsed };
      return planFailure(response.status, body, response.headers.get("x-request-id")) ?? new PlanError("unavailable", plainFailureWords(null, body), { code: safeWord(parsed["code"]), requestId: response.headers.get("x-request-id") });
    }
    if (!isObject(parsed["response"])) return null;
    if (parsed["type"] === "response.failed") {
      const body = { error: parsed["response"]["error"] };
      return planFailure(response.status, body, response.headers.get("x-request-id")) ?? new PlanError("unavailable", plainFailureWords(null, body), { code: safeWord(errorFields(body).code), requestId: response.headers.get("x-request-id") });
    }
    if (parsed["type"] === "response.completed") {
      const usage = parsed["response"]["usage"];
      hooks.used(isObject(usage) ? { inputTokens: Number(usage["input_tokens"]) || 0, outputTokens: Number(usage["output_tokens"]) || 0 } : { inputTokens: 0, outputTokens: 0 });
    }
    return null;
  };
  const watched = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffered += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
        for (let end = buffered.indexOf("\n\n"); end !== -1; end = buffered.indexOf("\n\n")) {
          const event = buffered.slice(0, end);
          buffered = buffered.slice(end + 2);
          const failure = read(event);
          if (failure !== null) {
            hooks.failed(failure);
            controller.error(failure);
            return;
          }
          controller.enqueue(encoder.encode(`${event}\n\n`));
        }
      },
      flush(controller) {
        if (buffered !== "") controller.enqueue(encoder.encode(buffered));
      },
    }),
  );
  return new Response(watched, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** The JSON of one server-sent event's `data:` lines; null for a comment, a keep-alive, the end marker. */
function eventData(event: string): Json | null {
  const data = event
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (data === "" || data === "[DONE]") return null;
  try {
    const parsed: unknown = JSON.parse(data);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * A response the caller asked for whole, though the route only streams: the
 * stream is read to its end and the finished response it closes with
 * (`response.completed` carries the whole of it) is handed back as the JSON
 * a request without `stream` would have had. This is what lets the calls
 * that do not stream — a compaction summary, a model scripted for a test —
 * run on the plan at all.
 */
export async function collectPlanResponse(response: Response, hooks: { failed(error: PlanError): void; used(usage: PlanUsage): void }): Promise<Response> {
  const text = (await response.text()).replace(/\r\n/g, "\n");
  let finished: Json | null = null;
  for (const event of text.split("\n\n")) {
    const parsed = eventData(event);
    if (parsed === null || !isObject(parsed["response"])) continue;
    if (parsed["type"] === "response.failed") {
      const body = { error: parsed["response"]["error"] };
      const failure = planFailure(response.status, body, response.headers.get("x-request-id")) ?? new PlanError("unavailable", plainFailureWords(null, body), { code: safeWord(errorFields(body).code), requestId: response.headers.get("x-request-id") });
      hooks.failed(failure);
      throw failure;
    } else if (parsed["type"] === "response.completed" || parsed["type"] === "response.incomplete") {
      finished = parsed["response"];
      const usage = finished["usage"];
      hooks.used(isObject(usage) ? { inputTokens: Number(usage["input_tokens"]) || 0, outputTokens: Number(usage["output_tokens"]) || 0 } : { inputTokens: 0, outputTokens: 0 });
    }
  }
  if (finished === null) throw new PlanError("unavailable", "ChatGPT's reply ended before it was complete. Try again in a moment.", { status: response.status, requestId: response.headers.get("x-request-id") });
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  return new Response(JSON.stringify(finished), { status: 200, headers });
}

/* ------------------------------ the fetch ------------------------------ */

export interface PlanFetchDeps {
  /** A usable access token — refreshed first when it is due, or when `fresh` asks. Rejects with a PlanError (`signIn`) when there is none to be had. */
  accessToken(options: { fresh: boolean }): Promise<string>;
  /** A request failed in a way the person is told of: the connection's state follows it. */
  failed(error: PlanError): void;
  /** A response finished: what it used, for Pistachio's own tally. */
  used(usage: PlanUsage): void;
  fetch?: typeof fetch;
  /** How long the route may take to begin answering. */
  headersTimeoutMs?: number;
}

/** How long a plan request may wait for its first byte: the stream after it runs as long as the turn does. */
export const PLAN_HEADERS_TIMEOUT_MS = 120_000;

/**
 * The fetch the OpenAI provider is given for a plan model: the person's
 * access token as the bearer, a `/responses` body made the route's own
 * (`planRequestBody`), a rejected token renewed once and the request sent
 * again, and a failure the plan explains thrown as a `PlanError` — whose
 * message is the sentence the conversation shows.
 */
export function planFetch(deps: PlanFetchDeps): typeof fetch {
  const send = deps.fetch ?? fetch;
  const headersTimeoutMs = deps.headersTimeoutMs ?? PLAN_HEADERS_TIMEOUT_MS;
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const isResponses = new URL(url).pathname.endsWith("/responses") && (init?.method ?? "GET").toUpperCase() === "POST";
    let body = init?.body;
    /** The caller asked for the response whole: the route still streams it, and it is put back together for them. */
    let whole = false;
    if (isResponses && typeof body === "string") {
      try {
        const asked = JSON.parse(body) as Json;
        whole = asked["stream"] !== true;
        body = JSON.stringify(planRequestBody(asked));
      } catch {
        // Not JSON: sent as it is, for the API to refuse in its own words.
      }
    }
    const attempt = async (fresh: boolean): Promise<Response> => {
      const token = await deps.accessToken({ fresh });
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${token}`);
      if (isResponses) headers.set("accept", "text/event-stream");
      // A deadline on the first byte only: the caller's signal alone ends a stream that has begun.
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), headersTimeoutMs);
      const caller = init?.signal ?? null;
      try {
        return await send(input, { ...init, ...(body === undefined || body === null ? {} : { body }), headers, signal: caller === null ? deadline.signal : AbortSignal.any([caller, deadline.signal]) });
      } catch (error) {
        if (caller?.aborted === true) throw error;
        if (deadline.signal.aborted) throw new PlanError("unavailable", `ChatGPT did not begin answering within ${String(Math.round(headersTimeoutMs / 1000))}s. Try again in a moment.`);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    };
    let response = await attempt(false);
    // A token OpenAI no longer takes: renewed once, and the same request sent again.
    if (response.status === 401) response = await attempt(true);
    if (!response.ok) {
      let parsed: unknown = null;
      const text = await response.clone().text().catch(() => "");
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      const failure = planFailure(response.status, parsed, response.headers.get("x-request-id"));
      if (failure !== null) {
        deps.failed(failure);
        throw failure;
      }
      // Not the plan's to explain: the provider library reads it as it would have (and retries what it retries),
      // from a copy that carries the status and the code and none of the provider's words.
      return plainErrorResponse(response, parsed);
    }
    if (!isResponses) return response;
    const hooks = { failed: (failure: PlanError) => deps.failed(failure), used: (usage: PlanUsage) => deps.used(usage) };
    return whole ? collectPlanResponse(response, hooks) : watchPlanStream(response, hooks);
  };
}
