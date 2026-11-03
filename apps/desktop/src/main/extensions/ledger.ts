/**
 * The ledger (docs/extensions.md §6.2, "Exfiltration"): every byte an
 * extension sends out goes through `net.fetch`, and every one of those calls
 * is a line in `<userData>/ExtensionData/<id>/ledger.ndjson` — the host, the
 * path (never the query, which is where tokens ride), the method, the status
 * and the sizes — so the extensions page can say "Sent to api.github.com: 41
 * requests today". Kept to 1 MB: past that the older half goes.
 */

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const LEDGER_MAX_BYTES = 1024 * 1024;

export interface LedgerLine {
  at: number;
  method: string;
  host: string;
  path: string;
  status: number | null;
  sent: number;
  received: number;
  /** Why it was refused, when it was (a host not granted, a limit). */
  refused?: string;
  /**
   * An agent's tool call rather than a request out (docs/extensions.md §5
   * `agent`, §6.2): its input is data leaving to the extension, so it is
   * written here whole (cut at LEDGER_TOOL_INPUT_CHARS of JSON), with the run
   * it came from. `method` is "TOOL", `host` "agent", `path` "/<tool>".
   */
  tool?: { name: string; runId: string; input: string };
}

/** How much of a tool call's input, as JSON, a ledger line keeps. */
export const LEDGER_TOOL_INPUT_CHARS = 8_000;

export class Ledger {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  record(line: LedgerLine): void {
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      appendFileSync(this.#path, `${JSON.stringify(line)}\n`);
      if (statSync(this.#path).size > LEDGER_MAX_BYTES) this.#trim();
    } catch (error) {
      console.error("[extensions] could not write the ledger", error);
    }
  }

  lines(): LedgerLine[] {
    try {
      return readFileSync(this.#path, "utf8")
        .split("\n")
        .flatMap((text) => {
          if (text.trim() === "") return [];
          try {
            return [JSON.parse(text) as LedgerLine];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
  }

  /** Requests sent per host since `since` (ms), refused ones and the agent's tool calls left out. */
  countsSince(since: number): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const line of this.lines()) if (line.at >= since && line.refused === undefined && line.tool === undefined) counts[line.host] = (counts[line.host] ?? 0) + 1;
    return counts;
  }

  #trim(): void {
    const text = readFileSync(this.#path, "utf8");
    const kept = text.slice(Math.floor(text.length / 2));
    writeFileSync(this.#path, kept.slice(kept.indexOf("\n") + 1));
  }
}

/** A ledger line's address part: host and path, no query, no fragment. */
export function ledgerAddress(url: string): { host: string; path: string } {
  try {
    const parsed = new URL(url);
    return { host: parsed.host, path: parsed.pathname };
  } catch {
    return { host: "", path: "" };
  }
}
