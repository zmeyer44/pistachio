/**
 * CloudRunService (docs/cloud-sync-design.md §10.4, §7.8): the SSE parser's
 * framing; a run's stream folded into the console's RunSummary with sealed
 * content opened under real Space keys (and left closed without them); the
 * folded run landing in the thread store and the console; a dropped stream
 * re-dialed from the last seq; starting a run from the active Space and tab;
 * steering forwarded to control; and RunController leaving a live cloud
 * record alone at restart while steering it through control.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationRouter } from "@pistachio/notifications";
import type { AgentMessage, AgentQuestion, RunEvent, RunSummary, StoredRunEvent, ThreadListItem } from "@pistachio/protocol";
import { deriveSpaceKeys, runEventSealAad, seal, toBase64, utf8 } from "@pistachio/sync-protocol";
import type { ControlClient } from "../src/main/account/control-client";
import type { BrowserController } from "../src/main/browser-controller";
import { CloudRunService, parseStoredRunEvent, webStartUrl } from "../src/main/cloud/cloud-run-service";
import { RunController, type CloudRunCommands } from "../src/main/run-controller";
import { ThreadStore } from "../src/main/thread-store";

const dirs: string[] = [];
const services: CloudRunService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "pistachio-cloud-"));
  dirs.push(dir);
  return dir;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, what = "condition", timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/* ---------------------------------- fixtures ---------------------------------- */

const T0 = "2026-09-02T10:00:00.000Z";
const SECRET = new Uint8Array(32).fill(5);

function createdRun(runId: string): RunSummary {
  return {
    runId,
    taskId: "task-1",
    status: "ready",
    purpose: "Book a table",
    title: "Book a table",
    updatedAt: T0,
    turns: 1,
    notes: "",
    context: { tokens: null, compactAt: 0, window: 0, compactions: 0, steps: 0, totalSteps: 0, usage: { inputTokens: 0, outputTokens: 0 } },
    humanTabId: null,
    agentTabId: null,
    startedAt: T0,
    completedAt: null,
    control: "agent",
    executor: { kind: "cloud", deviceId: "cloud-1", workerId: null },
    pendingApproval: null,
    pendingQuestion: null,
    pendingTakeover: null,
    messages: [],
    toolCalls: [],
    subagents: [],
    activity: [],
    result: null,
  };
}

async function sealed(runId: string, eventId: string, plain: unknown, secret = SECRET, spaceId = "work"): Promise<RunEvent> {
  const keys = await deriveSpaceKeys(spaceId, secret);
  return {
    t: "sealed",
    spaceId,
    sealed: toBase64(await seal(keys.sealKey, utf8(JSON.stringify(plain)), runEventSealAad(runId, eventId))),
  };
}

function stored(seq: number, event: RunEvent, at = T0): StoredRunEvent {
  return { seq, eventId: `evt-${String(seq)}`, at, event };
}

function frame(event: StoredRunEvent): string {
  return `id: ${String(event.seq)}\nevent: run\ndata: ${JSON.stringify(event)}\n\n`;
}

const END = 'event: end\ndata: {"status":"completed"}\n\n';

function listItem(run: RunSummary): ThreadListItem {
  return {
    runId: run.runId,
    title: run.title,
    status: run.status,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    turns: run.turns,
    messageCount: 0,
    executor: { kind: "cloud", deviceId: null, workerId: null },
  };
}

/** A stream of chunks; `hang` keeps it open until the request is aborted. */
function streamOf(chunks: string[], hang: boolean, signal: AbortSignal | null | undefined): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (!hang) {
        controller.close();
        return;
      }
      signal?.addEventListener("abort", () => {
        try {
          controller.error(new Error("aborted"));
        } catch {
          // Already closed.
        }
      });
    },
  });
}

interface Harness {
  service: CloudRunService;
  threads: ThreadStore;
  control: {
    listed: string[];
    fetched: string[];
    created: unknown[];
    desktopCreated: unknown[];
    desktopSnapshots: unknown[];
    imessageDeliveries: Array<{ runId: string; input: unknown }>;
    imessageLinkChecks: number;
    commands: Array<{ kind: string; runId: string; body?: unknown }>;
    runs: Record<string, ThreadListItem[]>;
    listRuns: ((spaceId: string) => Promise<ThreadListItem[]>) | null;
    /** The chunks (and whether to hang) per dial, keyed by `since`. */
    stream: (runId: string, since: number) => { chunks: string[]; hang: boolean } | { status: number };
  };
  refreshed: RunSummary[];
  imessageAnswers: Array<{ runId: string; questionId: string; value: string }>;
  sinkReady: boolean;
  changes: number;
}

function harness(options: {
  secret?: Uint8Array | null;
  /** A Space secret the test moves while the service runs, as enrollment does. */
  spaceSecret?: () => Uint8Array | null;
  activeTabUrl?: string | null;
  imessageLinked?: boolean;
  sinkReady?: boolean;
} = {}): Harness {
  const dir = scratch();
  const threads = new ThreadStore(dir);
  const h: Harness = {
    service: undefined as unknown as CloudRunService,
    threads,
    control: {
      listed: [],
      fetched: [],
      created: [],
      desktopCreated: [],
      desktopSnapshots: [],
      imessageDeliveries: [],
      imessageLinkChecks: 0,
      commands: [],
      runs: {},
      listRuns: null,
      stream: () => ({ chunks: [], hang: false }),
    },
    refreshed: [],
    imessageAnswers: [],
    sinkReady: options.sinkReady ?? true,
    changes: 0,
  };
  const client = {
    listRuns: async (spaceId: string) => {
      h.control.listed.push(spaceId);
      if (h.control.listRuns !== null) return await h.control.listRuns(spaceId);
      return h.control.runs[spaceId] ?? [];
    },
    runEventsUrl: (runId: string, since?: number) => `http://control.test/v1/runs/${runId}/events?since=${String(since ?? 0)}`,
    authorizedHeaders: async () => ({ authorization: "Bearer device-token" }),
    createRun: async (input: unknown) => {
      h.control.created.push(input);
      return { runId: "run-new" };
    },
    createDesktopRun: async (input: unknown) => {
      h.control.desktopCreated.push(input);
    },
    putDesktopRunSnapshot: async (_runId: string, input: unknown) => {
      h.control.desktopSnapshots.push(input);
    },
    imessageLink: async () => {
      h.control.imessageLinkChecks += 1;
      const linked = options.imessageLinked ?? true;
      return { available: true, linked, phone: linked ? "••• ••• 0123" : null, verifiedAt: linked ? T0 : null };
    },
    deliverIMessage: async (runId: string, input: unknown) => {
      h.control.imessageDeliveries.push({ runId, input });
      return true;
    },
    runMessage: async (runId: string, body: unknown) => {
      h.control.commands.push({ kind: "message", runId, body });
    },
    runAnswer: async (runId: string, body: unknown) => {
      h.control.commands.push({ kind: "answer", runId, body });
    },
    runInterrupt: async (runId: string) => {
      h.control.commands.push({ kind: "interrupt", runId });
    },
    runRelease: async (runId: string) => {
      h.control.commands.push({ kind: "release", runId });
    },
    runRevoke: async (runId: string) => {
      h.control.commands.push({ kind: "revoke", runId });
    },
  } as unknown as ControlClient;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    h.control.fetched.push(`${url.pathname}${url.search}`);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer device-token");
    const runId = url.pathname.split("/")[3] ?? "";
    const since = Number(url.searchParams.get("since") ?? "0");
    const answer = h.control.stream(runId, since);
    if ("status" in answer) return new Response(null, { status: answer.status });
    return new Response(streamOf(answer.chunks, answer.hang, init?.signal), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  h.service = new CloudRunService({
    control: () => client,
    spaces: { all: () => [{ id: "work" }], activeId: () => "work", get: (id) => (id === "work" ? { id } : null) },
    spaceSecret: options.spaceSecret ?? (() => (options.secret === undefined ? SECRET : options.secret)),
    threads,
    runs: () => h.sinkReady ? ({
      refreshRemote: (run) => h.refreshed.push(structuredClone(run)),
      answerIMessageQuestion: async (runId, questionId, value) => {
        h.imessageAnswers.push({ runId, questionId, value });
      },
    }) : null,
    activeTab: () => (options.activeTabUrl === null ? null : { url: options.activeTabUrl ?? "https://shop.example/cart" }),
    onChange: () => {
      h.changes += 1;
    },
    fetchImpl,
    reconnectDelayMs: 5,
    publishDelayMs: 5,
  });
  services.push(h.service);
  return h;
}

describe("desktop iMessage bridge", () => {
  it("mirrors before delivery and applies an inbound cmd.answer to the local run sink", async () => {
    const h = harness();
    const question = {
      id: "question-zip",
      prompt: "What ZIP code should I use?",
      description: "Local prices depend on it.",
      choices: [],
      input: { type: "text" as const, placeholder: "ZIP code" },
    };
    const run = {
      ...createdRun("run-desktop"),
      status: "waiting_for_judgment" as const,
      executor: { kind: "desktop" as const },
      pendingQuestion: question,
    };
    h.control.stream = (_runId, since) => ({
      chunks: since === 0 ? [frame(stored(1, { t: "cmd.answer", questionId: question.id, value: "10001" }))] : [],
      hang: true,
    });

    h.service.start();
    h.service.notifyIMessage(
      { version: 1, spaceId: "work", run, model: [] },
      { kind: "question", question },
    );

    await waitFor(() => h.imessageAnswers.length === 1, "the iMessage answer");
    expect(h.control.desktopCreated).toHaveLength(1);
    expect(h.control.desktopSnapshots).toHaveLength(1);
    expect(h.control.imessageDeliveries).toEqual([
      { runId: "run-desktop", input: { kind: "question", question } },
    ]);
    expect(h.imessageAnswers).toEqual([
      { runId: "run-desktop", questionId: "question-zip", value: "10001" },
    ]);

    h.service.notifyIMessage(
      { version: 1, spaceId: "work", run: { ...run, pendingQuestion: null }, model: [] },
      { kind: "resolved", questionId: question.id },
    );
    await waitFor(() => h.control.imessageDeliveries.length === 2, "the resolved notification");
    expect(h.control.imessageDeliveries[1]).toEqual({
      runId: "run-desktop",
      input: { kind: "resolved", questionId: question.id },
    });
    expect(h.control.imessageLinkChecks).toBe(1);
  });

  it("answers a second question on the same run instead of re-reading the first answer", async () => {
    const h = harness();
    const ask = (id: string): AgentQuestion => ({
      id,
      prompt: "What ZIP code should I use?",
      description: "",
      choices: [],
      input: { type: "text" as const, placeholder: "ZIP code" },
    });
    const q1 = ask("question-1");
    const q2 = ask("question-2");
    const run = {
      ...createdRun("run-two-questions"),
      status: "waiting_for_judgment" as const,
      executor: { kind: "desktop" as const },
      pendingQuestion: q1,
    };
    // Control replays every event after `since`, so a watch that restarted at
    // 0 would re-read the first answer instead of waiting for the second.
    const events: StoredRunEvent[] = [stored(1, { t: "cmd.answer", questionId: q1.id, value: "10001" })];
    h.control.stream = (_runId, since) => ({
      chunks: events.filter((event) => event.seq > since).map(frame),
      hang: true,
    });

    h.service.start();
    h.service.notifyIMessage({ version: 1, spaceId: "work", run, model: [] }, { kind: "question", question: q1 });
    await waitFor(() => h.imessageAnswers.length === 1, "the first answer");

    // The controller applied it: the run has no pending question, which closes
    // the watch, and the person is then asked again.
    h.service.mirrorDesktop({ version: 1, spaceId: "work", run: { ...run, pendingQuestion: null }, model: [] });
    events.push(stored(2, { t: "cmd.answer", questionId: q2.id, value: "94110" }));
    h.service.notifyIMessage(
      { version: 1, spaceId: "work", run: { ...run, pendingQuestion: q2 }, model: [] },
      { kind: "question", question: q2 },
    );

    await waitFor(() => h.imessageAnswers.length === 2, "the second answer");
    expect(h.imessageAnswers).toEqual([
      { runId: "run-two-questions", questionId: q1.id, value: "10001" },
      { runId: "run-two-questions", questionId: q2.id, value: "94110" },
    ]);
    expect(h.control.fetched.at(-1)).toContain("since=1");
  });

  it("picks up a Space secret that only arrives after the service started", async () => {
    // A Space's secret arrives asynchronously (ensureSpaceSecrets, sign-in,
    // enableCloud): a null cached by an earlier mirror must not stick.
    let secret: Uint8Array | null = null;
    const h = harness({ spaceSecret: () => secret });
    const run = { ...createdRun("run-late-secret"), executor: { kind: "desktop" as const } };

    h.service.start();
    h.service.mirrorDesktop({ version: 1, spaceId: "work", run, model: [] });
    await sleep(30);
    expect(h.control.desktopSnapshots).toHaveLength(0);

    secret = SECRET;
    h.service.mirrorDesktop({ version: 1, spaceId: "work", run, model: [] });
    await waitFor(() => h.control.desktopSnapshots.length === 1, "the mirror once the secret arrived");
  });

  it("does not restore answer streams when the account has no iMessage link", async () => {
    const h = harness({ imessageLinked: false });
    const question = {
      id: "question-off",
      prompt: "Choose",
      description: "",
      choices: [{ value: "yes", label: "Yes", description: "" }],
    };
    const run = {
      ...createdRun("run-unlinked"),
      status: "waiting_for_judgment" as const,
      executor: { kind: "desktop" as const },
      pendingQuestion: question,
    };
    h.threads.saveNow({ version: 1, spaceId: "work", run, model: [] });

    h.service.start();
    await waitFor(() => h.control.imessageLinkChecks === 1, "the link lookup");
    await sleep(25);
    expect(h.control.fetched).toHaveLength(0);
  });

  it("bounds retries while the local run controller is unavailable", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const h = harness({ sinkReady: false });
    const question = {
      id: "question-startup",
      prompt: "Choose",
      description: "",
      choices: [{ value: "yes", label: "Yes", description: "" }],
    };
    const run = {
      ...createdRun("run-startup"),
      status: "waiting_for_judgment" as const,
      executor: { kind: "desktop" as const },
      pendingQuestion: question,
    };
    h.threads.saveNow({ version: 1, spaceId: "work", run, model: [] });

    h.service.start();
    await waitFor(
      () => error.mock.calls.some(([message]) => String(message).includes("stopped after 8 attempts")),
      "the bounded retry stop",
      2_000,
    );
    expect(h.control.fetched).toHaveLength(0);
    expect(error).toHaveBeenCalledTimes(2);
  });
});

/* ------------------------------------ folding ------------------------------------ */

describe("observing a run", () => {
  it("folds the stream into a RunSummary, opening sealed content with the Space key", async () => {
    const h = harness();
    const runId = "run-1";
    const message: AgentMessage = { id: "m1", at: T0, role: "assistant", content: "Found the booking page.", turn: 1 };
    const events = [
      stored(1, { t: "run.created", run: createdRun(runId) }),
      stored(2, { t: "status", status: "running", completedAt: null }),
      stored(3, await sealed(runId, "evt-3", { t: "message", message })),
      stored(4, { t: "tool.started", toolId: "tool-1", name: "page.inspect", label: "Read the page", tabId: "cloud:1" }),
      stored(5, await sealed(runId, "evt-5", { t: "tool.detail", toolId: "tool-1", detail: "long", summary: "Booking form with 3 fields" })),
      stored(6, { t: "tool.completed", toolId: "tool-1" }),
      stored(7, await sealed(runId, "evt-7", { t: "result", result: { summary: "Booked.", changes: ["Reservation"], capsuleRevoked: false, evidenceEntries: 0, rootHash: "" } })),
      stored(8, { t: "status", status: "completed", completedAt: "2026-09-02T10:05:00.000Z" }, "2026-09-02T10:05:00.000Z"),
    ];
    h.control.runs["work"] = [listItem(createdRun(runId))];
    h.control.stream = () => ({ chunks: [events.map(frame).join("") + END], hang: false });

    h.service.start();
    await waitFor(() => h.threads.get(runId)?.run.status === "completed", "the folded run");
    const run = h.threads.get(runId)!.run;
    expect(h.control.listed).toEqual(["work"]);
    expect(h.control.fetched).toEqual(["/v1/runs/run-1/events?since=0"]);
    expect(run.executor).toEqual({ kind: "cloud", deviceId: "cloud-1", workerId: null });
    expect(run.humanTabId).toBeNull();
    expect(run.messages).toEqual([message]);
    expect(run.toolCalls).toHaveLength(1);
    expect(run.toolCalls[0]).toMatchObject({ id: "tool-1", status: "completed", detail: "Booking form with 3 fields", tabId: "cloud:1" });
    expect(run.result?.summary).toBe("Booked.");
    expect(run.completedAt).toBe("2026-09-02T10:05:00.000Z");
    expect(h.threads.list().map((item) => [item.runId, item.status, item.executor?.kind])).toEqual([["run-1", "completed", "cloud"]]);
    // The console heard about it, and the run snapshot was republished.
    expect(h.refreshed.at(-1)?.status).toBe("completed");
    expect(h.changes).toBeGreaterThan(0);
    expect(h.service.liveRunIds()).toEqual([]);
  });

  it("shows only the control-class rows without the Space's secret, and skips content sealed under another key", async () => {
    const h = harness({ secret: null });
    const runId = "run-2";
    const events = [
      stored(1, { t: "run.created", run: createdRun(runId) }),
      stored(2, await sealed(runId, "evt-2", { t: "message", message: { id: "m1", at: T0, role: "assistant", content: "secret", turn: 1 } })),
      stored(3, { t: "tool.started", toolId: "tool-1", name: "page.inspect", label: "Read the page", tabId: null }),
      stored(4, { t: "status", status: "completed", completedAt: T0 }),
    ];
    h.control.runs["work"] = [listItem(createdRun(runId))];
    h.control.stream = () => ({ chunks: [events.map(frame).join("") + END], hang: false });
    h.service.start();
    await waitFor(() => h.threads.get(runId)?.run.status === "completed", "the folded run");
    expect(h.threads.get(runId)?.run.messages).toEqual([]);
    expect(h.threads.get(runId)?.run.toolCalls).toHaveLength(1);

    const keyed = harness();
    const runId3 = "run-3";
    const foreign = [
      stored(1, { t: "run.created", run: createdRun(runId3) }),
      stored(2, await sealed(runId3, "evt-2", { t: "message", message: { id: "m1", at: T0, role: "assistant", content: "other key", turn: 1 } }, new Uint8Array(32).fill(9))),
      stored(3, await sealed(runId3, "evt-3", { t: "message", message: { id: "m2", at: T0, role: "assistant", content: "readable", turn: 1 } })),
      stored(4, { t: "status", status: "completed", completedAt: T0 }),
    ];
    keyed.control.runs["work"] = [listItem(createdRun(runId3))];
    keyed.control.stream = () => ({ chunks: [foreign.map(frame).join("") + END], hang: false });
    keyed.service.start();
    await waitFor(() => keyed.threads.get(runId3)?.run.status === "completed", "the folded run");
    expect(keyed.threads.get(runId3)?.run.messages.map((m) => m.content)).toEqual(["readable"]);
  });

  it("re-dials a dropped live stream from the last seq and stops at the terminal status", async () => {
    const h = harness();
    const runId = "run-4";
    const first = [stored(1, { t: "run.created", run: createdRun(runId) }), stored(2, { t: "status", status: "running", completedAt: null })];
    const second = [stored(3, { t: "turn", turns: 2 }), stored(4, { t: "status", status: "completed", completedAt: T0 })];
    h.control.runs["work"] = [listItem(createdRun(runId))];
    h.control.stream = (_runId, since) =>
      since === 0 ? { chunks: [first.map(frame).join("")], hang: false } : { chunks: [second.map(frame).join("") + END], hang: false };
    h.service.start();
    await waitFor(() => h.threads.get(runId)?.run.status === "completed", "the resumed run");
    expect(h.control.fetched).toEqual(["/v1/runs/run-4/events?since=0", "/v1/runs/run-4/events?since=2"]);
    expect(h.threads.get(runId)?.run.turns).toBe(2);
    await sleep(30);
    expect(h.control.fetched).toHaveLength(2);
  });

  it("leaves a finished run this Mac already holds alone, and drops a run control no longer has", async () => {
    const h = harness();
    const done = { ...createdRun("run-5"), status: "completed" as const };
    h.threads.saveNow({ version: 1, run: done, model: [] });
    h.control.runs["work"] = [listItem(done), listItem(createdRun("run-gone"))];
    h.control.stream = () => ({ status: 404 });
    h.service.start();
    await waitFor(() => h.control.fetched.length === 1, "the one dial");
    await sleep(30);
    expect(h.control.fetched).toEqual(["/v1/runs/run-gone/events?since=0"]);
    expect(h.service.liveRunIds()).toEqual([]);
  });

  it("closes every stream on stop and never dials again until started", async () => {
    const h = harness();
    const runId = "run-6";
    h.control.runs["work"] = [listItem(createdRun(runId))];
    h.control.stream = () => ({ chunks: [frame(stored(1, { t: "run.created", run: createdRun(runId) }))], hang: true });
    h.service.start();
    await waitFor(() => h.threads.get(runId) !== null, "the run");
    expect(h.service.liveRunIds()).toEqual([runId]);
    h.service.stop();
    await sleep(30);
    expect(h.service.liveRunIds()).toEqual([]);
    expect(h.control.fetched).toHaveLength(1);
    expect(h.service.started).toBe(false);
  });
});

/* ------------------------------------ starting ------------------------------------ */

describe("starting a cloud run", () => {
  it("POSTs the active Space, the intent, and the active tab's address, then follows the run", async () => {
    const h = harness();
    h.control.stream = () => ({ chunks: [frame(stored(1, { t: "run.created", run: createdRun("run-new") }))], hang: true });
    h.service.start();
    const { runId } = await h.service.startRun({ intent: "  Order the usual  ", attachments: [] });
    expect(runId).toBe("run-new");
    expect(h.control.created).toEqual([{ spaceId: "work", intent: "Order the usual", attachments: [], startUrl: "https://shop.example/cart" }]);
    await waitFor(() => h.threads.get("run-new") !== null, "the followed run");
    expect(h.service.liveRunIds()).toEqual(["run-new"]);
  });

  it("omits a start address that is not a web page and refuses an unknown Space or an empty intent", async () => {
    const h = harness({ activeTabUrl: "pistachio://welcome" });
    h.service.start();
    await h.service.startRun({ intent: "Go", startUrl: "chrome://version" });
    expect(h.control.created[0]).toEqual({ spaceId: "work", intent: "Go", attachments: [] });
    await expect(h.service.startRun({ intent: "Go", spaceId: "nope" })).rejects.toThrow(/unknown Space/);
    await expect(h.service.startRun({ intent: "   " })).rejects.toThrow(/say what/);
    expect(webStartUrl("https://a.example/x?y=1")).toBe("https://a.example/x?y=1");
    expect(webStartUrl("file:///etc/passwd")).toBeUndefined();
    expect(webStartUrl(null)).toBeUndefined();
  });

  it("refuses to start or steer anything before enrollment", async () => {
    const dir = scratch();
    const service = new CloudRunService({
      control: () => null,
      spaces: { all: () => [], activeId: () => "work", get: () => null },
      spaceSecret: () => null,
      threads: new ThreadStore(dir),
      runs: () => null,
      activeTab: () => null,
      onChange: () => undefined,
    });
    services.push(service);
    await expect(service.startRun({ intent: "x" })).rejects.toThrow(/enroll/);
    await expect(service.message("run-1", "hi", [])).rejects.toThrow(/enroll/);
    service.start();
    await sleep(10);
    expect(service.liveRunIds()).toEqual([]);
  });
});

/* ------------------------------------ steering ------------------------------------ */

describe("steering through control", () => {
  it("forwards every command to its route", async () => {
    const h = harness();
    await h.service.message("run-1", "left, not right", []);
    await h.service.message("run-1", "see this", [{ id: "a1", name: "x.png", mediaType: "image/png", url: "data:image/png;base64,AAAA" }]);
    await h.service.answer("run-1", "q1", "blue");
    await h.service.interrupt("run-1");
    await h.service.release("run-1");
    await h.service.revoke("run-1");
    expect(h.control.commands).toEqual([
      { kind: "message", runId: "run-1", body: { text: "left, not right" } },
      { kind: "message", runId: "run-1", body: { text: "see this", attachments: [{ id: "a1", name: "x.png", mediaType: "image/png", url: "data:image/png;base64,AAAA" }] } },
      { kind: "answer", runId: "run-1", body: { questionId: "q1", value: "blue" } },
      { kind: "interrupt", runId: "run-1" },
      { kind: "release", runId: "run-1" },
      { kind: "revoke", runId: "run-1" },
    ]);
  });

  it("discovers and follows a completed cloud run that is reopened after restart", async () => {
    const h = harness();
    const runId = "run-reopened-after-restart";
    const completed = {
      ...createdRun(runId),
      status: "completed" as const,
      completedAt: "2026-09-02T10:05:00.000Z",
    };
    // No spaceId models a record written by an earlier build.
    h.threads.saveNow({ version: 1, run: completed, model: [] });
    h.control.runs["work"] = [listItem(completed)];
    h.service.start();
    await waitFor(() => h.control.listed.length === 1, "the initial completed-run listing");
    expect(h.control.fetched).toHaveLength(0);

    const ready = { ...completed, status: "ready" as const, completedAt: null };
    h.control.runs["work"] = [listItem(ready)];
    const events = [
      stored(1, { t: "run.created", run: createdRun(runId) }),
      stored(2, { t: "status", status: "completed", completedAt: completed.completedAt }),
      stored(3, { t: "cmd.message", text: "Continue here", attachments: [] }),
      stored(4, { t: "status", status: "ready", completedAt: null }),
    ];
    h.control.stream = () => ({ chunks: [events.map(frame).join("")], hang: true });

    await h.service.message(runId, "Continue here", []);

    await waitFor(() => h.threads.get(runId)?.run.status === "ready", "the reopened run");
    expect(h.service.liveRunIds()).toEqual([runId]);
    expect(h.threads.get(runId)?.spaceId).toBe("work");
    expect(h.threads.get(runId)?.run.messages.at(-1)?.content).toBe("Continue here");
  });

  it("follows a reopened stored run even while startup refresh is using a stale listing", async () => {
    const h = harness();
    const runId = "run-reopened-during-refresh";
    const completed = {
      ...createdRun(runId),
      status: "completed" as const,
      completedAt: "2026-09-02T10:05:00.000Z",
    };
    h.threads.saveNow({ version: 1, spaceId: "work", run: completed, model: [] });
    let releaseListing = (): void => undefined;
    const listingBlocked = new Promise<void>((resolve) => {
      releaseListing = resolve;
    });
    h.control.listRuns = async () => {
      const snapshot = [listItem(completed)];
      await listingBlocked;
      return snapshot;
    };
    const events = [
      stored(1, { t: "run.created", run: createdRun(runId) }),
      stored(2, { t: "status", status: "completed", completedAt: completed.completedAt }),
      stored(3, { t: "cmd.message", text: "Continue now", attachments: [] }),
      stored(4, { t: "status", status: "ready", completedAt: null }),
    ];
    h.control.stream = () => ({ chunks: [events.map(frame).join("")], hang: true });

    h.service.start();
    await waitFor(() => h.control.listed.length === 1, "the blocked startup listing");
    await h.service.message(runId, "Continue now", []);
    await waitFor(() => h.control.fetched.length === 1, "the reopened run stream");
    releaseListing();

    await waitFor(() => h.threads.get(runId)?.run.status === "ready", "the reopened run");
    expect(h.service.liveRunIds()).toEqual([runId]);
    expect(h.threads.get(runId)?.run.messages.at(-1)?.content).toBe("Continue now");
  });

  it("parses stored events strictly", () => {
    expect(parseStoredRunEvent({ seq: 1, eventId: "e", at: T0, event: { t: "status", status: "running", completedAt: null } })?.seq).toBe(1);
    expect(parseStoredRunEvent({ seq: 1, eventId: "e", at: T0, event: { t: "sealed", spaceId: "work", sealed: "AAAA" } })?.event.t).toBe("sealed");
    expect(parseStoredRunEvent({ seq: 1, eventId: "e", at: T0, event: { t: "message", message: {} } })).toBeNull();
    expect(parseStoredRunEvent({ seq: -1, eventId: "e", at: T0, event: { t: "status" } })).toBeNull();
    expect(parseStoredRunEvent({ seq: 1, eventId: "", at: T0, event: { t: "status" } })).toBeNull();
    expect(parseStoredRunEvent("nope")).toBeNull();
  });
});

/* -------------------------- the console and a cloud run -------------------------- */

function fakeBrowser(): BrowserController {
  return {
    allTabs: () => [],
    activeTab: () => null,
    tab: () => null,
  } as unknown as BrowserController;
}

function controller(threads: ThreadStore, cloud: CloudRunCommands | null): { controller: RunController; onChange: ReturnType<typeof vi.fn> } {
  const onChange = vi.fn();
  return {
    controller: new RunController({ browser: fakeBrowser(), notifications: new NotificationRouter([]), onChange, threads, cloud }),
    onChange,
  };
}

describe("RunController with a cloud run", () => {
  it("restore() keeps a live cloud record as it is instead of forcing it interrupted", () => {
    const dir = scratch();
    const saved = new ThreadStore(dir);
    const live = { ...createdRun("run-cloud"), status: "running" as const, toolCalls: [{ id: "t", name: "page.inspect" as const, label: "Read", detail: "", status: "running" as const, startedAt: T0, completedAt: null, tabId: null }] };
    saved.saveNow({ version: 1, run: live, model: [] });
    const { controller: runs } = controller(new ThreadStore(dir), null);
    runs.restore();
    const run = runs.snapshot()!;
    expect(run.runId).toBe("run-cloud");
    expect(run.status).toBe("running");
    expect(run.control).toBe("agent");
    expect(run.toolCalls[0]?.status).toBe("running");
    expect(run.messages).toEqual([]);
    expect(runs.busy()).toBe(false);
    expect(runs.threads().map((item) => [item.runId, item.status, item.executor?.kind])).toEqual([["run-cloud", "running", "cloud"]]);
  });

  it("steers the open cloud run through control and follows what the observer folds", async () => {
    const dir = scratch();
    const threads = new ThreadStore(dir);
    const running = { ...createdRun("run-cloud"), status: "running" as const, pendingQuestion: { id: "q1", prompt: "Which?", description: "", choices: [{ value: "a", label: "A", description: "" }] } };
    threads.saveNow({ version: 1, run: running, model: [] });
    const commands: string[] = [];
    const cloud: CloudRunCommands = {
      message: async (runId, text) => {
        commands.push(`message:${runId}:${text}`);
      },
      answer: async (runId, questionId, value) => {
        commands.push(`answer:${runId}:${questionId}:${value}`);
      },
      forget: (runId) => {
        commands.push(`forget:${runId}`);
      },
      interrupt: async (runId) => {
        commands.push(`interrupt:${runId}`);
      },
      release: async (runId) => {
        commands.push(`release:${runId}`);
      },
      revoke: async (runId) => {
        commands.push(`revoke:${runId}`);
      },
    };
    const { controller: runs, onChange } = controller(threads, cloud);
    runs.restore();
    await runs.message("go left");
    await runs.answerQuestion("q1", "a");
    runs.interrupt();
    runs.takeControl();
    await runs.revoke();
    expect(commands).toEqual(["message:run-cloud:go left", "answer:run-cloud:q1:a", "interrupt:run-cloud", "interrupt:run-cloud", "revoke:run-cloud"]);
    // Nothing changed locally: the truth arrives through the stream.
    expect(runs.snapshot()?.status).toBe("running");
    expect(runs.snapshot()?.messages).toEqual([]);
    await expect(runs.approve("x")).rejects.toThrow(/cloud run/);

    onChange.mockClear();
    runs.refreshRemote({ ...running, status: "human_control", control: "human", pendingQuestion: null });
    expect(runs.snapshot()).toMatchObject({ status: "human_control", control: "human", pendingQuestion: null });
    expect(onChange).toHaveBeenCalledTimes(1);
    await runs.releaseControl();
    expect(commands.at(-1)).toBe("release:run-cloud");
    // A fold for some other run is not the console's.
    runs.refreshRemote({ ...createdRun("run-other"), status: "completed" });
    expect(runs.snapshot()?.runId).toBe("run-cloud");
  });

  it("takes control before releasing a cloud run that is paused for a step-up or interrupted", async () => {
    const dir = scratch();
    const threads = new ThreadStore(dir);
    const running = { ...createdRun("run-cloud"), status: "running" as const };
    threads.saveNow({ version: 1, run: running, model: [] });
    const commands: string[] = [];
    const cloud: CloudRunCommands = {
      message: async () => undefined,
      answer: async () => undefined,
      forget: () => undefined,
      interrupt: async (runId) => {
        commands.push(`interrupt:${runId}`);
      },
      release: async (runId) => {
        commands.push(`release:${runId}`);
      },
      revoke: async () => undefined,
    };
    const { controller: runs } = controller(threads, cloud);
    runs.restore();

    // The TakeoverCard's button on a cloud takeover request. Control's
    // /release needs `human_control`, so taking control is the exit from the
    // `waiting_for_step_up` pause — /release alone was a silent no-op.
    runs.refreshRemote({ ...running, status: "waiting_for_step_up", control: "human" });
    await runs.releaseControl();
    expect(commands).toEqual(["interrupt:run-cloud", "release:run-cloud"]);

    // The console's Resume link on a stopped cloud run: /release alone 409s.
    commands.length = 0;
    runs.refreshRemote({ ...running, status: "interrupted", control: "human" });
    await runs.releaseControl();
    expect(commands).toEqual(["interrupt:run-cloud", "release:run-cloud"]);

    // Already holding the wheel: release on its own is what control wants.
    commands.length = 0;
    runs.refreshRemote({ ...running, status: "human_control", control: "human" });
    await runs.releaseControl();
    expect(commands).toEqual(["release:run-cloud"]);

    // A run doing neither is left alone.
    commands.length = 0;
    runs.refreshRemote({ ...running, status: "running", control: "agent" });
    await runs.releaseControl();
    expect(commands).toEqual([]);
  });

  it("explains that a cloud run cannot be steered before enrollment", async () => {
    const dir = scratch();
    const threads = new ThreadStore(dir);
    threads.saveNow({ version: 1, run: { ...createdRun("run-cloud"), status: "running" }, model: [] });
    const { controller: runs } = controller(threads, null);
    runs.restore();
    await expect(runs.message("hi")).rejects.toThrow(/enrolled/);
  });
  it("stops following a conversation the person deleted, so its next event cannot restore it", async () => {
    const h = harness();
    const runId = "run-forget";
    const events = [
      stored(1, { t: "run.created", run: createdRun(runId) }, "2026-09-02T10:00:00.000Z"),
      stored(2, { t: "status", status: "running", completedAt: null }, "2026-09-02T10:00:01.000Z"),
    ];
    h.control.runs["work"] = [listItem(createdRun(runId))];
    // The stream stays open, as a live run's does.
    h.control.stream = () => ({ chunks: [events.map(frame).join("")], hang: true });

    h.service.start();
    await waitFor(() => h.threads.get(runId) !== null, "the followed run");

    // Deleting the row is only half of it: the run keeps streaming, and the
    // next folded event would write the thread straight back.
    h.service.forget(runId);
    h.threads.remove(runId);
    expect(h.service.liveRunIds()).not.toContain(runId);

    // A refresh sees it in control's list and must leave it alone.
    await h.service.refresh();
    await sleep(50);
    expect(h.threads.get(runId)).toBeNull();
  });
});
