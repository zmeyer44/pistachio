/**
 * The personal-record seam (docs/cloud-sync-design.md §10.2): one
 * `WorkspaceRecordStore` over the files that hold what a person keeps —
 * `bookmarks.json`, `reminders.json`, `memory.json`, and the artifact and
 * note libraries beside them.
 *
 * There is nothing per-kind here on purpose. Each store already knows how to
 * read a record another device wrote (`applyRemote`), how to drop one
 * (`removeRemote`), and which record a local write touched
 * (`onRecordChange`); this dispatches by kind and does no interpreting of its
 * own, so a record's shape stays defined in exactly one place — next to the
 * file that owns it — and workspace-sync stays a lane rather than a schema.
 */

import type { Bookmark } from "@pistachio/shell-contracts/bookmarks";
import type { MemoryEntry } from "@pistachio/shell-contracts/memory";
import type { Reminder } from "@pistachio/shell-contracts/reminders";
import type { ArtifactRecord, NoteBlobRecord, NoteRecord } from "@pistachio/sync-protocol";
import { WORKSPACE_RECORD_KINDS, type WorkspaceRecordKind, type WorkspaceRecordStore } from "./workspace-sync";

/** What each of the three stores offers this lane. */
export interface RecordSource<T> {
  all(): T[];
  get(id: string): T | null;
  applyRemote(value: unknown): T | null;
  removeRemote(id: string): boolean;
  onRecordChange(listener: (id: string) => void): () => void;
}

export interface WorkspaceRecordSources {
  bookmark: RecordSource<Bookmark>;
  reminder: RecordSource<Reminder>;
  memory: RecordSource<MemoryEntry>;
  artifact?: RecordSource<ArtifactRecord>;
  /** A note: its metadata and its markdown in one register (docs/notes.md N2). */
  note?: RecordSource<NoteRecord>;
  /** One image a note references, in a register of its own (N3). */
  noteBlob?: RecordSource<NoteBlobRecord>;
}

export class WorkspaceRecords implements WorkspaceRecordStore {
  readonly #sources: WorkspaceRecordSources;

  constructor(sources: WorkspaceRecordSources) {
    this.#sources = sources;
  }

  all(kind: WorkspaceRecordKind): unknown[] {
    return this.#source(kind)?.all() ?? [];
  }

  get(kind: WorkspaceRecordKind, id: string): unknown {
    return this.#source(kind)?.get(id) ?? null;
  }

  applyRemote(kind: WorkspaceRecordKind, record: unknown): void {
    this.#source(kind)?.applyRemote(record);
  }

  removeRemote(kind: WorkspaceRecordKind, id: string): void {
    this.#source(kind)?.removeRemote(id);
  }

  onChange(listener: (kind: WorkspaceRecordKind, id: string) => void): () => void {
    const unsubscribes = WORKSPACE_RECORD_KINDS.map(
      (kind) => this.#source(kind)?.onRecordChange((id) => listener(kind, id)) ?? (() => undefined),
    );
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }

  /**
   * The store behind a kind, or null when this run has none — the artifact
   * and note stores are built with the window, and a lane that asks before
   * they exist gets an empty answer rather than a crash.
   */
  #source(kind: WorkspaceRecordKind): RecordSource<unknown> | null {
    return (this.#sources[kind] as RecordSource<unknown> | undefined) ?? null;
  }
}
