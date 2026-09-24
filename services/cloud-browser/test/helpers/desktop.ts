/**
 * A simulated desktop for the end-to-end suite (docs/cloud-sync-design.md
 * §10 without Electron): the control HTTP client, real device keys enrolled
 * through the public routes, `password` wrappers derived exactly as the
 * desktop derives them, a `SpaceSyncEngine` over the real `WsTransport`,
 * the run event stream over SSE, and a live-view socket.
 */

import { randomUUID } from "node:crypto";
import type { StoredRunEvent } from "@pistachio/protocol";
import {
  DeviceRegistryVerifier,
  SpaceSyncEngine,
  WsTransport,
  type CookieApplier,
  type TransportEvents,
  type TransportState,
} from "@pistachio/sync-engine";
import {
  deriveKekFromPassphrase,
  deviceLoginSigningBytes,
  exportPublicKeyRaw,
  fromBase64,
  generateAgreementKeypair,
  generateDeviceKeypair,
  importPublicKeyRaw,
  liveProofSealAad,
  seal,
  shellProofSealAad,
  toBase64,
  utf8,
  unwrapRootSecret,
  wrapRootSecret,
  type AgreementKeypair,
  type CookieAttributes,
  type CookieIdentity,
  type CookiePlain,
  type DeviceKeypair,
  type SpaceKeys,
} from "@pistachio/sync-protocol";
import WebSocket from "ws";
import { must, settle } from "./fixture-server.js";

export const PASSWORD = "correct-horse-battery";

/* ------------------------------ HTTP ------------------------------ */

export interface ApiResult {
  status: number;
  json: Record<string, unknown>;
}

export interface ApiInit {
  method?: string;
  body?: unknown;
  token?: string;
}

/** `fetch` against control's `/v1` routes; the body is parsed when present. */
export class ControlApi {
  constructor(readonly baseUrl: string) {}

  async call(path: string, init: ApiInit = {}): Promise<ApiResult> {
    const response = await fetch(`${this.baseUrl}/v1${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
      },
      body: init.body === undefined ? null : JSON.stringify(init.body),
    });
    const text = await response.text();
    return { status: response.status, json: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }
}

/* ------------------------------ accounts and devices ------------------------------ */

export interface Account {
  userId: string;
  email: string;
  bootstrapToken: string;
}

export async function signup(api: ControlApi, password = PASSWORD): Promise<Account> {
  const email = `${randomUUID().slice(0, 8)}@example.com`;
  const out = await api.call("/accounts", { body: { email, password } });
  if (out.status !== 201) throw new Error(`signup answered ${String(out.status)}: ${JSON.stringify(out.json)}`);
  return { userId: out.json["userId"] as string, email, bootstrapToken: out.json["bootstrapToken"] as string };
}

/** A fresh bootstrap token for the account (what a second desktop starts from). */
export async function passwordLogin(api: ControlApi, email: string, password = PASSWORD): Promise<string> {
  const out = await api.call("/auth/password-login", { body: { email, password } });
  if (out.status !== 200) throw new Error(`password login answered ${String(out.status)}`);
  return out.json["bootstrapToken"] as string;
}

export interface DesktopKeys {
  /** The one device id (D24): minted next to the keys, never changed. */
  deviceId: string;
  signing: DeviceKeypair;
  agreement: AgreementKeypair;
  devicePublicKey: string;
  agreementPublicKey: string;
}

export interface Desktop extends DesktopKeys {
  token: string;
}

export async function newDesktopKeys(): Promise<DesktopKeys> {
  const signing = await generateDeviceKeypair();
  const agreement = await generateAgreementKeypair();
  return {
    deviceId: randomUUID(),
    signing,
    agreement,
    devicePublicKey: toBase64(await exportPublicKeyRaw(signing.publicKey)),
    agreementPublicKey: toBase64(await exportPublicKeyRaw(agreement.publicKey)),
  };
}

export async function signChallenge(keys: DesktopKeys, challenge: string): Promise<string> {
  const bytes = deviceLoginSigningBytes(keys.deviceId, challenge);
  return toBase64(new Uint8Array(await crypto.subtle.sign("Ed25519", keys.signing.privateKey, bytes as BufferSource)));
}

/** `POST /auth/device-challenge` + `POST /devices/enroll` with the bootstrap token (§7.3). */
export async function enrollDesktop(api: ControlApi, bootstrapToken: string, name = "MacBook"): Promise<Desktop> {
  const keys = await newDesktopKeys();
  const challenged = await api.call("/auth/device-challenge", { body: { deviceId: keys.deviceId } });
  if (challenged.status !== 200) throw new Error(`device challenge answered ${String(challenged.status)}`);
  const challenge = challenged.json["challenge"] as string;
  const out = await api.call("/devices/enroll", {
    token: bootstrapToken,
    body: {
      deviceId: keys.deviceId,
      name,
      platform: "macos",
      devicePublicKey: keys.devicePublicKey,
      agreementPublicKey: keys.agreementPublicKey,
      challenge,
      signature: await signChallenge(keys, challenge),
    },
  });
  if (out.status !== 201) throw new Error(`enroll answered ${String(out.status)}: ${JSON.stringify(out.json)}`);
  const device = out.json["device"] as { id: string };
  if (device.id !== keys.deviceId) throw new Error("control changed the device id");
  return { ...keys, token: out.json["token"] as string };
}

/** `DeviceRegistryVerifier('reject')` from `GET /devices` (D15): every non-revoked device. */
export async function registryVerifier(api: ControlApi, token: string): Promise<DeviceRegistryVerifier> {
  const out = await api.call("/devices", { token });
  if (out.status !== 200) throw new Error(`GET /devices answered ${String(out.status)}`);
  const verifier = new DeviceRegistryVerifier("reject");
  const devices = out.json["devices"] as Array<{ id: string; devicePublicKey: string; revokedAt: string | null }>;
  for (const device of devices) {
    if (device.revokedAt !== null) continue;
    verifier.addDevice(device.id, await importPublicKeyRaw(fromBase64(device.devicePublicKey)));
  }
  return verifier;
}

/* ------------------------------ wrappers ------------------------------ */

export interface PasswordWrapperBody {
  kind: "password";
  credentialId: "password";
  salt: string;
  wrapped: string;
}

/** The desktop's `password` wrapper: PBKDF2 KEK from the account password, root secret sealed under it (§2). */
export async function passwordWrapper(secret: Uint8Array, spaceId: string, password: string): Promise<PasswordWrapperBody> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const kek = await deriveKekFromPassphrase(password, salt);
  const wrapped = await wrapRootSecret(kek, secret, spaceId);
  return { kind: "password", credentialId: "password", salt: toBase64(salt), wrapped: toBase64(wrapped) };
}

/** What a second desktop does with a stored `password` wrapper before enrolling. */
export async function openPasswordWrapper(
  row: { salt: string; wrapped: string },
  spaceId: string,
  password: string,
): Promise<Uint8Array> {
  const kek = await deriveKekFromPassphrase(password, fromBase64(row.salt));
  return unwrapRootSecret(kek, fromBase64(row.wrapped), spaceId);
}

/* ------------------------------ sync peer ------------------------------ */

/** A cookie identity as the desktop capture would build it for a plain-HTTP loopback origin. */
export function loopbackCookieIdentity(spaceId: string, host: string, name: string): CookieIdentity {
  return { spaceId, hostKey: host, name, path: "/", partitionKey: "", sourceScheme: "nonsecure" };
}

export function sessionCookieAttributes(value: string): CookieAttributes {
  return { value, expiresMs: null, persistent: false, secure: false, httpOnly: false, sameSite: "lax", priority: "medium" };
}

/** Records what the engine applied instead of writing an Electron session. */
export class CollectingApplier implements CookieApplier {
  readonly applied: CookiePlain[] = [];

  apply(plain: CookiePlain): Promise<void> {
    this.applied.push(plain);
    return Promise.resolve();
  }

  /** The most recent applied record for a cookie name. */
  find(name: string): CookiePlain | undefined {
    return [...this.applied].reverse().find((plain) => plain.identity.name === name);
  }

  has(name: string, value?: string): boolean {
    const plain = this.find(name);
    return plain !== undefined && !plain.deleted && (value === undefined || plain.attributes?.value === value);
  }
}

export interface DesktopPeerOptions {
  hubUrl: string;
  spaceId: string;
  keys: SpaceKeys;
  desktop: Desktop;
  verifier: DeviceRegistryVerifier;
}

/** One desktop's `SpaceSyncEngine` over the real hub, wired as `SyncService` wires it (§10.2). */
export class DesktopPeer {
  readonly spaceId: string;
  readonly applier = new CollectingApplier();
  readonly transport: WsTransport;
  readonly engine: SpaceSyncEngine;
  readonly states: TransportState[] = [];
  /** Origins the hub reported released (`lease.released`). */
  readonly released: string[] = [];
  hydrations = 0;
  revoked = false;

  constructor(options: DesktopPeerOptions) {
    this.spaceId = options.spaceId;
    const { desktop, verifier } = options;
    const events: TransportEvents = {
      getToken: () => Promise.resolve(desktop.token),
      authRequired: () => true,
      onStateChanged: (state) => {
        this.states.push(state);
        this.engine.setOnline(state === "connected");
      },
      onRecords: (spaceId, records) => {
        if (spaceId === this.spaceId) void this.engine.applyRemote(records);
      },
      onHydrated: (spaceId) => {
        if (spaceId === this.spaceId) this.hydrations += 1;
      },
      onPublishAccepted: (recordIds) => this.engine.publishAccepted(recordIds),
      onPublishRejected: (rejections) => {
        for (const rejection of rejections) void this.engine.publishRejected(rejection.recordId, rejection.reason);
      },
      onPublishInterrupted: (recordIds) => {
        for (const recordId of recordIds) void this.engine.publishRejected(recordId, "lease_required");
      },
      onLeaseRevoked: (_spaceId, originId) => this.engine.leaseRevoked(originId),
      onLeaseReleased: (_spaceId, originId) => {
        this.released.push(originId);
        this.engine.leaseReleased(originId);
      },
      onRevoked: () => {
        this.revoked = true;
      },
    };
    this.transport = new WsTransport(options.hubUrl, desktop.deviceId, "desktop", events);
    this.engine = new SpaceSyncEngine(
      options.spaceId,
      options.keys,
      { deviceId: desktop.deviceId, privateKey: desktop.signing.privateKey },
      this.transport,
      this.applier,
      {
        deviceId: desktop.deviceId,
        leaseKind: "desktop",
        verifier,
        deferToForeignLease: (denial) => denial.holderKind === "cloud",
      },
    );
  }

  /** Dial the hub (`hello {kind:'desktop'}`) and wait for the first hydration to finish. */
  async connect(): Promise<void> {
    this.transport.start([this.spaceId]);
    await settle(() => this.transport.state === "connected" && this.hydrations > 0, { turns: 400 });
  }

  stop(): void {
    this.transport.stop();
  }
}

/* ------------------------------ run events over SSE ------------------------------ */

export interface SseSubscription {
  /** Every `event: run` frame so far, in arrival order. */
  readonly events: StoredRunEvent[];
  /** The terminal status from `event: end`, or `"closed"` when the stream ended without one. */
  readonly end: Promise<string>;
  close(): Promise<void>;
}

/** `GET /runs/:id/events?since=` read as it streams (§7.8). */
export async function subscribeRunEvents(baseUrl: string, runId: string, token: string, since = 0): Promise<SseSubscription> {
  const response = await fetch(`${baseUrl}/v1/runs/${runId}/events?since=${String(since)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (response.status !== 200) throw new Error(`SSE subscribe answered ${String(response.status)}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) throw new Error(`SSE content-type is ${contentType}`);
  const reader = must(response.body, "an SSE body").getReader();
  const events: StoredRunEvent[] = [];
  let resolveEnd: (status: string) => void = () => undefined;
  const end = new Promise<string>((resolve) => {
    resolveEnd = resolve;
  });
  const handle = (block: string): void => {
    const lines = block.split("\n");
    const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
    const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
    if (event === "run" && data !== undefined) events.push(JSON.parse(data) as StoredRunEvent);
    if (event === "end" && data !== undefined) resolveEnd((JSON.parse(data) as { status: string }).status);
  };
  const pump = async (): Promise<void> => {
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const next = await reader.read();
      if (next.value !== undefined) buffer += decoder.decode(next.value, { stream: true });
      let separator = buffer.indexOf("\n\n");
      while (separator !== -1) {
        handle(buffer.slice(0, separator));
        buffer = buffer.slice(separator + 2);
        separator = buffer.indexOf("\n\n");
      }
      if (next.done) break;
    }
    resolveEnd("closed");
  };
  void pump().catch(() => resolveEnd("closed"));
  return {
    events,
    end,
    close: () => reader.cancel().catch(() => undefined),
  };
}

/* ------------------------------ live view ------------------------------ */

export interface LiveSocket {
  ws: WebSocket;
  /** Null when the upgrade succeeded; the HTTP status when it was rejected. */
  status: number | null;
  frames: Array<Record<string, unknown>>;
  closed: Promise<number>;
}

/** Dial the runner's `GET /v1/live/:runId` with `Authorization: Bearer <token>` (§8.5). */
/**
 * Open a live view with a ticket from control (§8.5). Pass `sealKey` to
 * answer the runner's Space-key challenge, as a real client does; without it
 * the socket opens and is closed 4004 a moment later.
 */
export function openLiveView(
  runnerPort: number,
  runId: string,
  ticket: string,
  sealKey?: CryptoKey,
): Promise<LiveSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${String(runnerPort)}/v1/live/${runId}`, {
    headers: { authorization: `Bearer ${ticket}` },
  });
  const frames: Array<Record<string, unknown>> = [];
  ws.on("message", (data) => {
    const frame = JSON.parse(data.toString()) as Record<string, unknown>;
    if (frame["t"] === "challenge" && sealKey !== undefined) {
      const nonce = frame["nonce"] as string;
      void seal(sealKey, utf8(nonce), liveProofSealAad(runId, nonce)).then((proof) => {
        ws.send(JSON.stringify({ t: "auth", proof: toBase64(proof) }));
      });
      return;
    }
    frames.push(frame);
  });
  ws.on("error", () => undefined);
  const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
  return new Promise((resolve) => {
    ws.once("open", () => resolve({ ws, status: null, frames, closed }));
    ws.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve({ ws, status: response.statusCode ?? 0, frames, closed });
    });
  });
}

/* ------------------------------ shell socket ------------------------------ */

export interface ShellSocket {
  ws: WebSocket;
  /** Null when the upgrade succeeded; the HTTP status when it was rejected. */
  status: number | null;
  frames: Array<Record<string, unknown>>;
  closed: Promise<number>;
  /** One RPC call over the envelope (§5); resolves with the reply's result. */
  call(method: string, args?: unknown[]): Promise<unknown>;
  /** Human input under a control generation (W7). */
  input(tabId: string, generation: number, event: Record<string, unknown>): void;
  /** The frames of one kind, newest last. */
  of(kind: string): Array<Record<string, unknown>>;
}

/**
 * Dial a worker's shell socket with a ticket from control and answer its
 * Space-key challenge (§5), the way `/app/browse` does.
 */
export function openShellSocket(
  runnerPort: number,
  sessionId: string,
  ticket: string,
  sealKey: CryptoKey,
): Promise<ShellSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${String(runnerPort)}/v1/shell/${sessionId}?access_token=${ticket}`);
  const frames: Array<Record<string, unknown>> = [];
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  ws.on("message", (data) => {
    const frame = JSON.parse(data.toString()) as Record<string, unknown>;
    if (frame["t"] === "challenge") {
      const nonce = frame["nonce"] as string;
      void seal(sealKey, utf8(nonce), shellProofSealAad(sessionId, nonce)).then((proof) => {
        ws.send(JSON.stringify({ t: "auth", proof: toBase64(proof) }));
      });
      return;
    }
    if (frame["t"] === "reply") {
      const waiter = pending.get(String(frame["id"]));
      pending.delete(String(frame["id"]));
      if (frame["ok"] === true) waiter?.resolve(frame["result"]);
      else waiter?.reject(new Error(JSON.stringify(frame["error"])));
      return;
    }
    frames.push(frame);
  });
  ws.on("error", () => undefined);
  const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
  const socket: ShellSocket = {
    ws,
    status: null,
    frames,
    closed,
    call: (method, args = []) => {
      nextId += 1;
      const id = String(nextId);
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ t: "call", id, method, args }));
      });
    },
    input: (tabId, generation, event) => {
      ws.send(JSON.stringify({ t: "input", tabId, generation, event }));
    },
    of: (kind) => frames.filter((frame) => frame["t"] === kind),
  };
  return new Promise((resolve) => {
    ws.once("open", () => {
      void settle(() => frames.some((frame) => frame["t"] === "ready"), { turns: 400 }).then(() => resolve(socket));
    });
    ws.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve({ ...socket, status: response.statusCode ?? 0 });
    });
  });
}
