import { describe, expect, it, vi } from "vitest";
import { isFeedbackReport } from "@pistachio/protocol";
import { buildFeedbackReport, feedbackEndpoint, postFeedback, submitFeedback, type FeedbackContext } from "../src/main/feedback";

const context: FeedbackContext = {
  app: { version: "0.0.1", electron: "43.3.0", chrome: "140.0.0.0", platform: "darwin arm64" },
  browser: { activeTab: { url: "pistachio://demo/invoices", title: "Northstar · Invoice reconciliation" }, tabCount: 2 },
  run: null,
};

function respond(status: number): typeof fetch {
  return vi.fn(async () => new Response(status === 204 ? null : "{}", { status })) as unknown as typeof fetch;
}

describe("feedbackEndpoint", () => {
  it("appends /feedback to PISTACHIO_API_URL, whatever its trailing slashes", () => {
    expect(feedbackEndpoint({ PISTACHIO_API_URL: "http://localhost:3000/api" })).toBe("http://localhost:3000/api/feedback");
    expect(feedbackEndpoint({ PISTACHIO_API_URL: "http://localhost:3000/api/" })).toBe("http://localhost:3000/api/feedback");
    expect(feedbackEndpoint({ PISTACHIO_API_URL: " https://pistachio.example/api " })).toBe("https://pistachio.example/api/feedback");
  });

  it("is null when the variable is unset, blank, or not an address", () => {
    expect(feedbackEndpoint({})).toBeNull();
    expect(feedbackEndpoint({ PISTACHIO_API_URL: "  " })).toBeNull();
    expect(feedbackEndpoint({ PISTACHIO_API_URL: "not a url" })).toBeNull();
  });
});

describe("buildFeedbackReport", () => {
  it("wraps the input and context in a report the endpoint accepts", () => {
    const report = buildFeedbackReport(
      { message: "The vendor link opened the wrong page.", reaction: "sad" },
      context,
      "openai/gpt-5.6-terra",
      new Date("2026-08-27T14:00:00Z"),
      "16fd2706-8baf-433b-82eb-8c7fada847da",
    );
    expect(report).toEqual({
      version: 1,
      id: "16fd2706-8baf-433b-82eb-8c7fada847da",
      sentAt: "2026-08-27T14:00:00.000Z",
      message: "The vendor link opened the wrong page.",
      reaction: "sad",
      app: { ...context.app, model: "openai/gpt-5.6-terra" },
      browser: context.browser,
      run: null,
    });
    expect(isFeedbackReport(report)).toBe(true);
  });

  it("mints a distinct id per report by default", () => {
    const input = { message: "ok", reaction: null };
    expect(buildFeedbackReport(input, context, "m").id).not.toBe(buildFeedbackReport(input, context, "m").id);
  });
});

describe("postFeedback", () => {
  const report = buildFeedbackReport({ message: "hi", reaction: "love" }, context, "m");

  it("posts the report as JSON and succeeds on any 2xx", async () => {
    const fetchImpl = respond(201);
    await expect(postFeedback(report, "http://localhost:3000/api/feedback", fetchImpl)).resolves.toEqual({ ok: true });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/feedback");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual(report);
  });

  it("names the status when the service refuses", async () => {
    await expect(postFeedback(report, "http://localhost:3000/api/feedback", respond(500))).resolves.toEqual({
      ok: false,
      error: "http://localhost:3000/api/feedback answered 500.",
    });
  });

  it("names the endpoint when the service is unreachable", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(postFeedback(report, "http://localhost:3000/api/feedback", down)).resolves.toEqual({
      ok: false,
      error: "Couldn't reach http://localhost:3000/api/feedback: fetch failed",
    });
  });
});

describe("submitFeedback", () => {
  it("refuses an empty message before looking for an endpoint", async () => {
    const fetchImpl = respond(201);
    await expect(submitFeedback({ message: "   ", reaction: "love" }, context, { PISTACHIO_API_URL: "http://localhost:3000/api" }, fetchImpl)).resolves.toEqual({
      ok: false,
      error: "Write a few words first.",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("says which variable to set when there is no endpoint", async () => {
    const fetchImpl = respond(201);
    await expect(submitFeedback({ message: "hi", reaction: null }, context, {}, fetchImpl)).resolves.toEqual({
      ok: false,
      error: "Set PISTACHIO_API_URL to the API that receives feedback.",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends a report carrying the conversation", async () => {
    const fetchImpl = respond(201);
    const run = { runId: "run-1", messages: [{ role: "user", content: "hi" }], toolCalls: [{ id: "t1" }] } as unknown as FeedbackContext["run"];
    await expect(submitFeedback({ message: " hi ", reaction: "happy" }, { ...context, run }, { PISTACHIO_API_URL: "http://localhost:3000/api" }, fetchImpl)).resolves.toEqual({ ok: true });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent["message"]).toBe("hi");
    expect(sent["reaction"]).toBe("happy");
    expect(sent["run"]).toEqual(run);
    expect(isFeedbackReport(sent)).toBe(true);
  });
});
