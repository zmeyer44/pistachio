/**
 * An in-process authenticated forward proxy speaking `407 Basic` for both
 * plain-HTTP forwarding (absolute-form requests) and CONNECT tunnels, with
 * every `Proxy-Authorization` it receives recorded.
 */

import { createServer, request as httpRequest, type Server } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";

export interface ProxyRecord {
  kind: "http" | "connect";
  target: string;
  proxyAuthorization: string | null;
  accepted: boolean;
}

export function basicAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

export class AuthProxy {
  readonly valid = new Set<string>();
  readonly records: ProxyRecord[] = [];
  readonly server: Server;
  host = "127.0.0.1";
  port = 0;

  constructor() {
    this.server = createServer((request, response) => {
      const authorization = request.headers["proxy-authorization"] ?? null;
      const target = request.url ?? "";
      const accepted = authorization !== null && this.valid.has(authorization);
      this.records.push({ kind: "http", target, proxyAuthorization: authorization, accepted });
      if (!accepted) {
        response.writeHead(407, {
          "proxy-authenticate": 'Basic realm="pistachio-egress"',
          connection: "close",
          "content-length": "0",
        });
        response.end();
        return;
      }
      let url: URL;
      try {
        url = new URL(target);
      } catch {
        response.writeHead(400, { connection: "close" });
        response.end("malformed target");
        return;
      }
      const headers = { ...request.headers };
      delete headers["proxy-authorization"];
      delete headers["proxy-connection"];
      const upstream = httpRequest(
        { host: url.hostname, port: Number(url.port || 80), method: request.method, path: `${url.pathname}${url.search}`, headers },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(response);
        },
      );
      upstream.on("error", () => {
        if (!response.headersSent) response.writeHead(502, { connection: "close" });
        response.end();
      });
      request.pipe(upstream);
    });
    this.server.on("connect", (request, socket, head) => {
      const authorization = request.headers["proxy-authorization"] ?? null;
      const target = request.url ?? "";
      const accepted = authorization !== null && this.valid.has(authorization);
      this.records.push({ kind: "connect", target, proxyAuthorization: authorization, accepted });
      // A client that cancels a proxy challenge (or drops a tunnel) resets the
      // connection. Without a listener on this raw socket Node rethrows the
      // ECONNRESET as an uncaught exception and fails the whole run.
      socket.on("error", () => socket.destroy());
      if (!accepted) {
        socket.write(
          'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="pistachio-egress"\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
        );
        socket.end();
        return;
      }
      const [host, port] = target.split(":");
      const upstream = connect(Number(port ?? "443"), host ?? "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
    });
    // Same for a half-written request head on a socket the client just reset.
    this.server.on("clientError", (_error, socket) => socket.destroy());
  }

  /** Accept exactly this credential from now on. */
  setCredential(username: string, password: string): void {
    this.valid.clear();
    this.valid.add(basicAuthorization(username, password));
  }

  get authorizations(): Array<string | null> {
    return this.records.map((record) => record.proxyAuthorization);
  }

  async start(): Promise<{ host: string; port: number }> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
    return { host: this.host, port: this.port };
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
