/**
 * `/v1/ai/*` (ai-proxy.ts): the desktop's model calls, forwarded to the
 * gateway under the operator's key. The auth tier is the interesting part —
 * a device token and nothing else — and then that the forwarding swaps the
 * credential, keeps the SDK's headers, and streams the answer back.
 */

import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import * as schema from "../src/db/schema.js";
import {
  authed,
  desktopAccount,
  deviceLogin,
  enableCloud,
  fakeRunner,
  json,
  jsonInit,
  makeHarness,
  signup,
  type FakeRunner,
  type Harness,
} from "./helpers.js";

const GATEWAY_KEY = "vck_operator_key";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function recordingFetch(seen: Seen[], answer: () => Response): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    seen.push({
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: await request.text(),
    });
    return answer();
  };
}

describe("the model proxy", () => {
  let h: Harness;
  let runner: FakeRunner;
  const seen: Seen[] = [];
  let answer: () => Response = () => Response.json({ ok: true });

  beforeAll(async () => {
    runner = await fakeRunner((path, init) => h.request(path, init));
    h = await makeHarness({
      runner: runner.client,
      env: { AI_GATEWAY_API_KEY: GATEWAY_KEY, AI_GATEWAY_URL: "https://gateway.example/v4/ai" },
      ai: { fetchImpl: recordingFetch(seen, () => answer()) },
    });
  });

  it("accepts only a device token", async () => {
    const { bootstrapToken } = await signup(h);
    const anonymous = await h.request("/v1/ai/language-model", jsonInit("POST", {}));
    expect(anonymous.status).toBe(401);
    const bootstrap = await h.request("/v1/ai/language-model", jsonInit("POST", {}, bootstrapToken));
    expect(bootstrap.status).toBe(403);
    expect((await json(bootstrap))["error"]).toBe("device_required");
    expect(seen).toHaveLength(0);
  });

  it("swaps the credential, keeps the SDK's headers, and streams the answer", async () => {
    const { token } = await desktopAccount(h);
    answer = () =>
      new Response("data: {\"type\":\"text-delta\"}\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream", "content-encoding": "gzip", "x-vercel-id": "abc" },
      });
    const res = await h.request("/v1/ai/language-model?x=1", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "ai-language-model-specification-version": "3",
        "ai-model-id": "openai/gpt-5.6-terra",
        "ai-gateway-auth-method": "oidc",
        "x-forwarded-for": "203.0.113.9",
        cookie: "session=nope",
      },
      body: JSON.stringify({ prompt: [] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("x-vercel-id")).toBe("abc");
    // Decoded here, so the encoding must not be echoed on.
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.text()).toContain("text-delta");

    const forwarded = seen.at(-1);
    expect(forwarded).toBeDefined();
    expect(forwarded?.url).toBe("https://gateway.example/v4/ai/language-model?x=1");
    expect(forwarded?.method).toBe("POST");
    expect(JSON.parse(forwarded!.body)).toEqual({ prompt: [], providerOptions: { gateway: { disallowPromptTraining: true } } });
    expect(forwarded?.headers["authorization"]).toBe(`Bearer ${GATEWAY_KEY}`);
    expect(forwarded?.headers["ai-gateway-auth-method"]).toBe("api-key");
    expect(forwarded?.headers["ai-model-id"]).toBe("openai/gpt-5.6-terra");
    expect(forwarded?.headers["ai-language-model-specification-version"]).toBe("3");
    expect(forwarded?.headers["content-type"]).toBe("application/json");
    // Nothing about the device or its session crosses to the gateway.
    expect(forwarded?.headers["x-forwarded-for"]).toBeUndefined();
    expect(forwarded?.headers["cookie"]).toBeUndefined();
  });

  it("passes the gateway's refusals through as they are", async () => {
    const { token } = await desktopAccount(h);
    answer = () => Response.json({ error: { type: "rate_limit_exceeded", message: "slow down" } }, { status: 429 });
    const res = await h.request("/v1/ai/embedding-model", jsonInit("POST", { values: ["x"] }, token));
    expect(res.status).toBe(429);
    expect(((await json(res))["error"] as { type: string }).type).toBe("rate_limit_exceeded");
  });

  it("answers 502 when the gateway cannot be reached", async () => {
    const { token } = await desktopAccount(h);
    answer = () => {
      throw new Error("ECONNREFUSED");
    };
    const res = await h.request("/v1/ai/language-model", jsonInit("POST", {}, token));
    expect(res.status).toBe(502);
    expect((await json(res))["error"]).toBe("upstream_unreachable");
  });

  it("refuses a cloud device: the cloud browser has its own key", async () => {
    const account = await desktopAccount(h);
    await enableCloud(h, account.token);
    const identity = runner.identities.get(account.userId);
    expect(identity).toBeDefined();
    if (!identity) throw new Error("unreachable");
    const { token: cloudToken } = await deviceLogin(h, identity);
    const res = await h.request("/v1/ai/language-model", jsonInit("POST", {}, cloudToken));
    expect(res.status).toBe(403);
    expect((await json(res))["error"]).toBe("cloud_device_forbidden");
  });

  it("is closed, not open, without a key", async () => {
    const closed = await makeHarness({ env: { AI_GATEWAY_API_KEY: "" } });
    const { token } = await desktopAccount(closed);
    const res = await closed.request("/v1/ai/language-model", jsonInit("POST", {}, token));
    expect(res.status).toBe(503);
    expect((await json(res))["reason"]).toBe("ai_gateway_unconfigured");
  });

  it("meters every request on the account: tokens and cost from the answer, bytes and time always", async () => {
    const account = await desktopAccount(h);
    const before = await json<{ day: { requests: number } }>(await h.request("/v1/ai-usage", authed(account.token)));
    expect(before.day.requests).toBe(0);

    // A streamed language-model answer, its usage in the finish part.
    answer = () =>
      new Response(
        [
          'data: {"type":"text-delta","id":"1","delta":"Hello"}',
          'data: {"type":"finish","finishReason":"stop","usage":{"inputTokens":{"total":100},"outputTokens":{"total":20}},"providerMetadata":{"gateway":{"cost":"0.0015"}}}',
          "",
        ].join("\n\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    const streamed = await h.request("/v1/ai/language-model", {
      method: "POST",
      headers: { authorization: `Bearer ${account.token}`, "content-type": "application/json", "ai-model-id": "openai/gpt-5.6-terra" },
      body: JSON.stringify({ prompt: [] }),
    });
    expect(streamed.status).toBe(200);
    await streamed.text();

    // A JSON embedding answer: input tokens only, no cost.
    answer = () => Response.json({ embeddings: [[0.1]], usage: { tokens: 7 } });
    await (
      await h.request("/v1/ai/embedding-model", {
        method: "POST",
        headers: { authorization: `Bearer ${account.token}`, "content-type": "application/json", "ai-model-id": "openai/text-embedding-3-small" },
        body: JSON.stringify({ values: ["x"] }),
      })
    ).text();

    // Speech carries no usage at all; a refusal still counts as a request.
    answer = () => new Response(new Uint8Array(2048), { status: 200, headers: { "content-type": "audio/mpeg" } });
    await (await h.request("/v1/ai/speech-model", jsonInit("POST", { text: "hi" }, account.token))).arrayBuffer();
    answer = () => Response.json({ error: { type: "rate_limit_exceeded", message: "slow down" } }, { status: 429 });
    await (await h.request("/v1/ai/language-model", jsonInit("POST", {}, account.token))).text();
    await h.control.idle();

    const usage = await json<{
      day: { requests: number; inputTokens: number; outputTokens: number; costUsd: string };
      month: { requests: number };
      models: Array<{ kind: string; modelId: string | null; requests: number; inputTokens: number; costUsd: string }>;
      since: { day: string; month: string };
    }>(await h.request("/v1/ai-usage", authed(account.token)));
    expect(usage.day).toEqual({ requests: 4, inputTokens: 107, outputTokens: 20, costUsd: "0.0015" });
    expect(usage.month.requests).toBe(4);
    expect(usage.models).toEqual([
      { kind: "language-model", modelId: "openai/gpt-5.6-terra", requests: 1, inputTokens: 100, outputTokens: 20, costUsd: "0.0015" },
      { kind: "embedding-model", modelId: "openai/text-embedding-3-small", requests: 1, inputTokens: 7, outputTokens: 0, costUsd: "0" },
      { kind: "language-model", modelId: null, requests: 1, inputTokens: 0, outputTokens: 0, costUsd: "0" },
      { kind: "speech-model", modelId: null, requests: 1, inputTokens: 0, outputTokens: 0, costUsd: "0" },
    ]);
    expect(Date.parse(usage.since.day)).toBeLessThanOrEqual(Date.now());

    // The rows themselves: status, bytes, and the device that spent them.
    const rows = await h.db.select().from(schema.aiUsage).where(eq(schema.aiUsage.userId, account.userId));
    expect(rows.map((row) => row.status).sort()).toEqual([200, 200, 200, 429]);
    expect(rows.every((row) => row.deviceId === account.deviceId)).toBe(true);
    expect(rows.find((row) => row.kind === "speech-model")?.responseBytes).toBe(2048);
    expect(rows.every((row) => row.requestBytes > 0)).toBe(true);

    // Another account sees none of it.
    const other = await desktopAccount(h);
    const theirs = await json<{ month: { requests: number } }>(await h.request("/v1/ai-usage", authed(other.token)));
    expect(theirs.month.requests).toBe(0);
  });

  it("lets the account cap its month, refuses at the cap without spending, and lifts it again", async () => {
    const account = await desktopAccount(h);
    const read = async () =>
      json<{ month: { costUsd: string }; cap: { monthlyUsd: string | null; reached: boolean } }>(
        await h.request("/v1/ai-usage", authed(account.token)),
      );
    expect((await read()).cap).toEqual({ monthlyUsd: null, reached: false });

    // A dollar of cap, then a call that costs sixty cents: still under.
    const set = await h.request("/v1/ai-usage/cap", jsonInit("PUT", { monthlyUsd: "1" }, account.token));
    expect(set.status).toBe(200);
    expect((await json<{ cap: { monthlyUsd: string } }>(set)).cap.monthlyUsd).toBe("1");
    answer = () =>
      new Response('data: {"type":"finish","usage":{"inputTokens":10,"outputTokens":1},"providerMetadata":{"gateway":{"cost":"0.6"}}}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    const under = await h.request("/v1/ai/language-model", jsonInit("POST", {}, account.token));
    expect(under.status).toBe(200);
    await under.text();
    await h.control.idle();
    expect((await read()).cap.reached).toBe(false);

    // The next call takes it to the cap; the one after is refused before it
    // reaches the gateway, in the gateway's own shape.
    const sentBefore = seen.length;
    await (await h.request("/v1/ai/language-model", jsonInit("POST", {}, account.token))).text();
    await h.control.idle();
    const at = await read();
    expect(at.month.costUsd).toBe("1.2");
    expect(at.cap.reached).toBe(true);
    const refused = await h.request("/v1/ai/language-model", jsonInit("POST", {}, account.token));
    expect(refused.status).toBe(403);
    const refusal = await json<{ error: { type: string; message: string }; reason: string }>(refused);
    expect(refusal.reason).toBe("ai_budget_exceeded");
    expect(refusal.error.type).toBe("forbidden");
    expect(refusal.error.message).toContain("cap");
    expect(seen.length).toBe(sentBefore + 1);
    await h.control.idle();
    // A refusal is not a request against the meter.
    expect((await read()).month.costUsd).toBe("1.2");

    // A cap of zero means nothing at all; removing it opens the tap again.
    await h.request("/v1/ai-usage/cap", jsonInit("PUT", { monthlyUsd: 0 }, account.token));
    expect((await h.request("/v1/ai/embedding-model", jsonInit("POST", {}, account.token))).status).toBe(403);
    const lifted = await h.request("/v1/ai-usage/cap", jsonInit("PUT", { monthlyUsd: null }, account.token));
    expect((await json<{ cap: { monthlyUsd: null; reached: boolean } }>(lifted)).cap).toEqual({ monthlyUsd: null, reached: false });
    answer = () => Response.json({ embeddings: [], usage: { tokens: 1 } });
    expect((await h.request("/v1/ai/embedding-model", jsonInit("POST", {}, account.token))).status).toBe(200);

    // Nonsense is refused, and a bootstrap token cannot set a cap.
    for (const bad of ["-1", "lots", "1e12"]) {
      expect((await h.request("/v1/ai-usage/cap", jsonInit("PUT", { monthlyUsd: bad }, account.token))).status, bad).toBe(400);
    }
    const { bootstrapToken } = await signup(h);
    expect((await h.request("/v1/ai-usage/cap", jsonInit("PUT", { monthlyUsd: "5" }, bootstrapToken))).status).toBe(403);
  });

  it("prunes meter rows past their retention, and keeps the rest", async () => {
    const account = await desktopAccount(h);
    const old = new Date(Date.now() - 91 * 86_400_000);
    await h.db.insert(schema.aiUsage).values([
      { userId: account.userId, deviceId: account.deviceId, kind: "language-model", status: 200, requestBytes: 1, responseBytes: 1, durationMs: 1, at: old },
      { userId: account.userId, deviceId: account.deviceId, kind: "language-model", status: 200, requestBytes: 1, responseBytes: 1, durationMs: 1 },
    ]);
    const result = await h.control.runMaintenance();
    expect(result.prunedAiUsage).toBe(1);
    const left = await h.db.select().from(schema.aiUsage).where(eq(schema.aiUsage.userId, account.userId));
    expect(left).toHaveLength(1);
  });

  it("uses a device's own bearer, whichever account it belongs to", async () => {
    // Two accounts share the operator's key; the proxy does not tell them apart.
    const first = await desktopAccount(h);
    const second = await desktopAccount(h);
    answer = () => Response.json({ ok: true });
    for (const token of [first.token, second.token]) {
      const res = await h.request("/v1/ai/config", authed(token));
      expect(res.status).toBe(200);
      expect(seen.at(-1)?.url).toBe("https://gateway.example/v4/ai/config");
      expect(seen.at(-1)?.headers["authorization"]).toBe(`Bearer ${GATEWAY_KEY}`);
    }
  });
});
