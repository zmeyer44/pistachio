/**
 * Status back to the folder (docs/extensions.md §4, "Status back to the
 * folder"): for an extension in a dev folder, `.pistachio/status.json` —
 * rewritten on every change, so an agent that just saved a file reads what
 * Pistachio made of it — and `.pistachio/log.ndjson`, the console and errors
 * of every context (1 MB, then rotated to `log.1.ndjson`). Every extension,
 * dev or not, also keeps its last lines in memory for the extensions page's
 * *Logs*.
 */

import { appendFileSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtContext } from "@pistachio/extension-api";
import type { ExtensionStatus } from "@pistachio/shell-contracts/extensions";

export const LOG_MAX_BYTES = 1024 * 1024;
export const LOG_MEMORY_LINES = 500;
export const STATUS_DIR = ".pistachio";

export interface RuntimeErrorLine {
  context: ExtContext;
  message: string;
  file?: string;
  line?: number;
  at: number;
}

export interface StatusFile {
  id: string | null;
  state: ExtensionStatus;
  loadedAt: number | null;
  api: number | null;
  manifestErrors: { path: string; message: string }[];
  pendingGrants: { capabilities: string[]; hosts: string[] } | null;
  runtimeErrors: RuntimeErrorLine[];
  surfaces: { bar: string[]; tools: string[]; pages: string[] };
  /**
   * Its declared key commands as the app took them (./keys.ts): `binding` the app's key it holds, or null with
   * `unbound` saying why (a key the app holds, or another extension earlier in the person's order).
   */
  keys: { id: string; key: string | null; binding: string | null; unbound: string | null }[];
}

export interface LogLine {
  at: number;
  context: ExtContext | "main";
  level: "debug" | "info" | "warn" | "error";
  message: string;
  file?: string;
  line?: number;
  data?: unknown;
}

const MAX_RUNTIME_ERRORS = 20;

export class StatusWriter {
  /** The dev folder to write into, or null for an extension that is not one (memory only). */
  readonly #folder: string | null;
  readonly #memory: string[] = [];
  #status: StatusFile;

  constructor(folder: string | null, id: string | null) {
    this.#folder = folder;
    this.#status = { id, state: "idle", loadedAt: null, api: null, manifestErrors: [], pendingGrants: null, runtimeErrors: [], surfaces: { bar: [], tools: [], pages: [] }, keys: [] };
  }

  get status(): StatusFile {
    return structuredClone(this.#status);
  }

  /** Change the status file's fields and write it (unchanged fields kept). */
  update(patch: Partial<StatusFile>): void {
    this.#status = { ...this.#status, ...structuredClone(patch) };
    this.#writeStatus();
  }

  runtimeError(error: RuntimeErrorLine): void {
    this.#status.runtimeErrors = [...this.#status.runtimeErrors, error].slice(-MAX_RUNTIME_ERRORS);
    this.#writeStatus();
  }

  clearRuntimeErrors(): void {
    if (this.#status.runtimeErrors.length === 0) return;
    this.#status.runtimeErrors = [];
    this.#writeStatus();
  }

  log(line: LogLine): void {
    const text = JSON.stringify(line);
    this.#memory.push(text);
    if (this.#memory.length > LOG_MEMORY_LINES) this.#memory.splice(0, this.#memory.length - LOG_MEMORY_LINES);
    if (this.#folder === null) return;
    const dir = join(this.#folder, STATUS_DIR);
    const path = join(dir, "log.ndjson");
    try {
      mkdirSync(dir, { recursive: true });
      try {
        if (statSync(path).size + text.length + 1 > LOG_MAX_BYTES) renameSync(path, join(dir, "log.1.ndjson"));
      } catch {
        // No log yet.
      }
      appendFileSync(path, `${text}\n`);
    } catch {
      // A folder that went away (deleted, unmounted) takes its log with it.
    }
  }

  /** The last lines, oldest first (the extensions page's *Logs*). */
  lines(): string[] {
    return [...this.#memory];
  }

  #writeStatus(): void {
    if (this.#folder === null) return;
    const dir = join(this.#folder, STATUS_DIR);
    try {
      mkdirSync(dir, { recursive: true });
      const path = join(dir, "status.json");
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(this.#status, null, 2)}\n`);
      renameSync(tmp, path);
    } catch {
      // As the log.
    }
  }
}
