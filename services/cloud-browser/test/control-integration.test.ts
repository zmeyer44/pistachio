/**
 * The runner against the REAL control plane (§8.2, §8.3, §8.5, §12): control
 * and its hub booted in-process on PGlite and served on an ephemeral port;
 * the cloud device provisioned through `POST /cloud/enable`; a desktop
 * wrapping the Space secret to it; a run driven over the real hub with a
 * scripted model; control's event stream holding only sealed content; a
 * sponsor message delivered by steer and long-poll handled once; the
 * live-view auth matrix on real device JWTs; and revocation through
 * `POST /devices/:id/revoke` (hub 4003 + steer) tearing the runner down.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRequestListener } from "@hono/node-server";
import type { LanguageModel } from "ai";
import type { RunContentEvent, StoredRunEvent, ThreadListItem } from "@pistachio/protocol";
import {
  deriveSpaceKeys,
  credentialCaptureSealAad,
  deviceLoginSigningBytes,
  exportPublicKeyRaw,
  fromBase64,
  fromUtf8,
  generateAgreementKeypair,
  generateDeviceKeypair,
  liveProofSealAad,
  open,
  seal,
  sealCredentialCapturePayload,
  toBase64,
  utf8,
  vaultEntrySealAad,
  wrapRootSecretToDevice,
  type DeviceKeypair,
  type SpaceKeys,
} from "@pistachio/sync-protocol";
import { afterAll, beforeAll, expect, it } from "vitest";
import WebSocket from "ws";
import {
  createApp,
  createDbFromUrl,
  ensureSchema,
  generateSigningKeys,
  httpRunnerClient,
  schema,
  type ControlApp,
  type Db,
  type RunnerClient,
} from "../../control/src/index.js";
import { silentLogger } from "../src/logger.js";
import { createRunner, type Runner } from "../src/runner.js";
import { openRunEvent, openThread } from "../src/runs/events.js";
import type { ModelFactory } from "../src/runs/executor.js";
import { answer, gate, scriptedModel, toolCalls, type ScriptStep } from "../src/testing/scripted-model.js";
import { CHROMIUM, describeChromium } from "./helpers/chromium.js";
import { must, settle, startFixture, type FixtureServer } from "./helpers/fixture-server.js";
import { testRootSecret } from "./helpers/keys.js";

const SERVICE_TOKEN = "svc-token-for-tests";
const PASSWORD = "correct-horse-battery";

interface DesktopKeys {
  deviceId: string;
  signing: DeviceKeypair;
  devicePublicKey: string;
  agreementPublicKey: string;
}

interface Desktop extends DesktopKeys {
  token: string;
}

interface ControlDeviceRow {
  id: string;
  platform: string;
  agreementPublicKey: string;
  revokedAt: string | null;
}

/** The model reads the fixture: list tabs, inspect the first, answer. */
function readingScript(finalText: string): ScriptStep[] {
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
    answer(finalText),
  ];
}

describeChromium("runner against the real control plane", () => {
  let db: Db;
  let controlServer: Server;
  let control: ControlApp;
  let hub: { close(): Promise<void> };
  let controlUrl: string;
  let fixture: FixtureServer;
  let runner: Runner;
  let stateDir: string;
  let keys: SpaceKeys;
  const submittedCredentials: Array<{ email: string; password: string }> = [];
  const sentIMessages: Array<{ chatGuid: string; message: string }> = [];
  const secret = testRootSecret(0x71);
  /** Scripts by run id, read lazily on every model call (a run may be claimed before its script is registered). */
  const scripts = new Map<string, ScriptStep[]>();
  const gates = new Map<string, ReturnType<typeof gate>>();

  const api = async (
    path: string,
    init: { method?: string; body?: unknown; token?: string } = {},
  ): Promise<{ status: number; json: Record<string, unknown> }> => {
    const response = await fetch(`${controlUrl}/v1${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
      },
      body: init.body === undefined ? null : JSON.stringify(init.body),
    });
    const text = await response.text();
    return { status: response.status, json: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
  };

  const signup = async (): Promise<{ userId: string; bootstrapToken: string }> => {
    const out = await api("/accounts", { body: { email: `${randomUUID().slice(0, 8)}@example.com`, password: PASSWORD } });
    expect(out.status).toBe(201);
    return { userId: out.json["userId"] as string, bootstrapToken: out.json["bootstrapToken"] as string };
  };

  const desktopKeys = async (): Promise<DesktopKeys> => {
    const signing = await generateDeviceKeypair();
    const agreement = await generateAgreementKeypair();
    return {
      deviceId: randomUUID(),
      signing,
      devicePublicKey: toBase64(await exportPublicKeyRaw(signing.publicKey)),
      agreementPublicKey: toBase64(await exportPublicKeyRaw(agreement.publicKey)),
    };
  };

  const enrollDesktop = async (bootstrapToken: string, name = "MacBook"): Promise<Desktop> => {
    const k = await desktopKeys();
    const challenge = (await api("/auth/device-challenge", { body: { deviceId: k.deviceId } })).json["challenge"] as string;
    const signature = toBase64(
      new Uint8Array(
        await crypto.subtle.sign("Ed25519", k.signing.privateKey, deviceLoginSigningBytes(k.deviceId, challenge) as BufferSource),
      ),
    );
    const out = await api("/devices/enroll", {
      token: bootstrapToken,
      body: {
        deviceId: k.deviceId,
        name,
        platform: "macos",
        devicePublicKey: k.devicePublicKey,
        agreementPublicKey: k.agreementPublicKey,
        challenge,
        signature,
      },
    });
    expect(out.status).toBe(201);
    return { ...k, token: out.json["token"] as string };
  };

  const runStatus = async (runId: string, token: string): Promise<string> => {
    const out = await api(`/runs/${runId}`, { token });
    return out.status === 200 ? ((out.json["summary"] as ThreadListItem).status as string) : `http_${String(out.status)}`;
  };

  /** Read the SSE stream until `event: end`, returning the stored events. */
  const readEvents = async (runId: string, token: string): Promise<{ events: StoredRunEvent[]; end: string }> => {
    const response = await fetch(`${controlUrl}/v1/runs/${runId}/events?since=0`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = must(response.body).getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (let chunk = 0; chunk < 500 && !text.includes("event: end"); chunk += 1) {
      const next = await reader.read();
      if (next.value !== undefined) text += decoder.decode(next.value, { stream: true });
      if (next.done) break;
    }
    await reader.cancel().catch(() => undefined);
    const events: StoredRunEvent[] = [];
    let end = "";
    for (const block of text.split("\n\n")) {
      const lines = block.split("\n");
      const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
      const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
      if (event === "run" && data !== undefined) events.push(JSON.parse(data) as StoredRunEvent);
      if (event === "end" && data !== undefined) end = (JSON.parse(data) as { status: string }).status;
    }
    return { events, end };
  };

  /** Ask control for a live ticket the way a client does (§8.5). */
  const liveTicket = async (runId: string, token: string): Promise<{ status: number; ticket: string }> => {
    const res = await api(`/runs/${runId}/live-ticket`, { token, body: {} });
    return { status: res.status, ticket: (res.json["ticket"] as string | undefined) ?? "" };
  };

  const openLive = (
    runId: string,
    token: string,
  ): Promise<{ ws: WebSocket; status: number | null; frames: Array<Record<string, unknown>> }> => {
    const ws = new WebSocket(`ws://127.0.0.1:${String(runner.port)}/v1/live/${runId}`, { headers: { authorization: `Bearer ${token}` } });
    const frames: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => frames.push(JSON.parse(data.toString()) as Record<string, unknown>));
    ws.on("error", () => undefined);
    return new Promise((resolve) => {
      ws.once("open", () => resolve({ ws, status: null, frames }));
      ws.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve({ ws, status: response.statusCode ?? 0, frames });
      });
    });
  };

  const closedWith = (ws: WebSocket): Promise<number> => new Promise((resolve) => ws.once("close", (code) => resolve(code)));

  /**
   * Answer the runner's Space-key challenge with the real key (§8.5). A
   * device token gets a socket; only this gets the picture.
   */
  const prove = async (
    opened: { ws: WebSocket; frames: Array<Record<string, unknown>> },
    runId: string,
  ): Promise<void> => {
    await settle(() => opened.frames.length >= 1, { turns: 400 });
    const challenge = opened.frames.shift() as { t: string; nonce: string };
    expect(challenge.t).toBe("challenge");
    const keys = await deriveSpaceKeys("work", secret);
    const proof = toBase64(await seal(keys.sealKey, utf8(challenge.nonce), liveProofSealAad(runId, challenge.nonce)));
    opened.ws.send(JSON.stringify({ t: "auth", proof }));
  };

  /** `settle` for an async predicate (control round trips). */
  const waitFor = async (predicate: () => Promise<boolean>, turns = 400): Promise<void> => {
    for (let turn = 0; turn < turns; turn += 1) {
      if (await predicate()) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("condition did not settle within the turn budget");
  };

  /** `hosted_runs.thread` straight from the database: no route exposes it (only the runner opens it). */
  const threadFor = async (runId: string): Promise<{ spaceId: string; sealed: string } | null> => {
    const rows = await db.select({ id: schema.hostedRuns.id, thread: schema.hostedRuns.thread }).from(schema.hostedRuns);
    return (rows.find((row) => row.id === runId)?.thread as { spaceId: string; sealed: string } | null | undefined) ?? null;
  };

  beforeAll(async () => {
    db = await createDbFromUrl("pglite:memory://");
    await ensureSchema(db);
    const signing = await generateSigningKeys();
    // The runner's URL is only known once it listens; control reaches it through this indirection.
    let runnerClient: RunnerClient | null = null;
    control = createApp(db, {
      signing,
      // The fleet's one public address; this test dials the worker directly,
      // but control will not issue a live ticket without knowing it (§8.5).
      env: {
        CLOUD_BROWSER_SERVICE_TOKEN: SERVICE_TOKEN,
        CLOUD_BROWSER_PUBLIC_URL: "https://live.example",
        PISTACHIO_WEB_URL: "https://app.example",
      },
      runner: {
        provision: (userId, nonce) => must(runnerClient, "runner client").provision(userId, nonce),
        steer: (body) => must(runnerClient, "runner client").steer(body),
        routeIMessage: (input) => must(runnerClient, "runner client").routeIMessage(input),
      },
      imessage: {
        serverUrl: "http://bluebubbles.test",
        password: "password",
        webhookSecret: "webhook-secret",
        otpSecret: "otp-secret-for-tests",
        fetch: async (_input, init) => {
          const body = JSON.parse(String(init?.body ?? "{}")) as { chatGuid?: unknown; message?: unknown };
          sentIMessages.push({
            chatGuid: String(body.chatGuid ?? ""),
            message: String(body.message ?? ""),
          });
          return new Response(null, { status: 200 });
        },
      },
    });
    controlServer = createServer(getRequestListener(control.app.fetch));
    await new Promise<void>((resolve) => controlServer.listen(0, "127.0.0.1", resolve));
    hub = control.hub.attach(controlServer);
    controlUrl = `http://127.0.0.1:${String((controlServer.address() as AddressInfo).port)}`;

    fixture = await startFixture((request, response, body) => {
      if (request.method === "POST") {
        const submitted = new URLSearchParams(body.toString("utf8"));
        submittedCredentials.push({
          email: submitted.get("email") ?? "",
          password: submitted.get("password") ?? "",
        });
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<!doctype html><title>Signed in</title><p>Purchase account ready</p>");
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>Fixture</title><body>
        <p>fixture body text</p>
        <form method="post">
          <label>Email <input id="email" name="email" type="email" autocomplete="username"></label>
          <label>Password <input id="password" name="password" type="password" autocomplete="current-password"></label>
          <button id="sign-in" type="submit">Sign in</button>
        </form>
        <script>
          // Model a sign-in control that suppresses modifier-backed key events.
          document.querySelector("#password").addEventListener("keydown", (event) => {
            if (event.shiftKey) event.preventDefault();
          });
        </script>
      </body>`);
    });
    stateDir = await mkdtemp(join(tmpdir(), "cloud-browser-control-"));
    keys = await deriveSpaceKeys("work", secret);
    const modelFactory: ModelFactory = ({ runId }) => ({
      model: scriptedModel([], (options) => {
        const step = scripts.get(runId)?.shift() ?? gates.get(runId)?.step;
        if (step === undefined) throw new Error(`no script registered for run ${runId}`);
        return step(options);
      }) as unknown as LanguageModel,
      modelName: "scripted",
    });
    runner = createRunner({
      controlUrl,
      serviceToken: SERVICE_TOKEN,
      stateDir,
      stateKey: randomBytes(32),
      chromiumPath: CHROMIUM ?? undefined,
      modelFactory,
      ports: { http: 0 },
      host: "127.0.0.1",
      allowedOrigins: [fixture.origin],
      egressMode: "direct",
      claimIntervalMs: 50,
      commandWaitSeconds: 1,
      liveRecheckIntervalMs: 50,
      eventFlushDelayMs: 1,
      threadFlushMs: 10,
      sessionIdleMs: 60_000,
      log: silentLogger,
    });
    await runner.start();
    runnerClient = httpRunnerClient({ baseUrl: must(runner.url), serviceToken: SERVICE_TOKEN });
  });

  afterAll(async () => {
    for (const held of gates.values()) held.release();
    await runner.stop();
    await control.idle();
    await hub.close();
    controlServer.closeAllConnections();
    await new Promise<void>((resolve) => controlServer.close(() => resolve()));
    await fixture.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  it("provisions through /cloud/enable, drives a run over the real hub, and control stores only sealed content", async () => {
    const account = await signup();
    const desktop = await enrollDesktop(account.bootstrapToken);

    // Enabling the cloud makes control push provisioning to the runner (§8.2).
    const enabled = await api("/cloud/enable", { token: desktop.token, body: { spaceId: "work" } });
    expect(enabled.status).toBe(200);
    const cloud = enabled.json["device"] as ControlDeviceRow;
    expect(cloud.platform).toBe("cloud");
    const identity = must(await runner.identity.identityFor(account.userId), "stored identity");
    expect(identity.deviceId).toBe(cloud.id);
    expect(identity.agreementPublicKey).toBe(cloud.agreementPublicKey);
    expect(existsSync(join(stateDir, account.userId, "device.json"))).toBe(true);
    // A second enable is idempotent: control finds the live device and does not provision again.
    expect((await api("/cloud/enable", { token: desktop.token, body: { spaceId: "work" } })).json).toMatchObject({ device: { id: cloud.id } });
    const devices = (await api("/devices", { token: desktop.token })).json["devices"] as ControlDeviceRow[];
    expect(devices.map((row) => row.platform).sort()).toEqual(["cloud", "macos"]);

    // The desktop wraps the Space secret to the cloud device (sender-signed) and a run becomes possible.
    expect((await api("/runs", { token: desktop.token, body: { spaceId: "work", intent: "too early" } })).status).toBe(400);
    const wrapper = await wrapRootSecretToDevice(
      secret,
      "work",
      { deviceId: cloud.id, agreementPublicKeyRaw: fromBase64(cloud.agreementPublicKey) },
      { deviceId: desktop.deviceId, signingKey: desktop.signing.privateKey },
    );
    const put = await api("/spaces/work/wrappers", {
      method: "PUT",
      token: desktop.token,
      body: {
        wrappers: [
          {
            kind: wrapper.kind,
            credentialId: wrapper.credentialId,
            salt: wrapper.salt,
            wrapped: wrapper.wrapped,
            senderDeviceId: wrapper.senderDeviceId,
            signature: wrapper.signature,
          },
        ],
      },
    });
    expect(put.status).toBe(200);

    // The model is held at its first call so the sponsor can write mid-run.
    const held = gate();
    const created = await api("/runs", { token: desktop.token, body: { spaceId: "work", intent: "Read the fixture page", startUrl: fixture.origin } });
    expect(created.status).toBe(201);
    const runId = created.json["runId"] as string;
    gates.set(runId, held);
    scripts.set(runId, [held.step, ...readingScript("The fixture page says: fixture body text.")]);
    await settle(() => held.waiting, { turns: 1200 });
    expect(await runStatus(runId, desktop.token)).toBe("running");
    const user = must(runner.sessions.users.get(account.userId), "user session");
    expect(user.transport.state).toBe("connected"); // the real hub, hello {kind:'cloud'}
    expect(user.spaces.get("work")?.hasHydratedOnce).toBe(true);

    // Sent while the agent holds: control steers it and the long-poll repeats it; the runner handles it once.
    const message = await api(`/runs/${runId}/message`, { token: desktop.token, body: { text: "also tell me the title" } });
    expect(message.status).toBe(202);
    held.release(answer("I am about to read the page."));
    await waitFor(async () => (await runStatus(runId, desktop.token)) === "completed", 1200);
    await settle(() => runner.executor.active.size === 0, { turns: 1200 });

    const record = (await api(`/runs/${runId}`, { token: desktop.token })).json["run"] as { executor: unknown; status: string };
    expect(record.executor).toEqual({ kind: "cloud", deviceId: cloud.id, workerId: runner.workerId });
    const { events, end } = await readEvents(runId, desktop.token);
    expect(end).toBe("completed");
    expect(events[0]?.event.t).toBe("run.created");
    expect(events.map((event) => event.seq)).toEqual(events.map((_event, index) => index + 1));
    const kinds = events.map((event) => event.event.t);
    expect(kinds.slice(0, 3)).toEqual(["run.created", "status", "control"]);
    expect(kinds.filter((kind) => kind === "cmd.message")).toHaveLength(1);
    expect(kinds).toContain("tool.started");
    // The terminal status rides in the runner's trailing batch, so control adds none of its own.
    expect(events.filter((event) => event.event.t === "status" && event.event.status === "completed")).toHaveLength(1);
    expect(kinds.slice(-2)).toEqual(["status", "done"]);
    const wire = JSON.stringify(events);
    expect(wire).not.toContain("fixture body text");
    expect(wire).not.toContain("about to read");
    expect(wire).not.toContain('"role":');
    const opened: RunContentEvent[] = [];
    for (const event of events) {
      if (event.event.t === "sealed") opened.push(await openRunEvent(keys.sealKey, runId, event));
    }
    const userMessages = opened.filter((event) => event.t === "message" && event.message.role === "user").map((event) => (event as { message: { content: string } }).message.content);
    expect(userMessages).toEqual(["Read the fixture page", "also tell me the title"]);
    const assistant = opened.filter((event) => event.t === "message" && event.message.role === "assistant").map((event) => (event as { message: { content: string } }).message.content);
    expect(assistant).toEqual(["I am about to read the page.", "The fixture page says: fixture body text."]);
    expect(opened.some((event) => event.t === "tool.detail" && JSON.stringify(event.data ?? "").includes("fixture body text"))).toBe(true);
    const summary = (await api(`/runs/${runId}`, { token: desktop.token })).json["summary"] as ThreadListItem;
    expect(summary.turns).toBe(2);
    // The summary folds control's creation-time projection (no event updates the executor);
    // the record above carries the claimed device and worker.
    expect(summary.executor).toEqual({ kind: "cloud", deviceId: null, workerId: null });
    // The sealed thread lives in hosted_runs.thread and opens only with the Space key.
    const thread = await threadFor(runId);
    expect(thread?.spaceId).toBe("work");
    const plainThread = await openThread<{ version: number; messages: Array<{ role: string; content?: unknown }> }>(keys.sealKey, runId, must(thread).sealed);
    expect(plainThread.version).toBe(2);
    expect(plainThread.messages.filter((item) => item.role === "user").length).toBeGreaterThanOrEqual(2);
    await expect(openThread(keys.sealKey, randomUUID(), must(thread).sealed)).rejects.toThrow();

    // A completed run accepts another turn under the same id. The reclaimed
    // worker must consume that message before invoking the model, and its
    // restored prompt still contains the completed turn.
    scripts.set(runId, [
      (options) => {
        const prompt = JSON.stringify(options.prompt);
        expect(prompt).toContain("The fixture page says: fixture body text.");
        expect(prompt).toContain("Now continue in this same conversation");
        return answer("The follow-up kept the earlier context.")(options);
      },
    ]);
    const continued = await api(`/runs/${runId}/message`, {
      token: desktop.token,
      body: { text: "Now continue in this same conversation" },
    });
    expect(continued.status).toBe(202);
    expect(continued.json).toMatchObject({ status: "ready" });
    await waitFor(async () => (await runStatus(runId, desktop.token)) === "completed", 1200);
    await settle(() => runner.executor.active.size === 0, { turns: 1200 });

    const continuedThread = await threadFor(runId);
    const continuedPlain = await openThread<{ messages: Array<{ role: string; content?: unknown }> }>(
      keys.sealKey,
      runId,
      must(continuedThread).sealed,
    );
    expect(JSON.stringify(continuedPlain.messages)).toContain("Now continue in this same conversation");
    expect(JSON.stringify(continuedPlain.messages)).toContain("The fixture page says: fixture body text.");
    expect(JSON.stringify(continuedPlain.messages)).toContain("The follow-up kept the earlier context.");
  });

  it.each([true, false])("captures credentials, resumes and reuses the vault with phone linked=%s", async (phoneLinked) => {
    const messagesBefore = sentIMessages.length;
    const account = await signup();
    const desktop = await enrollDesktop(account.bootstrapToken);
    if (phoneLinked) await db.insert(schema.imessageLinks).values({
      userId: account.userId,
      phoneE164: "+12125550123",
      verifiedAt: new Date(),
    });
    const cloud = (await api("/cloud/enable", { token: desktop.token, body: { spaceId: "work" } })).json["device"] as ControlDeviceRow;
    const wrapper = await wrapRootSecretToDevice(
      secret,
      "work",
      { deviceId: cloud.id, agreementPublicKeyRaw: fromBase64(cloud.agreementPublicKey) },
      { deviceId: desktop.deviceId, signingKey: desktop.signing.privateKey },
    );
    expect((await api("/spaces/work/wrappers", {
      method: "PUT",
      token: desktop.token,
      body: { wrappers: [{ kind: wrapper.kind, credentialId: wrapper.credentialId, salt: wrapper.salt, wrapped: wrapper.wrapped, senderDeviceId: wrapper.senderDeviceId, signature: wrapper.signature }] },
    })).status).toBe(200);

    let tabId = "";
    const chooseTab: ScriptStep = ({ prompt }) => {
      for (const message of prompt) {
        if (message.role !== "tool") continue;
        for (const part of message.content) {
          if (part.type !== "tool-result" || part.output.type !== "json") continue;
          const value = part.output.value as { data?: { tabs?: Array<{ id: string }> } };
          tabId = value.data?.tabs?.[0]?.id ?? tabId;
        }
      }
      return toolCalls({ name: "page_inspect", input: { tabId } })({ prompt } as Parameters<ScriptStep>[0]);
    };
    const askForCredentials: ScriptStep = ({ prompt }) => toolCalls({
      name: "request_credentials",
      input: {
        tabId,
        siteName: "Fixture Store",
        fields: [
          { label: "Email", type: "email", target: "#email", autocomplete: "email" },
          { label: "Password", type: "password", target: "#password", autocomplete: "current-password" },
        ],
      },
    })({ prompt } as Parameters<ScriptStep>[0]);
    const inspectAfterHandoff: ScriptStep = ({ prompt }) =>
      toolCalls({ name: "page_inspect", input: { tabId } })({ prompt } as Parameters<ScriptStep>[0]);

    const created = await api("/runs", {
      token: desktop.token,
      body: { spaceId: "work", intent: "Sign in and prepare the account", startUrl: fixture.origin },
    });
    expect(created.status).toBe(201);
    const runId = created.json["runId"] as string;
    scripts.set(runId, [
      toolCalls({ name: "tabs_list", input: {} }),
      chooseTab,
      askForCredentials,
      inspectAfterHandoff,
      toolCalls({ name: "page_click", input: { tabId: "__resolved_later__", target: "#sign-in" } }),
      answer("The account is signed in and ready."),
    ]);
    // Replace the click step after the tab-list result has populated `tabId`.
    scripts.get(runId)?.splice(4, 1, ({ prompt }) =>
      toolCalls({ name: "page_click", input: { tabId, target: "#sign-in" } })({ prompt } as Parameters<ScriptStep>[0]));

    await waitFor(async () => (await runStatus(runId, desktop.token)) === "waiting_for_step_up", 1200);
    let capture: typeof schema.credentialCaptures.$inferSelect | undefined;
    await waitFor(async () => {
      capture = (await db.select().from(schema.credentialCaptures)).find((row) => row.runId === runId);
      return capture !== undefined;
    });
    await control.idle();
    if (phoneLinked) {
      expect(sentIMessages.at(-1)).toEqual({
        chatGuid: "iMessage;-;+12125550123",
        message: expect.stringContaining(`https://app.example/credential-capture/${must(capture).id}`),
      });
      expect(sentIMessages.at(-1)?.message).toContain(fixture.origin);
      expect(sentIMessages.at(-1)?.message).toContain("Requested fields: Email, Password");
      expect(sentIMessages.at(-1)?.message).toContain("Do not reply with sensitive information");
      expect(sentIMessages.at(-1)?.message).not.toContain("shopper@example.com");
    } else {
      expect(sentIMessages).toHaveLength(messagesBefore);
    }
    const fields = Object.fromEntries(must(capture).fields.map((field) => [
      field.id,
      field.target === "#email" ? "shopper@example.com" : "Synthetic44$Synthetic44$",
    ]));
    const plaintext = utf8(JSON.stringify({ version: 1, fields, remember: true }));
    expect(must(capture).encryptionPublicKey).toBe(cloud.agreementPublicKey);
    const sealedPayload = toBase64(await sealCredentialCapturePayload(
      fromBase64(must(capture).encryptionPublicKey),
      plaintext,
      credentialCaptureSealAad(runId, must(capture).id),
    ));
    plaintext.fill(0);
    const submitted = await api(`/credential-captures/${must(capture).id}/submit`, {
      body: { sealedPayload },
    });
    expect(submitted.status).toBe(202);

    await waitFor(async () => (await runStatus(runId, desktop.token)) === "completed", 1200);
    await settle(() => runner.executor.active.size === 0, { turns: 1200 });
    expect(submittedCredentials.at(-1)).toEqual({
      email: "shopper@example.com",
      password: "Synthetic44$Synthetic44$",
    });
    const { events } = await readEvents(runId, desktop.token);
    const wire = JSON.stringify(events);
    expect(wire).not.toContain("shopper@example.com");
    expect(wire).not.toContain("correct secret phrase");
    const opened: RunContentEvent[] = [];
    for (const event of events) {
      if (event.event.t === "sealed") opened.push(await openRunEvent(keys.sealKey, runId, event));
    }
    expect(opened).toEqual(expect.arrayContaining([
      expect.objectContaining({ t: "takeover", takeover: expect.objectContaining({ kind: "credentials", captureId: must(capture).id }) }),
      expect.objectContaining({ t: "evidence", entry: expect.objectContaining({ type: "credentials.injected" }) }),
      expect.objectContaining({ t: "evidence", entry: expect.objectContaining({ type: "vault.saved" }) }),
    ]));

    // What the person chose to keep is now a vault entry: sealed under the
    // Space key (control's row holds no plaintext), openable by their own
    // device, and listed to them with the fields it covers.
    const kept = (await db.select().from(schema.vaultEntries)).find((row) => row.userId === account.userId);
    expect(kept).toMatchObject({ spaceId: "work", siteOrigin: fixture.origin, siteName: "Fixture Store", source: "capture" });
    expect(JSON.stringify(kept)).not.toContain("shopper@example.com");
    expect(JSON.stringify(kept)).not.toContain("Synthetic44$");
    const keptPlain = JSON.parse(fromUtf8(await open(
      keys.sealKey,
      fromBase64(must(kept).sealedPayload),
      vaultEntrySealAad("work", must(kept).id),
    ))) as { version: number; values: Record<string, string> };
    expect(keptPlain.version).toBe(1);
    expect(Object.values(keptPlain.values).sort()).toEqual(["Synthetic44$Synthetic44$", "shopper@example.com"]);
    expect(must(kept).fields.map((field) => field.label).sort()).toEqual(["Email", "Password"]);
    const listed = await api("/spaces/work/vault", { token: desktop.token });
    expect(listed.status).toBe(200);
    expect((listed.json["entries"] as Array<{ id: string }>).map((entry) => entry.id)).toEqual([must(kept).id]);

    // The next run on the same site asks for the same fields and gets them
    // from the vault: no form, no pause, no new capture row, the same values
    // typed into the page, and the person's thread records where they came from.
    submittedCredentials.length = 0;
    const again = await api("/runs", {
      token: desktop.token,
      body: { spaceId: "work", intent: "Sign in again and check the account", startUrl: fixture.origin },
    });
    expect(again.status).toBe(201);
    const secondRunId = again.json["runId"] as string;
    // The Space's browser kept the first run's tabs, so the first one still
    // shows the signed-in page; send it back to the sign-in form first.
    const returnToForm: ScriptStep = ({ prompt }) => {
      chooseTab({ prompt } as Parameters<ScriptStep>[0]);
      return toolCalls({ name: "page_navigate", input: { tabId, url: `${fixture.origin}/` } })({ prompt } as Parameters<ScriptStep>[0]);
    };
    scripts.set(secondRunId, [
      toolCalls({ name: "tabs_list", input: {} }),
      returnToForm,
      ({ prompt }) => toolCalls({ name: "page_inspect", input: { tabId } })({ prompt } as Parameters<ScriptStep>[0]),
      askForCredentials,
      ({ prompt }) => {
        const last = prompt.at(-1);
        const results = last?.role === "tool" ? last.content.map((part) => JSON.stringify(part)).join("\n") : "";
        expect(results).toContain('"filledFromVault":true');
        expect(results).not.toContain("credential-capture/");
        return inspectAfterHandoff({ prompt } as Parameters<ScriptStep>[0]);
      },
      ({ prompt }) => toolCalls({ name: "page_click", input: { tabId, target: "#sign-in" } })({ prompt } as Parameters<ScriptStep>[0]),
      answer("Signed in again with the saved details."),
    ]);
    await waitFor(async () => (await runStatus(secondRunId, desktop.token)) === "completed", 1200);
    await settle(() => runner.executor.active.size === 0, { turns: 1200 });
    expect(submittedCredentials.at(-1)).toEqual({
      email: "shopper@example.com",
      password: "Synthetic44$Synthetic44$",
    });
    expect((await db.select().from(schema.credentialCaptures)).filter((row) => row.runId === secondRunId)).toHaveLength(0);
    const secondEvents = (await readEvents(secondRunId, desktop.token)).events;
    expect(JSON.stringify(secondEvents)).not.toContain("shopper@example.com");
    const secondOpened: RunContentEvent[] = [];
    for (const event of secondEvents) {
      if (event.event.t === "sealed") secondOpened.push(await openRunEvent(keys.sealKey, secondRunId, event));
    }
    expect(secondOpened).toEqual(expect.arrayContaining([
      expect.objectContaining({ t: "evidence", entry: expect.objectContaining({ type: "vault.injected", payload: expect.objectContaining({ entryId: must(kept).id }) }) }),
    ]));
    expect(secondOpened.some((event) => event.t === "takeover")).toBe(false);
    const touched = (await db.select().from(schema.vaultEntries)).find((row) => row.id === must(kept).id);
    expect(touched?.lastUsedAt?.getTime()).toBeGreaterThan(must(kept).lastUsedAt?.getTime() ?? 0);
  });

  it("gates the live view on real device tokens and tears down on revocation through control", async () => {
    const account = await signup();
    const desktop = await enrollDesktop(account.bootstrapToken);
    const cloud = (await api("/cloud/enable", { token: desktop.token, body: { spaceId: "work" } })).json["device"] as ControlDeviceRow;
    const wrapper = await wrapRootSecretToDevice(
      secret,
      "work",
      { deviceId: cloud.id, agreementPublicKeyRaw: fromBase64(cloud.agreementPublicKey) },
      { deviceId: desktop.deviceId, signingKey: desktop.signing.privateKey },
    );
    expect(
      (
        await api("/spaces/work/wrappers", {
          method: "PUT",
          token: desktop.token,
          body: { wrappers: [{ kind: wrapper.kind, credentialId: wrapper.credentialId, salt: wrapper.salt, wrapped: wrapper.wrapped, senderDeviceId: wrapper.senderDeviceId, signature: wrapper.signature }] },
        })
      ).status,
    ).toBe(200);
    const held = gate();
    const runId = (await api("/runs", { token: desktop.token, body: { spaceId: "work", intent: "Hold the browser", startUrl: fixture.origin } })).json["runId"] as string;
    gates.set(runId, held);
    await settle(() => held.waiting, { turns: 1200 });

    // The matrix (§8.5) is now control's, at the point a ticket is issued:
    // bootstrap has no device, another user does not own the run, an unknown
    // run is not found, and the cloud device is not a viewer.
    const other = await signup();
    const otherDesktop = await enrollDesktop(other.bootstrapToken);
    const cloudToken = await runner.identity.tokenFor(account.userId);
    expect((await liveTicket(runId, account.bootstrapToken)).status).toBe(403);
    expect((await liveTicket(runId, otherDesktop.token)).status).toBe(404);
    expect((await liveTicket(randomUUID(), desktop.token)).status).toBe(404);
    // The cloud device never gets one: control's own allowlist keeps it to
    // the handful of GETs it needs, and the runner would refuse it anyway.
    expect((await liveTicket(runId, cloudToken)).status).toBe(403);
    // And a ticket is the only thing the socket takes: a device token is not one.
    expect((await openLive(runId, desktop.token)).status).toBe(401);
    expect((await openLive(runId, "not-a-ticket")).status).toBe(401);

    // A second desktop watches; revoking it closes its socket 4003 within one re-check.
    const viewer = await enrollDesktop(account.bootstrapToken, "Second desktop");
    const watching = await openLive(runId, (await liveTicket(runId, viewer.token)).ticket);
    expect(watching.status).toBeNull();
    await prove(watching, runId);
    await settle(() => watching.frames.some((frame) => frame["t"] === "frame"), { turns: 400 });
    expect(watching.frames.find((frame) => frame["t"] === "status")).toEqual({ t: "status", status: "running", control: "agent" });
    const watchingClosed = closedWith(watching.ws);
    expect((await api(`/devices/${viewer.deviceId}/revoke`, { token: desktop.token, body: {} })).json).toMatchObject({ revoked: true });
    expect(await watchingClosed).toBe(4003);

    // Revoking the cloud device through control: the hub closes the runner's socket 4003 and control
    // steers device.revoked; the runner fails the run, closes live sockets 4003, drops the identity.
    const own = await openLive(runId, (await liveTicket(runId, desktop.token)).ticket);
    expect(own.status).toBeNull();
    await prove(own, runId);
    const ownClosed = closedWith(own.ws);
    const transport = must(runner.sessions.users.get(account.userId), "user session").transport;
    const revoked = await api(`/devices/${cloud.id}/revoke`, { token: desktop.token, body: {} });
    expect(revoked.status).toBe(200);
    expect(await ownClosed).toBe(4003);
    await waitFor(async () => (await runStatus(runId, desktop.token)) === "failed");
    await settle(() => !runner.sessions.users.has(account.userId) && runner.executor.active.size === 0, { turns: 400 });
    // The hub's 4003 close (state `off`) and the steer-driven stop (`offline`) race; neither reconnects.
    expect(["off", "offline"]).toContain(transport.state);
    expect(await runner.identity.identityFor(account.userId)).toBeNull();
    expect(existsSync(join(stateDir, account.userId, "device.json"))).toBe(false);
    const { events, end } = await readEvents(runId, desktop.token);
    expect(end).toBe("failed");
    expect(events.filter((event) => event.event.t === "status" && event.event.status === "failed")).toHaveLength(1);
    expect(events.at(-2)?.event).toMatchObject({ t: "status", status: "failed" });
    expect(events.at(-1)?.event).toEqual({ t: "done", ok: false });
    // The wrappers went with the device: the Space is no longer cloud-enabled.
    expect((await api("/runs", { token: desktop.token, body: { spaceId: "work", intent: "again" } })).json).toEqual({ error: "space_not_cloud_enabled" });
    // Re-enabling provisions a fresh identity (never the revoked one).
    const again = (await api("/cloud/enable", { token: desktop.token, body: { spaceId: "work" } })).json["device"] as ControlDeviceRow;
    expect(again.id).not.toBe(cloud.id);
    expect((await runner.identity.identityFor(account.userId))?.deviceId).toBe(again.id);
    expect(["off", "offline"]).toContain(transport.state);
  });

});
