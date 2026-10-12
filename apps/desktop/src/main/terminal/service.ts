/**
 * Main's half of the terminals (docs/terminal.md §3): it starts the terminal
 * host (./host.ts) when the shell first opens a terminal, hands the shell
 * window one end of a MessagePort to it — after that, main is not on the
 * path of a terminal's input or output — tells it which terminals tabs
 * still name (the rest are closed), and says when it stopped.
 *
 * The host is started again only when it is asked for: a host that keeps
 * failing is not restarted in a loop.
 */

import { MessageChannelMain, clipboard, utilityProcess, type UtilityProcess, type WebContents } from "electron";
import { IPC } from "@pistachio/shell-contracts/ipc";
import { inheritedEnvironment } from "./environment";
import type { HostOptions } from "./host";

export interface TerminalServiceOptions {
  /** The built host script (out/main/terminal-host.js). */
  hostPath: string;
  /** The terminals' folder in the app's data: their remembered folders, the shell integration. */
  stateDir: string;
  appVersion: string;
  locale: string;
  /** Keys the app put in its own environment (the workspace's .env): never a shell's. */
  omitEnv: () => ReadonlySet<string>;
}

/** The most a terminal's program may put on the clipboard at once (OSC 52), in characters. */
const MAX_CLIPBOARD = 1_000_000;

export class TerminalService {
  readonly #options: TerminalServiceOptions;
  #host: UtilityProcess | null = null;
  #ready = false;
  /** Sent once the host says it is ready. */
  #queue: Array<{ message: unknown; ports: Electron.MessagePortMain[] }> = [];
  /** The shell window the host's port went to: told when the host stops. */
  #renderer: WebContents | null = null;
  #retained: readonly string[] = [];
  #closed = false;

  constructor(options: TerminalServiceOptions) {
    this.#options = options;
  }

  /** Give `contents` (the shell window) its end of a port to the host, starting the host if need be. */
  connect(contents: WebContents): void {
    if (this.#closed) return;
    this.#renderer = contents;
    const host = this.#ensureHost();
    const { port1, port2 } = new MessageChannelMain();
    this.#post(host, { type: "port" }, [port1]);
    contents.postMessage(IPC.terminalPort, null, [port2]);
  }

  /** The terminals tabs name now (their ids): the host closes any other. */
  retain(ids: readonly string[]): void {
    const sorted = [...new Set(ids)].sort();
    if (sorted.length === this.#retained.length && sorted.every((id, index) => id === this.#retained[index])) return;
    this.#retained = sorted;
    if (this.#host !== null) this.#post(this.#host, { type: "retain", ids: sorted }, []);
  }

  dispose(): void {
    this.#closed = true;
    this.#host?.kill();
    this.#host = null;
  }

  #ensureHost(): UtilityProcess {
    if (this.#host !== null) return this.#host;
    const options: HostOptions = { appVersion: this.#options.appVersion, locale: this.#options.locale };
    const host = utilityProcess.fork(this.#options.hostPath, [this.#options.stateDir, JSON.stringify(options)], {
      serviceName: "Pistachio Terminal",
      stdio: "pipe",
      // The shells' environment starts from the host's: the app's, less what is the app's alone (./environment.ts).
      env: inheritedEnvironment(process.env, this.#options.omitEnv()),
    });
    this.#host = host;
    this.#ready = false;
    host.stderr?.on("data", (chunk: Buffer) => console.error("[Terminal]", chunk.toString().trim()));
    host.on("message", (message: { type?: unknown; text?: unknown }) => {
      if (this.#host !== host) return;
      // A terminal's program put text on the clipboard (OSC 52; docs/terminal.md §3).
      if (message.type === "clipboard") {
        if (typeof message.text === "string" && message.text.length <= MAX_CLIPBOARD) clipboard.writeText(message.text);
        return;
      }
      if (message.type !== "ready") return;
      this.#ready = true;
      host.postMessage({ type: "retain", ids: this.#retained });
      for (const { message: queued, ports } of this.#queue.splice(0)) host.postMessage(queued, ports);
    });
    host.once("exit", (code) => {
      if (this.#host !== host) return;
      this.#host = null;
      this.#ready = false;
      this.#queue = [];
      if (code !== 0 && !this.#closed) console.error(`[Terminal] the host stopped (${String(code)})`);
      // Every shell went with it: the shell window says so in each terminal, and asks again when one is wanted.
      const renderer = this.#renderer;
      if (renderer !== null && !renderer.isDestroyed()) renderer.send(IPC.terminalHostGone);
    });
    return host;
  }

  #post(host: UtilityProcess, message: unknown, ports: Electron.MessagePortMain[]): void {
    if (this.#ready) host.postMessage(message, ports);
    else this.#queue.push({ message, ports });
  }
}
