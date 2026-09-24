import { describe, expect, it, vi } from "vitest";
import { gatewayPrivacyFetch } from "../src/gateway-privacy.js";

describe("AI Gateway data policy", () => {
  it("protects old clients and overrides opt-outs while preserving routing, payload, and credentials", async () => {
    const seen: Request[] = [];
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      seen.push(new Request(input, init));
      return new Response("data: response\n\n", { headers: { "content-type": "text/event-stream" } });
    });
    const send = gatewayPrivacyFetch(upstream);
    for (const body of [
      { prompt: [{ role: "user", content: "Synthetic test" }] },
      { state: "Synthetic test", questions: {}, providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } }, gateway: { disallowPromptTraining: false, zeroDataRetention: true, only: ["anthropic"] } } },
    ]) {
      const response = await send("https://gateway.example/v4/ai/language-model", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer test-key", "ai-model-id": "test-model", "content-length": "1" },
        body: JSON.stringify(body),
      });
      const forwarded = seen.at(-1)!;
      const parsed = await forwarded.json();
      expect(parsed).toMatchObject(body.providerOptions ? { ...body, providerOptions: { ...body.providerOptions, gateway: { ...body.providerOptions.gateway, disallowPromptTraining: true } } } : body);
      expect(parsed.providerOptions.gateway.disallowPromptTraining).toBe(true);
      expect(forwarded.headers.get("authorization")).toBe("Bearer test-key");
      expect(forwarded.headers.get("ai-model-id")).toBe("test-model");
      expect(forwarded.headers.has("content-length")).toBe(false);
      expect(await response.text()).toBe("data: response\n\n");
    }
  });

  it("refuses malformed or non-JSON POSTs before any data reaches the provider", async () => {
    const upstream = vi.fn<typeof fetch>();
    const send = gatewayPrivacyFetch(upstream);
    for (const body of ["invalid", "null", "[]", '{"providerOptions":[]}', '{"providerOptions":{"gateway":false}}']) {
      await expect(send("https://gateway.example/v4/ai/evaluation-model", {
        method: "POST", headers: { "content-type": "application/json" }, body,
      })).rejects.toThrow();
    }
    await expect(send("https://gateway.example/v4/ai/language-model", { method: "POST", body: "{}" })).rejects.toThrow("must use JSON");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("passes through model discovery and does not retry a provider-policy refusal", async () => {
    const upstream = vi.fn<typeof fetch>(async () => new Response("no_providers_available", { status: 400 }));
    const send = gatewayPrivacyFetch(upstream);
    expect((await send("https://gateway.example/v1/models")).status).toBe(400);
    const response = await send("https://gateway.example/v4/ai/language-model", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    expect(response.status).toBe(400);
    expect(upstream).toHaveBeenCalledTimes(2);
  });
});
