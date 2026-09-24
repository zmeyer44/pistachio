/**
 * An in-process fake of the control routes the runner calls (§7.3): device
 * challenge/login/refresh, internal cloud enrollment, introspection, device
 * lookup, the run claim/heartbeat/events/pause/complete/fail/thread/commands
 * family, egress credentials, and the device-bearer `/me`, `/devices`, and
 * `/spaces/:id/wrappers` reads. Opaque tokens; every call recorded.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getRequestListener } from "@hono/node-server";
import { Hono, type Context } from "hono";
import type { AgentAttachment, DurablePause, RunEventInput, RunOrigin, RunSummary, StoredRunEvent, TaskStatus, ThreadListItem } from "@pistachio/protocol";
import {
  deviceLoginSigningBytes,
  exportPublicKeyRaw,
  fromBase64,
  generateDeviceKeypair,
  importPublicKeyRaw,
  toBase64,
  wrapRootSecretToDevice,
  type DeviceKeypair,
  type KeyWrapper,
} from "@pistachio/sync-protocol";
import type { ControlDevice, HostedRunRecord, WrapperRow } from "../../src/control-client.js";

export interface FakeDevice extends ControlDevice {
  userId: string;
}

export interface FakeToken {
  userId: string;
  deviceId: string | null;
  platform: "macos" | "web" | "cloud" | null;
  exp: number;
}

export interface FakeRun {
  record: HostedRunRecord;
  leaseToken: string | null;
  workerId: string | null;
  events: StoredRunEvent[];
  nextSeq: number;
  pause: DurablePause | null;
  thread: { spaceId: string; sealed: string } | null;
  failReason: string | null;
  heartbeats: number;
}

export interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

/** A browser session row, as the fake keeps it. */
export interface FakeBrowserSession {
  id: string;
  userId: string;
  spaceId: string;
  state: "ready" | "live" | "suspended" | "ended";
  control: { holder: "human" | "agent"; generation: number };
  activeRunId: string | null;
  leaseWorkerId: string | null;
  leaseWorkerUrl: string | null;
  leaseToken: string | null;
  leaseUntil: number | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

/** How long a session lease lives before control considers it lapsed (§4.3). */
export const FAKE_SESSION_LEASE_MS = 60_000;

export interface FakeControlOptions {
  serviceToken?: string;
  hubUrl?: string;
  egress?: { host: string; port: number } | null;
  tokenTtlSeconds?: number;
  /** Cap on the commands long-poll wait, so tests never sit for 25 s. */
  maxWaitSeconds?: number;
}

export class FakeControl {
  readonly serviceToken: string;
  readonly hubUrl: string;
  egress: { host: string; port: number } | null;
  readonly devices = new Map<string, FakeDevice>();
  /** Unspent live view tickets, by their opaque secret. */
  readonly liveTickets = new Map<
    string,
    { userId: string; deviceId: string; platform: "macos" | "web" | "cloud"; runId: string; spaceId: string; workerUrl: string | null }
  >();
  /** Browser sessions (web-browser-design.md §4), with their leases. */
  readonly browserSessions = new Map<string, FakeBrowserSession>();
  /** When set, every session heartbeat fails as a transport error would. */
  sessionHeartbeatsFail = false;
  /** Unspent shell socket tickets, by their opaque secret. */
  readonly sessionTickets = new Map<
    string,
    { userId: string; deviceId: string; platform: "macos" | "web" | "cloud"; sessionId: string }
  >();
  readonly tokens = new Map<string, FakeToken>();
  readonly enrollments = new Map<string, string>();
  readonly challenges = new Set<string>();
  readonly runs = new Map<string, FakeRun>();
  readonly commandPollFailures = new Map<string, number>();
  readonly claimQueue: string[] = [];
  readonly wrappers = new Map<string, WrapperRow[]>();
  readonly desktopKeys = new Map<string, DeviceKeypair>();
  readonly calls: RecordedCall[] = [];
  readonly credentialRequests: Array<{ userId: string; deviceId: string; runId: string; username: string; password: string }> = [];
  readonly app: Hono;
  #server: Server | null = null;
  #baseUrl: string | null = null;
  readonly #tokenTtl: number;
  readonly #maxWaitSeconds: number;
  readonly #waiters = new Map<string, Set<() => void>>();

  constructor(options: FakeControlOptions = {}) {
    this.serviceToken = options.serviceToken ?? "test-service-token";
    this.hubUrl = options.hubUrl ?? "ws://127.0.0.1:1/v1/hub/ws";
    this.egress = options.egress ?? null;
    this.#tokenTtl = options.tokenTtlSeconds ?? 600;
    this.#maxWaitSeconds = options.maxWaitSeconds ?? 3;
    this.app = this.#routes();
  }

  get baseUrl(): string {
    if (this.#baseUrl === null) throw new Error("fake control not started");
    return this.#baseUrl;
  }

  async start(): Promise<string> {
    const server = createServer(getRequestListener(this.app.fetch));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.#server = server;
    this.#baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    return this.#baseUrl;
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    if (server === null) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /* ------------------------------ mutators ------------------------------ */

  /** An enrolled desktop with a real Ed25519 key (the sender of Space wrappers). */
  async addDesktop(userId: string, name = "Desktop"): Promise<FakeDevice> {
    const keypair = await generateDeviceKeypair();
    const device: FakeDevice = {
      id: randomUUID(),
      userId,
      name,
      platform: "macos",
      devicePublicKey: toBase64(await exportPublicKeyRaw(keypair.publicKey)),
      agreementPublicKey: toBase64(randomBytes(32)),
      createdAt: new Date().toISOString(),
      lastSeenAt: null,
      revokedAt: null,
    };
    this.devices.set(device.id, device);
    this.desktopKeys.set(device.id, keypair);
    return device;
  }

  /** A browser device row: the account web app watching a run (§8.5). */
  addWebDevice(userId: string, name = "Chrome on macOS"): FakeDevice {
    const device: FakeDevice = {
      id: randomUUID(),
      userId,
      name,
      platform: "web",
      devicePublicKey: toBase64(randomBytes(32)),
      agreementPublicKey: toBase64(randomBytes(32)),
      createdAt: new Date().toISOString(),
      lastSeenAt: null,
      revokedAt: null,
    };
    this.devices.set(device.id, device);
    return device;
  }

  /** A browser device with a real Ed25519 key that can sign Space wrappers. */
  async addWebSigner(userId: string, name = "Chrome on macOS"): Promise<FakeDevice> {
    const keypair = await generateDeviceKeypair();
    const device: FakeDevice = {
      id: randomUUID(),
      userId,
      name,
      platform: "web",
      devicePublicKey: toBase64(await exportPublicKeyRaw(keypair.publicKey)),
      agreementPublicKey: toBase64(randomBytes(32)),
      createdAt: new Date().toISOString(),
      lastSeenAt: null,
      revokedAt: null,
    };
    this.devices.set(device.id, device);
    this.desktopKeys.set(device.id, keypair);
    return device;
  }

  /** A cloud device row inserted directly (for tests that do not go through provisioning). */
  addCloudDevice(userId: string, keys: { devicePublicKey: string; agreementPublicKey: string }): FakeDevice {
    const device: FakeDevice = {
      id: randomUUID(),
      userId,
      name: "Cloud browser",
      platform: "cloud",
      ...keys,
      createdAt: new Date().toISOString(),
      lastSeenAt: null,
      revokedAt: null,
    };
    this.devices.set(device.id, device);
    return device;
  }

  liveCloudDevice(userId: string): FakeDevice | null {
    return [...this.devices.values()].find((d) => d.userId === userId && d.platform === "cloud" && d.revokedAt === null) ?? null;
  }

  enrollmentNonce(userId: string): string {
    const nonce = randomBytes(16).toString("base64url");
    this.enrollments.set(userId, nonce);
    return nonce;
  }

  mintToken(claims: Omit<FakeToken, "exp"> & { exp?: number }): string {
    const token = `tok_${randomBytes(12).toString("hex")}`;
    this.tokens.set(token, { ...claims, exp: claims.exp ?? Math.floor(Date.now() / 1000) + this.#tokenTtl });
    return token;
  }

  /** Issue a live view ticket the runner can spend once. */
  mintLiveTicket(input: {
    userId: string;
    deviceId: string;
    platform: "macos" | "web" | "cloud";
    runId: string;
    spaceId?: string;
    workerUrl?: string | null;
  }): string {
    const ticket = `plt_${randomBytes(12).toString("hex")}`;
    this.liveTickets.set(ticket, {
      userId: input.userId,
      deviceId: input.deviceId,
      platform: input.platform,
      runId: input.runId,
      spaceId: input.spaceId ?? "work",
      workerUrl: input.workerUrl ?? null,
    });
    return ticket;
  }

  /** Create a browser session for a Space, as `POST /v1/browser-sessions` does. */
  addBrowserSession(input: { userId: string; spaceId: string; id?: string }): FakeBrowserSession {
    const at = new Date().toISOString();
    const session: FakeBrowserSession = {
      id: input.id ?? randomUUID(),
      userId: input.userId,
      spaceId: input.spaceId,
      state: "ready",
      control: { holder: "human", generation: 0 },
      activeRunId: null,
      leaseWorkerId: null,
      leaseWorkerUrl: null,
      leaseToken: null,
      leaseUntil: null,
      createdAt: at,
      updatedAt: at,
      endedAt: null,
    };
    this.browserSessions.set(session.id, session);
    return session;
  }

  /** Issue a shell socket ticket the worker can spend once (§5). */
  mintSessionTicket(input: {
    userId: string;
    deviceId: string;
    platform?: "macos" | "web" | "cloud";
    sessionId: string;
  }): string {
    const ticket = `pst_${randomBytes(12).toString("hex")}`;
    this.sessionTickets.set(ticket, {
      userId: input.userId,
      deviceId: input.deviceId,
      platform: input.platform ?? "web",
      sessionId: input.sessionId,
    });
    return ticket;
  }

  /** Pretend another worker holds the session, so a redemption routes there. */
  holdBrowserSession(sessionId: string, workerId: string, workerUrl: string | null): void {
    const session = this.browserSessions.get(sessionId);
    if (session === undefined) return;
    session.state = "live";
    session.leaseWorkerId = workerId;
    session.leaseWorkerUrl = workerUrl;
    session.leaseToken = randomUUID();
    session.leaseUntil = Date.now() + FAKE_SESSION_LEASE_MS;
  }

  revokeDevice(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (device !== undefined) device.revokedAt = new Date().toISOString();
  }

  /** Wrap a Space root secret to the user's live cloud device, signed by an enrolled user device. */
  async wrapSpace(userId: string, spaceId: string, rootSecret: Uint8Array, senderDeviceId?: string): Promise<WrapperRow> {
    const cloud = this.liveCloudDevice(userId);
    if (cloud === null) throw new Error("no live cloud device to wrap to");
    const sender =
      senderDeviceId === undefined
        ? [...this.devices.values()].find((d) => d.userId === userId && d.platform === "macos")
        : this.devices.get(senderDeviceId);
    if (sender === undefined) throw new Error("no wrapper sender");
    const keypair = this.desktopKeys.get(sender.id);
    if (keypair === undefined) throw new Error("sender has no key");
    const wrapper = await wrapRootSecretToDevice(
      rootSecret,
      spaceId,
      { deviceId: cloud.id, agreementPublicKeyRaw: fromBase64(cloud.agreementPublicKey) },
      { deviceId: sender.id, signingKey: keypair.privateKey },
    );
    return this.putWrapper(userId, wrapper);
  }

  putWrapper(userId: string, wrapper: KeyWrapper): WrapperRow {
    const row: WrapperRow = {
      spaceId: wrapper.spaceId,
      kind: wrapper.kind,
      credentialId: wrapper.credentialId,
      salt: wrapper.salt,
      wrapped: wrapper.wrapped,
      senderDeviceId: wrapper.senderDeviceId ?? null,
      signature: wrapper.signature ?? null,
      createdAt: new Date(wrapper.createdAtMs).toISOString(),
    };
    const key = `${userId}/${wrapper.spaceId}`;
    const rows = (this.wrappers.get(key) ?? []).filter(
      (existing) => !(existing.kind === row.kind && existing.credentialId === row.credentialId),
    );
    rows.push(row);
    this.wrappers.set(key, rows);
    return row;
  }

  addRun(input: {
    userId: string;
    spaceId: string;
    intent: string;
    /** The browser session the run acts in (web-browser-design.md §4.3). */
    sessionId?: string | null;
    startUrl?: string | null;
    attachments?: AgentAttachment[];
    origin?: RunOrigin | null;
    status?: TaskStatus;
  }): FakeRun {
    const now = new Date().toISOString();
    const id = randomUUID();
    const run: FakeRun = {
      record: {
        id,
        taskId: randomUUID(),
        sponsorId: input.userId,
        userId: input.userId,
        spaceId: input.spaceId,
        purpose: input.intent,
        intent: input.intent,
        attachments: input.attachments ?? [],
        origin: input.origin ?? null,
        executor: { kind: "cloud", deviceId: null, workerId: null },
        startUrl: input.startUrl ?? null,
        sessionId: input.sessionId ?? null,
        status: input.status ?? "ready",
        revision: 1,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      },
      leaseToken: null,
      workerId: null,
      events: [],
      nextSeq: 1,
      pause: null,
      thread: null,
      failReason: null,
      heartbeats: 0,
    };
    this.runs.set(id, run);
    // Control appends the control-class projection as the first event when it creates the run.
    this.#append(run, [{ eventId: `run.created:${id}`, at: now, event: { t: "run.created", run: createdSummary(run.record) } }]);
    this.claimQueue.push(id);
    return run;
  }

  run(runId: string): FakeRun {
    const run = this.runs.get(runId);
    if (run === undefined) throw new Error(`unknown run ${runId}`);
    return run;
  }

  failNextCommandPolls(runId: string, count = 1): void {
    this.commandPollFailures.set(runId, count);
  }

  /** Append a sponsor command (`cmd.*`) and wake long-pollers. */
  pushCommand(runId: string, event: StoredRunEvent["event"]): StoredRunEvent {
    const run = this.run(runId);
    const stored = this.#append(run, [{ eventId: randomUUID(), at: new Date().toISOString(), event }])[0];
    if (stored === undefined) throw new Error("append produced no event");
    return stored;
  }

  /** The sponsor answers a durable judgment and makes it claimable again. */
  answerQuestion(runId: string, questionId: string, value: string): boolean {
    const run = this.run(runId);
    const at = new Date().toISOString();
    this.#append(run, [{ eventId: randomUUID(), at, event: { t: "cmd.answer", questionId, value } }]);
    const pause = run.pause;
    if (pause?.kind !== "judgment" || pause.payload["questionId"] !== questionId) return false;
    run.pause = null;
    run.record.status = "ready";
    run.record.revision += 1;
    run.record.updatedAt = at;
    this.#append(run, [
      { eventId: randomUUID(), at, event: { t: "resume" } },
      { eventId: randomUUID(), at, event: { t: "status", status: "ready", completedAt: null } },
    ]);
    this.claimQueue.push(runId);
    return true;
  }

  /* ------------------------------ routes ------------------------------ */

  #routes(): Hono {
    const app = new Hono();
    app.use("*", async (c, next) => {
      let body: unknown = null;
      if (c.req.method !== "GET") {
        try {
          body = await c.req.raw.clone().json();
        } catch {
          body = null;
        }
      }
      this.calls.push({ method: c.req.method, path: c.req.path, body });
      await next();
    });

    const service = (c: Context): boolean => c.req.header("authorization") === `Bearer ${this.serviceToken}`;
    const bearer = (c: Context): FakeToken | null => {
      const header = c.req.header("authorization");
      if (header === undefined || !header.startsWith("Bearer ")) return null;
      const claims = this.tokens.get(header.slice(7)) ?? null;
      if (claims === null || claims.exp < Date.now() / 1000) return null;
      if (claims.deviceId !== null && (this.devices.get(claims.deviceId)?.revokedAt ?? null) !== null) return null;
      return claims;
    };
    const verifySignature = async (deviceId: string, challenge: string, signature: string, publicKey: string): Promise<boolean> => {
      try {
        const key = await importPublicKeyRaw(fromBase64(publicKey));
        return await crypto.subtle.verify(
          "Ed25519",
          key,
          fromBase64(signature) as BufferSource,
          deviceLoginSigningBytes(deviceId, challenge) as BufferSource,
        );
      } catch {
        return false;
      }
    };
    const tokenFor = (device: FakeDevice): { token: string; exp: number } => {
      const token = this.mintToken({ userId: device.userId, deviceId: device.id, platform: device.platform });
      return { token, exp: this.tokens.get(token)?.exp ?? 0 };
    };
    const publicDevice = (device: FakeDevice): ControlDevice => {
      const { userId: _userId, ...row } = device;
      return row;
    };

    app.get("/v1/healthz", (c) => c.json({ ok: true }));

    app.post("/v1/auth/device-challenge", async (c) => {
      const { deviceId } = (await c.req.json()) as { deviceId: string };
      const challenge = randomBytes(16).toString("base64url");
      this.challenges.add(`${deviceId}:${challenge}`);
      return c.json({ challenge });
    });

    app.post("/v1/auth/device-login", async (c) => {
      const body = (await c.req.json()) as Record<string, string | undefined>;
      const deviceId = body["deviceId"] ?? "";
      const challenge = body["challenge"] ?? "";
      const signature = body["signature"] ?? "";
      if (!this.challenges.delete(`${deviceId}:${challenge}`)) return c.json({ error: "challenge_expired" }, 401);
      const device = this.devices.get(deviceId);
      if (device === undefined) return c.json({ error: "unknown_device" }, 404);
      if (device.revokedAt !== null) return c.json({ error: "device_revoked" }, 401);
      if (!(await verifySignature(deviceId, challenge, signature, device.devicePublicKey))) {
        return c.json({ error: "bad_signature" }, 401);
      }
      return c.json(tokenFor(device));
    });

    app.post("/v1/auth/token/refresh", (c) => {
      const claims = bearer(c);
      if (claims === null) return c.json({ error: "unauthorized" }, 401);
      if (claims.deviceId === null) return c.json({ error: "bootstrap_refresh_denied" }, 403);
      const device = this.devices.get(claims.deviceId);
      if (device === undefined || device.revokedAt !== null) return c.json({ error: "device_revoked" }, 401);
      return c.json(tokenFor(device));
    });

    app.post("/v1/internal/cloud/devices/enroll", async (c) => {
      if (!service(c)) return c.json({ error: "unauthorized" }, 401);
      const body = (await c.req.json()) as Record<string, string>;
      if (this.enrollments.get(body.userId ?? "") !== body.nonce) return c.json({ error: "bad_nonce" }, 403);
      if (!this.challenges.delete(`${body.deviceId}:${body.challenge}`)) return c.json({ error: "challenge_expired" }, 401);
      if (!(await verifySignature(body.deviceId ?? "", body.challenge ?? "", body.signature ?? "", body.devicePublicKey ?? ""))) {
        return c.json({ error: "bad_signature" }, 401);
      }
      if (this.liveCloudDevice(body.userId ?? "") !== null) return c.json({ error: "cloud_device_exists" }, 409);
      if ([...this.devices.values()].some((d) => d.devicePublicKey === body.devicePublicKey)) {
        return c.json({ error: "device_already_enrolled" }, 409);
      }
      const device: FakeDevice = {
        id: body.deviceId ?? randomUUID(),
        userId: body.userId ?? "",
        name: "Cloud browser",
        platform: "cloud",
        devicePublicKey: body.devicePublicKey ?? "",
        agreementPublicKey: body.agreementPublicKey ?? "",
        createdAt: new Date().toISOString(),
        lastSeenAt: null,
        revokedAt: null,
      };
      this.devices.set(device.id, device);
      this.enrollments.delete(device.userId);
      return c.json({ device: publicDevice(device) }, 201);
    });

    app.post("/v1/internal/auth/introspect", async (c) => {
      if (!service(c)) return c.json({ error: "unauthorized" }, 401);
      const { token } = (await c.req.json()) as { token: string };
      const claims = this.tokens.get(token);
      if (claims === undefined || claims.exp < Date.now() / 1000) return c.json({ error: "unauthorized" }, 401);
      if (claims.deviceId !== null && (this.devices.get(claims.deviceId)?.revokedAt ?? null) !== null) {
        return c.json({ error: "unauthorized" }, 401);
      }
      return c.json({ userId: claims.userId, deviceId: claims.deviceId, platform: claims.platform });
    });

    /** Live view tickets: opaque, single-use, and they route as well as authenticate (§8.5). */
    app.post("/v1/internal/live-tickets/redeem", async (c) => {
      if (!service(c)) return c.json({ error: "unauthorized" }, 401);
      const { ticket, runId } = (await c.req.json()) as { ticket: string; runId: string };
      const held = this.liveTickets.get(ticket);
      if (held === undefined || held.runId !== runId) return c.json({ error: "unauthorized" }, 401);
      this.liveTickets.delete(ticket);
      if ((this.devices.get(held.deviceId)?.revokedAt ?? null) !== null) return c.json({ error: "unauthorized" }, 401);
      return c.json({
        userId: held.userId,
        deviceId: held.deviceId,
        platform: held.platform,
        spaceId: held.spaceId,
        workerUrl: held.workerUrl,
      });
    });


    /* ---------------- browser sessions (web-browser-design.md §4.3) ---------------- */

    const sessionView = (session: FakeBrowserSession): Record<string, unknown> => ({
      id: session.id,
      spaceId: session.spaceId,
      state: session.state,
      control: session.control,
      activeRunId: session.activeRunId,
      worker:
        session.leaseWorkerId !== null && session.leaseUntil !== null && session.leaseUntil > Date.now()
          ? { id: session.leaseWorkerId, until: new Date(session.leaseUntil).toISOString() }
          : null,
      lastAttachedAt: null,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      endedAt: session.endedAt,
    });

    const sessionLeaseLive = (session: FakeBrowserSession): boolean =>
      session.leaseUntil !== null && session.leaseUntil > Date.now();

    app.post("/v1/internal/session-tickets/redeem", async (c) => {
      if (!service(c)) return c.json({ error: "unauthorized" }, 401);
      const { ticket, sessionId } = (await c.req.json()) as { ticket: string; sessionId: string };
      const held = this.sessionTickets.get(ticket);
      if (held === undefined || held.sessionId !== sessionId) return c.json({ error: "unauthorized" }, 401);
      this.sessionTickets.delete(ticket);
      if ((this.devices.get(held.deviceId)?.revokedAt ?? null) !== null) return c.json({ error: "unauthorized" }, 401);
      const session = this.browserSessions.get(sessionId);
      if (session === undefined || session.userId !== held.userId || session.state === "ended") {
        return c.json({ error: "unauthorized" }, 401);
      }
      return c.json({
        userId: held.userId,
        deviceId: held.deviceId,
        platform: held.platform,
        spaceId: session.spaceId,
        workerUrl: sessionLeaseLive(session) ? session.leaseWorkerUrl : null,
      });
    });

    // Where a session is, for a worker deciding between claiming and relaying
    // (docs/web-browser-design.md §6.4).
    app.get("/v1/internal/browser-sessions/:id", (c) => {
      if (!service(c)) return c.json({ error: "unauthorized" }, 401);
      const session = this.browserSessions.get(c.req.param("id") ?? "");
      if (session === undefined) return c.json({ error: "not_found" }, 404);
      return c.json({
        session: sessionView(session),
        workerUrl: sessionLeaseLive(session) ? session.leaseWorkerUrl : null,
      });
    });

    app.post("/v1/internal/browser-sessions/:id/claim", async (c) => {
      if (!service(c)) return c.json({ error: "unauthorized" }, 401);
      const session = this.browserSessions.get(c.req.param("id") ?? "");
      const { workerId, workerUrl } = (await c.req.json()) as { workerId: string; workerUrl?: string };
      if (session === undefined) return c.json({ error: "not_found" }, 404);
      if (session.state === "ended") return c.json({ error: "session_ended" }, 410);
      if (sessionLeaseLive(session) && session.leaseWorkerId !== workerId) {
        return c.json({ error: "held_elsewhere" }, 409);
      }
      const renewing = session.leaseWorkerId === workerId && session.leaseToken !== null && sessionLeaseLive(session);
      const leaseToken = renewing ? (session.leaseToken as string) : randomUUID();
      session.state = "live";
      session.leaseWorkerId = workerId;
      session.leaseWorkerUrl = workerUrl ?? null;
      session.leaseToken = leaseToken;
      session.leaseUntil = Date.now() + FAKE_SESSION_LEASE_MS;
      session.updatedAt = new Date().toISOString();
      return c.json({ session: sessionView(session), leaseToken });
    });

    app.post("/v1/internal/browser-sessions/:id/heartbeat", async (c) => {
      if (!service(c)) return c.json({ error: "unauthorized" }, 401);
      // A control plane the worker cannot reach: not a refusal of the lease,
      // which is the whole point — the worker is told nothing at all.
      if (this.sessionHeartbeatsFail) return c.json({ error: "upstream_unavailable" }, 500);
      const session = this.browserSessions.get(c.req.param("id") ?? "");
      const { leaseToken } = (await c.req.json()) as { leaseToken: string };
      if (session === undefined) return c.json({ error: "not_found" }, 404);
      if (session.state === "ended") return c.json({ error: "session_ended" }, 410);
      if (session.leaseToken !== leaseToken || !sessionLeaseLive(session)) {
        return c.json({ error: "stale_lease" }, 409);
      }
      session.leaseUntil = Date.now() + FAKE_SESSION_LEASE_MS;
      session.updatedAt = new Date().toISOString();
      return c.json({ session: sessionView(session) });
    });

    app.post("/v1/internal/browser-sessions/:id/release", async (c) => {
      if (!service(c)) return c.json({ error: "unauthorized" }, 401);
      const session = this.browserSessions.get(c.req.param("id") ?? "");
      const { leaseToken, state } = (await c.req.json()) as { leaseToken: string; state: "suspended" };
      if (session === undefined) return c.json({ error: "not_found" }, 404);
      if (session.state === "ended") return c.body(null, 204);
      if (session.leaseToken !== leaseToken) return c.json({ error: "stale_lease" }, 409);
      session.state = state;
      session.leaseWorkerId = null;
      session.leaseWorkerUrl = null;
      session.leaseToken = null;
      session.leaseUntil = null;
      session.updatedAt = new Date().toISOString();
      return c.body(null, 204);
    });

    /* ------- the session's runs, lease-authenticated (§8) ------- */

    /** The lease-and-actor check every route in the family makes. */
    const leasedSession = (
      c: Context,
      leaseToken: unknown,
      viewerDeviceId: unknown,
    ): FakeBrowserSession | Response => {
      const session = this.browserSessions.get(c.req.param("id") ?? "");
      if (session === undefined) return c.json({ error: "not_found" }, 404);
      if (session.state === "ended") return c.json({ error: "session_ended" }, 410);
      if (session.leaseToken !== leaseToken || !sessionLeaseLive(session)) {
        return c.json({ error: "stale_lease" }, 409);
      }
      if (viewerDeviceId !== undefined) {
        const device = typeof viewerDeviceId === "string" ? this.devices.get(viewerDeviceId) : undefined;
        if (device === undefined || device.revokedAt !== null || device.userId !== session.userId) {
          return c.json({ error: "viewer_device" }, 403);
        }
      }
      return session;
    };

    app.post("/v1/internal/browser-sessions/:id/runs", async (c) => {
      if (!service(c)) return c.json({ error: "unauthorized" }, 401);
      const body = (await c.req.json()) as {
        leaseToken: string;
        viewerDeviceId: string;
        intent: string;
        attachments?: AgentAttachment[];
        startUrl?: string;
      };
      const session = leasedSession(c, body.leaseToken, body.viewerDeviceId);
      if (session instanceof Response) return session;
      const run = this.addRun({
        userId: session.userId,
        spaceId: session.spaceId,
        intent: body.intent,
        sessionId: session.id,
        ...(body.attachments === undefined ? {} : { attachments: body.attachments }),
        ...(body.startUrl === undefined ? {} : { startUrl: body.startUrl }),
      });
      const first = run.events[0];
      return c.json(
        {
          runId: run.record.id,
          at: run.record.createdAt,
          events: first === undefined ? [] : [first.event],
        },
        201,
      );
    });

    app.post("/v1/internal/browser-sessions/:id/runs/:runId/:command", async (c) => {
      if (!service(c)) return c.json({ error: "unauthorized" }, 401);
      const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      const session = leasedSession(c, body["leaseToken"], body["viewerDeviceId"]);
      if (session instanceof Response) return session;
      const run = this.runs.get(c.req.param("runId") ?? "");
      if (run === undefined || run.record.sessionId !== session.id) return c.json({ error: "not_found" }, 404);
      const command = c.req.param("command") ?? "";
      const at = new Date().toISOString();
      const events: StoredRunEvent["event"][] = [];
      const moveFence = (holder: "human" | "agent"): void => {
        session.control = { holder, generation: session.control.generation + 1 };
        session.updatedAt = at;
        events.push({ t: "control", control: holder, generation: session.control.generation });
      };
      switch (command) {
        case "message":
          events.push({ t: "cmd.message", text: String(body["text"] ?? ""), attachments: [] });
          if (run.record.status === "interrupted" || run.record.completedAt !== null) {
            run.record.status = "ready";
            run.record.completedAt = null;
            this.claimQueue.push(run.record.id);
            events.push({ t: "status", status: "ready", completedAt: null });
          }
          break;
        case "answer":
          events.push({ t: "cmd.answer", questionId: String(body["questionId"] ?? ""), value: String(body["value"] ?? "") });
          break;
        case "interrupt":
          run.record.status = "human_control";
          events.push({ t: "cmd.interrupt" }, { t: "status", status: "human_control", completedAt: null });
          moveFence("human");
          break;
        case "release":
          run.record.status = "running";
          events.push({ t: "cmd.release" }, { t: "status", status: "running", completedAt: null });
          moveFence("agent");
          break;
        case "revoke":
          run.record.status = "revoked";
          run.record.completedAt = at;
          session.activeRunId = null;
          events.push({ t: "cmd.revoke" }, { t: "status", status: "revoked", completedAt: at });
          moveFence("human");
          break;
        case "approve":
          run.pause = null;
          run.record.status = "ready";
          events.push({ t: "resume" }, { t: "status", status: "ready", completedAt: null });
          break;
        case "reject":
          run.pause = null;
          run.record.status = "rejected";
          run.record.completedAt = at;
          session.activeRunId = null;
          events.push({ t: "status", status: "rejected", completedAt: at });
          moveFence("human");
          break;
        default:
          return c.json({ error: "invalid_body" }, 400);
      }
      run.record.revision += 1;
      run.record.updatedAt = at;
      const stored = this.#append(run, events.map((event) => ({ eventId: randomUUID(), at, event })));
      return c.json({ ok: true, status: run.record.status, seqs: stored.map((row) => row.seq), at, events }, 202);
    });

    app.get("/v1/internal/browser-sessions/:id/runs", (c) => {
      if (!service(c)) return c.json({ error: "unauthorized" }, 401);
      // The lease travels in a header, never in the query string (§8.1): it
      // authorises acting as the person, and control logs `url.search`.
      const session = leasedSession(c, c.req.header("x-pistachio-session-lease"), undefined);
      if (session instanceof Response) return session;
      const runs: ThreadListItem[] = [];
      const threads: Array<{ runId: string; spaceId: string; sealed: string }> = [];
      for (const run of this.runs.values()) {
        if (run.record.userId !== session.userId || run.record.spaceId !== session.spaceId) continue;
        runs.push(listItem(run.record));
        if (run.thread !== null) threads.push({ runId: run.record.id, ...run.thread });
      }
      return c.json({ runs, threads });
    });

    app.get("/v1/internal/browser-sessions/:id/runs/:runId/events", (c) => {
      if (!service(c)) return c.json({ error: "unauthorized" }, 401);
      // The lease travels in a header, never in the query string (§8.1): it
      // authorises acting as the person, and control logs `url.search`.
      const session = leasedSession(c, c.req.header("x-pistachio-session-lease"), undefined);
      if (session instanceof Response) return session;
      const run = this.runs.get(c.req.param("runId") ?? "");
      if (run === undefined || run.record.spaceId !== session.spaceId) return c.json({ error: "not_found" }, 404);
      const since = Number(c.req.query("since") ?? "0");
      return c.json({ events: run.events.filter((event) => event.seq > (Number.isFinite(since) ? since : 0)) });
    });

    app.get("/v1/internal/devices/:id", (c) => {
      if (!service(c)) return c.json({ error: "unauthorized" }, 401);
      const device = this.devices.get(c.req.param("id") ?? "");
      if (device === undefined) return c.json({ error: "not_found" }, 404);
      return c.json({ userId: device.userId, platform: device.platform, revokedAt: device.revokedAt });
    });

    app.post("/v1/internal/runs/claim", async (c) => {
      if (!service(c)) return c.json({ error: "unauthorized" }, 401);
      const { workerId } = (await c.req.json()) as { workerId: string };
      const runId = this.claimQueue.shift();
      if (runId === undefined) return c.body(null, 204);
      const run = this.run(runId);
      run.leaseToken = randomUUID();
      run.workerId = workerId;
      if (run.record.status !== "human_control") run.record.status = "running";
      run.record.executor = { kind: "cloud", deviceId: this.liveCloudDevice(run.record.userId)?.id ?? null, workerId };
      run.record.revision += 1;
      // A run with a session takes the session in the same transaction (§4.3):
      // the lease comes back with the claim, and the fence moves to the agent.
      let session: { id: string; leaseToken: string; generation: number } | undefined;
      const attached = run.record.sessionId === null ? undefined : this.browserSessions.get(run.record.sessionId);
      if (attached !== undefined && attached.state !== "ended") {
        attached.state = "live";
        attached.leaseWorkerId = workerId;
        attached.leaseToken ??= randomUUID();
        attached.leaseUntil = Date.now() + FAKE_SESSION_LEASE_MS;
        attached.control = { holder: "agent", generation: attached.control.generation + 1 };
        attached.activeRunId = run.record.id;
        attached.updatedAt = new Date().toISOString();
        session = { id: attached.id, leaseToken: attached.leaseToken, generation: attached.control.generation };
        this.#append(run, [
          {
            eventId: `control:${run.record.id}:${String(attached.control.generation)}`,
            at: new Date().toISOString(),
            event: { t: "control", control: "agent", generation: attached.control.generation },
          },
        ]);
      }
      return c.json({
        run: run.record,
        leaseToken: run.leaseToken,
        thread: run.thread,
        ...(session === undefined ? {} : { session }),
      });
    });

    const leased = async (c: Context): Promise<{ run: FakeRun; body: Record<string, unknown> } | Response> => {
      if (!service(c)) return c.json({ error: "unauthorized" }, 401);
      const run = this.runs.get(c.req.param("id") ?? "");
      if (run === undefined) return c.json({ error: "not_found" }, 404);
      const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      if (run.leaseToken === null || body["leaseToken"] !== run.leaseToken) return c.json({ error: "stale_lease" }, 409);
      return { run, body };
    };
    const trailing = (run: FakeRun, body: Record<string, unknown>): void => {
      const events = body["events"];
      if (Array.isArray(events)) this.#append(run, events as RunEventInput[]);
    };

    app.post("/v1/internal/runs/:id/heartbeat", async (c) => {
      const out = await leased(c);
      if (out instanceof Response) return out;
      out.run.heartbeats += 1;
      return c.body(null, 204);
    });

    app.post("/v1/internal/runs/:id/events", async (c) => {
      const out = await leased(c);
      if (out instanceof Response) return out;
      const stored = this.#append(out.run, (out.body["events"] as RunEventInput[] | undefined) ?? []);
      return c.json({ seqs: stored.map((event) => event.seq) });
    });

    app.post("/v1/internal/runs/:id/pause", async (c) => {
      const out = await leased(c);
      if (out instanceof Response) return out;
      const pause = out.body["pause"] as DurablePause | undefined;
      out.run.record.status =
        pause?.kind === "step_up" ? "waiting_for_step_up" : pause?.kind === "approval" ? "waiting_for_approval" : "waiting_for_judgment";
      out.run.pause = pause ?? null;
      out.run.record.revision += 1;
      out.run.leaseToken = null;
      out.run.workerId = null;
      trailing(out.run, out.body);
      return c.body(null, 204);
    });

    app.post("/v1/internal/runs/:id/complete", async (c) => {
      const out = await leased(c);
      if (out instanceof Response) return out;
      out.run.record.status = "completed";
      out.run.record.completedAt = new Date().toISOString();
      out.run.leaseToken = null;
      trailing(out.run, out.body);
      return c.body(null, 204);
    });

    app.post("/v1/internal/runs/:id/fail", async (c) => {
      const out = await leased(c);
      if (out instanceof Response) return out;
      out.run.record.status = "failed";
      out.run.record.completedAt = new Date().toISOString();
      out.run.failReason = typeof out.body["reason"] === "string" ? out.body["reason"] : null;
      out.run.leaseToken = null;
      trailing(out.run, out.body);
      return c.body(null, 204);
    });

    app.post("/v1/internal/runs/:id/interrupt", async (c) => {
      const out = await leased(c);
      if (out instanceof Response) return out;
      out.run.record.status = "interrupted";
      out.run.leaseToken = null;
      trailing(out.run, out.body);
      return c.json({ run: out.run.record });
    });

    app.put("/v1/internal/runs/:id/thread", async (c) => {
      const out = await leased(c);
      if (out instanceof Response) return out;
      out.run.thread = out.body["thread"] as { spaceId: string; sealed: string };
      return c.body(null, 204);
    });

    app.get("/v1/internal/runs/:id/commands", async (c) => {
      if (!service(c)) return c.json({ error: "unauthorized" }, 401);
      const runId = c.req.param("id") ?? "";
      const run = this.runs.get(runId);
      if (run === undefined) return c.json({ error: "not_found" }, 404);
      const failures = this.commandPollFailures.get(runId) ?? 0;
      if (failures > 0) {
        if (failures === 1) this.commandPollFailures.delete(runId);
        else this.commandPollFailures.set(runId, failures - 1);
        return c.json({ error: "temporary_failure" }, 500);
      }
      const since = Number.parseInt(c.req.query("since") ?? "0", 10) || 0;
      const wait = Math.min(Number.parseInt(c.req.query("wait") ?? "0", 10) || 0, this.#maxWaitSeconds);
      const pick = (): StoredRunEvent[] => run.events.filter((event) => event.seq > since && event.event.t.startsWith("cmd."));
      let events = pick();
      if (events.length === 0 && wait > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, wait * 1000);
          const waiters = this.#waiters.get(run.record.id) ?? new Set();
          this.#waiters.set(run.record.id, waiters);
          function done(): void {
            clearTimeout(timer);
            waiters.delete(done);
            resolve();
          }
          waiters.add(done);
        });
        events = pick();
      }
      const cursor = Math.max(since, run.nextSeq - 1, ...events.map((event) => event.seq));
      return c.json({ events, since: cursor });
    });

    app.get("/v1/internal/users/:id/egress-credential", (c) => {
      if (!service(c)) return c.json({ error: "unauthorized" }, 401);
      const userId = c.req.param("id");
      const deviceId = c.req.query("deviceId") ?? "";
      const runId = c.req.query("runId") ?? c.req.query("sessionId") ?? "";
      const cloud = this.liveCloudDevice(userId);
      if (cloud === null || cloud.id !== deviceId) return c.json({ error: "not_found" }, 404);
      const credentialId = randomUUID();
      const exp = Math.floor(Date.now() / 1000) + 86_400;
      const username = `pe1.${userId}.${deviceId}.${credentialId}.${String(exp)}`;
      const password = randomBytes(32).toString("base64url");
      this.credentialRequests.push({ userId, deviceId, runId, username, password });
      return c.json({ username, password, expiresAt: new Date(exp * 1000).toISOString(), credentialId });
    });

    app.get("/v1/me", (c) => {
      const claims = bearer(c);
      if (claims === null) return c.json({ error: "unauthorized" }, 401);
      return c.json({
        userId: claims.userId,
        email: `${claims.userId}@example.test`,
        hubUrl: this.hubUrl,
        cloudBrowserUrl: null,
        egress: this.egress,
        features: ["sync", "cloud-browser", ...(this.egress === null ? [] : ["egress"])],
      });
    });

    app.get("/v1/devices", (c) => {
      const claims = bearer(c);
      if (claims === null) return c.json({ error: "unauthorized" }, 401);
      if (claims.deviceId === null) return c.json({ error: "device_required" }, 403);
      return c.json({ devices: [...this.devices.values()].filter((d) => d.userId === claims.userId).map(publicDevice) });
    });

    app.get("/v1/spaces/:id/wrappers", (c) => {
      const claims = bearer(c);
      if (claims === null) return c.json({ error: "unauthorized" }, 401);
      const rows = this.wrappers.get(`${claims.userId}/${c.req.param("id")}`) ?? [];
      const filtered =
        claims.platform === "cloud"
          ? rows.filter((row) => row.kind === "device-x25519" && row.credentialId === claims.deviceId)
          : rows;
      return c.json({ wrappers: filtered });
    });

    return app;
  }

  #append(run: FakeRun, events: RunEventInput[]): StoredRunEvent[] {
    const stored: StoredRunEvent[] = [];
    for (const input of events) {
      const existing = run.events.find((event) => event.eventId === input.eventId);
      if (existing !== undefined) {
        stored.push(existing);
        continue;
      }
      const entry: StoredRunEvent = { ...input, seq: run.nextSeq };
      run.nextSeq += 1;
      run.events.push(entry);
      stored.push(entry);
    }
    if (stored.some((event) => event.event.t.startsWith("cmd."))) {
      for (const wake of [...(this.#waiters.get(run.record.id) ?? [])]) wake();
    }
    return stored;
  }
}

/** Control's `controlRunSummary`: every content field empty, control-class fields from the record. */
function createdSummary(record: HostedRunRecord): RunSummary {
  return {
    runId: record.id,
    taskId: record.taskId,
    status: record.status,
    purpose: record.intent,
    title: record.intent.split("\n").find((line) => line.trim() !== "")?.trim() ?? "Cloud run",
    updatedAt: record.createdAt,
    turns: 0,
    notes: "",
    context: { tokens: null, compactAt: 0, window: 0, compactions: 0, steps: 0, totalSteps: 0, usage: { inputTokens: 0, outputTokens: 0 } },
    humanTabId: null,
    agentTabId: null,
    startedAt: record.createdAt,
    completedAt: null,
    control: "agent",
    ...(record.origin === null ? {} : { origin: record.origin }),
    executor: record.executor,
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

/** The control-class row `GET /runs?spaceId=` answers with. */
function listItem(record: HostedRunRecord): ThreadListItem {
  return {
    runId: record.id,
    title: record.intent.split("\n").find((line) => line.trim() !== "")?.trim() ?? "Cloud run",
    status: record.status,
    startedAt: record.createdAt,
    updatedAt: record.updatedAt,
    turns: 0,
    messageCount: 0,
    ...(record.origin === null ? {} : { origin: record.origin }),
    executor: record.executor,
  };
}

export async function startFakeControl(options: FakeControlOptions = {}): Promise<FakeControl> {
  const fake = new FakeControl(options);
  await fake.start();
  return fake;
}
