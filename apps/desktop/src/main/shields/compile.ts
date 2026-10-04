/**
 * Filter lists in, a serialized blocking engine out (docs/shields.md §2).
 *
 * Runs in the Shields worker (compile-worker.ts) — parsing every default
 * list takes ~0.5 s of CPU, which the main process must never spend — and in
 * unit tests directly. Main only ever DESERIALIZES what this writes, which
 * takes ~10 ms.
 *
 * Two engines come out: the blocking engine (every effective list plus the
 * person's own filters) and the danger engine (the Security lists alone),
 * which decides whether a PAGE is stopped behind the warning — a hostname on
 * EasyList is an ad server to keep out of pages, not a page to warn about.
 */

import { FiltersEngine, parseFilters, type CosmeticFilter, type NetworkFilter, type Preprocessor } from "@ghostery/adblocker";

export interface CompileList {
  id: string;
  text: string;
  /** uBlock Origin's own lists: their `trusted-*` scriptlets are kept. */
  trusted: boolean;
}

export interface CompileInput {
  lists: CompileList[];
  dangerLists: CompileList[];
  customFilters: string;
  /** uBlock Origin's resources (scriptlets and redirect bodies), in Ghostery's JSON form, or null. */
  resources: string | null;
}

export interface CompileOutput {
  engine: Uint8Array;
  danger: Uint8Array | null;
  networkFilters: number;
  cosmeticFilters: number;
  dangerFilters: number;
  /** Lines of the person's own filters the engine could not read. */
  customErrors: string[];
}

/**
 * `!#if` conditions the lists are evaluated under: a Chromium engine that
 * speaks uBlock Origin's syntax and injects user-origin style sheets.
 */
const ENV: [string, boolean][] = [
  ["env_chromium", true],
  ["ext_ublock", true],
  ["cap_user_stylesheet", true],
];

export const ENGINE_CONFIG = {
  loadNetworkFilters: true,
  loadCosmeticFilters: true,
  loadGenericCosmeticsFilters: true,
  loadExceptionFilters: true,
  loadCSPFilters: true,
  loadPreprocessors: true,
  // Procedural selectors (:has-text, :upward) need a matcher in the page;
  // the tab preload does not carry one yet.
  loadExtendedSelectors: false,
  // Electron cannot rewrite response bodies.
  enableHtmlFiltering: false,
  enableMutationObserver: true,
  enableCompression: false,
  guessRequestTypeFromUrl: true,
  integrityCheck: true,
} as const;

export function engineEnv(): Parameters<FiltersEngine["updateEnv"]>[0] {
  return new Map(ENV) as Parameters<FiltersEngine["updateEnv"]>[0];
}

/**
 * uBlock Origin runs `trusted-*` scriptlets (which rewrite responses, set
 * cookies, click elements) and `$replace` only from lists its own team
 * maintains. Ghostery's engine does not keep that rule, so it is kept here:
 * an untrusted list's lines that need trust are dropped before parsing.
 */
const NEEDS_TRUST = /#@?#\+js\(\s*trusted-|#%#\/\/scriptlet\(\s*['"]trusted-|\$(.*,)?replace=/;

export function withoutTrustedRules(text: string): string {
  if (!text.includes("trusted-") && !text.includes("replace=")) return text;
  return text
    .split("\n")
    .filter((line) => !NEEDS_TRUST.test(line))
    .join("\n");
}

/** Lines that do not parse — not comments or blank lines, which are fine. */
const NOT_SUPPORTED = 0;
const NOT_SUPPORTED_ADGUARD = 102;

interface Parsed {
  networkFilters: NetworkFilter[];
  cosmeticFilters: CosmeticFilter[];
  preprocessors: Preprocessor[];
}

/**
 * Every name — canonical and alias, as the resources spell them (`.js`) — of
 * a scriptlet that needs trust: marked `requiresTrust`, or named `trusted-`.
 * An alias is the way around a check on the name a filter writes:
 * `##+js(rpnt, …)` IS trusted-replace-node-text.
 */
export function trustedScriptletNames(resources: string | null): Set<string> {
  const names = new Set<string>();
  if (resources === null) return names;
  try {
    const parsed = JSON.parse(resources) as { scriptlets?: { name?: unknown; aliases?: unknown; requiresTrust?: unknown }[] };
    for (const scriptlet of parsed.scriptlets ?? []) {
      if (typeof scriptlet.name !== "string") continue;
      if (scriptlet.requiresTrust !== true && !scriptlet.name.startsWith("trusted-")) continue;
      names.add(scriptlet.name);
      if (Array.isArray(scriptlet.aliases)) for (const alias of scriptlet.aliases) if (typeof alias === "string") names.add(alias);
    }
  } catch {
    // Unreadable resources inject nothing at all.
  }
  return names;
}

function needsTrust(filter: CosmeticFilter, trusted: ReadonlySet<string>): boolean {
  if (!filter.isScriptInject() || filter.isUnhide()) return false;
  const name = filter.parseScript()?.name;
  if (name === undefined) return false;
  const key = name.endsWith(".js") ? name : `${name}.js`;
  return key.startsWith("trusted-") || trusted.has(key);
}

function parseAll(lists: readonly CompileList[], trusted: ReadonlySet<string> = new Set()): Parsed & { errors: Map<string, string[]> } {
  const out: Parsed = { networkFilters: [], cosmeticFilters: [], preprocessors: [] };
  const errors = new Map<string, string[]>();
  for (const list of lists) {
    const parsed = parseFilters(list.trusted ? list.text : withoutTrustedRules(list.text), ENGINE_CONFIG);
    // One at a time: a spread passes each filter as an argument, and AdGuard
    // Tracking Protection alone has more filters than V8 takes arguments.
    for (const filter of parsed.networkFilters) out.networkFilters.push(filter);
    for (const filter of parsed.cosmeticFilters) {
      // The text check above cannot see aliases; this one resolves them.
      if (!list.trusted && needsTrust(filter, trusted)) continue;
      out.cosmeticFilters.push(filter);
    }
    for (const preprocessor of parsed.preprocessors) out.preprocessors.push(preprocessor);
    const bad = parsed.notSupportedFilters
      .filter((filter) => filter.filterType === NOT_SUPPORTED || filter.filterType === NOT_SUPPORTED_ADGUARD)
      .map((filter) => filter.filter);
    if (bad.length > 0) errors.set(list.id, bad);
  }
  return { ...out, errors };
}

function build(parsed: Parsed, resources: string | null): FiltersEngine {
  const engine = new FiltersEngine({ ...parsed, config: ENGINE_CONFIG });
  engine.updateEnv(engineEnv());
  if (resources !== null) engine.updateResources(resources, checksum(resources));
  return engine;
}

export function compileEngines(input: CompileInput): CompileOutput {
  const lists = [...input.lists];
  if (input.customFilters.trim() !== "") lists.push({ id: "custom", text: input.customFilters, trusted: false });
  const parsed = parseAll(lists, trustedScriptletNames(input.resources));
  const engine = build(parsed, input.resources);
  let danger: Uint8Array | null = null;
  let dangerFilters = 0;
  if (input.dangerLists.length > 0) {
    const dangerParsed = parseAll(input.dangerLists);
    // Only the network half matters for a page decision.
    dangerParsed.cosmeticFilters = [];
    dangerFilters = dangerParsed.networkFilters.length;
    danger = build(dangerParsed, null).serialize();
  }
  return {
    engine: engine.serialize(),
    danger,
    networkFilters: parsed.networkFilters.length,
    cosmeticFilters: parsed.cosmeticFilters.length,
    dangerFilters,
    customErrors: (parsed.errors.get("custom") ?? []).slice(0, 50),
  };
}

/** A short content hash (FNV-1a) — enough to tell two texts apart, not a security boundary. */
export function checksum(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
