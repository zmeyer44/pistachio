import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FixtureServer {
  server: Server;
  origin: string;
  host: string;
  port: number;
  close(): Promise<void>;
}

export type FixtureHandler = (request: IncomingMessage, response: ServerResponse, body: Buffer) => void;

/** A plain HTTP origin on an ephemeral loopback port. */
export async function startFixture(handler: FixtureHandler): Promise<FixtureServer> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => handler(request, response, Buffer.concat(chunks)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    origin: `http://127.0.0.1:${String(port)}`,
    host: "127.0.0.1",
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Bounded event-loop yields until a condition holds; never a wall-clock wait on ordering. */
export async function settle(predicate: () => boolean, options: { turns?: number; stepMs?: number } = {}): Promise<void> {
  const turns = options.turns ?? 400;
  const stepMs = options.stepMs ?? 25;
  for (let turn = 0; turn < turns; turn += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, stepMs));
  }
  if (!predicate()) throw new Error("condition did not settle within the turn budget");
}

export function must<T>(value: T | null | undefined, what = "a value"): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}
