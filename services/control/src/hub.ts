/**
 * Session hub binding (docs/cloud-sync-design.md §7.4). The hub attaches
 * to the raw `http.Server` (`attachSyncHub` needs its `upgrade` event), which
 * exists only after `serve()` — so `createApp` returns a binding whose
 * `attach(server)` the entrypoint (or a test) calls, and the routes read
 * `binding.host` at call time. Tests without sockets may inject a fake
 * `HubHost` instead.
 */

import type { Server as HttpServer } from "node:http";
import { SqlHubStorage, attachSyncHub, type HubHost, type HubStorage } from "@pistachio/sync-hub";
import { authenticateToken, type AuthenticatedToken } from "./auth.js";
import type { Db } from "./db/client.js";
import type { DevicePlatform } from "./db/schema.js";
import type { SigningKeys } from "./keys-provider.js";

export const HUB_PATH = "/v1/hub/ws";

/**
 * `@pistachio/sync-hub`'s `VerifiedHubToken` predates the `web` platform and
 * still types `platform` as `'macos' | 'cloud' | null`. The hub only ever
 * asks whether the caller is the cloud browser (everything else is a
 * desktop-class `DeviceKind`), so a `web` device is presented to it as
 * `macos` — the same answer the hub would compute — and the platform enum
 * change stays inside services/control.
 */
function hubPlatform(platform: DevicePlatform | null): "macos" | "cloud" | null {
  if (platform === null) return null;
  return platform === "cloud" ? "cloud" : "macos";
}

export interface HubBinding {
  /** The attached (or injected) host; null until `attach` is called. */
  readonly host: HubHost | null;
  /** Attach the hub to a listening server. Once per binding. */
  attach(server: HttpServer): HubHost;
  verifyToken(token: string): Promise<AuthenticatedToken | null>;
  storageFor(userId: string): HubStorage;
}

export function createHubBinding(options: {
  db: Db;
  signing: SigningKeys;
  now: () => number;
  injected?: HubHost;
  /** Request logging for upgrades (the URL is already scrubbed of `access_token`). */
  log?: (line: string) => void;
}): HubBinding {
  let host: HubHost | null = options.injected ?? null;
  // An anonymous account has one device and no password to wrap a key under,
  // so there is nothing for it to sync with: the hub does not know it
  // (docs/anonymous-accounts.md).
  const verifyToken = async (token: string): Promise<AuthenticatedToken | null> => {
    const verified = await authenticateToken(options.db, options.signing, token, Math.floor(options.now() / 1000));
    return verified === null || verified.anonymous ? null : verified;
  };
  const storageFor = (userId: string): HubStorage => new SqlHubStorage(options.db, userId);
  return {
    get host() {
      return host;
    },
    attach(server) {
      if (host !== null) throw new Error("hub already attached");
      host = attachSyncHub(server, {
        path: HUB_PATH,
        verifyToken: async (token) => {
          const verified = await verifyToken(token);
          return verified === null ? null : { ...verified, platform: hubPlatform(verified.platform) };
        },
        storageFor,
        now: options.now,
      });
      const log = options.log;
      if (log !== undefined) {
        // Registered after the hub's own listener, which strips
        // `access_token` from `req.url` synchronously before yielding.
        server.on("upgrade", (req) => log(`UPGRADE ${req.url ?? "/"}`));
      }
      return host;
    },
    verifyToken,
    storageFor,
  };
}
