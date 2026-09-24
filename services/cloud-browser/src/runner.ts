/**
 * The composition root: `createRunner` wires the control client, the device
 * identity service, Chromium, sessions, the claim loop, the executor, the
 * live view, and the HTTP app into one object that `server.ts` starts and
 * integration tests boot in-process against a fake control plane.
 */

import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getRequestListener } from "@hono/node-server";
import { createGateway, type LanguageModel } from "ai";
import type { Hono } from "hono";
import type { AgentRunPolicy, ContextBudget } from "@pistachio/agent-runtime";
import { gatewayPrivacyFetch } from "@pistachio/runtime";
import type { Browser } from "playwright-core";
import { createCloudBrowserApp, type SteerBody } from "./app.js";
import { DEFAULT_BROWSER_SESSION_IDLE_MS, DEFAULT_WEB_URL } from "./config.js";
import { SafeBrowserNetworkPolicy, type BrowserNetworkPolicy } from "./browser/network-policy.js";
import { PlaywrightBrowserRuntime } from "./browser/runtime.js";
import { ControlClient } from "./control-client.js";
import { DeviceStore } from "./identity/device-store.js";
import { DeviceIdentityService, type ProvisionResult } from "./identity/provision.js";
import { LiveViewServer } from "./live/server.js";
import { consoleLogger, errorMessage, type Logger } from "./logger.js";
import { RunClaimer } from "./runs/claimer.js";
import { RunExecutor, type ModelFactory } from "./runs/executor.js";
import { IMessageThreadRouter } from "./runs/imessage-router.js";
import { SessionRegistry } from "./sessions/session-registry.js";
import type { IntentModelFactory } from "./sessions/shell-host.js";
import { ShellSocketServer } from "./sessions/shell-server.js";
import { SessionManager, type TransportFactory } from "./sync/session-manager.js";

export interface CreateRunnerOptions {
  controlUrl: string;
  serviceToken: string;
  stateDir: string;
  /** 32 raw bytes, or base64/hex of them. */
  stateKey: Uint8Array | string;
  chromiumPath?: string;
  /** Builds the agent's model per run. Defaults to the AI Gateway model named by `agentModel`. */
  modelFactory?: ModelFactory;
  /** `AI_GATEWAY_API_KEY` and `PISTACHIO_AGENT_MODEL` for the default model factory. */
  aiGatewayApiKey?: string;
  agentModel?: string;
  /**
   * `PISTACHIO_INTENT_MODEL`: the evaluation model a session's address bar
   * asks what typed prose means (docs/smart-suggestions.md). Null, or no
   * gateway key, and every session answers `rankAddressIntent` with null.
   */
  intentModel?: string | null;
  /** Overrides the gateway-backed intent model; for tests with no key. */
  intentModelFactory?: IntentModelFactory | null;
  ports?: { http?: number };
  host?: string;
  publicUrl?: string | null;
  /** This worker's address on the private network, for the in-fleet live hop (§8.5). */
  internalUrl?: string | null;
  /** `www`: the origin used in artifact tool results and credential-capture links (§15). */
  artifactWebUrl?: string;
  /**
   * The browser app's origin (§15). The shell socket and its download route
   * accept this one and no other; the live view accepts it alongside `www`.
   */
  browserUrl?: string;
  workerId?: string;
  fetch?: typeof fetch;
  /** Exact origins exempt from the SSRF policy (local fixtures in tests). */
  allowedOrigins?: string[];
  policy?: BrowserNetworkPolicy;
  egressScheme?: "https" | "http";
  /** `gateway` (default, fail closed) or `direct` (no proxy; dev without a gateway, tests). */
  egressMode?: "gateway" | "direct";
  transportFactory?: TransportFactory;
  launch?: () => Promise<Browser>;
  headless?: boolean;
  claimIntervalMs?: number;
  leaseMs?: number;
  maxConcurrentRuns?: number;
  sessionIdleMs?: number;
  /** `CLOUD_BROWSER_SESSION_IDLE_MS` (§6.4): how long a viewerless session stays claimed. */
  browserSessionIdleMs?: number;
  /** Test seam for the session heartbeat cadence (default `SESSION_LEASE_MS / 3`). */
  sessionHeartbeatMs?: number;
  /** Test seam for the sealed session record's write debounce (§9). */
  sessionStateDebounceMs?: number;
  shellRecheckIntervalMs?: number;
  renewIntervalMs?: number;
  hydrationTimeoutMs?: number;
  liveRecheckIntervalMs?: number;
  commandWaitSeconds?: number;
  commandRetryDelayMs?: number;
  defaultStartUrl?: string;
  runPolicy?: AgentRunPolicy;
  budget?: ContextBudget;
  eventFlushDelayMs?: number;
  threadFlushMs?: number;
  now?: () => number;
  log?: Logger;
}

export interface Runner {
  readonly app: Hono;
  readonly control: ControlClient;
  readonly identity: DeviceIdentityService;
  readonly runtime: PlaywrightBrowserRuntime;
  readonly sessions: SessionManager;
  readonly executor: RunExecutor;
  readonly imessageRouter: IMessageThreadRouter;
  readonly claimer: RunClaimer;
  readonly live: LiveViewServer;
  /** The browser sessions this worker holds (web-browser-design.md §6.4). */
  readonly browserSessions: SessionRegistry;
  readonly shell: ShellSocketServer;
  readonly workerId: string;
  /** Null until `start()` resolves. */
  readonly server: Server | null;
  readonly port: number | null;
  readonly url: string | null;
  start(): Promise<{ port: number; url: string }>;
  stop(): Promise<void>;
  provision(userId: string, nonce: string): Promise<ProvisionResult>;
  steer(body: SteerBody): Promise<void>;
}

/** `createGateway({apiKey}).evaluationModel(modelName)`, built once per worker. */
export function gatewayIntentModelFactory(options: { apiKey: string; modelName: string }): IntentModelFactory {
  const model = createGateway({ apiKey: options.apiKey, fetch: gatewayPrivacyFetch() }).evaluationModel(options.modelName);
  return () => model;
}

/** `createGateway({apiKey}).languageModel(modelName)` per run (§8.4). */
export function gatewayModelFactory(options: { apiKey: string; modelName: string }): ModelFactory {
  const gateway = createGateway({ apiKey: options.apiKey, fetch: gatewayPrivacyFetch() });
  return () => ({ model: gateway.languageModel(options.modelName) as LanguageModel, modelName: options.modelName });
}

export function createRunner(options: CreateRunnerOptions): Runner {
  const log = options.log ?? consoleLogger;
  const stateKey = typeof options.stateKey === "string" ? decodeKey(options.stateKey) : options.stateKey;
  const workerId = options.workerId ?? `cloud-browser:${randomUUID()}`;
  const control = new ControlClient({
    baseUrl: options.controlUrl,
    serviceToken: options.serviceToken,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const identity = new DeviceIdentityService({
    control,
    store: new DeviceStore(options.stateDir, stateKey),
    ...(options.now === undefined ? {} : { now: options.now }),
    log,
  });
  const egressMode = options.egressMode ?? "gateway";
  const runtime = new PlaywrightBrowserRuntime({
    proxyMode: egressMode === "direct" ? "direct" : "per-context",
    ...(options.chromiumPath === undefined ? {} : { executablePath: options.chromiumPath }),
    ...(options.launch === undefined ? {} : { launch: options.launch }),
    ...(options.headless === undefined ? {} : { headless: options.headless }),
  });
  const policy = options.policy ?? new SafeBrowserNetworkPolicy({ allowedOrigins: options.allowedOrigins ?? [] });
  let modelFactory = options.modelFactory;
  if (modelFactory === undefined) {
    if (options.aiGatewayApiKey === undefined || options.agentModel === undefined) {
      throw new Error("createRunner needs modelFactory or aiGatewayApiKey + agentModel");
    }
    modelFactory = gatewayModelFactory({ apiKey: options.aiGatewayApiKey, modelName: options.agentModel });
  }

  const sessions = new SessionManager({
    runtime,
    identity,
    control,
    policy,
    artifactWebUrl: options.artifactWebUrl ?? DEFAULT_WEB_URL,
    onRevoked: (userId) => {
      log.warn("hub closed the socket with 4003", { userId });
      void identity.revoke(userId).catch((error: unknown) => log.error("revocation teardown failed", { userId, error: errorMessage(error) }));
    },
    ...(options.transportFactory === undefined ? {} : { transportFactory: options.transportFactory }),
    ...(options.egressScheme === undefined ? {} : { egressScheme: options.egressScheme }),
    egressMode,
    ...(options.sessionIdleMs === undefined ? {} : { sessionIdleMs: options.sessionIdleMs }),
    ...(options.renewIntervalMs === undefined ? {} : { renewIntervalMs: options.renewIntervalMs }),
    ...(options.hydrationTimeoutMs === undefined ? {} : { hydrationTimeoutMs: options.hydrationTimeoutMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    log,
  });
  const executor = new RunExecutor({
    control,
    identity,
    sessions,
    // A run attached to a browser session acts in that session's tabs and
    // feeds its host (§8). The registry is built below, so this is read when
    // a run is claimed rather than now.
    browserSessions: () => browserSessions,
    modelFactory,
    workerId,
    log,
    webUrl: options.artifactWebUrl ?? DEFAULT_WEB_URL,
    // Not a link the executor builds — a site it refuses to type a password
    // into (§15). Both Pistachio origins, not just `www`.
    ...(options.browserUrl === undefined ? {} : { browserUrl: options.browserUrl }),
    ...(options.now === undefined ? {} : { now: (): Date => new Date(options.now?.() ?? Date.now()) }),
    ...(options.runPolicy === undefined ? {} : { policy: options.runPolicy }),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    ...(options.defaultStartUrl === undefined ? {} : { defaultStartUrl: options.defaultStartUrl }),
    ...(options.commandWaitSeconds === undefined ? {} : { commandWaitSeconds: options.commandWaitSeconds }),
    ...(options.commandRetryDelayMs === undefined ? {} : { commandRetryDelayMs: options.commandRetryDelayMs }),
    ...(options.threadFlushMs === undefined ? {} : { threadFlushMs: options.threadFlushMs }),
    ...(options.eventFlushDelayMs === undefined ? {} : { eventFlushDelayMs: options.eventFlushDelayMs }),
  });
  const imessageRouter = new IMessageThreadRouter({
    modelFactory,
    spaceKeyFor: async (userId, spaceId) => (await identity.spaceKeysFor(userId, spaceId)).sealKey,
  });
  const claimer = new RunClaimer({
    control,
    workerId,
    // How a SIBLING worker reaches this one. A live view can arrive at any
    // worker behind the shared address; whichever gets it hands the socket
    // here over the private network (§8.5).
    ...(options.internalUrl == null ? {} : { workerUrl: options.internalUrl }),
    execute: (claimed, lease) => executor.execute(claimed, lease),
    ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
    ...(options.claimIntervalMs === undefined ? {} : { claimIntervalMs: options.claimIntervalMs }),
    ...(options.maxConcurrentRuns === undefined ? {} : { maxConcurrent: options.maxConcurrentRuns }),
    log,
  });
  const live = new LiveViewServer({
    control,
    runs: { get: (runId) => executor.runFor(runId) },
    // A web page watches over the same socket the Mac does, so the two web
    // apps' origins are the ones a browser upgrade may carry (§8.5, §15).
    viewerOrigins: [options.artifactWebUrl, options.browserUrl],
    serviceToken: options.serviceToken,
    ...(options.liveRecheckIntervalMs === undefined ? {} : { recheckIntervalMs: options.liveRecheckIntervalMs }),
    log,
  });

  // Browser sessions (web-browser-design.md §6): claimed on demand when a
  // shell ticket lands here, heartbeated while held, suspended when the last
  // viewer has been gone for CLOUD_BROWSER_SESSION_IDLE_MS.
  const intentModel: IntentModelFactory | null =
    options.intentModelFactory ??
    (options.aiGatewayApiKey === undefined || options.intentModel == null || options.intentModel === ""
      ? null
      : gatewayIntentModelFactory({ apiKey: options.aiGatewayApiKey, modelName: options.intentModel }));
  const browserSessions = new SessionRegistry({
    control,
    sessions,
    workerId,
    ...(intentModel === null ? {} : { intentModel }),
    ...(options.internalUrl == null ? {} : { workerUrl: options.internalUrl }),
    keysFor: (userId, spaceId) => identity.spaceKeysFor(userId, spaceId),
    idleMs: options.browserSessionIdleMs ?? DEFAULT_BROWSER_SESSION_IDLE_MS,
    ...(options.sessionHeartbeatMs === undefined ? {} : { heartbeatMs: options.sessionHeartbeatMs }),
    ...(options.sessionStateDebounceMs === undefined ? {} : { stateDebounceMs: options.sessionStateDebounceMs }),
    stateDir: options.stateDir,
    chromeVersion: () => runtime.version(),
    ...(options.now === undefined ? {} : { now: options.now }),
    log,
  });
  const shell = new ShellSocketServer({
    control,
    registry: browserSessions,
    // Only the browser app drives a session: `www` has no shell on it (§15).
    ...(options.browserUrl === undefined ? {} : { browserUrl: options.browserUrl }),
    serviceToken: options.serviceToken,
    ...(options.shellRecheckIntervalMs === undefined ? {} : { recheckIntervalMs: options.shellRecheckIntervalMs }),
    log,
  });

  // Revocation teardown (§8.2): live sockets close `4003 revoked` first — a run
  // that ends before that would close them `1000 ended` — then active runs fail,
  // then leases + transport + contexts go; the identity service zeroizes secrets
  // and deletes device.json after the listeners.
  identity.onDeviceRevoked((userId) => {
    live.closeUser(userId);
    shell.closeUser(userId);
  });
  identity.onDeviceRevoked(async (userId) => {
    await browserSessions.closeUser(userId);
  });
  identity.onDeviceRevoked(async (userId) => {
    await executor.teardownUser(userId, "device_revoked");
  });
  identity.onDeviceRevoked(async (userId) => {
    await sessions.closeUser(userId);
  });

  const steer = async (body: SteerBody): Promise<void> => {
    if (body.kind === "device.revoked") {
      if (!(await identity.matchesStoredIdentity(body.userId, body.deviceId))) {
        log.warn("steer device.revoked for an unknown identity", { userId: body.userId, deviceId: body.deviceId });
        return;
      }
      await identity.revoke(body.userId);
      return;
    }
    if (body.kind === "session.ended") {
      await browserSessions.ended(body.sessionId);
      return;
    }
    if (!executor.command(body.runId, body.command)) {
      log.warn("steer run.command dropped", { runId: body.runId });
    }
  };
  const provision = (userId: string, nonce: string): Promise<ProvisionResult> => identity.provision(userId, nonce);
  const stopDisconnectWatch = runtime.onDisconnected(() => {
    log.error("chromium disconnected; failing the runs it was driving");
    void executor.failAll("browser_disconnected").catch((error: unknown) => {
      log.error("failing runs after a browser disconnect failed", { error: errorMessage(error) });
    });
  });
  const app = createCloudBrowserApp({
    serviceToken: options.serviceToken,
    provision,
    steer,
    routeIMessage: (input, signal) => imessageRouter.route(input, { signal }),
    health: () => {
      const connected = runtime.isConnected();
      return { browser: connected === null ? "not_started" : connected ? "connected" : "disconnected" };
    },
    log,
  });

  let server: Server | null = null;
  let port: number | null = null;
  let url: string | null = null;
  const host = options.host ?? "0.0.0.0";

  const runner: Runner = {
    app,
    control,
    identity,
    runtime,
    sessions,
    executor,
    imessageRouter,
    claimer,
    live,
    browserSessions,
    shell,
    workerId,
    get server() {
      return server;
    },
    get port() {
      return port;
    },
    get url() {
      return url;
    },
    async start() {
      if (server !== null && port !== null && url !== null) return { port, url };
      // The shell server answers one plain HTTP route of its own — a
      // download's bytes (§11) — and everything else is the worker's app.
      const appListener = getRequestListener(app.fetch);
      const httpServer = createServer((request, response) => {
        if (shell.handleRequest(request, response)) return;
        appListener(request, response);
      });
      live.attach(httpServer);
      shell.attach(httpServer);
      await new Promise<void>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(options.ports?.http ?? 0, host, () => {
          httpServer.off("error", reject);
          resolve();
        });
      });
      server = httpServer;
      port = (httpServer.address() as AddressInfo).port;
      const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
      url = `http://${displayHost.includes(":") ? `[${displayHost}]` : displayHost}:${String(port)}`;
      claimer.start();
      log.info("cloud browser listening", { url, workerId });
      return { port, url };
    },
    async stop() {
      // No new claims, then hand active runs back as `interrupted`, then wait for their loops.
      await claimer.stopClaiming();
      await executor.shutdown();
      await claimer.stop();
      await shell.close();
      await browserSessions.close();
      await live.close();
      await sessions.close();
      stopDisconnectWatch();
      await runtime.close().catch(() => undefined);
      if (server !== null) {
        const closing = server;
        server = null;
        port = null;
        url = null;
        closing.closeAllConnections?.();
        await new Promise<void>((resolve) => closing.close(() => resolve()));
      }
    },
    provision,
    steer,
  };
  return runner;
}

function decodeKey(raw: string): Uint8Array {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/u.test(trimmed)) return new Uint8Array(Buffer.from(trimmed, "hex"));
  const key = Buffer.from(trimmed, "base64");
  if (key.byteLength !== 32) throw new Error("stateKey must be 32 bytes (base64 or hex)");
  return new Uint8Array(key);
}
