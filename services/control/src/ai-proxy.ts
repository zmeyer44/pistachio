/**
 * The model proxy: `/v1/ai/*` forwarded to the Vercel AI Gateway under the
 * operator's key (`AI_GATEWAY_API_KEY`).
 *
 * The desktop runs the AI SDK itself — the agent loop lives next to the
 * tabs it drives — but it never holds a provider key. Its gateway provider
 * is pointed at this route (`createGateway({baseURL: <control>/v1/ai})`),
 * so every request arrives bearing a device JWT, which the `v1` auth tier
 * has already verified before this handler runs: device-only (a bootstrap
 * token is refused with `device_required`), and never a cloud device — the
 * cloud browser carries its own key.
 *
 * The SDK's protocol lives in the `ai-*` headers and the JSON body. The
 * credential is swapped and no-training routing is enforced on the JSON
 * body, even for older clients. Responses stream back as they arrive, so a
 * language-model stream reaches the desktop chunk by chunk.
 *
 * Every request is metered (ai-usage.ts): the answer streams through a
 * reader that picks the tokens and cost off it, and `onUsage` gets one
 * sample per request once the body has ended — however it ended.
 *
 * With no key configured the route is CLOSED (503), never open.
 */

import type { Context } from "hono";
import { gatewayPrivacyFetch } from "@pistachio/runtime";
import { meteredBody, usageKindOf, type AiUsageSample, type ExtractedUsage, NO_USAGE } from "./ai-usage.js";
import type { AppEnv } from "./env.js";

export const AI_GATEWAY_KEY_ENV = "AI_GATEWAY_API_KEY";
export const AI_GATEWAY_URL_ENV = "AI_GATEWAY_URL";
/** Where `@ai-sdk/gateway` points by default; overridden by AI_GATEWAY_URL. */
export const DEFAULT_AI_GATEWAY_URL = "https://ai-gateway.vercel.sh/v4/ai";
/** The route prefix the desktop's provider is given as its base URL. */
export const AI_PROXY_PREFIX = "/v1/ai";

/**
 * A model request that streams for longer than this is cut. The desktop
 * gives up on a request after three minutes (its own bounded fetch); this
 * only needs to be the outer bound, so a dead upstream does not hold a
 * connection open forever.
 */
export const AI_PROXY_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Request headers that reach the gateway. Everything the SDK says about the
 * call is in `ai-*`; the rest is what any HTTP client needs. Notably absent:
 * `authorization` (replaced), `host`/`content-length` (recomputed), and
 * `accept-encoding` — the upstream body is decoded here before it is
 * streamed on, so the encoding header must not be echoed either.
 */
const FORWARDED_REQUEST_HEADERS: ReadonlySet<string> = new Set(["accept", "content-type", "user-agent"]);

/** Response headers that never survive a proxy hop. */
const DROPPED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "transfer-encoding",
]);

export interface AiProxyOptions {
  env: Record<string, string | undefined>;
  /** Injectable for tests; global `fetch` otherwise. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** One sample per proxied request, after its answer has fully streamed. */
  onUsage?: (sample: AiUsageSample) => void;
  /** Answers instead of forwarding — the account's spend cap, reached. */
  guard?: (c: Context<AppEnv>) => Promise<Response | null>;
  now?: () => number;
}

/** True when a key is configured, which is when `/v1/ai/*` answers at all. */
export function aiGatewayConfigured(env: Record<string, string | undefined>): boolean {
  return (env[AI_GATEWAY_KEY_ENV]?.trim() ?? "") !== "";
}

/** The upstream address for one proxied request, or null off the prefix. */
export function upstreamUrl(base: string, requestUrl: string): string | null {
  const url = new URL(requestUrl);
  if (url.pathname !== AI_PROXY_PREFIX && !url.pathname.startsWith(`${AI_PROXY_PREFIX}/`)) return null;
  const rest = url.pathname.slice(AI_PROXY_PREFIX.length);
  return `${base.replace(/\/+$/, "")}${rest}${url.search}`;
}

export function upstreamHeaders(incoming: Headers, apiKey: string): Headers {
  const headers = new Headers();
  for (const [name, value] of incoming) {
    if (FORWARDED_REQUEST_HEADERS.has(name) || name.startsWith("ai-")) headers.set(name, value);
  }
  headers.set("authorization", `Bearer ${apiKey}`);
  // The SDK marks how it authenticated so the gateway can word a refusal;
  // whatever the desktop sent, what reaches the gateway is the key.
  headers.set("ai-gateway-auth-method", "api-key");
  return headers;
}

export function downstreamHeaders(upstream: Headers): Headers {
  const headers = new Headers();
  for (const [name, value] of upstream) {
    if (!DROPPED_RESPONSE_HEADERS.has(name)) headers.set(name, value);
  }
  return headers;
}

export function aiProxyHandler(options: AiProxyOptions): (c: Context<AppEnv>) => Promise<Response> {
  const fetchImpl = gatewayPrivacyFetch(options.fetchImpl ?? fetch);
  const timeoutMs = options.timeoutMs ?? AI_PROXY_TIMEOUT_MS;
  const now = options.now ?? ((): number => Date.now());
  return async (c) => {
    // Read per request, like the service secrets, so a rotated key needs no restart.
    const apiKey = options.env[AI_GATEWAY_KEY_ENV]?.trim() ?? "";
    if (apiKey === "") return c.json({ error: "unavailable", reason: "ai_gateway_unconfigured" }, 503);
    const base = options.env[AI_GATEWAY_URL_ENV]?.trim() || DEFAULT_AI_GATEWAY_URL;
    const target = upstreamUrl(base, c.req.url);
    if (target === null) return c.json({ error: "not_found" }, 404);
    const refused = options.guard === undefined ? null : await options.guard(c);
    if (refused !== null) return refused;
    const method = c.req.method;
    const hasBody = method !== "GET" && method !== "HEAD";
    // The body is read whole rather than piped: the SDK sends JSON (a
    // spoken introduction is the largest, base64 inside it), the app-wide
    // body limit already bounds it, and a buffered body can be resent by
    // the runtime on a dropped connection where a stream cannot.
    const body = hasBody ? await c.req.raw.arrayBuffer() : undefined;
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(timeoutMs)]);
    const startedAt = now();
    // The tier above guarantees a device; the meter needs it named.
    const userId = c.get("userId");
    const deviceId = c.get("deviceId") ?? "00000000-0000-0000-0000-000000000000";
    const meter = (status: number, responseBytes: number, usage: ExtractedUsage): void => {
      options.onUsage?.({
        userId,
        deviceId,
        kind: usageKindOf(new URL(c.req.url).pathname, AI_PROXY_PREFIX),
        modelId: c.req.header("ai-model-id")?.trim() || null,
        status,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd: usage.costUsd,
        requestBytes: body?.byteLength ?? 0,
        responseBytes,
        durationMs: Math.max(0, now() - startedAt),
        at: new Date(startedAt),
      });
    };
    let upstream: Response;
    try {
      upstream = await fetchImpl(target, {
        method,
        headers: upstreamHeaders(c.req.raw.headers, apiKey),
        ...(body === undefined ? {} : { body }),
        signal,
      });
    } catch (error) {
      // A request that never got an answer still spent time on the account's
      // behalf: it is counted, with no status.
      meter(0, 0, NO_USAGE);
      // The desktop hung up first: nothing to answer, and nothing to log as a failure.
      if (c.req.raw.signal.aborted) return new Response(null, { status: 499 });
      const reason = error instanceof Error ? error.message : String(error);
      return c.json({ error: "upstream_unreachable", explanation: `The model gateway did not answer: ${reason}` }, 502);
    }
    const metered = meteredBody(upstream.body, upstream.headers.get("content-type"), (outcome) =>
      meter(upstream.status, outcome.responseBytes, outcome.usage),
    );
    return new Response(metered, { status: upstream.status, headers: downstreamHeaders(upstream.headers) });
  };
}
