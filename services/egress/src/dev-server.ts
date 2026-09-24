/**
 * Local development entry (`pnpm dev`): reads the monorepo-root `.env`, then
 * runs the unauthenticated dev verifier on loopback unless a real
 * `EGRESS_TOKEN_SECRET` is provided, and no control-plane polling unless
 * `EGRESS_CONTROL_URL` is set. Precedence: shell > `.env` > these defaults.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The monorepo root `.env`, when there is one. The shell still wins:
// `process.loadEnvFile` does not overwrite a variable that is already set,
// and the `??=` defaults below only fill what neither supplied.
const rootEnv = path.resolve(fileURLToPath(import.meta.url), "../../../../.env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

import { runGateway } from "./server.js";

if ((process.env.EGRESS_TOKEN_SECRET ?? "").trim() === "") {
  process.env.EGRESS_DEV_INSECURE ??= "1";
}
process.env.EGRESS_LISTEN ??= "127.0.0.1:8443";

const running = await runGateway(process.env);
const shutdown = (): void => {
  void running.stop().then(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
