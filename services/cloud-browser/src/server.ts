/**
 * Production entry: every §8.6 variable is required (no generated secrets),
 * Chromium must exist, and the process exits 1 with a clear message
 * otherwise. Importable without side effects: the server starts only when
 * this file is the entrypoint.
 */

import { pathToFileURL } from "node:url";
import { readCloudBrowserConfig } from "./config.js";
import { consoleLogger, errorMessage } from "./logger.js";
import { createRunner, type Runner } from "./runner.js";

export async function startServer(env: NodeJS.ProcessEnv = process.env): Promise<Runner> {
  const config = readCloudBrowserConfig(env);
  const runner = createRunner({
    controlUrl: config.controlUrl,
    serviceToken: config.serviceToken,
    stateDir: config.stateDir,
    stateKey: config.stateKey,
    chromiumPath: config.chromiumExecutablePath,
    ...(config.aiGatewayApiKey === null ? {} : { aiGatewayApiKey: config.aiGatewayApiKey }),
    agentModel: config.agentModel,
    intentModel: config.intentModel,
    ports: { http: config.port },
    publicUrl: config.publicUrl,
    internalUrl: config.internalUrl,
    artifactWebUrl: config.webUrl,
    browserUrl: config.browserUrl,
    browserSessionIdleMs: config.sessionIdleMs,
    ...(env["CLOUD_BROWSER_EGRESS_SCHEME"] === "http" ? { egressScheme: "http" as const } : {}),
    ...(env["CLOUD_BROWSER_EGRESS_MODE"] === "direct" ? { egressMode: "direct" as const } : {}),
    log: consoleLogger,
  });
  await runner.start();
  const shutdown = (): void => {
    void runner.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return runner;
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isEntrypoint()) {
  startServer().catch((error: unknown) => {
    console.error(`cloud browser failed to start: ${errorMessage(error)}`);
    process.exit(1);
  });
}
