/**
 * Loopback fixtures: a real gateway on an ephemeral port, a real echo server
 * behind it, a fake control plane, and a small raw-socket client that speaks
 * CONNECT.
 */

import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";

import { Authenticator, RevocationSet, SharedSecretVerifier, type TokenVerifier } from "../src/auth.js";
import { silentLogger } from "../src/config.js";
import type { ThrottleSource } from "../src/limits.js";
import { EgressMetrics } from "../src/metrics.js";
import {
  basicProxyAuthorization,
  bearerProxyAuthorization,
  mintCredential,
  type MintedCredential,
} from "../src/mint.js";
import type { DialFn, LookupFn } from "../src/policy.js";
import type { RevocationEntry } from "../src/revocation.js";
import {
  createEgressServer,
  type EgressLimits,
  type EgressServer,
  type EgressTimeouts,
} from "../src/server.js";
import { TunnelRegistry } from "../src/tunnels.js";

export const SECRET_HEX = "ab".repeat(32);
export const OTHER_SECRET_HEX = "cd".repeat(32);
export const USER_A = "11111111-1111-4111-8111-111111111111";
export const DEVICE_A = "22222222-2222-4222-8222-222222222222";
export const USER_B = "33333333-3333-4333-8333-333333333333";
export const DEVICE_B = "44444444-4444-4444-8444-444444444444";

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms: ${label}`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function credentialFor(
  userId = USER_A,
  deviceId = DEVICE_A,
  options: { readonly secretHex?: string; readonly expiresAtSeconds?: number; readonly credentialId?: string } = {},
): MintedCredential {
  const minted: MintedCredential = mintCredential({
    secretHex: options.secretHex ?? SECRET_HEX,
    userId,
    deviceId,
    ...(options.credentialId === undefined ? {} : { credentialId: options.credentialId }),
    ...(options.expiresAtSeconds === undefined ? {} : { expiresAtSeconds: options.expiresAtSeconds }),
  });
  return minted;
}

export const basic = (c: MintedCredential): string => basicProxyAuthorization(c);
export const bearer = (c: MintedCredential): string => bearerProxyAuthorization(c);

export interface ParsedResponse {
  readonly status: number;
  readonly statusLine: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Buffers everything a socket receives so tests can read exact byte counts. */
export class SocketReader {
  readonly socket: net.Socket;
  #chunks: Buffer[] = [];
  #buffered = 0;
  #ended = false;
  #waiters: Array<() => void> = [];

  constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => {
      this.#chunks.push(chunk);
      this.#buffered += chunk.length;
      this.#wake();
    });
    const end = (): void => {
      this.#ended = true;
      this.#wake();
    };
    socket.on("end", end);
    socket.on("close", end);
    socket.on("error", end);
  }

  get ended(): boolean {
    return this.#ended;
  }

  get buffered(): number {
    return this.#buffered;
  }

  #wake(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const wake of waiters) wake();
  }

  #wait(): Promise<void> {
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  #buffer(): Buffer {
    const joined = Buffer.concat(this.#chunks);
    this.#chunks = joined.length === 0 ? [] : [joined];
    return joined;
  }

  #consume(n: number): Buffer {
    const buffer = this.#buffer();
    const out = Buffer.from(buffer.subarray(0, n));
    const rest = buffer.subarray(n);
    this.#chunks = rest.length === 0 ? [] : [Buffer.from(rest)];
    this.#buffered = rest.length;
    return out;
  }

  async readExact(n: number): Promise<Buffer> {
    while (this.#buffered < n) {
      if (this.#ended) throw new Error(`socket ended with ${this.#buffered}/${n} bytes buffered`);
      await this.#wait();
    }
    return this.#consume(n);
  }

  /** Read up to and including `\r\n\r\n`. */
  async readHead(): Promise<string> {
    for (;;) {
      const buffer = this.#buffer();
      const at = buffer.indexOf("\r\n\r\n");
      if (at >= 0) return this.#consume(at + 4).toString("latin1");
      if (this.#ended) {
        throw new Error(`socket ended before a response head: ${JSON.stringify(buffer.toString("latin1"))}`);
      }
      await this.#wait();
    }
  }

  /** Read a full response: head plus `Content-Length` bytes of body. */
  async readResponse(): Promise<ParsedResponse> {
    const head = await this.readHead();
    const lines = head.slice(0, -4).split("\r\n");
    const statusLine = lines[0] ?? "";
    const headers: Record<string, string> = {};
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(":");
      if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    const status = Number(statusLine.split(" ")[1] ?? "0");
    const length = Number(headers["content-length"] ?? "0");
    const body = length > 0 ? (await this.readExact(length)).toString("utf8") : "";
    return { status, statusLine, headers, body };
  }

  /** Resolves once the peer has closed; returns whatever arrived meanwhile. */
  async readToEnd(): Promise<Buffer> {
    while (!this.#ended) await this.#wait();
    return this.#consume(this.#buffered);
  }
}

export interface EchoServer {
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Echo server on an ephemeral loopback port. Echoes every byte back. With
 * `farewell`, the client's half-close is answered with `bye` before the
 * server closes its own write half, so half-close forwarding is observable in
 * both directions.
 */
export async function startEcho(options: { readonly farewell?: boolean } = {}): Promise<EchoServer> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (chunk: Buffer) => {
      socket.write(chunk);
    });
    socket.on("end", () => {
      if (options.farewell === true) socket.end(Buffer.from("bye"));
      else socket.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** An ephemeral loopback port nothing is listening on (just released). */
export async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export interface GatewayOptions {
  /** Production-shaped policy (loopback refused). Default: permissive for the echo server. */
  readonly strict?: boolean;
  readonly extraPorts?: ReadonlyArray<number>;
  readonly timeouts?: EgressTimeouts;
  readonly limits?: EgressLimits;
  readonly throttle?: ThrottleSource | null;
  readonly ownerUserId?: string | null;
  readonly lookup?: LookupFn;
  readonly dial?: DialFn;
  readonly verifier?: TokenVerifier;
  readonly now?: () => number;
}

export interface GatewayHarness {
  readonly server: EgressServer;
  readonly port: number;
  readonly revocations: RevocationSet;
  readonly metrics: EgressMetrics;
  readonly tunnels: TunnelRegistry;
  connect(): Promise<SocketReader>;
  /** Open a socket and send a CONNECT head; `auth` is a full `Proxy-Authorization` value. */
  connectTo(target: string, auth: string | null, extra?: Buffer): Promise<SocketReader>;
  close(): Promise<void>;
}

export async function startGateway(options: GatewayOptions = {}): Promise<GatewayHarness> {
  const revocations = new RevocationSet();
  const metrics = new EgressMetrics();
  const tunnels = new TunnelRegistry();
  const authenticator = new Authenticator({
    verifier: options.verifier ?? SharedSecretVerifier.fromHex(SECRET_HEX),
    revocations,
    ownerUserId: options.ownerUserId ?? null,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const server = createEgressServer({
    authenticator,
    policy: {
      extraPorts: options.extraPorts ?? [],
      ...(options.strict === true ? {} : { allowPrivateTargets: true }),
    },
    metrics,
    tunnels,
    throttle: options.throttle ?? null,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.timeouts === undefined ? {} : { timeouts: options.timeouts }),
    ...(options.lookup === undefined ? {} : { lookup: options.lookup }),
    ...(options.dial === undefined ? {} : { dial: options.dial }),
    ...(options.now === undefined ? {} : { now: options.now }),
    log: silentLogger,
  });
  const address = await server.listen("127.0.0.1", 0);
  const clients = new Set<net.Socket>();
  const connect = async (): Promise<SocketReader> => {
    const socket = net.connect({ host: "127.0.0.1", port: address.port });
    clients.add(socket);
    socket.once("close", () => clients.delete(socket));
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return new SocketReader(socket);
  };
  return {
    server,
    port: address.port,
    revocations,
    metrics,
    tunnels,
    connect,
    async connectTo(target, auth, extra) {
      const reader = await connect();
      const lines = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`];
      if (auth !== null) lines.push(`Proxy-Authorization: ${auth}`);
      const head = Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1");
      reader.socket.write(extra === undefined ? head : Buffer.concat([head, extra]));
      return reader;
    },
    async close() {
      for (const socket of clients) socket.destroy();
      await server.close();
    },
  };
}

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

export interface FakeControl {
  readonly url: string;
  readonly token: string;
  readonly requests: RecordedRequest[];
  readonly usage: RecordedRequest[];
  readonly revocations: RevocationEntry[];
  readonly throttled: Set<string>;
  /** Rows returned per `GET /v1/egress/revocations`, as control caps them. */
  revocationPageLimit: number;
  /** When set, every request is answered with this status and an empty body. */
  failWith: number | null;
  close(): Promise<void>;
}

/** Control caps one revocation page at 1000 rows (services/control/src/app.ts). */
export const REVOCATION_PAGE_LIMIT = 1000;

/** Control's gateway-facing routes (§7.3), just enough to drive the pollers. */
export async function startFakeControl(token = "gateway-token"): Promise<FakeControl> {
  const requests: RecordedRequest[] = [];
  const usage: RecordedRequest[] = [];
  const revocations: RevocationEntry[] = [];
  const throttled = new Set<string>();
  const state = { failWith: null as number | null, revocationPageLimit: REVOCATION_PAGE_LIMIT };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = null;
      if (raw !== "") {
        try {
          body = JSON.parse(raw) as unknown;
        } catch {
          body = raw;
        }
      }
      const recorded: RecordedRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        authorization: req.headers.authorization,
        body,
      };
      requests.push(recorded);
      const reply = (status: number, payload: unknown): void => {
        const text = JSON.stringify(payload);
        res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) });
        res.end(text);
      };
      if (state.failWith !== null) {
        reply(state.failWith, { error: "forced" });
        return;
      }
      if (req.headers.authorization !== `Bearer ${token}`) {
        reply(401, { error: "unauthorized" });
        return;
      }
      const url = new URL(req.url ?? "/", "http://control.invalid");
      if (req.method === "POST" && url.pathname === "/v1/usage/egress") {
        usage.push(recorded);
        reply(201, { ok: true });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/egress/revocations") {
        const since = Number(url.searchParams.get("since") ?? "0");
        const fresh = revocations.filter((entry) => entry.id > since).slice(0, state.revocationPageLimit);
        const cursor = fresh.reduce((max, entry) => Math.max(max, entry.id), since);
        // Control's rule (services/control/src/app.ts): the cursor names a row
        // that has been pruned, so nothing between it and the retained floor
        // can be proven delivered.
        const floor = revocations.reduce((min, entry) => Math.min(min, entry.id), Number.POSITIVE_INFINITY);
        const reset = since > 0 && revocations.length > 0 && floor > since;
        reply(200, { revocations: fresh, cursor, reset });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/egress/limits") {
        const userId = url.searchParams.get("userId") ?? "";
        reply(200, { userId, throttled: throttled.has(userId) });
        return;
      }
      reply(404, { error: "not_found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    requests,
    usage,
    revocations,
    throttled,
    get revocationPageLimit() {
      return state.revocationPageLimit;
    },
    set revocationPageLimit(value: number) {
      state.revocationPageLimit = value;
    },
    get failWith() {
      return state.failWith;
    },
    set failWith(value: number | null) {
      state.failWith = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
