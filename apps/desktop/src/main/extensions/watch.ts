/**
 * Developer mode's folder (docs/extensions.md §2 "Make one", §4 "Hot reload",
 * X7): `~/Pistachio/Extensions/` (or Settings' `devFolder`) with what any
 * coding agent reads there — `AGENTS.md`, `CLAUDE.md` (`@AGENTS.md`), the
 * skill, the API's `.d.ts` and the manifest's JSON Schema — and a watch over
 * every folder in it, and every folder loaded with *Load a folder…*.
 *
 * One recursive `fs.watch` per root. A change is routed to the extension
 * folder it is in and debounced there (200 ms, so an agent's ten writes are
 * one reload); `.pistachio/` (our own status files), `node_modules/`, `.git/`
 * and dotfiles are ignored. A folder that comes to hold a `pistachio.json` is
 * *found*, one that changes is *changed*, one that goes is *gone*: the
 * service decides what each means.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { MANIFEST_FILE } from "./loader";

export const DEBOUNCE_MS = 200;

/** The generated files, by where they go in the dev folder, from where they come in `packages/extension-api/`. */
export const GENERATED_FILES: ReadonlyArray<{ to: string; from: string | null; content?: string }> = [
  { to: "AGENTS.md", from: "AGENTS.md" },
  { to: ".claude/skills/pistachio-extension/SKILL.md", from: "skill/SKILL.md" },
  { to: ".pistachio/pistachio.d.ts", from: "pistachio.d.ts" },
  { to: ".pistachio/pistachio-extension.schema.json", from: "schema/pistachio-extension.schema.json" },
];

/** Whether a path inside an extension folder is one a change of should reload it. */
export function watchedPath(relativePath: string): boolean {
  const parts = relativePath.split(/[\\/]/).filter((part) => part !== "");
  if (parts.length === 0) return false;
  return !parts.some((part) => part.startsWith(".") || part === "node_modules");
}

/**
 * Write the generated files into `folder` (made if need be), each from
 * `apiDir`; one whose source is missing gets a one-line placeholder. Answers
 * the sources that were missing. `CLAUDE.md` is written only where there is none.
 */
export function writeGeneratedFiles(folder: string, apiDir: string): string[] {
  mkdirSync(folder, { recursive: true });
  const missing: string[] = [];
  for (const file of GENERATED_FILES) {
    const target = join(folder, file.to);
    let content: string;
    try {
      content = readFileSync(join(apiDir, file.from!), "utf8");
    } catch {
      missing.push(file.from!);
      content = file.to.endsWith(".json") ? "{}\n" : `<!-- ${file.from} is not in this build of Pistachio yet. -->\n`;
    }
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    } catch (error) {
      console.error("[extensions] could not write", target, error);
    }
  }
  const claude = join(folder, "CLAUDE.md");
  if (!existsSync(claude)) {
    try {
      writeFileSync(claude, "@AGENTS.md\n");
    } catch (error) {
      console.error("[extensions] could not write", claude, error);
    }
  }
  return missing;
}

export interface DevWatchEvents {
  /** A folder now holds a pistachio.json the watcher had not seen. */
  found(folder: string): void;
  /** A watched folder's files changed (debounced). */
  changed(folder: string): void;
  /** A folder that held an extension is gone, or no longer holds a pistachio.json. */
  gone(folder: string): void;
}

export class DevWatcher {
  readonly #events: DevWatchEvents;
  /** Roots watched: the dev folder (its subfolders are extensions), or a loaded folder (itself one). */
  readonly #roots = new Map<string, { watcher: FSWatcher | null; kind: "parent" | "folder" }>();
  readonly #known = new Set<string>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #debounceMs: number;

  constructor(events: DevWatchEvents, options: { debounceMs?: number } = {}) {
    this.#events = events;
    this.#debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  }

  /** Watch a dev folder: each subfolder with a pistachio.json is an extension (found at once). */
  watchParent(folder: string): void {
    if (this.#roots.has(folder)) return;
    mkdirSync(folder, { recursive: true });
    this.#roots.set(folder, { watcher: this.#watch(folder, (path) => this.#routeParent(folder, path)), kind: "parent" });
    for (const entry of this.#subfolders(folder)) this.#seen(entry);
  }

  /** Watch one extension folder (*Load a folder…*). */
  watchFolder(folder: string): void {
    if (this.#roots.has(folder)) return;
    this.#roots.set(folder, { watcher: this.#watch(folder, (path) => this.#routeFolder(folder, path)), kind: "folder" });
    this.#seen(folder);
  }

  unwatch(root: string): void {
    const watched = this.#roots.get(root);
    if (watched === undefined) return;
    watched.watcher?.close();
    this.#roots.delete(root);
    for (const folder of [...this.#known]) {
      if (folder === root || (watched.kind === "parent" && dirname(folder) === root)) {
        this.#known.delete(folder);
        const timer = this.#timers.get(folder);
        if (timer !== undefined) clearTimeout(timer);
        this.#timers.delete(folder);
      }
    }
  }

  /** The folders known to hold an extension. */
  folders(): string[] {
    return [...this.#known].sort();
  }

  dispose(): void {
    for (const root of [...this.#roots.keys()]) this.unwatch(root);
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }

  #subfolders(parent: string): string[] {
    try {
      return readdirSync(parent, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
        .map((entry) => join(parent, entry.name));
    } catch {
      return [];
    }
  }

  #watch(root: string, route: (relativePath: string) => void): FSWatcher | null {
    try {
      const watcher = watch(root, { recursive: true }, (_event, name) => {
        if (name === null) return;
        route(name.toString());
      });
      watcher.on("error", (error) => console.error("[extensions] watch failed", root, error));
      return watcher;
    } catch (error) {
      console.error("[extensions] could not watch", root, error);
      return null;
    }
  }

  #routeParent(parent: string, relativePath: string): void {
    const parts = relativePath.split(/[\\/]/).filter((part) => part !== "");
    const top = parts[0];
    if (top === undefined || top.startsWith(".") || top === "node_modules") return;
    if (parts.length > 1 && !watchedPath(parts.slice(1).join("/"))) return;
    // (A file at the top — AGENTS.md — settles as no extension's: it holds no pistachio.json.)
    this.#schedule(join(parent, top));
  }

  #routeFolder(folder: string, relativePath: string): void {
    if (!watchedPath(relativePath)) return;
    this.#schedule(folder);
  }

  #schedule(folder: string): void {
    const timer = this.#timers.get(folder);
    if (timer !== undefined) clearTimeout(timer);
    this.#timers.set(
      folder,
      setTimeout(() => {
        this.#timers.delete(folder);
        this.#settle(folder);
      }, this.#debounceMs),
    );
  }

  #seen(folder: string): void {
    if (!existsSync(join(folder, MANIFEST_FILE))) return;
    if (this.#known.has(folder)) return;
    this.#known.add(folder);
    this.#events.found(folder);
  }

  #settle(folder: string): void {
    const holds = existsSync(join(folder, MANIFEST_FILE));
    if (!holds) {
      if (this.#known.delete(folder)) this.#events.gone(folder);
      return;
    }
    if (!this.#known.has(folder)) {
      this.#known.add(folder);
      this.#events.found(folder);
      return;
    }
    this.#events.changed(folder);
  }
}

/** Whether `path` is inside `root` (or is it). */
export function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep));
}
