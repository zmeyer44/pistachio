import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunContentEvent, StoredRunEvent } from "@pistachio/protocol";
import { LoopbackTransport } from "@pistachio/sync-engine";
import { deriveSpaceKeys, type SpaceKeys } from "@pistachio/sync-protocol";
import { afterAll, beforeAll, expect, it } from "vitest";
import WebSocket from "ws";
import { consoleLogger } from "../src/logger.js";
import { createRunner, type Runner } from "../src/runner.js";
import { openRunEvent, openThread } from "../src/runs/events.js";
import { answer, gate, scriptedModelFactory, toolCalls, type ScriptStep } from "../src/testing/scripted-model.js";
import { CHROMIUM, describeChromium } from "./helpers/chromium.js";
import { startFakeControl, type FakeControl } from "./helpers/fake-control.js";
import { settle, startFixture, type FixtureServer } from "./helpers/fixture-server.js";
import { liveProof, testRootSecret, USER_A, USER_B } from "./helpers/keys.js";

/** The model reads the fixture: list tabs, inspect the first, answer. */
function readingScript(): ScriptStep[] {
  return [
    toolCalls({ name: "tabs_list", input: {} }),
    ({ prompt }) => {
      let tabId = "";
      for (const message of prompt) {
        if (message.role !== "tool") continue;
        for (const part of message.content) {
          if (part.type !== "tool-result" || part.output.type !== "json") continue;
          const value = part.output.value as { data?: { tabs?: Array<{ id: string }> } };
          tabId = value.data?.tabs?.[0]?.id ?? tabId;
        }
      }
      return toolCalls({ name: "page_inspect", input: { tabId } })({ prompt } as Parameters<ScriptStep>[0]);
    },
    answer("The fixture page says: fixture body text."),
  ];
}

describeChromium("runner integration against a fake control plane", () => {
  let fake: FakeControl;
  let fixture: FixtureServer;
  let runner: Runner;
  let stateDir: string;
  let keys: SpaceKeys;
  const scripts = new Map<string, ScriptStep[]>();
  const held = gate();

  beforeAll(async () => {
    fake = await startFakeControl({ egress: null, maxWaitSeconds: 1 });
    fixture = await startFixture((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Fixture</title><body><p>fixture body text</p><button id=\"go\">Go</button></body>");
    });
    stateDir = await mkdtemp(join(tmpdir(), "cloud-browser-runner-"));
    keys = await deriveSpaceKeys("work", testRootSecret(0x61));
    runner = createRunner({
      controlUrl: fake.baseUrl,
      serviceToken: fake.serviceToken,
      stateDir,
      stateKey: randomBytes(32),
      chromiumPath: CHROMIUM ?? undefined,
      modelFactory: scriptedModelFactory(({ runId }) => scripts.get(runId) ?? [held.step], { modelName: "scripted" }),
      ports: { http: 0 },
      host: "127.0.0.1",
      allowedOrigins: [fixture.origin],
      egressMode: "direct",
      transportFactory: (_hubUrl, deviceId, events) => new LoopbackTransport(deviceId, "cloud", events),
      claimIntervalMs: 50,
      commandWaitSeconds: 1,
      commandRetryDelayMs: 5,
      liveRecheckIntervalMs: 50,
      eventFlushDelayMs: 1,
      threadFlushMs: 10,
      sessionIdleMs: 60_000,
      log: consoleLogger,
    });
    await runner.start();
  });

  afterAll(async () => {
    held.release();
    await runner.stop(); // idempotent: the shutdown test stops it first
    await fake.close();
    await fixture.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  it("fails a claimed run whose user has no cloud device with cloud_device_missing before any context exists", async () => {
    const run = fake.addRun({ userId: USER_A, spaceId: "work", intent: "no device yet", startUrl: fixture.origin });
    await settle(() => fake.run(run.record.id).record.status === "failed");
    expect(fake.run(run.record.id).failReason).toBe("cloud_device_missing");
    expect(runner.sessions.users.size).toBe(0);
  });

  it("provisions, claims, drives a run to completion, and stores only sealed content", async () => {
    const provisioned = await runner.provision(USER_A, fake.enrollmentNonce(USER_A));
    expect(provisioned.status).toBe(201);
    expect(existsSync(join(stateDir, USER_A, "device.json"))).toBe(true);
    await fake.addDesktop(USER_A);
    await fake.wrapSpace(USER_A, "work", testRootSecret(0x61));

    const run = fake.addRun({ userId: USER_A, spaceId: "work", intent: "Read the fixture page", startUrl: fixture.origin });
    // The claim loop polls every 50 ms; the script must be registered before the model factory runs.
    scripts.set(run.record.id, readingScript());
    await settle(() => fake.run(run.record.id).record.status === "completed", { turns: 800 });
    const stored = fake.run(run.record.id);
    expect(stored.events[0]?.event.t).toBe("run.created");
    const kinds = stored.events.map((event) => event.event.t);
    expect(kinds.slice(0, 3)).toEqual(["run.created", "status", "control"]);
    expect(kinds).toContain("tool.started");
    expect(kinds).toContain("tool.completed");
    expect(kinds.at(-2)).toBe("status");
    expect(kinds.at(-1)).toBe("done");
    const wire = JSON.stringify(stored.events);
    expect(wire).not.toContain("fixture body text");
    expect(wire).not.toContain('"role":');
    expect(wire).not.toContain('"content":');
    const opened: RunContentEvent[] = [];
    for (const event of stored.events) {
      if (event.event.t === "sealed") opened.push(await openRunEvent(keys.sealKey, run.record.id, event as StoredRunEvent));
    }
    expect(opened.some((event) => event.t === "message" && event.message.role === "user" && event.message.content === "Read the fixture page")).toBe(true);
    expect(opened.some((event) => event.t === "message" && event.message.role === "assistant" && event.message.content.includes("fixture body text"))).toBe(true);
    expect(opened.some((event) => event.t === "tool.detail" && JSON.stringify(event.data ?? "").includes("fixture body text"))).toBe(true);
    expect(opened.some((event) => event.t === "result" && event.result?.rootHash !== "")).toBe(true);
    expect(opened.some((event) => event.t === "evidence")).toBe(true);
    expect(stored.thread?.spaceId).toBe("work");
    const thread = await openThread<{ version: number; messages: unknown[] }>(keys.sealKey, run.record.id, stored.thread?.sealed ?? "");
    expect(thread.version).toBe(2);
    expect(thread.messages.length).toBeGreaterThan(1);
    expect(stored.heartbeats).toBeGreaterThanOrEqual(0);
    // Control answers `complete` before the executor unwinds (poller, thread flush, session release).
    await settle(() => runner.executor.active.size === 0);
    const session = runner.sessions.users.get(USER_A)?.spaces.get("work");
    expect(session?.activeRuns).toBe(0);
    expect(session?.hasHydratedOnce).toBe(true);
  });

  it("retries a transient failure on the startup command poll", async () => {
    const run = fake.addRun({
      userId: USER_A,
      spaceId: "work",
      intent: "Recover from a control blip",
      startUrl: fixture.origin,
    });
    scripts.set(run.record.id, readingScript());
    fake.failNextCommandPolls(run.record.id);

    await settle(() => fake.run(run.record.id).record.status === "completed", { turns: 800 });

    expect(fake.run(run.record.id).failReason).toBeNull();
    expect(
      fake.calls.filter((call) => call.method === "GET" && call.path === `/v1/internal/runs/${run.record.id}/commands`).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("persists a question pause, releases the lease, and continues from the answered checkpoint after reclaim", async () => {
    if ((await runner.identity.identityFor(USER_A)) === null) {
      expect((await runner.provision(USER_A, fake.enrollmentNonce(USER_A))).status).toBe(201);
      await fake.addDesktop(USER_A);
      await fake.wrapSpace(USER_A, "work", testRootSecret(0x61));
    }
    const run = fake.addRun({ userId: USER_A, spaceId: "work", intent: "Find local paper towel prices", startUrl: fixture.origin });
    scripts.set(run.record.id, [
      toolCalls({
        name: "ask_user_text",
        input: {
          prompt: "What ZIP code should I use?",
          description: "Local prices depend on the destination.",
          placeholder: "ZIP code",
        },
      }),
    ]);

    await settle(() => fake.run(run.record.id).record.status === "waiting_for_judgment", { turns: 800 });
    await settle(() => !runner.executor.active.has(run.record.id), { turns: 800 });
    const paused = fake.run(run.record.id);
    expect(paused.leaseToken).toBeNull();
    expect(paused.pause?.id).not.toBe(paused.pause?.payload["questionId"]);
    const checkpoint = await openThread<{
      version: number;
      state: string;
      turns: number;
      pending: { question: { id: string; prompt: string; input?: { type: string; placeholder: string } } | null };
    }>(keys.sealKey, run.record.id, paused.thread?.sealed ?? "");
    expect(checkpoint).toMatchObject({
      version: 2,
      state: "waiting",
      turns: 1,
      pending: {
        question: {
          prompt: "What ZIP code should I use?",
          input: { type: "text", placeholder: "ZIP code" },
        },
      },
    });
    const questionId = checkpoint.pending.question?.id;
    if (questionId === undefined) throw new Error("checkpoint lost its pending question");

    scripts.set(run.record.id, [
      (options) => {
        expect(JSON.stringify(options.prompt)).toContain("[The person answered your question]\\n10001");
        return answer("I found the offers available near 10001.")(options);
      },
    ]);
    expect(fake.answerQuestion(run.record.id, questionId, "10001")).toBe(true);

    await settle(() => fake.run(run.record.id).record.status === "completed", { turns: 800 });
    const completed = fake.run(run.record.id);
    expect(completed.events.filter((event) => event.event.t === "resume")).toHaveLength(2);
    expect(completed.events.some((event) => event.event.t === "turn" && event.event.turns === 2)).toBe(true);
    const opened: RunContentEvent[] = [];
    for (const event of completed.events) {
      if (event.event.t === "sealed") opened.push(await openRunEvent(keys.sealKey, run.record.id, event));
    }
    expect(opened.some((event) => event.t === "message" && event.message.role === "user" && event.message.content === "10001")).toBe(true);
    expect(opened.some((event) => event.t === "message" && event.message.role === "assistant" && event.message.content.includes("near 10001"))).toBe(true);
  });

  it("tears everything down on device.revoked: fails the run, closes live sockets 4003, drops contexts and device.json", async () => {
    const desktop = await fake.addDesktop(USER_A, "Viewer");
    const run = fake.addRun({ userId: USER_A, spaceId: "work", intent: "Hold the browser", startUrl: fixture.origin });
    const ticket = fake.mintLiveTicket({
      userId: USER_A,
      deviceId: desktop.id,
      platform: "macos",
      runId: run.record.id,
      spaceId: "work",
    });
    await settle(() => held.waiting, { turns: 800 });
    expect(runner.executor.active.has(run.record.id)).toBe(true);
    expect(runner.sessions.users.get(USER_A)?.spaces.get("work")?.activeRuns).toBe(1);

    const ws = new WebSocket(`ws://127.0.0.1:${String(runner.port)}/v1/live/${run.record.id}`, { headers: { authorization: `Bearer ${ticket}` } });
    const frames: unknown[] = [];
    ws.on("message", (data) => frames.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("unexpected-response", (_request, response) => reject(new Error(`upgrade rejected with ${String(response.statusCode)}`)));
    });
    // The runner asks every viewer to prove it holds the Space key before it
    // sends a pixel; a real client answers with the key it syncs under.
    await settle(() => frames.length >= 1, { turns: 400 });
    const challenge = frames.shift() as { t: string; nonce: string };
    expect(challenge.t).toBe("challenge");
    ws.send(JSON.stringify({ t: "auth", proof: await liveProof("work", run.record.id, challenge.nonce, 0x61) }));
    await settle(() => frames.some((frame) => (frame as { t: string }).t === "frame"), { turns: 400 });
    const frame = frames.find((item) => (item as { t: string }).t === "frame") as { width: number; height: number; metadata: Record<string, number> };
    expect(frame.width).toBeGreaterThan(0);
    expect(frame.metadata.deviceWidth).toBe(1280);
    const tabsFrame = frames.find((item) => (item as { t: string }).t === "tabs") as { tabs: Array<{ id: string }>; activeTabId: string };
    expect(tabsFrame.tabs[0]?.id).toMatch(/^cloud:/u);
    const closedCode = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));

    const identity = await runner.identity.identityFor(USER_A);
    const transport = runner.sessions.users.get(USER_A)?.transport;
    await runner.steer({ kind: "device.revoked", userId: USER_A, deviceId: identity?.deviceId ?? "" });

    expect(await closedCode).toBe(4003);
    await settle(() => fake.run(run.record.id).record.status === "failed");
    expect(fake.run(run.record.id).failReason).toBe("device_revoked");
    expect(runner.sessions.users.has(USER_A)).toBe(false);
    expect(transport?.state).toBe("offline");
    expect(existsSync(join(stateDir, USER_A, "device.json"))).toBe(false);
    expect(await runner.identity.identityFor(USER_A)).toBeNull();
    await settle(() => !runner.executor.active.has(run.record.id));
    expect(fake.calls.filter((call) => call.path.endsWith("/fail") && call.path.includes(run.record.id))).toHaveLength(1);

    // A run claimed after the teardown fails with cloud_device_missing; the revoked identity is never reused.
    const later = fake.addRun({ userId: USER_A, spaceId: "work", intent: "after revocation", startUrl: fixture.origin });
    await settle(() => fake.run(later.record.id).record.status === "failed");
    expect(fake.run(later.record.id).failReason).toBe("cloud_device_missing");
  });

  it("hands an active run back as interrupted on shutdown, with its lease, so the next message can reopen it", async () => {
    expect((await runner.provision(USER_B, fake.enrollmentNonce(USER_B))).status).toBe(201);
    await fake.addDesktop(USER_B);
    await fake.wrapSpace(USER_B, "work", testRootSecret(0x62));
    const holding = gate();
    const run = fake.addRun({ userId: USER_B, spaceId: "work", intent: "Hold until shutdown", startUrl: fixture.origin });
    scripts.set(run.record.id, [holding.step]);
    await settle(() => holding.waiting, { turns: 800 });
    const leaseToken = fake.run(run.record.id).leaseToken;
    expect(leaseToken).not.toBeNull();

    await runner.stop();

    const stored = fake.run(run.record.id);
    expect(stored.record.status).toBe("interrupted");
    expect(stored.events.at(-1)?.event).toEqual({ t: "status", status: "interrupted", completedAt: null });
    const interrupt = fake.calls.find((call) => call.path.endsWith(`/runs/${run.record.id}/interrupt`));
    expect(interrupt?.body).toMatchObject({ leaseToken });
    expect(fake.calls.filter((call) => call.path.endsWith(`/runs/${run.record.id}/fail`))).toHaveLength(0);
    expect(runner.executor.active.size).toBe(0);
    expect(runner.sessions.users.size).toBe(0);
    expect(runner.server).toBeNull();
  });
});
