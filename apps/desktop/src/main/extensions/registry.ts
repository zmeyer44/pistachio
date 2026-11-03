/**
 * The extension registry (docs/extensions.md §7): `<userData>/extensions.json`,
 * one record per installed extension — Chrome's and Pistachio's — plus the
 * values the person gave each one's declared settings. Main is the only
 * writer; every change is a whole-file rewrite through a temp file and a
 * rename (the settings-store recipe), so a crash leaves the old file or the
 * new one, never half of either.
 *
 * A record is bound to (id, source): a dev or unpacked folder declaring an
 * id another source already holds is refused (claim), and `com.pistachio.*`
 * ids are the bundled set's alone.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ChromeVerdict, ExtensionKind, ExtensionSource } from "@pistachio/shell-contracts/extensions";
import type { Json } from "@pistachio/extension-api";

export const REGISTRY_FILE = "extensions.json";
export const REGISTRY_VERSION = 1;
/** Ids the app's own extensions use; no folder of the person's may declare one. */
export const RESERVED_ID_PREFIX = "com.pistachio.";

export interface ExtensionGrant {
  capabilities: string[];
  hosts: string[];
  /** The manifest the person approved, by its hash (sheet.ts manifestHash). */
  manifestHash: string;
  at: number;
}

export interface ExtensionPending {
  manifestHash: string;
  /** What it asks for beyond the grant (all of it, for a first approval). */
  widened: string[];
  hosts: string[];
  /**
   * The agent's author turn wrote to the folder after the person approved it
   * (docs/extensions.md §6.2, "Approving"): it waits paused until they look
   * again, whatever it asks — a person's own edits hot-reload, an agent's
   * never run unseen. Cleared by the approval.
   */
  changedBy?: "agent";
}

export interface ExtensionRecord {
  id: string;
  kind: ExtensionKind;
  source: ExtensionSource;
  /** The master switch. */
  enabled: boolean;
  /** The Profiles (code: Spaces) it is on in. */
  profiles: "all" | string[];
  /** Null: never approved. */
  grants: ExtensionGrant | null;
  /** Waiting on the person: a first approval, or a manifest that widened. */
  pending: ExtensionPending | null;
  pinned: boolean;
  order: number;
  agentAllowed: boolean;
  installedAt: number;
  updatedAt: number;
  /**
   * A Chrome extension's verdict, read from the manifest that loads (chrome/verdict.ts, the curated index over it):
   * `wont` is `incompatible`, never loaded. Absent for a Pistachio extension.
   */
  verdict?: ChromeVerdict | null;
}

interface RegistryDocument {
  version: typeof REGISTRY_VERSION;
  records: ExtensionRecord[];
  /** Each extension's declared settings, as the person set them (secrets sealed by the codec). */
  settings: Record<string, Record<string, Json>>;
}

/** How a secret setting is kept on disk: safeStorage in the app, plain in a test. */
export interface SecretCodec {
  seal(value: string): string;
  open(sealed: string): string;
}

const PLAIN: SecretCodec = { seal: (value) => value, open: (value) => value };

export type ClaimResult = { ok: true; record: ExtensionRecord | null } | { ok: false; reason: string };

/** Whether a record is on in any Profile at all: off here in its last one is off everywhere, whatever `enabled` says. */
export function onInAnyProfile(record: Pick<ExtensionRecord, "profiles">): boolean {
  return record.profiles === "all" || record.profiles.length > 0;
}

export function sameSource(a: ExtensionSource, b: ExtensionSource): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "bundled") return true;
  if (a.type === "webstore" && b.type === "webstore") return a.cwsId === b.cwsId;
  if ((a.type === "dev" || a.type === "unpacked") && (b.type === "dev" || b.type === "unpacked")) return a.path === b.path;
  return false;
}

function sourceInWords(source: ExtensionSource): string {
  switch (source.type) {
    case "bundled":
      return "Pistachio's own extensions";
    case "webstore":
      return "the Chrome Web Store";
    case "dev":
    case "unpacked":
      return source.path;
  }
}

export class ExtensionRegistry {
  readonly #path: string;
  readonly #codec: SecretCodec;
  readonly #listeners = new Set<() => void>();
  #document: RegistryDocument;

  constructor(userDataDir: string, options: { codec?: SecretCodec } = {}) {
    this.#path = join(userDataDir, REGISTRY_FILE);
    this.#codec = options.codec ?? PLAIN;
    this.#document = this.#read();
  }

  get path(): string {
    return this.#path;
  }

  list(): ExtensionRecord[] {
    return structuredClone([...this.#document.records].sort((a, b) => a.order - b.order));
  }

  get(id: string): ExtensionRecord | null {
    const record = this.#document.records.find((candidate) => candidate.id === id);
    return record === undefined ? null : structuredClone(record);
  }

  /** The record a folder is registered as, if any. */
  findByPath(path: string): ExtensionRecord | null {
    const record = this.#document.records.find((candidate) => (candidate.source.type === "dev" || candidate.source.type === "unpacked") && candidate.source.path === path);
    return record === undefined ? null : structuredClone(record);
  }

  /**
   * Whether `source` may hold `id`: refused when the id is reserved for the
   * bundled set and the source is not that, or when another source holds it.
   * Answers the record it already is, or null for a new one.
   */
  claim(id: string, source: ExtensionSource): ClaimResult {
    if (id.startsWith(RESERVED_ID_PREFIX) && source.type !== "bundled") {
      return { ok: false, reason: `The id "${id}" is reserved for Pistachio's own extensions: give yours an id of your own in pistachio.json, like dev.yourname.${id.slice(RESERVED_ID_PREFIX.length) || "extension"}.` };
    }
    const held = this.#document.records.find((record) => record.id === id);
    if (held === undefined) return { ok: true, record: null };
    if (sameSource(held.source, source)) return { ok: true, record: structuredClone(held) };
    return { ok: false, reason: `The id "${id}" is already used by ${sourceInWords(held.source)}: change "id" in pistachio.json, or remove the other one first.` };
  }

  /** A new record, or one replaced whole. */
  upsert(record: ExtensionRecord): ExtensionRecord {
    const next = structuredClone(record);
    const at = this.#document.records.findIndex((candidate) => candidate.id === record.id);
    if (at >= 0) this.#document.records[at] = next;
    else this.#document.records.push(next);
    this.#commit();
    return structuredClone(next);
  }

  /** A fresh record's defaults, ordered last. */
  fresh(id: string, kind: ExtensionKind, source: ExtensionSource, now = Date.now()): ExtensionRecord {
    const order = this.#document.records.reduce((max, record) => Math.max(max, record.order + 1), 0);
    return {
      id,
      kind,
      source,
      enabled: false,
      profiles: "all",
      grants: null,
      pending: null,
      pinned: true,
      order,
      agentAllowed: false,
      installedAt: now,
      updatedAt: now,
    };
  }

  update(id: string, patch: Partial<Omit<ExtensionRecord, "id">>, now = Date.now()): ExtensionRecord | null {
    const record = this.#document.records.find((candidate) => candidate.id === id);
    if (record === undefined) return null;
    Object.assign(record, structuredClone(patch), { updatedAt: now });
    this.#commit();
    return structuredClone(record);
  }

  remove(id: string): boolean {
    const before = this.#document.records.length;
    this.#document.records = this.#document.records.filter((record) => record.id !== id);
    delete this.#document.settings[id];
    if (this.#document.records.length === before) return false;
    this.#commit();
    return true;
  }

  /**
   * Move `id` to `index` among the records `among` keeps (all of them when unsaid) — the Ledge's index is among the
   * pinned ones — in order; the rest keep their places relative to each other.
   */
  reorder(id: string, index: number, among: (record: ExtensionRecord) => boolean = () => true): boolean {
    const ordered = [...this.#document.records].sort((a, b) => a.order - b.order);
    const from = ordered.findIndex((record) => record.id === id);
    if (from < 0) return false;
    const [moved] = ordered.splice(from, 1);
    const peers = ordered.filter(among);
    const at = Math.max(0, Math.floor(index));
    // Before the peer now at `index`, or just after the last peer.
    const before = peers[at];
    const last = peers[peers.length - 1];
    const position = before !== undefined ? ordered.indexOf(before) : last !== undefined ? ordered.indexOf(last) + 1 : ordered.length;
    ordered.splice(position, 0, moved!);
    ordered.forEach((record, order) => {
      record.order = order;
    });
    this.#commit();
    return true;
  }

  /** The values the person set, secrets opened (main hands a secret only to the worker). */
  settingsOf(id: string, secrets: ReadonlySet<string> = new Set()): Record<string, Json> {
    const stored = this.#document.settings[id] ?? {};
    const values: Record<string, Json> = {};
    for (const [key, value] of Object.entries(stored)) {
      if (secrets.has(key) && typeof value === "string") {
        try {
          values[key] = this.#codec.open(value);
        } catch {
          // A secret sealed under another key (another Mac's file): as if unset.
        }
      } else values[key] = structuredClone(value);
    }
    return values;
  }

  setSetting(id: string, key: string, value: Json | undefined, secret = false): void {
    const settings = (this.#document.settings[id] ??= {});
    if (value === undefined || value === null) delete settings[key];
    else settings[key] = secret && typeof value === "string" ? this.#codec.seal(value) : structuredClone(value);
    this.#commit();
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #commit(): void {
    this.#write();
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (error) {
        console.error("[extensions] registry listener failed", error);
      }
    }
  }

  #read(): RegistryDocument {
    try {
      return sanitizeRegistry(JSON.parse(readFileSync(this.#path, "utf8")));
    } catch {
      return { version: REGISTRY_VERSION, records: [], settings: {} };
    }
  }

  #write(): void {
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      const tmp = `${this.#path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.#document, null, 2));
      renameSync(tmp, this.#path);
    } catch (error) {
      // The in-memory registry still holds for this session.
      console.error("[extensions] could not write the registry", error);
    }
  }
}

const KINDS: readonly ExtensionKind[] = ["pistachio", "chrome"];

function sanitizeSource(value: unknown): ExtensionSource | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  switch (raw["type"]) {
    case "bundled":
      return { type: "bundled" };
    case "dev":
    case "unpacked":
      return typeof raw["path"] === "string" && raw["path"].length > 0 ? { type: raw["type"], path: raw["path"] } : null;
    case "webstore":
      return typeof raw["cwsId"] === "string" && typeof raw["version"] === "string" ? { type: "webstore", cwsId: raw["cwsId"], version: raw["version"] } : null;
    default:
      return null;
  }
}

function sanitizeVerdict(value: unknown): ChromeVerdict | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (raw["kind"] === "works") return { kind: "works" };
  if (raw["kind"] === "partly") return { kind: "partly", notes: strings(raw["notes"]) };
  if (raw["kind"] === "wont" && typeof raw["reason"] === "string") {
    return { kind: "wont", reason: raw["reason"], ...(typeof raw["alternative"] === "string" ? { alternative: raw["alternative"] } : {}) };
  }
  return null;
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
const finite = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

function sanitizeRecord(value: unknown): ExtensionRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const id = raw["id"];
  const kind = raw["kind"];
  const source = sanitizeSource(raw["source"]);
  if (typeof id !== "string" || id.length === 0 || id.length > 128 || !KINDS.includes(kind as ExtensionKind) || source === null) return null;
  const grantsRaw = raw["grants"];
  const grants =
    typeof grantsRaw === "object" && grantsRaw !== null && typeof (grantsRaw as Record<string, unknown>)["manifestHash"] === "string"
      ? {
          capabilities: strings((grantsRaw as Record<string, unknown>)["capabilities"]),
          hosts: strings((grantsRaw as Record<string, unknown>)["hosts"]),
          manifestHash: (grantsRaw as Record<string, unknown>)["manifestHash"] as string,
          at: finite((grantsRaw as Record<string, unknown>)["at"], 0),
        }
      : null;
  const pendingRaw = raw["pending"];
  const pending =
    typeof pendingRaw === "object" && pendingRaw !== null && typeof (pendingRaw as Record<string, unknown>)["manifestHash"] === "string"
      ? {
          manifestHash: (pendingRaw as Record<string, unknown>)["manifestHash"] as string,
          widened: strings((pendingRaw as Record<string, unknown>)["widened"]),
          hosts: strings((pendingRaw as Record<string, unknown>)["hosts"]),
          ...((pendingRaw as Record<string, unknown>)["changedBy"] === "agent" ? { changedBy: "agent" as const } : {}),
        }
      : null;
  const profiles = raw["profiles"] === "all" ? "all" : Array.isArray(raw["profiles"]) ? strings(raw["profiles"]) : "all";
  return {
    id,
    kind: kind as ExtensionKind,
    source,
    enabled: raw["enabled"] === true,
    profiles,
    grants,
    pending,
    pinned: raw["pinned"] !== false,
    order: finite(raw["order"], 0),
    agentAllowed: raw["agentAllowed"] === true,
    installedAt: finite(raw["installedAt"], 0),
    updatedAt: finite(raw["updatedAt"], 0),
    ...(kind === "chrome" ? { verdict: sanitizeVerdict(raw["verdict"]) } : {}),
  };
}

export function sanitizeRegistry(value: unknown): RegistryDocument {
  const empty: RegistryDocument = { version: REGISTRY_VERSION, records: [], settings: {} };
  if (typeof value !== "object" || value === null) return empty;
  const raw = value as Record<string, unknown>;
  if (raw["version"] !== REGISTRY_VERSION) return empty;
  const seen = new Set<string>();
  const records: ExtensionRecord[] = [];
  for (const candidate of Array.isArray(raw["records"]) ? raw["records"] : []) {
    const record = sanitizeRecord(candidate);
    if (record === null || seen.has(record.id)) continue;
    seen.add(record.id);
    records.push(record);
  }
  const settings: Record<string, Record<string, Json>> = {};
  const rawSettings = raw["settings"];
  if (typeof rawSettings === "object" && rawSettings !== null) {
    for (const [id, values] of Object.entries(rawSettings as Record<string, unknown>)) {
      if (!seen.has(id) || typeof values !== "object" || values === null || Array.isArray(values)) continue;
      settings[id] = structuredClone(values as Record<string, Json>);
    }
  }
  return { version: REGISTRY_VERSION, records, settings };
}
