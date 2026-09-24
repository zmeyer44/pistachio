/**
 * Anonymous accounts (docs/anonymous-accounts.md): minting one for a Mac
 * nobody signed in on, the allow-list it lives behind, the model bounds
 * that stand in for a spend cap it cannot set, and the two ways it becomes a
 * real account — upgraded in place, or folded into one that already exists.
 */

import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ANONYMOUS_RETENTION_MS,
  ANONYMOUS_SIGNUPS_PER_IP,
  AnonymousAiLimiter,
  anonymousAiPolicy,
  anonymousAllowed,
} from "../src/anonymous.js";
import * as schema from "../src/db/schema.js";
import { CREDENTIAL_ISSUER } from "../src/idp.js";
import {
  PASSWORD,
  anonymousAccount,
  anonymousRequest,
  authed,
  deviceLogin,
  enrollDesktop,
  json,
  jsonInit,
  makeHarness,
  newDeviceKeys,
  nextEmail,
  signup,
  type Harness,
} from "./helpers.js";

const GATEWAY_KEY = "vck_operator_key";

function gatewayAnswer(costUsd: string): Response {
  return Response.json({
    content: [{ type: "text", text: "ok" }],
    usage: { inputTokens: 10, outputTokens: 5 },
    providerMetadata: { gateway: { cost: costUsd } },
  });
}

let h: Harness;
let answer: () => Response = () => gatewayAnswer("0.01");
let forwarded = 0;

beforeAll(async () => {
  h = await makeHarness({
    env: {
      AI_GATEWAY_API_KEY: GATEWAY_KEY,
      AI_GATEWAY_URL: "https://gateway.example/v4/ai",
      AI_ANONYMOUS_MONTHLY_USD: "1",
      AI_ANONYMOUS_RPM: "5",
      AI_ANONYMOUS_SLOW_MODELS: "anthropic/claude-opus-5",
      AI_ANONYMOUS_SLOW_RPM: "2",
    },
    ai: {
      fetchImpl: async () => {
        forwarded += 1;
        return answer();
      },
    },
  });
});

/** One model call, its answer read to the end — the meter lands a row only once the body has. */
async function callModel(token: string, modelId = "openai/gpt-5.6-terra"): Promise<Response> {
  const init = jsonInit("POST", { prompt: "hi" }, token);
  const res = await h.request("/v1/ai/language-model", {
    ...init,
    headers: { ...(init.headers as Record<string, string>), "ai-model-id": modelId },
  });
  return new Response(await res.text(), { status: res.status, headers: res.headers });
}

describe("POST /v1/accounts/anonymous", () => {
  it("makes the user, its two Spaces and the device in one call, and answers a device token", async () => {
    const anon = await anonymousAccount(h);
    const [user] = await h.db.select().from(schema.users).where(eq(schema.users.id, anon.userId));
    expect(user?.isAnonymous).toBe(true);
    expect(user?.email).toBeNull();
    const spaces = await h.db.select().from(schema.spaces).where(eq(schema.spaces.userId, anon.userId));
    expect(spaces.map((space) => space.id).sort()).toEqual(["__workspace__", "work"]);
    const [device] = await h.db.select().from(schema.devices).where(eq(schema.devices.id, anon.deviceId));
    expect(device?.userId).toBe(anon.userId);

    const me = await json(await h.request("/v1/me", authed(anon.token)));
    expect(me["anonymous"]).toBe(true);
    expect(me["email"]).toBeNull();
    // The device key is the account's only credential: it mints fresh tokens like any device.
    expect((await deviceLogin(h, anon.keys)).token).toBeTruthy();
  });

  it("needs the device proof, and leaves no user behind a refused one", async () => {
    const before = (await h.db.select({ id: schema.users.id }).from(schema.users)).length;
    const keys = await newDeviceKeys();
    const other = await newDeviceKeys();
    const bad = await anonymousRequest(h, keys, { overrides: { devicePublicKey: other.devicePublicKey } });
    expect(bad.status).toBe(401);
    const web = await anonymousRequest(h, keys, { overrides: { platform: "web" } });
    expect(web.status).toBe(400);
    // A key control already knows cannot mint a second account.
    const anon = await anonymousAccount(h);
    const again = await anonymousRequest(h, anon.keys);
    expect(again.status).toBe(409);
    expect((await h.db.select({ id: schema.users.id }).from(schema.users)).length).toBe(before + 1);
  });

  it("bounds minting per client address", async () => {
    const address = "203.0.113.77";
    for (let i = 0; i < ANONYMOUS_SIGNUPS_PER_IP; i += 1) {
      expect((await anonymousRequest(h, await newDeviceKeys(), { address })).status).toBe(201);
    }
    expect((await anonymousRequest(h, await newDeviceKeys(), { address })).status).toBe(429);
    expect((await anonymousRequest(h, await newDeviceKeys(), { address: "203.0.113.78" })).status).toBe(201);
  });
});

describe("what an anonymous account may reach", () => {
  it("is an allow-list: the models, its usage, and the way out", () => {
    expect(anonymousAllowed("POST", "/v1/ai/language-model")).toBe(true);
    expect(anonymousAllowed("GET", "/v1/me")).toBe(true);
    expect(anonymousAllowed("GET", "/v1/ai-usage")).toBe(true);
    expect(anonymousAllowed("POST", "/v1/me/onboarding/complete")).toBe(true);
    expect(anonymousAllowed("POST", "/v1/account/upgrade")).toBe(true);
    expect(anonymousAllowed("PUT", "/v1/ai-usage/cap")).toBe(false);
    expect(anonymousAllowed("GET", "/v1/devices")).toBe(false);
    expect(anonymousAllowed("POST", "/v1/account/link")).toBe(false);
  });

  it("answers account_required everywhere else", async () => {
    const anon = await anonymousAccount(h);
    for (const [method, path] of [
      ["GET", "/v1/devices"],
      ["GET", "/v1/spaces"],
      ["GET", "/v1/spaces/work/wrappers"],
      ["GET", "/v1/vault/entries"],
      ["GET", "/v1/sync/policy"],
      ["GET", "/v1/egress"],
    ] as const) {
      const res = await h.request(path, authed(anon.token, method));
      expect(res.status, path).toBe(403);
      expect((await json(res))["error"], path).toBe("account_required");
    }
    // Its own spend cap is not its to raise.
    const cap = await h.request("/v1/ai-usage/cap", jsonInit("PUT", { monthlyUsd: 1000 }, anon.token));
    expect(cap.status).toBe(403);
    // Nor do the planes that introspect a token (the cloud browser) know it.
    const introspect = await h.request(
      "/v1/internal/auth/introspect",
      jsonInit("POST", { token: anon.token }, "svc-token-for-tests"),
    );
    expect(introspect.status).toBe(403);
  });

  it("records onboarding on the account", async () => {
    const anon = await anonymousAccount(h);
    const res = await h.request("/v1/me/onboarding/complete", authed(anon.token, "POST"));
    expect(res.status).toBe(200);
    const me = await json(await h.request("/v1/me", authed(anon.token)));
    expect(me["onboardingCompletedAt"]).toBeTruthy();
  });
});

describe("the models, for an anonymous account", () => {
  it("forwards, meters, and reports the allowance as the cap", async () => {
    const anon = await anonymousAccount(h);
    answer = () => gatewayAnswer("0.25");
    expect((await callModel(anon.token)).status).toBe(200);
    await h.control.idle();
    const usage = await json<{ month: { requests: number; costUsd: string }; cap: { monthlyUsd: string; reached: boolean } }>(
      await h.request("/v1/ai-usage", authed(anon.token)),
    );
    expect(usage.month.requests).toBe(1);
    expect(usage.cap).toEqual({ monthlyUsd: "1", reached: false });
  });

  it("refuses once the month's allowance is spent, without forwarding", async () => {
    const anon = await anonymousAccount(h);
    answer = () => gatewayAnswer("0.6");
    expect((await callModel(anon.token)).status).toBe(200);
    expect((await callModel(anon.token)).status).toBe(200);
    await h.control.idle();
    const before = forwarded;
    const refused = await callModel(anon.token);
    expect(refused.status).toBe(403);
    expect((await json(refused))["reason"]).toBe("anonymous_budget_exceeded");
    expect(forwarded).toBe(before);
  });

  it("paces requests per minute, and the named models more tightly", async () => {
    answer = () => gatewayAnswer("0");
    const slow = await anonymousAccount(h);
    expect((await callModel(slow.token, "anthropic/claude-opus-5")).status).toBe(200);
    expect((await callModel(slow.token, "Anthropic/Claude-Opus-5")).status).toBe(200);
    const paced = await callModel(slow.token, "anthropic/claude-opus-5");
    expect(paced.status).toBe(429);
    expect((await json(paced))["reason"]).toBe("anonymous_rate_limited");
    expect(Number(paced.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another model is still within the account's overall pace.
    expect((await callModel(slow.token)).status).toBe(200);

    const fast = await anonymousAccount(h);
    for (let i = 0; i < 5; i += 1) expect((await callModel(fast.token)).status).toBe(200);
    expect((await callModel(fast.token)).status).toBe(429);
  });

  it("does not pace or cap a real account this way", async () => {
    answer = () => gatewayAnswer("0.9");
    const account = await signup(h);
    const device = await enrollDesktop(h, account.bootstrapToken);
    for (let i = 0; i < 8; i += 1) expect((await callModel(device.token)).status).toBe(200);
  });
});

describe("the policy", () => {
  it("reads its numbers from the environment and falls back on nonsense", () => {
    const defaults = anonymousAiPolicy({});
    expect(defaults.monthlyUsd).toBe(5);
    expect(defaults.requestsPerMinute).toBe(60);
    expect(defaults.slowModels.size).toBe(0);
    const tuned = anonymousAiPolicy({ AI_ANONYMOUS_MONTHLY_USD: "0", AI_ANONYMOUS_RPM: "-3", AI_ANONYMOUS_SLOW_MODELS: " A/b , ,c/D " });
    expect(tuned.monthlyUsd).toBe(0);
    expect(tuned.requestsPerMinute).toBe(60);
    expect([...tuned.slowModels]).toEqual(["a/b", "c/d"]);
  });

  it("forgets windows that have turned", () => {
    let at = 0;
    const limiter = new AnonymousAiLimiter(1000, () => at);
    expect(limiter.take("a", 1)).toBeNull();
    expect(limiter.take("a", 1)).toBe(1);
    expect(limiter.take("b", 0)).toBe(1);
    at = 1500;
    expect(limiter.take("c", 1)).toBeNull();
    expect(limiter.size()).toBe(1);
    expect(limiter.take("a", 1)).toBeNull();
  });
});

describe("POST /v1/account/upgrade", () => {
  it("turns the anonymous account into a real one in place: same user, same device, same meter", async () => {
    const anon = await anonymousAccount(h);
    answer = () => gatewayAnswer("0.1");
    expect((await callModel(anon.token)).status).toBe(200);
    await h.control.idle();

    const email = nextEmail("upgraded");
    const res = await h.request("/v1/account/upgrade", jsonInit("POST", { email: email.toUpperCase(), password: PASSWORD }, anon.token));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ userId: anon.userId, email });

    const [user] = await h.db.select().from(schema.users).where(eq(schema.users.id, anon.userId));
    expect(user?.isAnonymous).toBe(false);
    expect(user?.email).toBe(email);

    // The token it already held now reaches the whole device tier.
    expect((await h.request("/v1/devices", authed(anon.token))).status).toBe(200);
    const usage = await json<{ month: { requests: number }; cap: { monthlyUsd: string | null } }>(
      await h.request("/v1/ai-usage", authed(anon.token)),
    );
    expect(usage.month.requests).toBe(1);
    expect(usage.cap.monthlyUsd).toBeNull();

    // BetterAuth knows it like any account: the password signs in, and the
    // bootstrap token is already consumed by the device that came with it.
    const login = await h.request("/v1/auth/password-login", jsonInit("POST", { email, password: PASSWORD }));
    expect(login.status).toBe(200);
    expect((await json(login))["userId"]).toBe(anon.userId);
    const wrong = await h.request("/v1/auth/password-login", jsonInit("POST", { email, password: "not-the-password" }));
    expect(wrong.status).toBe(403);
  });

  it("writes the credential row exactly as signUpEmail does", async () => {
    const real = await signup(h);
    const [signedUp] = await h.db
      .select()
      .from(schema.authAccounts)
      .where(eq(schema.authAccounts.userId, real.userId));
    expect(signedUp?.issuer).toBe(CREDENTIAL_ISSUER);

    const anon = await anonymousAccount(h);
    await h.request("/v1/account/upgrade", jsonInit("POST", { email: nextEmail(), password: PASSWORD }, anon.token));
    const [upgraded] = await h.db
      .select()
      .from(schema.authAccounts)
      .where(and(eq(schema.authAccounts.userId, anon.userId), eq(schema.authAccounts.providerId, "credential")));
    expect(upgraded?.issuer).toBe(signedUp?.issuer);
    expect(upgraded?.providerId).toBe(signedUp?.providerId);
    expect(upgraded?.accountId).toBe(anon.userId);
    expect(signedUp?.accountId).toBe(real.userId);
    expect(upgraded?.password).not.toBe(PASSWORD);
  });

  it("supports the password change and nothing about it lingers as anonymous", async () => {
    const anon = await anonymousAccount(h);
    await h.request("/v1/account/upgrade", jsonInit("POST", { email: nextEmail(), password: PASSWORD }, anon.token));
    const changed = await h.request(
      "/v1/auth/password",
      jsonInit("POST", { currentPassword: PASSWORD, newPassword: "a-brand-new-password" }, anon.token),
    );
    expect(changed.status).toBe(200);
  });

  it("refuses a taken email, a real account, and a second upgrade", async () => {
    const real = await signup(h);
    const anon = await anonymousAccount(h);
    const taken = await h.request("/v1/account/upgrade", jsonInit("POST", { email: real.email, password: PASSWORD }, anon.token));
    expect(taken.status).toBe(409);
    expect((await json(taken))["error"]).toBe("email_taken");
    const [still] = await h.db.select().from(schema.users).where(eq(schema.users.id, anon.userId));
    expect(still?.isAnonymous).toBe(true);

    const device = await enrollDesktop(h, real.bootstrapToken);
    const notAnon = await h.request("/v1/account/upgrade", jsonInit("POST", { email: nextEmail(), password: PASSWORD }, device.token));
    expect(notAnon.status).toBe(409);
    expect((await json(notAnon))["error"]).toBe("not_anonymous");

    expect((await h.request("/v1/account/upgrade", jsonInit("POST", { email: nextEmail(), password: PASSWORD }, anon.token))).status).toBe(200);
    const twice = await h.request("/v1/account/upgrade", jsonInit("POST", { email: nextEmail(), password: PASSWORD }, anon.token));
    expect(twice.status).toBe(409);
  });
});

describe("POST /v1/account/link", () => {
  it("folds the anonymous account into the one signed in to, device and meter included", async () => {
    const anon = await anonymousAccount(h);
    answer = () => gatewayAnswer("0.2");
    expect((await callModel(anon.token)).status).toBe(200);
    await h.control.idle();
    await h.request("/v1/me/onboarding/complete", authed(anon.token, "POST"));

    const real = await signup(h);
    const res = await h.request("/v1/account/link", jsonInit("POST", { anonymousToken: anon.token }, real.bootstrapToken));
    expect(res.status).toBe(200);
    const out = await json<{ linked: boolean; usageRows: number; token: string; device: { id: string } }>(res);
    expect(out.linked).toBe(true);
    expect(out.usageRows).toBe(1);
    expect(out.device.id).toBe(anon.deviceId);

    // The anonymous account is gone, and its token with it.
    expect(await h.db.select().from(schema.users).where(eq(schema.users.id, anon.userId))).toHaveLength(0);
    expect((await h.request("/v1/me", authed(anon.token))).status).toBe(401);

    // This Mac kept its id and is now the real account's device.
    const me = await json(await h.request("/v1/me", authed(out.token)));
    expect(me["userId"]).toBe(real.userId);
    expect(me["anonymous"]).toBe(false);
    expect(me["onboardingCompletedAt"]).toBeTruthy();
    const devices = await json<{ devices: Array<{ id: string }> }>(await h.request("/v1/devices", authed(out.token)));
    expect(devices.devices.map((device) => device.id)).toEqual([anon.deviceId]);
    expect((await deviceLogin(h, anon.keys)).token).toBeTruthy();

    const usage = await json<{ month: { requests: number; costUsd: string } }>(await h.request("/v1/ai-usage", authed(out.token)));
    expect(usage.month.requests).toBe(1);
    expect(usage.month.costUsd).toBe("0.2");
    const audits = await h.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.userId, real.userId));
    expect(audits.map((event) => event.kind)).toContain("account.linked");
  });

  it("still meters an answer that was streaming when the link happened, under the real account", async () => {
    const anon = await anonymousAccount(h);
    // The gateway answers, but the body does not end until the test says so.
    let finish: () => void = () => undefined;
    answer = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            finish = () => {
              controller.enqueue(
                new TextEncoder().encode(
                  JSON.stringify({ usage: { inputTokens: 10, outputTokens: 5 }, providerMetadata: { gateway: { cost: "0.3" } } }),
                ),
              );
              controller.close();
            };
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    const init = jsonInit("POST", { prompt: "hi" }, anon.token);
    const streaming = await h.request("/v1/ai/language-model", init);
    expect(streaming.status).toBe(200);

    const real = await signup(h);
    const linked = await h.request("/v1/account/link", jsonInit("POST", { anonymousToken: anon.token }, real.bootstrapToken));
    expect(linked.status).toBe(200);
    const { token } = await json<{ token: string }>(linked);

    // The answer ends only now: its user row is gone.
    finish();
    await streaming.text();
    await h.control.idle();

    const usage = await json<{ month: { requests: number; costUsd: string } }>(await h.request("/v1/ai-usage", authed(token)));
    expect(usage.month).toMatchObject({ requests: 1, costUsd: "0.3" });
    expect(h.logs.filter((line) => line.includes("background task failed"))).toEqual([]);
  });

  it("refuses a meter row for a user that is simply gone, and forgets links after a day", async () => {
    const { recordAiUsage } = await import("../src/ai-usage.js");
    const sample = {
      userId: "99999999-9999-4999-8999-999999999999",
      deviceId: "99999999-9999-4999-8999-999999999998",
      kind: "language-model" as const,
      modelId: null,
      status: 200,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      requestBytes: 0,
      responseBytes: 0,
      durationMs: 0,
      at: new Date(),
    };
    await expect(recordAiUsage(h.db, sample)).rejects.toThrow();

    const real = await signup(h);
    await h.db.insert(schema.accountLinks).values({ fromUserId: sample.userId, toUserId: real.userId, linkedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) });
    await recordAiUsage(h.db, sample);
    expect(await h.db.select().from(schema.aiUsage).where(eq(schema.aiUsage.userId, real.userId))).toHaveLength(1);
    await h.control.runMaintenance();
    expect(await h.db.select().from(schema.accountLinks).where(eq(schema.accountLinks.fromUserId, sample.userId))).toHaveLength(0);
  });

  it("keeps an onboarding the real account already recorded", async () => {
    const real = await signup(h);
    const first = await enrollDesktop(h, real.bootstrapToken);
    const done = await json<{ onboardingCompletedAt: string }>(
      await h.request("/v1/me/onboarding/complete", authed(first.token, "POST")),
    );
    const anon = await anonymousAccount(h);
    await h.request("/v1/me/onboarding/complete", authed(anon.token, "POST"));
    const res = await h.request("/v1/account/link", jsonInit("POST", { anonymousToken: anon.token }, first.token));
    expect(res.status).toBe(200);
    const me = await json(await h.request("/v1/me", authed(first.token)));
    expect(me["onboardingCompletedAt"]).toBe(done.onboardingCompletedAt);
  });

  it("merges only an anonymous account, proven by its own device token", async () => {
    const real = await signup(h);
    const victim = await signup(h);
    const victimDevice = await enrollDesktop(h, victim.bootstrapToken);
    const notAnon = await h.request("/v1/account/link", jsonInit("POST", { anonymousToken: victimDevice.token }, real.bootstrapToken));
    expect(notAnon.status).toBe(409);
    expect(await h.db.select().from(schema.users).where(eq(schema.users.id, victim.userId))).toHaveLength(1);

    const garbage = await h.request("/v1/account/link", jsonInit("POST", { anonymousToken: "a.b.c" }, real.bootstrapToken));
    expect(garbage.status).toBe(403);

    // An anonymous account cannot absorb another.
    const a = await anonymousAccount(h);
    const b = await anonymousAccount(h);
    const anonToAnon = await h.request("/v1/account/link", jsonInit("POST", { anonymousToken: b.token }, a.token));
    expect(anonToAnon.status).toBe(403);
  });
});

describe("the hourly sweep", () => {
  it("deletes an anonymous account whose Mac stopped calling, and no other", async () => {
    let at = Date.now();
    const timed = await makeHarness({ now: () => at });
    const stale = await anonymousAccount(timed);
    const real = await signup(timed);
    at += ANONYMOUS_RETENTION_MS / 2;
    const active = await anonymousAccount(timed);
    at += ANONYMOUS_RETENTION_MS / 2 + 60_000;
    // `active` was made half a window ago; `stale` and `real` a whole one.
    const result = await timed.control.runMaintenance(at);
    expect(result.prunedAnonymousAccounts).toBe(1);
    const left = (await timed.db.select({ id: schema.users.id }).from(schema.users)).map((row) => row.id);
    expect(left).not.toContain(stale.userId);
    expect(left).toContain(active.userId);
    expect(left).toContain(real.userId);
  });
});
