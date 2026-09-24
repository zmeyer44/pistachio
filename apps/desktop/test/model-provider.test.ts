import { afterEach, describe, expect, it } from "vitest";
import {
  accountFetch,
  aiProviderStatus,
  configuredIntentModel,
  intentModelName,
  NOT_SIGNED_IN,
  setAiSession,
  type AiSession,
} from "../src/main/model-provider";

function session(overrides: Partial<AiSession> = {}): AiSession {
  return {
    controlUrl: "https://control.example",
    enrolled: () => true,
    getToken: () => Promise.resolve("device-jwt"),
    ...overrides,
  };
}

describe("aiProviderStatus", () => {
  it("is unavailable until the account services exist, and while this Mac is not enrolled", () => {
    setAiSession(null);
    expect(aiProviderStatus()).toEqual({ available: false, controlUrl: null });
    setAiSession(session({ enrolled: () => false }));
    expect(aiProviderStatus()).toEqual({ available: false, controlUrl: "https://control.example" });
    setAiSession(session());
    expect(aiProviderStatus()).toEqual({ available: true, controlUrl: "https://control.example" });
    setAiSession(null);
  });
});

describe("accountFetch", () => {
  it("replaces the SDK's placeholder credential with the device token, keeping the other headers", async () => {
    const seen: Array<{ url: string; headers: Headers }> = [];
    const fetchImpl: typeof fetch = (input, init) => {
      seen.push({ url: String(input), headers: new Headers(init?.headers) });
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    const send = accountFetch(() => session(), fetchImpl);
    const res = await send("https://control.example/v1/ai/language-model", {
      method: "POST",
      headers: { Authorization: "Bearer device-token", "ai-model-id": "openai/gpt-5.6-terra" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer device-jwt");
    expect(seen[0]?.headers.get("ai-model-id")).toBe("openai/gpt-5.6-terra");
  });

  it("asks for the token on every request, so a run outlives a refresh", async () => {
    let issued = 0;
    const fetchImpl: typeof fetch = () => Promise.resolve(new Response("{}"));
    const send = accountFetch(
      () =>
        session({
          getToken: () => {
            issued += 1;
            return Promise.resolve(`jwt-${String(issued)}`);
          },
        }),
      fetchImpl,
    );
    await send("https://control.example/v1/ai/language-model", { method: "POST", body: "{}" });
    await send("https://control.example/v1/ai/language-model", { method: "POST", body: "{}" });
    expect(issued).toBe(2);
  });

  it("refuses to send anything without a token — signed out, revoked, or no account services", async () => {
    let sent = 0;
    const fetchImpl: typeof fetch = () => {
      sent += 1;
      return Promise.resolve(new Response("{}"));
    };
    for (const current of [
      () => null,
      () => session({ enrolled: () => false }),
      () => session({ getToken: () => Promise.resolve(null) }),
    ]) {
      await expect(accountFetch(current, fetchImpl)("https://control.example/v1/ai/config")).rejects.toThrow(NOT_SIGNED_IN);
    }
    expect(sent).toBe(0);
  });

  it("retries once when its own deadline cut a resendable request, then fails plainly", async () => {
    let attempts = 0;
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        attempts += 1;
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const send = accountFetch(() => session(), hang, 20);
    await expect(send("https://control.example/v1/ai/language-model", { method: "POST", body: "{}" })).rejects.toThrow(
      /did not answer within 0.02s \(twice in a row\)/,
    );
    expect(attempts).toBe(2);
  });

  it("does not retry when the caller aborted", async () => {
    let attempts = 0;
    // Like the real fetch: an already-aborted signal rejects at once.
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        attempts += 1;
        if (init?.signal?.aborted === true) reject(new Error("caller aborted"));
        init?.signal?.addEventListener("abort", () => reject(new Error("caller aborted")));
      });
    const controller = new AbortController();
    const send = accountFetch(() => session(), hang, 10_000);
    const pending = send("https://control.example/v1/ai/language-model", {
      method: "POST",
      body: "{}",
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow("caller aborted");
    expect(attempts).toBe(1);
  });
});

describe("the intent model", () => {
  const configured = process.env["PISTACHIO_INTENT_MODEL"];
  afterEach(() => {
    if (configured === undefined) delete process.env["PISTACHIO_INTENT_MODEL"];
    else process.env["PISTACHIO_INTENT_MODEL"] = configured;
    setAiSession(null);
  });

  it("is Jev unless the environment names another, and nothing at all when it says off", () => {
    delete process.env["PISTACHIO_INTENT_MODEL"];
    expect(intentModelName()).toBe("typesafe-ai/jev");
    process.env["PISTACHIO_INTENT_MODEL"] = " typesafe-ai/jev-mini ";
    expect(intentModelName()).toBe("typesafe-ai/jev-mini");
    for (const off of ["off", "0", "false"]) {
      process.env["PISTACHIO_INTENT_MODEL"] = off;
      expect(intentModelName()).toBeNull();
    }
  });

  it("is null while this Mac is not enrolled, and when it is turned off — never a throw", () => {
    delete process.env["PISTACHIO_INTENT_MODEL"];
    setAiSession(null);
    expect(configuredIntentModel()).toBeNull();
    setAiSession(session({ enrolled: () => false }));
    expect(configuredIntentModel()).toBeNull();
    setAiSession(session());
    expect(configuredIntentModel()?.id).toBe("typesafe-ai/jev");
    process.env["PISTACHIO_INTENT_MODEL"] = "off";
    expect(configuredIntentModel()).toBeNull();
  });
});
