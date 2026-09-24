import { describe, expect, it } from "vitest";
import { jsonInit, makeHarness } from "./helpers.js";

describe("request limits", () => {
  it("refuses an oversized body before any handler buffers it", async () => {
    const h = await makeHarness();
    const declared = await h.request("/v1/accounts", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(33 * 1024 * 1024) },
      body: "{}",
    });
    expect(declared.status).toBe(413);
    expect(await declared.json()).toEqual({ error: "payload_too_large" });

    const streamed = await h.request("/v1/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@b.c", password: "x".repeat(33 * 1024 * 1024) }),
    });
    expect(streamed.status).toBe(413);
  });

  it("bounds device challenges per client address so one caller cannot fill the store", async () => {
    const h = await makeHarness();
    const from = (ip: string): RequestInit => {
      const init = jsonInit("POST", { deviceId: crypto.randomUUID() });
      return { ...init, headers: { ...(init.headers as Record<string, string>), "x-forwarded-for": `${ip}, 10.0.0.1` } };
    };
    const statuses: number[] = [];
    for (let i = 0; i < 121; i += 1) statuses.push((await h.request("/v1/auth/device-challenge", from("203.0.113.9"))).status);
    expect(statuses.slice(0, 120).every((status) => status === 200)).toBe(true);
    expect(statuses[120]).toBe(429);
    expect((await h.request("/v1/auth/device-challenge", from("203.0.113.10"))).status).toBe(200);
  });
});
