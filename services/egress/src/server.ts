/**
 * The identity egress gateway (docs/cloud-sync-design.md §9): a blind HTTP
 * CONNECT proxy.
 *
 * The request flow is deliberately short: parse the CONNECT target,
 * authenticate the credential, apply caps and throttles, vet the target,
 * resolve and re-check, dial, answer `200 Connection Established`, then
 * splice bytes until either side closes or the tunnel idles. Everything after
 * the 200 is an opaque byte splice — TLS stays end-to-end between the client
 * and the site. Anything that is not CONNECT gets a 405 (except
 * `GET /healthz`): the gateway is not, and must never become, a plaintext
 * HTTP proxy. Nothing here logs a hostname.
 *
 * Also the process entry (`pnpm start` → `tsx src/server.ts`): resolving the
 * environment fail-closed and listening.
 */

import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { AddressInfo } from "node:net";

import { Authenticator, RevocationSet, authFailureStatus } from "./auth.js";
import {
  ENV,
  HEAD_READ_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  MAX_HEAD_BYTES,
  MAX_TUNNELS_PER_DEVICE,
  MAX_TUNNELS_PER_USER,
  PROXY_AUTH_REALM,
  consoleLogger,
  isEntrypoint,
  silentLogger,
  type Logger,
} from "./config.js";
import { ControlClient } from "./control.js";
import { LimitsPoller, type ThrottleSource } from "./limits.js";
import { EgressMetrics, MetricsFlusher, type ConnectionSample } from "./metrics.js";
import {
  dialAny,
  resolveTarget,
  type DialFn,
  type LookupFn,
  type TargetPolicyOptions,
} from "./policy.js";
import { RevocationPoller } from "./revocation.js";
import { StartupError, resolveStartup, type StartupConfig } from "./startup.js";
import { Tunnel, TunnelRegistry, type TunnelIdentity } from "./tunnels.js";

export interface EgressTimeouts {
  /** Time to deliver a complete request head (`server.headersTimeout`). */
  readonly headReadMs?: number;
  /** Shared idle deadline of a spliced tunnel. */
  readonly idleMs?: number;
  /** Per-address upstream connect timeout. */
  readonly dialMs?: number;
  /** How often Node checks `headersTimeout` (`connectionsCheckingInterval`). */
  readonly connectionsCheckingIntervalMs?: number;
}

export interface EgressLimits {
  readonly maxTunnelsPerDevice?: number;
  readonly maxTunnelsPerUser?: number;
}

export interface EgressServerOptions {
  readonly authenticator: Authenticator;
  readonly policy?: TargetPolicyOptions;
  readonly metrics?: EgressMetrics;
  readonly tunnels?: TunnelRegistry;
  readonly throttle?: ThrottleSource | null;
  readonly limits?: EgressLimits;
  readonly timeouts?: EgressTimeouts;
  /** PEM material; when set the listener speaks TLS (an `https://` proxy). */
  readonly tls?: { readonly cert: string | Buffer; readonly key: string | Buffer } | null;
  readonly lookup?: LookupFn;
  readonly dial?: DialFn;
  readonly now?: () => number;
  readonly log?: Logger;
}

export interface TunnelClosedEvent {
  readonly identity: TunnelIdentity;
  readonly sample: ConnectionSample;
}

export interface EgressServerEvents {
  "tunnel:opened": [TunnelIdentity];
  "tunnel:closed": [TunnelClosedEvent];
}

export interface ConnectTarget {
  /** As written on the request line; IPv6 literals keep their brackets. */
  readonly host: string;
  readonly port: number;
}

/** Parse the CONNECT authority: `host:port` or `[v6]:port`, port 1..65535. */
export function parseConnectTarget(authority: string): ConnectTarget | null {
  let host: string;
  let portText: string;
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    if (end < 0 || authority[end + 1] !== ":") return null;
    host = authority.slice(0, end + 1);
    portText = authority.slice(end + 2);
  } else {
    const colon = authority.lastIndexOf(":");
    if (colon <= 0) return null;
    host = authority.slice(0, colon);
    portText = authority.slice(colon + 1);
  }
  if (host === "" || /[\s/@?#\\]/.test(host)) return null;
  if (!/^[0-9]{1,5}$/.test(portText)) return null;
  const port = Number(portText);
  if (port < 1 || port > 65535) return null;
  return { host, port };
}

const CONNECT_ONLY_BODY = "CONNECT only";
const HEALTHZ_BODY = '{"ok":true}';

function statusLine(status: number): string {
  const reasons: Record<number, string> = {
    400: "Bad Request",
    403: "Forbidden",
    407: "Proxy Authentication Required",
    408: "Request Timeout",
    429: "Too Many Requests",
    502: "Bad Gateway",
  };
  return `HTTP/1.1 ${status} ${reasons[status] ?? ""}`.trimEnd();
}

/** A terse plain-text refusal on a raw socket, then a clean end. */
function respond(
  socket: net.Socket,
  status: number,
  body: string,
  extraHeaders: ReadonlyArray<string> = [],
): void {
  if (socket.destroyed || !socket.writable) return;
  const payload = `${body}\n`;
  const head = [
    statusLine(status),
    ...extraHeaders,
    "Content-Type: text/plain",
    `Content-Length: ${Buffer.byteLength(payload)}`,
    "Connection: close",
    "",
    "",
  ].join("\r\n");
  socket.end(head + payload);
}

function respondProxyAuthRequired(socket: net.Socket): void {
  respond(socket, 407, "proxy authentication required", [
    `Proxy-Authenticate: Basic realm="${PROXY_AUTH_REALM}"`,
  ]);
}

const noop = (): void => {};

/** How far a client-side dial deadline sits above the dial's own timeout, so
 * the dial gives up first and `dialAny` moves on to the next address. */
const DIAL_DEADLINE_GRACE_MS = 1_000;

export class EgressServer extends EventEmitter<EgressServerEvents> {
  readonly tunnels: TunnelRegistry;
  readonly metrics: EgressMetrics;
  readonly authenticator: Authenticator;
  readonly #server: http.Server;
  readonly #sockets = new Set<net.Socket>();
  readonly #policy: TargetPolicyOptions;
  readonly #throttle: ThrottleSource | null;
  readonly #maxPerDevice: number;
  readonly #maxPerUser: number;
  readonly #headReadMs: number;
  readonly #idleMs: number;
  readonly #dialMs: number | undefined;
  readonly #lookup: LookupFn | undefined;
  readonly #dial: DialFn | undefined;
  readonly #now: () => number;
  readonly #log: Logger;

  constructor(options: EgressServerOptions) {
    super();
    this.authenticator = options.authenticator;
    this.tunnels = options.tunnels ?? new TunnelRegistry();
    this.metrics = options.metrics ?? new EgressMetrics();
    this.#policy = options.policy ?? {};
    this.#throttle = options.throttle ?? null;
    this.#maxPerDevice = options.limits?.maxTunnelsPerDevice ?? MAX_TUNNELS_PER_DEVICE;
    this.#maxPerUser = options.limits?.maxTunnelsPerUser ?? MAX_TUNNELS_PER_USER;
    this.#idleMs = options.timeouts?.idleMs ?? IDLE_TIMEOUT_MS;
    this.#dialMs = options.timeouts?.dialMs;
    this.#lookup = options.lookup;
    this.#dial = options.dial;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? silentLogger;

    const headReadMs = options.timeouts?.headReadMs ?? HEAD_READ_TIMEOUT_MS;
    this.#headReadMs = headReadMs;
    const serverOptions: http.ServerOptions = {
      maxHeaderSize: MAX_HEAD_BYTES,
      connectionsCheckingInterval: options.timeouts?.connectionsCheckingIntervalMs ?? 30_000,
    };
    const tls = options.tls ?? null;
    this.#server =
      tls === null
        ? http.createServer(serverOptions)
        : https.createServer({ ...serverOptions, cert: tls.cert, key: tls.key });
    this.#server.headersTimeout = headReadMs;
    // Inactivity bound for sockets that never send a byte (headersTimeout
    // only starts once a request line begins to arrive).
    this.#server.timeout = headReadMs;
    this.#server.on("timeout", (socket: net.Socket) => {
      respond(socket, 408, "request head timed out");
      socket.destroy();
    });
    this.#server.on("connection", (socket: net.Socket) => {
      this.#sockets.add(socket);
      socket.once("close", () => this.#sockets.delete(socket));
    });
    this.#server.on("request", (req, res) => this.#onRequest(req, res));
    this.#server.on("connect", (req, socket: net.Socket, head: Buffer) =>
      this.#onConnect(req, socket, head),
    );
  }

  get server(): http.Server {
    return this.#server;
  }

  address(): AddressInfo | null {
    const address = this.#server.address();
    return typeof address === "object" ? address : null;
  }

  listen(host: string, port: number): Promise<AddressInfo> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.#server.once("error", onError);
      this.#server.listen(port, host, () => {
        this.#server.removeListener("error", onError);
        const address = this.address();
        if (address === null) reject(new Error("listener has no address"));
        else resolve(address);
      });
    });
  }

  /** Cut every tunnel and socket, then close the listener. */
  async close(): Promise<void> {
    this.tunnels.destroyAll();
    for (const socket of this.#sockets) socket.destroy();
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
    });
  }

  #onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    let pathname = "";
    try {
      pathname = new URL(req.url ?? "", "http://gateway.invalid").pathname;
    } catch {
      pathname = "";
    }
    if (req.method === "GET" && pathname === "/healthz") {
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(HEALTHZ_BODY)),
      });
      res.end(HEALTHZ_BODY);
      return;
    }
    // CONNECT-only: refusing other methods is what keeps the gateway blind —
    // a GET handler would mean reading user request content.
    const body = `${CONNECT_ONLY_BODY}\n`;
    res.writeHead(405, {
      "content-type": "text/plain",
      "content-length": String(Buffer.byteLength(body)),
      allow: "CONNECT",
      connection: "close",
    });
    res.end(body);
  }

  #onConnect(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
    // Node detached its own listeners when it emitted 'connect'; without an
    // error listener a reset from the client would crash the process.
    socket.on("error", noop);
    socket.once("timeout", () => {
      respond(socket, 408, "request head timed out");
      socket.destroy();
    });

    const target = parseConnectTarget(req.url ?? "");
    if (target === null) {
      respond(socket, 400, "malformed CONNECT target");
      return;
    }

    const auth = this.authenticator.authenticate(req.headers["proxy-authorization"]);
    if (!auth.ok) {
      if (authFailureStatus(auth.reason) === 403) {
        respond(socket, 403, "credential is not valid for this gateway");
      } else {
        respondProxyAuthRequired(socket);
      }
      return;
    }
    const { userId, deviceId, credentialId } = auth.credential;

    this.#throttle?.noteUser(userId);
    if (this.#throttle?.isThrottled(userId) === true) {
      respond(socket, 429, "egress throttled for this user");
      return;
    }
    if (this.tunnels.countForDevice(deviceId) >= this.#maxPerDevice) {
      respond(socket, 429, "too many tunnels for this device");
      return;
    }
    if (this.tunnels.countForUser(userId) >= this.#maxPerUser) {
      respond(socket, 429, "too many tunnels for this user");
      return;
    }

    const tunnel = new Tunnel({ userId, deviceId, credentialId }, socket, this.#now());
    this.tunnels.add(tunnel);
    void this.#establish(tunnel, target, head);
  }

  /**
   * Resolve and dial, with a deadline armed **per phase**. The head-read
   * deadline is the socket's until the head arrives; leaving it armed through
   * DNS and a sequential dial answers 408 while a perfectly good second
   * address is still untried — which is exactly what one blackholed AAAA
   * record produces. So: a fresh budget for the resolve, then a fresh budget
   * for each dial attempt (`onAttempt`), sitting just above the dial's own
   * timeout so the dial always gives up first and the next address is tried.
   */
  async #establish(tunnel: Tunnel, target: ConnectTarget, head: Buffer): Promise<void> {
    const { client } = tunnel;
    client.setTimeout(this.#headReadMs);
    const resolution = await resolveTarget(target.host, target.port, this.#policy, this.#lookup);
    if (tunnel.destroyed || client.destroyed) {
      this.tunnels.remove(tunnel);
      return;
    }
    if (!resolution.ok) {
      this.tunnels.remove(tunnel);
      respond(client, 403, resolution.body);
      return;
    }
    const dialOptions = this.#dialMs === undefined ? { dial: this.#dial } : { dial: this.#dial, timeoutMs: this.#dialMs };
    const upstream = await dialAny(resolution.addresses, target.port, {
      ...dialOptions,
      onAttempt: (_address, timeoutMs) => {
        if (!client.destroyed) client.setTimeout(timeoutMs + DIAL_DEADLINE_GRACE_MS);
      },
    });
    if (tunnel.destroyed || client.destroyed) {
      upstream?.destroy();
      this.tunnels.remove(tunnel);
      return;
    }
    if (upstream === null) {
      this.tunnels.remove(tunnel);
      respond(client, 502, "could not reach target");
      return;
    }
    tunnel.upstream = upstream;
    this.#splice(tunnel, upstream, head);
  }

  /**
   * The blind splice: bytes are counted and forwarded, never inspected. One
   * shared idle deadline covers both directions and resets on any traffic,
   * so only a tunnel that is genuinely doing nothing is reclaimed. Half-close
   * is preserved: an EOF from one side ends the other's write half and the
   * remaining direction keeps flowing.
   */
  #splice(tunnel: Tunnel, upstream: net.Socket, head: Buffer): void {
    const { client } = tunnel;
    client.setTimeout(0);
    client.allowHalfOpen = true;
    client.setNoDelay(true);
    upstream.setTimeout(0);
    upstream.allowHalfOpen = true;
    upstream.on("error", noop);

    const idle = setTimeout(() => {
      this.#log.info("tunnel closed after idle timeout");
      tunnel.destroy();
    }, this.#idleMs);
    idle.unref();

    const finish = (): void => {
      if (!client.closed || !upstream.closed) return;
      clearTimeout(idle);
      if (!this.tunnels.remove(tunnel)) return;
      const sample: ConnectionSample = {
        bytesToTarget: tunnel.bytesToTarget,
        bytesToClient: tunnel.bytesToClient,
        durationMs: this.#now() - tunnel.startedAt,
      };
      this.metrics.record(tunnel.identity.userId, sample);
      this.emit("tunnel:closed", { identity: tunnel.identity, sample });
    };

    const forward = (
      source: net.Socket,
      sink: net.Socket,
      count: (bytes: number) => void,
    ): void => {
      source.on("data", (chunk: Buffer) => {
        count(chunk.length);
        idle.refresh();
        if (sink.destroyed) return;
        if (!sink.write(chunk)) {
          source.pause();
          sink.once("drain", () => source.resume());
        }
      });
      source.on("end", () => {
        if (!sink.destroyed) sink.end();
      });
      source.on("close", () => {
        if (!sink.destroyed) sink.destroySoon();
        finish();
      });
    };

    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    // Bytes the client pipelined behind its CONNECT head (typically the TLS
    // ClientHello) must reach the target or the tunnel deadlocks.
    if (head.length > 0) {
      tunnel.bytesToTarget += head.length;
      upstream.write(head);
    }
    forward(client, upstream, (n) => {
      tunnel.bytesToTarget += n;
    });
    forward(upstream, client, (n) => {
      tunnel.bytesToClient += n;
    });
    this.emit("tunnel:opened", tunnel.identity);
  }
}

export function createEgressServer(options: EgressServerOptions): EgressServer {
  return new EgressServer(options);
}

/** Everything `runGateway` wires up, so a caller can stop it. */
export interface RunningGateway {
  readonly server: EgressServer;
  readonly config: StartupConfig;
  stop(): Promise<void>;
}

/**
 * Resolve the environment (exit 1 when it cannot be served safely), listen,
 * and start the control-plane pollers when `EGRESS_CONTROL_URL` is set.
 */
export async function runGateway(
  env: NodeJS.ProcessEnv = process.env,
  log: Logger = consoleLogger,
): Promise<RunningGateway> {
  let config: StartupConfig;
  try {
    config = resolveStartup(env);
  } catch (error) {
    log.error(error instanceof StartupError ? error.message : String(error));
    process.exit(1);
  }
  for (const warning of config.warnings) log.warn(warning);
  if (config.devInsecure) {
    log.warn(`${ENV.devInsecure}=1: credentials are NOT authenticated; loopback-only listener`);
  }

  const revocations = new RevocationSet();
  const authenticator = new Authenticator({
    verifier: config.verifier,
    revocations,
    ownerUserId: config.ownerUserId,
  });
  const metrics = new EgressMetrics();
  const tunnels = new TunnelRegistry();

  const pollers: Array<{ start(): void; stop(): void }> = [];
  let throttle: LimitsPoller | null = null;
  let flusher: MetricsFlusher | null = null;
  if (config.control !== null) {
    const control = new ControlClient(config.control);
    throttle = new LimitsPoller({ control, ownerUserId: config.ownerUserId, tunnels, log });
    flusher = new MetricsFlusher({ metrics, control, log });
    pollers.push(new RevocationPoller({ control, revocations, tunnels, log }), throttle, flusher);
  }

  const server = createEgressServer({
    authenticator,
    policy: { extraPorts: config.extraPorts },
    metrics,
    tunnels,
    throttle,
    tls: config.tls,
    log,
  });
  const address = await server.listen(config.listen.host, config.listen.port);
  log.info(
    `listening on ${address.address}:${address.port} (CONNECT only${config.tls === null ? "" : ", TLS"})`,
  );
  for (const poller of pollers) poller.start();

  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    if (stopping === null) {
      stopping = (async () => {
        for (const poller of pollers) poller.stop();
        await server.close();
        await flusher?.flushNow();
      })();
    }
    return stopping;
  };
  return { server, config, stop };
}

if (isEntrypoint(import.meta.url)) {
  const running = await runGateway(process.env);
  const shutdown = (): void => {
    void running.stop().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
