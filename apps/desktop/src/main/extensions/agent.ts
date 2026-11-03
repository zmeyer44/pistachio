/**
 * Extensions and the agent, main's side (docs/extensions.md §1 X12, §6.2
 * "Agent tools" and "Approving", §8): no Electron here, so the rules are
 * unit-tested (test/extensions-agent.test.ts); the service wires them.
 *
 * - `agentToolSpecs`: the declared tools a turn in a Profile may have — of an
 *   extension that runs, is on in that Profile, holds `agent:tools`, and was
 *   left *Agent can use it*.
 * - `callAgentTool`: one call, checked again at call time (the person may
 *   have turned it off mid-turn), its input written to the extension's
 *   ledger — it is data leaving to the extension — then the worker's `tool`
 *   handler, awaited with the 30 s timeout `invoke` keeps; an `ExtError` is
 *   a sentence the model reads.
 * - `DraftFolders`: the author turn's reach — the draft folders the Bar made
 *   (`draftFolder`), each claimed once with the token the shell was handed,
 *   and the three things the author tools do in one: write a file (≤ 256 KB,
 *   a relative path, never `..`, never `.pistachio/**`, never through a
 *   symlink, never a manifest naming `<all_urls>`), read a file or the
 *   listing, and read the status file once the watcher has reloaded.
 */

import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { ExtError, type ExtInvokeMap, type Json } from "@pistachio/extension-api";
import { isEverySite, type Capability } from "@pistachio/extension-api/capabilities";
import type { PistachioManifest } from "@pistachio/extension-api/manifest";
import type { ExtensionDraftReading, ExtensionToolSpec } from "@pistachio/agent-runtime";
import { LEDGER_TOOL_INPUT_CHARS, type LedgerLine } from "./ledger";
import { STATUS_DIR } from "./status";

/* ------------------------------ an extension's tools ------------------------------ */

/** One extension as the agent's side reads it. */
export interface AgentExtensionView {
  id: string;
  manifest: PistachioManifest | null;
  /** Approved, on, loaded, not paused (the service's `#runnable`). */
  runnable: boolean;
  /** The person left *Agent can use it* on. */
  agentAllowed: boolean;
  can(capability: Capability): boolean;
  onIn(profileId: string): boolean;
}

/** Why an extension's tool is not the agent's to call in `profileId`, or null when it is. */
export function agentToolRefusal(extension: AgentExtensionView | null, profileId: string): string | null {
  if (extension === null || extension.manifest === null) return "there is no such extension";
  const name = extension.manifest.name;
  if (!extension.runnable) return `${name} is off or waiting on the person's approval`;
  if (!extension.can("agent:tools")) return `${name} has not been allowed to give the agent tools ("agent:tools")`;
  if (!extension.agentAllowed) return `the person turned off "Agent can use it" for ${name}`;
  if (!extension.onIn(profileId)) return `${name} is off in this Profile`;
  return null;
}

/** The tools a turn in `profileId` may have, in the extensions' order. */
export function agentToolSpecs(extensions: readonly AgentExtensionView[], profileId: string): ExtensionToolSpec[] {
  const specs: ExtensionToolSpec[] = [];
  for (const extension of extensions) {
    if (agentToolRefusal(extension, profileId) !== null) continue;
    const manifest = extension.manifest!;
    for (const declared of manifest.tools ?? []) {
      specs.push({ extensionId: extension.id, extensionName: manifest.name, name: declared.name, description: declared.description, input: declared.input, effect: declared.effect });
    }
  }
  return specs;
}

/** The largest input, as JSON, a tool call sends an extension. */
export const MAX_TOOL_INPUT_CHARS = 1_000_000;

export interface AgentToolCallDeps {
  find(extensionId: string): AgentExtensionView | null;
  /** The worker's `tool` handler: started if need be, answered through `runtime.done`, timed out at 30 s. */
  invoke(extensionId: string, tool: string, value: ExtInvokeMap["tool"], profileId: string): Promise<Json | undefined>;
  ledger(extensionId: string, line: LedgerLine): void;
  now?: () => number;
}

export interface AgentToolCall {
  runId: string;
  spaceId: string | null;
  /** The run's Profile: the tool runs only where the extension is on, and its calls with no tab act there. */
  profileId: string;
  signal: AbortSignal;
}

/** A sentence for the model from whatever the worker or main threw: `CODE: message` for an ExtError. */
export function toolFailure(error: unknown): Error {
  if (error instanceof ExtError) return new Error(`${error.code}: ${error.message}`);
  return error instanceof Error ? error : new Error(String(error));
}

/** One call of an extension's declared tool, for the agent. Resolves the tool's JSON (null for nothing); rejects with a sentence. */
export async function callAgentTool(deps: AgentToolCallDeps, extensionId: string, tool: string, input: unknown, call: AgentToolCall): Promise<Json> {
  const extension = deps.find(extensionId);
  const refusal = agentToolRefusal(extension, call.profileId);
  if (refusal !== null) throw new Error(`PERMISSION_DENIED: ${refusal}`);
  if (!(extension!.manifest!.tools ?? []).some((declared) => declared.name === tool)) throw new Error(`NOT_FOUND: ${extension!.manifest!.name} declares no tool "${tool}"`);
  let text: string;
  try {
    text = JSON.stringify(input ?? {});
  } catch {
    throw new Error("INVALID_ARGUMENT: the tool's input is not JSON");
  }
  if (text.length > MAX_TOOL_INPUT_CHARS) throw new Error("INVALID_ARGUMENT: the tool's input is larger than 1 MB");
  const now = deps.now ?? Date.now;
  // The input leaves for the extension: on the record before it goes.
  deps.ledger(extensionId, {
    at: now(),
    method: "TOOL",
    host: "agent",
    path: `/${tool}`,
    status: null,
    sent: Buffer.byteLength(text),
    received: 0,
    tool: { name: tool, runId: call.runId, input: text.length > LEDGER_TOOL_INPUT_CHARS ? `${text.slice(0, LEDGER_TOOL_INPUT_CHARS)}…` : text },
  });
  if (call.signal.aborted) throw new Error("CANCELLED: the turn was stopped");
  const invoked = deps.invoke(extensionId, tool, { input: JSON.parse(text) as Json, runId: call.runId, spaceId: call.spaceId }, call.profileId);
  const stopped = new Promise<never>((_resolve, reject) => {
    call.signal.addEventListener("abort", () => reject(new Error("CANCELLED: the turn was stopped")), { once: true });
  });
  // (A stopped turn stops waiting; the worker's answer, when it comes, finds no one.)
  invoked.catch(() => undefined);
  try {
    const value = await Promise.race([invoked, stopped]);
    return value ?? null;
  } catch (error) {
    throw toolFailure(error);
  }
}

/* ------------------------------ the agent as an author ------------------------------ */

/** The largest file an author turn writes (and reads back). */
export const MAX_DRAFT_FILE_BYTES = 256 * 1024;
/** How long `extension_status` waits for the watcher (200 ms debounce) and the reload to write the status. */
export const DRAFT_SETTLE_MS = 1_500;
const MAX_LISTED = 200;

export interface DraftClaim {
  slug: string;
  folder: string;
}

/** The marker the Bar's `/extension` puts first in the prompt, which the run controller reads and strips. */
export const AUTHOR_MARKER_PATTERN = /^\[pistachio:extension-author slug=([a-z0-9-]{1,80}) token=([0-9a-f]{32})\]\s*\n?/;

/** The marker and what follows it, or null when the text does not start with one. */
export function parseAuthorMarker(text: string): { slug: string; token: string; rest: string } | null {
  const match = AUTHOR_MARKER_PATTERN.exec(text.trimStart());
  if (match === null) return null;
  return { slug: match[1]!, token: match[2]!, rest: text.trimStart().slice(match[0].length).trim() };
}

function refuse(message: string): never {
  throw new Error(message);
}

/**
 * A path an author turn names, checked by its spelling: relative, no `..`,
 * no NUL, nothing under `.pistachio/` (any case: the Mac's disk ignores it).
 * Its parts, cleaned of `.` and empty ones.
 */
export function draftPathParts(path: string): string[] {
  if (path.includes("\0")) refuse("a path has no NUL characters");
  const spelled = path.replace(/\\/g, "/").trim();
  if (spelled === "" || spelled.startsWith("/") || /^[a-zA-Z]:/.test(spelled) || spelled.startsWith("~")) refuse(`"${path}" is not relative to the extension's folder: write paths like pistachio.json or src/panel.js`);
  const parts = spelled.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0) refuse(`"${path}" names no file`);
  if (parts.some((part) => part === "..")) refuse(`"${path}" climbs out of the extension's folder: no .. in paths`);
  if (parts[0]!.toLowerCase() === STATUS_DIR) refuse(".pistachio/ is Pistachio's own: read it with extension_status, never write it");
  // (What the watcher ignores never reloads: a draft is only files Pistachio reads.)
  if (parts.some((part) => part.startsWith("."))) refuse(`"${path}": Pistachio ignores dotfiles and dot-folders in an extension; name it without the dot`);
  if (parts.some((part) => part.toLowerCase() === "node_modules")) refuse(`"${path}": node_modules is ignored; vendor a library as an ES module file in the folder`);
  return parts;
}

/** Whether a manifest's text names every site among its hosts — `<all_urls>` or a star-host pattern (refused: Critical, never the agent's to ask). */
export function manifestAsksAllUrls(text: string): boolean {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const hosts = value["hosts"];
    return Array.isArray(hosts) && hosts.some((host) => typeof host === "string" && isEverySite(host));
  } catch {
    // Not JSON: it will not load, and the status says why.
    return false;
  }
}

export interface DraftFoldersDeps {
  /** Before a file is written: the service pauses an approved extension in that folder (`markAgentChanged`). */
  beforeWrite?(folder: string): void;
  settleMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The draft folders the Bar made this session, by slug: what the author
 * turn reaches, and nothing beside. Each is claimed by a turn with the token
 * `draftFolder` answered the shell — so a prompt someone else wrote, an
 * extension's `agent.ask` among them, starts no author turn.
 */
export class DraftFolders {
  readonly #drafts = new Map<string, { folder: string; token: string; claimed: boolean }>();
  readonly #deps: DraftFoldersDeps;

  constructor(deps: DraftFoldersDeps = {}) {
    this.#deps = deps;
  }

  /** A folder `draftFolder` made: its slug (the folder's name) and the one-time token for the turn that writes it. */
  add(folder: string): { slug: string; token: string } {
    const slug = basename(folder);
    const token = randomBytes(16).toString("hex");
    this.#drafts.set(slug, { folder, token, claimed: false });
    return { slug, token };
  }

  /** Whether `folder` is one of this session's drafts. */
  has(folder: string): boolean {
    return [...this.#drafts.values()].some((draft) => draft.folder === folder);
  }

  /** The turn that carries the token takes the draft; a second claim, or a wrong token, gets nothing. */
  claim(slug: string, token: string): DraftClaim | null {
    const draft = this.#drafts.get(slug);
    if (draft === undefined || draft.claimed || draft.token !== token) return null;
    draft.claimed = true;
    return { slug, folder: draft.folder };
  }

  #folder(slug: string): string {
    const draft = this.#drafts.get(slug);
    if (draft === undefined || !draft.claimed) refuse(`"${slug}" is not a draft folder this turn may write`);
    let stat;
    try {
      stat = lstatSync(draft.folder);
    } catch {
      refuse("the draft folder is gone");
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) refuse("the draft folder is not a folder any more");
    return draft.folder;
  }

  /** The real path of `parts` under `folder`, refusing a symlink anywhere on the way; `create` makes the folders. */
  #resolve(folder: string, parts: string[], create: boolean): string {
    const realRoot = realpathSync(folder);
    let current = folder;
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      let stat;
      try {
        stat = lstatSync(current);
      } catch {
        stat = null;
      }
      if (stat?.isSymbolicLink() === true) refuse(`"${parts.slice(0, index + 1).join("/")}" is a symbolic link: the draft never writes or reads through one`);
      const last = index === parts.length - 1;
      if (!last) {
        if (stat === null) {
          if (!create) refuse(`there is no "${parts.join("/")}" in the draft folder`);
          mkdirSync(current);
        } else if (!stat.isDirectory()) refuse(`"${parts.slice(0, index + 1).join("/")}" is a file, not a folder`);
      } else if (stat !== null && !stat.isFile()) refuse(`"${parts.join("/")}" is not a file`);
    }
    const parent = realpathSync(dirname(current));
    const inside = relative(realRoot, parent);
    if (inside.startsWith(`..${sep}`) || inside === "..") refuse("that path leaves the draft folder");
    return join(parent, basename(current));
  }

  /** `extension_draft_write`: one file, whole, replacing what was there. */
  async write(slug: string, path: string, content: string): Promise<{ path: string; bytes: number }> {
    const folder = this.#folder(slug);
    const parts = draftPathParts(path);
    const bytes = Buffer.byteLength(content);
    if (bytes > MAX_DRAFT_FILE_BYTES) refuse(`${parts.join("/")} is ${String(bytes)} bytes: a file is at most 256 KB`);
    // (By its name in any case: the Mac's file system is case-insensitive, so PISTACHIO.JSON is the manifest too.)
    if (parts.length === 1 && (parts[0] as string).toLowerCase() === "pistachio.json" && manifestAsksAllUrls(content)) {
      refuse('pistachio.json may not ask for "<all_urls>": name the sites it needs in "hosts", or use a gesture grant (the guide, §4)');
    }
    const target = this.#resolve(folder, parts, true);
    this.#deps.beforeWrite?.(folder);
    // A temp file renamed over the target: the watcher sees the whole file at once, and a link put there meanwhile is
    // replaced, never followed. (Its dot name is one the watcher ignores.)
    const temp = join(dirname(target), `.${basename(target)}.${randomBytes(4).toString("hex")}.draft`);
    try {
      writeFileSync(temp, content, { flag: "wx" });
      renameSync(temp, target);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
    return { path: parts.join("/"), bytes };
  }

  /** `extension_draft_read`: a file's text, or (no path) the folder's files and sizes, `.pistachio/` left out. */
  async read(slug: string, path: string | null): Promise<ExtensionDraftReading> {
    const folder = this.#folder(slug);
    if (path === null) return { path: null, files: listFiles(folder) };
    const parts = draftPathParts(path);
    const target = this.#resolve(folder, parts, false);
    let text: Buffer;
    try {
      text = readFileSync(target);
    } catch {
      refuse(`there is no "${parts.join("/")}" in the draft folder`);
    }
    if (text.byteLength > MAX_DRAFT_FILE_BYTES) refuse(`${parts.join("/")} is larger than 256 KB`);
    return { path: parts.join("/"), text: text.toString("utf8") };
  }

  /** `extension_status`: the status file, once the watcher (200 ms) and the reload have had their moment. */
  async status(slug: string): Promise<string> {
    const folder = this.#folder(slug);
    const settle = this.#deps.settleMs ?? DRAFT_SETTLE_MS;
    await (this.#deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms))))(settle);
    try {
      return readFileSync(join(folder, STATUS_DIR, "status.json"), "utf8");
    } catch {
      return JSON.stringify({ state: "unknown", note: "Pistachio has not written a status for this folder yet: write pistachio.json first." });
    }
  }
}

/** The folder's files, relative, with sizes: no dotfiles or dot-folders, no node_modules, at most 200. */
function listFiles(folder: string): Array<{ path: string; bytes: number }> {
  const files: Array<{ path: string; bytes: number }> = [];
  const walk = (dir: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= MAX_LISTED) return;
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.isSymbolicLink()) continue;
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), path);
      else if (entry.isFile()) {
        let bytes = 0;
        try {
          bytes = lstatSync(join(dir, entry.name)).size;
        } catch {
          bytes = 0;
        }
        files.push({ path, bytes });
      }
    }
  };
  walk(folder, "");
  return files;
}
