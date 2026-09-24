import { describe, expect, it } from "vitest";
import { boundPageResumes, sanitizePageResume } from "../src/page-resume.js";

describe("portable page checkpoints", () => {
  it("rejects other documents and local or privileged URLs", () => {
    expect(sanitizePageResume({ url: "https://a.test/one" }, "https://a.test/two")).toBeUndefined();
    expect(sanitizePageResume({ url: "file:///private" }, "file:///private")).toBeUndefined();
  });
  it("bounds untrusted state and excludes credential fields", () => {
    const state = sanitizePageResume({ url: "https://a.test/", scrollX: Infinity, scrollY: -1, drafts: [
      { id: "password", value: "secret" }, { name: "draft", value: "x".repeat(10000) },
      { value: "anonymous" }, { name: "credit-card", value: "secret" },
    ] }, "https://a.test/");
    expect(state?.scrollX).toBe(0);
    expect(state?.scrollY).toBe(0);
    expect(state?.drafts).toEqual([{ id: "", name: "draft", value: "x".repeat(2048) }]);
  });
});

it("keeps the active page checkpoint within a session-wide budget without dropping tabs", () => {
  const tabs = Array.from({ length: 200 }, (_, i) => ({ id: String(i), resume: { url: "https://a.test/", scrollX: 0, scrollY: i, drafts: [{ id: "draft", name: "", value: "x".repeat(8192) }] } }));
  const bounded = boundPageResumes(tabs, "199");
  expect(bounded.map(tab => tab.id)).toEqual(tabs.map(tab => tab.id));
  expect(bounded[199]?.resume).toEqual(tabs[199]?.resume);
  expect(bounded.filter(tab => tab.resume).length).toBeLessThan(20);
  expect(tabs.every(tab => tab.resume)).toBe(true);
});
