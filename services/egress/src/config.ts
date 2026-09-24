/**
 * Fixed constants and environment names for the identity egress gateway
 * (docs/cloud-sync-design.md §9). There is deliberately no runtime
 * configuration surface beyond the environment read once at startup.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";

import { CREDENTIAL_SECRET_BYTES } from "@pistachio/egress-policy";

/** Environment variable names (§9, §11). */
export const ENV = {
  listen: "EGRESS_LISTEN",
  tokenSecret: "EGRESS_TOKEN_SECRET",
  devInsecure: "EGRESS_DEV_INSECURE",
  extraPorts: "EGRESS_EXTRA_PORTS",
  ownerUserId: "EGRESS_OWNER_USER_ID",
  controlUrl: "EGRESS_CONTROL_URL",
  gatewayToken: "EGRESS_GATEWAY_TOKEN",
  tlsCert: "EGRESS_TLS_CERT",
  tlsKey: "EGRESS_TLS_KEY",
} as const;

/** Where a real deployment binds. */
export const DEFAULT_LISTEN = "0.0.0.0:8443";
/** Where the dev-insecure mode binds; startup refuses to move it off loopback. */
export const DEFAULT_DEV_LISTEN = "127.0.0.1:8443";

/** Upper bound on a request head (`http.createServer({ maxHeaderSize })`). */
export const MAX_HEAD_BYTES = 8 * 1024;
/** Time to deliver a complete CONNECT head (`server.headersTimeout`). */
export const HEAD_READ_TIMEOUT_MS = 10_000;
/** Time a spliced tunnel may go with no bytes in *either* direction. */
export const IDLE_TIMEOUT_MS = 300_000;
/** Time to establish one upstream TCP connection before trying the next address. */
export const DIAL_TIMEOUT_MS = 10_000;

/** Concurrent tunnel caps (§9). Exceeding either answers 429. */
export const MAX_TUNNELS_PER_DEVICE = 256;
export const MAX_TUNNELS_PER_USER = 1024;

/** Control-plane polling cadence (§9). */
export const REVOCATION_POLL_INTERVAL_MS = 30_000;
export const LIMITS_POLL_INTERVAL_MS = 60_000;
export const METRICS_FLUSH_INTERVAL_MS = 60_000;
/** Per-request timeout for control-plane calls. */
export const CONTROL_REQUEST_TIMEOUT_MS = 10_000;

/** Shared-secret length: 32 bytes supplied as 64 lowercase hex characters. */
export const SECRET_BYTES = CREDENTIAL_SECRET_BYTES;

/** The realm in the 407 challenge. */
export const PROXY_AUTH_REALM = "pistachio-egress";

/** Credential username prefix (§7.6); the format itself is shared with
 * control through `@pistachio/egress-policy`. */
export { CREDENTIAL_PREFIX } from "@pistachio/egress-policy";

/** Console branding prefix. Log lines never carry hostnames. */
export const LOG_PREFIX = "[egress]";

/** Minimal logger seam so tests can silence the gateway. */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const consoleLogger: Logger = {
  info: (m) => console.log(`${LOG_PREFIX} ${m}`),
  warn: (m) => console.warn(`${LOG_PREFIX} ${m}`),
  error: (m) => console.error(`${LOG_PREFIX} ${m}`),
};

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** True when `moduleUrl` is the script Node was started with (`tsx src/x.ts`). */
export function isEntrypoint(moduleUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (argv1 === undefined || argv1 === "") return false;
  try {
    return fileURLToPath(moduleUrl) === path.resolve(argv1);
  } catch {
    return false;
  }
}
