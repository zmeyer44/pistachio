/**
 * D25: page content, messages, and URLs of a cloud run reach control only as
 * sealed content events. A pause is a control-class fact, so its payload may
 * carry correlators (`questionId`, `takeoverId`) and nothing the model wrote:
 * control persists `hosted_runs.pause` and a plaintext `{t:'pause'}` row, and
 * both survive until the retention sweep.
 */

import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopbackTransport } from "@pistachio/sync-engine";
import { afterAll, beforeAll, expect, it } from "vitest";
import { silentLogger } from "../src/logger.js";
import { CLOUD_TOOL_GROUPS } from "../src/runs/executor.js";
import { createRunner, type Runner } from "../src/runner.js";
import { scriptedModelFactory, toolCalls, type ScriptStep } from "../src/testing/scripted-model.js";
import { CHROMIUM, describeChromium } from "./helpers/chromium.js";
import { startFakeControl, type FakeControl } from "./helpers/fake-control.js";
import { must, settle } from "./helpers/fixture-server.js";
import { testRootSecret, USER_A } from "./helpers/keys.js";

/** Free text only the model writes; none of it may reach control in the clear. */
const TAKEOVER_REASON = "Amazon wants the 6-digit code sent to shopper@example.test to confirm the $482.19 order";
const TAKEOVER_INSTRUCTIONS = "Open the mailbox for 12 Elm Street and paste the code into the checkout page";
const QUESTION_PROMPT = "Ship the order to 12 Elm Street or to shopper@example.test's office?";
const QUESTION_DESCRIPTION = "The cart holds the $482.19 order and both addresses are on file";

interface PauseBody {
  pause: { id: string; kind: string; payload: Record<string, unknown> };
}

describeChromium("pause payloads carry correlators only", () => {
  let fake: FakeControl;
  let runner: Runner;
  let stateDir: string;
  const scripts = new Map<string, ScriptStep[]>();

  const pauseBodyFor = (runId: string): PauseBody =>
    must(
      fake.calls.filter((call) => call.path === `/v1/internal/runs/${runId}/pause`).at(-1),
      `a pause call for ${runId}`,
    ).body as PauseBody;

  /** Everything control can read without the Space keys. */
  const plaintextFor = (runId: string): string =>
    JSON.stringify({
      calls: fake.calls.filter((call) => call.path.includes(runId)),
      events: fake.run(runId).events,
    });

  beforeAll(async () => {
    fake = await startFakeControl({ egress: null, maxWaitSeconds: 1 });
    stateDir = await mkdtemp(join(tmpdir(), "cloud-browser-pause-"));
    runner = createRunner({
      controlUrl: fake.baseUrl,
      serviceToken: fake.serviceToken,
      stateDir,
      stateKey: randomBytes(32),
      chromiumPath: CHROMIUM ?? undefined,
      modelFactory: scriptedModelFactory(({ runId }) => scripts.get(runId) ?? []),
      ports: { http: 0 },
      host: "127.0.0.1",
      egressMode: "direct",
      transportFactory: (_hubUrl, deviceId, events) => new LoopbackTransport(deviceId, "cloud", events),
      claimIntervalMs: 50,
      commandWaitSeconds: 1,
      eventFlushDelayMs: 1,
      threadFlushMs: 10,
      sessionIdleMs: 60_000,
      // One step per turn: the third pause path (the step budget) is reached
      // without a long script.
      runPolicy: { maxSteps: 1, enabledToolGroups: [...CLOUD_TOOL_GROUPS] },
      // No navigation: the policy refuses `about:blank`, so the run drives an
      // empty tab and never opens a socket.
      defaultStartUrl: "about:blank",
      log: silentLogger,
    });
    await runner.start();
    expect((await runner.provision(USER_A, fake.enrollmentNonce(USER_A))).status).toBe(201);
    await fake.addDesktop(USER_A);
    await fake.wrapSpace(USER_A, "work", testRootSecret(0x61));
  });

  afterAll(async () => {
    await runner.stop();
    await fake.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  it("pauses a takeover with the takeover id alone, keeping the model's reason and instructions sealed", async () => {
    const run = fake.addRun({ userId: USER_A, spaceId: "work", intent: "Finish the checkout" });
    scripts.set(run.record.id, [
      toolCalls({ name: "request_takeover", input: { reason: TAKEOVER_REASON, instructions: TAKEOVER_INSTRUCTIONS } }),
    ]);
    await settle(() => fake.run(run.record.id).record.status === "waiting_for_step_up", { turns: 800 });

    const requested = must(
      fake.run(run.record.id).events.find((stored) => stored.event.t === "takeover.requested"),
      "the takeover.requested event",
    ).event;
    if (requested.t !== "takeover.requested") throw new Error("unexpected event");
    const body = pauseBodyFor(run.record.id);
    expect(body.pause.kind).toBe("step_up");
    expect(body.pause.payload).toEqual({ takeoverId: requested.takeoverId });
    expect(plaintextFor(run.record.id)).not.toContain("Elm Street");
    expect(plaintextFor(run.record.id)).not.toContain("482.19");
    expect(plaintextFor(run.record.id)).not.toContain("shopper@example.test");
  });

  it("pauses a question with the question id alone, keeping the model's prompt sealed", async () => {
    const run = fake.addRun({ userId: USER_A, spaceId: "work", intent: "Decide the delivery" });
    scripts.set(run.record.id, [
      toolCalls({
        name: "ask_user",
        input: {
          prompt: QUESTION_PROMPT,
          description: QUESTION_DESCRIPTION,
          choices: [
            { value: "home", label: "Home", description: "The street address" },
            { value: "office", label: "Office", description: "The work address" },
          ],
        },
      }),
    ]);
    await settle(() => fake.run(run.record.id).record.status === "waiting_for_judgment", { turns: 800 });

    const asked = must(
      fake.run(run.record.id).events.find((stored) => stored.event.t === "question.asked"),
      "the question.asked event",
    ).event;
    if (asked.t !== "question.asked") throw new Error("unexpected event");
    const body = pauseBodyFor(run.record.id);
    expect(body.pause.kind).toBe("judgment");
    expect(body.pause.payload).toEqual({ questionId: asked.questionId });
    expect(plaintextFor(run.record.id)).not.toContain("Elm Street");
    expect(plaintextFor(run.record.id)).not.toContain("shopper@example.test");
    expect(plaintextFor(run.record.id)).not.toContain("Office");
  });

  it("pauses the step budget with the question id and the budget flag alone", async () => {
    const run = fake.addRun({ userId: USER_A, spaceId: "work", intent: "Look around" });
    scripts.set(run.record.id, [toolCalls({ name: "tabs_list", input: {} })]);
    await settle(() => fake.run(run.record.id).record.status === "waiting_for_judgment", { turns: 800 });

    const asked = must(
      fake.run(run.record.id).events.find((stored) => stored.event.t === "question.asked"),
      "the question.asked event",
    ).event;
    if (asked.t !== "question.asked") throw new Error("unexpected event");
    const body = pauseBodyFor(run.record.id);
    expect(body.pause.kind).toBe("judgment");
    expect(body.pause.payload).toEqual({ questionId: asked.questionId, budget: true });
    expect(plaintextFor(run.record.id)).not.toContain("step budget");
  });
});
