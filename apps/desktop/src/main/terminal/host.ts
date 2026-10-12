/**
 * The terminal host (docs/terminal.md §3): a utility process that runs the
 * terminals' shells, each on a pseudo-terminal (node-pty), apart from main
 * — a shell pouring out output, or a native module failing, never stalls
 * the window. Main hands it one end of a MessagePort for the shell window's
 * renderer; everything a terminal says and is told goes over that port.
 *
 * The sessions themselves — output, flow control, replay, lifetime — are
 * ./sessions.ts's; this is their wiring: node-pty, the headless terminal
 * each shell is mirrored into (./mirror.ts: so a window that loads again
 * finds its terminals as they were), the folders kept on disk (so a
 * terminal reopened after a restart opens where it was), and the ports.
 *
 * argv: [2] the terminal's folder in the app's data, [3] a JSON of
 * `HostOptions`.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import type { MessagePortMain } from "electron";
import { isTerminalRequest } from "@pistachio/shell-contracts/terminal";
import { shellLaunch, type ShellIntegrationPaths } from "./environment";
import { headlessMirror } from "./mirror";
import { TerminalSessions, type TerminalPlaces } from "./sessions";
import { installShellIntegration } from "./shell-integration";

// (A CommonJS package, whose named exports an ES module cannot always see.)
const require = createRequire(import.meta.url);
const pty = require("node-pty") as typeof import("node-pty");

export interface HostOptions {
  appVersion: string;
  /** Intl's spelling (`en-US`), for a shell given no locale. */
  locale: string;
}

/** A remembered folder no tab names is forgotten after this long. */
const FORGET_MS = 14 * 24 * 60 * 60 * 1000;

const port0 = process.parentPort;
if (!port0) throw new Error("The terminal host must run in its utility process.");
const parentPort = port0;

const stateDir = process.argv[2] ?? join(homedir(), ".pistachio-terminal");
const options = JSON.parse(process.argv[3] ?? "{}") as HostOptions;
mkdirSync(stateDir, { recursive: true });

let port: MessagePortMain | null = null;
let integration: ShellIntegrationPaths | null = null;
const integrationReady = installShellIntegration(join(stateDir, "shell-integration")).then((paths) => {
  integration = paths;
});

// ── Where each terminal was (its folder), kept across restarts ─────────────

/** `places.json` in the terminal's folder: each terminal's folder and when a tab last named it. */
class PlacesFile implements TerminalPlaces {
  readonly #file = join(stateDir, "places.json");
  readonly #places = new Map<string, { cwd: string; at: number }>();
  #timer: NodeJS.Timeout | null = null;

  constructor() {
    try {
      const read = JSON.parse(readFileSync(this.#file, "utf8")) as { places?: Record<string, { cwd?: unknown; at?: unknown }> };
      for (const [id, place] of Object.entries(read.places ?? {})) {
        if (typeof place.cwd === "string" && typeof place.at === "number") this.#places.set(id, { cwd: place.cwd, at: place.at });
      }
    } catch {
      // None yet, or unreadable: every terminal starts at home.
    }
  }

  get(id: string): string | null {
    return this.#places.get(id)?.cwd ?? null;
  }

  set(id: string, cwd: string): void {
    this.#places.set(id, { cwd, at: Date.now() });
    this.#save();
  }

  retain(ids: ReadonlySet<string>): void {
    const now = Date.now();
    let forgot = false;
    for (const [id, place] of this.#places) {
      if (ids.has(id)) place.at = now;
      else if (now - place.at > FORGET_MS) {
        this.#places.delete(id);
        forgot = true;
      }
    }
    if (forgot) this.#save();
  }

  #save(): void {
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      try {
        const temporary = `${this.#file}.tmp`;
        writeFileSync(temporary, JSON.stringify({ places: Object.fromEntries(this.#places) }));
        renameSync(temporary, this.#file);
      } catch {
        // (Lost with the next restart, at worst.)
      }
    }, 500);
  }
}

// ── The shell ─────────────────────────────────────────────────────────────

/** The person's shell: the environment's (SHELL), else their account's, else zsh, macOS's own. */
function loginShell(env: Record<string, string>): string {
  const candidates = [env["SHELL"], safeUserShell(), "/bin/zsh"];
  return candidates.find((candidate): candidate is string => candidate !== undefined && candidate !== "" && existsSync(candidate)) ?? "/bin/sh";
}

function safeUserShell(): string | undefined {
  try {
    return userInfo().shell ?? undefined;
  } catch {
    return undefined;
  }
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const sessions = new TerminalSessions({
  send: (event) => port?.postMessage(event),
  spawn: (cwd, cols, rows) => {
    // (The host's environment is the shells': main forked it with the app's, less the app's own — ./environment.ts.)
    const inherited = process.env as Record<string, string>;
    const launch = shellLaunch(loginShell(inherited), inherited, { appVersion: options.appVersion, locale: options.locale, integration });
    return pty.spawn(launch.file, launch.args, { name: "xterm-256color", cols, rows, cwd, env: launch.env, encoding: "utf8" });
  },
  mirror: headlessMirror,
  places: new PlacesFile(),
  isFolder,
  home: homedir(),
  ready: integrationReady,
  clipboard: (text) => parentPort.postMessage({ type: "clipboard", text }),
  alive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
});

/** The renderer's port: a new one means the shell window loaded again, and opens its terminals anew. */
function adopt(next: MessagePortMain): void {
  port?.close();
  port = next;
  sessions.detachAll();
  next.on("message", (event) => {
    if (isTerminalRequest(event.data)) sessions.handle(event.data);
  });
  next.on("close", () => {
    if (port !== next) return;
    port = null;
    sessions.detachAll();
  });
  next.start();
}

parentPort.on("message", (event) => {
  const message = event.data as { type?: unknown; ids?: unknown };
  if (message.type === "port") {
    const next = event.ports[0];
    if (next !== undefined) adopt(next);
  } else if (message.type === "retain" && Array.isArray(message.ids)) {
    sessions.retain(message.ids.filter((id): id is string => typeof id === "string"));
  }
});

// Every shell hangs up as the host goes (the app quitting): their pseudo-terminals close with it.
parentPort.postMessage({ type: "ready" });
