/**
 * Both socket servers share one Node server (docs/web-browser-design.md
 * §6.1), and Node hands every `upgrade` to every listener. So neither may
 * refuse the other's paths: a live-view server that answered `/v1/shell/:id`
 * with 404 would destroy the socket before the shell server ever saw it, and
 * the web app would never connect at all — with nothing in either log to say
 * why.
 */

import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlClient } from "../../src/control-client.js";
import { LiveViewServer } from "../../src/live/server.js";
import type { ClaimOutcome } from "../../src/sessions/session-registry.js";
import { ShellSocketServer, type ShellSession, type ShellSessionRegistry } from "../../src/sessions/shell-server.js";
import { startFakeControl, type FakeControl } from "../helpers/fake-control.js";

let fake: FakeControl;
let server: Server;
let live: LiveViewServer;
let shell: ShellSocketServer;
let port: number;

/** The upgrade's HTTP status; every path here is refused before any protocol. */
function upgrade(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    req.once("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    req.once("upgrade", () => reject(new Error("the upgrade unexpectedly succeeded")));
    req.once("error", reject);
    req.end();
  });
}

beforeEach(async () => {
  fake = await startFakeControl();
  const control = new ControlClient({ baseUrl: fake.baseUrl, serviceToken: fake.serviceToken });
  const registry: ShellSessionRegistry = {
    get: () => null,
    claim: async (): Promise<ClaimOutcome<ShellSession>> => ({ kind: "refused", reason: "not_found" }),
    viewerAttached: () => undefined,
    viewerDetached: () => undefined,
    onClosing: () => () => undefined,
  };
  live = new LiveViewServer({ control, runs: { get: () => null } });
  shell = new ShellSocketServer({ control, registry, serviceToken: fake.serviceToken });
  server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  // In the order the runner attaches them.
  live.attach(server);
  shell.attach(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await shell.close();
  await live.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fake.close();
});

describe("two socket servers on one address", () => {
  it("lets the shell server answer its own path rather than the live view refusing it", async () => {
    // 401 is the shell server's answer to a missing ticket. A 404 here would
    // mean the live view refused the path first.
    expect(await upgrade("/v1/shell/some-session")).toBe(401);
    expect(await upgrade("/v1/internal/shell/some-session")).toBe(401);
  });

  it("still lets the live view answer its own path", async () => {
    expect(await upgrade("/v1/live/some-run")).toBe(401);
  });

  it("still refuses a path neither of them owns", async () => {
    expect(await upgrade("/v1/nothing")).toBe(404);
  });

  it("refuses a shell path with 404 when no shell server is there to answer it", async () => {
    // Leaving another server's paths alone and having nobody listening look
    // the same to a client: the upgrade dangles until something times out,
    // with nothing in either log to say why. So the live view answers for the
    // shell's paths exactly when the shell is not attached.
    await shell.close();
    expect(await upgrade("/v1/shell/some-session")).toBe(404);
    expect(await upgrade("/v1/internal/shell/some-session")).toBe(404);
    // …and its own paths are unaffected.
    expect(await upgrade("/v1/live/some-run")).toBe(401);
  });
});
