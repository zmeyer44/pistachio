/**
 * Production entrypoint (`pnpm start`, docs/cloud-sync-design.md §7.7).
 * Fail-closed: CONTROL_TOKEN_SK/PK, MAILER, and a real DATABASE_URL in
 * production are required; a missing one exits 1 with a clear message.
 * `dev-server.ts` fills in local defaults before importing this module.
 */

import { serve } from "@hono/node-server";
import type { Server as HttpServer } from "node:http";
import { createApp } from "./app.js";
import { createDbFromUrl } from "./db/client.js";
import { ensureSchema } from "./db/migrate.js";
import { EgressConfigError, egressFromEnv } from "./egress.js";
import { signingKeysFromEnv } from "./keys-provider.js";
import { MailerConfigError, mailerFromEnv } from "./mailer.js";
import { httpRunnerClient, startOutboxDrain } from "./outbox.js";
import { blueBubblesOptionsFromEnv } from "./imessage.js";

const env = process.env;

function fatal(message: string): never {
  console.error(`control: ${message}`);
  process.exit(1);
}

const databaseUrl = env["DATABASE_URL"];
if (!databaseUrl) {
  fatal('DATABASE_URL is required. Set a Postgres URL, or "pglite" for an embedded local-dev database.');
}
const production = env["NODE_ENV"] === "production";
if (production && (databaseUrl === "pglite" || databaseUrl.startsWith("pglite:"))) {
  fatal("DATABASE_URL=pglite is not allowed in production.");
}

const signing = await signingKeysFromEnv(env).catch((err: unknown) =>
  fatal(`CONTROL_TOKEN_SK/PK did not decode: ${err instanceof Error ? err.message : String(err)}`),
);
if (signing === null) {
  fatal("CONTROL_TOKEN_SK and CONTROL_TOKEN_PK are required (dev-server.ts generates an ephemeral pair).");
}

let mailer;
try {
  mailer = mailerFromEnv(env);
} catch (err) {
  fatal(err instanceof MailerConfigError ? err.message : String(err));
}
if (mailer === null) fatal("MAILER is required (log or resend).");

let egress;
try {
  egress = egressFromEnv(env);
} catch (err) {
  fatal(err instanceof EgressConfigError ? err.message : String(err));
}

let imessage;
try {
  imessage = blueBubblesOptionsFromEnv(env);
} catch (err) {
  fatal(err instanceof Error ? err.message : String(err));
}

const port = Number(env["PORT"] ?? 8787);
const db = await createDbFromUrl(databaseUrl);
await ensureSchema(db);

const runnerUrl = env["CLOUD_BROWSER_URL"];
const serviceToken = env["CLOUD_BROWSER_SERVICE_TOKEN"];
const runner =
  runnerUrl && serviceToken ? httpRunnerClient({ baseUrl: runnerUrl, serviceToken }) : undefined;

const control = createApp(db, {
  signing,
  mailer,
  egress,
  imessage,
  env,
  log: console.log,
  ...(runner === undefined ? {} : { runner }),
});

const server = serve({ fetch: control.app.fetch, port }) as HttpServer;
control.hub.attach(server);
startOutboxDrain(control.outbox);

const HOUR_MS = 60 * 60 * 1000;
const maintenance = setInterval(() => {
  void control.runMaintenance().catch((err: unknown) => {
    console.error("control: maintenance failed:", err);
  });
}, HOUR_MS);
maintenance.unref();

console.log(
  [
    `@pistachio/control listening on :${port} (hub: /v1/hub/ws)`,
    `cloud browser: ${runner === undefined ? "disabled (CLOUD_BROWSER_URL / CLOUD_BROWSER_SERVICE_TOKEN unset)" : runnerUrl}`,
    `egress: ${egress.provider === null ? "disabled (EGRESS_PROVIDER unset)" : egress.provider.kind}${egress.tokenSecretHex === null ? " (no EGRESS_TOKEN_SECRET — credentials disabled)" : ""}`,
    `mailer: ${env["MAILER"]}`,
    `iMessage: ${imessage === null ? "disabled (BlueBubbles configuration unset)" : "enabled"}`,
  ].join("\n"),
);

const shutdown = (): void => {
  clearInterval(maintenance);
  void control.hub.host?.close().finally(() => {
    server.close(() => process.exit(0));
  });
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
