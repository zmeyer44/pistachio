/**
 * `pnpm dev:livekit` (docs/live-share.md §11): the local LiveKit SFU that
 * live share rides in development. `--dev` gives it the fixed credentials
 * control's dev-server assumes (`devkey` / `secret`) on port 7880, and
 * `--bind` keeps it on loopback.
 *
 * The server runs in its own process group so each Ctrl-C reaches it once,
 * from here: LiveKit drains on the first signal and takes a second as "stop
 * now", so pressing it again still gets you out.
 */

import { spawn } from "node:child_process";

const child = spawn("livekit-server", ["--dev", "--bind", "127.0.0.1"], {
  stdio: "inherit",
  detached: process.platform !== "win32",
});

let stopping = false;

child.on("error", (error) => {
  if (error.code === "ENOENT") {
    console.error("livekit-server is not on PATH. Install LiveKit: brew install livekit");
  } else {
    console.error("[dev:livekit] could not start livekit-server:", error);
  }
  process.exit(1);
});

child.on("exit", (code, signal) => {
  process.exit(code ?? (stopping || signal === null ? 0 : 1));
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    stopping = true;
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  });
}
