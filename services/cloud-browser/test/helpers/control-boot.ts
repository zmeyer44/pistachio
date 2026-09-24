/**
 * The real control plane for the cloud-browser integration suites
 * (docs/cloud-sync-design.md §7): PGlite, a generated Ed25519 signing pair,
 * the Hono app served on an ephemeral loopback port, and the sync hub
 * attached to the same `http.Server` (§7.4). The runner's URL is only
 * known once it listens, so control's runner client is bound afterwards
 * through `bindRunner`.
 *
 * `@pistachio/control` is not a dependency of this package (and may not
 * become one here), hence the relative import of its source.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getRequestListener } from "@hono/node-server";
import {
  createApp,
  createDbFromUrl,
  ensureSchema,
  generateSigningKeys,
  httpRunnerClient,
  type ControlApp,
  type Db,
  type RunnerClient,
} from "../../../control/src/index.js";
import { must } from "./fixture-server.js";

export type HubHost = ReturnType<ControlApp["hub"]["attach"]>;

export interface BootedControl {
  readonly db: Db;
  readonly control: ControlApp;
  readonly server: Server;
  readonly hub: HubHost;
  /** `http://127.0.0.1:<port>` */
  readonly url: string;
  /** `ws://127.0.0.1:<port>/v1/hub/ws` */
  readonly hubUrl: string;
  /** Point control's `/cloud/enable` provisioning and steers at a listening runner. */
  bindRunner(runnerUrl: string): void;
  close(): Promise<void>;
}

export interface BootControlOptions {
  serviceToken: string;
  log?: (line: string) => void;
}

export async function bootControl(options: BootControlOptions): Promise<BootedControl> {
  const db = await createDbFromUrl("pglite:memory://");
  await ensureSchema(db);
  const signing = await generateSigningKeys();
  let runnerClient: RunnerClient | null = null;
  const control = createApp(db, {
    signing,
    // The fleet's one public address (§8.5). Tests dial workers directly, but
    // control will not issue a live ticket without knowing where to send one.
    env: {
      CLOUD_BROWSER_SERVICE_TOKEN: options.serviceToken,
      CLOUD_BROWSER_PUBLIC_URL: "https://live.example",
    },
    runner: {
      provision: (userId, nonce) => must(runnerClient, "a bound runner client").provision(userId, nonce),
      steer: (body) => must(runnerClient, "a bound runner client").steer(body),
      routeIMessage: (input) => must(runnerClient, "a bound runner client").routeIMessage(input),
    },
    ...(options.log === undefined ? {} : { log: options.log }),
  });
  const server = createServer(getRequestListener(control.app.fetch));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const hub = control.hub.attach(server);
  const { port } = server.address() as AddressInfo;
  return {
    db,
    control,
    server,
    hub,
    url: `http://127.0.0.1:${String(port)}`,
    hubUrl: `ws://127.0.0.1:${String(port)}/v1/hub/ws`,
    bindRunner: (runnerUrl) => {
      runnerClient = httpRunnerClient({ baseUrl: runnerUrl, serviceToken: options.serviceToken });
    },
    close: async () => {
      await control.idle();
      await hub.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
