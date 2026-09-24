/**
 * Shared harness: PGlite + createApp driven in-process through
 * `app.request()`, real device keys for every enrollment, a fake hub that
 * records calls, and a fake cloud-browser runner (a real `http.Server`) that
 * performs the §8.2 provision → challenge → internal enroll dance.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { IMessageThreadRouteRequest, IMessageThreadRouteResult } from "@pistachio/protocol";
import type { ServerMessage } from "@pistachio/sync-protocol";
import {
  deviceLoginSigningBytes,
  exportPublicKeyRaw,
  generateAgreementKeypair,
  generateDeviceKeypair,
  toBase64,
  type AgreementKeypair,
  type DeviceKeypair,
} from "@pistachio/sync-protocol";
import type { HubHost } from "@pistachio/sync-hub";
import type { HostedRunRecord } from "@pistachio/runtime";
import { expect } from "vitest";
import { createApp, type ControlApp, type CreateAppOptions } from "../src/app.js";
import type { Db } from "../src/db/client.js";
import { ensureSchema } from "../src/db/migrate.js";
import * as schema from "../src/db/schema.js";
import { StaticEgressProvider, type EgressOptions } from "../src/egress.js";
import { generateSigningKeys, type SigningKeys } from "../src/keys-provider.js";
import { httpRunnerClient, type RunnerClient, type SteerBody } from "../src/outbox.js";

export const SERVICE_TOKEN = "svc-token-for-tests";
export const GATEWAY_TOKEN = "gw-token-for-tests";
export const EGRESS_SECRET_HEX = "0123456789abcdef".repeat(4);
export const PASSWORD = "correct-horse-battery";

export async function makeDb(): Promise<Db> {
  const db = drizzle(new PGlite(), { schema });
  await ensureSchema(db);
  return db;
}

export class FakeHub implements HubHost {
  readonly revoked: Array<{ userId: string; deviceId: string }> = [];
  readonly released: Array<{ userId: string; deviceId: string; spaceId?: string; originIds?: string[] }> = [];
  readonly broadcasts: Array<{ userId: string; frame: ServerMessage }> = [];
  gcCalls = 0;
  /** When set, the next `revokeDevice` rejects (and clears the flag). */
  failRevokeOnce = false;

  revokeDevice(userId: string, deviceId: string): Promise<void> {
    if (this.failRevokeOnce) {
      this.failRevokeOnce = false;
      return Promise.reject(new Error("hub_kv write failed"));
    }
    this.revoked.push({ userId, deviceId });
    return Promise.resolve();
  }

  broadcast(userId: string, frame: ServerMessage): Promise<void> {
    this.broadcasts.push({ userId, frame });
    return Promise.resolve();
  }

  releaseLeases(userId: string, filter: { deviceId: string; spaceId?: string; originIds?: string[] }): Promise<void> {
    this.released.push({ userId, ...filter });
    return Promise.resolve();
  }

  gc(): Promise<void> {
    this.gcCalls += 1;
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

export interface Harness {
  db: Db;
  control: ControlApp;
  signing: SigningKeys;
  hub: FakeHub;
  env: Record<string, string | undefined>;
  logs: string[];
  request(path: string, init?: RequestInit): Promise<Response>;
}

export interface HarnessOptions {
  runner?: RunnerClient;
  egress?: EgressOptions;
  mailer?: CreateAppOptions["mailer"];
  now?: () => number;
  env?: Record<string, string | undefined>;
  channels?: CreateAppOptions["channels"];
  imessage?: CreateAppOptions["imessage"];
  sse?: CreateAppOptions["sse"];
  ai?: CreateAppOptions["ai"];
  /** Pass `null` to attach a real hub later instead of the fake. */
  hub?: FakeHub | null;
  db?: Db;
  signing?: SigningKeys;
}

export async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const db = options.db ?? (await makeDb());
  const signing = options.signing ?? (await generateSigningKeys());
  const hub = options.hub === undefined ? new FakeHub() : options.hub;
  const env: Record<string, string | undefined> = {
    CLOUD_BROWSER_SERVICE_TOKEN: SERVICE_TOKEN,
    EGRESS_GATEWAY_TOKEN: GATEWAY_TOKEN,
    CONTROL_PUBLIC_URL: "https://control.example",
    ...options.env,
  };
  const logs: string[] = [];
  const control = createApp(db, {
    signing,
    env,
    log: (line) => logs.push(line),
    egress: options.egress ?? {
      provider: new StaticEgressProvider("gw.example", 8443, "203.0.113.5"),
      tokenSecretHex: EGRESS_SECRET_HEX,
    },
    ...(hub === null ? {} : { hub }),
    ...(options.runner === undefined ? {} : { runner: options.runner }),
    ...(options.mailer === undefined ? {} : { mailer: options.mailer }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.channels === undefined ? {} : { channels: options.channels }),
    ...(options.imessage === undefined ? {} : { imessage: options.imessage }),
    ...(options.sse === undefined ? {} : { sse: options.sse }),
    ...(options.ai === undefined ? {} : { ai: options.ai }),
  });
  return {
    db,
    control,
    signing,
    hub: hub ?? new FakeHub(),
    env,
    logs,
    request: (path, init) => Promise.resolve(control.app.request(path, init)),
  };
}

/* ------------------------------------------------------------------ *
 * Requests
 * ------------------------------------------------------------------ */

export function jsonInit(method: string, body: unknown, token?: string): RequestInit {
  return {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  };
}

export function authed(token: string, method = "GET"): RequestInit {
  return { method, headers: { authorization: `Bearer ${token}` } };
}

export async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/* ------------------------------------------------------------------ *
 * Accounts and devices
 * ------------------------------------------------------------------ */

let emailCounter = 0;
export function nextEmail(prefix = "user"): string {
  emailCounter += 1;
  return `${prefix}-${String(emailCounter)}-${randomUUID().slice(0, 8)}@example.com`;
}

export interface Account {
  userId: string;
  email: string;
  bootstrapToken: string;
}

export async function signup(h: Harness, email = nextEmail()): Promise<Account> {
  const res = await h.request("/v1/accounts", jsonInit("POST", { email, password: PASSWORD }));
  expect(res.status).toBe(201);
  const out = await json<{ userId: string; bootstrapToken: string }>(res);
  return { userId: out.userId, email, bootstrapToken: out.bootstrapToken };
}

export interface DeviceKeys {
  deviceId: string;
  signing: DeviceKeypair;
  agreement: AgreementKeypair;
  devicePublicKey: string;
  agreementPublicKey: string;
  agreementPublicKeyRaw: Uint8Array;
}

export async function newDeviceKeys(): Promise<DeviceKeys> {
  const signing = await generateDeviceKeypair();
  const agreement = await generateAgreementKeypair();
  const agreementPublicKeyRaw = await exportPublicKeyRaw(agreement.publicKey);
  return {
    deviceId: randomUUID(),
    signing,
    agreement,
    devicePublicKey: toBase64(await exportPublicKeyRaw(signing.publicKey)),
    agreementPublicKey: toBase64(agreementPublicKeyRaw),
    agreementPublicKeyRaw,
  };
}

export async function challengeFor(h: Harness, deviceId: string): Promise<string> {
  const res = await h.request("/v1/auth/device-challenge", jsonInit("POST", { deviceId }));
  expect(res.status).toBe(200);
  return (await json<{ challenge: string }>(res)).challenge;
}

export async function signChallenge(keys: DeviceKeys, challenge: string): Promise<string> {
  const sig = await crypto.subtle.sign(
    "Ed25519",
    keys.signing.privateKey,
    deviceLoginSigningBytes(keys.deviceId, challenge) as BufferSource,
  );
  return toBase64(new Uint8Array(sig));
}

export interface EnrolledDevice {
  keys: DeviceKeys;
  deviceId: string;
  token: string;
  exp: number;
  device: Record<string, unknown>;
}

export async function enrollRequest(
  h: Harness,
  bootstrapToken: string,
  keys: DeviceKeys,
  overrides: Record<string, unknown> = {},
): Promise<Response> {
  const challenge = await challengeFor(h, keys.deviceId);
  const signature = await signChallenge(keys, challenge);
  return h.request(
    "/v1/devices/enroll",
    jsonInit(
      "POST",
      {
        deviceId: keys.deviceId,
        name: "MacBook",
        platform: "macos",
        devicePublicKey: keys.devicePublicKey,
        agreementPublicKey: keys.agreementPublicKey,
        challenge,
        signature,
        ...overrides,
      },
      bootstrapToken,
    ),
  );
}

export async function enrollDesktop(h: Harness, bootstrapToken: string, keys?: DeviceKeys): Promise<EnrolledDevice> {
  const k = keys ?? (await newDeviceKeys());
  const res = await enrollRequest(h, bootstrapToken, k);
  expect(res.status).toBe(201);
  const out = await json<{ device: Record<string, unknown>; token: string; exp: number }>(res);
  expect(out.device["id"]).toBe(k.deviceId);
  return { keys: k, deviceId: k.deviceId, token: out.token, exp: out.exp, device: out.device };
}

export async function deviceLogin(h: Harness, keys: DeviceKeys): Promise<{ token: string; exp: number }> {
  const challenge = await challengeFor(h, keys.deviceId);
  const signature = await signChallenge(keys, challenge);
  const res = await h.request(
    "/v1/auth/device-login",
    jsonInit("POST", { deviceId: keys.deviceId, challenge, signature }),
  );
  expect(res.status).toBe(200);
  return json(res);
}

export async function anonymousRequest(
  h: Harness,
  keys: DeviceKeys,
  options: { address?: string; overrides?: Record<string, unknown> } = {},
): Promise<Response> {
  const challenge = await challengeFor(h, keys.deviceId);
  const signature = await signChallenge(keys, challenge);
  const init = jsonInit("POST", {
    deviceId: keys.deviceId,
    name: "MacBook",
    platform: "macos",
    devicePublicKey: keys.devicePublicKey,
    agreementPublicKey: keys.agreementPublicKey,
    challenge,
    signature,
    ...options.overrides,
  });
  // Minting is bounded per client address; each caller is its own unless it says otherwise.
  const address = options.address ?? randomUUID();
  return h.request("/v1/accounts/anonymous", {
    ...init,
    headers: { ...(init.headers as Record<string, string>), "x-forwarded-for": address },
  });
}

/** An anonymous account (docs/anonymous-accounts.md): one call makes the user and enrolls the Mac. */
export async function anonymousAccount(h: Harness, keys?: DeviceKeys): Promise<EnrolledDevice & { userId: string }> {
  const k = keys ?? (await newDeviceKeys());
  const res = await anonymousRequest(h, k);
  expect(res.status).toBe(201);
  const out = await json<{ userId: string; device: Record<string, unknown>; token: string; exp: number }>(res);
  return { userId: out.userId, keys: k, deviceId: k.deviceId, token: out.token, exp: out.exp, device: out.device };
}

/** Sign up and enroll one desktop in one go. */
export async function desktopAccount(h: Harness): Promise<Account & EnrolledDevice> {
  const account = await signup(h);
  const device = await enrollDesktop(h, account.bootstrapToken);
  return { ...account, ...device };
}

/* ------------------------------------------------------------------ *
 * Fake cloud-browser runner
 * ------------------------------------------------------------------ */

export interface FakeRunner {
  url: string;
  client: RunnerClient;
  provisions: Array<{ userId: string; nonce: string }>;
  steers: SteerBody[];
  routes: IMessageThreadRouteRequest[];
  /** Fixed answer, or one computed per candidate. */
  routeDecision: IMessageThreadRouteResult | ((input: IMessageThreadRouteRequest) => IMessageThreadRouteResult);
  identities: Map<string, DeviceKeys>;
  /** When set, provision responds 500 without enrolling. */
  failProvision: boolean;
  /** When set, steers respond 500. */
  failSteer: boolean;
  /** When set, iMessage routing responds 500. */
  failRoute: boolean;
  /** Extra delay before provisioning (to widen races). */
  provisionDelayMs: number;
  close(): Promise<void>;
}

export type ControlRequest = (path: string, init: RequestInit) => Promise<Response>;

export async function fakeRunner(controlRequest: ControlRequest): Promise<FakeRunner> {
  const state: Omit<FakeRunner, "url" | "client" | "close"> = {
    provisions: [],
    steers: [],
    routes: [],
    routeDecision: { decision: "new", confidence: 0.9 },
    identities: new Map(),
    failProvision: false,
    failSteer: false,
    failRoute: false,
    provisionDelayMs: 0,
  };
  const provisionLocks = new Map<string, Promise<void>>();
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void (async () => {
        const auth = req.headers.authorization;
        if (auth !== `Bearer ${SERVICE_TOKEN}`) {
          res.writeHead(401).end();
          return;
        }
        const body = chunks.length === 0 ? {} : (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        if (req.method === "POST" && req.url === "/v1/devices/provision") {
          const userId = typeof body["userId"] === "string" ? body["userId"] : "";
          const nonce = typeof body["nonce"] === "string" ? body["nonce"] : "";
          state.provisions.push({ userId, nonce });
          if (state.failProvision) {
            res.writeHead(500).end();
            return;
          }
          const previous = provisionLocks.get(userId) ?? Promise.resolve();
          const work = previous.then(async () => {
            if (state.provisionDelayMs > 0) await new Promise((r) => setTimeout(r, state.provisionDelayMs));
            const existing = state.identities.get(userId);
            if (existing !== undefined) {
              res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ device: { id: existing.deviceId } }));
              return;
            }
            const keys = await newDeviceKeys();
            const challengeRes = await controlRequest("/v1/auth/device-challenge", jsonInit("POST", { deviceId: keys.deviceId }));
            const { challenge } = (await challengeRes.json()) as { challenge: string };
            const signature = await signChallenge(keys, challenge);
            const enroll = await controlRequest(
              "/v1/internal/cloud/devices/enroll",
              jsonInit(
                "POST",
                {
                  userId,
                  nonce,
                  deviceId: keys.deviceId,
                  devicePublicKey: keys.devicePublicKey,
                  agreementPublicKey: keys.agreementPublicKey,
                  challenge,
                  signature,
                },
                SERVICE_TOKEN,
              ),
            );
            const text = await enroll.text();
            if (enroll.status === 201) state.identities.set(userId, keys);
            res.writeHead(enroll.status, { "content-type": "application/json" }).end(text);
          });
          provisionLocks.set(userId, work.catch(() => undefined));
          await work;
          return;
        }
        if (req.method === "POST" && req.url === "/v1/tasks/steer") {
          state.steers.push(body as unknown as SteerBody);
          if (body["kind"] === "device.revoked") {
            const userId = typeof body["userId"] === "string" ? body["userId"] : "";
            const identity = state.identities.get(userId);
            if (identity?.deviceId === body["deviceId"]) state.identities.delete(userId);
          }
          res.writeHead(state.failSteer ? 500 : 204).end();
          return;
        }
        if (req.method === "POST" && req.url === "/v1/imessage/route") {
          const input = body as unknown as IMessageThreadRouteRequest;
          state.routes.push(input);
          if (state.failRoute) {
            res.writeHead(500).end();
            return;
          }
          const decision = typeof state.routeDecision === "function" ? state.routeDecision(input) : state.routeDecision;
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(decision));
          return;
        }
        res.writeHead(404).end();
      })().catch((err: unknown) => {
        res.writeHead(500).end(String(err));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${String(port)}`;
  return Object.assign(state, {
    url,
    client: httpRunnerClient({ baseUrl: url, serviceToken: SERVICE_TOKEN }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
}

/** Claim runs until `runId` comes back (other tests' runs are claimed along the way). */
export async function claimRun(
  h: Harness,
  runId: string,
  workerId = "worker-1",
): Promise<{ run: HostedRunRecord; leaseToken: string; thread: { spaceId: string; sealed: string } | null }> {
  for (let i = 0; i < 500; i += 1) {
    const res = await h.request("/v1/internal/runs/claim", jsonInit("POST", { workerId }, SERVICE_TOKEN));
    if (res.status === 204) break;
    expect(res.status).toBe(200);
    const claimed = await json<{ run: HostedRunRecord; leaseToken: string; thread: { spaceId: string; sealed: string } | null }>(res);
    if (claimed.run.id === runId) return claimed;
  }
  throw new Error(`run ${runId} was not claimable`);
}

/** Enable the cloud device for a space through `POST /cloud/enable`. */
export async function enableCloud(h: Harness, token: string, spaceId = "work"): Promise<Record<string, unknown>> {
  const res = await h.request("/v1/cloud/enable", jsonInit("POST", { spaceId }, token));
  expect(res.status).toBe(200);
  return (await json<{ device: Record<string, unknown> }>(res)).device;
}

export function serviceInit(method: string, body?: unknown): RequestInit {
  return body === undefined ? authed(SERVICE_TOKEN, method) : jsonInit(method, body, SERVICE_TOKEN);
}

/**
 * A service-bearer request that also presents a session lease. The lease
 * travels in a header, never in the query string: it authorises acting as the
 * person in their own Space, and control logs `url.search` on every request
 * (docs/web-browser-design.md §8.1).
 */
export function leasedInit(method: string, leaseToken: string, body?: unknown): RequestInit {
  const init = serviceInit(method, body);
  return {
    ...init,
    headers: { ...(init.headers as Record<string, string>), "x-pistachio-session-lease": leaseToken },
  };
}

/** Read an SSE body until `done(text)` holds or the stream ends. */
export async function readSse(res: Response, done: (text: string) => boolean, maxChunks = 200): Promise<string> {
  const reader = res.body?.getReader();
  if (reader === undefined) throw new Error("no body");
  const decoder = new TextDecoder();
  let text = "";
  for (let i = 0; i < maxChunks; i += 1) {
    if (done(text)) break;
    const { value, done: ended } = await reader.read();
    if (value !== undefined) text += decoder.decode(value, { stream: true });
    if (ended) break;
  }
  await reader.cancel().catch(() => undefined);
  return text;
}

/** Bounded event-loop yields until a condition holds (no wall-clock waits). */
export async function settle(predicate: () => boolean, maxTurns = 500): Promise<void> {
  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  if (!predicate()) throw new Error("condition did not settle");
}
