/**
 * Development entry: reads the monorepo-root `.env`, fills in the defaults a
 * laptop needs (loud warnings for generated secrets), then starts the
 * production server module. Precedence: shell > `.env` > these defaults.
 */

import { randomBytes } from "node:crypto";

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The monorepo root `.env`, when there is one. The shell still wins:
// `process.loadEnvFile` does not overwrite a variable that is already set,
// and the `??=` defaults below only fill what neither supplied.
const rootEnv = path.resolve(fileURLToPath(import.meta.url), "../../../../.env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const env = process.env;
const warn = (message: string): void => console.warn(`[cloud-browser dev] ${message}`);

env["PORT"] ??= "8791";
env["PISTACHIO_CONTROL_URL"] ??= "http://localhost:8787";
// The two web apps, on the ports `pnpm dev` gives them (§15): `www` on
// 3000, the browser app on 3001.
env["PISTACHIO_WEB_URL"] ??= "http://localhost:3000";
env["PISTACHIO_BROWSER_URL"] ??= "http://localhost:3001";
if (env["CLOUD_BROWSER_SERVICE_TOKEN"] === undefined || env["CLOUD_BROWSER_SERVICE_TOKEN"] === "") {
  env["CLOUD_BROWSER_SERVICE_TOKEN"] = "dev-cloud-browser-service-token";
  warn("CLOUD_BROWSER_SERVICE_TOKEN unset: using the dev token; control must use the same value");
}
env["CLOUD_BROWSER_STATE_DIR"] ??= "./.cloud-browser";
if (env["CLOUD_BROWSER_STATE_KEY"] === undefined || env["CLOUD_BROWSER_STATE_KEY"] === "") {
  env["CLOUD_BROWSER_STATE_KEY"] = randomBytes(32).toString("base64");
  warn("CLOUD_BROWSER_STATE_KEY unset: generated an EPHEMERAL key — stored device identities will not survive a restart");
}
env["PISTACHIO_AGENT_MODEL"] ??= "openai/gpt-5.6-terra";
if (env["AI_GATEWAY_API_KEY"] === undefined || env["AI_GATEWAY_API_KEY"] === "") {
  warn("AI_GATEWAY_API_KEY unset: cloud runs cannot call a model");
}
// The dev egress gateway listens on plain HTTP; a laptop without one runs direct.
env["CLOUD_BROWSER_EGRESS_SCHEME"] ??= "http";
env["CLOUD_BROWSER_EGRESS_MODE"] ??= "direct";
if (env["CLOUD_BROWSER_EGRESS_MODE"] === "direct") warn("CLOUD_BROWSER_EGRESS_MODE=direct: contexts use no proxy and gateways are ignored");

const { startServer } = await import("./server.js");
await startServer(env);
