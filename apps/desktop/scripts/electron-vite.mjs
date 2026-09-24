import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const appDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));
const macExecutable = "dist/Electron.app/Contents/MacOS/Electron";
const candidates = [
  process.env.PISTACHIO_ELECTRON_PATH,
  join(appDirectory, "node_modules/electron", macExecutable),
  resolve(
    appDirectory,
    "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron",
    macExecutable,
  ),
].filter(Boolean);

const executable = candidates.find((candidate) => {
  if (!existsSync(candidate)) return false;
  if (process.platform !== "darwin") return true;
  return existsSync(resolve(dirname(candidate), "../Info.plist"));
});

if (executable === undefined) {
  throw new Error(
    "No complete Electron runtime is installed. Run pnpm install after freeing disk space, or set PISTACHIO_ELECTRON_PATH.",
  );
}

const cli = join(appDirectory, "node_modules/electron-vite/bin/electron-vite.js");
// The child leads its own process group so the whole tree — electron-vite
// and the Electron it spawns — can be reaped as one. Without this, a stop
// that only reaches this wrapper (turbo forwards signals one level down)
// orphans Electron, and the next dev run steals its stale profile lock and
// corrupts the shared Space session underneath both instances.
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], {
  cwd: appDirectory,
  // electron-vite performs its own lookup and checks this variable before
  // reading electron/path.txt. The latter may be absent after an interrupted
  // Electron postinstall, so provide the selected executable directly.
  env: { ...process.env, ELECTRON_EXEC_PATH: executable },
  stdio: "inherit",
  detached: process.platform !== "win32",
});

const reap = (signal) => {
  if (process.platform === "win32") {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group is already gone.
  }
};

// A detached child is outside the terminal's foreground group, so signals
// must be forwarded by hand — and escalated, in case a quit path hangs.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    reap(signal === "SIGHUP" ? "SIGTERM" : signal);
    const failsafe = setTimeout(() => reap("SIGKILL"), 5000);
    failsafe.unref();
  });
}

// Whatever way this wrapper dies, Electron must not outlive it.
process.on("exit", () => reap("SIGKILL"));

child.on("exit", (code, signal) => {
  if (signal !== null) {
    // Restore default handling first, or the re-raise lands in the
    // forwarding handler above and the wrapper never dies.
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  } else process.exit(code ?? 1);
});

child.on("error", (error) => {
  throw error;
});
