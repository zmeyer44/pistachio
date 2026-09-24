import { describe, expect, it } from "vitest";
import { isFeedbackReport, MAX_FEEDBACK_MESSAGE, sanitizeFeedbackInput, type FeedbackReport } from "../src/index.js";

function report(overrides: Partial<FeedbackReport> = {}): FeedbackReport {
  return {
    version: 1,
    id: "16fd2706-8baf-433b-82eb-8c7fada847da",
    sentAt: "2026-08-27T14:00:00.000Z",
    message: "The vendor link opened the wrong page.",
    reaction: "sad",
    app: { version: "0.0.1", electron: "43.3.0", chrome: "140.0.0.0", platform: "darwin arm64", model: "openai/gpt-5.6-terra" },
    browser: { activeTab: { url: "pistachio://demo/invoices", title: "Northstar · Invoice reconciliation" }, tabCount: 1 },
    run: null,
    ...overrides,
  };
}

describe("sanitizeFeedbackInput", () => {
  it("trims the message and keeps a known reaction", () => {
    expect(sanitizeFeedbackInput({ message: "  Loved it  ", reaction: "love" })).toEqual({ message: "Loved it", reaction: "love" });
  });

  it("drops an unknown reaction rather than the whole input", () => {
    expect(sanitizeFeedbackInput({ message: "ok", reaction: "meh" })).toEqual({ message: "ok", reaction: null });
    expect(sanitizeFeedbackInput({ message: "ok" })).toEqual({ message: "ok", reaction: null });
  });

  it("refuses nothing to send", () => {
    expect(sanitizeFeedbackInput({ message: "   ", reaction: "love" })).toBeNull();
    expect(sanitizeFeedbackInput({ message: "x".repeat(MAX_FEEDBACK_MESSAGE + 1), reaction: null })).toBeNull();
    expect(sanitizeFeedbackInput("hello")).toBeNull();
    expect(sanitizeFeedbackInput(null)).toBeNull();
  });
});

describe("isFeedbackReport", () => {
  it("accepts a whole report, with or without a run", () => {
    expect(isFeedbackReport(report())).toBe(true);
    expect(isFeedbackReport(report({ run: { runId: "r", messages: [], toolCalls: [] } as unknown as FeedbackReport["run"] }))).toBe(true);
    expect(isFeedbackReport(report({ browser: { activeTab: null, tabCount: 0 }, reaction: null }))).toBe(true);
  });

  it("refuses an id that is not an id, since it names a file", () => {
    expect(isFeedbackReport(report({ id: "../../etc/passwd" }))).toBe(false);
    expect(isFeedbackReport(report({ id: "" }))).toBe(false);
  });

  it("refuses a malformed envelope", () => {
    expect(isFeedbackReport(null)).toBe(false);
    expect(isFeedbackReport(report({ version: 2 as unknown as 1 }))).toBe(false);
    expect(isFeedbackReport(report({ message: " " }))).toBe(false);
    expect(isFeedbackReport(report({ reaction: "meh" as unknown as "love" }))).toBe(false);
    expect(isFeedbackReport(report({ sentAt: "yesterday" }))).toBe(false);
    expect(isFeedbackReport({ ...report(), app: { version: "1" } })).toBe(false);
    expect(isFeedbackReport(report({ run: { runId: "r" } as unknown as FeedbackReport["run"] }))).toBe(false);
  });
});
