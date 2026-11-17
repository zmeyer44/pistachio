/**
 * What main keeps of extensions that run by themselves (docs/primitives.md
 * §3), in `<userData>/extension-automation.json`:
 *
 * - **what each trigger last heard** — the answer delivered, so a trigger is
 *   delivered when the clock's answer is not that one, across any restart;
 * - **the pauses** — one extension's triggers, or everyone's (*Pause all*);
 * - **the journal** — every write an extension made with nobody there (a
 *   space sent away or brought back, a theme set, a tab opened): who, which
 *   trigger, what, to which space, and whether the person undid it.
 *   Main's record, drawn by the shell; never the extension's own words.
 *
 * Main is the only writer; a write is the whole file through a temp file
 * and a rename, at once (these are rare: a delivery, a press).
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EXTENSION_JOURNAL_VERBS, type ExtensionJournalEntry } from "@pistachio/shell-contracts/extensions";

export const AUTOMATION_FILE = "extension-automation.json";
export const AUTOMATION_VERSION = 1;
/** The journal's length: the newest kept. */
export const JOURNAL_MAX = 400;

export interface Delivered {
  /** The answer the worker last heard (./triggers triggerAnswer). */
  answer: string;
  at: number;
}

interface AutomationExtension {
  paused: boolean;
  delivered: Record<string, Delivered>;
  /**
   * Each declared trigger as it was when what it heard was heard (triggerKey): one whose days, times, rhythm or
   * signal changed under the same id is another trigger, and starts afresh. Absent for a trigger heard before this
   * was kept.
   */
  keys: Record<string, string>;
}

interface AutomationDocument {
  version: typeof AUTOMATION_VERSION;
  pausedAll: boolean;
  extensions: Record<string, AutomationExtension>;
  journal: ExtensionJournalEntry[];
}

const empty = (): AutomationDocument => ({ version: AUTOMATION_VERSION, pausedAll: false, extensions: {}, journal: [] });

const text = (value: unknown, max: number): string | null => (typeof value === "string" && value.length > 0 && value.length <= max ? value : null);
/** A record's own entry, never one of Object's (a trigger may be named "constructor"). */
const own = <T>(record: Record<string, T>, key: string): T | undefined => (Object.hasOwn(record, key) ? record[key] : undefined);
const instant = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

function isJournalVerb(value: unknown): value is ExtensionJournalEntry["verb"] {
  return typeof value === "string" && (EXTENSION_JOURNAL_VERBS as readonly string[]).includes(value);
}

function sanitizeEntry(value: unknown): ExtensionJournalEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const id = text(raw["id"], 64);
  const at = instant(raw["at"]);
  const extensionId = text(raw["extensionId"], 200);
  const spaceId = text(raw["spaceId"], 128);
  const verb = raw["verb"];
  if (id === null || at === null || extensionId === null || spaceId === null || !isJournalVerb(verb)) return null;
  const undone = instant(raw["undone"]);
  const tabId = text(raw["tabId"], 128);
  const entryId = text(raw["entryId"], 128);
  const until = instant(raw["until"]);
  return {
    id,
    at,
    extensionId,
    trigger: text(raw["trigger"], 64),
    verb,
    spaceId,
    title: typeof raw["title"] === "string" ? raw["title"].slice(0, 240) : "",
    ...(tabId === null ? {} : { tabId }),
    ...(entryId === null ? {} : { entryId }),
    ...(until === null ? {} : { until }),
    ...(undone === null ? {} : { undone }),
  };
}

/**
 * What undoing an opened tab comes to, by where the tab is now. `here`: close it. `away`: it went away with a space
 * — the one it opened in, or one it was moved to since — and comes back with it: not undone, and said. Neither: the
 * person closed it, and nothing is left to undo.
 */
export function undoOfOpenTab(tab: { here: boolean; away: boolean }): "close" | "away" | "gone" {
  return tab.here ? "close" : tab.away ? "away" : "gone";
}

/**
 * What undoing a bring-back does: the space is sent away again as it was — until the time it was due (`until`), not
 * for good; and once that time has passed there is nothing to send, since it would be back by now. With no time
 * kept it was away until asked for, and is again.
 */
export function undoOfBringBack(line: Pick<ExtensionJournalEntry, "until">, now: number): { send: true; until?: number } | { send: false } {
  if (line.until === undefined) return { send: true };
  return line.until > now ? { send: true, until: line.until } : { send: false };
}

export function sanitizeAutomation(value: unknown): AutomationDocument {
  if (typeof value !== "object" || value === null) return empty();
  const raw = value as Record<string, unknown>;
  if (raw["version"] !== AUTOMATION_VERSION) return empty();
  const extensions: Record<string, AutomationExtension> = {};
  const rawExtensions = raw["extensions"];
  if (typeof rawExtensions === "object" && rawExtensions !== null && !Array.isArray(rawExtensions)) {
    for (const [id, entry] of Object.entries(rawExtensions as Record<string, unknown>)) {
      if (text(id, 200) === null || typeof entry !== "object" || entry === null) continue;
      const delivered: Record<string, Delivered> = {};
      const rawDelivered = (entry as Record<string, unknown>)["delivered"];
      if (typeof rawDelivered === "object" && rawDelivered !== null && !Array.isArray(rawDelivered)) {
        for (const [trigger, last] of Object.entries(rawDelivered as Record<string, unknown>)) {
          if (text(trigger, 64) === null || typeof last !== "object" || last === null) continue;
          const answer = text((last as Record<string, unknown>)["answer"], 64);
          const at = instant((last as Record<string, unknown>)["at"]);
          if (answer !== null && at !== null) delivered[trigger] = { answer, at };
        }
      }
      const keys: Record<string, string> = {};
      const rawKeys = (entry as Record<string, unknown>)["keys"];
      if (typeof rawKeys === "object" && rawKeys !== null && !Array.isArray(rawKeys)) {
        for (const [trigger, key] of Object.entries(rawKeys as Record<string, unknown>)) {
          const kept = text(key, 2_000);
          if (text(trigger, 64) !== null && kept !== null && Object.hasOwn(delivered, trigger)) keys[trigger] = kept;
        }
      }
      extensions[id] = { paused: (entry as Record<string, unknown>)["paused"] === true, delivered, keys };
    }
  }
  const journal = (Array.isArray(raw["journal"]) ? raw["journal"] : []).flatMap((entry) => sanitizeEntry(entry) ?? []);
  return { version: AUTOMATION_VERSION, pausedAll: raw["pausedAll"] === true, extensions, journal: journal.slice(Math.max(0, journal.length - JOURNAL_MAX)) };
}

export class AutomationStore {
  readonly #path: string;
  #document: AutomationDocument;

  constructor(userDataDir: string) {
    this.#path = join(userDataDir, AUTOMATION_FILE);
    this.#document = this.#read();
  }

  /* -------------------------------- pauses -------------------------------- */

  get pausedAll(): boolean {
    return this.#document.pausedAll;
  }

  setPausedAll(paused: boolean): void {
    if (this.#document.pausedAll === paused) return;
    this.#document.pausedAll = paused;
    this.#write();
  }

  /** This extension's own pause (not *Pause all*). */
  paused(extensionId: string): boolean {
    return own(this.#document.extensions, extensionId)?.paused === true;
  }

  setPaused(extensionId: string, paused: boolean): void {
    if (this.paused(extensionId) === paused) return;
    this.#of(extensionId).paused = paused;
    this.#write();
  }

  /* ------------------------------ deliveries ------------------------------ */

  delivered(extensionId: string, trigger: string): Delivered | null {
    const entry = own(this.#document.extensions, extensionId);
    return entry === undefined ? null : (own(entry.delivered, trigger) ?? null);
  }

  /** `key`: the trigger as it is declared now (triggerKey), kept beside what it heard so a changed one is told apart. */
  setDelivered(extensionId: string, trigger: string, answer: string, at: number, key?: string): void {
    const entry = this.#of(extensionId);
    entry.delivered[trigger] = { answer, at };
    if (key !== undefined) entry.keys[trigger] = key;
    this.#write();
  }

  /**
   * The triggers an extension declares now, each as an approval names it (`key`: triggerKey). What one no longer
   * declared last heard is forgotten — and so is what one heard whose key has changed: the same id with other days,
   * another rhythm or another signal is another trigger, and starts as a new one does (an interval quiet, an instant
   * from now, a window said once).
   */
  keepTriggers(extensionId: string, triggers: readonly { id: string; key: string }[]): void {
    const entry = own(this.#document.extensions, extensionId);
    if (entry === undefined) return;
    const declared = new Map(triggers.map((trigger) => [trigger.id, trigger.key]));
    let changed = false;
    for (const trigger of Object.keys(entry.delivered)) {
      const key = declared.get(trigger);
      const kept = own(entry.keys, trigger);
      if (key !== undefined && (kept === undefined || kept === key)) {
        // (Heard before keys were kept: this is the trigger it heard, from here on.)
        if (kept === undefined) {
          entry.keys[trigger] = key;
          changed = true;
        }
        continue;
      }
      delete entry.delivered[trigger];
      delete entry.keys[trigger];
      changed = true;
    }
    for (const trigger of Object.keys(entry.keys)) {
      if (Object.hasOwn(entry.delivered, trigger)) continue;
      delete entry.keys[trigger];
      changed = true;
    }
    if (changed) this.#write();
  }

  /** The extension is gone: its pause, what its triggers heard, and its lines in the journal. */
  forget(extensionId: string): void {
    const had = Object.hasOwn(this.#document.extensions, extensionId) || this.#document.journal.some((entry) => entry.extensionId === extensionId);
    if (!had) return;
    delete this.#document.extensions[extensionId];
    this.#document.journal = this.#document.journal.filter((entry) => entry.extensionId !== extensionId);
    this.#write();
  }

  /* ------------------------------- journal ------------------------------- */

  record(entry: Omit<ExtensionJournalEntry, "id">): ExtensionJournalEntry {
    const recorded: ExtensionJournalEntry = { ...entry, id: randomUUID() };
    this.#document.journal = [...this.#document.journal, recorded].slice(-JOURNAL_MAX);
    this.#write();
    return structuredClone(recorded);
  }

  /** An extension's entries, newest first, at most `limit`. */
  journalOf(extensionId: string, limit: number): ExtensionJournalEntry[] {
    const entries = this.#document.journal.filter((entry) => entry.extensionId === extensionId);
    return structuredClone(entries.slice(Math.max(0, entries.length - limit)).reverse());
  }

  entry(id: string): ExtensionJournalEntry | null {
    const found = this.#document.journal.find((entry) => entry.id === id);
    return found === undefined ? null : structuredClone(found);
  }

  markUndone(id: string, at: number): void {
    const found = this.#document.journal.find((entry) => entry.id === id);
    if (found === undefined || found.undone !== undefined) return;
    found.undone = at;
    this.#write();
  }

  /* --------------------------------- file --------------------------------- */

  #of(extensionId: string): AutomationExtension {
    const held = own(this.#document.extensions, extensionId);
    if (held !== undefined) return held;
    // (Null-prototype records: a trigger named "constructor" is an entry like any other, never Object's own.)
    const made: AutomationExtension = { paused: false, delivered: Object.create(null) as Record<string, Delivered>, keys: Object.create(null) as Record<string, string> };
    this.#document.extensions[extensionId] = made;
    return made;
  }

  #read(): AutomationDocument {
    try {
      return sanitizeAutomation(JSON.parse(readFileSync(this.#path, "utf8")));
    } catch {
      return empty();
    }
  }

  #write(): void {
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      const tmp = `${this.#path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.#document, null, 2));
      renameSync(tmp, this.#path);
    } catch (error) {
      // What is in memory still holds for this session; a delivery not written is heard once more after a restart.
      console.error("[extensions] could not write what extensions did by themselves", error);
    }
  }
}
