/**
 * Atomic, debounced persistence for the tab archive (docs/tab-tidy.md §3.6):
 * tabs Tidy closed for going idle and groups a person closed, newest first,
 * kept for the days Settings → Tabs says. Its own file because what is
 * archived is not a setting and is not part of the session a restart reopens.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  EMPTY_TAB_ARCHIVE,
  MAX_ARCHIVE_ENTRIES,
  pruneArchive,
  sanitizeTabArchive,
  type ArchiveEntry,
  type ArchivedTab,
  type ArchiveReason,
  type ArchivedGroupEntry,
  type TabArchiveFile,
} from "@pistachio/shell-contracts/tab-archive";

const WRITE_DELAY_MS = 150;

/** What a caller files; the store names it and stamps it. */
export type ArchiveDraft =
  | { kind: "tab"; spaceId: string; reason: ArchiveReason; runId: string | null; tab: ArchivedTab }
  | { kind: "group"; spaceId: string; reason: ArchiveReason; runId: string | null; group: ArchivedGroupEntry["group"]; tabs: ArchivedTab[] };

export class TabArchiveStore {
  readonly #path: string;
  readonly #retentionDays: () => number;
  readonly #now: () => number;
  #current: TabArchiveFile;
  #timer: NodeJS.Timeout | null = null;

  constructor(userDataDir: string, retentionDays: () => number, now: () => number = Date.now) {
    this.#path = join(userDataDir, "tab-archive.json");
    this.#retentionDays = retentionDays;
    this.#now = now;
    this.#current = this.#read();
  }

  /** A Space's entries, newest first, with what has lapsed already gone. */
  list(spaceId: string): ArchiveEntry[] {
    this.#prune();
    return this.#current.entries.filter((entry) => entry.spaceId === spaceId);
  }

  get(entryId: string): ArchiveEntry | null {
    return this.#current.entries.find((entry) => entry.id === entryId) ?? null;
  }

  /** Whether anything was ever filed — a profile's first Tidy run explains itself. */
  isEmpty(): boolean {
    return this.#current.entries.length === 0;
  }

  add(drafts: readonly ArchiveDraft[]): ArchiveEntry[] {
    if (drafts.length === 0) return [];
    const archivedAt = this.#now();
    const entries = drafts.map((draft): ArchiveEntry => ({ ...draft, id: randomUUID(), archivedAt }));
    this.#current = { ...this.#current, entries: [...entries, ...this.#current.entries].slice(0, MAX_ARCHIVE_ENTRIES) };
    this.#prune();
    this.#schedule();
    return entries;
  }

  remove(entryId: string): ArchiveEntry | null {
    const entry = this.get(entryId);
    if (entry === null) return null;
    this.#current = { ...this.#current, entries: this.#current.entries.filter((candidate) => candidate.id !== entryId) };
    this.#schedule();
    return entry;
  }

  /** Take one tab out of a group entry; the entry goes with its last tab. */
  removeGroupTab(entryId: string, tabIndex: number): ArchivedTab | null {
    const entry = this.get(entryId);
    if (entry === null || entry.kind !== "group") return null;
    const tab = entry.tabs[tabIndex];
    if (tab === undefined) return null;
    const tabs = entry.tabs.filter((_, index) => index !== tabIndex);
    this.#current = {
      ...this.#current,
      entries: this.#current.entries.flatMap((candidate) =>
        candidate.id !== entryId ? [candidate] : tabs.length === 0 ? [] : [{ ...entry, tabs }],
      ),
    };
    this.#schedule();
    return tab;
  }

  /** Everything a Tidy run filed, removed — what that run's Undo reopens. */
  takeRun(runId: string): ArchiveEntry[] {
    const taken = this.#current.entries.filter((entry) => entry.runId === runId);
    if (taken.length === 0) return [];
    this.#current = { ...this.#current, entries: this.#current.entries.filter((entry) => entry.runId !== runId) };
    this.#schedule();
    return taken;
  }

  clear(spaceId: string): void {
    this.#current = { ...this.#current, entries: this.#current.entries.filter((entry) => entry.spaceId !== spaceId) };
    this.#schedule();
  }

  /** Flush pending state during a clean quit; the temp+rename also protects crash reads. */
  flush(): void {
    if (this.#timer === null) return;
    clearTimeout(this.#timer);
    this.#timer = null;
    this.#write();
  }

  #prune(): void {
    const kept = pruneArchive(this.#current.entries, this.#now(), this.#retentionDays());
    if (kept === this.#current.entries) return;
    this.#current = { ...this.#current, entries: [...kept] };
    this.#schedule();
  }

  #schedule(): void {
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#write();
    }, WRITE_DELAY_MS);
    this.#timer.unref();
  }

  #read(): TabArchiveFile {
    try {
      return sanitizeTabArchive(JSON.parse(readFileSync(this.#path, "utf8")));
    } catch {
      return structuredClone(EMPTY_TAB_ARCHIVE);
    }
  }

  #write(): void {
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      const tmp = `${this.#path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.#current, null, 2));
      renameSync(tmp, this.#path);
    } catch {
      // The in-memory archive remains authoritative for this process.
    }
  }
}
