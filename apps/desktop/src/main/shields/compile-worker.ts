/**
 * The Shields compile worker: a utility process that reads the cached lists,
 * builds the engines (compile.ts), and writes them where main will
 * deserialize them. One job at a time; main forks it per compile and it
 * exits when done, so a parse never holds memory past its use.
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { compileEngines, type CompileList } from "./compile.js";

export interface CompileJob {
  lists: { id: string; path: string; trusted: boolean }[];
  dangerLists: { id: string; path: string; trusted: boolean }[];
  customFilters: string;
  resourcesPath: string | null;
  enginePath: string;
  dangerPath: string;
}

export type CompileReply =
  | { ok: true; networkFilters: number; cosmeticFilters: number; dangerFilters: number; customErrors: string[] }
  | { ok: false; error: string };

function read(entries: CompileJob["lists"]): CompileList[] {
  const out: CompileList[] = [];
  for (const entry of entries) {
    try {
      out.push({ id: entry.id, text: readFileSync(entry.path, "utf8"), trusted: entry.trusted });
    } catch {
      // A list that vanished from the cache is skipped; the next fetch brings it back.
    }
  }
  return out;
}

function writeAtomic(path: string, data: Uint8Array): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

const port = process.parentPort;
port.on("message", (event: { data: CompileJob }) => {
  const job = event.data;
  let reply: CompileReply;
  try {
    let resources: string | null = null;
    if (job.resourcesPath !== null) {
      try {
        resources = readFileSync(job.resourcesPath, "utf8");
      } catch {
        resources = null;
      }
    }
    const output = compileEngines({
      lists: read(job.lists),
      dangerLists: read(job.dangerLists),
      customFilters: job.customFilters,
      resources,
    });
    writeAtomic(job.enginePath, output.engine);
    if (output.danger === null) rmSync(job.dangerPath, { force: true });
    else writeAtomic(job.dangerPath, output.danger);
    reply = {
      ok: true,
      networkFilters: output.networkFilters,
      cosmeticFilters: output.cosmeticFilters,
      dangerFilters: output.dangerFilters,
      customErrors: output.customErrors,
    };
  } catch (error) {
    reply = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  port.postMessage(reply);
});
