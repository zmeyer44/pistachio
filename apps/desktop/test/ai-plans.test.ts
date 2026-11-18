/**
 * A person's ChatGPT plan, connected (docs/ai-plans.md): the sign-in, the
 * request as the plan's route takes it, what is kept, and the service that
 * holds them together — against a stand-in for OpenAI that checks what the
 * real one checks (test/support/openai-standin.ts). Nothing here touches
 * the network or the Mac's keychain.
 */

import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateText, streamText, tool, type ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AiPlanView, AiPlansSnapshot } from "@pistachio/shell-contracts/ai-plans";
import type { CallbackOutcome } from "../src/main/ai-plans/callback";
import { PISTACHIO_MODELS, portableHistory } from "../src/main/ai-plans/history";
import { pickPlanModel, readPlanModels } from "../src/main/ai-plans/model";
import { PLAN_TOOL_NAMESPACE, PlanError, findPlanError, planFailure, planFetch, planRequestBody } from "../src/main/ai-plans/plan-request";
import { AiPlanService, PAUSED_FOR_LIMIT, type PlanTurn } from "../src/main/ai-plans/service";
import { REGISTRATION_CLIENT_ID, SiwcError, authorizeUrl, discover, newAttempt, readCallback, verifyIdToken } from "../src/main/ai-plans/siwc";
import { AI_PLANS_FILE, AiPlanStore, tallyUsage, type PlanCipher } from "../src/main/ai-plans/store";
import { createStandIn, type StandIn } from "./support/openai-standin";

/** A keychain that can be taken away: what it seals is not the text. */
function cipher(): PlanCipher & { on: boolean } {
  const state = {
    on: true,
    available: () => state.on,
    encrypt: (plain: string) => `sealed:${Buffer.from(plain, "utf8").toString("base64")}`,
    decrypt: (sealed: string) => {
      if (!sealed.startsWith("sealed:")) throw new Error("not sealed here");
      return Buffer.from(sealed.slice(7), "base64").toString("utf8");
    },
  };
  return state;
}

interface Rig {
  standIn: StandIn;
  service: AiPlanService;
  store: AiPlanStore;
  path: string;
  keychain: ReturnType<typeof cipher>;
  /** Every snapshot published, oldest first. */
  published: AiPlansSnapshot[];
  opened: string[];
  /** What the browser was shown when the sign-in came back. */
  outcomes: CallbackOutcome[];
  clock: { now: number };
  plan(): AiPlanView;
  connect(options?: { fresh?: boolean }): Promise<void>;
  /** A service over the same file, as after a relaunch. */
  relaunch(): AiPlanService;
}

function rig(options: { path?: string; standIn?: StandIn } = {}): Rig {
  const standIn = options.standIn ?? createStandIn();
  const path = options.path ?? join(mkdtempSync(join(tmpdir(), "ai-plans-")), AI_PLANS_FILE);
  const keychain = cipher();
  const clock = { now: Date.now() };
  const published: AiPlansSnapshot[] = [];
  const opened: string[] = [];
  const outcomes: CallbackOutcome[] = [];
  let answer: ((search: URLSearchParams) => Promise<CallbackOutcome>) | null = null;
  let done: Promise<void> = Promise.resolve();
  const make = (): { service: AiPlanService; store: AiPlanStore } => {
    const store = new AiPlanStore(path, keychain);
    const service = new AiPlanService({
      store,
      fetch: standIn.handle,
      endpoints: { issuer: standIn.origin, authorize: `${standIn.origin}/api/accounts/authorize`, token: `${standIn.origin}/api/accounts/oauth/token`, api: `${standIn.origin}/v1` },
      discoveryUrl: `${standIn.origin}/.well-known/openid-configuration`,
      now: () => clock.now,
      onChange: (snapshot) => published.push(snapshot),
      listen: (handle) => {
        answer = handle;
        return Promise.resolve({ port: 49152, close: () => undefined });
      },
      // The person's browser: it follows the authorize page's redirect back to the loopback callback.
      openExternal: (url) => {
        opened.push(url);
        if (!url.startsWith(standIn.origin)) return;
        done = (async () => {
          const page = await standIn.handle(url);
          const back = page.headers.get("location");
          if (back === null || answer === null) return;
          outcomes.push(await answer(new URL(back).searchParams));
        })();
      },
    });
    return { service, store };
  };
  const first = make();
  const self: Rig = {
    standIn,
    service: first.service,
    store: first.store,
    path,
    keychain,
    published,
    opened,
    outcomes,
    clock,
    plan: () => self.service.snapshot().plans[0]!,
    connect: async (asked = {}) => {
      await self.service.request({ type: "connect", provider: "chatgpt", ...(asked.fresh === true ? { fresh: true } : {}) });
      await done;
      // (The catalog is read once the sign-in is in: let it land.)
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    relaunch: () => {
      const next = make();
      self.service = next.service;
      self.store = next.store;
      return next.service;
    },
  };
  return self;
}

/**
 * A turn's words, drained the way the runner drains them: an error part is
 * kept and thrown once the stream ends, and a rejection is what it is. Either
 * way the plan's own failure is what is thrown when there is one inside — as
 * the run controller reads it (`findPlanError`): the provider library wraps
 * an error it meets while reading a response.
 */
async function say(turn: PlanTurn | null, prompt = "Say hello"): Promise<string> {
  if (turn === null || "blocked" in turn) throw new Error("no plan model for this turn");
  let text = "";
  try {
    const result = streamText({ model: turn.model, prompt, providerOptions: turn.providerOptions, maxRetries: 0 });
    let failure: unknown = null;
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") text += part.text;
      if (part.type === "error") failure = part.error;
    }
    if (failure !== null) throw failure;
  } catch (error) {
    throw findPlanError(error) ?? error;
  }
  return text;
}

describe("signing in with ChatGPT", () => {
  it("asks for a new registration by name, and for a returning one by its issued id — never both", () => {
    const endpoints = { authorize: "https://auth.example/api/accounts/authorize", api: "https://api.example/v1" };
    const attempt = newAttempt(51234);
    const first = new URL(authorizeUrl(endpoints, attempt, "urn:uuid:host", null)).searchParams;
    expect(first.get("client_id")).toBe(REGISTRATION_CLIENT_ID);
    expect(first.get("agent_name_hint")).toBe("Pistachio");
    expect(first.get("redirect_uri")).toBe("http://127.0.0.1:51234/auth/callback");
    expect(first.get("scope")).toBe("openid profile email offline_access resource.invoke chatgpt.tokens.use.direct");
    expect(first.get("resource")).toBe("https://api.example/v1");
    expect(first.get("code_challenge_method")).toBe("S256");
    expect(first.get("ext_agent_host_id")).toBe("urn:uuid:host");
    expect(first.has("prompt")).toBe(false);

    const again = new URL(authorizeUrl(endpoints, attempt, "urn:uuid:host", { clientId: "oaiapp_1", idToken: "id.token.kept", email: "person@example.com" }, { consent: true })).searchParams;
    expect(again.get("client_id")).toBe("oaiapp_1");
    expect(again.has("agent_name_hint")).toBe(false);
    expect(again.get("id_token_hint")).toBe("id.token.kept");
    expect(again.get("login_hint")).toBe("person@example.com");
    expect(again.get("prompt")).toBe("consent");
  });

  it("takes a callback only for the attempt it answers, and only under the registration it is for", () => {
    const attempt = newAttempt(51234);
    const back = (params: Record<string, string>): URLSearchParams => new URLSearchParams({ state: attempt.state, ...params });
    expect(readCallback(back({ code: "c1", client_id: "oaiapp_1" }), attempt, null)).toEqual({ code: "c1", clientId: "oaiapp_1" });
    expect(readCallback(back({ code: "c1" }), attempt, { clientId: "oaiapp_1", idToken: null, email: null })).toEqual({ code: "c1", clientId: "oaiapp_1" });
    const kind = (run: () => unknown): string => {
      try {
        run();
      } catch (error) {
        return error instanceof SiwcError ? error.kind : "other";
      }
      return "none";
    };
    expect(kind(() => readCallback(new URLSearchParams({ state: "another", code: "c1", client_id: "oaiapp_1" }), attempt, null))).toBe("mismatch");
    expect(kind(() => readCallback(back({ error: "access_denied" }), attempt, null))).toBe("declined");
    // A registration with no issued id is not one; nor is the entrypoint's own name an id.
    expect(kind(() => readCallback(back({ code: "c1" }), attempt, null))).toBe("rejected");
    expect(kind(() => readCallback(back({ code: "c1", client_id: REGISTRATION_CLIENT_ID }), attempt, null))).toBe("rejected");
    // A returning sign-in answered for another registration never replaces the saved one.
    expect(kind(() => readCallback(back({ code: "c1", client_id: "oaiapp_2" }), attempt, { clientId: "oaiapp_1", idToken: null, email: null }))).toBe("mismatch");
  });

  it("takes signing keys only from the issuer's own origin", async () => {
    const base = { issuer: "https://auth.example", authorize: "https://auth.example/a", token: "https://auth.example/t", api: "https://api.example/v1" };
    const serving = (document: unknown): typeof fetch => () => Promise.resolve(new Response(JSON.stringify(document), { status: 200 }));
    const good = await discover(serving({ jwks_uri: "https://auth.example/jwks", revocation_endpoint: "https://elsewhere.example/revoke" }), base, "https://auth.example/.well-known/openid-configuration");
    expect(good.jwks).toBe("https://auth.example/jwks");
    // (A revocation endpoint elsewhere is not used: sign-out is then local, and says so.)
    expect(good.revocation).toBeNull();
    await expect(discover(serving({ jwks_uri: "https://elsewhere.example/jwks" }), base, "https://auth.example/.well-known/openid-configuration")).rejects.toMatchObject({ kind: "rejected" });
  });

  it("signs in end to end: a registration, the exchange, a verified ID token, plan usage granted — and the tokens sealed", async () => {
    const r = rig();
    expect(r.plan().status).toBe("off");
    expect(r.service.turn()).toBeNull();
    await r.connect();
    expect(r.outcomes).toEqual([{ ok: true }]);
    const plan = r.plan();
    expect(plan).toMatchObject({ status: "ready", chosen: true, inUse: true, email: "person@example.com", trouble: null, welcome: true });
    // The account's models, as it lists them for a picker — and the one Pistachio's own turns use, since it is there.
    expect(plan.models).toEqual([
      { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
      { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
    ]);
    expect(plan.model).toBe("gpt-5.6-terra");
    // It went through "connecting" on the way.
    expect(r.published.map((snapshot) => snapshot.plans[0]!.status)).toContain("connecting");

    // The exchange was under the ISSUED id, with the attempt's verifier and its exact callback address.
    const exchange = r.standIn.seen.token[0]!;
    expect(exchange.get("client_id")).toBe("oaiapp_standin_1");
    expect(exchange.get("redirect_uri")).toBe("http://127.0.0.1:49152/auth/callback");
    expect(exchange.get("code_verifier")).not.toBeNull();
    expect(exchange.has("client_secret")).toBe(false);

    // On disk: the registration in the clear, no token anywhere in it, and only the person may read it.
    const raw = readFileSync(r.path, "utf8");
    expect(raw).toContain("oaiapp_standin_1");
    expect(raw).not.toContain("at_standin_");
    expect(raw).not.toContain("rt_standin_");
    expect(statSync(r.path).mode & 0o777).toBe(0o600);
    // And nothing of a token in what the shell is told.
    expect(JSON.stringify(r.published)).not.toMatch(/at_standin_|rt_standin_|eyJ/);
  });

  it("keeps the install's host id for good, and comes back signed in after a relaunch", async () => {
    const r = rig();
    await r.connect();
    const host = r.store.hostId();
    expect(host).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    r.relaunch();
    expect(r.store.hostId()).toBe(host);
    expect(r.plan()).toMatchObject({ status: "ready", inUse: true, email: "person@example.com" });
    expect(await say(r.service.turn())).toBe("Hello from your plan.");
  });

  it("says so when the person declines, and stays off", async () => {
    const r = rig();
    r.standIn.knobs.decline = true;
    await r.connect();
    expect(r.outcomes[0]).toMatchObject({ ok: false });
    expect(r.plan()).toMatchObject({ status: "off", inUse: false, trouble: { kind: "declined" } });
    expect(r.service.turn()).toBeNull();
  });

  it("refuses an ID token its keys did not sign, and keeps nothing of it", async () => {
    const r = rig();
    r.standIn.knobs.forgeIdToken = true;
    await r.connect();
    expect(r.outcomes[0]).toMatchObject({ ok: false });
    expect(r.plan()).toMatchObject({ status: "off", email: null, trouble: { kind: "failed" } });
    expect(r.store.session()).toBeNull();
  });

  it("does not use a sign-in that came back without plan usage, and asks for consent the next time", async () => {
    const r = rig();
    r.standIn.knobs.grantPlanUse = false;
    await r.connect();
    expect(r.plan()).toMatchObject({ status: "off", inUse: false, trouble: { kind: "declined" } });
    expect(r.service.turn()).toBeNull();
    // The tokens it was handed were ended, not kept.
    expect(r.store.session()).toBeNull();
    expect(r.standIn.seen.revoked).toHaveLength(1);

    r.standIn.knobs.grantPlanUse = true;
    await r.connect();
    const second = r.standIn.seen.authorize[1]!.searchParams;
    // The same registration, asked again — this time for consent.
    expect(second.get("client_id")).toBe("oaiapp_standin_1");
    expect(second.get("prompt")).toBe("consent");
    expect(r.plan().status).toBe("ready");
  });

  it("refuses to sign in at all where the keychain cannot seal", async () => {
    const r = rig();
    r.keychain.on = false;
    await r.connect();
    expect(r.opened).toEqual([]);
    expect(r.plan()).toMatchObject({ status: "off", trouble: { kind: "failed" } });
    expect(r.plan().trouble?.message).toContain("keychain");
  });

  it("signs out: the session ended at the provider, the tokens gone, the registration kept for next time", async () => {
    const r = rig();
    await r.connect();
    await r.service.request({ type: "disconnect", provider: "chatgpt" });
    expect(r.standIn.seen.revoked).toEqual(["rt_standin_1"]);
    expect(r.plan()).toMatchObject({ status: "off", inUse: false, email: "person@example.com", unconfirmedSignOut: false });
    expect(r.store.session()).toBeNull();
    expect(r.service.turn()).toBeNull();

    // Signing in again is to the same registration, with the email as a hint and no name sent.
    await r.connect();
    const again = r.standIn.seen.authorize[1]!.searchParams;
    expect(again.get("client_id")).toBe("oaiapp_standin_1");
    expect(again.get("login_hint")).toBe("person@example.com");
    expect(again.has("agent_name_hint")).toBe(false);
    expect(r.plan().status).toBe("ready");
    // The first sign-in's confirmation is shown once, ever: not answered yet, so still owed — then never again.
    await r.service.request({ type: "welcomed", provider: "chatgpt" });
    await r.service.request({ type: "disconnect", provider: "chatgpt" });
    await r.connect();
    expect(r.plan()).toMatchObject({ status: "ready", welcome: false });
  });

  it("starts over as a new registration for a different account", async () => {
    const r = rig();
    await r.connect();
    await r.service.request({ type: "disconnect", provider: "chatgpt" });
    r.standIn.knobs.email = "other@example.com";
    r.standIn.knobs.subject = "user-standin-0002";
    // Signing in to the kept registration as someone else is refused…
    await r.connect();
    expect(r.plan()).toMatchObject({ status: "off", trouble: { kind: "failed" } });
    expect(r.plan().trouble?.message).toContain("different account");
    // …and *Use a different account* registers anew.
    await r.connect({ fresh: true });
    const fresh = r.standIn.seen.authorize[2]!.searchParams;
    expect(fresh.get("client_id")).toBe(REGISTRATION_CLIENT_ID);
    expect(r.plan()).toMatchObject({ status: "ready", email: "other@example.com" });
  });
});

describe("a request, as the plan's route takes it", () => {
  it("groups function tools in a namespace, moves system text to instructions, and leaves out what the route refuses", () => {
    const body = planRequestBody({
      model: "gpt-5.6-terra",
      store: true,
      temperature: 0.2,
      max_output_tokens: 4096,
      previous_response_id: "resp_0",
      metadata: { a: "b" },
      tools: [
        { type: "function", name: "tabs_list", description: "List tabs", parameters: { type: "object", properties: {} } },
        { type: "web_search" },
      ],
      input: [
        { role: "system", content: "You are Pistachio." },
        { role: "user", content: [{ type: "input_text", text: "Hi" }] },
        { type: "reasoning", id: "rs_other", summary: [] },
        { type: "reasoning", id: "rs_ours", encrypted_content: "sealed", summary: [] },
        { type: "function_call", call_id: "call_1", name: "tabs_list", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "[]" },
      ],
    });
    expect(body).toMatchObject({ model: "gpt-5.6-terra", store: false, stream: true, instructions: "You are Pistachio." });
    for (const field of ["temperature", "max_output_tokens", "previous_response_id", "metadata"]) expect(body).not.toHaveProperty(field);
    expect(body["tools"]).toEqual([
      { type: "web_search" },
      { type: "namespace", name: PLAN_TOOL_NAMESPACE, description: expect.any(String), tools: [{ type: "function", name: "tabs_list", description: "List tabs", parameters: { type: "object", properties: {} } }] },
    ]);
    expect(body["input"]).toEqual([
      { role: "user", content: [{ type: "input_text", text: "Hi" }] },
      // Reasoning another model wrote cannot be read here: left behind. The route's own travels sealed.
      { type: "reasoning", id: "rs_ours", encrypted_content: "sealed", summary: [] },
      { type: "function_call", call_id: "call_1", name: "tabs_list", arguments: "{}", namespace: PLAN_TOOL_NAMESPACE },
      { type: "function_call_output", call_id: "call_1", output: "[]" },
    ]);
  });

  it("reads a failure by its code, and by its status alone when the route refused it before a request began", () => {
    expect(planFailure(429, { error: { code: "subscription_sharing_usage_limit_exceeded" } })?.kind).toBe("limit");
    expect(planFailure(429, { error: { code: "subscription_sharing_workplace_individual_usage_limit_exceeded" } })?.kind).toBe("limit");
    expect(planFailure(403, { error: { code: "subscription_sharing_user_not_eligible" } })?.kind).toBe("ineligible");
    expect(planFailure(401, { error: { code: "subscription_sharing_invalid_user" } })?.kind).toBe("signIn");
    expect(planFailure(503, { error: { code: "subscription_sharing_usage_unavailable" } })?.kind).toBe("unavailable");
    const refused = planFailure(400, { error: { code: "subscription_sharing_unsupported_capability", param: "tools[2]" } });
    expect(refused?.kind).toBe("refused");
    expect(refused?.message).toContain("tools[2]");
    expect(planFailure(401, { detail: "…" })?.kind).toBe("signIn");
    expect(planFailure(403, { detail: "…" })?.kind).toBe("ineligible");
    expect(planFailure(503, { detail: "…" })?.kind).toBe("unavailable");
    // Not the plan's to explain: the provider library says these as it always did.
    expect(planFailure(400, { error: { code: "invalid_request_error" } })).toBeNull();
    expect(planFailure(500, null)).toBeNull();
  });

  it("renews a refused token once and sends the same request again", async () => {
    const tokens: boolean[] = [];
    const sent: string[] = [];
    const fetchImpl = planFetch({
      accessToken: ({ fresh }) => {
        tokens.push(fresh);
        return Promise.resolve(fresh ? "new" : "old");
      },
      failed: () => undefined,
      used: () => undefined,
      fetch: (_input, init) => {
        const bearer = new Headers(init?.headers).get("authorization") ?? "";
        sent.push(bearer);
        return Promise.resolve(bearer === "Bearer new" ? new Response("{}", { status: 200 }) : new Response('{"detail":"no"}', { status: 401 }));
      },
    });
    const response = await fetchImpl("https://api.example/v1/models", { headers: { authorization: "Bearer placeholder" } });
    expect(response.status).toBe(200);
    expect(tokens).toEqual([false, true]);
    expect(sent).toEqual(["Bearer old", "Bearer new"]);
  });
});

describe("what a provider says in an error never reaches the person", () => {
  const NAMES_THE_ACCOUNT = "Invalid value for user-standin-0001 (person@example.com) in org-secret";
  const through = (answer: () => Response): typeof fetch => planFetch({ accessToken: () => Promise.resolve("token"), failed: () => undefined, used: () => undefined, fetch: () => Promise.resolve(answer()) });

  it("hands the provider library a failure it does not explain with the status and the code, and none of the words", async () => {
    const fetchImpl = through(() => new Response(JSON.stringify({ error: { message: NAMES_THE_ACCOUNT, type: "invalid_request_error", code: "invalid_value", param: "tools[0].name" } }), { status: 400, headers: { "x-request-id": "req_1" } }));
    const response = await fetchImpl("https://api.example/v1/responses", { method: "POST", body: JSON.stringify({ model: "m", input: "hi", stream: true }) });
    // The same status (so what the library retries, it still retries) and the request id, for a report.
    expect(response.status).toBe(400);
    expect(response.headers.get("x-request-id")).toBe("req_1");
    const body = (await response.json()) as { error: { message: string; type: string; code: string; param: string } };
    expect(body.error).toEqual({ message: "ChatGPT couldn't complete this request on your plan (HTTP 400 · invalid_value · tools[0].name).", type: "invalid_request_error", code: "invalid_value", param: "tools[0].name" });
    expect(JSON.stringify(body)).not.toMatch(/user-standin|person@example|org-secret/);
  });

  it("does not repeat a code that is not a plain word", async () => {
    const fetchImpl = through(() => new Response(JSON.stringify({ error: { message: NAMES_THE_ACCOUNT, code: "see person@example.com", param: "a b" } }), { status: 500 }));
    const response = await fetchImpl("https://api.example/v1/responses", { method: "POST", body: JSON.stringify({ model: "m", input: "hi", stream: true }) });
    expect(await response.json()).toEqual({ error: { message: "ChatGPT couldn't complete this request on your plan (HTTP 500).", type: "api_error", code: null, param: null } });
  });

  it("ends a stream that fails for a reason the plan does not explain on a plain sentence", async () => {
    const events = [
      { type: "response.created", response: { id: "resp_1", created_at: 1, model: "m" } },
      { type: "response.failed", sequence_number: 1, response: { error: { code: "server_error", message: NAMES_THE_ACCOUNT } } },
    ];
    const fetchImpl = through(() => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const response = await fetchImpl("https://api.example/v1/responses", { method: "POST", body: JSON.stringify({ model: "m", input: "hi", stream: true }) });
    const failure = await response.text().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PlanError);
    expect((failure as PlanError).message).toBe("ChatGPT couldn't complete this request on your plan (server_error).");
    // And the same for a call that asked for the response whole.
    const whole = await fetchImpl("https://api.example/v1/responses", { method: "POST", body: JSON.stringify({ model: "m", input: "hi" }) }).catch((error: unknown) => error);
    expect(whole).toBeInstanceOf(PlanError);
    expect((whole as PlanError).message).not.toMatch(/user-standin|person@example|org-secret/);
  });
});

describe("what is kept", () => {
  it("counts a response into its day, and lets days past the month go", () => {
    const day = (iso: string): Date => new Date(`${iso}T12:00:00`);
    let days = tallyUsage([], day("2026-11-01"), { inputTokens: 100, outputTokens: 10 });
    days = tallyUsage(days, day("2026-11-01"), { inputTokens: 50, outputTokens: 5 });
    days = tallyUsage(days, day("2026-11-17"), { inputTokens: 1, outputTokens: 1 });
    expect(days).toEqual([
      { day: "2026-11-01", requests: 2, inputTokens: 150, outputTokens: 15 },
      { day: "2026-11-17", requests: 1, inputTokens: 1, outputTokens: 1 },
    ]);
    // Thirty days on, the first is out of the window.
    expect(tallyUsage(days, day("2026-12-05"), { inputTokens: 1, outputTokens: 1 }).map((entry) => entry.day)).toEqual(["2026-11-17", "2026-12-05"]);
  });

  it("treats a session this Mac can no longer open as a sign-in owed, not as one", async () => {
    const r = rig();
    await r.connect();
    // The same file under another keychain: a restored profile.
    const store = new AiPlanStore(r.path, { available: () => true, encrypt: (plain) => plain, decrypt: () => { throw new Error("cannot open"); } });
    expect(store.session()).toBeNull();
    expect(store.chatgpt()).toMatchObject({ needsSignIn: true, clientId: "oaiapp_standin_1" });
  });

  it("lists the models meant for a picker, and asks for the person's choice only while the account offers it", () => {
    const models = readPlanModels({ models: [{ slug: "a", display_name: "A", visibility: "list" }, { slug: "b", display_name: "", visibility: "list" }, { slug: "c", visibility: "hide" }, { slug: "d", visibility: "list", supported_in_api: false }] });
    expect(models).toEqual([{ id: "a", name: "A" }, { id: "b", name: "b" }]);
    expect(pickPlanModel("b", models)).toBe("b");
    expect(pickPlanModel("gone", models)).toBe("a");
    expect(pickPlanModel(null, [{ id: "x", name: "X" }, { id: "gpt-5.6-terra", name: "T" }])).toBe("gpt-5.6-terra");
    expect(pickPlanModel(null, [])).toBe("gpt-5.6-terra");
  });

  it("makes a thread portable to another source: what was said stays, reasoning and item ids do not", () => {
    const history = [
      { role: "user", content: "Hi", providerOptions: { openai: { imageDetail: "low" } } },
      { role: "assistant", content: [{ type: "reasoning", text: "thinking", providerOptions: { openai: { itemId: "rs_1" } } }] },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "more", providerOptions: { openai: { itemId: "rs_2", reasoningEncryptedContent: "sealed" } } },
          { type: "text", text: "Looking.", providerOptions: { openai: { itemId: "msg_1" } } },
          { type: "tool-call", toolCallId: "call_1", toolName: "tabs_list", input: {}, providerOptions: { openai: { itemId: "fc_1" } } },
        ],
      },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call_1", toolName: "tabs_list", output: { type: "json", value: [] } }] },
      { role: "assistant", content: "Done." },
    ] as unknown as ModelMessage[];
    expect(portableHistory(history)).toEqual([
      // The person's own message is no route's: exactly as it was.
      { role: "user", content: "Hi", providerOptions: { openai: { imageDetail: "low" } } },
      // (A message that was only thought is gone.)
      { role: "assistant", content: [{ type: "text", text: "Looking." }, { type: "tool-call", toolCallId: "call_1", toolName: "tabs_list", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call_1", toolName: "tabs_list", output: { type: "json", value: [] } }] },
      { role: "assistant", content: "Done." },
    ]);
    expect(PISTACHIO_MODELS).toBe("pistachio");
  });
});

describe("a turn on the plan", () => {
  it("runs through the public Responses API on the person's token, stateless and streamed, and is counted", async () => {
    const r = rig();
    await r.connect();
    const turn = r.service.turn();
    expect(turn).toMatchObject({ name: "chatgpt-plan/gpt-5.6-terra", source: "chatgpt" });
    expect(await say(turn)).toBe("Hello from your plan.");
    const sent = r.standIn.seen.responses[0]!;
    expect(sent.authorization).toBe("Bearer at_standin_1");
    expect(sent.body).toMatchObject({ model: "gpt-5.6-terra", store: false, stream: true });
    expect(sent.body).not.toHaveProperty("temperature");
    const plan = r.plan();
    expect(plan.usage).toHaveLength(1);
    expect(plan.usage[0]).toMatchObject({ requests: 1, inputTokens: 120, outputTokens: 30 });
    expect(plan.lastUsedAt).not.toBeNull();
  });

  it("sends the agent's tools in a namespace, and a call the model makes comes back as that tool's", async () => {
    const r = rig();
    await r.connect();
    r.standIn.knobs.replies.push({ call: { name: "settings_read", arguments: { section: "appearance" } } }, { text: "It is dark." });
    const turn = r.service.turn();
    if (turn === null || "blocked" in turn) throw new Error("expected the plan's model");
    const called: unknown[] = [];
    const result = await generateText({
      model: turn.model,
      system: "You are Pistachio.",
      prompt: "What theme am I on?",
      providerOptions: turn.providerOptions,
      maxRetries: 0,
      stopWhen: ({ steps }) => steps.length >= 2,
      tools: {
        settings_read: tool({
          description: "Read a settings section",
          inputSchema: z.object({ section: z.string() }),
          execute: (input) => {
            called.push(input);
            return Promise.resolve({ theme: "dark" });
          },
        }),
      },
    });
    expect(called).toEqual([{ section: "appearance" }]);
    expect(result.text).toBe("It is dark.");
    const [first, second] = r.standIn.seen.responses;
    expect(first!.body["tools"]).toEqual([expect.objectContaining({ type: "namespace", name: "pistachio", tools: [expect.objectContaining({ type: "function", name: "settings_read" })] })]);
    // No system-role item reaches the route: the words are instructions, or a developer message.
    const firstInput = first!.body["input"] as Array<{ role?: string }>;
    expect(firstInput.some((item) => item.role === "system")).toBe(false);
    expect(JSON.stringify(first!.body)).toContain("You are Pistachio.");
    // The step after carries the call and its result back, the call named in its namespace.
    const items = second!.body["input"] as Array<Record<string, unknown>>;
    expect(items.find((item) => item["type"] === "function_call")).toMatchObject({ name: "settings_read", namespace: "pistachio", call_id: "call_1" });
    expect(items.find((item) => item["type"] === "function_call_output")).toMatchObject({ call_id: "call_1" });
  });

  it("stops on a usage limit with Pistachio's own sentence, pauses, and never falls back by itself", async () => {
    const r = rig();
    await r.connect();
    r.standIn.knobs.limit = true;
    const failure = await say(r.service.turn()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PlanError);
    expect((failure as PlanError).kind).toBe("limit");
    // What OpenAI said named the account: none of it is in what the person reads, or in what the shell is told.
    expect((failure as PlanError).message).not.toMatch(/user-standin|person@example/);
    expect((failure as PlanError).message).toContain("https://chatgpt.com/settings/usage");
    expect(JSON.stringify(r.published)).not.toContain("user-standin-0001");
    expect(r.plan()).toMatchObject({ status: "limit", chosen: true, inUse: false, trouble: { kind: "limit" } });

    // Paused: the next turn is not sent at all, and is not handed Pistachio's models instead.
    const sentBefore = r.standIn.seen.responses.length;
    const next = r.service.turn();
    expect(next).toMatchObject({ blocked: { kind: "limit", message: PAUSED_FOR_LIMIT } });
    expect(r.standIn.seen.responses).toHaveLength(sentBefore);

    // The person lifts the pause; what the next request says decides.
    r.standIn.knobs.limit = false;
    await r.service.request({ type: "resume", provider: "chatgpt" });
    expect(r.plan()).toMatchObject({ status: "ready", inUse: true, trouble: null });
    expect(await say(r.service.turn())).toBe("Hello from your plan.");
    // Or they switch: then the plan answers nothing for a turn, and Pistachio's models run it.
    await r.service.request({ type: "choose", provider: "chatgpt", chosen: false });
    expect(r.service.turn()).toBeNull();
    expect(r.plan()).toMatchObject({ status: "ready", chosen: false, inUse: false });
  });

  it("stops a reply that fails late on a limit with the same sentence, not the provider's", async () => {
    const r = rig();
    await r.connect();
    r.standIn.knobs.replies.push({ fail: "subscription_sharing_usage_limit_exceeded" });
    const failure = await say(r.service.turn()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PlanError);
    expect((failure as PlanError).message).not.toMatch(/user-standin|person@example/);
    expect(r.plan().status).toBe("limit");
  });

  it("says when plan usage is not available to the account, and does not ask again", async () => {
    const r = rig();
    await r.connect();
    r.standIn.knobs.ineligible = true;
    const failure = await say(r.service.turn()).catch((error: unknown) => error);
    expect((failure as PlanError).kind).toBe("ineligible");
    expect(r.plan()).toMatchObject({ status: "ineligible", inUse: false });
    expect(r.service.turn()).toMatchObject({ blocked: { kind: "ineligible" } });
  });

  it("renews the token before it lapses — once, however many requests are waiting — and keeps the replacement", async () => {
    const r = rig();
    await r.connect();
    r.clock.now += 56 * 60_000;
    const [a, b] = await Promise.all([say(r.service.turn()), say(r.service.turn())]);
    expect([a, b]).toEqual(["Hello from your plan.", "Hello from your plan."]);
    const refreshes = r.standIn.seen.token.filter((form) => form.get("grant_type") === "refresh_token");
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]!.get("client_id")).toBe("oaiapp_standin_1");
    expect(refreshes[0]!.has("scope")).toBe(false);
    expect(r.standIn.seen.responses.map((request) => request.authorization)).toEqual(["Bearer at_standin_2", "Bearer at_standin_2"]);
    // The replacement refresh token is the one kept: a relaunch renews with it, not with the spent one.
    r.relaunch();
    r.clock.now += 56 * 60_000;
    expect(await say(r.service.turn())).toBe("Hello from your plan.");
    expect(r.standIn.seen.token.filter((form) => form.get("grant_type") === "refresh_token")[1]!.get("refresh_token")).toBe("rt_standin_2");
  });

  it("asks for a new sign-in when the session is over, and keeps the registration for it", async () => {
    const r = rig();
    await r.connect();
    r.clock.now += 56 * 60_000;
    r.standIn.knobs.refreshError = "refresh_token_invalidated";
    const failure = await say(r.service.turn()).catch((error: unknown) => error);
    expect((failure as PlanError).kind).toBe("signIn");
    expect(r.plan()).toMatchObject({ status: "signIn", chosen: true, inUse: false, email: "person@example.com", trouble: { kind: "signIn" } });
    expect(r.store.session()).toBeNull();
    expect(r.service.turn()).toMatchObject({ blocked: { kind: "signIn" } });
    // Signing in again is to the same registration.
    await r.connect();
    expect(r.standIn.seen.authorize[1]!.searchParams.get("client_id")).toBe("oaiapp_standin_1");
    expect(r.plan()).toMatchObject({ status: "ready", inUse: true });
  });

  it("finds a connection ended in ChatGPT's settings when it looks, before a turn does", async () => {
    const r = rig();
    await r.connect();
    r.standIn.knobs.disconnected = true;
    await r.service.request({ type: "refresh", provider: "chatgpt" });
    expect(r.plan()).toMatchObject({ status: "signIn", inUse: false });
  });

  it("concludes nothing from a network that is down", async () => {
    const r = rig();
    await r.connect();
    r.clock.now += 56 * 60_000;
    const down: typeof fetch = () => Promise.reject(new TypeError("fetch failed"));
    const store = new AiPlanStore(r.path, r.keychain);
    const offline = new AiPlanService({ store, fetch: down, now: () => r.clock.now, onChange: () => undefined, openExternal: () => undefined, endpoints: { issuer: r.standIn.origin, authorize: "", token: `${r.standIn.origin}/t`, api: `${r.standIn.origin}/v1` } });
    await offline.request({ type: "refresh", provider: "chatgpt" });
    // Still signed in, still the person's choice: the token in hand is good for a few minutes yet.
    expect(offline.snapshot().plans[0]).toMatchObject({ status: "ready", inUse: true });
    expect(store.session()).not.toBeNull();
  });

  it("opens ChatGPT's own page for what is left of the plan", async () => {
    const r = rig();
    await r.connect();
    await r.service.request({ type: "manageUsage", provider: "chatgpt" });
    expect(r.opened.at(-1)).toBe("https://chatgpt.com/settings/usage");
  });
});
