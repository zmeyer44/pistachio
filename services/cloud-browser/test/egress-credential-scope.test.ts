/**
 * D13: egress credentials are minted per run and control revokes them by run
 * id. A worker runs several of a user's runs at once, so the credential a
 * Space's page guards present must be the live run's own — never a newer
 * run's, whose completion would revoke it out from under the run still
 * driving, and whose revocation would leave the finished run's egress open.
 */

import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopbackTransport } from "@pistachio/sync-engine";
import { afterAll, beforeAll, expect, it } from "vitest";
import { silentLogger } from "../src/logger.js";
import { createRunner, type Runner } from "../src/runner.js";
import { gate, scriptedModelFactory, type ScriptStep } from "../src/testing/scripted-model.js";
import { CHROMIUM, describeChromium } from "./helpers/chromium.js";
import { startFakeControl, type FakeControl } from "./helpers/fake-control.js";
import { must, settle } from "./helpers/fixture-server.js";
import { testRootSecret, USER_A } from "./helpers/keys.js";

describeChromium("egress credentials are scoped to the run that minted them", () => {
  let fake: FakeControl;
  let runner: Runner;
  let stateDir: string;
  const scripts = new Map<string, ScriptStep[]>();
  const holdWork = gate();
  const holdShop = gate();

  /** The credential control last minted for a run. */
  const mintedFor = (runId: string): { username: string; password: string } =>
    must(fake.credentialRequests.filter((request) => request.runId === runId).at(-1), `a credential for ${runId}`);

  beforeAll(async () => {
    // A gateway the contexts name but never dial: no run navigates.
    fake = await startFakeControl({ egress: { host: "127.0.0.1", port: 1 }, maxWaitSeconds: 1 });
    stateDir = await mkdtemp(join(tmpdir(), "cloud-browser-egress-"));
    runner = createRunner({
      controlUrl: fake.baseUrl,
      serviceToken: fake.serviceToken,
      stateDir,
      stateKey: randomBytes(32),
      chromiumPath: CHROMIUM ?? undefined,
      modelFactory: scriptedModelFactory(({ runId }) => scripts.get(runId) ?? []),
      ports: { http: 0 },
      host: "127.0.0.1",
      egressMode: "gateway",
      egressScheme: "http",
      transportFactory: (_hubUrl, deviceId, events) => new LoopbackTransport(deviceId, "cloud", events),
      claimIntervalMs: 50,
      commandWaitSeconds: 1,
      eventFlushDelayMs: 1,
      threadFlushMs: 10,
      sessionIdleMs: 60_000,
      // The policy refuses `about:blank`, so the run drives an empty tab and
      // never asks the gateway for a tunnel.
      defaultStartUrl: "about:blank",
      log: silentLogger,
    });
    await runner.start();
    expect((await runner.provision(USER_A, fake.enrollmentNonce(USER_A))).status).toBe(201);
    await fake.addDesktop(USER_A);
    await fake.wrapSpace(USER_A, "work", testRootSecret(0x61));
    await fake.wrapSpace(USER_A, "shop", testRootSecret(0x62));
  });

  afterAll(async () => {
    holdWork.release();
    holdShop.release();
    await runner.stop();
    await fake.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  it("gives each of a user's concurrent runs its own credential and takes it back when that run ends", async () => {
    const work = fake.addRun({ userId: USER_A, spaceId: "work", intent: "Hold the work Space" });
    scripts.set(work.record.id, [holdWork.step]);
    await settle(() => holdWork.waiting, { turns: 800 });
    const shop = fake.addRun({ userId: USER_A, spaceId: "shop", intent: "Hold the shop Space" });
    scripts.set(shop.record.id, [holdShop.step]);
    await settle(() => holdShop.waiting, { turns: 800 });

    const user = must(runner.sessions.userFor(USER_A), "the user session");
    expect(user.spaces.get("work")?.activeRuns).toBe(1);
    expect(user.spaces.get("shop")?.activeRuns).toBe(1);
    expect(fake.credentialRequests.map((request) => request.runId)).toEqual([work.record.id, shop.record.id]);

    // The newer run must not have taken over the older run's pages: control
    // revokes by run id, so a Space presenting another run's credential is
    // cut when that run ends and survives its own revocation.
    expect(user.credentialForSpace("work")?.username).toBe(mintedFor(work.record.id).username);
    expect(user.credentialHolderFor("work")).toEqual({ kind: "run", runId: work.record.id });
    expect(user.credentialForSpace("shop")?.username).toBe(mintedFor(shop.record.id).username);
    expect(user.credentialHolderFor("shop")).toEqual({ kind: "run", runId: shop.record.id });

    // The shop run finishes; its credential is revoked by run id, and the
    // work run keeps driving on its own.
    holdShop.release();
    await settle(() => fake.run(shop.record.id).record.status === "completed", { turns: 800 });
    await settle(() => !runner.executor.active.has(shop.record.id));
    expect(user.spaces.get("shop")?.activeRuns).toBe(0);
    expect(user.credentialForSpace("shop")).toBeNull();
    expect(user.credentialForSpace("work")?.username).toBe(mintedFor(work.record.id).username);
    expect(fake.run(work.record.id).record.status).toBe("running");

    holdWork.release();
    await settle(() => fake.run(work.record.id).record.status === "completed", { turns: 800 });
    await settle(() => !runner.executor.active.has(work.record.id));
    expect(user.credentialForSpace("work")).toBeNull();
  });
});
