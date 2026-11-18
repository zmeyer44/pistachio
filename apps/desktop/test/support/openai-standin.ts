/**
 * A stand-in for OpenAI, for the AI plan's tests (docs/ai-plans.md §7): the
 * sign-in service — discovery, signing keys, the authorize page, the token
 * endpoint with its rotating refresh tokens, revocation — and the two API
 * routes a plan uses, `/v1/models` and `/v1/responses`.
 *
 * It checks what the real one checks, so a flow that passes here was done
 * properly: PKCE (the verifier must hash to the challenge), the exact
 * redirect address, the issued client id at the token endpoint and never
 * the registration entrypoint, a refresh token that works once, a bearer
 * that is the session's current access token. ID tokens are really signed
 * (RS256) and the keys really published, so the verification is exercised.
 *
 * `handle` is a fetch: the unit tests hand it to the code as one, and the
 * e2e spec serves it over HTTP on 127.0.0.1 (`serveStandIn`).
 */

import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

export interface StandInReply {
  /** The reply's words; streamed in two parts. */
  text?: string;
  /** A function call the model makes instead. */
  call?: { name: string; arguments: Record<string, unknown> };
  /** The stream fails late, with this code (`response.failed`). */
  fail?: string;
}

export interface StandIn {
  /** Where it is served from: its issuer. Set before use. */
  origin: string;
  handle(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  /** How it behaves: changed by a test between steps. */
  knobs: {
    email: string;
    subject: string;
    /** The grant includes plan usage. */
    grantPlanUse: boolean;
    /** The person says no on the authorize page. */
    decline: boolean;
    /** The next refresh fails with this code. */
    refreshError: string | null;
    /** `/v1/responses` answers 429 with the usage-limit code. */
    limit: boolean;
    /** `/v1/responses` answers 403 with the not-eligible code. */
    ineligible: boolean;
    /** This many requests to the API answer 401 whatever the token. */
    unauthorized: number;
    /** Every access token issued so far stops being accepted (disconnected in ChatGPT's settings). */
    disconnected: boolean;
    /** The replies `/v1/responses` gives, in order; one line of text when it has run out. */
    replies: StandInReply[];
    /** The signing key no longer matches the published one: an ID token signed with it must be refused. */
    forgeIdToken: boolean;
    expiresIn: number;
  };
  /** What it was asked: read by a test to see what was sent. */
  seen: {
    authorize: URL[];
    token: URLSearchParams[];
    revoked: string[];
    models: number;
    responses: Array<{ authorization: string | null; body: Record<string, unknown> }>;
  };
}

const MODELS = [
  { slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list", supported_in_api: true },
  { slug: "gpt-5.6-terra", display_name: "GPT-5.6 Terra", visibility: "list", supported_in_api: true },
  { slug: "gpt-internal", display_name: "Internal", visibility: "hide", supported_in_api: true },
];

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function sse(events: unknown[]): Response {
  const body = events.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  // Two chunks, split inside an event, as a network would.
  const bytes = new TextEncoder().encode(body);
  const cut = Math.floor(bytes.length / 2);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, cut));
      controller.enqueue(bytes.slice(cut));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "x-request-id": "req_standin" } });
}

function replyEvents(reply: StandInReply, model: string, index: number): unknown[] {
  const id = `resp_${String(index)}`;
  const created = { type: "response.created", response: { id, created_at: 1_800_000_000, model } };
  const usage = { input_tokens: 120, input_tokens_details: { cached_tokens: 0 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 150 };
  if (reply.fail !== undefined) {
    return [
      created,
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: `msg_${String(index)}` } },
      { type: "response.output_text.delta", item_id: `msg_${String(index)}`, output_index: 0, delta: "Starting" },
      // (As OpenAI's errors do, the message names the account: it must never reach the person.)
      { type: "response.failed", sequence_number: 3, response: { error: { code: reply.fail, message: "Limit reached for user-standin-0001 (person@example.com)" } } },
    ];
  }
  if (reply.call !== undefined) {
    const item = { type: "function_call", id: `fc_${String(index)}`, call_id: `call_${String(index)}`, name: reply.call.name, namespace: "pistachio", arguments: JSON.stringify(reply.call.arguments) };
    return [
      created,
      { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments },
      { type: "response.output_item.done", output_index: 0, item: { ...item, status: "completed" } },
      { type: "response.completed", response: { id, created_at: 1_800_000_000, model, status: "completed", output: [{ ...item, status: "completed" }], usage } },
    ];
  }
  const text = reply.text ?? "Hello from your plan.";
  const half = Math.ceil(text.length / 2);
  const message = `msg_${String(index)}`;
  return [
    created,
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: message } },
    { type: "response.output_text.delta", item_id: message, output_index: 0, delta: text.slice(0, half) },
    { type: "response.output_text.delta", item_id: message, output_index: 0, delta: text.slice(half) },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", id: message } },
    // (As the real one does, the closing event carries the whole response.)
    { type: "response.completed", response: { id, created_at: 1_800_000_000, model, status: "completed", output: [{ type: "message", role: "assistant", id: message, content: [{ type: "output_text", text, annotations: [] }] }], usage } },
  ];
}

export function createStandIn(): StandIn {
  const signing = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const forged = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "standin-key-1";
  const codes = new Map<string, { challenge: string; redirectUri: string; nonce: string; clientId: string }>();
  /** client id → its live session. */
  const sessions = new Map<string, { access: string; refresh: string }>();
  let registered = 0;
  let issued = 0;
  let responses = 0;

  const standIn: StandIn = {
    origin: "https://auth.standin.test",
    knobs: {
      email: "person@example.com",
      subject: "user-standin-0001",
      grantPlanUse: true,
      decline: false,
      refreshError: null,
      limit: false,
      ineligible: false,
      unauthorized: 0,
      disconnected: false,
      replies: [],
      forgeIdToken: false,
      expiresIn: 3600,
    },
    seen: { authorize: [], token: [], revoked: [], models: 0, responses: [] },
    handle: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const route = `${request.method} ${url.pathname}`;
      switch (route) {
        case "GET /.well-known/openid-configuration":
          return json({
            issuer: standIn.origin,
            authorization_endpoint: `${standIn.origin}/api/accounts/authorize`,
            token_endpoint: `${standIn.origin}/api/accounts/oauth/token`,
            jwks_uri: `${standIn.origin}/jwks`,
            revocation_endpoint: `${standIn.origin}/api/accounts/oauth/revoke`,
          });
        case "GET /jwks":
          return json({ keys: [{ ...signing.publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" }] });
        case "GET /api/accounts/authorize":
          return authorize(url);
        case "POST /api/accounts/oauth/token":
          return token(new URLSearchParams(await request.text()));
        case "POST /api/accounts/oauth/revoke": {
          const form = new URLSearchParams(await request.text());
          standIn.seen.revoked.push(form.get("token") ?? "");
          for (const [clientId, session] of sessions) if (session.refresh === form.get("token")) sessions.delete(clientId);
          return new Response("", { status: 200 });
        }
        case "GET /v1/models": {
          standIn.seen.models += 1;
          const refused = admission(request);
          return refused ?? json({ models: MODELS });
        }
        case "POST /v1/responses": {
          const body = JSON.parse(await request.text()) as Record<string, unknown>;
          standIn.seen.responses.push({ authorization: request.headers.get("authorization"), body });
          const refused = admission(request);
          if (refused !== null) return refused;
          if (standIn.knobs.limit) return json({ error: { code: "subscription_sharing_usage_limit_exceeded", type: "rate_limit_error", message: "Usage limit exceeded for user-standin-0001 (person@example.com)" } }, 429);
          if (standIn.knobs.ineligible) return json({ error: { code: "subscription_sharing_user_not_eligible", type: "invalid_request_error", message: "Not eligible: user-standin-0001" } }, 403);
          responses += 1;
          return sse(replyEvents(standIn.knobs.replies.shift() ?? {}, typeof body["model"] === "string" ? body["model"] : "gpt-5.6-terra", responses));
        }
        default:
          return json({ error: { code: "not_found", message: route } }, 404);
      }
    },
  };

  /** The API's own check of who is asking: null when the bearer is a live session's access token. */
  function admission(request: Request): Response | null {
    if (standIn.knobs.unauthorized > 0) {
      standIn.knobs.unauthorized -= 1;
      return json({ detail: "The signed identity was not accepted for user-standin-0001" }, 401);
    }
    const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const live = !standIn.knobs.disconnected && [...sessions.values()].some((session) => session.access === bearer);
    return live ? null : json({ detail: "The signed identity was not accepted" }, 401);
  }

  function authorize(url: URL): Response {
    standIn.seen.authorize.push(url);
    const query = url.searchParams;
    const redirectUri = query.get("redirect_uri") ?? "";
    const back = new URL(redirectUri);
    back.searchParams.set("state", query.get("state") ?? "");
    const wellFormed =
      query.get("response_type") === "code" &&
      query.get("code_challenge_method") === "S256" &&
      (query.get("code_challenge") ?? "") !== "" &&
      (query.get("nonce") ?? "") !== "" &&
      /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/.test(redirectUri) &&
      query.get("resource") === `${standIn.origin}/v1` &&
      (query.get("ext_agent_host_id") ?? "").startsWith("urn:uuid:");
    if (!wellFormed) {
      back.searchParams.set("error", "invalid_request");
      return new Response(null, { status: 302, headers: { location: back.toString() } });
    }
    if (standIn.knobs.decline) {
      back.searchParams.set("error", "access_denied");
      return new Response(null, { status: 302, headers: { location: back.toString() } });
    }
    const asked = query.get("client_id") ?? "";
    const registering = asked === "dynamic_agent_client";
    // A registration is asked for by name; a returning sign-in never sends the name again.
    if (registering !== (query.get("agent_name_hint") !== null)) {
      back.searchParams.set("error", "invalid_request");
      return new Response(null, { status: 302, headers: { location: back.toString() } });
    }
    if (registering) registered += 1;
    const clientId = registering ? `oaiapp_standin_${String(registered)}` : asked;
    const code = randomBytes(12).toString("hex");
    codes.set(code, { challenge: query.get("code_challenge") ?? "", redirectUri, nonce: query.get("nonce") ?? "", clientId });
    back.searchParams.set("code", code);
    if (registering) back.searchParams.set("client_id", clientId);
    back.searchParams.set("scope", scopes());
    return new Response(null, { status: 302, headers: { location: back.toString() } });
  }

  function scopes(): string {
    return ["openid", "profile", "email", "offline_access", "resource.invoke", ...(standIn.knobs.grantPlanUse ? ["chatgpt.tokens.use.direct"] : [])].join(" ");
  }

  function idToken(clientId: string, nonce: string | null): string {
    const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const signed = `${part({ alg: "RS256", typ: "JWT", kid })}.${part({ iss: standIn.origin, aud: clientId, sub: standIn.knobs.subject, email: standIn.knobs.email, iat: now, exp: now + 3600, ...(nonce === null ? {} : { nonce }) })}`;
    const signature = createSign("RSA-SHA256")
      .update(signed)
      .sign(standIn.knobs.forgeIdToken ? forged.privateKey : signing.privateKey)
      .toString("base64url");
    return `${signed}.${signature}`;
  }

  function issue(clientId: string, nonce: string | null): Response {
    issued += 1;
    const session = { access: `at_standin_${String(issued)}`, refresh: `rt_standin_${String(issued)}` };
    sessions.set(clientId, session);
    return json({
      access_token: session.access,
      refresh_token: session.refresh,
      id_token: idToken(clientId, nonce),
      token_type: "Bearer",
      expires_in: standIn.knobs.expiresIn,
      scope: scopes(),
    });
  }

  function token(form: URLSearchParams): Response {
    standIn.seen.token.push(form);
    const clientId = form.get("client_id") ?? "";
    if (clientId === "" || clientId === "dynamic_agent_client") return json({ error: "invalid_client" }, 401);
    if (form.get("resource") !== `${standIn.origin}/v1`) return json({ error: "invalid_target" }, 400);
    if (form.get("grant_type") === "authorization_code") {
      const code = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      const matches =
        code !== undefined &&
        code.clientId === clientId &&
        code.redirectUri === form.get("redirect_uri") &&
        createHash("sha256").update(verifier).digest("base64url") === code.challenge;
      return matches ? issue(clientId, code.nonce) : json({ error: "invalid_grant" }, 400);
    }
    if (form.get("grant_type") === "refresh_token") {
      if (standIn.knobs.refreshError !== null) {
        const error = standIn.knobs.refreshError;
        standIn.knobs.refreshError = null;
        return json({ error }, 400);
      }
      const session = sessions.get(clientId);
      // A refresh token works once: its replacement is the only one that does after.
      if (session === undefined || session.refresh !== form.get("refresh_token")) return json({ error: "refresh_token_reused" }, 400);
      return issue(clientId, null);
    }
    return json({ error: "unsupported_grant_type" }, 400);
  }

  return standIn;
}

/** The stand-in over HTTP on 127.0.0.1, for a run of the real app. */
export async function serveStandIn(standIn: StandIn): Promise<{ origin: string; close(): Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(name, value);
      const method = request.method ?? "GET";
      void standIn
        .handle(new Request(`${standIn.origin}${request.url ?? "/"}`, { method, headers, ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }) }))
        .then(async (answer) => {
          response.writeHead(answer.status, Object.fromEntries(answer.headers));
          response.end(Buffer.from(await answer.arrayBuffer()));
        })
        .catch(() => {
          response.writeHead(500);
          response.end();
        });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the stand-in has no port");
  standIn.origin = `http://127.0.0.1:${String(address.port)}`;
  return {
    origin: standIn.origin,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
