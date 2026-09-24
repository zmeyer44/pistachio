/**
 * The run fold both hosts share (docs/web-browser-design.md §8,
 * docs/cloud-sync-design.md §7.8): what control's stream is allowed to say,
 * what a reader may fold onto nothing, and where a run's identity comes from.
 */

import { describe, expect, it } from "vitest";
import type { RunSummary } from "@pistachio/protocol";
import {
  desktopThreadRun,
  foldRunInto,
  parseContentEvent,
  parseStoredRunEvent,
  RUN_CONTENT_EVENT_TYPES,
  RUN_CONTROL_EVENT_TYPES,
  webStartUrl,
} from "../src/run-fold.js";

const AT = "2026-09-09T10:00:00.000Z";
const RUN = "8f1c2e3a-0000-4000-8000-000000000001";

function created(runId: string): RunSummary {
  return {
    runId,
    taskId: "task-1",
    status: "running",
    purpose: "Read the fixture page",
    title: "Read the fixture page",
    updatedAt: AT,
    turns: 1,
    notes: "",
    context: {
      tokens: null,
      compactAt: 0,
      window: 0,
      compactions: 0,
      steps: 0,
      totalSteps: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
    },
    humanTabId: "tab-of-another-device",
    agentTabId: null,
    startedAt: AT,
    completedAt: null,
    control: "agent",
    messages: [],
    toolCalls: [],
    subagents: [],
    activity: [],
    pendingApproval: null,
    pendingQuestion: null,
    pendingTakeover: null,
    result: null,
  } as unknown as RunSummary;
}

describe("the event tables", () => {
  it("keep content and control apart, with no member in both", () => {
    for (const type of RUN_CONTENT_EVENT_TYPES) expect(RUN_CONTROL_EVENT_TYPES.has(type)).toBe(false);
    expect(RUN_CONTROL_EVENT_TYPES.has("run.created")).toBe(true);
    expect(RUN_CONTENT_EVENT_TYPES.has("message")).toBe(true);
  });
});

describe("parseStoredRunEvent", () => {
  it("accepts a control event and a sealed one", () => {
    expect(parseStoredRunEvent({ seq: 1, eventId: "e", at: AT, event: { t: "status", status: "running", completedAt: null } })?.seq).toBe(1);
    expect(parseStoredRunEvent({ seq: 2, eventId: "e", at: AT, event: { t: "sealed", spaceId: "work", sealed: "AAAA" } })?.event.t).toBe("sealed");
  });

  it("refuses plaintext content, an unknown type, and a malformed envelope", () => {
    // Content in the clear is a control plane that opened something it must not.
    expect(parseStoredRunEvent({ seq: 1, eventId: "e", at: AT, event: { t: "message", message: {} } })).toBeNull();
    expect(parseStoredRunEvent({ seq: 1, eventId: "e", at: AT, event: { t: "invented" } })).toBeNull();
    expect(parseStoredRunEvent({ seq: -1, eventId: "e", at: AT, event: { t: "status" } })).toBeNull();
    expect(parseStoredRunEvent({ seq: 1, eventId: "", at: AT, event: { t: "status" } })).toBeNull();
    expect(parseStoredRunEvent({ seq: 1, eventId: "e", at: AT, event: { t: "sealed", spaceId: "work" } })).toBeNull();
    expect(parseStoredRunEvent(null)).toBeNull();
  });
});

describe("parseContentEvent", () => {
  it("takes an opened content event and nothing else", () => {
    expect(parseContentEvent({ t: "message", message: { role: "user", content: "hi" } })?.t).toBe("message");
    expect(parseContentEvent({ t: "status", status: "running" })).toBeNull();
    expect(parseContentEvent("message")).toBeNull();
  });
});

describe("foldRunInto", () => {
  it("refuses to invent a run for a stream joined mid-way", () => {
    expect(foldRunInto(null, RUN, { t: "status", status: "completed", completedAt: AT }, AT)).toBeNull();
  });

  it("names the run the reader asked for and never one of the reader's tabs", () => {
    const run = foldRunInto(null, RUN, { t: "run.created", run: created("some-other-id") }, AT);
    expect(run?.runId).toBe(RUN);
    expect(run?.humanTabId).toBeNull();
    expect(run?.executor).toEqual({ kind: "cloud", deviceId: null, workerId: null });
  });

  it("folds the stream onto the run it started", () => {
    const start = foldRunInto(null, RUN, { t: "run.created", run: created(RUN) }, AT);
    const titled = foldRunInto(start, RUN, { t: "title", title: "Fixture" }, AT);
    const done = foldRunInto(titled, RUN, { t: "status", status: "completed", completedAt: AT }, AT);
    expect(done?.title).toBe("Fixture");
    expect(done?.status).toBe("completed");
    // The fold is pure: the earlier run is untouched.
    expect(start?.title).toBe("Read the fixture page");
  });
});

describe("desktopThreadRun", () => {
  it("takes a version 2 snapshot's run and refuses anything else", () => {
    expect(desktopThreadRun({ version: 2, run: { runId: RUN } })?.runId).toBe(RUN);
    expect(desktopThreadRun({ version: 1, run: { runId: RUN } })).toBeNull();
    // A cloud run's `thread` is the runner's checkpoint, which has no `run`.
    expect(desktopThreadRun({ version: 2, messages: [], turns: 1 })).toBeNull();
    expect(desktopThreadRun("nope")).toBeNull();
  });
});

describe("webStartUrl", () => {
  it("passes a web address through and drops everything else", () => {
    expect(webStartUrl("https://a.example/x?y=1")).toBe("https://a.example/x?y=1");
    expect(webStartUrl("http://a.example/")).toBe("http://a.example/");
    expect(webStartUrl("file:///etc/passwd")).toBeUndefined();
    expect(webStartUrl("pistachio://settings")).toBeUndefined();
    expect(webStartUrl("")).toBeUndefined();
    expect(webStartUrl(null)).toBeUndefined();
  });
});
