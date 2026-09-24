/**
 * The cloud path end to end (docs/cloud-sync-design.md §7, §8, §12): the real
 * control plane on PGlite with its hub on an ephemeral port, the runner booted
 * programmatically with a scripted model, an in-process HTTP fixture origin,
 * and a simulated desktop speaking the HTTP routes and the hub with real keys.
 *
 * In order: sign up → enroll a desktop → password wrappers for `work` and
 * `__workspace__` (opened by a second device before it enrolls) → cloud
 * enable (the runner provisions its device) → device-x25519 wrappers to the
 * cloud device → desktop engine over `WsTransport` seeds a cookie for the
 * fixture origin → a run whose start page echoes that cookie → the fixture's
 * own cookie flows back to the desktop, the cloud's exclusive lease defers a
 * desktop write → live view frames for the desktop token (bootstrap refused)
 * → completion: SSE from `run.created`, sealed content opens with the Space
 * keys, the deferred write drains → revoking the cloud device tears the
 * runner's identity down and re-enabling mints a new one.
 *
 * Gated on Chromium (`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` or the registry).
 * No egress gateway: the runner runs `egressMode: 'direct'`.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModel } from "ai";
import type { RunContentEvent, RunSummary, StoredRunEvent, ThreadListItem } from "@pistachio/protocol";
import {
  computeOriginIdHex,
  deriveSpaceKeys,
  toBase64,
  fromBase64,
  generateSpaceRootSecret,
  wrapRootSecretToDevice,
  type SpaceKeys,
} from "@pistachio/sync-protocol";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { ShellSnapshot } from "@pistachio/shell-contracts/ipc";
import { silentLogger } from "../../src/logger.js";
import { createRunner, type Runner } from "../../src/runner.js";
import { openRunEvent } from "../../src/runs/events.js";
import type { ModelFactory } from "../../src/runs/executor.js";
import { answer, gate, scriptedModel, toolCalls, type ScriptStep } from "../../src/testing/scripted-model.js";
import { CHROMIUM, describeChromium } from "../helpers/chromium.js";
import { bootControl, type BootedControl } from "../helpers/control-boot.js";
import {
  ControlApi,
  DesktopPeer,
  enrollDesktop,
  loopbackCookieIdentity,
  openLiveView,
  openPasswordWrapper,
  openShellSocket,
  PASSWORD,
  passwordLogin,
  passwordWrapper,
  registryVerifier,
  sessionCookieAttributes,
  signup,
  subscribeRunEvents,
  type Account,
  type Desktop,
  type ShellSocket,
  type SseSubscription,
} from "../helpers/desktop.js";
import { must, settle, startFixture, type FixtureServer } from "../helpers/fixture-server.js";

const SERVICE_TOKEN = "svc-token-for-e2e";
const SPACE = "work";
const WORKSPACE = "__workspace__";
const SEEDED_COOKIE = "seeded=from-desktop";
const FIXTURE_COOKIE = "fromfixture=hello";
const TYPED = "typed by the cloud";
const INTENT = "Read the fixture page and leave a note";
const FINAL_ANSWER = "The fixture page shows the seeded cookie and the note is written.";

interface ControlDeviceRow {
  id: string;
  name: string;
  platform: string;
  devicePublicKey: string;
  agreementPublicKey: string;
  revokedAt: string | null;
}

interface WrapperRow {
  spaceId: string;
  kind: string;
  credentialId: string;
  salt: string;
  wrapped: string;
  senderDeviceId: string | null;
  signature: string | null;
}

interface FixtureHit {
  path: string;
  cookie: string | null;
}

type ToolDetail = Extract<RunContentEvent, { t: "tool.detail" }>;
type MessageEvent = Extract<RunContentEvent, { t: "message" }>;

function escapeHtml(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

/** The fixture page: echoes the request's cookies into the body and offers one text input. */
function fixtureHtml(cookie: string | null): string {
  return [
    "<!doctype html><html><head><title>Cloud fixture</title></head><body>",
    "<h1>Cloud fixture</h1>",
    `<p id="cookies">cookies: ${escapeHtml(cookie ?? "(none)")}</p>`,
    '<form><label for="note">Note</label> <input id="note" name="note" type="text" autofocus></form>',
    // Focused on load so a forwarded keystroke has somewhere to land (§8).
    '<script>document.getElementById("note").focus();</script>',
    "</body></html>",
  ].join("");
}

/** The fixture's input, read through the session's own CDP guard session. */
async function noteValue(session: { host: { guardSessionFor(tabId: string): unknown } }, tabId: string): Promise<string> {
  const cdp = session.host.guardSessionFor(tabId) as { send(method: string, params: unknown): Promise<unknown> } | null;
  if (cdp === null) return "";
  const result = (await cdp.send("Runtime.evaluate", {
    expression: "document.getElementById('note') ? document.getElementById('note').value : ''",
    returnByValue: true,
  })) as { result: { value: string } };
  return result.result.value;
}

describeChromium("cloud run end to end", () => {
  let booted: BootedControl;
  let api: ControlApi;
  let fixture: FixtureServer;
  let runner: Runner;
  let stateDir: string;
  const hits: FixtureHit[] = [];
  /** Scripts by run id, read lazily on every model call (a run is claimed before its script can be registered). */
  const scripts = new Map<string, ScriptStep[]>();
  const gates = new Map<string, ReturnType<typeof gate>>();

  // Flow state, filled in step by step.
  let account: Account;
  let desktop: Desktop;
  let observerBootstrap: string;
  const secrets = new Map<string, Uint8Array>();
  let keys: SpaceKeys;
  let cloud: ControlDeviceRow;
  let peerA: DesktopPeer;
  let peerB: DesktopPeer;
  let runId: string;
  let held: ReturnType<typeof gate>;
  let sse: SseSubscription;
  let originId: string;
  let shell: ShellSocket | null = null;

  const deviceJsonPath = (): string => join(stateDir, account.userId, "device.json");

  const putWrappers = async (spaceId: string, wrappers: unknown[], token: string): Promise<WrapperRow[]> => {
    const out = await api.call(`/spaces/${spaceId}/wrappers`, { method: "PUT", token, body: { wrappers } });
    expect(out.status).toBe(200);
    return out.json["wrappers"] as WrapperRow[];
  };

  const runRecord = async (): Promise<{ run: { status: string; executor: unknown }; summary: ThreadListItem }> => {
    const out = await api.call(`/runs/${runId}`, { token: desktop.token });
    expect(out.status).toBe(200);
    return out.json as unknown as { run: { status: string; executor: unknown }; summary: ThreadListItem };
  };

  /** The run's first tab, read when the model step executes (never invented up front). */
  const tabIdFor = (id: string): string => must(must(runner.executor.runFor(id), "an active run").tabs()[0], "a tab").id;

  beforeAll(async () => {
    booted = await bootControl({ serviceToken: SERVICE_TOKEN });
    api = new ControlApi(booted.url);
    fixture = await startFixture((request, response) => {
      const path = request.url ?? "/";
      if (path !== "/") {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("not found");
        return;
      }
      const cookie = typeof request.headers.cookie === "string" ? request.headers.cookie : null;
      hits.push({ path, cookie });
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": `${FIXTURE_COOKIE}; Path=/`,
      });
      response.end(fixtureHtml(cookie));
    });
    stateDir = await mkdtemp(join(tmpdir(), "cloud-browser-e2e-"));
    const modelFactory: ModelFactory = ({ runId: id }) => ({
      model: scriptedModel([], (options) => {
        const step = scripts.get(id)?.shift() ?? gates.get(id)?.step;
        if (step === undefined) throw new Error(`no script registered for run ${id}`);
        return step(options);
      }) as unknown as LanguageModel,
      modelName: "scripted",
    });
    runner = createRunner({
      controlUrl: booted.url,
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
    const { url } = await runner.start();
    booted.bindRunner(url);
  });

  afterAll(async () => {
    for (const waiting of gates.values()) waiting.release();
    shell?.ws.close();
    await sse?.close();
    peerA?.stop();
    peerB?.stop();
    await runner.stop();
    await booted.close();
    await fixture.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  it("signs up, enrolls a desktop with real keys, and uploads password wrappers a second device can open", async () => {
    account = await signup(api);
    desktop = await enrollDesktop(api, account.bootstrapToken);
    const me = await api.call("/me", { token: desktop.token });
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({ userId: account.userId, email: account.email, egress: null });
    expect(me.json["features"]).toEqual(expect.arrayContaining(["sync", "cloud-browser"]));
    expect(me.json["hubUrl"]).toBe(booted.hubUrl);
    const spaces = (await api.call("/spaces", { token: desktop.token })).json["spaces"] as Array<{ id: string }>;
    expect(spaces.map((space) => space.id)).toEqual([SPACE]);

    // First enroll (§10.1): a root secret per Space, wrapped under the password KEK.
    for (const spaceId of [SPACE, WORKSPACE]) {
      const secret = generateSpaceRootSecret();
      secrets.set(spaceId, secret);
      const wrapper = await passwordWrapper(secret, spaceId, PASSWORD);
      const stored = await putWrappers(spaceId, [wrapper], desktop.token);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ spaceId, kind: "password", credentialId: "password", senderDeviceId: null, signature: null });
    }
    keys = await deriveSpaceKeys(SPACE, must(secrets.get(SPACE)));

    // A second device signs in and, still on its bootstrap token, opens the wrappers before enrolling.
    observerBootstrap = await passwordLogin(api, account.email);
    const listed = await api.call(`/spaces/${SPACE}/wrappers`, { token: observerBootstrap });
    expect(listed.status).toBe(200);
    const row = (listed.json["wrappers"] as WrapperRow[]).find((wrapper) => wrapper.kind === "password");
    const recovered = await openPasswordWrapper(must(row, "the password wrapper"), SPACE, PASSWORD);
    expect(recovered).toEqual(must(secrets.get(SPACE)));
    await expect(openPasswordWrapper(must(row), SPACE, "wrong-password")).rejects.toThrow();
    // The bootstrap token cannot reach device-only routes.
    expect((await api.call("/runs", { token: observerBootstrap, body: { spaceId: SPACE, intent: "nope" } })).status).toBe(403);
  });

  it("enables the cloud: the runner provisions its device and the desktop wraps both Space secrets to it", async () => {
    // Nothing is cloud-enabled until a device-x25519 wrapper names the live cloud device.
    expect((await api.call("/runs", { token: desktop.token, body: { spaceId: SPACE, intent: INTENT } })).json).toEqual({
      error: "space_not_cloud_enabled",
    });

    const enabled = await api.call("/cloud/enable", { token: desktop.token, body: { spaceId: SPACE } });
    expect(enabled.status).toBe(200);
    cloud = enabled.json["device"] as ControlDeviceRow;
    expect(cloud.platform).toBe("cloud");
    expect(cloud.revokedAt).toBeNull();
    expect(fromBase64(cloud.agreementPublicKey)).toHaveLength(32);
    expect(fromBase64(cloud.devicePublicKey)).toHaveLength(32);
    // Push-driven provisioning (§8.2): the runner holds exactly this identity on disk.
    const identity = must(await runner.identity.identityFor(account.userId), "the runner's stored identity");
    expect(identity.deviceId).toBe(cloud.id);
    expect(identity.agreementPublicKey).toBe(cloud.agreementPublicKey);
    expect(identity.devicePublicKey).toBe(cloud.devicePublicKey);
    expect(existsSync(deviceJsonPath())).toBe(true);
    const devices = (await api.call("/devices", { token: desktop.token })).json["devices"] as ControlDeviceRow[];
    expect(devices.map((row) => row.platform).sort()).toEqual(["cloud", "macos"]);

    // The desktop pins the cloud device and wraps `work` and `__workspace__` to it (sender-signed, §2/§10.1).
    for (const spaceId of [SPACE, WORKSPACE]) {
      const wrapper = await wrapRootSecretToDevice(
        must(secrets.get(spaceId)),
        spaceId,
        { deviceId: cloud.id, agreementPublicKeyRaw: fromBase64(cloud.agreementPublicKey) },
        { deviceId: desktop.deviceId, signingKey: desktop.signing.privateKey },
      );
      const stored = await putWrappers(
        spaceId,
        [
          {
            kind: wrapper.kind,
            credentialId: wrapper.credentialId,
            salt: wrapper.salt,
            wrapped: wrapper.wrapped,
            senderDeviceId: wrapper.senderDeviceId,
            signature: wrapper.signature,
          },
        ],
        desktop.token,
      );
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        spaceId,
        kind: "device-x25519",
        credentialId: cloud.id,
        senderDeviceId: desktop.deviceId,
        signature: wrapper.signature,
      });
      const listed = (await api.call(`/spaces/${spaceId}/wrappers`, { token: desktop.token })).json["wrappers"] as WrapperRow[];
      expect(listed.map((row) => row.kind).sort()).toEqual(["device-x25519", "password"]);
    }
    // The cloud device reads only its own wrappers.
    const cloudToken = await runner.identity.tokenFor(account.userId);
    const cloudView = (await api.call(`/spaces/${SPACE}/wrappers`, { token: cloudToken })).json["wrappers"] as WrapperRow[];
    expect(cloudView.map((row) => [row.kind, row.credentialId])).toEqual([["device-x25519", cloud.id]]);
  });

  it("connects desktop engines over the hub and seeds a cookie for the fixture origin", async () => {
    // A second desktop watches the Space; both verifiers know the cloud device.
    const observer = await enrollDesktop(api, observerBootstrap, "Observer");
    const verifierA = await registryVerifier(api, desktop.token);
    const verifierB = await registryVerifier(api, observer.token);
    for (const verifier of [verifierA, verifierB]) {
      expect(verifier.hasDevice(cloud.id)).toBe(true);
      expect(verifier.hasDevice(desktop.deviceId)).toBe(true);
    }
    peerA = new DesktopPeer({ hubUrl: booted.hubUrl, spaceId: SPACE, keys, desktop, verifier: verifierA });
    peerB = new DesktopPeer({ hubUrl: booted.hubUrl, spaceId: SPACE, keys, desktop: observer, verifier: verifierB });
    await peerA.connect();
    await peerB.connect();
    expect(peerA.states).toContain("connected");

    const wire = await peerA.engine.localChange(
      loopbackCookieIdentity(SPACE, fixture.host, "seeded"),
      sessionCookieAttributes("from-desktop"),
      false,
      "explicit",
    );
    expect(wire).not.toBeNull();
    expect(wire?.hlc.deviceId).toBe(desktop.deviceId);
    // The observer applies it, so the hub holds the record before the cloud hydrates.
    await settle(() => peerB.applier.has("seeded", "from-desktop"));
    expect(peerA.applier.applied).toHaveLength(0);
    originId = await computeOriginIdHex(keys.idKey, SPACE, fixture.host);
  });

  it("the runner claims the run, hydrates the seeded cookie into Chromium, and the fixture page sees it", async () => {
    held = gate();
    const created = await api.call("/runs", {
      token: desktop.token,
      body: { spaceId: SPACE, intent: INTENT, startUrl: `${fixture.origin}/` },
    });
    expect(created.status).toBe(201);
    runId = created.json["runId"] as string;
    gates.set(runId, held);
    // The gate holds the agent at its first model call; releasing it runs page_inspect, then page_type, then the answer.
    scripts.set(runId, [
      held.step,
      (options) => toolCalls({ name: "page_type", input: { tabId: tabIdFor(runId), target: "#note", value: TYPED } })(options),
      answer(FINAL_ANSWER),
    ]);
    sse = await subscribeRunEvents(booted.url, runId, desktop.token);

    await settle(() => held.waiting, { turns: 1200 });
    // Claimed by this worker under the live cloud device.
    const claimed = await runRecord();
    expect(claimed.run.status).toBe("running");
    expect(claimed.run.executor).toEqual({ kind: "cloud", deviceId: cloud.id, workerId: runner.workerId });
    expect(claimed.summary.status).toBe("running");
    const active = must(runner.executor.runFor(runId), "the active run");
    expect(active.userId).toBe(account.userId);
    // A real sync device: hello {kind:'cloud'} over the real hub, hydrated before the first navigation.
    const user = must(runner.sessions.users.get(account.userId), "the runner's user session");
    expect(user.deviceId).toBe(cloud.id);
    expect(user.transport.state).toBe("connected");
    const space = must(user.spaces.get(SPACE), "the space session");
    expect(space.hasHydratedOnce).toBe(true);
    expect(space.activeRuns).toBe(1);
    expect(space.renewing).toBe(true);
    // The start tab is the fixture, and the page request carried the desktop's cookie.
    expect(active.tabs().map((tab) => tab.url)).toEqual([`${fixture.origin}/`]);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]?.cookie).toBe(SEEDED_COOKIE);
    // The event stream already starts with control's projection.
    await settle(() => sse.events.length >= 3);
    expect(sse.events[0]?.event.t).toBe("run.created");
    expect(sse.events.map((event) => event.event.t).slice(0, 3)).toEqual(["run.created", "status", "control"]);
  });

  it("a cookie set by the fixture reaches the desktops through the hub and the cloud's exclusive lease defers a desktop write", async () => {
    // The fixture's Set-Cookie: captured by the cloud (raw CDP jar diff), leased exclusively, published.
    await settle(() => peerA.applier.has("fromfixture", "hello") && peerB.applier.has("fromfixture", "hello"), { turns: 400 });
    const applied = must(peerA.applier.find("fromfixture"), "the fixture cookie on the desktop");
    expect(applied.identity).toMatchObject({ spaceId: SPACE, hostKey: fixture.host, path: "/", sourceScheme: "nonsecure", partitionKey: "" });
    expect(applied.attributes).toMatchObject({ value: "hello", secure: false, httpOnly: false, sameSite: "unspecified", expiresMs: null });
    expect(applied.deleted).toBe(false);

    // A desktop write on that origin now parks behind the cloud's exclusive lease (D10) instead of forcing a takeover.
    const seenByB = peerB.applier.applied.length;
    const wire = await peerA.engine.localChange(
      loopbackCookieIdentity(SPACE, fixture.host, "blocked"),
      sessionCookieAttributes("deferred-1"),
      false,
      "explicit",
    );
    expect(wire).not.toBeNull();
    await settle(() => peerA.engine.deferredDepth === 1, { turns: 400 });
    expect(peerA.engine.queueDepth).toBe(0);
    expect(peerB.applier.applied.length).toBe(seenByB);
    expect(peerB.applier.has("blocked")).toBe(false);
    expect(peerA.released).not.toContain(originId);
  });

  it("the live view streams frames to a ticket holder that proves the Space key, and to nobody else", async () => {
    expect(held.waiting).toBe(true);
    const ticketFor = async (token: string): Promise<{ status: number; ticket: string }> => {
      const res = await api.call(`/runs/${runId}/live-ticket`, { method: "POST", token, body: {} });
      return { status: res.status, ticket: (res.json["ticket"] as string | undefined) ?? "" };
    };
    // Who may watch is settled by control, when it issues the ticket (§8.5).
    expect((await ticketFor(account.bootstrapToken)).status).toBe(403);
    const cloudToken = await runner.identity.tokenFor(account.userId);
    expect((await ticketFor(cloudToken)).status).toBe(403);
    // The socket itself takes a ticket and nothing else — not a device token.
    expect((await openLiveView(must(runner.port), runId, desktop.token)).status).toBe(401);
    expect((await openLiveView(must(runner.port), runId, "not-a-ticket")).status).toBe(401);

    // A viewer that cannot answer the Space-key challenge is closed on it.
    const unproven = await openLiveView(must(runner.port), runId, (await ticketFor(desktop.token)).ticket);
    expect(unproven.status).toBeNull();
    unproven.ws.send(JSON.stringify({ t: "auth", proof: toBase64(new Uint8Array([1, 2, 3])) }));
    expect(await unproven.closed).toBe(4004);

    const live = await openLiveView(must(runner.port), runId, (await ticketFor(desktop.token)).ticket, keys.sealKey);
    expect(live.status).toBeNull();
    await settle(() => live.frames.some((frame) => frame["t"] === "frame"), { turns: 400 });
    expect(live.frames[0]).toEqual({ t: "status", status: "running", control: "agent" });
    const tabs = live.frames.find((frame) => frame["t"] === "tabs") as { tabs: Array<{ url: string; kind: string }>; activeTabId: string } | undefined;
    expect(tabs?.tabs.map((tab) => tab.url)).toEqual([`${fixture.origin}/`]);
    expect(tabs?.activeTabId).toBe(tabIdFor(runId));
    const frame = live.frames.find((candidate) => candidate["t"] === "frame") as
      | { data: string; width: number; height: number; metadata: { deviceWidth: number; deviceHeight: number } }
      | undefined;
    expect(Buffer.from(must(frame).data, "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); // JPEG
    expect(must(frame).width).toBeGreaterThan(0);
    expect(must(frame).height).toBeGreaterThan(0);
    expect(must(frame).metadata).toMatchObject({ deviceWidth: 1280, deviceHeight: 800 });
    live.ws.close();
    await live.closed;
  });

  it("completes: events over SSE from run.created, sealed content opens with the Space keys, the deferred write publishes", async () => {
    // Release the gate with the inspection; page_type and the answer follow from the script.
    held.release((options) => toolCalls({ name: "page_inspect", input: { tabId: tabIdFor(runId) } })(options));
    await settle(() => runner.executor.active.size === 0, { turns: 1200 });
    let ended: string | null = null;
    void sse.end.then((status) => {
      ended = status;
    });
    await settle(() => ended !== null, { turns: 400 });
    expect(ended).toBe("completed");
    const record = await runRecord();
    expect(record.run.status).toBe("completed");
    expect(record.summary.status).toBe("completed");
    expect(record.summary.turns).toBe(1);

    const events: StoredRunEvent[] = sse.events;
    expect(events.map((event) => event.seq)).toEqual(events.map((_event, index) => index + 1));
    const kinds = events.map((event) => event.event.t);
    expect(kinds.slice(0, 3)).toEqual(["run.created", "status", "control"]);
    expect(kinds.filter((kind) => kind === "tool.started")).toHaveLength(2);
    expect(kinds.filter((kind) => kind === "tool.completed")).toHaveLength(2);
    expect(kinds).not.toContain("tool.failed");
    expect(kinds.slice(-2)).toEqual(["status", "done"]);
    expect(events.at(-2)?.event).toMatchObject({ t: "status", status: "completed" });
    expect(events.at(-1)?.event).toEqual({ t: "done", ok: true });
    const started = events.map((event) => event.event).filter((event) => event.t === "tool.started");
    expect(started.map((event) => (event as { name: string }).name)).toEqual(["page.inspect", "page.type"]);
    // Control holds no plaintext content (D25).
    const wire = JSON.stringify(events);
    for (const secret of [SEEDED_COOKIE, TYPED, "Cloud fixture", FINAL_ANSWER, '"role":']) expect(wire).not.toContain(secret);

    const opened: RunContentEvent[] = [];
    for (const event of events) {
      if (event.event.t === "sealed") opened.push(await openRunEvent(keys.sealKey, runId, event));
    }
    const details = opened.filter((event): event is ToolDetail => event.t === "tool.detail");
    const inspection = details
      .map((detail) => detail.data as { title?: string; url?: string; text?: string; controls?: Array<{ selector: string }> } | undefined)
      .find((data) => typeof data?.text === "string");
    expect(inspection?.title).toBe("Cloud fixture");
    expect(inspection?.url).toBe(`${fixture.origin}/`);
    expect(inspection?.text).toContain(SEEDED_COOKIE);
    expect(inspection?.controls?.some((control) => control.selector.includes("note"))).toBe(true);
    const typed = details.map((detail) => detail.data as { value?: string } | undefined).find((data) => typeof data?.value === "string");
    expect(typed?.value).toBe(TYPED);
    const messages = opened.filter((event): event is MessageEvent => event.t === "message");
    expect(messages.map((event) => [event.message.role, event.message.content])).toEqual([
      ["user", INTENT],
      ["assistant", FINAL_ANSWER],
    ]);
    expect(opened.some((event) => event.t === "result")).toBe(true);
    // Another Space's keys open nothing.
    const foreign = await deriveSpaceKeys(SPACE, generateSpaceRootSecret());
    const sealed = must(events.find((event) => event.event.t === "sealed"), "a sealed event");
    await expect(openRunEvent(foreign.sealKey, runId, sealed)).rejects.toThrow();

    // The run ended: the cloud released its leases, the desktop's deferred write drained and published.
    await settle(() => peerA.released.includes(originId), { turns: 400 });
    await settle(() => peerA.engine.deferredDepth === 0, { turns: 400 });
    await settle(() => peerB.applier.has("blocked", "deferred-1"), { turns: 400 });
    const space = must(runner.sessions.users.get(account.userId)?.spaces.get(SPACE), "the space session");
    expect(space.activeRuns).toBe(0);
    expect(space.renewing).toBe(false);
  });

  it("runs the agent inside a browser session: the shell starts it, the person takes the wheel and gives it back (§8)", async () => {
    // The session: created by the person's device, claimed on demand by
    // whichever worker the ticket lands on (§6.4).
    const opened = await api.call("/browser-sessions", { token: desktop.token, body: { spaceId: SPACE } });
    expect(opened.status).toBe(201);
    const sessionId = (opened.json["session"] as { id: string }).id;
    const ticketed = await api.call(`/browser-sessions/${sessionId}/ticket`, {
      method: "POST",
      token: desktop.token,
      body: {},
    });
    expect(ticketed.status).toBe(200);
    shell = await openShellSocket(must(runner.port), sessionId, ticketed.json["ticket"] as string, keys.sealKey);
    expect(shell.status).toBeNull();
    const held = must(runner.browserSessions.get(sessionId), "the claimed browser session");

    // This suite's Space context is still warm from the first run, so its
    // agent tab is still open in it. Start the session from a clean strip.
    const initial = (await shell.call("getSnapshot")) as ShellSnapshot;
    for (const tab of initial.tabs) await shell.call("closeTab", [tab.id]);
    await shell.call("createTab", [`${fixture.origin}/`]);
    const withTab = (await shell.call("getSnapshot")) as ShellSnapshot;
    expect(withTab.tabs).toHaveLength(1);
    const tabId = must(withTab.tabs[0], "the session's tab").id;
    expect(withTab.tabs[0]).toMatchObject({ kind: "human", url: `${fixture.origin}/` });

    // The console starts a run ON the session: no start page, so it acts in
    // the tab the person already has open.
    const sessionGate = gate();
    const started = (await shell.call("startCloudRun", [{ intent: "Finish the note" }])) as { runId: string };
    const sessionRunId = started.runId;
    gates.set(sessionRunId, sessionGate);
    scripts.set(sessionRunId, [
      sessionGate.step,
      (options) =>
        toolCalls({
          name: "page_type",
          input: { tabId: tabIdFor(sessionRunId), target: "#note", value: "the agent finished it" },
        })(options),
      answer("The note is written."),
    ]);
    await settle(() => sessionGate.waiting, { turns: 1200 });

    // The run is this worker's, on this session's Chromium, in this session's
    // tab: it opened none of its own.
    const active = must(runner.executor.runFor(sessionRunId), "the session's active run");
    expect(active.tabs().map((tab) => tab.url)).toEqual([`${fixture.origin}/`]);
    expect(active.tabs().map((tab) => tab.kind)).toEqual(["human"]);
    expect(held.activeRunId).toBe(sessionRunId);
    // The claim moved the fence to the agent, and the console has the run.
    expect(held.control.holder).toBe("agent");
    const agentGeneration = held.control.generation;
    await settle(() => (must(shell).of("control").at(-1)?.["holder"] ?? null) === "agent", { turns: 400 });
    const acting = (await shell.call("getSnapshot")) as ShellSnapshot;
    expect(acting.run?.runId).toBe(sessionRunId);
    expect(acting.threads.map((item: ThreadListItem) => item.runId)).toContain(sessionRunId);

    // The person takes the wheel. Control's `interrupt` IS the takeover, and
    // the generation it answers with is what input is accepted under (W7).
    await shell.call("takeControl");
    await settle(() => held.control.holder === "human", { turns: 400 });
    const humanGeneration = held.control.generation;
    expect(humanGeneration).toBe(agentGeneration + 1);
    await settle(() => (must(shell).of("control").at(-1)?.["generation"] ?? -1) === humanGeneration, { turns: 400 });

    // Input flows: keystrokes into the focused field of the session's tab.
    const typed = "typed by the person";
    for (const character of typed) {
      must(shell).input(tabId, humanGeneration, {
        kind: "key",
        type: "keyDown",
        key: character,
        code: character === " " ? "Space" : `Key${character.toUpperCase()}`,
        text: character,
        modifiers: 0,
      });
      must(shell).input(tabId, humanGeneration, {
        kind: "key",
        type: "keyUp",
        key: character,
        code: character === " " ? "Space" : `Key${character.toUpperCase()}`,
        modifiers: 0,
      });
    }
    let field = "";
    for (let turn = 0; turn < 200 && field !== typed; turn += 1) {
      field = await noteValue(held, tabId);
      if (field !== typed) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(field).toBe(typed);
    // A keystroke under the fence the agent held is dropped, not replayed.
    const droppedBefore = held.droppedInput;
    must(shell).input(tabId, agentGeneration, {
      kind: "key",
      type: "keyDown",
      key: "z",
      code: "KeyZ",
      text: "z",
      modifiers: 0,
    });
    await settle(() => held.droppedInput === droppedBefore + 1, { turns: 400 });
    expect(await noteValue(held, tabId)).toBe(typed);

    // Giving it back: the model's next step runs, and it runs in the very tab
    // the person was just typing in (`page_type` replaces what is there).
    await shell.call("releaseControl");
    await settle(() => held.control.holder === "agent", { turns: 400 });
    expect(held.control.generation).toBe(humanGeneration + 1);
    await settle(() => runner.executor.active.size === 0, { turns: 2000 });
    expect(await noteValue(held, tabId)).toBe("the agent finished it");

    // The run ended; the session did not. The tab is still the person's, the
    // wheel is back with them, and the conversation is in the thread list.
    const after = (await shell.call("getSnapshot")) as ShellSnapshot;
    expect(after.tabs.map((tab) => tab.id)).toEqual([tabId]);
    expect(after.tabs[0]).toMatchObject({ kind: "human", url: `${fixture.origin}/` });
    expect(runner.browserSessions.get(sessionId)).not.toBeNull();
    await settle(() => held.control.holder === "human", { turns: 800 });
    const finished = (await shell.call("getSnapshot")) as ShellSnapshot;
    const run = finished.run as RunSummary;
    expect(run.runId).toBe(sessionRunId);
    expect(run.status).toBe("completed");
    expect(finished.threads.map((item: ThreadListItem) => item.runId)).toContain(sessionRunId);

    // Control agrees, and the run is recorded against the session.
    const record = await api.call(`/runs/${sessionRunId}`, { token: desktop.token });
    expect((record.json["run"] as { status: string; sessionId: string }).status).toBe("completed");
    expect((record.json["run"] as { sessionId: string }).sessionId).toBe(sessionId);

    shell.ws.close();
    await shell.closed;
    shell = null;
  });

  it("revoking the cloud device after the run tears the runner's identity down and re-enabling mints a new device", async () => {
    const revoked = await api.call(`/devices/${cloud.id}/revoke`, { token: desktop.token, body: {} });
    expect(revoked.status).toBe(200);
    expect(revoked.json).toMatchObject({ revoked: true });
    await settle(() => !existsSync(deviceJsonPath()), { turns: 400 });
    await settle(() => !runner.sessions.users.has(account.userId), { turns: 400 });
    expect(await runner.identity.identityFor(account.userId)).toBeNull();
    expect(runner.executor.active.size).toBe(0);
    const devices = (await api.call("/devices", { token: desktop.token })).json["devices"] as ControlDeviceRow[];
    expect(devices.find((row) => row.id === cloud.id)?.revokedAt).not.toBeNull();
    // The wrappers went with the device: the Space is no longer cloud-enabled.
    expect((await api.call("/runs", { token: desktop.token, body: { spaceId: SPACE, intent: INTENT } })).json).toEqual({
      error: "space_not_cloud_enabled",
    });
    // The desktops were not touched.
    expect(peerA.transport.state).toBe("connected");
    expect(peerA.revoked).toBe(false);

    const again = await api.call("/cloud/enable", { token: desktop.token, body: { spaceId: SPACE } });
    expect(again.status).toBe(200);
    const fresh = again.json["device"] as ControlDeviceRow;
    expect(fresh.id).not.toBe(cloud.id);
    expect(fresh.platform).toBe("cloud");
    expect(fresh.agreementPublicKey).not.toBe(cloud.agreementPublicKey);
    expect((await runner.identity.identityFor(account.userId))?.deviceId).toBe(fresh.id);
    expect(existsSync(deviceJsonPath())).toBe(true);
  });
});
