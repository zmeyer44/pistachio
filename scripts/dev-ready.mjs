import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootEnv = resolve(repoRoot, ".env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const children = new Set();
let stopping = false;

function killTree(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // The process group has already exited.
  }
}

function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) killTree(child, signal);

  const failsafe = setTimeout(() => {
    for (const child of children) killTree(child, "SIGKILL");
  }, 5_000);
  failsafe.unref();
}

function run(label, args) {
  const child = spawn(pnpm, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
  children.add(child);

  child.on("error", (error) => {
    console.error(`[dev:ready] could not start ${label}:`, error);
    process.exitCode = 1;
    stop();
  });

  child.on("exit", (code, signal) => {
    children.delete(child);
    if (!stopping) {
      const result = signal === null ? `code ${code ?? 1}` : `signal ${signal}`;
      console.error(`[dev:ready] ${label} exited unexpectedly (${result})`);
      process.exitCode = code && code !== 0 ? code : 1;
      stop();
    }
    if (children.size === 0) process.exit();
  });

  return child;
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    stop(signal === "SIGHUP" ? "SIGTERM" : signal);
  });
}
process.on("exit", () => {
  for (const child of children) killTree(child, "SIGKILL");
});

const delay = (milliseconds) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function waitForControl(control, healthUrl) {
  const deadline = Date.now() + 30_000;
  while (!stopping && Date.now() < deadline) {
    if (control.exitCode !== null || control.signalCode !== null) {
      throw new Error("control exited before becoming ready");
    }
    try {
      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // Control is still generating its development keys or initializing PGlite.
    }
    await delay(200);
  }
  if (stopping) return;
  throw new Error(
    `control did not become ready at ${healthUrl} within 30 seconds`,
  );
}

const controlBaseUrl =
  process.env.PISTACHIO_CONTROL_URL ??
  `http://localhost:${process.env.PORT ?? "8787"}`;
const healthUrl = new URL(
  "/healthz",
  `${controlBaseUrl.replace(/\/+$/, "")}/`,
).toString();

console.log(`[dev:ready] starting control and waiting for ${healthUrl}`);
const control = run("control", ["--filter", "@pistachio/control", "dev"]);

try {
  await waitForControl(control, healthUrl);
  if (!stopping) {
    console.log(
      "[dev:ready] control is ready; starting the remaining development services",
    );
    run("egress", ["--filter", "@pistachio/egress", "dev"]);
    run("cloud browser", ["--filter", "@pistachio/cloud-browser", "dev"]);
    // Two web apps (docs/web-browser-design.md §15): the site and dashboard
    // on 3000, the browser app on 3001.
    run("www", ["--filter", "www", "dev"]);
    run("web browser", ["--filter", "web", "dev"]);
    run("desktop", ["--filter", "@pistachio/desktop", "dev"]);
  }
} catch (error) {
  console.error(
    `[dev:ready] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
  stop();
}
